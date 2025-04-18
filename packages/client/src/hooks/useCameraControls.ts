import { useRef, useEffect, useCallback, useState } from 'react';
import * as THREE from 'three';

// Assuming PlayerState is defined elsewhere (e.g., usePlayerState or shared types)
interface PlayerState {
    position: THREE.Vector3;
    yaw: number;
    // Other fields might exist but are not directly used by camera logic
}

interface UseCameraControlsProps {
    mountRef: React.RefObject<HTMLDivElement>;
    scene: THREE.Scene | null; // Needed for attaching third-person camera
    characterModelRef: React.RefObject<THREE.Group | null>; // Ref for attaching FP camera
    mapRef: React.RefObject<THREE.Group | null>; // <-- Add mapRef prop
    initialPlayerState: PlayerState; // For initial setup
    accumulatedYawRef: React.RefObject<number>;   // From useInputControls
    accumulatedPitchRef: React.RefObject<number>; // From useInputControls
}

export function useCameraControls({
    mountRef,
    scene,
    characterModelRef,
    mapRef, // <-- Destructure mapRef
    initialPlayerState,
    accumulatedYawRef,
    accumulatedPitchRef,
}: UseCameraControlsProps) {
    const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
    const isFirstPerson = useRef(true); // Default to first person
    const firstPersonAttachmentRef = useRef<THREE.Object3D | null>(null);
    const thirdPersonOffset = useRef(new THREE.Vector3(0, 1.5, 3)); // Use ref for offset

    // --- Define Callbacks FIRST ---

    const findAttachmentPoint = useCallback(() => {
        if (!characterModelRef.current) return;
        let foundAttachment: THREE.Object3D | null = null;
        
        // Debug: Log all bones/objects in the model
        console.log('CameraControls: Scanning model hierarchy:');
        characterModelRef.current.traverse((child) => {
            if (child instanceof THREE.Object3D) {
                const obj3D = child as THREE.Object3D; // Explicit cast
                console.log('Found node:', obj3D.name, obj3D.type); // Use cast variable
            
                // Look for chest-related bones (common names in different formats)
                if (obj3D.name.toLowerCase().includes('chest') || 
                    obj3D.name.toLowerCase().includes('spine') ||
                    obj3D.name.toLowerCase().includes('torso')) {
                    console.log('Potential chest bone found:', obj3D.name); // Use cast variable
                    foundAttachment = obj3D; // Use cast variable
                }
            }
        });

        if (foundAttachment) {
            // Explicitly cast here again as the linter seems to lose the type after traverse
            const attachment = foundAttachment as THREE.Object3D;
            firstPersonAttachmentRef.current = attachment; // Use cast variable
            console.log('CameraControls: Using chest bone for attachment:', attachment.name); // Use cast variable
        } else {
            // Fallback to model root if no chest bone found
            firstPersonAttachmentRef.current = characterModelRef.current;
            console.warn('CameraControls: No chest bone found. Falling back to model root.');
        }
    }, [characterModelRef]); // Dependency: characterModelRef

     const setActiveCamera = useCallback(() => {
        if (!cameraRef.current || !characterModelRef.current || !scene) return;

        // Add debug logging
        console.log('Camera world position:', cameraRef.current.getWorldPosition(new THREE.Vector3()));
        
        // Add position validation
        if (cameraRef.current.position.y < 0.1) {
            console.warn('Resetting camera position');
            cameraRef.current.position.set(0, 1.6, 0);
        }

        // Try finding attachment point again in case model loaded late
        if (!firstPersonAttachmentRef.current) {
             findAttachmentPoint(); // Now defined above
        }

        const camera = cameraRef.current;
        const player = characterModelRef.current;

        // Ensure camera is not parented before re-parenting
        camera.parent?.remove(camera);

        if (isFirstPerson.current) {
            const attachmentPoint = firstPersonAttachmentRef.current ?? player; // Use fallback if still null
            if (attachmentPoint) {
                attachmentPoint.add(camera);
                // Set position slightly in front of the attachment point (e.g., eyes)
                // Adjust Y offset if needed based on attachment point location
                camera.position.set(0, 0.1, 0.1); // Move slightly forward and potentially up
                // Set rotation to look forward (0,0,0 local) relative to the attachment point
                camera.rotation.set(0, 0, 0);
                // Pitch (X rotation) will be applied in updateCamera based on accumulatedPitchRef
                 console.log("setActiveCamera: Set to First Person");
            } else {
                 console.error("setActiveCamera: Could not find attachment point for FP camera.");
                  // Fallback: Add to scene directly? Might look weird.
                 scene.add(camera);
            }
        } else {
            // Third-person: Attach directly to scene
            scene.add(camera);
             console.log("setActiveCamera: Set to Third Person");
            // Position calculation handled in updateCamera loop
        }
    }, [scene, characterModelRef, findAttachmentPoint]); // Dependencies: scene, characterModelRef, findAttachmentPoint

    const toggleCameraView = useCallback(() => {
        isFirstPerson.current = !isFirstPerson.current;
        console.log(`CameraControls: Switched to ${isFirstPerson.current ? 'First' : 'Third'} Person View`);
        setActiveCamera(); // Re-attach and position the camera
    }, [setActiveCamera]); // Dependency: setActiveCamera

    const handleResize = useCallback(() => {
        if (cameraRef.current && mountRef.current) {
            const camera = cameraRef.current;
            const mount = mountRef.current;
            const width = mount.clientWidth;
            const height = mount.clientHeight;

            camera.aspect = width / height;
            camera.updateProjectionMatrix();

            // Note: Renderer size update is handled by useThreeScene
             console.log("CameraControls: Resized.");
        }
    }, [mountRef]); // Depends only on mountRef


    // --- Effects (AFTER callback definitions) ---

    // Initialize Camera Object
    useEffect(() => {
        if (!mountRef.current) return;
        const currentMount = mountRef.current;

        const camera = new THREE.PerspectiveCamera(
            75, // Field of View
            currentMount.clientWidth / currentMount.clientHeight, // Aspect Ratio
            0.1, // Near clipping plane
            1000 // Far clipping plane
        );
        cameraRef.current = camera;

        // Initial camera setup for debug and normal use
        camera.position.set(0, 2, 10); // Place camera further back and up
        camera.lookAt(new THREE.Vector3(0, 0, 0)); // Look at origin where debug cube should be

        // Add camera to scene initially
        if (scene) {
            scene.add(camera);
            console.log("CameraControls: Added camera to scene at position:", camera.position);
        }

        // Try to find attachment point and set up camera parenting
        findAttachmentPoint();
        setActiveCamera(); // Now safe to call as camera is already in a good position

        return () => {
            cameraRef.current = null;
            if (scene && camera.parent === scene) {
                scene.remove(camera);
            }
            console.log("CameraControls: Cleaned up camera.");
        };
    }, [mountRef, findAttachmentPoint, setActiveCamera, scene]);

    // Re-find attachment point and set camera if character model loads/changes later
    useEffect(() => {
        if (characterModelRef.current) {
            findAttachmentPoint();
            if (isFirstPerson.current) {
                setActiveCamera(); // Only reattach if in first person
            }
        }
    }, [characterModelRef, findAttachmentPoint, setActiveCamera]);

    // Handle Resize
    useEffect(() => {
        window.addEventListener('resize', handleResize);
        handleResize(); // Call once initially

        return () => {
            window.removeEventListener('resize', handleResize);
            console.log("CameraControls: Removed resize listener.");
        };
    }, [handleResize]);

    // --- Update Camera Position/Rotation (Called each frame) ---
    const updateCamera = useCallback((playerState: PlayerState) => {
        if (!cameraRef.current) return;
        const camera = cameraRef.current;
        const accumulatedPitch = accumulatedPitchRef.current ?? 0;

        if (isFirstPerson.current) {
            // Apply pitch directly to the camera's local X rotation
            // Yaw is handled by the parent attachment's rotation (driven by playerState.yaw)
            // combined with the initial Math.PI rotation set in setActiveCamera.
            camera.rotation.x = accumulatedPitch;
            // Ensure other local rotations are 0
            // camera.rotation.y = Math.PI; // Keep the initial 180 deg rotation
            camera.rotation.z = 0;
        } else {
            // Third person logic
             if (!characterModelRef.current || !scene) return; // Ensure needed refs/scene exist

            // Use the playerState position directly (which comes from usePlayerState)
            const playerPosition = playerState.position;
            const playerYaw = playerState.yaw; // Use yaw from playerState for consistency

            // Calculate offset based on player's current yaw
            const yawOffset = thirdPersonOffset.current.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), playerYaw);

            // Determine the camera's right vector based on the yaw offset for pitch axis
            const pitchAxis = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), yawOffset).normalize();

            // Apply pitch rotation to the yaw-adjusted offset vector, using clamped accumulated pitch
            const clampedPitch = Math.max(-Math.PI / 2 * 0.95, Math.min(Math.PI / 2 * 0.95, accumulatedPitch));
            const desiredOffset = yawOffset.clone().applyAxisAngle(pitchAxis, clampedPitch);

            const desiredPosition = playerPosition.clone().add(desiredOffset);

            // --- Collision Check (Optional but Recommended) ---
            // Raycast from player towards camera position to check for obstructions
            const rayOrigin = playerPosition.clone().add(new THREE.Vector3(0, 0.5, 0)); // Start ray slightly above player feet
            const rayDirection = desiredPosition.clone().sub(rayOrigin).normalize();
            const maxDistance = thirdPersonOffset.current.length();
            const raycaster = new THREE.Raycaster(rayOrigin, rayDirection, 0.1, maxDistance);

            // What objects should the camera collide with? Usually just the map.
            // Assuming mapRef is accessible or passed in if needed for collision.
            let collisionDistance = maxDistance;
            if (mapRef?.current) { // Now mapRef is defined
                const intersects = raycaster.intersectObject(mapRef.current, true);
                if (intersects.length > 0) {
                    collisionDistance = Math.max(0.5, intersects[0].distance - 0.2); // Pull camera slightly in front of hit point
                }
            }
            // --- Apply Position with Collision Check ---
            camera.position.copy(rayOrigin).addScaledVector(rayDirection, collisionDistance);
            // camera.position.copy(desiredPosition); // Comment out this line

            // --- Look At ---
            const lookAtTarget = playerPosition.clone().add(new THREE.Vector3(0, 1.0, 0)); // Look slightly above player base
            camera.lookAt(lookAtTarget);
        }

    }, [scene, characterModelRef, mapRef, accumulatedPitchRef]); // Dependencies


    // Expose the camera object, update function, and toggle function
    return {
        cameraRef, // Return the ref itself
        updateCamera,
        toggleCameraView,
        isFirstPersonRef: isFirstPerson, // Expose ref if needed elsewhere
    };
} 