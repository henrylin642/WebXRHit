import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

export class SceneManager {
    constructor(scene, camera, logger) {
        this.scene = scene;
        this.camera = camera;
        this.log = logger || console.log;

        // The Root container for all AR content.
        // We will move THIS container to match the MindAR anchor.
        this.worldRoot = new THREE.Group();
        this.scene.add(this.worldRoot);

        this.raycaster = new THREE.Raycaster();
        this.objectsToIntersect = [];
        this.eventListeners = {};
    }

    loadSceneConfig(configUrl) {
        this.log(`Loading scene config: ${configUrl}`);
        fetch(configUrl)
            .then(res => res.json())
            .then(config => {
                this.buildSceneFromConfig(config);
            })
            .catch(err => {
                this.log('Error loading config: ' + err);
                // Fallback: Add a simple cube if config fails
                this.addTestCube();
            });
    }

    addTestCube() {
        const geometry = new THREE.BoxGeometry(0.5, 0.5, 0.5);
        const material = new THREE.MeshNormalMaterial();
        const cube = new THREE.Mesh(geometry, material);
        this.worldRoot.add(cube);
    }

    buildSceneFromConfig(config) {
        if (!config.objects) return;

        const loader = new GLTFLoader();

        config.objects.forEach(objData => {
            if (objData.type === 'model') {
                loader.load(objData.url, (gltf) => {
                    const model = gltf.scene;
                    this.applyTransform(model, objData);
                    model.userData = { ...objData }; // Store metadata
                    this.worldRoot.add(model);

                    if (objData.interactive) {
                        this.objectsToIntersect.push(model);
                    }
                }, undefined, (err) => {
                    this.log(`Failed to load model ${objData.url}: ${err}`);
                });
            } else if (objData.type === 'primitive') {
                // Handle basic cues/spheres
                let geo, mat;
                if (objData.shape === 'sphere') {
                    geo = new THREE.SphereGeometry(objData.scale?.x || 0.1);
                    mat = new THREE.MeshStandardMaterial({ color: objData.color || 0xffffff });
                } else {
                    geo = new THREE.BoxGeometry(0.2, 0.2, 0.2);
                    mat = new THREE.MeshStandardMaterial({ color: objData.color || 0xff0000 });
                }
                const mesh = new THREE.Mesh(geo, mat);
                this.applyTransform(mesh, objData);
                mesh.userData = { ...objData };
                this.worldRoot.add(mesh);

                if (objData.interactive) {
                    this.objectsToIntersect.push(mesh);
                }
            }
        });
    }

    applyTransform(object, data) {
        if (data.position) object.position.set(data.position.x, data.position.y, data.position.z);
        if (data.rotation) object.rotation.set(
            THREE.MathUtils.degToRad(data.rotation.x),
            THREE.MathUtils.degToRad(data.rotation.y),
            THREE.MathUtils.degToRad(data.rotation.z)
        );
        if (data.scale) object.scale.set(data.scale.x, data.scale.y, data.scale.z);
    }

    update(delta) {
        // Animation updates if needed
        this.worldRoot.children.forEach(child => {
            if (child.userData && child.userData.animate) {
                child.rotation.y += delta * 0.5;
            }
        });
    }

    raycast(controller) {
        // Controller is a generic XR controller Group
        // We raycast from controller position in direction of controller forward
        // But WebXR Controller 'select' event handles imply pointing.
        // We use the matrixWorld of the controller to get origin/direction.

        const tempMatrix = new THREE.Matrix4();
        tempMatrix.identity().extractRotation(controller.matrixWorld);

        this.raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
        this.raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix);

        const intersects = this.raycaster.intersectObjects(this.objectsToIntersect, true);
        if (intersects.length > 0) {
            return intersects[0].object;
        }
        return null;
    }

    getObjectName(object) {
        return object.userData.id || 'Unknown Object';
    }

    triggerEvent(layoutId, value) {
        this.log(`Trigger event for ${layoutId}: ${value}`);
        // Handle interactions, e.g. play sound, show info
    }
}
