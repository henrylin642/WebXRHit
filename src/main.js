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

// IMPORTANT: Physical width of the marker in meters.
let PHYSICAL_MARKER_WIDTH = 0.55;
const MAX_MARKER_DISTANCE = 5;
let webxrSessionStarting = false;
const USE_GRAVITY_ALIGN = true;

// UI Elements
let ui = {
  overlay: document.getElementById('overlay'),
  mindarScanning: document.getElementById('mindar-scanning-ui'),
  transition: document.getElementById('transition-overlay'),
  lockProgress: document.getElementById('lock-progress'),
  loading: document.getElementById('loading-screen'),
  webxrStartOverlay: document.getElementById('webxr-start-overlay'),
  webxrStartBtn: document.getElementById('webxr-start-btn'),
  runtime: document.getElementById('runtime-ui'),
  arButton: document.getElementById('ar-button'),
  poseInfo: document.getElementById('pose-info'),
  // Settings UI
  settingsBtn: document.getElementById('settings-btn'),
  settingsModal: document.getElementById('settings-modal'),
  saveSettings: document.getElementById('save-settings'),
  closeSettings: document.getElementById('close-settings'),
  widthInput: document.getElementById('marker-width-input')
};

// --- Initialization ---
async function init() {
  log('State: INIT (ES Modules)');

  // Load saved setting
  const savedWidth = localStorage.getItem('markerWidth');
  if (savedWidth) {
    PHYSICAL_MARKER_WIDTH = parseFloat(savedWidth);
    if (ui.widthInput) ui.widthInput.value = PHYSICAL_MARKER_WIDTH;
    log(`Loaded saved marker width: ${PHYSICAL_MARKER_WIDTH}m`);
  }

  if (ui.arButton) {
    ui.arButton.innerText = "Start Experience";
    ui.arButton.disabled = false;
    ui.arButton.addEventListener('click', startMindARPhase);
  }

  // Settings Events
  if (ui.settingsBtn) {
    ui.settingsBtn.addEventListener('click', () => {
      if (ui.settingsModal) ui.settingsModal.style.display = 'flex';
    });
  }

  if (ui.closeSettings) {
    ui.closeSettings.addEventListener('click', () => {
      if (ui.settingsModal) ui.settingsModal.style.display = 'none';
    });
  }

  if (ui.saveSettings) {
    ui.saveSettings.addEventListener('click', () => {
      const val = parseFloat(ui.widthInput.value);
      if (val > 0) {
        PHYSICAL_MARKER_WIDTH = val;
        localStorage.setItem('markerWidth', val);
        log(`Updated Marker Width to: ${val}m`);
        if (ui.settingsModal) ui.settingsModal.style.display = 'none';
      } else {
        alert("Invalid width");
      }
    });
  }

  if (ui.webxrStartBtn) {
    ui.webxrStartBtn.addEventListener('click', () => {
      if (ui.webxrStartOverlay) ui.webxrStartOverlay.style.display = 'none';
      startWebXRSession();
    });
  }

  // Exit Button logic
  const exitBtn = document.getElementById('exit-ar-btn');
  if (exitBtn) {
    exitBtn.addEventListener('click', () => location.reload());
  }
}

