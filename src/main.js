// REMOVE IMPORT: import * as THREE from 'three';
// USE GLOBAL THREE INSTEAD
// GLTFLoader is also global: THREE.GLTFLoader
const THREE = window.THREE; // Ensure we use the CDN-loaded THREE
import { SceneManager } from './SceneManager.js';

// --- Debug & Logger ---
const debugConsole = document.getElementById('debug-console');
function log(message) {
  console.log(`[App] ${message}`);
  if (debugConsole) {
    debugConsole.innerText += message + '\n';
    debugConsole.scrollTop = debugConsole.scrollHeight;
  }
}
function error(message) {
  console.error(message);
  if (debugConsole) {
    debugConsole.innerText += '[ERR] ' + message + '\n';
    debugConsole.scrollTop = debugConsole.scrollHeight;
  }
}

window.onerror = function (msg, url, lineNo, columnNo, error) {
  log(`Global Error: ${msg} at line ${lineNo}`);
  return false;
};

// --- State Machine ---
const AppState = {
  INIT: 'INIT',
  MINDAR_READY: 'MINDAR_READY',
  MINDAR_TRACKING: 'MINDAR_TRACKING',
  POSE_STABILIZING: 'POSE_STABILIZING',
  WEBXR_STARTING: 'WEBXR_STARTING',
  WORLD_LOCKING: 'WORLD_LOCKING',
  RUNNING: 'RUNNING'
};

let currentState = AppState.INIT;

// --- Globals ---
let mindarThree = null;
let webxrRenderer = null;
let scene = null;
let camera = null;
let sceneManager = null;
let clock = window.THREE ? new THREE.Clock() : null;

// MindAR Data
let mindarAnchor = null;
let poseBuffer = [];
const POSE_BUFFER_SIZE = 15; // Frames to average
let poseStabilizeTimer = null;
let stabilizedPose = null; // { position: Vector3, quaternion: Quaternion }

// WebXR Data
let hitTestSource = null;
let isAnchorPlaced = false;

// --- UI Elements ---
let ui = {
  overlay: document.getElementById('overlay'),
  mindarScanning: document.getElementById('mindar-scanning-ui'),
  transition: document.getElementById('transition-overlay'),
  lockProgress: document.getElementById('lock-progress'),
  loading: document.getElementById('loading-screen'),
  runtime: document.getElementById('runtime-ui'),
  arButton: document.getElementById('ar-button'),
  poseInfo: document.getElementById('pose-info')
};

// --- Initialization ---
async function init() {
  log('State: INIT');
  log('Waiting for Libraries (Polling)...');

  if (ui.arButton) {
    ui.arButton.disabled = true;
    ui.arButton.innerText = "Loading Libraries...";
  }

  // Poll for Dependencies
  const maxRetries = 200; // 20 seconds total
  let attempts = 0;

  const checkDeps = setInterval(() => {
    attempts++;
    // Check for specific deep properties to ensure full load
    const mindArReady = window.MINDAR && window.MINDAR.IMAGE;
    const threeReady = window.THREE && window.THREE.WebGLRenderer;

    if (mindArReady && threeReady) {
      clearInterval(checkDeps);
      log('Dependencies Ready: MindAR & THREE');
      // Re-initialize clock now that THREE is definitely valid
      if (!clock) clock = new THREE.Clock();
      enableStartButton();
    } else if (attempts >= maxRetries) {
      clearInterval(checkDeps);
      error('Timeout: Libraries not fully loaded after 20s');

      if (!threeReady) error('Missing: THREE (or WebGLRenderer)');
      if (!mindArReady) error('Missing: MINDAR (or MINDAR.IMAGE)');
    }
  }, 100);
}

function enableStartButton() {
  // Recheck elements in case of DOM issues
  ui.arButton = document.getElementById('ar-button');
  if (ui.arButton) {
    ui.arButton.innerText = "Start Experience";
    ui.arButton.disabled = false;
    ui.arButton.style.opacity = "1";
    ui.arButton.style.cursor = "pointer";
    // Clone/replace to clear listeners
    const newBtn = ui.arButton.cloneNode(true);
    ui.arButton.parentNode.replaceChild(newBtn, ui.arButton);
    ui.arButton = newBtn;

    ui.arButton.addEventListener('click', startMindARPhase);
  }
}

