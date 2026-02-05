import { defineConfig } from 'vite';

export default defineConfig({
    build: {
        rollupOptions: {
            external: [
                'three',
                'three/addons/loaders/GLTFLoader.js',
                'mindar-image-three'
            ]
        }
    }
});