// --- Phase 1: MindAR Image Tracking ---
async function startMindARPhase() {
  if (ui.overlay) ui.overlay.style.display = 'none';
  if (ui.mindarScanning) ui.mindarScanning.style.display = 'block';
  currentState = AppState.MINDAR_READY;

  log('Starting MindAR Setup...');

  try {
    log("Creating MindARThree instance...");
    mindarThree = new MindARThree({
      container: document.body,
      imageTargetSrc: '/targets.mind',
      video: {
        facingMode: 'environment',
        width: { ideal: 1280 },
        height: { ideal: 720 }
      },
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
  renderer.setPixelRatio(window.devicePixelRatio);

  const light = new THREE.HemisphereLight(0xffffff, 0xbbbbff, 1);
  mScene.add(light);

  mindarAnchor = mindarThree.addAnchor(0);

  const geometry = new THREE.SphereGeometry(0.1, 32, 32);
  const material = new THREE.MeshBasicMaterial({ color: 0x00ff00, transparent: true, opacity: 0.5 });
  const sphere = new THREE.Mesh(geometry, material);
  mindarAnchor.group.add(sphere);

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

  try {
    log("Starting MindAR Video...");
    await mindarThree.start();
    renderer.setAnimationLoop(() => {
      if (currentState === AppState.MINDAR_TRACKING || currentState === AppState.POSE_STABILIZING) {
        if (currentState === AppState.POSE_STABILIZING) {
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
  const relPos = groupPos.clone().sub(camPos).applyQuaternion(camQuat.clone().invert());
  relPos.multiplyScalar(PHYSICAL_MARKER_WIDTH);
  const relQuat = camQuat.clone().invert().multiply(groupQuat);
  poseBuffer.push({ position: relPos, quaternion: relQuat });
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
  stabilizedPose = { position: avgPos, quaternion: avgQuat };
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
  if (ui.webxrStartOverlay) ui.webxrStartOverlay.style.display = 'flex';
}

async function startWebXRSession() {
  if (webxrSessionStarting) return;
  webxrSessionStarting = true;
  if (!navigator.xr) {
    alert("WebXR not supported");
    webxrSessionStarting = false;
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
    webxrSessionStarting = false;
    if (ui.webxrStartOverlay) ui.webxrStartOverlay.style.display = 'flex';
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

  // --- Interaction ---
  const controller = webxrRenderer.xr.getController(0);
  controller.addEventListener('select', () => {
    if (currentState !== AppState.RUNNING) return;
    const hit = sceneManager.raycast(controller);
    if (hit) {
      log(`Hit: ${hit.userData.name}`);
      if (hit.userData.url) openIframe(hit.userData.url);
    }
  });
  scene.add(controller);

  const closeIframeBtn = document.getElementById('close-iframe');
  if (closeIframeBtn) {
    closeIframeBtn.addEventListener('click', () => {
      const overlay = document.getElementById('iframe-overlay');
      if (overlay) overlay.style.display = 'none';
    });
  }

  currentState = AppState.WORLD_LOCKING;
  session.addEventListener('end', () => location.reload());
  webxrRenderer.setAnimationLoop(renderWebXR);
}

function openIframe(url) {
  const overlay = document.getElementById('iframe-overlay');
  const iframe = document.getElementById('web-iframe');
  if (overlay && iframe) {
    iframe.src = url;
    overlay.style.display = 'block';
    log(`Opening: ${url}`);
  }
}

let stableFramesCount = 0;
function renderWebXR(timestamp, frame) {
  const delta = clock.getDelta();
  sceneManager.update(delta, camera);
  if (!frame) return;
  const viewerPose = frame.getViewerPose(webxrRenderer.xr.getReferenceSpace());
  if (currentState === AppState.WORLD_LOCKING) {
    if (!viewerPose) return;
    if (!viewerPose.emulatedPosition) stableFramesCount++;
    else stableFramesCount = 0;
    if (stableFramesCount > 10) lockWorldOrigin(viewerPose);
  }
  if (currentState === AppState.RUNNING) {
    if (ui.poseInfo) ui.poseInfo.innerText = viewerPose && viewerPose.emulatedPosition ? "SLAM: LOST" : "SLAM: Tracking";
  }
  webxrRenderer.render(scene, camera);
}

function lockWorldOrigin(viewerPose) {
  log('Locking World Origin...');
  const cameraPosition = new THREE.Vector3().copy(viewerPose.transform.position);
  const cameraQuaternion = new THREE.Quaternion().copy(viewerPose.transform.orientation);
  const offsetPos = stabilizedPose.position.clone();
  offsetPos.applyQuaternion(cameraQuaternion);
  if (offsetPos.length() > MAX_MARKER_DISTANCE) {
    offsetPos.setLength(MAX_MARKER_DISTANCE);
  }
  const markerWorldPos = cameraPosition.clone().add(offsetPos);
  const markerWorldRot = cameraQuaternion.clone().multiply(stabilizedPose.quaternion);
  let finalRotation = markerWorldRot;
  if (USE_GRAVITY_ALIGN) {
    // Yaw-only: keep vertical axis aligned to gravity, align Z to marker normal projected on XZ.
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(markerWorldRot);
    forward.y = 0;
    if (forward.lengthSq() < 1e-6) {
      forward.set(0, 0, -1);
    } else {
      forward.normalize();
    }
    const yaw = Math.atan2(forward.x, forward.z);
    finalRotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0, 'YXZ'));
  }
  sceneManager.worldRoot.position.copy(markerWorldPos);
  sceneManager.worldRoot.quaternion.copy(finalRotation);
  sceneManager.worldRoot.visible = true;
  if (ui.transition) ui.transition.style.display = 'none';
  if (ui.runtime) ui.runtime.style.display = 'block';
  currentState = AppState.RUNNING;
  log('Transition Complete.');
  stabilizedPose = null;
  poseBuffer = null;
}

init();