// --- Phase 1: MindAR Image Tracking ---
async function startMindARPhase() {
  if (ui.overlay) ui.overlay.style.display = 'none';
  if (ui.mindarScanning) ui.mindarScanning.style.display = 'block';
  currentState = AppState.MINDAR_READY;

  log('Starting MindAR Setup...');

  // Initialize MindAR Three
  try {
    if (!window.MINDAR || !window.MINDAR.IMAGE) {
      throw new Error("MindAR.IMAGE is missing. Upgrade or Check Script.");
    }

    log("Creating MindARThree instance...");
    mindarThree = new window.MINDAR.IMAGE.MindARThree({
      container: document.body,
      imageTargetSrc: '/targets.mind', // Assumed file in public/
      filterMinCF: 0.0001, // Reduce jitter
      filterBeta: 0.001,
      uiLoading: 'no', // Disable default loading UI
      uiScanning: 'no'
    });
  } catch (e) {
    error("MindAR Init Failed: " + e.message);
    console.error(e);
    return;
  }

  const { renderer, scene: mScene, camera: mCamera } = mindarThree;

  // Setup light for MindAR scene
  const light = new THREE.HemisphereLight(0xffffff, 0xbbbbff, 1);
  mScene.add(light);

  // Anchor
  mindarAnchor = mindarThree.addAnchor(0);

  // Visual helper on the anchor
  const geometry = new THREE.SphereGeometry(0.1, 32, 32);
  const material = new THREE.MeshBasicMaterial({ color: 0x00ff00, transparent: true, opacity: 0.5 });
  const sphere = new THREE.Mesh(geometry, material);
  mindarAnchor.group.add(sphere);

  // Events
  mindarAnchor.onTargetFound = () => {
    if (currentState === AppState.MINDAR_READY) {
      log('Target Found! Stabilizing...');
      currentState = AppState.MINDAR_TRACKING;
      beginPoseStabilization();
    }
  };

  mindarAnchor.onTargetLost = () => {
    if (currentState === AppState.MINDAR_TRACKING || currentState === AppState.POSE_STABILIZING) {
      log('Target Lost - Abort Transition');
      cancelPoseStabilization();
      currentState = AppState.MINDAR_READY;
      if (ui.transition) ui.transition.style.display = 'none';
    }
  };

  // Start MindAR
  try {
    log("Starting MindAR Video...");
    await mindarThree.start();
    renderer.setAnimationLoop(() => {
      if (currentState === AppState.MINDAR_TRACKING || currentState === AppState.POSE_STABILIZING) {
        if (currentState === AppState.POSE_STABILIZING) {
          bufferPose(mindarAnchor.group);
        }
      }
      renderer.render(mScene, mCamera);
    });
  } catch (e) {
    error("MindAR Start Failed: " + e.message);
    alert("Camera access denied or device not supported.");
  }
}

// --- Phase 2: Pose Stabilization (Critical Section) ---
function beginPoseStabilization() {
  currentState = AppState.POSE_STABILIZING;
  if (ui.mindarScanning) ui.mindarScanning.style.display = 'none';
  if (ui.transition) ui.transition.style.display = 'flex';
  if (ui.lockProgress) ui.lockProgress.style.width = '0%';

  poseBuffer = [];

  let progress = 0;
  const duration = 1500; // 1.5s lock time
  const interval = 50;

  poseStabilizeTimer = setInterval(() => {
    progress += (interval / duration) * 100;
    if (ui.lockProgress) ui.lockProgress.style.width = Math.min(progress, 100) + '%';

    if (progress >= 100) {
      clearInterval(poseStabilizeTimer);
      finalizeStabilization();
    }
  }, interval);
}

function cancelPoseStabilization() {
  clearInterval(poseStabilizeTimer);
  if (ui.lockProgress) ui.lockProgress.style.width = '0%';
  if (ui.transition) ui.transition.style.display = 'none';
  if (ui.mindarScanning) ui.mindarScanning.style.display = 'block';
}

function bufferPose(group) {
  poseBuffer.push({
    position: group.position.clone(),
    quaternion: group.quaternion.clone()
  });
}

function finalizeStabilization() {
  log('Stabilization Complete. Calculating Average Pose...');

  if (poseBuffer.length === 0) {
    error("No poses buffered!");
    cancelPoseStabilization();
    return;
  }

  // Average Position
  const avgPos = new THREE.Vector3();
  poseBuffer.forEach(p => avgPos.add(p.position));
  avgPos.divideScalar(poseBuffer.length);

  // Average Quaternion
  let avgQuat = poseBuffer[0].quaternion.clone();
  for (let i = 1; i < poseBuffer.length; i++) {
    avgQuat.slerp(poseBuffer[i].quaternion, 1 / (i + 1));
  }

  stabilizedPose = {
    position: avgPos,
    quaternion: avgQuat
  };

  log(`Stabilized Pose: ${JSON.stringify(stabilizedPose.position)}`);

  transitionToWebXR();
}

