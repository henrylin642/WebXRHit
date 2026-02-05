import * as THREE from 'three';
import { MindARThree } from 'mindar-image-three';
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
let clock = new THREE.Clock();

// MindAR Data
let mindarAnchor = null;
let poseBuffer = [];
const POSE_BUFFER_SIZE = 15;
let poseStabilizeTimer = null;
let stabilizedPose = null;

// UI Elements
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
  log('State: INIT (ES Modules)');

  // Dependencies are imported, so they are ready if this script runs
  if (ui.arButton) {
    ui.arButton.innerText = "Start Experience";
    ui.arButton.disabled = false;
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
    log("Creating MindARThree instance...");
    mindarThree = new MindARThree({
      container: document.body,
      imageTargetSrc: '/targets.mind',
      filterMinCF: 0.0001,
      filterBeta: 0.001,
      uiLoading: 'no',
      uiScanning: 'no'
    });
  } catch (e) {
    error("MindAR Init Failed: " + e.message);
    console.error(e);
    return;
  }

  const { renderer, scene: mScene, camera: mCamera } = mindarThree;

  // Setup light
  const light = new THREE.HemisphereLight(0xffffff, 0xbbbbff, 1);
  mScene.add(light);

  // Anchor
  mindarAnchor = mindarThree.addAnchor(0);

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
          // IMPORTANT: Pass camera to bufferPose
          bufferPose(mindarAnchor.group, mCamera);
        }
      }
      renderer.render(mScene, mCamera);
    });
  } catch (e) {
    error("MindAR Start Failed: " + e.message);
    alert("Camera access denied or device not supported.");
  }
}

// --- Phase 2: Pose Stabilization ---
function beginPoseStabilization() {
  currentState = AppState.POSE_STABILIZING;
  if (ui.mindarScanning) ui.mindarScanning.style.display = 'none';
  if (ui.transition) ui.transition.style.display = 'flex';
  if (ui.lockProgress) ui.lockProgress.style.width = '0%';

  poseBuffer = [];

  let progress = 0;
  const duration = 1500;
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

function bufferPose(group, camera) {
  if (!camera) return;

  // Use world matrices for accuracy
  group.updateWorldMatrix(true, false);
  camera.updateWorldMatrix(true, false);

  const groupPos = new THREE.Vector3();
  const groupQuat = new THREE.Quaternion();
  group.getWorldPosition(groupPos);
  group.getWorldQuaternion(groupQuat);

  const camPos = new THREE.Vector3();
  const camQuat = new THREE.Quaternion();
  camera.getWorldPosition(camPos);
  camera.getWorldQuaternion(camQuat);

  // Calculate Target Pose in CAMERA SPACE
  // This removes the dependency on how MindAR manages the world (Target moving vs Camera moving)
  const relPos = groupPos.clone().sub(camPos).applyQuaternion(camQuat.clone().invert());
  const relQuat = camQuat.clone().invert().multiply(groupQuat);

  poseBuffer.push({
    position: relPos,
    quaternion: relQuat
  });
}

function finalizeStabilization() {
  log('Stabilization Complete.');

  if (poseBuffer.length === 0) {
    error("No poses buffered!");
    cancelPoseStabilization();
    return;
  }

  const avgPos = new THREE.Vector3();
  poseBuffer.forEach(p => avgPos.add(p.position));
  avgPos.divideScalar(poseBuffer.length);

  let avgQuat = poseBuffer[0].quaternion.clone();
  for (let i = 1; i < poseBuffer.length; i++) {
    avgQuat.slerp(poseBuffer[i].quaternion, 1 / (i + 1));
  }

  stabilizedPose = {
    position: avgPos,
    quaternion: avgQuat
  };

  transitionToWebXR();
}

// --- Phase 3: Transition to WebXR ---
async function transitionToWebXR() {
  currentState = AppState.WEBXR_STARTING;

  log('Stopping MindAR for WebXR...');
  mindarThree.stop();
  mindarThree.renderer.setAnimationLoop(null);
  mindarThree.renderer.dispose();

  const video = document.querySelector('video');
  if (video) video.remove();
  const canvas = document.querySelector('canvas');
  if (canvas) canvas.remove();

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
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 20);

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

  sceneManager = new SceneManager(scene, camera, log);
  sceneManager.loadSceneConfig('/scene.json');
  sceneManager.worldRoot.visible = false;

  webxrRenderer.xr.setSession(session);

  currentState = AppState.WORLD_LOCKING;

  session.addEventListener('end', () => {
    location.reload();
  });

  webxrRenderer.setAnimationLoop(renderWebXR);
}

let stableFramesCount = 0;

function renderWebXR(timestamp, frame) {
  const delta = clock.getDelta();
  sceneManager.update(delta);

  if (!frame) return;

  const viewerPose = frame.getViewerPose(webxrRenderer.xr.getReferenceSpace());

  if (currentState === AppState.WORLD_LOCKING) {
    if (!viewerPose) return;

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
    if (ui.poseInfo) {
      ui.poseInfo.innerText = viewerPose && viewerPose.emulatedPosition ? "SLAM: LOST" : "SLAM: Tracking";
    }
  }

  webxrRenderer.render(scene, camera);
}

function lockWorldOrigin(viewerPose) {
  log('Locking World Origin (Gravity Corrected)...');

  const cameraPosition = new THREE.Vector3().copy(viewerPose.transform.position);
  const cameraQuaternion = new THREE.Quaternion().copy(viewerPose.transform.orientation);

  // 1. Calculate the Marker's Position in WebXR Space
  // offsetPos is the vector "Camera -> Marker" in Camera Space
  // So we rotate it by Camera Rotation to get World Vector
  const offsetPos = stabilizedPose.position.clone();
  offsetPos.applyQuaternion(cameraQuaternion);
  const markerWorldPos = cameraPosition.clone().add(offsetPos);

  // 2. Calculate the Marker's Rotation in WebXR Space
  // Marker Rot = Camera Rot * Local Rot
  const markerWorldRot = cameraQuaternion.clone().multiply(stabilizedPose.quaternion);

  // 3. Gravity Correction
  // We want Y-up.
  // Use the Marker's forward direction to determine yaw, but force Pitch/Roll to zero (align to gravity)
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(markerWorldRot);
  forward.y = 0; // Project to floor
  forward.normalize();

  const gravityAlignedQuaternion = new THREE.Quaternion();
  const dummyMatrix = new THREE.Matrix4();
  const targetPos = markerWorldPos.clone().add(forward);
  dummyMatrix.lookAt(markerWorldPos, targetPos, new THREE.Vector3(0, 1, 0));
  gravityAlignedQuaternion.setFromRotationMatrix(dummyMatrix);

  // Apply
  sceneManager.worldRoot.position.copy(markerWorldPos);
  sceneManager.worldRoot.quaternion.copy(gravityAlignedQuaternion);
  sceneManager.worldRoot.visible = true;

  if (ui.transition) ui.transition.style.display = 'none';
  if (ui.runtime) ui.runtime.style.display = 'block';
  currentState = AppState.RUNNING;
  log('Transition Complete.');

  stabilizedPose = null;
  poseBuffer = null;
}

init();
