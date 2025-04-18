import * as THREE from 'three';
import * as CANNON from 'cannon-es';

/**
 * Creates a static Cannon.js Body from a Three.js Mesh using a Trimesh shape.
 * @param mesh The Three.js Mesh to convert.
 * @returns A static CANNON.Body representing the mesh geometry, or null if conversion fails.
 */
export function threeMeshToCannonBody(mesh: THREE.Mesh): CANNON.Body | null {
    if (!mesh.geometry || !(mesh.geometry instanceof THREE.BufferGeometry)) {
        console.warn("threeMeshToCannonBody: Mesh geometry is missing or not BufferGeometry.", mesh);
        return null;
    }

    const geometry = mesh.geometry;
    let vertices: number[] = [];
    let indices: number[] = [];

    // Extract vertices
    const positionAttribute = geometry.attributes.position;
    if (!positionAttribute) {
        console.warn("threeMeshToCannonBody: Mesh geometry is missing position attribute.", mesh);
        return null;
    }
    vertices = Array.from(positionAttribute.array);

    // Extract indices
    if (geometry.index) {
        indices = Array.from(geometry.index.array);
    } else {
        // Handle non-indexed geometry (vertices are sequential triangles)
        indices = Array.from({ length: vertices.length / 3 }, (_, i) => i);
    }
    
    if (vertices.length === 0 || indices.length === 0) {
        console.warn("threeMeshToCannonBody: No vertices or indices found for mesh.", mesh);
        return null; // Don't create empty shapes
    }

    // Create Cannon Trimesh shape
    const trimeshShape = new CANNON.Trimesh(vertices, indices);

    // Create Cannon Body (static)
    const body = new CANNON.Body({ mass: 0 }); // Static body
    body.addShape(trimeshShape);

    // Apply the mesh's world transform to the physics body
    // Important: Ensure the mesh world matrix is up-to-date if the mesh is nested
    mesh.updateWorldMatrix(true, false); 
    body.position.copy(mesh.getWorldPosition(new THREE.Vector3()) as unknown as CANNON.Vec3);
    body.quaternion.copy(mesh.getWorldQuaternion(new THREE.Quaternion()) as unknown as CANNON.Quaternion);

    return body;
} 