// --- Phase 3: Transition to WebXR ---
async function transitionToWebXR() {
  currentState = AppState.WEBXR_STARTING;

  log('Stopping MindAR...');
  mindarThree.stop();
  mindarThree.renderer.setAnimationLoop(null);
  mindarThree.renderer.dispose();

  // Remove MindAR video/canvas from DOM
  const video = document.querySelector('video');
  if (video) video.remove();
  const canvas = document.querySelector('canvas');
  if (canvas) canvas.remove();

  log('Starting WebXR Session...');
  startWebXRSession();
}

async function startWebXRSession() {
  if (!navigator.xr) {
    alert("WebXR not supported");
    return;
  }

  try {
    const session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['local', 'hit-test'],
      optionalFeatures: ['dom-overlay'],
      domOverlay: { root: document.body }
    });

    setupWebXRScene(session);

  } catch (e) {
    error("WebXR Start Failed: " + e);
    location.reload();
  }
}

function setupWebXRScene(session) {
  // Create new Renderer/Scene for WebXR
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 20);

  // Lighting
  const hemiLight = new THREE.HemisphereLight(0xffffff, 0xbbbbff, 1);
  hemiLight.position.set(0.5, 1, 0.25);
  scene.add(hemiLight);
  const dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
  dirLight.position.set(0, 10, 0);
  scene.add(dirLight);

  webxrRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  webxrRenderer.setPixelRatio(window.devicePixelRatio);
  webxrRenderer.setSize(window.innerWidth, window.innerHeight);
  webxrRenderer.xr.enabled = true;
  webxrRenderer.xr.setReferenceSpaceType('local');
  document.body.appendChild(webxrRenderer.domElement);

  // Scene Manager (Content)
  sceneManager = new SceneManager(scene, camera, log);
  sceneManager.loadSceneConfig('/scene.json'); // Load assets
  sceneManager.worldRoot.visible = false;

  // Setup Session
  webxrRenderer.xr.setSession(session);

  // Wait for "Tracking" state
  currentState = AppState.WORLD_LOCKING;

  session.addEventListener('end', () => {
    location.reload();
  });

  webxrRenderer.setAnimationLoop(renderWebXR);
}

// --- Phase 4 & 5: World Locking & Running ---
let stableFramesCount = 0;

function renderWebXR(timestamp, frame) {
  const delta = clock ? clock.getDelta() : 0.016;
  sceneManager.update(delta);

  if (!frame) return;

  const viewerPose = frame.getViewerPose(webxrRenderer.xr.getReferenceSpace());

  if (currentState === AppState.WORLD_LOCKING) {
    if (!viewerPose) return;

    // Wait for a few stable frames
    if (!viewerPose.emulatedPosition) {
      stableFramesCount++;
    } else {
      stableFramesCount = 0;
    }

    if (stableFramesCount > 10) {
      lockWorldOrigin(viewerPose);
    }
  }

  if (currentState === AppState.RUNNING) {
    // SLAM Status Update
    if (ui.poseInfo) {
      ui.poseInfo.innerText = viewerPose && viewerPose.emulatedPosition ? "SLAM: LOST" : "SLAM: Tracking";
    }
  }

  webxrRenderer.render(scene, camera);
}

function lockWorldOrigin(viewerPose) {
  log('Locking World Origin...');

  const cameraPosition = new THREE.Vector3().copy(viewerPose.transform.position);
  const cameraQuaternion = new THREE.Quaternion().copy(viewerPose.transform.orientation);

  // Marker Position in World = CameraPos + (CameraRot * MindAROffset)
  const offsetPos = stabilizedPose.position.clone();
  offsetPos.applyQuaternion(cameraQuaternion);
  const markerWorldPos = cameraPosition.clone().add(offsetPos);

  // Marker Rotation = CameraRot * MindARRot
  const markerWorldRot = cameraQuaternion.clone().multiply(stabilizedPose.quaternion);

  sceneManager.worldRoot.position.copy(markerWorldPos);

  // --- Vertical Alignment (Wall Mode) Fix ---
  // If we want to align to a vertical wall properly, ensure the Z-axis (normal) 
  // of the MindAR target maps to horizontal in WebXR.
  // Usually MindAR "Image Up" is Y.
  // We already copied rotation. Let's just trust it for now.
  sceneManager.worldRoot.quaternion.copy(markerWorldRot);
  sceneManager.worldRoot.visible = true;

  // Transition UI Done
  if (ui.transition) ui.transition.style.display = 'none';
  if (ui.runtime) ui.runtime.style.display = 'block';
  currentState = AppState.RUNNING;
  log('Transition Complete. Enjoy!');

  stabilizedPose = null;
  poseBuffer = null;
}

init();
