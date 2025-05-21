import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';

function DebugControls({
    isEnabled, // Controls whether debug features are active
    camera,    // Main scene camera
    renderer,  // Main renderer
    scene,     // Main scene
    rapierWorld // Client-side Rapier world
}) {
    const orbitControlsRef = useRef(null);
    const linesRef = useRef(null);
    const animationFrameIdRef = useRef(null); // Ref for the rAF loop ID

    // Effect 1: Setup/Management of Controls and Lines based on isEnabled and core object validity
    useEffect(() => {
        console.log('[DebugControls Setup Effect] Running. isEnabled:', isEnabled); // Log effect run

        // Check for core object validity first
        if (!camera || !renderer?.domElement || !scene || !rapierWorld) {
            console.log("[DebugControls Setup Effect] Missing required refs/props. Cannot setup yet.");
            // Dispose existing controls and lines if required objects missing (redundant but safe)
            if (orbitControlsRef.current) {
                orbitControlsRef.current.dispose();
                orbitControlsRef.current = null;
            }
            if (linesRef.current) {
                if(scene) scene.remove(linesRef.current); // Check scene validity before removing
                linesRef.current.geometry?.dispose(); // Safe navigation
                linesRef.current.material?.dispose(); // Safe navigation
                linesRef.current = null;
            }
            return; // Exit early if refs invalid
        }
        console.log('[DebugControls Setup Effect] Core objects seem valid.');

        // --- Create Debug Lines ONCE if they don't exist ---
        if (!linesRef.current) {
             console.log("[DebugControls Setup Effect] Debug lines don't exist. Creating...");
            linesRef.current = new THREE.LineSegments(
                new THREE.BufferGeometry(),
                new THREE.LineBasicMaterial({ color: 0xffffff, vertexColors: true })
            );
            scene.add(linesRef.current);
             console.log("[DebugControls Setup Effect] Debug lines CREATED.");
        } else {
             console.log("[DebugControls Setup Effect] Debug lines instance already exists.");
        }

        // MOVED Cleanup logic inside the main effect block
        return () => {
            console.log('[DebugControls Setup Effect] Cleaning up on unmount...');
            if (orbitControlsRef.current) {
                orbitControlsRef.current.dispose();
                orbitControlsRef.current = null;
                console.log('[DebugControls Setup Effect] OrbitControls disposed on unmount.');
            }
            if (linesRef.current) {
                if(scene) scene.remove(linesRef.current);
                linesRef.current.geometry?.dispose();
                linesRef.current.material?.dispose();
                linesRef.current = null;
                console.log('[DebugControls Setup Effect] Physics debug lines removed and disposed on unmount.');
            }
        };
    }, [camera, renderer, scene, rapierWorld]); // Dependencies: Only core objects for creation

    // Effect 2: Manage OrbitControls initialization and enabling based on isEnabled prop
    useEffect(() => {
        console.log('[DebugControls Enable Effect] Running. isEnabled:', isEnabled);
        // Only attempt to create or enable OrbitControls if all required objects are valid and debug mode is enabled
        if (isEnabled && camera && renderer?.domElement) {
            // Check if the renderer's DOM element is attached to the document
            if (!document.body.contains(renderer.domElement)) {
                console.warn('[DebugControls Enable Effect] renderer.domElement is not attached to the DOM. Skipping OrbitControls creation.');
            } else if (!orbitControlsRef.current) {
                console.log("[DebugControls Enable Effect] OrbitControls instance doesn't exist. Attempting creation...");
                try {
                    if (camera instanceof THREE.PerspectiveCamera && renderer.domElement instanceof HTMLElement) {
                        // Additional check for canvas size
                        if (renderer.domElement.clientWidth === 0 || renderer.domElement.clientHeight === 0) {
                            console.warn('[DebugControls Enable Effect] renderer.domElement has zero width or height. Skipping OrbitControls creation.');
                            return; // Exit if canvas size is zero, effectively stopping this attempt
                        }

                        orbitControlsRef.current = new OrbitControls(camera, renderer.domElement);
                        orbitControlsRef.current.enableDamping = true;
                        orbitControlsRef.current.dampingFactor = 0.05;
                        orbitControlsRef.current.screenSpacePanning = true;
                        orbitControlsRef.current.minDistance = 1;
                        orbitControlsRef.current.maxDistance = 50;
                        orbitControlsRef.current.enabled = true;
                        console.log(`[DebugControls Enable Effect] OrbitControls CREATED and enabled.`);
                        // Ensure pointer lock is exited when debug mode is enabled
                        if (document.pointerLockElement) {
                            document.exitPointerLock();
                            console.log('[DebugControls Enable Effect] Exited pointer lock for debug mode.');
                        }
                    } else {
                        console.error('[DebugControls Enable Effect] Invalid camera or renderer element TYPE during OrbitControls creation.');
                    }
                } catch (error) {
                    console.error('[DebugControls Enable Effect] FAILED to CREATE OrbitControls:', error);
                    // orbitControlsRef.current remains null, allowing a retry if props change and effect re-runs.
                    // This prevents the application from crashing.
                }
            } else {
                console.log(`[DebugControls Enable Effect] Setting OrbitControls enabled to: true`);
                orbitControlsRef.current.enabled = true;
                // Ensure pointer lock is exited when debug mode is enabled
                if (document.pointerLockElement) {
                    document.exitPointerLock();
                    console.log('[DebugControls Enable Effect] Exited pointer lock for debug mode.');
                }
            }
        } else if (orbitControlsRef.current) {
            console.log(`[DebugControls Enable Effect] Setting OrbitControls enabled to: false`);
            orbitControlsRef.current.enabled = false;
        }

        if (linesRef.current) {
            console.log(`[DebugControls Enable Effect] Setting lines visible to: ${isEnabled}`);
            linesRef.current.visible = isEnabled;
        }
    }, [isEnabled, camera, renderer]); // Dependency: Include camera and renderer for validation

    // Effect 3: Update Loop Management
    useEffect(() => {
        console.log('[DebugControls Update Effect] Running. isEnabled:', isEnabled, 'Controls enabled:', orbitControlsRef.current?.enabled); // Log effect run and controls state

        if (isEnabled && orbitControlsRef.current?.enabled) {
            // Start the update loop ONLY when enabled and controls exist/are enabled
            const loop = () => {
                // Check controls still exist and are enabled before updating
                if(orbitControlsRef.current && orbitControlsRef.current.enabled) {
                    orbitControlsRef.current.update(); // Call update for damping
                }

                // Update physics lines (optional, could be less frequent)
                if (linesRef.current?.visible && rapierWorld) {
                     try {
                        const buffers = rapierWorld.debugRender();
                        linesRef.current.geometry.setAttribute('position', new THREE.BufferAttribute(buffers.vertices, 3));
                        linesRef.current.geometry.setAttribute('color', new THREE.BufferAttribute(buffers.colors, 4));
                     } catch (error) {
                        console.error("[DebugControls Update Effect] Error getting Rapier debug render during update loop:", error);
                        if(linesRef.current) linesRef.current.visible = false; // Hide lines if error persists
                     }
                }
                animationFrameIdRef.current = requestAnimationFrame(loop);
            };

            // Only start loop if not already running
            if (!animationFrameIdRef.current) {
                 console.log("[DebugControls Update Effect] Starting internal update loop.");
                animationFrameIdRef.current = requestAnimationFrame(loop); // Start the loop
            } else {
                 console.log("[DebugControls Update Effect] Update loop already running.");
            }
        } else {
            // If not enabled or controls disabled, cancel any existing loop
            if (animationFrameIdRef.current) {
                console.log("[DebugControls Update Effect] isEnabled is false or controls disabled. Cancelling internal update loop.");
                cancelAnimationFrame(animationFrameIdRef.current);
                animationFrameIdRef.current = null;
            }
        }

        // Cleanup function for this effect
        return () => {
            if (animationFrameIdRef.current) {
                console.log("[DebugControls Update Effect] Cleaning up internal update loop on effect change/unmount.");
                cancelAnimationFrame(animationFrameIdRef.current);
                animationFrameIdRef.current = null;
            }
        };
    }, [isEnabled, rapierWorld]); // Dependencies: loop restarts if these change while enabled

    return null;
}

export default DebugControls; 