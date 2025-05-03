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

        // --- Create OrbitControls ONCE if they don't exist ---
        if (!orbitControlsRef.current) {
            console.log("[DebugControls Setup Effect] OrbitControls instance doesn't exist. Attempting creation...");
            const isRendererAttached = document.body.contains(renderer.domElement);
            if (isRendererAttached) {
                try {
                    if (camera instanceof THREE.PerspectiveCamera && renderer.domElement instanceof HTMLElement) {
                        orbitControlsRef.current = new OrbitControls(camera, renderer.domElement);
                        orbitControlsRef.current.enableDamping = true;
                        orbitControlsRef.current.dampingFactor = 0.05;
                        orbitControlsRef.current.screenSpacePanning = true;
                        orbitControlsRef.current.minDistance = 1;
                        orbitControlsRef.current.maxDistance = 50;
                        orbitControlsRef.current.enabled = isEnabled; // Initial state based on prop
                        console.log(`[DebugControls Setup Effect] OrbitControls CREATED. Initial enabled state: ${isEnabled}`);
                    } else {
                        console.error('[DebugControls Setup Effect] Invalid camera or renderer element TYPE during OrbitControls creation.');
                    }
                } catch (error) {
                    console.error('[DebugControls Setup Effect] Failed to CREATE OrbitControls:', error);
                    // Log element state on error for diagnostics
                    if(renderer?.domElement){
                         console.error(`[DebugControls Error State] renderer.domElement exists: ${!!renderer.domElement}`);
                         console.error(`[DebugControls Error State] document.body.contains(renderer.domElement): ${document.body.contains(renderer.domElement)}`);
                    } else {
                         console.error(`[DebugControls Error State] renderer.domElement is missing.`);
                    }
                    orbitControlsRef.current = null;
                }
            } else {
                console.warn('[DebugControls Setup Effect] Renderer DOM element not attached to document body. Cannot create OrbitControls yet.');
            }
        } else {
             console.log("[DebugControls Setup Effect] OrbitControls instance already exists.");
        }

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

    // Effect 2: Manage Enabled state based on isEnabled prop
    useEffect(() => {
        console.log('[DebugControls Enable Effect] Running. isEnabled:', isEnabled);
        if (orbitControlsRef.current) {
            console.log(`[DebugControls Enable Effect] Setting OrbitControls enabled to: ${isEnabled}`);
            orbitControlsRef.current.enabled = isEnabled;
        }
        if (linesRef.current) {
            console.log(`[DebugControls Enable Effect] Setting lines visible to: ${isEnabled}`);
            linesRef.current.visible = isEnabled;
        }
    }, [isEnabled]); // Dependency: Only isEnabled prop

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
    }, [isEnabled, rapierWorld]); // Dependencies: loop restarts if these change while enabled (Removed control/line refs as deps)

    return null;
}

export default DebugControls; 