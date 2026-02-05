import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export class SceneManager {
    constructor(scene, camera, logger) {
        this.scene = scene;
        this.camera = camera;
        this.log = logger || console.log;

        this.worldRoot = new THREE.Group();
        this.scene.add(this.worldRoot);

        this.raycaster = new THREE.Raycaster();
        this.objectsToIntersect = [];
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
                this.addTestCube();
            });
    }

    addTestCube() {
        this.log("Adding Test Cube");
        const geometry = new THREE.BoxGeometry(0.2, 0.2, 0.2);
        const material = new THREE.MeshBasicMaterial({ color: 0xff0000, wireframe: true });
        const cube = new THREE.Mesh(geometry, material);
        cube.position.set(0, 0, -1);
        this.worldRoot.add(cube);
        this.addThickAxes(1, 0.02);
    }

    buildSceneFromConfig(config) {
        const objects = config.ar_objects || config.objects;
        if (!objects || objects.length === 0) {
            this.log("No objects found in scene config. Adding test cube.");
            this.addTestCube();
            return;
        }

        const loader = new GLTFLoader();
        objects.forEach(objData => {
            let modelUrl = null;
            if (objData.model) {
                if (objData.model.ios_texture && objData.model.ios_texture.url) {
                    modelUrl = objData.model.ios_texture.url;
                } else if (objData.model.texture && objData.model.texture.url) {
                    modelUrl = objData.model.texture.url;
                }
            } else if (objData.url) {
                modelUrl = objData.url;
            }

            if (modelUrl) {
                this.log(`Loading model: ${modelUrl}`);
                loader.load(modelUrl, (gltf) => {
                    const model = gltf.scene;
                    this.applyTransform(model, objData);
                    model.userData = { ...objData };
                    this.worldRoot.add(model);
                    this.log(`Model added: ${objData.name || 'Unnamed'}`);

                    if (objData.interactive || (objData.model && objData.model.fields && objData.model.fields.interactive)) {
                        // Traverse to add all meshes to intersection list
                        model.traverse(child => {
                            if (child.isMesh) {
                                child.userData = model.userData; // Pass parent data
                                this.objectsToIntersect.push(child);
                            }
                        });
                    }
                }, undefined, (err) => {
                    this.log(`Failed to load model ${modelUrl}: ${err}`);
                });
            }
        });

        this.addThickAxes(1, 0.02);
    }

    addThickAxes(length = 1, thickness = 0.01) {
        const check = this.worldRoot.getObjectByName("ThickAxes");
        if (check) return;
        const axesGroup = new THREE.Group();
        axesGroup.name = "ThickAxes";
        const red = new THREE.MeshBasicMaterial({ color: 0xff0000 });
        const green = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
        const blue = new THREE.MeshBasicMaterial({ color: 0x0000ff });
        const xGeo = new THREE.CylinderGeometry(thickness, thickness, length, 12);
        xGeo.rotateZ(-Math.PI / 2); xGeo.translate(length / 2, 0, 0);
        axesGroup.add(new THREE.Mesh(xGeo, red));
        const yGeo = new THREE.CylinderGeometry(thickness, thickness, length, 12);
        yGeo.translate(0, length / 2, 0);
        axesGroup.add(new THREE.Mesh(yGeo, green));
        const zGeo = new THREE.CylinderGeometry(thickness, thickness, length, 12);
        zGeo.rotateX(Math.PI / 2); zGeo.translate(0, 0, length / 2);
        axesGroup.add(new THREE.Mesh(zGeo, blue));
        this.worldRoot.add(axesGroup);
    }

    applyTransform(object, data) {
        if (data.location) {
            object.position.set(data.location.x || 0, data.location.y || 0, data.location.z || 0);
            object.rotation.set(
                THREE.MathUtils.degToRad(data.location.rotate_x || 0),
                THREE.MathUtils.degToRad(data.location.rotate_y || 0),
                THREE.MathUtils.degToRad(data.location.rotate_z || 0)
            );
        } else if (data.position) {
            object.position.set(data.position.x, data.position.y, data.position.z);
            if (data.rotation) object.rotation.set(THREE.MathUtils.degToRad(data.rotation.x), THREE.MathUtils.degToRad(data.rotation.y), THREE.MathUtils.degToRad(data.rotation.z));
        }
        if (data.zoom) object.scale.set(data.zoom.x || 1, data.zoom.y || 1, data.zoom.z || 1);
        else if (data.scale) object.scale.set(data.scale.x, data.scale.y, data.scale.z);
    }

    update(delta, camera) {
        this.worldRoot.children.forEach(child => {
            if (child.geometry && child.geometry.type === 'BoxGeometry') {
                child.rotation.y += delta * 0.5;
                child.rotation.x += delta * 0.3;
            }
            if (camera && child.userData && child.userData.model && child.userData.model.fields && child.userData.model.fields.face_me) {
                const camPos = new THREE.Vector3();
                camera.getWorldPosition(camPos);
                const targetPos = new THREE.Vector3(camPos.x, child.position.y, camPos.z);
                child.lookAt(targetPos);
            }
        });
    }

    raycast(controller) {
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
}
