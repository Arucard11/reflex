// Path: packages/client/src/utils/threeUtils.ts
// Purpose: Contains utility functions related to Three.js objects.

import * as THREE from 'three';

/**
 * Disposes of all geometries, materials, and textures within an object hierarchy.
 * @param obj The root object to traverse for disposal.
 */
export const disposeObjectTree = (obj: THREE.Object3D) => {
    obj.traverse((child) => {
        if (child instanceof THREE.Mesh) {
            child.geometry?.dispose();
            // Dispose material(s)
            if (Array.isArray(child.material)) {
                child.material.forEach(material => {
                    material?.map?.dispose(); // Dispose texture
                    material?.dispose();
                });
            } else if (child.material) {
                child.material.map?.dispose(); // Dispose texture
                child.material.dispose();
            }
        }
    });
}; 