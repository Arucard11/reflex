import React, { useEffect, useRef, useState, useCallback } from 'react';

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { io, Socket } from 'socket.io-client'; // Import socket.io client and specific Socket type if using TS
// Import GLTFLoader and SkeletonUtils
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
// Assuming shared types and map data are correctly resolved by build/monorepo setup
import {
    MessageTypeFPS,
    MapId,
    CharacterId,
    MAP_CONFIGS_FPS,
    CHARACTER_CONFIG_FPS,
    WEAPON_CONFIG_FPS,
    // NEW: Import CollisionGroup AND interactionGroups function
    CollisionGroup,
    interactionGroups,
    MAX_SLOPE_ANGLE_RAD,
    PHYSICS_CONSTANTS // NEW: Import the single source of truth
} from '@shared-types/game-fps';
import DebugControls from './DebugControls'; // Import DebugControls
import HUD from './HUD'; // NEW: Import the HUD component

// NEW: Physics constants will be received from server
// These will be set when the server sends GAME_CONSTANTS_FPS message

// Define props based on Universal Standard (II.1)
function GameViewFPS({
    serverIp,
    serverPort,
    matchId,
    localPlayerUserId,
    opponentPlayerId,
    localPlayerWallet, // Wallet adapter likely passed via Context, not props
    opponentPlayerWallet,
    // access useWallet() from context maybe
    // NEW: Map and Character Selection Info from Plan 1.1.2
    mapId, // ID of the map selected for this match
    localPlayerCharacterId, // ID of the character selected by local player
    opponentPlayerCharacterId, // ID of the character selected by opponent
}) {
    const canvasRef = useRef(null); // Ref for the rendering canvas
    const socketRef = useRef(null); // NEW: Use a ref for the socket instance
    const retryTimeoutRef = useRef(null); // Ref for retry timer
    // NEW: Ref for current animation state - Separate refs for player and FPV
    const currentPlayerActionRef = useRef(null);
    const currentRemoteActionRef = useRef(null); // Add remote player animation ref
    const currentFpvActionRef = useRef(null); // Ref for currently playing FPV animation
    const gameStateRef = useRef(null);
    const [gameStateVersion, setGameStateVersion] = useState(0); // Only for UI updates
    
    // NEW: Server-provided physics constants
    const serverConstantsRef = useRef(null);
    
    // Helper function to get server constants safely
    const getServerConstants = () => {
        if (!serverConstantsRef.current) {
            console.warn('Server constants not yet received, using fallback values from shared package');
            // NEW: Use the single source of truth for fallback constants
            return PHYSICS_CONSTANTS;
        }
        return serverConstantsRef.current;
    };

    // --- Refs for Three.js/Rapier objects ---
    const cameraRef = useRef(null);
    const rendererRef = useRef(null);
    const sceneRef = useRef(null);
    const rapierWorldRef = useRef(null);
    const localPlayerRef = useRef({ mesh: null, rapierBody: null, mixer: null, weaponMesh: null, skeleton: null });
    const remotePlayerRef = useRef({ mesh: null, mixer: null, weaponMesh: null, skeleton: null });
    const fpvElementsRef = useRef({ camera: null, weaponModels: {}, grappleRopeMaterial: null });
    const playerAnimationActionsRef = useRef({});
    const remotePlayerAnimationActionsRef = useRef({}); // Add remote player animations ref
    const renderLoopIdRef = useRef(null); // Ref for render loop ID

    const projectilePoolRef = useRef([]); // NEW: For reusing projectile meshes
    const activeVisualProjectilesRef = useRef([]); // NEW: For animating visual projectiles
    const debugRayLinesRef = useRef([]); // NEW: For debug ray visualization

    // State for loading/connection status
    const [isLoading, setIsLoading] = useState(true);
    // Provide more detailed statuses
    const [connectionStatus, setConnectionStatus] = useState('disconnected'); // 'connecting', 'connected', 'error', 'retrying', 'disconnected'
    const [retryAttempt, setRetryAttempt] = useState(0); // Track retry attempts
    // RE-ADD State for triggering prop update to DebugControls
    const [isDebugModeEnabled, setIsDebugModeEnabled] = useState(false);

    // Max retries
    const MAX_RETRIES = 5;

    // --- Input State Management ---
    const inputStateRef = useRef({
        keys: { W: false, A: false, S: false, D: false, Space: false, Shift: false, Crouch: false, Ability1: false, GrenadeFrag: false, GrenadeSemtex: false, GrenadeFlash: false, Reload: false, Interact: false, GrappleFire: false, WeaponSwitch: false },
        lookQuat: { x: 0, y: 0, z: 0, w: 1 },
        sequence: 0,
        pendingInputs: [],
        // NEW: Initialize state values used in input handlers to prevent NaN errors
        cameraPitch: 0,
        characterYaw: 0,
        isFiring: false,
        isAiming: false,
        lastFireTime: 0,
    });
    const lastInputSendTimeRef = useRef(0);
    const INPUT_SEND_INTERVAL = 1000 / 30; // Increased to 30Hz for smoother input

    // Use the existing cameraModeRef for all camera state:
    const cameraModeRef = useRef({
        isThirdPerson: true, // Keep as true to see the character
        isOrbital: false
    });

    // NEW: Add recoil recovery state
    const recoilStateRef = useRef({
        pitch: 0,
        yaw: 0,
        recoverySpeed: 4, // default, will be updated by weapon
    });

    // Server reconciliation state (for debugging)
    const reconciliationStateRef = useRef({
        lastCorrectionTime: 0,
        totalCorrections: 0,
        avgCorrectionDistance: 0,
    });

    // --- Client-Side Prediction & Movement Engine ---
    // NEW: Weapon prediction reconciliation function
    const updateWeaponPrediction = useCallback((deltaTime) => {
        const gameState = gameStateRef.current;
        const localPlayerState = gameState?.players?.[localPlayerUserId];
        
        if (!localPlayerState || !weaponPredictionRef.current) return;
        
        const prediction = weaponPredictionRef.current;
        const serverState = localPlayerState;
        
        // Update predicted weapon timers
        const currentTime = performance.now();
        
        // Handle weapon switch prediction
        if (prediction.isPredictingSwitch) {
            const elapsed = currentTime - prediction.weaponSwitchStartTime;
            if (elapsed >= prediction.weaponSwitchDuration) {
                // Complete predicted weapon switch
                prediction.isPredictingSwitch = false;
                prediction.weaponSwitchStartTime = 0;
                
                // Update predicted ammo for new weapon
                if (serverState.ammoInClip) {
                    prediction.currentAmmoInClip = serverState.ammoInClip[prediction.activeWeaponSlot] || 0;
                }
            }
        }
        
        // Handle reload prediction
        if (prediction.isReloading) {
            const elapsed = currentTime - prediction.reloadStartTime;
            if (elapsed >= prediction.reloadDuration) {
                // Complete predicted reload
                prediction.isReloading = false;
                prediction.reloadStartTime = 0;
                prediction.reloadDuration = 0;
                
                // Predict full ammo after reload completion
                const activeWeaponId = serverState.weaponSlots?.[prediction.activeWeaponSlot];
                if (activeWeaponId && WEAPON_CONFIG_FPS[activeWeaponId]) {
                    prediction.currentAmmoInClip = WEAPON_CONFIG_FPS[activeWeaponId].ammoCapacity;
                }
            }
        }
        
        // Server reconciliation - smooth corrections for mispredictions
        const RECONCILIATION_THRESHOLD = 50; // ms tolerance
        const INTERPOLATION_SPEED = 8.0; // How fast to correct mispredictions
        
        // Check for weapon slot mismatch
        if (serverState.activeWeaponSlot !== undefined && 
            Math.abs(serverState.activeWeaponSlot - prediction.activeWeaponSlot) > 0.1) {
            
            // Server disagrees with our weapon slot prediction
            if (!prediction.isPredictingSwitch) {
                // Not currently predicting, accept server state immediately
                prediction.activeWeaponSlot = serverState.activeWeaponSlot;
                prediction.currentAmmoInClip = serverState.currentAmmoInClip || 0;
            }
        }
        
        // Check for reload state mismatch
        if (serverState.isReloading !== undefined) {
            if (serverState.isReloading && !prediction.isReloading) {
                // Server says we're reloading but we're not predicting it
                // This could happen if we started reloading but prediction failed
                const activeWeaponId = serverState.weaponSlots?.[serverState.activeWeaponSlot];
                if (activeWeaponId && WEAPON_CONFIG_FPS[activeWeaponId]) {
                    prediction.isReloading = true;
                    prediction.reloadStartTime = currentTime;
                    prediction.reloadDuration = WEAPON_CONFIG_FPS[activeWeaponId].reloadTime;
                }
            } else if (!serverState.isReloading && prediction.isReloading) {
                // Server says we're not reloading but we think we are
                // This could happen if reload was cancelled or completed server-side
                prediction.isReloading = false;
                prediction.reloadStartTime = 0;
                prediction.reloadDuration = 0;
            }
        }
        
        // Smooth ammo reconciliation to prevent jarring corrections
        if (serverState.currentAmmoInClip !== undefined && 
            Math.abs(serverState.currentAmmoInClip - prediction.currentAmmoInClip) > 0.1) {
            
            if (!prediction.isReloading && !prediction.isPredictingSwitch) {
                // Only correct ammo if we're not predicting weapon actions
                // Use smooth interpolation for visual correction
                const ammoDiff = serverState.currentAmmoInClip - prediction.currentAmmoInClip;
                const correction = ammoDiff * INTERPOLATION_SPEED * (deltaTime / 1000);
                
                if (Math.abs(correction) < Math.abs(ammoDiff)) {
                    prediction.currentAmmoInClip += correction;
                } else {
                    prediction.currentAmmoInClip = serverState.currentAmmoInClip;
                }
                
                // NEW: Round the result to prevent decimal ammo counts
                prediction.currentAmmoInClip = Math.round(prediction.currentAmmoInClip);
            }
        }
        
        // Store last server state for debugging/metrics
        prediction.lastServerWeaponState = {
            activeWeaponSlot: serverState.activeWeaponSlot,
            isReloading: serverState.isReloading,
            currentAmmoInClip: serverState.currentAmmoInClip,
            timestamp: currentTime
        };
        
    }, [localPlayerUserId]);

    const applyInputPhysics = useCallback((playerBody, inputKeys, inputLookQuat, physicsDeltaTime, isOnGround, groundNormal) => {
        if (!playerBody || physicsDeltaTime <= 0) return;
        
        // NEW: Use server-provided physics constants
        const serverConstants = getServerConstants();
        const walkSpeed = serverConstants.WALK_SPEED;
        const runSpeed = serverConstants.RUN_SPEED;
        const jumpImpulse = serverConstants.JUMP_IMPULSE;
        const accelerationForce = serverConstants.ACCELERATION_FORCE;
        const maxAccelForce = serverConstants.MAX_ACCEL_FORCE;
        const airControlFactor = serverConstants.AIR_CONTROL_FACTOR;
        
        // NEW: Movement smoothing variables from server
        const velocitySmoothing = serverConstants.VELOCITY_SMOOTHING;
        const minForceThreshold = serverConstants.MIN_FORCE_THRESHOLD;
        
        let desiredVelocity = { x: 0, z: 0 };
        let moveDirection = { x: 0, z: 0 };
        let isMoving = false;
        
        // Use the exact same quaternion math as the server
        const applyQuaternion = (vec, q) => {
            if (!q) return { ...vec };
            const ix = q.w * vec.x + q.y * vec.z - q.z * vec.y;
            const iy = q.w * vec.y + q.z * vec.x - q.x * vec.z;
            const iz = q.w * vec.z + q.x * vec.y - q.y * vec.x;
            const iw = -q.x * vec.x - q.y * vec.y - q.z * vec.z;
            return {
                x: ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y,
                y: iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z,
                z: iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x,
            };
        };

        const yawQuaternion = { x:0, y: inputLookQuat.y, z: 0, w: inputLookQuat.w };
        const yawMag = Math.sqrt(yawQuaternion.y**2 + yawQuaternion.w**2);
        if (yawMag > 1e-6) { yawQuaternion.y /= yawMag; yawQuaternion.w /= yawMag; } else { yawQuaternion.w = 1.0; }

        const _forward = { x: 0, y: 0, z: 1 };
        const _right = { x: -1, y: 0, z: 0 }; // FIXED: Right is negative X (inverted coordinate system)
        const forward = applyQuaternion(_forward, yawQuaternion);
        const right = applyQuaternion(_right, yawQuaternion);

        // This logic is now identical to the server's applyMovementInputToPlayer
        if (inputKeys.W) { moveDirection.x += forward.x; moveDirection.z += forward.z; isMoving = true; }
        if (inputKeys.S) { moveDirection.x -= forward.x; moveDirection.z -= forward.z; isMoving = true; }
        if (inputKeys.A) { moveDirection.x -= right.x; moveDirection.z -= right.z; isMoving = true; }
        if (inputKeys.D) { moveDirection.x += right.x; moveDirection.z += right.z; isMoving = true; }
        
        if (isMoving) {
            const mag = Math.sqrt(moveDirection.x**2 + moveDirection.z**2);
            if (mag > 1e-6) { moveDirection.x /= mag; moveDirection.z /= mag; }
            const targetSpeed = inputKeys.Shift ? runSpeed : walkSpeed;
            desiredVelocity.x = moveDirection.x * targetSpeed;
            desiredVelocity.z = moveDirection.z * targetSpeed;
        } else {
            // No input, so stop all horizontal movement directly.
            const currentLinvel = playerBody.linvel();
            playerBody.setLinvel({ x: 0, y: currentLinvel.y, z: 0 }, true);
            desiredVelocity.x = 0;
            desiredVelocity.z = 0;
        }
        
        const currentLinvel = playerBody.linvel();
        
        // Calculate velocity difference directly for more responsive movement
        const velocityDiffX = desiredVelocity.x - currentLinvel.x;
        const velocityDiffZ = desiredVelocity.z - currentLinvel.z;

        // Use velocity-based force calculation for more predictable movement
        const force = { x: 0, y: 0, z: 0 };
        
        // Apply force only if the difference is significant and not near target
        const targetSpeedXZ = Math.sqrt(desiredVelocity.x**2 + desiredVelocity.z**2);
        const currentSpeedXZ = Math.sqrt(currentLinvel.x**2 + currentLinvel.z**2);
        const speedDiff = Math.abs(targetSpeedXZ - currentSpeedXZ);
        
        // Only apply forces if we're not already close to the target velocity
        if (speedDiff > minForceThreshold) {
            if (Math.abs(velocityDiffX) > minForceThreshold) {
                force.x = velocityDiffX * accelerationForce * physicsDeltaTime;
            }
            if (Math.abs(velocityDiffZ) > minForceThreshold) {
                force.z = velocityDiffZ * accelerationForce * physicsDeltaTime;
            }
        }

        // FIXED: Add stronger stopping forces when not moving to prevent sliding
        const currentSpeed = Math.sqrt(currentLinvel.x**2 + currentLinvel.z**2);
        if (!isMoving && currentSpeed > 0.02) {
            // The setLinvel call above now handles stopping, this is redundant.
        }
        
        if (!isOnGround) {
            force.x *= airControlFactor;
            force.z *= airControlFactor;
        }

        // --- FIXED: Slope Force Projection (only when moving intentionally) ---
        if (isOnGround && isMoving && groundNormal) {
            // Project the force vector F onto the plane with normal N: F_proj = F - dot(F, N) * N
            // Since our initial force is purely horizontal (force.y = 0), the dot product simplifies.
            const dotProduct = (force.x * groundNormal.x) + (force.z * groundNormal.z);
            
            // The projected force will now have a vertical component to climb the slope.
            force.x = force.x - dotProduct * groundNormal.x;
            force.y = -dotProduct * groundNormal.y; // The 'y' component of the projected force.
            force.z = force.z - dotProduct * groundNormal.z;
        }

        const forceMagnitude = Math.sqrt(force.x**2 + force.z**2);
        if (forceMagnitude > maxAccelForce) {
            const scale = maxAccelForce / forceMagnitude;
            force.x *= scale;
            force.z *= scale;
        }

        // Higher threshold for applying forces to reduce micro-jitter (matched to server)
        const totalForceMagnitude = Math.sqrt(force.x**2 + force.y**2 + force.z**2);
        if (totalForceMagnitude > 0.15 && isMoving) { // MATCHED to server threshold
            if (!isNaN(force.x) && !isNaN(force.y) && !isNaN(force.z)) {
                 playerBody.applyImpulse(force, true);
            }
        }
        
        if (inputKeys.Space && isOnGround) {
            playerBody.applyImpulse({ x: 0, y: jumpImpulse, z: 0 }, true);
        }
        
        // Grapple Gun Physics (if active) -- placeholder for client prediction
        // ...
    }, [getServerConstants]); // Add dependency on getServerConstants

    // Effect for initialization and cleanup
    useEffect(() => {
        const canvasElement = canvasRef.current;
        if (!canvasElement) return;

        // --- StrictMode Guard ---
        if (socketRef.current) { // Check the ref
            return; 
        }
        // --- End StrictMode Guard ---

        const abortController = new AbortController();
        let isMounted = true; // Flag to check if component is still mounted in async operations

        // Use refs directly instead of local variables
        // let renderer, scene, camera, rapierWorld, renderLoopId;
        // let localPlayer = { mesh: null, rapierBody: null, mixer: null };
        // let remotePlayer = { mesh: null, mixer: null };
        // let fpvElements = { camera: null, weaponModels: {}, grappleRopeMaterial: null };
        // let playerAnimationActions = {};

        // >>> NEW: Move Input Handlers outside initGame <<< Plan 2.2.1 / 2.2.2
        const handleKeyDown = (event) => {
            // --- Handle Debug Toggle Key ('B') - Use State ---
            if (event.code === 'KeyB') {
                event.preventDefault(); // Prevent browser 'b' input

                // Decide the *next* state for the ref
                const nextIsEnabled = !isDebugModeEnabled;

                if (nextIsEnabled) {
                    // If ENABLING debug mode, exit pointer lock FIRST
                    document.exitPointerLock();
                } else {
                    // If DISABLING debug mode, request pointer lock (requires user click)
                    // canvasRef.current?.requestPointerLock(); // Don't force it here
                }

                // Now update the ref AFTER handling pointer lock
                // Update State (triggers re-render and prop update)
                setIsDebugModeEnabled(nextIsEnabled);
                // Keep ref in sync for internal logic
                cameraModeRef.current.isOrbital = nextIsEnabled;

                return; // Stop processing other keys if 'B' was pressed
            }
            // --- End Debug Toggle Key ---

            // Prevent browser default actions for game keys *if pointer is locked*
            if (document.pointerLockElement && [
                'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ControlLeft', 'KeyC'
                // Add other game action keys here that might have browser defaults
            ].includes(event.code)) {
                event.preventDefault();
            }

            // Map event.code to inputState keys (only when pointer locked)
            if (document.pointerLockElement) {
                switch (event.code) {
                    case 'KeyW': 
                        inputStateRef.current.keys.W = true; 
                        break;
                    case 'KeyA': 
                        inputStateRef.current.keys.A = true; 
                        break;
                    case 'KeyS': 
                        inputStateRef.current.keys.S = true; 
                        break;
                    case 'KeyD': 
                        inputStateRef.current.keys.D = true; 
                        break;
                    case 'Space': 
                        inputStateRef.current.keys.Space = true; 
                        break;
                    case 'ShiftLeft': 
                        inputStateRef.current.keys.Shift = true; 
                        break;
                    case 'ControlLeft': // NEW: Add Left Ctrl for crouch
                        inputStateRef.current.keys.Crouch = true; 
                        break;
                    case 'KeyC': inputStateRef.current.keys.C = true; break; // Camera toggle still needs lock
                    case 'KeyQ': // NEW: Weapon Switch Key
                        if (!inputStateRef.current.keys.WeaponSwitch) { // Prevent repeat triggers
                            inputStateRef.current.keys.WeaponSwitch = true;
                            
                            // Client-side prediction for immediate feedback
                            const localPlayerState = gameStateRef.current?.players?.[localPlayerUserId];
                            if (localPlayerState && !weaponPredictionRef.current.isPredictingSwitch && !weaponPredictionRef.current.isReloading) {
                                const currentSlot = localPlayerState.activeWeaponSlot;
                                const nextSlot = (currentSlot + 1) % 2;
                                
                                console.log(`🔄 [CLIENT] Predicting weapon switch to slot ${nextSlot}`);
                                
                                // Get current active weapon ID for animation
                                const currentActiveWeaponId = localPlayerState.weaponSlots[currentSlot];
                                
                                // Start client prediction
                                weaponPredictionRef.current.isPredictingSwitch = true;
                                weaponPredictionRef.current.weaponSwitchStartTime = performance.now();
                                weaponPredictionRef.current.activeWeaponSlot = nextSlot;
                                
                                // Update predicted ammo for new weapon
                                const newWeaponId = localPlayerState.weaponSlots[nextSlot];
                                weaponPredictionRef.current.currentAmmoInClip = localPlayerState.ammoInClip?.[nextSlot] || 0;
                                
                                // Send request to server
                                socketRef.current?.emit(MessageTypeFPS.SWITCH_WEAPON_FPS);
                                
                                // Play weapon switch animation/sound immediately
                                if (currentActiveWeaponId) {
                                    playFpvAnimation(currentActiveWeaponId, 'weapon_down', false);
                                }
                            }
                        }
                        break;
                    case 'KeyR':
                        if (!inputStateRef.current.keys.Reload) { // Prevent repeat triggers
                            inputStateRef.current.keys.Reload = true;
                            
                            // Client-side prediction for reload
                            const localPlayerState = gameStateRef.current?.players?.[localPlayerUserId];
                            if (localPlayerState && !weaponPredictionRef.current.isReloading && !weaponPredictionRef.current.isPredictingSwitch) {
                                const activeWeaponId = localPlayerState.weaponSlots[localPlayerState.activeWeaponSlot];
                                const weaponConfig = WEAPON_CONFIG_FPS[activeWeaponId];
                                
                                if (weaponConfig && localPlayerState.currentAmmoInClip < weaponConfig.ammoCapacity) {
                                    console.log(`🔄 [CLIENT] Predicting reload for ${activeWeaponId}`);
                                    
                                    // Start client prediction
                                    weaponPredictionRef.current.isReloading = true;
                                    weaponPredictionRef.current.reloadStartTime = performance.now();
                                    weaponPredictionRef.current.reloadDuration = weaponConfig.reloadTime;
                                    
                                    // Send request to server
                                    socketRef.current?.emit(MessageTypeFPS.RELOAD_WEAPON_FPS);
                                    
                                    // Play reload animation/sound immediately
                                    playFpvAnimation(activeWeaponId, 'reload', false);
                                }
                            }
                        }
                        break;
                }
            }
        };
        const handleKeyUp = (event) => {
            // Only process game key releases if pointer was locked during release
            // or if the key being released is the debug key itself.
            if (document.pointerLockElement || event.code === 'KeyB') {
                switch (event.code) {
                    case 'KeyW': 
                        inputStateRef.current.keys.W = false; 
                        break;
                    case 'KeyA': 
                        inputStateRef.current.keys.A = false; 
                        break;
                    case 'KeyS': 
                        inputStateRef.current.keys.S = false; 
                        break;
                    case 'KeyD': 
                        inputStateRef.current.keys.D = false; 
                        break;
                    case 'Space': 
                        inputStateRef.current.keys.Space = false; 
                        break;
                    case 'ShiftLeft': 
                        inputStateRef.current.keys.Shift = false; 
                        break;
                    // Camera toggle on KeyUp only if it was pressed down
                    case 'KeyC':
                        if (inputStateRef.current.keys.C) {
                            cameraModeRef.current.isThirdPerson = !cameraModeRef.current.isThirdPerson;
                        }
                        inputStateRef.current.keys.C = false; break;
                    case 'KeyQ': // NEW: Weapon Switch Key
                        inputStateRef.current.keys.WeaponSwitch = false;
                        break;
                    case 'KeyR':
                        inputStateRef.current.keys.Reload = false;
                        break;
                    case 'ControlLeft': // NEW: Release Left Ctrl crouch
                        inputStateRef.current.keys.Crouch = false; 
                        break;
                    case 'KeyH': // NEW: Toggle hand bone debug visualizers
                        if (localPlayerRef.current.leftHandDebug) {
                            localPlayerRef.current.leftHandDebug.visible = !localPlayerRef.current.leftHandDebug.visible;
                        }
                        if (localPlayerRef.current.rightHandDebug) {
                            localPlayerRef.current.rightHandDebug.visible = !localPlayerRef.current.rightHandDebug.visible;
                        }
                        console.log('🤚 Toggled hand bone debug visualizers');
                        break;
                }
            }
        };

        const handleMouseMove = (event) => {
            // Need camera defined before use - ensure initGame runs first or check existence
            if (!document.pointerLockElement || !cameraRef.current) return;

            const movementX = event.movementX || 0;
            const movementY = event.movementY || 0;
            const sensitivity = 0.002; // Increased sensitivity for better responsiveness

            // Update separate pitch and yaw values from raw input
            inputStateRef.current.cameraPitch += movementY * sensitivity; // Fixed: Changed -= to += to fix inverted Y-axis
            inputStateRef.current.characterYaw -= movementX * sensitivity; // REVERT: Reverted to -= to fix inverted mouse turning.

            // Clamp camera pitch to prevent over-rotation
            inputStateRef.current.cameraPitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, inputStateRef.current.cameraPitch));

            // Create TOTAL visual rotation including recoil for the camera
            const totalPitch = inputStateRef.current.cameraPitch + recoilStateRef.current.pitch;
            const totalYaw = inputStateRef.current.characterYaw + recoilStateRef.current.yaw + Math.PI; // Add 180 degrees to align with weapon
            const cameraEuler = new THREE.Euler(totalPitch, totalYaw, 0, 'YXZ');
            const targetCameraQuaternion = new THREE.Quaternion().setFromEuler(cameraEuler);
            
            // NEW: Use direct assignment to remove camera sway and make movement instant
            cameraRef.current.quaternion.copy(targetCameraQuaternion);

            // Create the look quaternion for the server from the raw input pitch and yaw (NO recoil).
            // This ensures the server knows the exact aiming direction, including vertical angle, for authoritative actions like shooting.
            const lookEuler = new THREE.Euler(inputStateRef.current.cameraPitch, inputStateRef.current.characterYaw, 0, 'YXZ');
            const lookQuaternion = new THREE.Quaternion().setFromEuler(lookEuler);

            // Update input state quaternion for server
            inputStateRef.current.lookQuat = {
                x: lookQuaternion.x,
                y: lookQuaternion.y,
                z: lookQuaternion.z,
                w: lookQuaternion.w
            };
        };

        // NEW: Firing system - separate from mouse movement
        const handleFiring = () => {
            const localPlayerState = gameStateRef.current?.players[localPlayerUserId];
            if (localPlayerState) {
                const activeWeaponId = localPlayerState.weaponSlots[localPlayerState.activeWeaponSlot];
                const weaponConfig = WEAPON_CONFIG_FPS[activeWeaponId];

                // Debug: Log player state when trying to fire
                if (inputStateRef.current.isFiring) {
                    console.log(`🔫 [CLIENT] Trying to fire. State: ${localPlayerState.state}, Reloading: ${localPlayerState.isReloading}, Ammo: ${localPlayerState.currentAmmoInClip}, Weapon: ${activeWeaponId}`);
                }

                // Firing logic
                if (localPlayerState.state === 'alive' && !localPlayerState.isReloading && localPlayerState.currentAmmoInClip > 0 && inputStateRef.current.isFiring) {
                    const now = performance.now();
                    if (now - inputStateRef.current.lastFireTime >= weaponConfig.fireRate) {
                        inputStateRef.current.lastFireTime = now;
                        console.log(`🔫 FIRING ${activeWeaponId}! Ammo: ${localPlayerState.currentAmmoInClip}/${weaponConfig.ammoCapacity}`);
                        socketRef.current?.emit(MessageTypeFPS.PLAYER_FIRE_FPS, { sequence: inputStateRef.current.sequence });
                        playFpvAnimation(activeWeaponId, 'fire', false);

                        // Apply Visual Recoil to the recoil state, not the input state
                        const recoilUp = weaponConfig.visualRecoilUp || 0.1;
                        const recoilSide = weaponConfig.visualRecoilSide || 0.05;
                        recoilStateRef.current.pitch += recoilUp; // Kick camera up
                        recoilStateRef.current.yaw += (Math.random() - 0.5) * recoilSide; // Kick camera sideways
                    }
                }

                // Reload Animation Logic
                if (localPlayerState.isReloading) {
                    // playFpvAnimation handles not re-playing an animation, so this is safe to call continuously
                    playFpvAnimation(activeWeaponId, 'reload', false);
                } else {
                    // If we are NOT reloading, but the reload animation IS playing, interrupt it by switching to idle.
                    // This handles cases where a reload is cancelled by the server (e.g. by switching weapons).
                    const currentAction = currentFpvActionRef.current;
                    if (currentAction && currentAction.getClip().name.includes('reload') && !currentAction.paused) {
                         playFpvAnimation(activeWeaponId, 'idle', true);
                    }
                }
            }
        };

        const handlePointerLockChange = () => {
            if (document.pointerLockElement === canvasElement) {
            } else {
            }
        };

        // NEW: Mouse Down/Up for Aiming
        const handleMouseDown = (event) => {
            // Only handle mouse input when pointer is locked (FPS mode)
            if (!document.pointerLockElement) return;
            
            if (event.button === 0) { // Left mouse button
                inputStateRef.current.isFiring = true;
                console.log('🔫 Started firing');
            }
            if (event.button === 2) { // Right mouse button
                inputStateRef.current.isAiming = true;
            }
        };
        const handleMouseUp = (event) => {
            // Only handle mouse input when pointer is locked (FPS mode)
            if (!document.pointerLockElement) return;
            
            if (event.button === 0) { // Left mouse button
                inputStateRef.current.isFiring = false;
                console.log('🔫 Stopped firing');
            }
            if (event.button === 2) {
                inputStateRef.current.isAiming = false;
            }
        };
        // >>> End Moved Input Handlers <<<

        // --- Debug Helper: Create Bone Visualizers ---
        const createBoneDebugHelper = (bone, color = 0xff0000) => {
            const geometry = new THREE.SphereGeometry(0.02, 8, 8);
            const material = new THREE.MeshBasicMaterial({ color: color });
            const sphere = new THREE.Mesh(geometry, material);
            bone.add(sphere);
            return sphere;
        };

        // --- OLD Weapon Attachment Helper Function (DISABLED) ---
        const attachWeaponToCharacter = (playerRef, isReloading = false) => {
            // DISABLED: This function is no longer used. 
            // We now use the dual-hand constraint system exclusively.
            console.log(`🚫 attachWeaponToCharacter DISABLED - using dual-hand constraint system only`);
            return;
        };

        // --- Animation Helper (Modified for FPV Target) ---
        const playFpvAnimation = (weaponId, actionName, loop = true) => {
            // Access FPV elements via ref
            const weaponData = fpvElementsRef.current.weaponModels[weaponId];
            if (!weaponData || !weaponData.mixer || !weaponData.animations || !weaponData.animations[actionName]) {
                return null; // Return null if action not found or invalid
            }

            const mixer = weaponData.mixer;
            const newAction = mixer.clipAction(weaponData.animations[actionName]);
            const previousAction = currentFpvActionRef.current; // Use dedicated ref for FPV

            if (previousAction !== newAction) {
                if (previousAction) {
                    previousAction.fadeOut(0.2); // Fade out previous action
                }
                
                newAction
                    .reset()
                    .setEffectiveTimeScale(1)
                    .setEffectiveWeight(1)
                    .fadeIn(0.2) // Fade in new action
                    .play();

                if (!loop) {
                    newAction.clampWhenFinished = true;
                    newAction.loop = THREE.LoopOnce;
                    
                    // NEW: When a non-looping animation finishes, transition back to idle
                    const onFinished = (e) => {
                        if (e.action === newAction) {
                            // Play the idle animation once the fire/reload animation is done
                            playFpvAnimation(weaponId, 'idle', true); 
                            mixer.removeEventListener('finished', onFinished);
                        }
                    };
                    mixer.addEventListener('finished', onFinished);

                } else {
                    newAction.loop = THREE.LoopRepeat;
                }

                currentFpvActionRef.current = newAction; // Update FPV action ref
                return newAction; // Return the action being played
            }
            return previousAction; // Return the current action if no change
        };

        // --- Game Initialization Function ---
        async function initGame() {
            try {
                if (!isMounted) return;
                
                console.log('🚀 Starting game initialization...');
                setIsLoading(true);
                setConnectionStatus('initializing');

                // --- Access Config based on Props ---
                console.log(`🗺️ Loading map: ${mapId}`);
                console.log(`👤 Local character: ${localPlayerCharacterId}`);
                console.log(`👤 Remote character: ${opponentPlayerCharacterId}`);
                
                const mapConfig = MAP_CONFIGS_FPS[mapId];
                const localCharConfig = CHARACTER_CONFIG_FPS[localPlayerCharacterId];
                const remoteCharConfig = CHARACTER_CONFIG_FPS[opponentPlayerCharacterId];
                
                if (!mapConfig) {
                    console.error(`❌ Map config not found for: ${mapId}`);
                    throw new Error(`Missing map config for ${mapId}`);
                }
                if (!localCharConfig) {
                    console.error(`❌ Local character config not found for: ${localPlayerCharacterId}`);
                    throw new Error(`Missing local character config for ${localPlayerCharacterId}`);
                }
                if (!remoteCharConfig) {
                    console.error(`❌ Remote character config not found for: ${opponentPlayerCharacterId}`);
                    throw new Error(`Missing remote character config for ${opponentPlayerCharacterId}`);
                }
                
                console.log('✅ All configs found, proceeding with asset loading...');
                const localCharacterVisualYOffset = localCharConfig.visualYOffset || 0.0;
                // We'll get the remote character's visualYOffset later when we have gameState

                // --- Asset Loaders ---
                const loader = new GLTFLoader();
                
                // --- Three.js Core Setup ---
                // Assign to refs
                rendererRef.current = new THREE.WebGLRenderer({ canvas: canvasElement, antialias: true });
                rendererRef.current.setSize(canvasElement.clientWidth, canvasElement.clientHeight);
                rendererRef.current.setPixelRatio(window.devicePixelRatio);
                rendererRef.current.shadowMap.enabled = true;

                sceneRef.current = new THREE.Scene();
                sceneRef.current.background = new THREE.Color(0x6699cc); // Example sky blue

                cameraRef.current = new THREE.PerspectiveCamera(65, canvasElement.clientWidth / canvasElement.clientHeight, 0.1, 1000);
                // NEW: Position camera closer to spawn area and looking towards spawn points
                // Spawn points are at (-3, 6, -7) and (-3, 6, 7), so position camera to see this area
                cameraRef.current.position.set(-3, 8, 0); // Above and between the spawn points
                cameraRef.current.lookAt(-3, 6, -7); // Look towards player 1 spawn point
                sceneRef.current.add(cameraRef.current);

                // DEBUG: Log initial camera direction
                const initialDirection = new THREE.Vector3();
                cameraRef.current.getWorldDirection(initialDirection);
                console.log('Initial Camera Facing Direction:', initialDirection);
                console.log(`🎥 Camera positioned at: (${cameraRef.current.position.x}, ${cameraRef.current.position.y}, ${cameraRef.current.position.z})`);
                console.log(`🎯 Camera looking towards spawn area at: (-3, 6, -7)`);

                // >>> MODIFIED: Adjust FPV camera position <<<
                // Assign FPV camera to ref
                fpvElementsRef.current.camera = new THREE.PerspectiveCamera(60, canvasElement.clientWidth / canvasElement.clientHeight, 0.01, 100);
                cameraRef.current.add(fpvElementsRef.current.camera); // Attach FPV camera to main camera

                const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
                sceneRef.current.add(ambientLight);
                const directionalLight = new THREE.DirectionalLight(0xffffff, 1.0);
                directionalLight.position.set(10, 15, 5);
                directionalLight.castShadow = true; // Enable shadows
                sceneRef.current.add(directionalLight);
                
                // --- Load Map Visuals (NEW) ---
                console.log(`🗺️ Loading map from: ${mapConfig.visualAssetPath}`);
                const mapGltf = await loader.loadAsync(mapConfig.visualAssetPath);
                console.log('✅ Map GLB loaded successfully');
                const mapMesh = mapGltf.scene;
                mapMesh.traverse(node => { // Enable shadows on map objects
                    if (node.isMesh) {
                        node.castShadow = true;
                        node.receiveShadow = true;
                    }
                });
                sceneRef.current.add(mapMesh); // Add to scene via ref
                console.log('✅ Map added to scene');
                
                // --- Load Character Models ---
                const localModelPath = localCharConfig.modelPath;
                const remoteModelPath = remoteCharConfig.modelPath;
                
                console.log(`👤 Loading local character from: ${localModelPath}`);
                console.log(`👤 Loading remote character from: ${remoteModelPath}`);
                
                let localCharacterGltf, remoteCharacterGltf;
                try {
                    [localCharacterGltf, remoteCharacterGltf] = await Promise.all([
                        loader.loadAsync(localModelPath),
                        loader.loadAsync(remoteModelPath)
                    ]);
                    console.log('✅ Both character models loaded successfully');
                } catch (error) {
                    console.error("❌ Failed to load character models:", error);
                    throw error;
                }

                // Assign to refs
                localPlayerRef.current.mesh = localCharacterGltf.scene;
                remotePlayerRef.current.mesh = remoteCharacterGltf.scene;

                // Process character model textures (simplified)
                const processTextures = (gltf) => {
                    gltf.scene.traverse(node => {
                        if (node.isMesh && node.material) {
                            const material = node.material;
                            // Ensure textures are properly configured
                            const textureProperties = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap'];
                            textureProperties.forEach(prop => {
                                if (material[prop]) {
                                    material[prop].needsUpdate = true;
                                }
                            });
                        }
                    });
                };

                // Process textures for both characters
                processTextures(localCharacterGltf);
                processTextures(remoteCharacterGltf);



                // Store animations for both players
                playerAnimationActionsRef.current = {}; // Local player animations
                remotePlayerAnimationActionsRef.current = {}; // Remote player animations
                
                if (localCharacterGltf.animations && localCharacterGltf.animations.length > 0) {
                    console.log('--- AVAILABLE LOCAL PLAYER ANIMATIONS ---');
                    localCharacterGltf.animations.forEach((clip, idx) => {
                        playerAnimationActionsRef.current[clip.name] = clip;
                        console.log(`[${idx}]: ${clip.name}`);
                    });
                    console.log('------------------------------------');
                } else {
                    console.error('❌ NO LOCAL PLAYER ANIMATIONS FOUND');
                }
                
                if (remoteCharacterGltf.animations && remoteCharacterGltf.animations.length > 0) {
                    console.log('--- AVAILABLE REMOTE PLAYER ANIMATIONS ---');
                    remoteCharacterGltf.animations.forEach((clip, idx) => {
                        remotePlayerAnimationActionsRef.current[clip.name] = clip;
                        console.log(`[${idx}]: ${clip.name}`);
                    });
                    console.log('-----------------------------------------');
                } else {
                    console.error('❌ NO REMOTE PLAYER ANIMATIONS FOUND');
                }

                // Animation name mapping - Updated based on actual GLB animation names
                // From the logs, we can see the actual available animations in the GLB file
                const animationMapping = {
                    // Logical name -> Actual GLB animation name
                    'idle': 'idle',                    // Use the actual 'idle' animation for neutral pose
                    'aimIdle': 'aimIdle',             // Aiming idle pose
                    'fireIdle': 'fireIdle',           // Firing idle pose
                    'grenadeIdle': 'idleGrenadeThrow', // Grenade throwing idle pose
                    'reloadIdle': 'reloadIdle',       // Reloading idle pose
                    'crouchIdle': 'crouchIdle',       // Crouching idle pose
                    // Movement animations - use actual names
                    'walkForward': 'walkForward',
                    'walkBackward': 'walkBackward',
                    'strafeLeft': 'strafeLeft',
                    'strafeRight': 'strafeRight',
                    'runFowardFire': 'runFowardFire', // Keep the typo as it exists in GLB
                    'runLeft': 'runLeft',
                    'runRight': 'runRight',
                    'runBackward': 'runBackward',
                    'runForwardLeft': 'runForwardLeft',
                    'runForwardRight': 'runForwardRight',
                    'runBackwardLeft': 'runBackwardLeft',
                    'runBackwardRight': 'runBackwardRight',
                    'walkForwardLeft': 'walkForwardLeft',
                    'walkForwardRight': 'walkForwardRight',
                    'walkBackwardLeft': 'walkBackwardLeft',
                    'walkBackwardRight': 'walkBackwardRight',
                    'death': 'death',
                };

                // Helper function to get the correct animation name
                const getCorrectAnimationName = (logicalName) => {
                    return animationMapping[logicalName] || logicalName;
                };

                // Apply character scale to match physics body dimensions
                const serverConstants = getServerConstants();
                const characterScale = serverConstants.CHARACTER_VISUAL_SCALE;
                localPlayerRef.current.mesh.scale.setScalar(characterScale);
                remotePlayerRef.current.mesh.scale.setScalar(characterScale);

                localPlayerRef.current.mesh.traverse(node => { if (node.isMesh) node.castShadow = true; });
                remotePlayerRef.current.mesh.traverse(node => { if (node.isMesh) node.castShadow = true; });
                sceneRef.current.add(localPlayerRef.current.mesh); // Add to scene via ref
                sceneRef.current.add(remotePlayerRef.current.mesh); // Add to scene via ref
                localPlayerRef.current.mesh.visible = false;
                remotePlayerRef.current.mesh.visible = false;

                // --- Load AK-47 Weapon Models for Character Attachment ---
                console.log('🔫 Loading AK-47 weapon models for character attachment...');
                try {
                    // Load AK-47 for local player
                    const ak47LocalGltf = await loader.loadAsync('/assets/fps_1v1/models/ak_47_pbr.glb');
                    localPlayerRef.current.weaponMesh = ak47LocalGltf.scene.clone();
                    localPlayerRef.current.weaponMesh.scale.setScalar(0.004); // Much smaller scale for proper size
                    
                    // Load AK-47 for remote player
                    const ak47RemoteGltf = await loader.loadAsync('/assets/fps_1v1/models/ak_47_pbr.glb');
                    remotePlayerRef.current.weaponMesh = ak47RemoteGltf.scene.clone();
                    remotePlayerRef.current.weaponMesh.scale.setScalar(0.004); // Same scale as local player
                    
                    // Find skeletons for bone attachment
                    localPlayerRef.current.mesh.traverse(node => {
                        if (node.isSkinnedMesh && node.skeleton) {
                            localPlayerRef.current.skeleton = node.skeleton;
                        }
                    });
                    
                    
                    remotePlayerRef.current.mesh.traverse(node => {
                        if (node.isSkinnedMesh && node.skeleton) {
                            remotePlayerRef.current.skeleton = node.skeleton;
                        }
                    });
                    
                    console.log('✅ AK-47 weapon models loaded successfully');
                    console.log(`🦴 Local player skeleton bones: ${localPlayerRef.current.skeleton?.bones?.length || 0}`);
                    console.log(`🦴 Remote player skeleton bones: ${remotePlayerRef.current.skeleton?.bones?.length || 0}`);
                    
                    // Debug: List ALL bone names to see what's available
                    if (localPlayerRef.current.skeleton?.bones) {
                        const boneNames = localPlayerRef.current.skeleton.bones.map(bone => bone.name);
                        console.log('🦴 ALL BONE NAMES:', boneNames);
                        
                        const relevantBones = boneNames.filter(name => 
                            name.toLowerCase().includes('hand') || 
                            name.toLowerCase().includes('wrist') ||
                            name.toLowerCase().includes('arm') ||
                            name.toLowerCase().includes('weapon') ||
                            name.toLowerCase().includes('gun') ||
                            name.toLowerCase().includes('rifle') ||
                            name.toLowerCase().includes('grip')
                        );
                        console.log('🦴 Relevant bone names found:', relevantBones);
                        
                        // Debug: Try to find weapon attachment points
                        const weaponBones = boneNames.filter(name => 
                            name.toLowerCase().includes('wpn') ||
                            name.toLowerCase().includes('weapon') ||
                            name.toLowerCase().includes('gun') ||
                            name.toLowerCase().includes('rifle')
                        );
                        console.log('🔫 Weapon-specific bones found:', weaponBones);
                        
                        // DEBUG: Add hand bone visualizers (press 'H' key to toggle)
                        const leftHandBone = localPlayerRef.current.skeleton.bones.find(bone => bone.name === 'mixamorigLeftHand');
                        const rightHandBone = localPlayerRef.current.skeleton.bones.find(bone => bone.name === 'mixamorigRightHand');
                        
                        if (leftHandBone) {
                            const leftHandDebug = createBoneDebugHelper(leftHandBone, 0x00ff00); // Green for left hand
                            leftHandDebug.visible = false; // Hidden by default
                            localPlayerRef.current.leftHandDebug = leftHandDebug;
                            console.log('🟢 Left hand debug helper created');
                        }
                        
                        if (rightHandBone) {
                            const rightHandDebug = createBoneDebugHelper(rightHandBone, 0x0000ff); // Blue for right hand
                            rightHandDebug.visible = false; // Hidden by default
                            localPlayerRef.current.rightHandDebug = rightHandDebug;
                            console.log('🔵 Right hand debug helper created');
                        }
                    }

                    // NEW: Initialize dual-hand constraint system on spawn
                    console.log('🔫 Initializing dual-hand weapon constraint system...');
                    
                    // Set up constraint system for local player
                    const localLeftHand = localPlayerRef.current.skeleton?.bones.find(bone => bone.name === 'mixamorigLeftHand');
                    const localRightHand = localPlayerRef.current.skeleton?.bones.find(bone => bone.name === 'mixamorigRightHand');
                    
                    if (localLeftHand && localRightHand && localPlayerRef.current.weaponMesh) {
                        const localWeaponConstraint = {
                            leftHand: localLeftHand,
                            rightHand: localRightHand,
                            weaponGroup: new THREE.Group(),
                            isActive: true
                        };
                        
                        localWeaponConstraint.weaponGroup.add(localPlayerRef.current.weaponMesh);
                        
                        // Proper weapon positioning and rotation for natural grip
                        localPlayerRef.current.weaponMesh.position.set(0, 0, 0); // Reset position relative to group
                        localPlayerRef.current.weaponMesh.rotation.set(0, 0, 0); // No initial rotation - let constraint system handle it
                        
                        sceneRef.current.add(localWeaponConstraint.weaponGroup);
                        localPlayerRef.current.weaponConstraint = localWeaponConstraint;
                        
                        console.log('✅ Local player dual-hand constraint initialized');
                    }
                    
                    // Set up constraint system for remote player
                    const remoteLeftHand = remotePlayerRef.current.skeleton?.bones.find(bone => bone.name === 'mixamorigLeftHand');
                    const remoteRightHand = remotePlayerRef.current.skeleton?.bones.find(bone => bone.name === 'mixamorigRightHand');
                    
                    if (remoteLeftHand && remoteRightHand && remotePlayerRef.current.weaponMesh) {
                        const remoteWeaponConstraint = {
                            leftHand: remoteLeftHand,
                            rightHand: remoteRightHand,
                            weaponGroup: new THREE.Group(),
                            isActive: true
                        };
                        
                        remoteWeaponConstraint.weaponGroup.add(remotePlayerRef.current.weaponMesh);
                        
                        // Proper weapon positioning and rotation for remote player
                        remotePlayerRef.current.weaponMesh.position.set(0, 0, 0); // Reset position relative to group
                        remotePlayerRef.current.weaponMesh.rotation.set(0, 0, 0); // No initial rotation - let constraint system handle it
                        
                        sceneRef.current.add(remoteWeaponConstraint.weaponGroup);
                        remotePlayerRef.current.weaponConstraint = remoteWeaponConstraint;
                        
                        console.log('✅ Remote player dual-hand constraint initialized');
                    }
                    
                    console.log('✅ Dual-hand weapon constraint system initialized for both players');
                } catch (error) {
                    console.error('❌ Failed to load AK-47 weapon models:', error);
                }

                // Assign to refs
                localPlayerRef.current.mixer = new THREE.AnimationMixer(localPlayerRef.current.mesh);
                remotePlayerRef.current.mixer = new THREE.AnimationMixer(remotePlayerRef.current.mesh);
                
                // NEW: Initialize with a proper starting animation to prevent wrong animations from playing
                if (localCharacterGltf.animations && localCharacterGltf.animations.length > 0) {
                    // Improved initialization with exact matching
                    let startingAnim = null;
                    
                    // Step 1: Try exact matches for ideal starting animations (in priority order)
                    const idealStarters = ['idle', 'Idle', 'idle_pose', 'T-pose', 'Default'];
                    for (const candidate of idealStarters) {
                        if (playerAnimationActionsRef.current[candidate]) {
                            startingAnim = candidate;
                            break;
                        }
                    }
                    
                    // Step 2: If no ideal starter, look for any animation with "idle" in the name
                    if (!startingAnim) {
                        const idleVariants = Object.keys(playerAnimationActionsRef.current).filter(name => 
                            name.toLowerCase().includes('idle')
                        );
                        if (idleVariants.length > 0) {
                            startingAnim = idleVariants[0];
                        }
                    }
                    
                    // Step 3: If still no starter, use first safe animation (not reload/attack related)
                    if (!startingAnim) {
                        const safeAnimNames = Object.keys(playerAnimationActionsRef.current).filter(name => 
                            !name.toLowerCase().includes('reload') && 
                            !name.toLowerCase().includes('attack') && 
                            !name.toLowerCase().includes('fire') &&
                            !name.toLowerCase().includes('shoot') &&
                            !name.toLowerCase().includes('death') &&
                            !name.toLowerCase().includes('hit')
                        );
                        if (safeAnimNames.length > 0) {
                            startingAnim = safeAnimNames[0];
                        }
                    }
                    
                    // Step 4: Last resort - use any available animation
                    if (!startingAnim) {
                        const allAnimNames = Object.keys(playerAnimationActionsRef.current);
                        if (allAnimNames.length > 0) {
                            startingAnim = allAnimNames[0];
                        }
                    }
                    
                    // Start the appropriate animation
                    if (startingAnim && playerAnimationActionsRef.current[startingAnim]) {
                        const initAction = localPlayerRef.current.mixer.clipAction(playerAnimationActionsRef.current[startingAnim]);
                        initAction.reset().setEffectiveTimeScale(1).setEffectiveWeight(1).play();
                        initAction.loop = THREE.LoopRepeat;
                        currentPlayerActionRef.current = initAction;
                    } else {
                        console.error('[Animation Init] 💀 CRITICAL: No suitable starting animation found!');
                    }
                }

                // Initialize remote player with starting animation
                if (remoteCharacterGltf.animations && remoteCharacterGltf.animations.length > 0) {
                    // Use logical 'idle' as the default for remote player
                    let remoteStartingAnim = 'idle';
                    
                    // Apply mapping to get correct GLB animation name
                    const mappedRemoteStartingAnim = getCorrectAnimationName(remoteStartingAnim);
                    
                    // Fallback if mapped animation doesn't exist
                    if (!remotePlayerAnimationActionsRef.current[mappedRemoteStartingAnim]) {
                        const remoteAnimNames = Object.keys(remotePlayerAnimationActionsRef.current);
                        if (remoteAnimNames.length > 0) {
                            const fallbackAnim = remoteAnimNames[0];
                            
                            if (remotePlayerAnimationActionsRef.current[fallbackAnim]) {
                                const remoteInitAction = remotePlayerRef.current.mixer.clipAction(remotePlayerAnimationActionsRef.current[fallbackAnim]);
                                remoteInitAction.reset().setEffectiveTimeScale(1).setEffectiveWeight(1).play();
                                remoteInitAction.loop = THREE.LoopRepeat;
                                currentRemoteActionRef.current = remoteInitAction;
                            }
                        }
                    } else {
                        const remoteInitAction = remotePlayerRef.current.mixer.clipAction(remotePlayerAnimationActionsRef.current[mappedRemoteStartingAnim]);
                        remoteInitAction.reset().setEffectiveTimeScale(1).setEffectiveWeight(1).play();
                        remoteInitAction.loop = THREE.LoopRepeat;
                        currentRemoteActionRef.current = remoteInitAction;
                    }
                }

                // --- Load FPV Arms/Weapons (NEW - logic from 2.1.2 adapted) ---
                fpvElementsRef.current.weaponModels = {}; // Store loaded FPV models by weapon ID
                for (const weaponId in WEAPON_CONFIG_FPS) {
                    try {
                        const weaponConfig = WEAPON_CONFIG_FPS[weaponId];
                        const modelPath = weaponConfig.fpvModelPath;
                        if (!modelPath) {
                            continue;
                        }

                        const fpvGltf = await loader.loadAsync(modelPath);
                        const weaponGroup = fpvGltf.scene;

                        // Process animations if any
                        const weaponAnimations = {};
                        if (fpvGltf.animations && fpvGltf.animations.length > 0) {
                            console.log(`--- AVAILABLE FPV ANIMATIONS for ${weaponId} ---`);
                            fpvGltf.animations.forEach((clip, idx) => {
                                weaponAnimations[clip.name] = clip;
                                console.log(`[${idx}]: ${clip.name}`);
                            });
                            console.log('-----------------------------------------');
                        } else {
                            console.log(`--- NO FPV ANIMATIONS FOUND for ${weaponId} ---`);
                        }

                        weaponGroup.traverse(node => {
                            if (node.isMesh) {
                                node.frustumCulled = false;
                                node.renderOrder = 10; // Ensure FPV renders on top
                            }
                        });

                        // Create mixer for this weapon model
                        const weaponMixer = new THREE.AnimationMixer(weaponGroup);

                        // Store model, mixer, and animations together in ref
                        fpvElementsRef.current.weaponModels[weaponId] = {
                            model: weaponGroup,
                            mixer: weaponMixer,
                            animations: weaponAnimations,
                        };

                        fpvElementsRef.current.camera.add(weaponGroup); // Add to FPV camera via ref

                        // Set the actual FPV weapon position
                        weaponGroup.position.set(0.12, -0.18, -0.4); // Pulled model further from camera
                        weaponGroup.scale.set(.008, .008, .008); // Adjusted scale
                        weaponGroup.rotation.set(0,15,0);


                        weaponGroup.visible = false; // Hide initially

                    } catch (e) {
                         console.error(`FPV model '${modelPath}' failed to load or process:`, e);
                    }
                }
                
                // --- Load Grapple Visuals ---
                // Assign to ref
                fpvElementsRef.current.grappleRopeMaterial = new THREE.LineBasicMaterial({ color: 0xffffff, linewidth: 2 });
                
                // --- NEW: Create Projectile Pool ---
                const projectileGeometry = new THREE.SphereGeometry(0.2, 8, 8); // Increased size from 0.05 to 0.2
                const projectileMaterial = new THREE.MeshBasicMaterial({ color: 0xff0000 }); // Changed to red for visibility
                for (let i = 0; i < 50; i++) { // Create a pool of 50 projectiles
                    const projectileMesh = new THREE.Mesh(projectileGeometry, projectileMaterial);
                    projectileMesh.visible = false;
                    sceneRef.current.add(projectileMesh);
                    projectilePoolRef.current.push(projectileMesh);
                }
                // --- End Projectile Pool ---

                // --- NEW: Create Debug Ray Line Pool ---
                const rayLineMaterial = new THREE.LineBasicMaterial({ 
                    color: 0x00ff00, 
                    linewidth: 3, // Reduced from 5 for better compatibility
                    transparent: true,
                    opacity: 1.0,
                    depthTest: false, // Make sure lines are always visible
                    depthWrite: false
                });
                for (let i = 0; i < 20; i++) { // Create a pool of 20 debug lines
                    const rayLineGeometry = new THREE.BufferGeometry().setFromPoints([
                        new THREE.Vector3(0, 0, 0),
                        new THREE.Vector3(0, 0, 1)
                    ]);
                    const rayLine = new THREE.Line(rayLineGeometry, rayLineMaterial.clone()); // Use cloned material for each line
                    rayLine.visible = false;
                    rayLine.renderOrder = 1000; // Render on top
                    sceneRef.current.add(rayLine);
                    debugRayLinesRef.current.push(rayLine);
                }
                console.log(`✅ Created ${debugRayLinesRef.current.length} debug ray lines in the pool`);
                // --- End Debug Ray Line Pool ---

                // --- Rapier Setup ---
                await RAPIER.init();
                if (!isMounted) return; // Check after await
                // Assign to ref
                rapierWorldRef.current = new RAPIER.World({ x: 0.0, y: -9.81, z: 0.0 });
                
                // --- Load Map Physics (Client - Mirroring server 1.2.2) ---
                const clientMapConfig = MAP_CONFIGS_FPS[mapId]; // Use a different variable name
                if (!clientMapConfig || !clientMapConfig.physicsData) {
                } else {
                    const clientPhysicsData = clientMapConfig.physicsData;
                    
                    // --- Only support Trimesh Loading ---
                    if (clientPhysicsData.vertices && clientPhysicsData.vertices.length > 0 && clientPhysicsData.indices && clientPhysicsData.indices.length > 0) {
                        try {
                            const rigidBodyDesc = RAPIER.RigidBodyDesc.fixed();
                            const body = rapierWorldRef.current.createRigidBody(rigidBodyDesc);
                            const trimeshDesc = RAPIER.ColliderDesc.trimesh(clientPhysicsData.vertices, clientPhysicsData.indices);
                             
                            // IMPORTANT: Set Collision Groups - MUST MATCH SERVER
                            const groups = interactionGroups(
                                CollisionGroup.WORLD,
                                [CollisionGroup.PLAYER_BODY, CollisionGroup.GRENADE, CollisionGroup.PROJECTILE, CollisionGroup.PLAYER_UTILITY_RAY]
                            );
                            trimeshDesc.setCollisionGroups(groups);
                             
                            // Use rapierWorldRef
                            const collider = rapierWorldRef.current.createCollider(trimeshDesc, body);
                        } catch (error) {
                            console.error(`[Client Physics Load] ERROR: Failed to create client trimesh collider for map ${mapId}:`, error);
                            // No fallback to primitives
                        }
                    } else {
                        console.error(`[Client Physics Load] No valid trimesh data found for map ${mapId}. Physics loading failed.`);
                    }
                }
                
                // --- Resize Handling ---
                const handleResize = () => {
                    // Access via refs
                    if (!rendererRef.current || !cameraRef.current || !canvasElement) return;
                    const width = canvasElement.clientWidth;
                    const height = canvasElement.clientHeight;
                    rendererRef.current.setSize(width, height);
                    cameraRef.current.aspect = width / height;
                    cameraRef.current.updateProjectionMatrix();
                    // FPV camera uses main camera aspect ratio
                };
                window.addEventListener('resize', handleResize, { signal: abortController.signal });
                handleResize(); // Initial size calculation
                
                // >>> MODIFIED: Add Input Listeners (handlers defined outside now) <<<
                document.addEventListener('keydown', handleKeyDown, { signal: abortController.signal });
                document.addEventListener('keyup', handleKeyUp, { signal: abortController.signal });
                document.addEventListener('mousemove', handleMouseMove, { signal: abortController.signal });
                document.addEventListener('mousedown', handleMouseDown, { signal: abortController.signal }); // NEW
                document.addEventListener('mouseup', handleMouseUp, { signal: abortController.signal });     // NEW

                // --- Setup Pointer Lock Listener (ASAP for FPS input) ---
                if (canvasElement) { // Ensure canvasElement exists
                    // Attach pointer lock error handler once
                    document.addEventListener('pointerlockerror', (event) => {
                        console.error('[PointerLock] Error acquiring pointer lock:', event);
                    }, { once: true });

                    const pointerLockClickListener = () => {
                        // Only request pointer lock if NOT in debug/orbital mode
                        if (!isDebugModeEnabled && !document.pointerLockElement) {
                            if (typeof canvasElement.requestPointerLock === 'function') {
                                canvasElement.requestPointerLock(); // No .catch(), synchronous in most browsers
                                cameraModeRef.current.isOrbital = false; // <<< Disable debug when locking pointer
                            } else {
                                console.error('[PointerLock] Error: canvasElement.requestPointerLock is not a function!');
                            }
                        } else if (isDebugModeEnabled) {
                        } else {
                        }
                    };
                    canvasElement.addEventListener('click', pointerLockClickListener, { signal: abortController.signal });
                } else {
                    console.error("[PointerLock] Canvas element not found at pointer lock setup!");
                }

                // --- Render Loop ---
                let lastTimestamp = performance.now();
                const clock = new THREE.Clock(); // Use Clock for mixer updates
                const thirdPersonOffset = new THREE.Vector3(-0.1, 0.6, -1); // FPS third-person: Over left shoulder, character closer to center
                const tempPlayerPos = new THREE.Vector3(); // Temporary vectors for calculations
                const tempCameraPos = new THREE.Vector3();
                const tempLookAt = new THREE.Vector3();

                // NEW: Fixed timestep physics loop variables
                let accumulator = 0.0;
                const physicsTickRate = 1000 / 60; // 60Hz
                let lastPhysicsTime = performance.now();

                const render = (timestamp) => {
                    if (!isMounted) return;
                    renderLoopIdRef.current = requestAnimationFrame(render);

                    const frameTime = timestamp - lastPhysicsTime;
                    lastPhysicsTime = timestamp;
                    accumulator += frameTime;

                    const mixerDeltaTime = clock.getDelta();

                    // Run fixed-step physics loop
                    while (accumulator >= physicsTickRate) {
                        const fixedDeltaTime = physicsTickRate / 1000;

                        // Get Local Player State
                        const localState = gameStateRef.current?.players?.[localPlayerUserId];

                        // >>> NEW: Client-side ground check for responsive jumping <<<
                        let isClientOnGround = false;
                        let clientGroundNormal = null;
                        if (rapierWorldRef.current && localPlayerRef.current.rapierBody) {
                                                    const rapierWorld = rapierWorldRef.current;
                        const body = localPlayerRef.current.rapierBody;
                        const currentPos = body.translation();
                        
                        const serverConstants = getServerConstants();
                        const playerHeight = serverConstants.PLAYER_TOTAL_HEIGHT;
                        const playerRadius = serverConstants.PLAYER_RADIUS;
                            const halfHeight = playerHeight / 2;
                            const capsuleBottomOffset = halfHeight - playerRadius;
                            
                            const rayOrigin = { x: currentPos.x, y: currentPos.y - capsuleBottomOffset, z: currentPos.z };
                            const rayDirection = { x: 0, y: -1, z: 0 };
                            const rayLength = playerRadius + 0.15;
                            
                            const filterGroups = interactionGroups(CollisionGroup.PLAYER_UTILITY_RAY, [CollisionGroup.WORLD]);
                            
                            const ray = new RAPIER.Ray(rayOrigin, rayDirection);
                            const hit = rapierWorld.castRayAndGetNormal(ray, rayLength, true, filterGroups);
                            
                            if (hit) {
                                const slopeAngle = Math.acos(hit.normal.y);
                                if (slopeAngle < MAX_SLOPE_ANGLE_RAD) {
                                    isClientOnGround = true;
                                    clientGroundNormal = hit.normal;
                                } else {
                                    isClientOnGround = false;
                                }
                            } else {
                                isClientOnGround = false;
                            }
                        }

                        // Apply local input prediction for responsive movement
                        if (localPlayerRef.current.rapierBody && localState && localState.state === 'alive') {
                            applyInputPhysics(
                                localPlayerRef.current.rapierBody,
                                inputStateRef.current.keys,
                                inputStateRef.current.lookQuat,
                                fixedDeltaTime, // Use fixed delta time
                                isClientOnGround,
                                clientGroundNormal
                            );
                        }

                        // Step Client Physics World
                        if (rapierWorldRef.current) {
                            rapierWorldRef.current.step();
                        }

                        accumulator -= physicsTickRate;
                    }
                    
                    // The rest of the function is for rendering, which runs on every frame
                    
                    // Handle firing logic every frame
                    handleFiring();

                    // NEW: Update weapon prediction timers and reconcile with server
                    updateWeaponPrediction(frameTime);

                    // Get Local Player State for rendering
                    const localState = gameStateRef.current?.players?.[localPlayerUserId];

                    // --- NEW: Visual Projectile Animation ---
                    const stillActiveProjectiles = [];
                    for (const proj of activeVisualProjectilesRef.current) {
                        const direction = proj.target.clone().sub(proj.mesh.position).normalize();
                        const distance = proj.mesh.position.distanceTo(proj.target);
                        const moveDistance = proj.speed * (frameTime / 1000); // Use visual frame time

                        if (distance <= moveDistance) {
                            proj.mesh.visible = false;
                            projectilePoolRef.current.push(proj.mesh);
                        } else {
                            proj.mesh.position.add(direction.multiplyScalar(moveDistance));
                            stillActiveProjectiles.push(proj);
                        }
                    }
                    activeVisualProjectilesRef.current = stillActiveProjectiles;

                    // Get active weapon ID from game state for FPV model visibility
                    let activeWeaponId = null;
                    if (localState && localState.weaponSlots && localState.activeWeaponSlot !== undefined) {
                        activeWeaponId = localState.weaponSlots[localState.activeWeaponSlot];
                    }

                    // --- Recoil Recovery Logic ---
                    if (activeWeaponId) {
                        const weaponConfig = WEAPON_CONFIG_FPS[activeWeaponId];
                        if (weaponConfig) {
                            const recoverySpeed = weaponConfig.recoilRecoverySpeed;
                            const recoveryDelta = frameTime / 1000; // Use visual frame time
                            // Recover pitch
                            if (recoilStateRef.current.pitch > 0) {
                                const pitchRecovery = recoilStateRef.current.pitch * recoverySpeed * recoveryDelta;
                                recoilStateRef.current.pitch -= pitchRecovery;
                            } else {
                                recoilStateRef.current.pitch = 0;
                            }
                            // Recover yaw
                            if (Math.abs(recoilStateRef.current.yaw) > 0.001) {
                                const yawRecovery = recoilStateRef.current.yaw * recoverySpeed * recoveryDelta;
                                recoilStateRef.current.yaw -= yawRecovery;
                            } else {
                                recoilStateRef.current.yaw = 0;
                            }
                        }
                    }

                    // FPV Weapon Aiming Logic
                    if (fpvElementsRef.current.camera) {
                        const fpvCam = fpvElementsRef.current.camera;
                        const defaultFov = 60;
                        const zoomFov = 30; // Example zoom FOV
                        const fov = inputStateRef.current.isAiming ? zoomFov : defaultFov;

                        // Smooth FOV transition
                        if (Math.abs(fpvCam.fov - fov) > 0.1) {
                            fpvCam.fov += (fov - fpvCam.fov) * 0.2;
                            fpvCam.updateProjectionMatrix();
                        }

                        // Update mixer for the active weapon
                        if (activeWeaponId && fpvElementsRef.current.weaponModels[activeWeaponId]?.mixer) {
                            fpvElementsRef.current.weaponModels[activeWeaponId].mixer.update(mixerDeltaTime);
                        }
                    }

                    // >>> NEW: Send Input State Periodically <<<
                    const now = performance.now();
                    if (socketRef.current?.connected && now - lastInputSendTimeRef.current > INPUT_SEND_INTERVAL) {
                        inputStateRef.current.sequence++; // Increment sequence number
                        // Ensure all relevant keys are included in the payload
                        const payload = {
                            sequence: inputStateRef.current.sequence,
                            keys: { ...inputStateRef.current.keys }, // Send current key state
                            lookQuat: { ...inputStateRef.current.lookQuat }
                        };
                        
                        // NEW: Log input being sent to server
                        const hasMovementKeys = payload.keys.W || payload.keys.A || payload.keys.S || payload.keys.D || payload.keys.Shift;
                        if (hasMovementKeys) {
                        }
                        
                        socketRef.current.emit(MessageTypeFPS.PLAYER_INPUT_FPS, payload);
                        lastInputSendTimeRef.current = now;
                        // Store this input locally for reconciliation (Plan 2.3.1)
                        inputStateRef.current.pendingInputs.push(payload);
                        // Limit buffer size if needed
                        if (inputStateRef.current.pendingInputs.length > 60) { // Keep ~1-2 seconds of inputs
                             inputStateRef.current.pendingInputs.shift();
                        }
                    }
                    // >>> End Send Input State <<<

                    // --- RESTORED: Client Physics Prediction for Smooth Movement ---
                    // This is now handled inside the fixed physics loop above.

                    // --- Update Player Mixers ---
                    localPlayerRef.current.mixer?.update(mixerDeltaTime);
                    remotePlayerRef.current.mixer?.update(mixerDeltaTime);

                    // --- Character Animation Logic (Movement Animations) ---
                    if (localPlayerRef.current.mixer && playerAnimationActionsRef.current) {
                        const keys = inputStateRef.current.keys;
                        const localState = gameStateRef.current?.players?.[localPlayerUserId];
                        
                        let targetAnim = null;

                        // >>> NEW: Prioritize action animations over movement <<<
                        if (localState && localState.state === 'dead') {
                            targetAnim = 'death'; // Death animation takes highest priority
                        } else if (localState && localState.isReloading) {
                            // Check if player is moving while reloading
                            const isMoving = keys.W || keys.A || keys.S || keys.D;
                            const isRunning = keys.Shift;
                            if (isMoving && isRunning && keys.W) {
                                targetAnim = 'runForwardReload'; // Running forward while reloading
                            } else {
                                targetAnim = 'reloadIdle'; // Static reloading
                            }
                        } else if (inputStateRef.current.isFiring) {
                            // Firing animations - check if moving
                            const isMoving = keys.W || keys.A || keys.S || keys.D;
                            const isRunning = keys.Shift;
                            if (isMoving && isRunning && keys.W) {
                                targetAnim = 'runFowardFire'; // Already exists - running forward while firing
                            } else if (!isMoving) {
                                targetAnim = 'fireIdle'; // Standing still while firing
                            } else {
                                // Moving but not running forward - use movement animation
                                targetAnim = null; // Will fall through to movement logic
                            }
                        } else if (inputStateRef.current.isAiming) {
                            // Aiming animations
                            const isMoving = keys.W || keys.A || keys.S || keys.D;
                            if (!isMoving) {
                                targetAnim = 'aimIdle'; // Standing still while aiming
                            } else {
                                // Moving while aiming - use movement animation
                                targetAnim = null; // Will fall through to movement logic
                            }
                        }

                        // If no action animation was selected, use movement logic
                        if (targetAnim === null) {
                            // NEW: COMPREHENSIVE MOVEMENT ANIMATION LOGIC
                            // Supports crouch, diagonal movement, and combinations
                            
                            const isCrouching = keys.Crouch;
                            const isRunning = keys.Shift;
                            const W = keys.W; // Forward
                            const A = keys.A; // Left
                            const S = keys.S; // Backward
                            const D = keys.D; // Right
                            
                            // Priority order: Action states > Complex movement > Simple movement > Idle
                            
                            if (isCrouching) {
                                // CROUCH ANIMATIONS
                                if (W && A) {
                                    targetAnim = 'walkForwardCrouchLeft';
                                } else if (W && D) {
                                    targetAnim = 'walkForwardCrouchRight';
                                } else if (S && A) {
                                    targetAnim = 'walkBackwardCrouchLeft';
                                } else if (S && D) {
                                    targetAnim = 'walkBackwardCrouchRight';
                                } else if (W) {
                                    targetAnim = 'walkForwardCrouch';
                                } else if (S) {
                                    targetAnim = 'walkCrouchBackward';
                                } else if (A) {
                                    targetAnim = 'walkLeftCrouch';
                                } else if (D) {
                                    targetAnim = 'walkRightCrouch';
                                } else {
                                    targetAnim = 'crouchIdle';
                                }
                            } else if (isRunning && (W || A || S || D)) {
                                // RUNNING ANIMATIONS
                                if (W && A) {
                                    targetAnim = 'runForwardLeft';
                                } else if (W && D) {
                                    targetAnim = 'runForwardRight';
                                } else if (S && A) {
                                    targetAnim = 'runBackwardLeft';
                                } else if (S && D) {
                                    targetAnim = 'runBackwardRight';
                                } else if (W) {
                                    targetAnim = 'runFowardFire'; // Note: Keep GLB typo for exact match
                                } else if (S) {
                                    targetAnim = 'runBackward';
                                } else if (A) {
                                    targetAnim = 'runLeft';
                                } else if (D) {
                                    targetAnim = 'runRight';
                                }
                            } else if (W || A || S || D) {
                                // WALKING ANIMATIONS (diagonal combinations have priority)
                                if (W && A) {
                                    targetAnim = 'walkForwardLeft';
                                } else if (W && D) {
                                    targetAnim = 'walkForwardRight';
                                } else if (S && A) {
                                    targetAnim = 'walkBackwardLeft';
                                } else if (S && D) {
                                    targetAnim = 'walkBackwardRight';
                                } else if (W) {
                                    targetAnim = 'walkForward';
                                } else if (S) {
                                    targetAnim = 'walkBackward';
                                } else if (A) {
                                    targetAnim = 'strafeLeft';
                                } else if (D) {
                                    targetAnim = 'strafeRight';
                                }
                            } else {
                                // IDLE ANIMATIONS
                                targetAnim = 'idle';
                            }
                            
                            // 🔧 JITTER FIX: Removed debug logging that was causing performance issues every frame
                        }

                        // Enhanced DEBUG: Log available animations and target animation
                        const availableAnims = Object.keys(playerAnimationActionsRef.current);
                        
                        // Apply animation name mapping to get the correct GLB animation
                        const mappedAnimName = getCorrectAnimationName(targetAnim);
                        
                        // Improved animation selection with exact matching and semantic fallbacks
                        let finalTargetAnim = null;
                        
                        // Step 1: Try exact match first (using mapped name)
                        if (playerAnimationActionsRef.current[mappedAnimName]) {
                            finalTargetAnim = mappedAnimName;
                        } else {
                            
                            // Step 2: Try semantic fallbacks with priority ranking
                            const semanticFallbacks = {
                                'idle': [
                                    'idle',           // Exact match (shouldn't reach here)
                                    'Idle',           // Case variation
                                    'idle_pose',      // Common naming
                                    'aimIdle',        // Specific idle variants
                                    'fireIdle',
                                    'T-pose',         // Bind pose
                                    'Default'         // Default pose
                                ],
                                // ACTION ANIMATIONS
                                'death': [
                                    'death',
                                    'die',
                                    'dead',
                                    'death_animation',
                                    'idle'  // Fallback to idle if no death animation
                                ],
                                'aimIdle': [
                                    'aimIdle',
                                    'aim_idle',
                                    'aiming_idle',
                                    'aim',
                                    'idle'  // Fallback to regular idle
                                ],
                                'fireIdle': [
                                    'fireIdle',
                                    'fire_idle',
                                    'shooting_idle',
                                    'shoot_idle',
                                    'fire',
                                    'idle'  // Fallback to regular idle
                                ],
                                'idleGrenadeThrow': [
                                    'idleGrenadeThrow',
                                    'idle_grenade_throw',
                                    'grenade_idle',
                                    'grenade_throw_idle',
                                    'idle'  // Fallback to regular idle
                                ],
                                'forwardGrenadeThrow': [
                                    'forwardGrenadeThrow',
                                    'forward_grenade_throw',
                                    'grenade_throw_forward',
                                    'walkForward'  // Fallback to walking forward
                                ],
                                'runForwardReload': [
                                    'runForwardReload',
                                    'run_forward_reload',
                                    'reload_run_forward',
                                    'runFowardFire',  // Similar running animation
                                    'runForward',     // Fallback to running
                                    'reloadIdle'      // Fallback to static reload
                                ],
                                'reloadIdle': [
                                    'reloadIdle',
                                    'reload_idle',
                                    'reloading_idle',
                                    'reload',
                                    'idle'  // Fallback to regular idle
                                ],
                                // CROUCH ANIMATIONS
                                'crouchIdle': [
                                    'crouchIdle',
                                    'crouch_idle',
                                    'crouch',
                                    'idle_crouch',
                                    'squat_idle',
                                    'idle'  // Fallback to standing idle
                                ],
                                'walkForwardCrouch': [
                                    'walkForwardCrouch',
                                    'walk_forward_crouch',
                                    'crouchWalkForward',
                                    'crouch_walk_forward',
                                    'walkForward'  // Fallback to standing walk
                                ],
                                'walkLeftCrouch': [
                                    'walkLeftCrouch',
                                    'walk_left_crouch',
                                    'crouchWalkLeft',
                                    'crouch_walk_left',
                                    'strafeLeft'  // Fallback to standing strafe
                                ],
                                'walkRightCrouch': [
                                    'walkRightCrouch',
                                    'walk_right_crouch',
                                    'crouchWalkRight',
                                    'crouch_walk_right',
                                    'strafeRight'  // Fallback to standing strafe
                                ],
                                'walkCrouchBackward': [
                                    'walkCrouchBackward',
                                    'walk_crouch_backward',
                                    'crouchWalkBackward',
                                    'crouch_walk_backward',
                                    'walkBackward'  // Fallback to standing walk
                                ],
                                'walkForwardCrouchLeft': [
                                    'walkForwardCrouchLeft',
                                    'walk_forward_crouch_left',
                                    'crouchWalkForwardLeft',
                                    'walkForwardLeft'  // Fallback to standing diagonal
                                ],
                                'walkForwardCrouchRight': [
                                    'walkForwardCrouchRight',
                                    'walk_forward_crouch_right',
                                    'crouchWalkForwardRight',
                                    'walkForwardRight'  // Fallback to standing diagonal
                                ],
                                'walkBackwardCrouchLeft': [
                                    'walkBackwardCrouchLeft',
                                    'walk_backward_crouch_left',
                                    'crouchWalkBackwardLeft',
                                    'walkBackwardLeft'  // Fallback to standing diagonal
                                ],
                                'walkBackwardCrouchRight': [
                                    'walkBackwardCrouchRight',
                                    'walk_backward_crouch_right',
                                    'crouchWalkBackwardRight',
                                    'walkBackwardRight'  // Fallback to standing diagonal
                                ],
                                // DIAGONAL WALKING ANIMATIONS
                                'walkForwardLeft': [
                                    'walkForwardLeft',
                                    'walk_forward_left',
                                    'walkNorthWest',
                                    'walk_NW',
                                    'walkForward'  // Fallback to simple forward
                                ],
                                'walkForwardRight': [
                                    'walkForwardRight',
                                    'walk_forward_right',
                                    'walkNorthEast',
                                    'walk_NE',
                                    'walkForward'  // Fallback to simple forward
                                ],
                                'walkBackwardLeft': [
                                    'walkBackwardLeft',
                                    'walk_backward_left',
                                    'walkSouthWest',
                                    'walk_SW',
                                    'walkBackward'  // Fallback to simple backward
                                ],
                                'walkBackwardRight': [
                                    'walkBackwardRight',
                                    'walk_backward_right',
                                    'walkSouthEast',
                                    'walk_SE',
                                    'walkBackward'  // Fallback to simple backward
                                ],
                                // RUNNING ANIMATIONS
                                'runForwardLeft': [
                                    'runForwardLeft',
                                    'run_forward_left',
                                    'runNorthWest',
                                    'runFowardLeft',  // Handle typos
                                    'walkForwardLeft'  // Fallback to walking
                                ],
                                'runForwardRight': [
                                    'runForwardRight',
                                    'run_forward_right',
                                    'runNorthEast',
                                    'runFowardRight',  // Handle typos
                                    'walkForwardRight'  // Fallback to walking
                                ],
                                'runBackwardLeft': [
                                    'runBackwardLeft',
                                    'run_backward_left',
                                    'runSouthWest',
                                    'walkBackwardLeft'  // Fallback to walking
                                ],
                                'runBackwardRight': [
                                    'runBackwardRight',
                                    'run_backward_right',
                                    'runSouthEast',
                                    'walkBackwardRight'  // Fallback to walking
                                ],
                                'runLeft': [
                                    'runLeft',
                                    'run_left',
                                    'runStrafeLeft',
                                    'strafeLeft'  // Fallback to walking
                                ],
                                'runRight': [
                                    'runRight',
                                    'run_right',
                                    'runStrafeRight',
                                    'strafeRight'  // Fallback to walking
                                ],
                                'runBackward': [
                                    'runBackward',
                                    'run_backward',
                                    'walkBackward'  // Fallback to walking
                                ],
                                // EXISTING ANIMATIONS (keep original)
                                'walkForward': [
                                    'walkForward',
                                    'walk_forward',
                                    'walkFoward',     // Handle typos in GLB
                                    'runForward',     // Close alternative
                                    'walking',
                                    'walk'
                                ],
                                'runFowardFire': [
                                    'runFowardFire',
                                    'runForwardFire', // Correct spelling
                                    'run_forward_fire',
                                    'runForward',     // Without fire
                                    'runFoward',      // Common typo
                                    'walkForward'     // Slower alternative
                                ],
                                'walkBackward': [
                                    'walkBackward',
                                    'walk_backward',
                                    'runBackward',
                                    'walking_back'
                                ],
                                'strafeLeft': [
                                    'strafeLeft',
                                    'strafe_left',
                                    'walkLeft',
                                    'runLeft',
                                    'sideLeft'
                                ],
                                'strafeRight': [
                                    'strafeRight',
                                    'strafe_right',
                                    'walkRight',
                                    'runRight',
                                    'sideRight'
                                ]
                            };
                            
                            const candidates = semanticFallbacks[targetAnim] || [];
                            
                            // Try each candidate in priority order
                            for (const candidate of candidates) {
                                if (playerAnimationActionsRef.current[candidate]) {
                                    finalTargetAnim = candidate;
                                    break;
                                }
                            }
                            
                            // Step 3: If still no match, try universal fallbacks
                            if (!finalTargetAnim) {
                                
                                // Filter for safe idle animations (exclude action-specific idles)
                                const safeIdleAnims = availableAnims.filter(name => {
                                    const lowerName = name.toLowerCase();
                                    // Include animations that contain "idle" BUT exclude action-specific ones
                                    return (
                                        lowerName.includes('idle') || 
                                        lowerName.includes('stand') || 
                                        lowerName.includes('pose')
                                    ) && !(
                                        // Exclude action-specific idle animations
                                        lowerName.includes('grenade') ||
                                        lowerName.includes('throw') ||
                                        lowerName.includes('reload') ||
                                        lowerName.includes('fire') ||
                                        lowerName.includes('shoot') ||
                                        lowerName.includes('attack') ||
                                        lowerName.includes('death') ||
                                        lowerName.includes('hit') ||
                                        lowerName.includes('damage')
                                    );
                                });
                                
                                const universalFallbacks = [
                                    'idle', 'Idle', 'idle_pose', 'T-pose', 'Default',
                                    ...safeIdleAnims
                                ];
                                
                                for (const fallback of universalFallbacks) {
                                    if (playerAnimationActionsRef.current[fallback]) {
                                        finalTargetAnim = fallback;
                                        break;
                                    }
                                }
                            }
                            
                            // Step 4: Last resort - use first available animation
                            if (!finalTargetAnim && availableAnims.length > 0) {
                                finalTargetAnim = availableAnims[0];
                            }
                            
                            // Step 5: Complete failure - no animations available
                            if (!finalTargetAnim) {
                                if (currentPlayerActionRef.current) {
                                    currentPlayerActionRef.current.stop();
                                    currentPlayerActionRef.current = null;
                                }
                                return; // Exit early
                            }
                        }

                        const mixer = localPlayerRef.current.mixer;
                        const actions = playerAnimationActionsRef.current;
                        const newAction = actions[finalTargetAnim] ? mixer.clipAction(actions[finalTargetAnim]) : null;
                        const prevAction = currentPlayerActionRef.current;

                        if (newAction && prevAction !== newAction) {
                            if (prevAction) {
                                prevAction.fadeOut(0.2);
                            }
                            newAction.reset().setEffectiveTimeScale(1).setEffectiveWeight(1).fadeIn(0.2).play();
                            newAction.loop = THREE.LoopRepeat;
                            currentPlayerActionRef.current = newAction;
                        } else if (newAction) {
                        }

                                                                    // --- Update Dual-Hand Weapon Constraint System ---
                        // OLD ATTACHMENT LOGIC REMOVED - Only using dual-hand constraint system now
                    if (localPlayerRef.current.weaponConstraint && localPlayerRef.current.weaponConstraint.isActive) {
                        const constraint = localPlayerRef.current.weaponConstraint;
                        const leftHand = constraint.leftHand;
                        const rightHand = constraint.rightHand;
                        const weaponGroup = constraint.weaponGroup;
                        
                        if (leftHand && rightHand && weaponGroup) {
                            // Get world positions and rotations of both hands
                            const leftHandWorldPos = new THREE.Vector3();
                            const rightHandWorldPos = new THREE.Vector3();
                            const leftHandWorldQuat = new THREE.Quaternion();
                            const rightHandWorldQuat = new THREE.Quaternion();
                            
                            leftHand.getWorldPosition(leftHandWorldPos);
                            rightHand.getWorldPosition(rightHandWorldPos);
                            leftHand.getWorldQuaternion(leftHandWorldQuat);
                            rightHand.getWorldQuaternion(rightHandWorldQuat);
                            
                            // Position weapon at right hand with forward and upward offset
                            const forwardOffset = new THREE.Vector3(0, 0, 0.3); // Forward from hand
                            const upwardOffset = new THREE.Vector3(0, 0.1, 0);  // Upward from hand
                            forwardOffset.applyQuaternion(rightHandWorldQuat);
                            upwardOffset.applyQuaternion(rightHandWorldQuat); // Also rotate the upward offset
                            weaponGroup.position.copy(rightHandWorldPos).add(forwardOffset).add(upwardOffset);
                            
                            // Use character yaw directly from input state for immediate rotation response
                            const characterYaw = inputStateRef.current.characterYaw;
                            const weaponYaw = characterYaw + Math.PI; // Add 180 degrees (π radians)
                            
                            // Create weapon rotation quaternion
                            const weaponQuaternion = new THREE.Quaternion();
                            weaponQuaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), weaponYaw);
                            
                            // Apply rotation to weapon group
                            weaponGroup.quaternion.copy(weaponQuaternion);
                            
                            // Debug output (uncomment to see constraint working)
                            // console.log(`🔗 Weapon positioned between hands at: (${handMidpoint.x.toFixed(2)}, ${handMidpoint.y.toFixed(2)}, ${handMidpoint.z.toFixed(2)})`);
                        }
                    }
                        
                    }

                    // --- Remote Player Animation Logic ---
                    if (remotePlayerRef.current.mixer && remotePlayerAnimationActionsRef.current) {
                        // Find the opponent by finding the player that's not the local player
                        let remoteState = null;
                        if (gameStateRef.current?.players) {
                            for (const userId in gameStateRef.current.players) {
                                if (userId !== localPlayerUserId) {
                                    remoteState = gameStateRef.current.players[userId];
                                    break;
                                }
                            }
                        }
                        
                        if (remoteState && remoteState.state === 'alive') {
                            // Determine remote player animation based on server state
                            let remoteTargetAnim = 'idle'; // Default to logical idle (will be mapped)
                            
                            // Simple animation logic based on velocity (server sends this)
                            if (remoteState.velocity) {
                                const speed = Math.sqrt(remoteState.velocity.x**2 + remoteState.velocity.z**2);
                                if (speed > 0.1) {
                                    // Player is moving
                                    if (speed > 6) {
                                        remoteTargetAnim = 'runFowardFire'; // Running
                                    } else {
                                        remoteTargetAnim = 'walkForward'; // Walking
                                    }
                                }
                            }
                            
                            // Apply mapping to get correct GLB animation name
                            const mappedRemoteAnimName = getCorrectAnimationName(remoteTargetAnim);
                            
                            // Apply animation to remote player
                            const remoteMixer = remotePlayerRef.current.mixer;
                            const remoteActions = remotePlayerAnimationActionsRef.current;
                            
                            if (remoteActions[mappedRemoteAnimName]) {
                                const newRemoteAction = remoteMixer.clipAction(remoteActions[mappedRemoteAnimName]);
                                const prevRemoteAction = currentRemoteActionRef.current;
                                
                                if (newRemoteAction && prevRemoteAction !== newRemoteAction) {
                                    if (prevRemoteAction) {
                                        prevRemoteAction.fadeOut(0.2);
                                    }
                                    newRemoteAction.reset().setEffectiveTimeScale(1).setEffectiveWeight(1).fadeIn(0.2).play();
                                    newRemoteAction.loop = THREE.LoopRepeat;
                                    currentRemoteActionRef.current = newRemoteAction;
                                }
                            }

                        // --- Update Remote Player Dual-Hand Weapon Constraint ---
                        // OLD ATTACHMENT LOGIC REMOVED - Only using dual-hand constraint system now
                        if (remotePlayerRef.current.weaponConstraint && remotePlayerRef.current.weaponConstraint.isActive) {
                            const constraint = remotePlayerRef.current.weaponConstraint;
                            const leftHand = constraint.leftHand;
                            const rightHand = constraint.rightHand;
                            const weaponGroup = constraint.weaponGroup;
                            
                            if (leftHand && rightHand && weaponGroup) {
                                // Get world positions and rotations of both hands
                                const leftHandWorldPos = new THREE.Vector3();
                                const rightHandWorldPos = new THREE.Vector3();
                                const leftHandWorldQuat = new THREE.Quaternion();
                                const rightHandWorldQuat = new THREE.Quaternion();
                                
                                leftHand.getWorldPosition(leftHandWorldPos);
                                rightHand.getWorldPosition(rightHandWorldPos);
                                leftHand.getWorldQuaternion(leftHandWorldQuat);
                                rightHand.getWorldQuaternion(rightHandWorldQuat);
                                
                                // Position weapon at right hand with forward and upward offset
                                const forwardOffset = new THREE.Vector3(0, 0, 0.3); // Forward from hand
                                const upwardOffset = new THREE.Vector3(0, 0.1, 0);  // Upward from hand
                                forwardOffset.applyQuaternion(rightHandWorldQuat);
                                upwardOffset.applyQuaternion(rightHandWorldQuat); // Also rotate the upward offset
                                weaponGroup.position.copy(rightHandWorldPos).add(forwardOffset).add(upwardOffset);
                                
                                // For remote player, use the character mesh rotation directly
                                const characterMesh = remotePlayerRef.current.mesh;
                                const characterQuaternion = characterMesh.quaternion.clone();
                                
                                // Extract yaw rotation and add 180 degrees
                                const euler = new THREE.Euler().setFromQuaternion(characterQuaternion, 'YXZ');
                                const weaponYaw = euler.y + Math.PI; // Add 180 degrees
                                
                                // Create weapon rotation quaternion
                                const weaponQuaternion = new THREE.Quaternion();
                                weaponQuaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), weaponYaw);
                                
                                // Apply rotation to weapon group
                                weaponGroup.quaternion.copy(weaponQuaternion);
                            }
                        }
                        }
                    }

                    // --- Update FPV Weapon Visibility ---
                    // >> NEW: Control overall FPV camera visibility first <<
                    const isFirstPerson = !cameraModeRef.current.isThirdPerson && !cameraModeRef.current.isOrbital;
                    if (fpvElementsRef.current.camera) {
                        fpvElementsRef.current.camera.visible = isFirstPerson;
                    }
                    // >> END NEW <<

                    // Keep this logic: Only make the *active* weapon model visible *when* FPV is active
                    for (const weaponId in fpvElementsRef.current.weaponModels) {
                        const weaponData = fpvElementsRef.current.weaponModels[weaponId];
                        if (weaponData?.model) {
                            weaponData.model.visible = isFirstPerson && (weaponId === activeWeaponId);
                        }
                    }

                    // --- Update Player Mesh Visibility & Position (FPS Optimized) ---
                    if (localPlayerRef.current.mesh) {
                        localPlayerRef.current.mesh.visible = cameraModeRef.current.isThirdPerson;
                        
                        // NEW: Create client-side physics body for local player if needed
                        if (!localPlayerRef.current.rapierBody && localState && localState.position && localState.state === 'alive') {
                            console.log(`🔧 [CLIENT] Creating local player physics body...`);
                            const spawnPos = localState.position;
                            const serverConstants = getServerConstants();
                            
                            // Create client-side physics body for prediction with MATCHED server damping
                            const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
                                .setTranslation(spawnPos.x, spawnPos.y, spawnPos.z)
                                .setCanSleep(false)
                                .setCcdEnabled(true)
                                .lockRotations()
                                .setLinearDamping(0.9) // MATCHED to server value
                                .setAngularDamping(1.0); // MATCHED to server value
                            const body = rapierWorldRef.current.createRigidBody(bodyDesc);
                            
                            const capsuleHalfHeight = serverConstants.PLAYER_TOTAL_HEIGHT / 2 - serverConstants.PLAYER_RADIUS;
                            const colliderDesc = RAPIER.ColliderDesc.capsule(capsuleHalfHeight, serverConstants.PLAYER_RADIUS)
                                .setDensity(800.0) // MATCHED to server for stable physics
                                .setFriction(0.8) // MATCHED to server for consistent movement
                                .setRestitution(0.02) // MATCHED to server to minimize bouncing
                                .setCollisionGroups(interactionGroups(
                                    CollisionGroup.PLAYER_BODY,
                                    [CollisionGroup.WORLD, CollisionGroup.PLAYER_BODY, CollisionGroup.GRENADE]
                                ))
                                .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
                            const collider = rapierWorldRef.current.createCollider(colliderDesc, body);
                            
                            // Set userData for identification
                            if (collider) {
                                collider.userData = { type: 'playerBody', playerId: localPlayerUserId, isLocal: true };
                            }
                            
                            localPlayerRef.current.rapierBody = body;
                            console.log(`✅ [CLIENT] Local player physics body created with matched server damping`);
                        }
                        
                        // Update mesh from predicted Rapier body state for smooth movement
                        if (localPlayerRef.current.rapierBody) {
                            const localCharConfig = CHARACTER_CONFIG_FPS[localPlayerCharacterId];
                            const localCharacterVisualYOffset = localCharConfig?.visualYOffset || 0.0;
                            const serverConstants = getServerConstants();
                            const totalCapsuleHalfHeightForVisuals = serverConstants.PLAYER_TOTAL_HEIGHT / 2;

                            const predictedPos = localPlayerRef.current.rapierBody.translation();

                            const targetPosition = new THREE.Vector3(
                                predictedPos.x,
                                predictedPos.y - totalCapsuleHalfHeightForVisuals + localCharacterVisualYOffset,
                                predictedPos.z
                            );

                            // NEW: Improved exponential decay interpolation for smoother movement
                            const currentPos = localPlayerRef.current.mesh.position;
                            const distance = currentPos.distanceTo(targetPosition);
                            
                            // Dynamic interpolation speed based on distance
                            let interpSpeed = 0.15; // Base interpolation speed (reduced from 0.3)
                            if (distance > 2.0) {
                                interpSpeed = 0.8; // Fast catch-up for large distances
                            } else if (distance > 0.5) {
                                interpSpeed = 0.4; // Medium speed for moderate distances
                            }
                            
                            // Exponential decay interpolation
                            const deltaTime = frameTime / 1000; // Convert to seconds
                            const decay = Math.exp(-interpSpeed * 60 * deltaTime); // 60 for target 60fps
                            localPlayerRef.current.mesh.position.lerp(targetPosition, 1 - decay);

                            // Use immediate input-based rotation for responsiveness
                            const characterYawQuaternion = new THREE.Quaternion();
                            characterYawQuaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), inputStateRef.current.characterYaw);
                            
                            // Apply rotation directly for immediate response
                            localPlayerRef.current.mesh.quaternion.copy(characterYawQuaternion);

                        } else if (localState && localState.position && localState.rotation) {
                            // Fallback to server state if physics body not available
                            const localCharConfig = CHARACTER_CONFIG_FPS[localPlayerCharacterId];
                            const localCharacterVisualYOffset = localCharConfig?.visualYOffset || 0.0;
                            const serverConstants = getServerConstants();
                            const totalCapsuleHalfHeightForVisuals = serverConstants.PLAYER_TOTAL_HEIGHT / 2;
                            
                            const serverTargetPosition = new THREE.Vector3(
                                localState.position.x,
                                localState.position.y - totalCapsuleHalfHeightForVisuals + localCharacterVisualYOffset,
                                localState.position.z
                            );
                            
                            // NEW: Smooth fallback positioning with exponential decay
                            const deltaTime = frameTime / 1000;
                            const decay = Math.exp(-0.12 * 60 * deltaTime); // Slower for server fallback
                            localPlayerRef.current.mesh.position.lerp(serverTargetPosition, 1 - decay);
                            
                            // Use server rotation as fallback with smooth interpolation
                            const serverQuaternion = new THREE.Quaternion(localState.rotation.x, localState.rotation.y, localState.rotation.z, localState.rotation.w);
                            localPlayerRef.current.mesh.quaternion.slerp(serverQuaternion, 1 - decay);
                        }
                    }
                    if (remotePlayerRef.current.mesh) {
                         // Find the opponent by finding the player that's not the local player
                         let remoteState = null;
                         let remotePlayerId = null;
                         if (gameStateRef.current?.players) {
                             for (const userId in gameStateRef.current.players) {
                                 if (userId !== localPlayerUserId) {
                                     remoteState = gameStateRef.current.players[userId];
                                     remotePlayerId = userId;
                                     break;
                                 }
                             }
                         }
                         
                         if (remoteState && remoteState.position && remoteState.rotation && remoteState.state === 'alive') {
                            remotePlayerRef.current.mesh.visible = true; 
                            
                            // NEW: Create client-side physics body for remote player if needed (for hitboxes)
                            if (!remotePlayerRef.current.rapierBody && rapierWorldRef.current) {
                                console.log(`🔧 [CLIENT] Creating remote player physics body for ${remotePlayerId}...`);
                                const spawnPos = remoteState.position;
                                const serverConstants = getServerConstants();
                                
                                // Create client-side physics body for hit detection
                                const bodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased() // Kinematic since server controls position
                                    .setTranslation(spawnPos.x, spawnPos.y, spawnPos.z);
                                const body = rapierWorldRef.current.createRigidBody(bodyDesc);
                                
                                const capsuleHalfHeight = serverConstants.PLAYER_TOTAL_HEIGHT / 2 - serverConstants.PLAYER_RADIUS;
                                const colliderDesc = RAPIER.ColliderDesc.capsule(capsuleHalfHeight, serverConstants.PLAYER_RADIUS)
                                    .setCollisionGroups(interactionGroups(
                                        CollisionGroup.PLAYER_BODY,
                                        [CollisionGroup.PROJECTILE] // Remote players can be hit by projectiles
                                    ))
                                    .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
                                const collider = rapierWorldRef.current.createCollider(colliderDesc, body);
                                
                                // Set userData for identification
                                if (collider) {
                                    collider.userData = { type: 'playerBody', playerId: remotePlayerId, isLocal: false };
                                }
                                
                                remotePlayerRef.current.rapierBody = body;
                                console.log(`✅ [CLIENT] Remote player physics body created for ${remotePlayerId}`);
                            }
                            
                            const serverConstants = getServerConstants();
                            const totalCapsuleHalfHeightForVisuals = serverConstants.PLAYER_TOTAL_HEIGHT / 2;
                            
                            const opponentActualCharId = remoteState.characterId; // Get the opponent's actual characterId from gameState
                            const opponentCharConfig = CHARACTER_CONFIG_FPS[opponentActualCharId];
                            const remoteCharacterVisualYOffset = opponentCharConfig?.visualYOffset || 0.0;

                            const targetPosition = new THREE.Vector3(
                                remoteState.position.x,
                                remoteState.position.y - totalCapsuleHalfHeightForVisuals + remoteCharacterVisualYOffset, 
                                remoteState.position.z
                            );
                            
                            // NEW: Improved remote player interpolation with exponential decay
                            const currentPos = remotePlayerRef.current.mesh.position;
                            const distance = currentPos.distanceTo(targetPosition);
                            
                            // Dynamic interpolation speed for remote players
                            let interpSpeed = 0.12; // Base speed for remote players (slightly slower than local)
                            if (distance > 3.0) {
                                interpSpeed = 0.6; // Fast catch-up for large distances
                            } else if (distance > 1.0) {
                                interpSpeed = 0.3; // Medium speed for moderate distances
                            }
                            
                            // Exponential decay interpolation for smooth remote player movement
                            const deltaTime = frameTime / 1000;
                            const decay = Math.exp(-interpSpeed * 60 * deltaTime);
                            remotePlayerRef.current.mesh.position.lerp(targetPosition, 1 - decay);
                            
                            // Update remote player physics body position
                            if (remotePlayerRef.current.rapierBody) {
                                remotePlayerRef.current.rapierBody.setTranslation(remoteState.position, true);
                            }
                            
                            // NEW: Smooth rotation interpolation for remote player
                            const remoteQuaternion = new THREE.Quaternion(remoteState.rotation.x, remoteState.rotation.y, remoteState.rotation.z, remoteState.rotation.w);
                            remotePlayerRef.current.mesh.quaternion.slerp(remoteQuaternion, 1 - decay);
                        } else {
                            remotePlayerRef.current.mesh.visible = false;
                            if (remoteState) {
                                console.log(`Remote player hidden - state: ${remoteState.state}, hasPosition: ${!!remoteState.position}, hasRotation: ${!!remoteState.rotation}`);
                            } else {
                                // console.log('No remote player state found'); // This is too noisy
                            }
                         }
                    }

                    // --- Camera Controls Setup ---
                    // OrbitControls logic removed, handled by DebugControls

                    // --- Update Camera Position (FPS Optimized) ---
                    // ONLY update camera based on game state if Orbital mode is OFF
                    if (!cameraModeRef.current.isOrbital) {
                        if (cameraModeRef.current.isThirdPerson && localPlayerRef.current.mesh) {
                            // FPS THIRD-PERSON CAMERA: Fast, responsive camera that follows character instantly
                            // Camera position should follow character position with minimal delay
                            const characterPos = localPlayerRef.current.mesh.position;
                            
                            // NEW: Dynamic camera distance based on pitch angle
                            // Get the absolute pitch angle (looking up or down)
                            const pitchAngle = Math.abs(inputStateRef.current.cameraPitch);
                            const maxPitchForClosing = Math.PI / 3; // 60 degrees
                            
                            // Calculate distance multiplier: closer when looking up/down, normal when looking straight
                            const pitchFactor = Math.min(pitchAngle / maxPitchForClosing, 1.0); // Clamp to 0-1
                            const minDistanceMultiplier = 0.3; // Camera gets 30% closer at max pitch
                            const distanceMultiplier = 1.0 - (pitchFactor * (1.0 - minDistanceMultiplier));
                            
                            // Apply dynamic distance to the base third-person offset
                            const dynamicOffset = thirdPersonOffset.clone().multiplyScalar(distanceMultiplier);
                            
                            // Calculate camera offset based on character's yaw rotation (not pitch)
                            tempCameraPos.copy(dynamicOffset);
                            const characterYawQuat = new THREE.Quaternion();
                            characterYawQuat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), inputStateRef.current.characterYaw);
                            tempCameraPos.applyQuaternion(characterYawQuat);
                            tempCameraPos.add(characterPos);
                            
                            // NEW: Improved camera interpolation with exponential decay
                            const cameraDistance = cameraRef.current.position.distanceTo(tempCameraPos);
                            let cameraInterpSpeed = 0.08; // Base camera interpolation speed
                            
                            // Dynamic camera speed based on distance
                            if (cameraDistance > 2.0) {
                                cameraInterpSpeed = 0.3; // Faster for large distances
                            } else if (cameraDistance > 0.5) {
                                cameraInterpSpeed = 0.15; // Medium for moderate distances
                            }
                            
                            // Smooth camera positioning with exponential decay
                            const deltaTime = frameTime / 1000;
                            const cameraDecay = Math.exp(-cameraInterpSpeed * 60 * deltaTime);
                            cameraRef.current.position.lerp(tempCameraPos, 1 - cameraDecay);
                            
                            // RESTORED: This lookAt call is essential for the third-person camera.
                            // It orients the camera to look in the player's aiming direction.
                            const lookDirection = new THREE.Vector3(0, 0, 1);
                            const fullLookQuat = new THREE.Quaternion(
                                inputStateRef.current.lookQuat.x,
                                inputStateRef.current.lookQuat.y,
                                inputStateRef.current.lookQuat.z,
                                inputStateRef.current.lookQuat.w
                            );
                            lookDirection.applyQuaternion(fullLookQuat);
                            
                            tempLookAt.copy(cameraRef.current.position).add(lookDirection.multiplyScalar(10));
                            cameraRef.current.lookAt(tempLookAt);
                        } else {
                            // First-person camera: Responsive positioning
                            if (localState && localState.position) {
                                const serverConstants = getServerConstants();
                                const eyeLevelHeight = 1.6 * serverConstants.CHARACTER_VISUAL_SCALE;
                                const targetCameraPos = new THREE.Vector3(
                                    localState.position.x,
                                    localState.position.y + eyeLevelHeight,
                                    localState.position.z
                                );
                                
                                // NEW: Smooth first-person camera positioning
                                const fpvCameraDistance = cameraRef.current.position.distanceTo(targetCameraPos);
                                let fpvInterpSpeed = 0.12; // Base FPV interpolation speed
                                
                                // Dynamic speed based on distance
                                if (fpvCameraDistance > 1.5) {
                                    fpvInterpSpeed = 0.5; // Fast catch-up
                                } else if (fpvCameraDistance > 0.3) {
                                    fpvInterpSpeed = 0.25; // Medium speed
                                }
                                
                                // Smooth FPV camera positioning with exponential decay
                                const deltaTime = frameTime / 1000;
                                const fpvDecay = Math.exp(-fpvInterpSpeed * 60 * deltaTime);
                                cameraRef.current.position.lerp(targetCameraPos, 1 - fpvDecay);
                            }
                        }
                    } else {
                        // Orbital mode is active - DO NOTHING here, let DebugControls handle it completely.
                        // Prevent any game logic from updating camera position or rotation.
                    }

                    // Render Scene
                    if (rendererRef.current && sceneRef.current && cameraRef.current) {
                        // >>> MODIFIED: Only one render call needed <<<
                        rendererRef.current.render(sceneRef.current, cameraRef.current);

                        // NEW: Add the FPV overlay render call
                        if (isFirstPerson && fpvElementsRef.current.camera) {
                            rendererRef.current.autoClear = false;
                            rendererRef.current.clearDepth();
                            // Render the scene with the FPV camera to draw the weapon model on top
                            rendererRef.current.render(sceneRef.current, fpvElementsRef.current.camera);
                            rendererRef.current.autoClear = true;
                        }
                    }

                    if (!localPlayerRef.current.mesh) {
                    }
                    if (!localPlayerRef.current.rapierBody) {
                    }
                    if (!localState) {
                    } else if (localState.state !== 'alive') {
                    }
                    if (localPlayerRef.current.mesh && localPlayerRef.current.rapierBody) {
                    }
                };
                
                renderLoopIdRef.current = requestAnimationFrame(render); // Use ref

                // --- Socket.IO Connection ---
                const connectToServer = () => {
                    if (!isMounted || socketRef.current?.connected) return; // Check the ref

                    // Clear previous socket instance if retrying
                    if (socketRef.current) {
                        socketRef.current.disconnect();
                        socketRef.current = null;
                    }

                    const newSocket = io(`ws://${serverIp}:${serverPort}`, {
                        reconnection: false, 
                        timeout: 5000,
                    });
                    socketRef.current = newSocket; // Assign to the ref

                    newSocket.on('connect', () => {
                        if (!isMounted) return;
                        console.log('🔌 Socket connected successfully!');
                        setConnectionStatus('connected');
                        setRetryAttempt(0);
                        if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);

                        // Send identification
                        console.log(`📤 Sending identification: userId=${localPlayerUserId}, matchId=${matchId}`);
                        newSocket.emit(MessageTypeFPS.IDENTIFY_PLAYER, { userId: localPlayerUserId, matchId: matchId });

                        // NEW: Listen for game constants from server
                        newSocket.on(MessageTypeFPS.GAME_CONSTANTS_FPS, (constants) => {
                            console.log('📋 [CLIENT] Received game constants from server:', constants);
                            serverConstantsRef.current = constants;
                            // Constants are now available for physics calculations
                        });

                        // Setup listeners
                        newSocket.on(MessageTypeFPS.GAME_STATE_FPS, (gameState) => {
                            // NEW: Log detailed server state for local player
                            const serverPlayerState = gameState.players?.[localPlayerUserId];
                            if (serverPlayerState) {
                                console.log(`📊 [Game State] Local player at: ${serverPlayerState.position?.x?.toFixed(2)}, ${serverPlayerState.position?.y?.toFixed(2)}, ${serverPlayerState.position?.z?.toFixed(2)}`);
                                console.log(`📊 [Game State] Local player state: ${serverPlayerState.state}`);
                            } else {
                                console.log(`❌ [Game State] No local player state found for userId: ${localPlayerUserId}`);
                            }
                            
                            // Debug: Log all players in game state
                            if (gameState.players) {
                                console.log(`📊 [Game State] Players in state:`, Object.keys(gameState.players));
                                for (const [userId, playerState] of Object.entries(gameState.players)) {
                                    console.log(`📊 [Game State] Player ${userId}: state=${playerState.state}, pos=${playerState.position?.x?.toFixed(2)},${playerState.position?.y?.toFixed(2)},${playerState.position?.z?.toFixed(2)}`);
                                }
                            } else {
                                console.log(`❌ [Game State] No players object in game state`);
                            }
                            
                            if (!isMounted) return;

                            // FIXED: Improved server reconciliation with reduced jitter
                            if (serverPlayerState && localPlayerRef.current.rapierBody) {
                                const serverPos = serverPlayerState.position;
                                const clientPos = localPlayerRef.current.rapierBody.translation();
                                
                                // Calculate position difference
                                const posDiff = Math.sqrt(
                                    Math.pow(serverPos.x - clientPos.x, 2) +
                                    Math.pow(serverPos.y - clientPos.y, 2) +
                                    Math.pow(serverPos.z - clientPos.z, 2)
                                );
                                
                                // Only apply correction if difference is significant AND not oscillating
                                const now = performance.now();
                                const timeSinceLastCorrection = now - reconciliationStateRef.current.lastCorrectionTime;
                                
                                // NEW: More responsive correction thresholds for smaller scale
                                const correctionThreshold = 0.2; // A bit larger than player height
                                const minTimeBetweenCorrections = 200; // Allow more frequent, smaller corrections
                                const deadbandZone = 0.05; // A bit larger than player radius
                                const largeErrorThreshold = 0.5; // For major desyncs
                                
                                // Check if player is actively moving (avoid corrections during active input)
                                const isMoving = inputStateRef.current.keys.W || inputStateRef.current.keys.A || 
                                               inputStateRef.current.keys.S || inputStateRef.current.keys.D;
                                
                                // NEW: More conservative correction system with velocity consideration
                                const velocity = localPlayerRef.current.rapierBody.linvel();
                                const isMovingFast = Math.sqrt(velocity.x**2 + velocity.z**2) > 1.0;
                                
                                // Three-tier correction system:
                                // 1. No corrections during fast movement (prevents ping-pong)
                                // 2. Small corrections only when stationary and enough time has passed
                                // 3. Large corrections only for major desyncs
                                const shouldCorrect = !isMovingFast && (
                                    (posDiff > largeErrorThreshold) || 
                                    (posDiff > correctionThreshold && !isMoving && timeSinceLastCorrection > minTimeBetweenCorrections)
                                );
                                
                                if (shouldCorrect && posDiff > deadbandZone) {
                                    console.log(`🔧 [CLIENT] Server correction applied. Diff: ${posDiff.toFixed(3)}`);
                                    
                                    // NEW: Much gentler correction strengths
                                    let correctionStrength;
                                    if (posDiff > largeErrorThreshold) {
                                        correctionStrength = 0.15; // REDUCED from 0.3 - very gentle even for large errors
                                    } else {
                                        correctionStrength = 0.03; // REDUCED from 0.05 - extremely gentle for small errors
                                    }
                                    
                                    // NEW: Exponential decay correction based on time
                                    const maxCorrectionTime = 2.0; // seconds
                                    const correctionTime = Math.min(timeSinceLastCorrection / 1000, maxCorrectionTime) / maxCorrectionTime;
                                    correctionStrength *= correctionTime; // Stronger corrections over time
                                    
                                    const correctedPos = {
                                        x: clientPos.x + (serverPos.x - clientPos.x) * correctionStrength,
                                        y: clientPos.y + (serverPos.y - clientPos.y) * correctionStrength,
                                        z: clientPos.z + (serverPos.z - clientPos.z) * correctionStrength
                                    };
                                    
                                    // Apply the correction to the physics body
                                    localPlayerRef.current.rapierBody.setTranslation(correctedPos, true);
                                    
                                    // Update reconciliation tracking
                                    reconciliationStateRef.current.lastCorrectionTime = now;
                                    reconciliationStateRef.current.totalCorrections++;
                                    
                                    const correctionType = posDiff > largeErrorThreshold ? "MAJOR" : "minor";
                                    console.log(`🔧 [CLIENT] Applied ${correctionType} correction (${(correctionStrength * 100).toFixed(1)}%) to: (${correctedPos.x.toFixed(2)}, ${correctedPos.y.toFixed(2)}, ${correctedPos.z.toFixed(2)})`);
                                } else if (posDiff > deadbandZone) {
                                    let reason = "unknown";
                                    if (isMovingFast) reason = "moving too fast";
                                    else if (isMoving) reason = "player moving";
                                    else if (timeSinceLastCorrection <= minTimeBetweenCorrections) reason = `too soon (${timeSinceLastCorrection.toFixed(0)}ms ago)`;
                                    console.log(`🔧 [CLIENT] Correction suppressed - ${reason}, diff: ${posDiff.toFixed(3)}`);
                                }
                                
                                // Clean up acknowledged inputs
                                if (serverPlayerState.lastProcessedSequence !== undefined) {
                                    const lastProcessedSequence = serverPlayerState.lastProcessedSequence;
                                    inputStateRef.current.pendingInputs = inputStateRef.current.pendingInputs.filter(
                                        input => input.sequence > lastProcessedSequence
                                    );
                                }
                            }

                            // Always update the overall game state for rendering remote players, HUD, etc.
                            gameStateRef.current = gameState;
                            setGameStateVersion(v => v + 1); // Trigger UI updates if needed
                        });
                        // Add other listeners...
                        newSocket.on(MessageTypeFPS.SHOT_FIRED_VISUAL_FPS, (shotData) => {
                            console.log(`🎆 [CLIENT] Received SHOT_FIRED_VISUAL_FPS:`, shotData);
                            if (!isMounted) return;
                        
                            // DEBUG: Check if start and end are the same
                            const distance = Math.sqrt(
                                Math.pow(shotData.endPosition.x - shotData.startPosition.x, 2) +
                                Math.pow(shotData.endPosition.y - shotData.startPosition.y, 2) +
                                Math.pow(shotData.endPosition.z - shotData.startPosition.z, 2)
                            );
                            console.log(`🎆 [CLIENT] Shot distance: ${distance.toFixed(3)}`);
                            console.log(`🎆 [CLIENT] Hit result:`, shotData.hitResult);
                            
                            // Check if this shot hit something
                            const didHit = shotData.hitResult?.hit || false;
                            const hitType = shotData.hitResult?.userData?.type || 'unknown';
                            
                            if (didHit) {
                                console.log(`🎯 [CLIENT] Shot HIT: ${hitType} at distance ${shotData.hitResult.distance.toFixed(3)}`);
                            } else {
                                console.log(`🎯 [CLIENT] Shot MISSED: No collision detected`);
                            }
                            
                            // DEBUG: Log pool status
                            console.log(`🎆 [CLIENT] Debug ray pool size: ${debugRayLinesRef.current.length}`);
                            
                            // --- Create Debug Ray Line ---
                            if (debugRayLinesRef.current.length > 0) {
                                const rayLine = debugRayLinesRef.current.pop();
                                const startPoint = new THREE.Vector3(shotData.startPosition.x, shotData.startPosition.y, shotData.startPosition.z);
                                const endPoint = new THREE.Vector3(shotData.endPosition.x, shotData.endPosition.y, shotData.endPosition.z);
                                
                                // Update the line geometry
                                const positions = new Float32Array([
                                    startPoint.x, startPoint.y, startPoint.z,
                                    endPoint.x, endPoint.y, endPoint.z
                                ]);
                                rayLine.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
                                rayLine.geometry.computeBoundingSphere(); // Important for proper rendering
                                rayLine.geometry.attributes.position.needsUpdate = true; // Force update
                                
                                // Change color based on hit type with more vibrant colors
                                if (didHit && hitType === 'playerBody') {
                                    rayLine.material.color.setHex(0xff0000); // Bright red for player hits
                                } else if (didHit) {
                                    rayLine.material.color.setHex(0xffff00); // Bright yellow for wall/ground hits
                                } else {
                                    rayLine.material.color.setHex(0x00ff00); // Bright green for misses
                                }
                                
                                // Force material update
                                rayLine.material.needsUpdate = true;
                                
                                // Make the line always visible on top
                                rayLine.material.depthTest = false;
                                rayLine.material.depthWrite = false;
                                rayLine.renderOrder = 1000;
                                rayLine.visible = true;
                                
                                console.log(`🎆 [CLIENT] Created debug ray line from (${startPoint.x.toFixed(2)}, ${startPoint.y.toFixed(2)}, ${startPoint.z.toFixed(2)}) to (${endPoint.x.toFixed(2)}, ${endPoint.y.toFixed(2)}, ${endPoint.z.toFixed(2)})`);
                                console.log(`🎆 [CLIENT] Ray line color: ${rayLine.material.color.getHexString()}, visible: ${rayLine.visible}`);
                                
                                // Hide the ray line after 5 seconds (increased from 3)
                                setTimeout(() => {
                                    rayLine.visible = false;
                                    rayLine.material.color.setHex(0x00ff00); // Reset to green
                                    rayLine.material.depthTest = true; // Reset depth test
                                    rayLine.material.depthWrite = false; // Keep depth write off
                                    rayLine.renderOrder = 0; // Reset render order
                                    debugRayLinesRef.current.push(rayLine);
                                    console.log(`🎆 [CLIENT] Ray line hidden and returned to pool. Pool size: ${debugRayLinesRef.current.length}`);
                                }, 5000); // Increased visibility time
                            } else {
                                console.warn("🎆 [CLIENT] No available ray lines in the pool to display shot visual!");
                            }
                            
                            // --- ALTERNATIVE: Create Sphere Markers at Start and End Points ---
                            // This helps debug if the ray lines are not visible
                            const startMarkerGeometry = new THREE.SphereGeometry(0.1, 8, 8);
                            const startMarkerMaterial = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
                            const startMarker = new THREE.Mesh(startMarkerGeometry, startMarkerMaterial);
                            startMarker.position.set(shotData.startPosition.x, shotData.startPosition.y, shotData.startPosition.z);
                            sceneRef.current.add(startMarker);
                            
                            const endMarkerGeometry = new THREE.SphereGeometry(0.15, 8, 8);
                            const endMarkerMaterial = new THREE.MeshBasicMaterial({ 
                                color: didHit ? (hitType === 'playerBody' ? 0xff0000 : 0xffff00) : 0x0000ff 
                            });
                            const endMarker = new THREE.Mesh(endMarkerGeometry, endMarkerMaterial);
                            endMarker.position.set(shotData.endPosition.x, shotData.endPosition.y, shotData.endPosition.z);
                            sceneRef.current.add(endMarker);
                            
                            console.log(`🎯 [CLIENT] Created shot markers: Start (${shotData.startPosition.x.toFixed(2)}, ${shotData.startPosition.y.toFixed(2)}, ${shotData.startPosition.z.toFixed(2)}) End (${shotData.endPosition.x.toFixed(2)}, ${shotData.endPosition.y.toFixed(2)}, ${shotData.endPosition.z.toFixed(2)})`);
                            
                            // Remove markers after 5 seconds
                            setTimeout(() => {
                                if (sceneRef.current) {
                                    sceneRef.current.remove(startMarker);
                                    sceneRef.current.remove(endMarker);
                                    startMarkerGeometry.dispose();
                                    startMarkerMaterial.dispose();
                                    endMarkerGeometry.dispose();
                                    endMarkerMaterial.dispose();
                                }
                            }, 5000);
                            
                            // --- Create Visual Projectile ---
                            if (distance > 0.1 && projectilePoolRef.current.length > 0) { // Only create projectile if there's meaningful distance
                                const projectileMesh = projectilePoolRef.current.pop();
                                console.log(`🎆 [CLIENT] Creating visual projectile. Pool size: ${projectilePoolRef.current.length}`);
                                
                                // Set initial position
                                projectileMesh.position.set(shotData.startPosition.x, shotData.startPosition.y, shotData.startPosition.z);
                                projectileMesh.visible = true;
                        
                                // Add to active list for animation in the render loop
                                activeVisualProjectilesRef.current.push({
                                    mesh: projectileMesh,
                                    target: new THREE.Vector3(shotData.endPosition.x, shotData.endPosition.y, shotData.endPosition.z),
                                    speed: 200, // Adjust speed of the visual tracer
                                    startTime: performance.now()
                                });
                                console.log(`🎆 [CLIENT] Active projectiles: ${activeVisualProjectilesRef.current.length}`);
                            } else if (distance <= 0.1) {
                                console.warn(`🎆 [CLIENT] Shot distance too small (${distance.toFixed(3)}), skipping projectile creation`);
                            } else {
                                console.warn("🎆 [CLIENT] No available projectiles in the pool to display shot visual.");
                            }
                        });

                        // NEW: Handle hit confirmation feedback
                        newSocket.on(MessageTypeFPS.HIT_CONFIRMED_FPS, (hitData) => {
                            console.log(`🎯 [CLIENT] Hit confirmed! You hit ${hitData.victimId} at`, hitData.hitPoint);
                            
                            // Create visual hit marker at the hit point
                            if (sceneRef.current && hitData.hitPoint) {
                                const hitMarkerGeometry = new THREE.SphereGeometry(0.1, 8, 8);
                                const hitMarkerMaterial = new THREE.MeshBasicMaterial({ color: 0xff0000 });
                                const hitMarker = new THREE.Mesh(hitMarkerGeometry, hitMarkerMaterial);
                                
                                hitMarker.position.set(
                                    hitData.hitPoint.x,
                                    hitData.hitPoint.y,
                                    hitData.hitPoint.z
                                );
                                
                                sceneRef.current.add(hitMarker);
                                
                                // Remove hit marker after 2 seconds
                                setTimeout(() => {
                                    if (sceneRef.current) {
                                        sceneRef.current.remove(hitMarker);
                                        hitMarkerGeometry.dispose();
                                        hitMarkerMaterial.dispose();
                                    }
                                }, 2000);
                            }
                            
                            // TODO: Add more visual/audio feedback for successful hits
                            // - Flash the crosshair red
                            // - Play hit sound effect
                            // - Show damage numbers floating up
                            // - Add blood splatter effect
                        });

                        // NEW: Handle player death notifications
                        newSocket.on(MessageTypeFPS.PLAYER_DIED_FPS, (deathData) => {
                            console.log(`💀 [CLIENT] Player death: ${deathData.victimId} was killed by ${deathData.killerId}`);
                            
                            if (deathData.victimId === localPlayerUserId) {
                                console.log("💀 [CLIENT] You were killed!");
                                // TODO: Add death screen effects
                                // - Show "You were killed by X" message
                                // - Fade screen to red/gray
                                // - Play death sound
                                // - Switch to spectator camera
                            } else if (deathData.killerId === localPlayerUserId) {
                                console.log("🏆 [CLIENT] You got a kill!");
                                // TODO: Add kill feedback
                                // - Show "You eliminated X" message
                                // - Play kill sound
                                // - Add screen effect
                            } else {
                                console.log(`👀 [CLIENT] ${deathData.killerId} killed ${deathData.victimId}`);
                                // TODO: Add kill feed notification
                            }
                        });

                        newSocket.on('disconnect', (reason) => {
                            if (!isMounted) return;
                            socketRef.current = null; // Clear the ref
                            gameStateRef.current = null;
                            setConnectionStatus('disconnected'); // Set to disconnected first
                            // If disconnect wasn't manual and retries left, schedule retry
                            if (reason !== 'io client disconnect' && retryAttempt < MAX_RETRIES) {
                                setRetryAttempt(prev => prev + 1);
                                const delay = Math.pow(2, retryAttempt) * 1000;
                                setConnectionStatus(`retrying (${retryAttempt + 1}/${MAX_RETRIES}) in ${delay/1000}s`);
                                if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
                                retryTimeoutRef.current = setTimeout(connectToServer, delay);
                            } else if (reason !== 'io client disconnect') {
                                setConnectionStatus('error');
                                console.error('Max retries reached or disconnect not retryable.');
                            }
                        });
                    });

                    newSocket.on('connect_error', (error) => {
                        if (!isMounted) return;
                        console.error('Connection error:', error.message);
                        newSocket.disconnect(); 
                        socketRef.current = null; // Clear the ref
                        if (retryAttempt < MAX_RETRIES) {
                            setRetryAttempt(prev => prev + 1);
                            const delay = Math.pow(2, retryAttempt) * 1000;
                            setConnectionStatus(`retrying (${retryAttempt + 1}/${MAX_RETRIES}) in ${delay/1000}s`);
                            if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
                            retryTimeoutRef.current = setTimeout(connectToServer, delay);
                        } else {
                            console.error('Max connection retries reached.');
                            setConnectionStatus('error');
                        }
                    });
                };

                connectToServer();

                setIsLoading(false);

            } catch (error) { // Catch errors during initGame
                 if (!isMounted) return;
                console.error("Client Initialization Failed:", error);
                setConnectionStatus('error');
                setIsLoading(false);
            }
        }
        // --- End initGame Definition ---

        initGame(); // Call the initialization function

        // --- Cleanup Logic ---
        return () => {
            isMounted = false;
            abortController.abort();

            // Clear retry timer on unmount
            if (retryTimeoutRef.current) {
                clearTimeout(retryTimeoutRef.current);
            }

            // Disconnect socket if it exists in the ref
            if (socketRef.current) {
                socketRef.current.disconnect();
                socketRef.current = null;
            }

            // Cancel render loop
            if(renderLoopIdRef.current) cancelAnimationFrame(renderLoopIdRef.current);

            // >>> NEW: Remove Input Listeners <<<
            document.removeEventListener('keydown', handleKeyDown);
            document.removeEventListener('keyup', handleKeyUp);
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('pointerlockchange', handlePointerLockChange);
            document.removeEventListener('mousedown', handleMouseDown);
            document.removeEventListener('mouseup', handleMouseUp);
            if (document.pointerLockElement === canvasElement) {
                 document.exitPointerLock(); // Release lock on unmount
            }

            // Dispose Three.js resources
            if (rendererRef.current) {
                 sceneRef.current?.traverse(object => {
                      if (object.geometry) object.geometry.dispose();
                      if (object.material) {
                         if (Array.isArray(object.material)) {
                            object.material.forEach(material => material.dispose());
                         } else {
                            object.material.dispose();
                         }
                      }
                 });
                 // Dispose FPV elements (assuming models added to fpvElements.camera)
                 fpvElementsRef.current?.camera?.traverse(object => { // Traverse the FPV camera children
                     if (object.geometry) object.geometry.dispose();
                      if (object.material) {
                         if (Array.isArray(object.material)) {
                            object.material.forEach(material => material.dispose());
                         } else {
                            object.material.dispose();
                         }
                      }
                 });
                // NEW: Dispose projectile pool geometry/material
                if (projectilePoolRef.current.length > 0) {
                    const sampleProjectile = projectilePoolRef.current[0];
                    sampleProjectile.geometry.dispose();
                    sampleProjectile.material.dispose();
                }
                // NEW: Dispose weapon meshes
                if (localPlayerRef.current.weaponMesh) {
                    localPlayerRef.current.weaponMesh.traverse(object => {
                        if (object.geometry) object.geometry.dispose();
                        if (object.material) {
                            if (Array.isArray(object.material)) {
                                object.material.forEach(material => material.dispose());
                            } else {
                                object.material.dispose();
                            }
                        }
                    });
                }
                if (remotePlayerRef.current.weaponMesh) {
                    remotePlayerRef.current.weaponMesh.traverse(object => {
                        if (object.geometry) object.geometry.dispose();
                        if (object.material) {
                            if (Array.isArray(object.material)) {
                                object.material.forEach(material => material.dispose());
                            } else {
                                object.material.dispose();
                            }
                        }
                    });
                }
                rendererRef.current.dispose();
            }
            // OrbitControls disposal removed, handled by DebugControls
        };
    }, [serverIp, serverPort, matchId, mapId, localPlayerCharacterId, opponentPlayerCharacterId, localPlayerUserId]); // Essential props that trigger re-init

    // --- NEW: Prepare props for the HUD ---
    const gameState = gameStateRef.current;
    const localPlayerState = gameState?.players?.[localPlayerUserId] || null;
    const opponentPlayerState = gameState?.players?.[opponentPlayerId] || null;
    
    // DEBUG: Log HUD props to see why it's not rendering
    console.log('🎮 [HUD DEBUG] HUD Props:', {
        hasGameState: !!gameState,
        matchState: gameState?.matchState,
        hasLocalPlayer: !!localPlayerState,
        hasOpponentPlayer: !!opponentPlayerState,
        localPlayerUserId,
        opponentPlayerId,
        gameStateKeys: gameState ? Object.keys(gameState) : 'no gameState'
    });

    // NEW: Client-side prediction state for weapons
    const weaponPredictionRef = useRef({
        isReloading: false,
        reloadStartTime: 0,
        reloadDuration: 0,
        activeWeaponSlot: 0,
        currentAmmoInClip: 0,
        weaponSwitchStartTime: 0,
        weaponSwitchDuration: 250, // Match server delay
        isPredictingSwitch: false,
        lastServerWeaponState: null, // For reconciliation
    });

    return (
        <div style={{ width: '100%', height: '100%', position: 'relative', background: '#222' }}>
            {/* Basic UI Placeholders - Use connectionStatus */}
            {isLoading && <div>Loading Game...</div>}
            {!isLoading && connectionStatus !== 'connected' && <div>Status: {connectionStatus}</div>}
            {/* TODO: Add HUD elements driven by currentGameState */}

            <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%' }} />

            {/* Conditionally render DebugControls */}
            <DebugControls
                isEnabled={isDebugModeEnabled}
                camera={cameraRef.current}
                renderer={rendererRef.current}
                scene={sceneRef.current}
                rapierWorld={rapierWorldRef.current}
            />

            {/* TEMPORARY: Test HUD that always shows */}
            <div style={{
                position: 'absolute',
                top: '10px',
                right: '10px',
                color: 'lime',
                background: 'rgba(0,0,0,0.8)',
                padding: '10px',
                fontFamily: 'monospace',
                zIndex: 1000
            }}>
                🎮 TEST HUD - Connection: {connectionStatus}
            </div>

            {/* NEW: Render the HUD */}
            <HUD
                localPlayer={localPlayerState}
                opponent={opponentPlayerState}
                matchState={gameState?.matchState}
                roundWins={gameState?.roundWins}
                localPlayerUserId={localPlayerUserId}
                opponentPlayerId={opponentPlayerId}
                weaponPredictionState={weaponPredictionRef.current}
            />

            {/* Potential UI Overlays */}
        </div>
    );
}

export default GameViewFPS; 