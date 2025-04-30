import React, { useEffect, useRef, useState, useCallback } from 'react';

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { io, Socket } from 'socket.io-client'; // Import socket.io client and specific Socket type if using TS
// Import GLTFLoader and SkeletonUtils
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
// Assuming shared types and map data are correctly resolved by build/monorepo setup
import { MessageTypeFPS, MapId, CharacterId, MAP_CONFIGS_FPS, CHARACTER_CONFIG_FPS, WEAPON_CONFIG_FPS } from '@shared-types/game-fps';

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
    const socketRef = useRef(null);
    const retryTimeoutRef = useRef(null); // Ref for retry timer
    // NEW: Ref for current animation state - Separate refs for player and FPV
    const currentPlayerActionRef = useRef(null);
    const currentFpvActionRef = useRef(null); // Ref for currently playing FPV animation

    // State for loading/connection status
    const [isLoading, setIsLoading] = useState(true);
    // Provide more detailed statuses
    const [connectionStatus, setConnectionStatus] = useState('disconnected'); // 'connecting', 'connected', 'error', 'retrying', 'disconnected'
    const [retryAttempt, setRetryAttempt] = useState(0); // Track retry attempts
    // NEW: State for camera view mode (Plan 2.1.3)
    const [isThirdPersonView, setIsThirdPersonView] = useState(false); // Default to First Person
    // NEW: Add state to hold the merged game state received from server (Plan 1.1.2)
    const [currentGameState, setCurrentGameState] = useState(null);

    // Max retries
    const MAX_RETRIES = 5;

    // >>> NEW: Ref for Input State <<< Plan 2.2.1 / 2.2.2
    const inputStateRef = useRef({
        keys: { W: false, A: false, S: false, D: false, Space: false, Shift: false, /* NEW Action Keys */ C: false, Ability1: false, GrenadeFrag: false, GrenadeSemtex: false, GrenadeFlash: false, Reload: false, Interact: false, GrappleFire: false, WeaponSwitch: false },
        lookQuat: { x: 0, y: 0, z: 0, w: 1 },
        sequence: 0, // Input sequence number
        pendingInputs: [], // Store inputs applied client-side but not yet ack'd by server
    });
    const lastInputSendTimeRef = useRef(0);
    const INPUT_SEND_INTERVAL = 1000 / 30; // Send input ~30 times/sec

    // Effect for initialization and cleanup
    useEffect(() => {
        console.log(`GameViewFPS Mounting for match: ${matchId}`);
        const canvasElement = canvasRef.current;
        if (!canvasElement) return;

        // --- StrictMode Guard --- Prevent multiple initializations
        if (socketRef.current) {
            console.log("Socket already exists, skipping initialization (StrictMode re-mount?).");
            return; // Don't re-initialize if socket exists
        }
        // --- End StrictMode Guard ---

        const abortController = new AbortController();
        let isMounted = true; // Flag to check if component is still mounted in async operations

        // Refs for game objects (moved outside initGame)
        let renderer, scene, camera, rapierWorld, renderLoopId;
        let localPlayer = { mesh: null, rapierBody: null, mixer: null };
        let remotePlayer = { mesh: null, mixer: null };
        // MODIFIED: Updated fpvElements structure
        let fpvElements = {
            camera: null,
            weaponModels: {}, // { weaponId: { model: THREE.Group, mixer: THREE.AnimationMixer, animations: { animName: THREE.AnimationClip } } }
            grappleRopeMaterial: null,
        };
        let playerAnimationActions = {}; // Store shared player animations

        // >>> NEW: Move Input Handlers outside initGame <<< Plan 2.2.1 / 2.2.2
        const handleKeyDown = (event) => {
            // Map event.code to inputState keys (more robust than event.key)
            switch (event.code) {
                case 'KeyW': inputStateRef.current.keys.W = true; break;
                case 'KeyA': inputStateRef.current.keys.A = true; break;
                case 'KeyS': inputStateRef.current.keys.S = true; break;
                case 'KeyD': inputStateRef.current.keys.D = true; break;
                case 'Space': inputStateRef.current.keys.Space = true; break;
                case 'ShiftLeft': inputStateRef.current.keys.Shift = true; break;
                // NEW: Toggle Camera Key
                case 'KeyC': inputStateRef.current.keys.C = true; break;
                // Add other keys later (Ability, Grenade, Reload, etc.)
            }
        };
        const handleKeyUp = (event) => {
            switch (event.code) {
                case 'KeyW': inputStateRef.current.keys.W = false; break;
                case 'KeyA': inputStateRef.current.keys.A = false; break;
                case 'KeyS': inputStateRef.current.keys.S = false; break;
                case 'KeyD': inputStateRef.current.keys.D = false; break;
                case 'Space': inputStateRef.current.keys.Space = false; break;
                case 'ShiftLeft': inputStateRef.current.keys.Shift = false; break;
                // NEW: Toggle Camera Key Release
                case 'KeyC':
                    if (inputStateRef.current.keys.C) { // Process toggle on key up
                         setIsThirdPersonView(prev => !prev);
                         console.log('Toggled view. isThirdPerson:', !isThirdPersonView);
                    }
                    inputStateRef.current.keys.C = false; break;
                // Add other keys later
            }
        };

        const handleMouseMove = (event) => {
            // Need camera defined before use - ensure initGame runs first or check existence
            if (!document.pointerLockElement || !camera) return;

            const movementX = event.movementX || 0;
            const movementY = event.movementY || 0;
            const sensitivity = 0.002;

            const euler = new THREE.Euler(0, 0, 0, 'YXZ');
            euler.setFromQuaternion(camera.quaternion);
            euler.y -= movementX * sensitivity;
            euler.x -= movementY * sensitivity;
            euler.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, euler.x));
            camera.quaternion.setFromEuler(euler);

            // Update lookQuat in input state
            inputStateRef.current.lookQuat.x = camera.quaternion.x;
            inputStateRef.current.lookQuat.y = camera.quaternion.y;
            inputStateRef.current.lookQuat.z = camera.quaternion.z;
            inputStateRef.current.lookQuat.w = camera.quaternion.w;
        };

        const handlePointerLockChange = () => {
            if (document.pointerLockElement === canvasElement) {
                console.log('Pointer Locked');
            } else {
                console.log('Pointer Unlocked');
            }
        };
        // >>> End Moved Input Handlers <<<

        // --- Animation Helper (Modified for FPV Target) ---
        const playFpvAnimation = (weaponId, actionName, loop = true) => {
            const weaponData = fpvElements.weaponModels[weaponId];
            if (!weaponData || !weaponData.mixer || !weaponData.animations || !weaponData.animations[actionName]) {
                // console.warn(`FPV Animation '${actionName}' not found for weapon '${weaponId}' or mixer invalid.`);
                return null; // Return null if action not found or invalid
            }

            const mixer = weaponData.mixer;
            const newAction = mixer.clipAction(weaponData.animations[actionName]);
            const previousAction = currentFpvActionRef.current; // Use dedicated ref for FPV

            if (previousAction !== newAction) {
                // console.log(`[FPV Anim] Playing '${actionName}' for ${weaponId}`); // Debug log
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
                console.log('Initializing Three.js, Rapier...');
                setIsLoading(true);
                setConnectionStatus('initializing');

                // --- Access Config based on Props ---
                const mapConfig = MAP_CONFIGS_FPS[mapId];
                const localCharConfig = CHARACTER_CONFIG_FPS[localPlayerCharacterId];
                const remoteCharConfig = CHARACTER_CONFIG_FPS[opponentPlayerCharacterId];
                if (!mapConfig || !localCharConfig || !remoteCharConfig) {
                    throw new Error("Missing required map or character config on client!");
                }
                console.log("Configuration accessed."); // Log progress

                // --- Asset Loaders ---
                const loader = new GLTFLoader();
                const textureLoader = new THREE.TextureLoader(); // For potential texture variations
                console.log("Loaders created."); // Log progress

                // --- Three.js Core Setup ---
                renderer = new THREE.WebGLRenderer({ canvas: canvasElement, antialias: true });
                renderer.setSize(canvasElement.clientWidth, canvasElement.clientHeight);
                renderer.setPixelRatio(window.devicePixelRatio);
                renderer.shadowMap.enabled = true;
                scene = new THREE.Scene();
                scene.background = new THREE.Color(0x6699cc); // Example sky blue
                camera = new THREE.PerspectiveCamera(75, canvasElement.clientWidth / canvasElement.clientHeight, 0.1, 1000);
                camera.position.set(0, 1.6, 5); // Initial placeholder position
                scene.add(camera);
                // >>> MODIFIED: Adjust FPV camera position <<<
                fpvElements.camera = new THREE.PerspectiveCamera(60, canvasElement.clientWidth / canvasElement.clientHeight, 0.01, 100);
                // Don't set FPV camera position here, it will follow main camera
                // fpvElements.camera.position.set(0, -1.6, 5);
                camera.add(fpvElements.camera); // Attach FPV camera to main camera
                const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
                scene.add(ambientLight);
                const directionalLight = new THREE.DirectionalLight(0xffffff, 1.0);
                directionalLight.position.set(10, 15, 5);
                directionalLight.castShadow = true; // Enable shadows
                scene.add(directionalLight);
                console.log("Three.js core setup complete."); // Log progress

                // --- Load Map Visuals (NEW) ---
                console.log(`Loading visual map: ${mapConfig.visualAssetPath}`);
                const mapGltf = await loader.loadAsync(mapConfig.visualAssetPath);
                const mapMesh = mapGltf.scene;
                mapMesh.traverse(node => { // Enable shadows on map objects
                    if (node.isMesh) {
                        node.castShadow = true;
                        node.receiveShadow = true;
                    }
                });
                scene.add(mapMesh);
                console.log(`Map ${mapId} visuals loaded.`);

                // --- Load Character Models ---
                // REVERTING to previous logic which seems correct based on user feedback
                console.log("Loading character models...");
                const localModelPath = localCharConfig.modelPath;
                const remoteModelPath = remoteCharConfig.modelPath;
                console.log(`Local model: ${localModelPath}, Remote model: ${remoteModelPath}`);

                let localCharacterGltf, remoteCharacterGltf;
                try {
                    [localCharacterGltf, remoteCharacterGltf] = await Promise.all([
                        loader.loadAsync(localModelPath),
                        loader.loadAsync(remoteModelPath)
                    ]);
                } catch (error) {
                    console.error("Failed to load character models:", error);
                    throw error;
                }

                localPlayer.mesh = localCharacterGltf.scene;
                remotePlayer.mesh = remoteCharacterGltf.scene;

                playerAnimationActions = {};
                localCharacterGltf.animations.forEach(clip => {
                    playerAnimationActions[clip.name] = clip;
                });

                localPlayer.mesh.traverse(node => { if (node.isMesh) node.castShadow = true; });
                remotePlayer.mesh.traverse(node => { if (node.isMesh) node.castShadow = true; });
                scene.add(localPlayer.mesh);
                scene.add(remotePlayer.mesh);
                localPlayer.mesh.visible = false;
                remotePlayer.mesh.visible = false;

                localPlayer.mixer = new THREE.AnimationMixer(localPlayer.mesh);
                remotePlayer.mixer = new THREE.AnimationMixer(remotePlayer.mesh);
                console.log("Character models loaded and mixers created.");

                // --- Load FPV Arms/Weapons (NEW - logic from 2.1.2 adapted) ---
                console.log("Loading FPV assets...");
                fpvElements.weaponModels = {}; // Reset before loading

                for (const weaponId in WEAPON_CONFIG_FPS) {
                    const weaponConfig = WEAPON_CONFIG_FPS[weaponId];
                    if (!weaponConfig || !weaponConfig.fpvModelPath) {
                        console.warn(`Skipping FPV model for ${weaponId}: Missing config or fpvModelPath.`);
                        continue;
                    }
                    const modelPath = weaponConfig.fpvModelPath;
                    console.log(`Attempting to load FPV model for ${weaponId} from ${modelPath}`);
                    try {
                        const fpvGltf = await loader.loadAsync(modelPath);
                        if (!isMounted) return; // Check mount status after await

                        const weaponGroup = fpvGltf.scene;
                        const weaponAnimations = {};
                        // Store animations found in this model
                        if (fpvGltf.animations && fpvGltf.animations.length > 0) {
                            // console.log(`Animations found for FPV model '${weaponId}' (${modelPath}):`);
                            fpvGltf.animations.forEach(clip => {
                                // console.log(`- ${clip.name}`);
                                weaponAnimations[clip.name] = clip; // Store clip by name
                            });
                        } else {
                            // console.log(`No animations found for FPV model '${weaponId}' (${modelPath}).`);
                        }

                        weaponGroup.traverse(node => {
                            if (node.isMesh) {
                                node.frustumCulled = false;
                                node.renderOrder = 10; // Ensure FPV renders on top
                            }
                        });

                        // Create mixer for this weapon model
                        const weaponMixer = new THREE.AnimationMixer(weaponGroup);

                        // Store model, mixer, and animations together
                        fpvElements.weaponModels[weaponId] = {
                            model: weaponGroup,
                            mixer: weaponMixer,
                            animations: weaponAnimations,
                        };

                        fpvElements.camera.add(weaponGroup); // Add to FPV camera

                        // Set the actual FPV weapon position
                        weaponGroup.position.set(0.12, -0.18, -0.01); // Default FPV: Right, Down, Close
                        weaponGroup.scale.set(.37, .37, .37);
                        weaponGroup.rotation.set(0, Math.PI, 0);

                        weaponGroup.visible = false; // Hide initially

                        console.log(`Successfully loaded and setup FPV group for ${weaponId}`);

                    } catch (e) {
                         console.error(`FPV model '${modelPath}' failed to load or process:`, e);
                    }
                }
                console.log("Finished loading FPV assets."); // Log completion

                // --- Load Grapple Visuals ---
                fpvElements.grappleRopeMaterial = new THREE.LineBasicMaterial({ color: 0xffffff, linewidth: 2 });
                console.log("Grapple visuals placeholder ready."); // Log progress

                // --- Rapier Setup ---
                console.log('Initializing Client Rapier...');
                await RAPIER.init();
                if (!isMounted) return; // Check after await
                rapierWorld = new RAPIER.World({ x: 0.0, y: -9.81, z: 0.0 });
                console.log('Client Rapier World created.'); // Log progress

                // --- Load Map Physics ---
                console.log(`Loading Client Physics for Map ID: ${mapId}...`);
                const clientPhysicsData = mapConfig.physicsData;
                if (clientPhysicsData.colliders) {
                    clientPhysicsData.colliders.forEach(colliderData => {
                        let colliderDesc;
                        if (colliderData.type === 'cuboid') {
                            colliderDesc = RAPIER.ColliderDesc.cuboid(colliderData.dimensions.x / 2, colliderData.dimensions.y / 2, colliderData.dimensions.z / 2);
                        } // Add other types if needed
                        if (colliderDesc) {
                            colliderDesc.setTranslation(colliderData.position.x, colliderData.position.y, colliderData.position.z);
                            // Set groups, friction, etc. - ENSURE THESE MATCH SERVER
                            // colliderDesc.setCollisionGroups(...)
                            rapierWorld.createCollider(colliderDesc);
                        }
                    });
                    console.log(`Created ${clientPhysicsData.colliders.length} client map colliders.`);
                } // Add trimesh loading if used
                console.log('Client Map Physics Loaded.'); // Log progress

                // --- Resize Handling ---
                const handleResize = () => {
                    if (!renderer || !camera || !canvasElement) return;
                    const width = canvasElement.clientWidth;
                    const height = canvasElement.clientHeight;
                    renderer.setSize(width, height);
                    camera.aspect = width / height;
                    camera.updateProjectionMatrix();
                    // FPV camera uses main camera aspect ratio
                };
                window.addEventListener('resize', handleResize, { signal: abortController.signal });
                handleResize(); // Initial size calculation
                console.log("Resize handler set."); // Log progress

                // >>> MODIFIED: Add Input Listeners (handlers defined outside now) <<<
                document.addEventListener('keydown', handleKeyDown, { signal: abortController.signal });
                document.addEventListener('keyup', handleKeyUp, { signal: abortController.signal });
                document.addEventListener('mousemove', handleMouseMove, { signal: abortController.signal });

                // --- Setup Pointer Lock Listener (ASAP for FPS input) ---
                if (canvasElement) { // Ensure canvasElement exists
                    // Attach pointer lock error handler once
                    document.addEventListener('pointerlockerror', (event) => {
                        console.error('Pointer lock failed', event);
                    }, { once: true });

                    const pointerLockClickListener = () => {
                        if (!document.pointerLockElement) {
                            if (typeof canvasElement.requestPointerLock === 'function') {
                                canvasElement.requestPointerLock(); // No .catch(), synchronous in most browsers
                            } else {
                                console.error('Error: canvasElement.requestPointerLock is not a function!');
                            }
                        }
                    };
                    canvasElement.addEventListener('click', pointerLockClickListener, { signal: abortController.signal });
                    console.log("Pointer Lock click listener attached (early for FPS input).");
                } else {
                    console.error("Canvas element not found at pointer lock setup!");
                }

                // --- Render Loop ---
                let lastTimestamp = performance.now();
                const clock = new THREE.Clock(); // Use Clock for mixer updates
                const thirdPersonOffset = new THREE.Vector3(0, 2, -4); // Camera offset behind player
                const tempPlayerPos = new THREE.Vector3(); // Temporary vectors for calculations
                const tempCameraPos = new THREE.Vector3();
                const tempLookAt = new THREE.Vector3();

                const render = (timestamp) => {
                    if (!isMounted) return;
                    renderLoopId = requestAnimationFrame(render);

                    const deltaTime = Math.min(0.05, (timestamp - lastTimestamp) / 1000); // Clamp delta time
                    const mixerDeltaTime = clock.getDelta(); // Use clock delta for mixers
                    lastTimestamp = timestamp;

                    // Get Local Player State
                    const localState = currentGameState?.players?.[localPlayerUserId];

                    // >>> NEW: Send Input State Periodically <<<
                    const now = performance.now();
                    if (socketRef.current?.connected && now - lastInputSendTimeRef.current > INPUT_SEND_INTERVAL) {
                        inputStateRef.current.sequence++; // Increment sequence number
                        const payload = {
                            sequence: inputStateRef.current.sequence,
                            deltaTime: deltaTime, // Include frame delta time
                            keys: { ...inputStateRef.current.keys },
                            lookQuat: { ...inputStateRef.current.lookQuat }
                        };
                        socketRef.current.emit(MessageTypeFPS.PLAYER_INPUT_FPS, payload);
                        lastInputSendTimeRef.current = now;
                        // TODO: Store pendingInputs (Phase 2.3.1)
                    }
                    // >>> End Send Input State <<<

                    // --- Physics Simulation --- (NEW - Step 2.2.1 Client Prediction)
                    // 1. Apply Local Input Prediction (Before stepping world)
                    if (localPlayer.rapierBody && localState && localState.state === 'alive') {
                        const playerBody = localPlayer.rapierBody;
                        const currentKeys = inputStateRef.current.keys;
                        const currentLookQuat = camera.quaternion; // Use current camera view

                        // Mirror server-side force calculation constants
                        const walkSpeed = 5.0;
                        const runSpeed = 8.0;
                        const jumpImpulse = 7.0;
                        const accelerationForce = 2000.0; // Should match server
                        const maxAccelForce = 50.0; // Should match server

                        let desiredVelocity = new THREE.Vector3(0, 0, 0);
                        let moveDirection = new THREE.Vector3(0, 0, 0);
                        let isMoving = false;

                        // Calculate forward/right vectors based on camera quaternion
                        const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(currentLookQuat); //.normalize(); // Normalization might happen below
                        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(currentLookQuat); //.normalize();
                        forward.y = 0; // Project onto ground plane
                        right.y = 0;
                        forward.normalize();
                        right.normalize();

                        if (currentKeys.W) { moveDirection.add(forward); isMoving = true; }
                        if (currentKeys.S) { moveDirection.sub(forward); isMoving = true; }
                        if (currentKeys.A) { moveDirection.sub(right); isMoving = true; }
                        if (currentKeys.D) { moveDirection.add(right); isMoving = true; }

                        if (isMoving) {
                            moveDirection.normalize();
                            const targetSpeed = currentKeys.Shift ? runSpeed : walkSpeed;
                            desiredVelocity.x = moveDirection.x * targetSpeed;
                            desiredVelocity.z = moveDirection.z * targetSpeed;
                        }

                        // Apply force based on velocity difference
                        const currentLinvel = playerBody.linvel(); // Get current velocity from Rapier body
                        let force = new THREE.Vector3(0, 0, 0);
                        const velocityDiffX = desiredVelocity.x - currentLinvel.x;
                        const velocityDiffZ = desiredVelocity.z - currentLinvel.z;

                        force.x = velocityDiffX * accelerationForce * deltaTime;
                        force.z = velocityDiffZ * accelerationForce * deltaTime;

                        // Clamp force
                        const forceMagnitude = Math.sqrt(force.x * force.x + force.z * force.z);
                        if (forceMagnitude > maxAccelForce) {
                            const scale = maxAccelForce / forceMagnitude;
                            force.x *= scale;
                            force.z *= scale;
                        }
                        playerBody.applyImpulse({ x: force.x, y: 0, z: force.z }, true);

                        // Jumping Prediction
                        // TODO: Client-side ground check needed here too for accurate prediction
                        const isOnGround = true; // Placeholder
                        if (currentKeys.Space && isOnGround /* && !wasJumpingLastFrame */) {
                            playerBody.applyImpulse({ x: 0, y: jumpImpulse, z: 0 }, true);
                            // TODO: Add jump input flag/timer to prevent spamming impulse
                        }
                    }

                    // 2. Step Client Physics World
                    if (rapierWorld) {
                        rapierWorld.step();
                    }
                    // --- End Physics Simulation ---

                    // --- Update Player Mixers ---
                    localPlayer.mixer?.update(mixerDeltaTime);
                    remotePlayer.mixer?.update(mixerDeltaTime);

                    // --- Update FPV Mixers & Animation ---
                    let activeWeaponId = null;
                    let activeFpvMixer = null;
                    if (localState && localState.weaponSlots && localState.activeWeaponSlot !== undefined) {
                        activeWeaponId = localState.weaponSlots[localState.activeWeaponSlot];
                        const activeWeaponData = fpvElements.weaponModels[activeWeaponId];
                        if (activeWeaponData?.mixer) {
                            activeFpvMixer = activeWeaponData.mixer;
                            activeFpvMixer.update(mixerDeltaTime); // Update the active FPV mixer

                            // --- Determine and Play FPV Animation ---
                            const keys = inputStateRef.current.keys;
                            const isMoving = keys.W || keys.A || keys.S || keys.D;
                            const isRunning = isMoving && keys.Shift; // Check Shift key for running

                            let targetAnimation = 'Rig|KDW_DPose_Idle'; // Default to Idle

                            if (isRunning) {
                                targetAnimation = 'Rig|KDW_Run';
                            } else if (isMoving) {
                                targetAnimation = 'Rig|KDW_Walk';
                            }
                            // TODO: Add conditions for Reload, Fire, Switch Weapon animations later

                            playFpvAnimation(activeWeaponId, targetAnimation, true); // Play the determined animation (looping)

                        }
                    }

                    // --- Update FPV Weapon Visibility ---
                    for (const weaponId in fpvElements.weaponModels) {
                        const weaponData = fpvElements.weaponModels[weaponId];
                        if (weaponData?.model) {
                            // Show only the active weapon model
                            weaponData.model.visible = (weaponId === activeWeaponId);
                            // Removed per-frame FPV weapon position log for performance
                        }
                    }

                    // --- Update Player Mesh Visibility & Position (Placeholder) ---
                    if (localPlayer.mesh) {
                        localPlayer.mesh.visible = isThirdPersonView;
                        // NEW: Update mesh from predicted Rapier body state
                        if (localPlayer.rapierBody) {
                            const predictedPos = localPlayer.rapierBody.translation();
                            const predictedRot = localPlayer.rapierBody.rotation(); // Rapier returns {x,y,z,w}
                            localPlayer.mesh.position.set(predictedPos.x, predictedPos.y, predictedPos.z);
                            // Don't directly set mesh rotation from body if using third person lookAt
                            if (!isThirdPersonView) {
                                // In first person, mesh (usually hidden) should match body rotation
                                localPlayer.mesh.quaternion.set(predictedRot.x, predictedRot.y, predictedRot.z, predictedRot.w);
                            }
                        } else if (localState && localState.position && localState.rotation) {
                            // Fallback to lerping server state if body missing (e.g., before spawn)
                            localPlayer.mesh.position.lerp(localState.position, 0.3);
                            localPlayer.mesh.quaternion.slerp(localState.rotation, 0.3);
                        }
                    }
                    if (remotePlayer.mesh) {
                         const remoteState = currentGameState?.players?.[opponentPlayerId];
                         if (remoteState && remoteState.position && remoteState.rotation) {
                            remotePlayer.mesh.visible = true; // Show remote player always
                            remotePlayer.mesh.position.lerp(remoteState.position, 0.3);
                            remotePlayer.mesh.quaternion.slerp(remoteState.rotation, 0.3);
                        } else {
                            remotePlayer.mesh.visible = false;
                         }
                    }

                    // --- Update Camera Position ---
                    if (isThirdPersonView && localPlayer.mesh) {
                        tempCameraPos.copy(thirdPersonOffset);
                        tempCameraPos.applyQuaternion(localPlayer.mesh.quaternion);
                        tempCameraPos.add(localPlayer.mesh.position);
                        // TODO: Camera collision check
                        camera.position.lerp(tempCameraPos, 0.1);
                        tempLookAt.copy(localPlayer.mesh.position).add(new THREE.Vector3(0, 1.0, 0));
                        camera.lookAt(tempLookAt);
                    } else {
                        // First Person: Camera rotation driven by mouse. Position follows player state.
                        if (localState && localState.position) {
                             // Directly set camera position based on player state + eye height offset
                             camera.position.set(localState.position.x, localState.position.y + 1.7, localState.position.z);
                        }
                    }

                    // Render Scene
                    if (renderer && scene && camera) {
                        renderer.render(scene, camera);
                        // No separate FPV render needed
                    }
                };
                console.log("Starting render loop...");
                renderLoopId = requestAnimationFrame(render); // Start the loop

                // --- Socket.IO Connection --- (Refined Retry Logic)
                const connectToServer = () => {
                    if (!isMounted || socketRef.current?.connected || connectionStatus === 'connecting') return; // Prevent multiple concurrent attempts

                    console.log(`Attempting connection (Attempt: ${retryAttempt + 1})...`);
                    setConnectionStatus('connecting');

                    // Clear previous socket instance if retrying
                    if (socketRef.current) {
                        socketRef.current.disconnect();
                        socketRef.current = null;
                    }

                    const newSocket = io(`ws://${serverIp}:${serverPort}`, {
                        reconnection: false, // Manual retry
                        timeout: 5000,
                        // query: { matchId, userId: localPlayerUserId } // Send identification info if server needs it on connect
                    });
                    socketRef.current = newSocket;

                    newSocket.on('connect', () => {
                        if (!isMounted) return;
                        console.log('Successfully connected. Socket ID:', newSocket.id);
                        setConnectionStatus('connected');
                        setRetryAttempt(0);
                        if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);

                        // Send identification
                        console.log(`Sending IDENTIFY_PLAYER with userId: ${localPlayerUserId}`);
                        newSocket.emit(MessageTypeFPS.IDENTIFY_PLAYER, { userId: localPlayerUserId });

                        // Setup listeners
                        newSocket.on(MessageTypeFPS.GAME_STATE_FPS, (gameState) => {
                            if (!isMounted) return;
                            setCurrentGameState(prevState => ({ ...(prevState || {}), ...gameState }));
                        });
                        // Add other listeners...

                        newSocket.on('disconnect', (reason) => {
                            if (!isMounted) return;
                            console.log('Disconnected. Reason:', reason);
                            socketRef.current = null;
                            setCurrentGameState(null);
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
                        newSocket.disconnect(); // Clean up failed socket
                        socketRef.current = null;
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

                connectToServer(); // Initial connection attempt

                console.log('Client Init Game Systems Placeholder Complete.');
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
            console.log('GameViewFPS Unmounting, cleaning up...');
            isMounted = false;
            abortController.abort();

            // Clear retry timer on unmount
            if (retryTimeoutRef.current) {
                clearTimeout(retryTimeoutRef.current);
            }

            // Disconnect socket if it exists
            if (socketRef.current) {
                 console.log(`Disconnecting socket ${socketRef.current.id} on unmount.`);
                socketRef.current.disconnect();
                socketRef.current = null; // Clear the ref
            }

            // Cancel render loop
            if(renderLoopId) cancelAnimationFrame(renderLoopId);

            // >>> NEW: Remove Input Listeners <<<
            document.removeEventListener('keydown', handleKeyDown);
            document.removeEventListener('keyup', handleKeyUp);
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('pointerlockchange', handlePointerLockChange);
            if (document.pointerLockElement === canvasElement) {
                 document.exitPointerLock(); // Release lock on unmount
            }

            // Dispose Three.js resources
            if (renderer) {
                 scene?.traverse(object => {
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
                 fpvElements?.camera?.traverse(object => { // Traverse the FPV camera children
                     if (object.geometry) object.geometry.dispose();
                      if (object.material) {
                         if (Array.isArray(object.material)) {
                            object.material.forEach(material => material.dispose());
                         } else {
                            object.material.dispose();
                         }
                      }
                 });
                renderer.dispose();
            }
            console.log("Client Cleanup Complete.");
        };
    }, [serverIp, serverPort, matchId, mapId, localPlayerCharacterId, opponentPlayerCharacterId, localPlayerUserId]); // Essential props that trigger re-init

    return (
        <div style={{ width: '100%', height: '100%', position: 'relative', background: '#222' }}>
            {/* Basic UI Placeholders - Use connectionStatus */}
            {isLoading && <div>Loading Game...</div>}
            {!isLoading && connectionStatus !== 'connected' && <div>Status: {connectionStatus}</div>}
            {/* TODO: Add HUD elements driven by currentGameState */}

            <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%' }} />

            {/* Potential UI Overlays */}
        </div>
    );
}

export default GameViewFPS; 