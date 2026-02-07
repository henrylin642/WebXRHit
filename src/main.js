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
let lastMindarRelPose = null;
let lastMindarRawPose = null;
let lastMindarNormPose = null;
let lastVideoSize = { width: 0, height: 0 };

// IMPORTANT: Physical width of the marker in meters.
let PHYSICAL_MARKER_WIDTH = 0.58;
let MINDAR_TARGET_SRC = '/targets.mind';
let REQUESTED_VIDEO_HEIGHT = 720; // Default to 720p

// --- Testing Metrics Globals ---
let metrics = {
  maxDistance: 0,
  consecutiveFrames: 0,
  rotationHistory: [], // Array of Euler angles for SD calculation
  jitterSD: 0,
  caseADetected: false
};
const JITTER_WINDOW_SIZE = 30;

const TARGET_OFFSETS = {
  0: new THREE.Vector3(0, -0.29, 0), // Top (Idx 0): 中心在頂端下方 29cm
  1: new THREE.Vector3(0, -0.87, 0), // Mid (Idx 1): 中心在頂端下方 87cm
  2: new THREE.Vector3(0, -1.45, 0)  // Bot (Idx 2)
};
const TARGET_NAMES = { 0: "TOP (上)", 1: "MID (中)", 2: "BOT (下)" };
let currentTargetIndex = 0;
const MAX_MARKER_DISTANCE = 5;
let webxrSessionStarting = false;
const USE_GRAVITY_ALIGN = true;
const FLIP_MARKER_Z = true;
const AUTO_NORMALIZE_BY_VIDEO = true;
const USE_MARKER_WIDTH_SCALE = true;
const INVERT_MARKER_OFFSET = false; // 修正：不再反轉位移，讓加法邏輯直覺化
const WORLD_Y_OFFSET = 0.0;
const ALIGN_MODE = "gravity+board"; // "gravity+board" | "full"
const MINDAR_SCALE_ADJUST = 3.0; // 根據用戶回饋修正 3 倍誤差
let pendingWebXRStart = false;

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
  cameraPose: document.getElementById('camera-pose'),
  mindarPose: document.getElementById('mindar-pose'),
  // Settings UI
  settingsBtn: document.getElementById('settings-btn'),
  settingsModal: document.getElementById('settings-modal'),
  saveSettings: document.getElementById('save-settings'),
  closeSettings: document.getElementById('close-settings'),
  widthInput: document.getElementById('marker-width-input'),
  targetInput: document.getElementById('mind-target-input'),
  resInput: document.getElementById('camera-res-input'),
  metricsOverlay: document.getElementById('metrics-overlay'),
  metricRes: document.getElementById('metric-res'),
  metricDist: document.getElementById('metric-dist'),
  metricStability: document.getElementById('metric-stability'),
  metricJitter: document.getElementById('metric-jitter')
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

  const savedTarget = localStorage.getItem('mindarTarget');
  if (savedTarget) {
    MINDAR_TARGET_SRC = savedTarget;
    if (ui.targetInput) ui.targetInput.value = MINDAR_TARGET_SRC;
    log(`Loaded saved target: ${MINDAR_TARGET_SRC}`);
  }

  const savedRes = localStorage.getItem('cameraRes');
  if (savedRes) {
    REQUESTED_VIDEO_HEIGHT = parseInt(savedRes);
    if (ui.resInput) ui.resInput.value = REQUESTED_VIDEO_HEIGHT;
    log(`Loaded saved camera resolution: ${REQUESTED_VIDEO_HEIGHT}p`);
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
      const widthVal = parseFloat(ui.widthInput.value);
      const targetVal = ui.targetInput.value;
      const resVal = parseInt(ui.resInput.value);
      let needsReload = false;

      if (widthVal > 0) {
        if (PHYSICAL_MARKER_WIDTH !== widthVal) {
          PHYSICAL_MARKER_WIDTH = widthVal;
          localStorage.setItem('markerWidth', widthVal);
          log(`Updated Marker Width to: ${widthVal}m`);
        }
      } else {
        alert("Invalid width");
        return;
      }

      if (MINDAR_TARGET_SRC !== targetVal) {
        MINDAR_TARGET_SRC = targetVal;
        localStorage.setItem('mindarTarget', targetVal);
        log(`Updated MindAR Target to: ${targetVal}`);
        needsReload = true;
      }

      if (REQUESTED_VIDEO_HEIGHT !== resVal) {
        REQUESTED_VIDEO_HEIGHT = resVal;
        localStorage.setItem('cameraRes', resVal);
        log(`Updated Camera Resolution to: ${resVal}p`);
        needsReload = true;
      }

      if (ui.settingsModal) ui.settingsModal.style.display = 'none';

      if (needsReload) {
        log("Target changed - reloading page...");
        setTimeout(() => location.reload(), 500);
      }
    });
  }

  if (ui.webxrStartBtn) {
    ui.webxrStartBtn.addEventListener('click', () => {
      pendingWebXRStart = false;
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
      imageTargetSrc: MINDAR_TARGET_SRC,
      video: {
        facingMode: 'environment',
        height: { ideal: REQUESTED_VIDEO_HEIGHT }
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

  // Use a loop to setup multiple anchors
  for (let i = 0; i < 3; i++) {
    const anchor = mindarThree.addAnchor(i);
    // Visual feedback for development (optional: only add to the first one or all)
    if (i === 0) anchor.group.add(sphere);

    anchor.onTargetFound = () => {
      if (currentState === AppState.MINDAR_READY) {
        const name = TARGET_NAMES[i] || "Unknown";
        log(`Target Found: ${name} (Index ${i})`);

        // --- Metrics Detection ---
        if (lastMindarRelPose) {
          const dist = lastMindarRelPose.position.length();
          metrics.maxDistance = dist;
          log(`First Detection Distance: ${dist.toFixed(3)}m`);
        }

        currentTargetIndex = i;
        mindarAnchor = anchor;
        currentState = AppState.MINDAR_TRACKING;

        if (ui.metricsOverlay) ui.metricsOverlay.style.display = 'block';

        beginPoseStabilization();
      }
    };

    anchor.onTargetLost = () => {
      if (currentState === AppState.MINDAR_TRACKING || currentState === AppState.POSE_STABILIZING) {
        if (mindarAnchor === anchor) {
          log('Target Lost - Abort Transition');
          cancelPoseStabilization();
          currentState = AppState.MINDAR_READY;
          if (ui.transition) ui.transition.style.display = 'none';
        }
      }
    };
  }

  try {
    log("Starting MindAR Video...");
    await mindarThree.start();
    const video = document.querySelector('video');
    if (video) {
      const updateVideoSize = () => {
        const track = video.srcObject && video.srcObject.getVideoTracks
          ? video.srcObject.getVideoTracks()[0]
          : null;
        const settings = track && track.getSettings ? track.getSettings() : null;
        lastVideoSize.width = (settings && settings.width) || video.videoWidth || 0;
        lastVideoSize.height = (settings && settings.height) || video.videoHeight || 0;
      };
      updateVideoSize();
      video.addEventListener('loadedmetadata', updateVideoSize);
    }
    renderer.setAnimationLoop(() => {
      if (currentState === AppState.MINDAR_TRACKING || currentState === AppState.POSE_STABILIZING) {
        if (currentState === AppState.POSE_STABILIZING) {
          bufferPose(mindarAnchor.group, mCamera);
          updateMetrics();
        }
        metrics.consecutiveFrames++;
      } else {
        metrics.consecutiveFrames = 0;
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
      showConfirmButton(); // 顯示手動進入按鈕
    }
  }, interval);
}

function showConfirmButton() {
  const btn = document.getElementById('confirm-lock-btn');
  const statusText = document.querySelector('#transition-overlay div div:nth-child(3)');
  const icon = document.getElementById('lock-status-icon');

  if (statusText) statusText.innerText = '位置已鎖定，正在進入 AR...';
  if (icon) icon.innerText = '✅';

  // Automated transition after 1 second
  log("Space locked. Auto-transitioning to WebXR in 1s...");
  setTimeout(() => {
    if (btn) btn.style.display = 'none';
    finalizeStabilization();
  }, 1000);
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
  // MindAR anchor.group world matrix encodes the camera-relative pose.
  const relPos = new THREE.Vector3();
  const relQuat = new THREE.Quaternion();
  // MindAR updates anchor.group.matrix directly.
  group.matrix.decompose(relPos, relQuat, new THREE.Vector3());

  // Standard Three.js: Objects in front of camera have negative Z.
  // We no longer manually flip Z here to maintain camera-space consistency.

  lastMindarRawPose = { position: relPos.clone(), quaternion: relQuat.clone() };

  // Calculate focal length from MindAR camera
  const proj = camera.projectionMatrix.elements;
  const focalLength = (proj[5] * lastVideoSize.height) / 2;

  let normPos = relPos.clone();
  if (focalLength > 0) {
    normPos.divideScalar(focalLength);
  }

  lastMindarNormPose = { position: normPos.clone(), quaternion: relQuat.clone() };
  // 修正比例係數：根據用戶 2.5m 實測數據微調
  const scaleFactor = (USE_MARKER_WIDTH_SCALE ? PHYSICAL_MARKER_WIDTH : 1) / 3.0;
  const scaledPos = normPos.clone().multiplyScalar(scaleFactor);
  lastMindarRelPose = { position: scaledPos.clone(), quaternion: relQuat.clone() };
  poseBuffer.push({ position: scaledPos, quaternion: relQuat });

  if (ui.mindarPose) {
    const dx = scaledPos.x;
    const dy = scaledPos.y;
    const dz = scaledPos.z;
    const euler = new THREE.Euler().setFromQuaternion(relQuat, 'YXZ');
    const degX = THREE.MathUtils.radToDeg(euler.x);
    const degY = THREE.MathUtils.radToDeg(euler.y);
    const degZ = THREE.MathUtils.radToDeg(euler.z);
    ui.mindarPose.innerText =
      `Target: ${TARGET_NAMES[currentTargetIndex] || "None"} (Idx:${currentTargetIndex})\n` +
      `Video: ${lastVideoSize.width}x${lastVideoSize.height} (${REQUESTED_VIDEO_HEIGHT}p set)\n` +
      `Diagnosis: ${lastVideoSize.height >= REQUESTED_VIDEO_HEIGHT ? "Case B (MindAR Limit?)" : "Case A (Camera Limit?)"}\n` +
      `Rel: (${scaledPos.x.toFixed(3)}, ${scaledPos.y.toFixed(3)}, ${scaledPos.z.toFixed(3)})\n` +
      `Rot: (${degX.toFixed(1)}, ${degY.toFixed(1)}, ${degZ.toFixed(1)})\n` +
      `Dist: ${scaledPos.length().toFixed(3)}m`;
  }
}

function updateMetrics() {
  if (!lastMindarRelPose) return;

  // Track Rotation History for Jitter (SD)
  const euler = new THREE.Euler().setFromQuaternion(lastMindarRelPose.quaternion, 'YXZ');
  metrics.rotationHistory.push({ x: euler.x, y: euler.y, z: euler.z });
  if (metrics.rotationHistory.length > JITTER_WINDOW_SIZE) {
    metrics.rotationHistory.shift();
  }

  // Calculate StdDev of Rotation
  if (metrics.rotationHistory.length >= 10) {
    const avg = { x: 0, y: 0, z: 0 };
    metrics.rotationHistory.forEach(r => { avg.x += r.x; avg.y += r.y; avg.z += r.z; });
    avg.x /= metrics.rotationHistory.length;
    avg.y /= metrics.rotationHistory.length;
    avg.z /= metrics.rotationHistory.length;

    let variance = 0;
    metrics.rotationHistory.forEach(r => {
      variance += Math.pow(r.x - avg.x, 2) + Math.pow(r.y - avg.y, 2) + Math.pow(r.z - avg.z, 2);
    });
    metrics.jitterSD = Math.sqrt(variance / metrics.rotationHistory.length);
  }

  // Update UI
  if (ui.metricRes) ui.metricRes.innerText = `Res: ${lastVideoSize.width}x${lastVideoSize.height} (${REQUESTED_VIDEO_HEIGHT}p)`;
  if (ui.metricDist) ui.metricDist.innerText = `Max Dist: ${metrics.maxDistance.toFixed(3)}m`;
  if (ui.metricStability) ui.metricStability.innerText = `Stability: ${metrics.consecutiveFrames} frames`;
  if (ui.metricJitter) ui.metricJitter.innerText = `Jitter (SD): ${metrics.jitterSD.toFixed(4)}`;
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
  startWebXRSession();
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
    if (String(e).includes('user activation')) {
      pendingWebXRStart = true;
      if (ui.webxrStartOverlay) ui.webxrStartOverlay.style.display = 'flex';
    }
    webxrSessionStarting = false;
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
let lockWaitFrames = 0;
function renderWebXR(timestamp, frame) {
  const delta = clock.getDelta();
  sceneManager.update(delta, camera);
  if (!frame) return;
  const viewerPose = frame.getViewerPose(webxrRenderer.xr.getReferenceSpace());
  if (currentState === AppState.WORLD_LOCKING) {
    if (!viewerPose) return;
    lockWaitFrames++;
    if (!viewerPose.emulatedPosition) stableFramesCount++;
    else stableFramesCount = 0;
    if (stableFramesCount > 10 || lockWaitFrames > 60) lockWorldOrigin(viewerPose);
  }
  if (viewerPose && ui.cameraPose) {
    const camPos = viewerPose.transform.position;
    const camQuat = viewerPose.transform.orientation;
    const rootPos = sceneManager.worldRoot.position;
    const rootQuat = sceneManager.worldRoot.quaternion;
    const dx = camPos.x - rootPos.x;
    const dy = camPos.y - rootPos.y;
    const dz = camPos.z - rootPos.z;
    const mindarPos = (stabilizedPose || lastMindarRelPose) ? (stabilizedPose || lastMindarRelPose).position : null;
    const stabilizedPos = stabilizedPose ? stabilizedPose.position : null;
    const mindarRawPos = lastMindarRawPose ? lastMindarRawPose.position : null;
    const mindarNormPos = lastMindarNormPose ? lastMindarNormPose.position : null;
    const rootQuatInv = rootQuat.clone().invert();
    const camLocalPos = new THREE.Vector3(camPos.x, camPos.y, camPos.z)
      .sub(rootPos)
      .applyQuaternion(rootQuatInv);
    const camLocalQuat = rootQuatInv.clone().multiply(new THREE.Quaternion(camQuat.x, camQuat.y, camQuat.z, camQuat.w));
    const camEuler = new THREE.Euler().setFromQuaternion(camLocalQuat, 'YXZ');
    const camRot = {
      x: THREE.MathUtils.radToDeg(camEuler.x),
      y: THREE.MathUtils.radToDeg(camEuler.y),
      z: THREE.MathUtils.radToDeg(camEuler.z)
    };
    ui.cameraPose.innerText =
      `cam: (${camPos.x.toFixed(3)}, ${camPos.y.toFixed(3)}, ${camPos.z.toFixed(3)})\n` +
      `dxyz: (${dx.toFixed(3)}, ${dy.toFixed(3)}, ${dz.toFixed(3)})\n` +
      (mindarRawPos
        ? `raw: (${mindarRawPos.x.toFixed(3)}, ${mindarRawPos.y.toFixed(3)}, ${mindarRawPos.z.toFixed(3)})\n`
        : `raw: (n/a)\n`) +
      (mindarNormPos
        ? `norm: (${mindarNormPos.x.toFixed(3)}, ${mindarNormPos.y.toFixed(3)}, ${mindarNormPos.z.toFixed(3)})\n`
        : `norm: (n/a)\n`) +
      (mindarPos
        ? `scaled: (${mindarPos.x.toFixed(3)}, ${mindarPos.y.toFixed(3)}, ${mindarPos.z.toFixed(3)})\n`
        : `scaled: (n/a)\n`) +
      `camL: (${camLocalPos.x.toFixed(3)}, ${camLocalPos.y.toFixed(3)}, ${camLocalPos.z.toFixed(3)})\n` +
      `rot: (${camRot.x.toFixed(1)}, ${camRot.y.toFixed(1)}, ${camRot.z.toFixed(1)})\n` +
      `root: (${rootPos.x.toFixed(3)}, ${rootPos.y.toFixed(3)}, ${rootPos.z.toFixed(3)})\n` +
      `yOff: ${WORLD_Y_OFFSET.toFixed(2)} mode: ${ALIGN_MODE}\n` +
      (stabilizedPos
        ? `stb: (${stabilizedPos.x.toFixed(3)}, ${stabilizedPos.y.toFixed(3)}, ${stabilizedPos.z.toFixed(3)})`
        : `stb: (n/a)`);
  }
  if (currentState === AppState.RUNNING) {
    if (ui.poseInfo) ui.poseInfo.innerText = viewerPose && viewerPose.emulatedPosition ? "SLAM: LOST" : "SLAM: Tracking";
  }
  webxrRenderer.render(scene, camera);
}

function lockWorldOrigin(viewerPose) {
  log('Locking World Origin...');
  if (!stabilizedPose) {
    error("No stabilized pose; cannot lock world origin.");
    return;
  }
  lockWaitFrames = 0;
  const cameraPosition = new THREE.Vector3().copy(viewerPose.transform.position);
  const cameraQuaternion = new THREE.Quaternion().copy(viewerPose.transform.orientation);

  // 1. Get stabilized pose in Camera Space (relPos.z is negative if in front)
  const relPos = stabilizedPose.position.clone();
  const relQuat = stabilizedPose.quaternion.clone();

  // 2. Adjust Origin: The "Top Edge Center" relative to the detected Target center
  // If Target is at (0,-0.29,0) relative to Top, then Top is at (0,+0.29,0) relative to Target
  const targetToOrigin = TARGET_OFFSETS[currentTargetIndex].clone().multiplyScalar(-1);

  // Important: apply target-to-origin offset in marker's local space then transform to camera space
  const originInCamSpace = relPos.clone().add(targetToOrigin.applyQuaternion(relQuat));

  // 3. Transformation to World Space
  // We place the world root where the origin is calculated to be in world space
  const markerWorldPos = cameraPosition.clone().add(originInCamSpace.clone().applyQuaternion(cameraQuaternion));

  markerWorldPos.y += WORLD_Y_OFFSET;
  const markerWorldRot = cameraQuaternion.clone().multiply(relQuat);
  let finalRotation = markerWorldRot;
  if (USE_GRAVITY_ALIGN) {
    if (ALIGN_MODE === "full") {
      finalRotation = markerWorldRot;
    } else {
      // gravity+board: keep Y vertical, align Z to marker normal projected on XZ.
      const forward = new THREE.Vector3(0, 0, FLIP_MARKER_Z ? 1 : -1).applyQuaternion(markerWorldRot);
      const up = new THREE.Vector3(0, 1, 0);
      const fwd = forward.clone().projectOnPlane(up);
      if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
      fwd.normalize();
      const right = new THREE.Vector3().crossVectors(up, fwd).normalize();
      const correctedForward = new THREE.Vector3().crossVectors(right, up).normalize();
      const m = new THREE.Matrix4().makeBasis(right, up, correctedForward);
      finalRotation = new THREE.Quaternion().setFromRotationMatrix(m);
    }
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
