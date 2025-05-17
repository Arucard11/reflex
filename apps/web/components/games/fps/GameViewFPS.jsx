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
    interactionGroups
} from '@shared-types/game-fps';
import DebugControls from './DebugControls'; // Import DebugControls

// NEW: Player Physics Dimensions Constants (must match server)
const PLAYER_VISUAL_TOTAL_HEIGHT = 0.9; // New smaller height for visual alignment
const PLAYER_VISUAL_RADIUS = 0.2;       // New smaller radius (used for client physics body)

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
    const gameStateRef = useRef(null);
    const [gameStateVersion, setGameStateVersion] = useState(0); // Only for UI updates

    // --- Refs for Three.js/Rapier objects ---
    const cameraRef = useRef(null);
    const rendererRef = useRef(null);
    const sceneRef = useRef(null);
    const rapierWorldRef = useRef(null);
    const localPlayerRef = useRef({ mesh: null, rapierBody: null, mixer: null });
    const remotePlayerRef = useRef({ mesh: null, mixer: null });
    const fpvElementsRef = useRef({ camera: null, weaponModels: {}, grappleRopeMaterial: null });
    const playerAnimationActionsRef = useRef({});
    const renderLoopIdRef = useRef(null); // Ref for render loop ID

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
        keys: { W: false, A: false, S: false, D: false, Space: false, Shift: false, Ability1: false, GrenadeFrag: false, GrenadeSemtex: false, GrenadeFlash: false, Reload: false, Interact: false, GrappleFire: false, WeaponSwitch: false },
        lookQuat: { x: 0, y: 0, z: 0, w: 1 },
        sequence: 0,
        pendingInputs: [],
        isAiming: false, // NEW: Track right mouse button state
    });
    const lastInputSendTimeRef = useRef(0);
    const INPUT_SEND_INTERVAL = 1000 / 30;

    // Use the existing cameraModeRef for all camera state:
    const cameraModeRef = useRef({
        isThirdPerson: true,
        isOrbital: false
    });



    // --- Client-Side Prediction & Movement Engine ---
    const applyInputPhysics = useCallback((playerBody, inputKeys, inputLookQuat, physicsDeltaTime) => {
        if (!playerBody || physicsDeltaTime <= 0) return;
        const walkSpeed = 5.0;
        const runSpeed = 8.0;
        const jumpImpulse = 7.0;
        const accelerationForce = 2000.0;
        const maxAccelForce = 50.0;
        const airControlFactor = 0.2;
        let desiredVelocity = new THREE.Vector3(0, 0, 0);
        let moveDirection = new THREE.Vector3(0, 0, 0);
        let isMoving = false;
        const _lookQuat = new THREE.Quaternion(inputLookQuat.x, inputLookQuat.y, inputLookQuat.z, inputLookQuat.w);
        const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(_lookQuat);
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(_lookQuat);
        forward.y = 0; right.y = 0; forward.normalize(); right.normalize();
        if (inputKeys.W) { moveDirection.add(forward); isMoving = true; }
        if (inputKeys.S) { moveDirection.sub(forward); isMoving = true; }
        if (inputKeys.A) { moveDirection.sub(right); isMoving = true; }
        if (inputKeys.D) { moveDirection.add(right); isMoving = true; }
        if (isMoving) {
            moveDirection.normalize();
            const targetSpeed = inputKeys.Shift ? runSpeed : walkSpeed;
            desiredVelocity.x = moveDirection.x * targetSpeed;
            desiredVelocity.z = moveDirection.z * targetSpeed;
        }
        const currentLinvel = playerBody.linvel();
        let force = new THREE.Vector3(0, 0, 0);
        const velocityDiffX = desiredVelocity.x - currentLinvel.x;
        const velocityDiffZ = desiredVelocity.z - currentLinvel.z;
        force.x = velocityDiffX * accelerationForce * physicsDeltaTime;
        force.z = velocityDiffZ * accelerationForce * physicsDeltaTime;
        // TODO: Air control factor application needs ground check state
        // const isOnGround = true; // Placeholder
        // if (!isOnGround) { force.x *= airControlFactor; force.z *= airControlFactor; }
        const forceMagnitude = force.length();
        if (forceMagnitude > maxAccelForce) force.multiplyScalar(maxAccelForce / forceMagnitude);
        playerBody.applyImpulse({ x: force.x, y: 0, z: force.z }, true);
        // Jumping
        // const isOnGround = true; // Placeholder
        if (inputKeys.Space /* && isOnGround */) {
            playerBody.applyImpulse({ x: 0, y: jumpImpulse, z: 0 }, true);
        }
        // Grapple Gun Physics (if active) -- placeholder for client prediction
        // ...
    }, []);

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

        // Use refs directly instead of local variables
        // let renderer, scene, camera, rapierWorld, renderLoopId;
        // let localPlayer = { mesh: null, rapierBody: null, mixer: null };
        // let remotePlayer = { mesh: null, mixer: null };
        // let fpvElements = { camera: null, weaponModels: {}, grappleRopeMaterial: null };
        // let playerAnimationActions = {};

        // >>> NEW: Move Input Handlers outside initGame <<< Plan 2.2.1 / 2.2.2
        const handleKeyDown = (event) => {
            console.log(`[DEBUG] KeyDown: code=${event.code}, key=${event.key}`);

            // --- Handle Debug Toggle Key ('B') - Use State ---
            if (event.code === 'KeyB') {
                event.preventDefault(); // Prevent browser 'b' input

                // Decide the *next* state for the ref
                const nextIsEnabled = !isDebugModeEnabled;

                if (nextIsEnabled) {
                    // If ENABLING debug mode, exit pointer lock FIRST
                    console.log('Requesting exit from pointer lock...');
                    document.exitPointerLock();
                } else {
                    // If DISABLING debug mode, request pointer lock (requires user click)
                    console.log('Debug mode disabled. Click canvas to re-lock pointer.');
                    // canvasRef.current?.requestPointerLock(); // Don't force it here
                }

                // Now update the ref AFTER handling pointer lock
                // Update State (triggers re-render and prop update)
                setIsDebugModeEnabled(nextIsEnabled);
                // Keep ref in sync for internal logic
                cameraModeRef.current.isOrbital = nextIsEnabled;
                console.log(`Debug mode toggled via state: ${nextIsEnabled}.`);

                return; // Stop processing other keys if 'B' was pressed
            }
            // --- End Debug Toggle Key ---

            // Prevent browser default actions for game keys *if pointer is locked*
            if (document.pointerLockElement && [
                'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'KeyC'
                // Add other game action keys here that might have browser defaults
            ].includes(event.code)) {
                event.preventDefault();
            }

            // Map event.code to inputState keys (only when pointer locked)
            if (document.pointerLockElement) {
                switch (event.code) {
                    case 'KeyW': inputStateRef.current.keys.W = true; break;
                    case 'KeyA': inputStateRef.current.keys.A = true; break;
                    case 'KeyS': inputStateRef.current.keys.S = true; break;
                    case 'KeyD': inputStateRef.current.keys.D = true; break;
                    case 'Space': inputStateRef.current.keys.Space = true; break;
                    case 'ShiftLeft': inputStateRef.current.keys.Shift = true; break;
                    case 'KeyC': inputStateRef.current.keys.C = true; break; // Camera toggle still needs lock
                    // Add other game action keys here...
                }
            }
        };
        const handleKeyUp = (event) => {
            console.log(`[DEBUG] KeyUp: code=${event.code}, key=${event.key}`);

            // Only process game key releases if pointer was locked during release
            // or if the key being released is the debug key itself.
            if (document.pointerLockElement || event.code === 'KeyB') {
                switch (event.code) {
                    case 'KeyW': inputStateRef.current.keys.W = false; break;
                    case 'KeyA': inputStateRef.current.keys.A = false; break;
                    case 'KeyS': inputStateRef.current.keys.S = false; break;
                    case 'KeyD': inputStateRef.current.keys.D = false; break;
                    case 'Space': inputStateRef.current.keys.Space = false; break;
                    case 'ShiftLeft': inputStateRef.current.keys.Shift = false; break;
                    // Camera toggle on KeyUp only if it was pressed down
                    case 'KeyC':
                        if (inputStateRef.current.keys.C) {
                            cameraModeRef.current.isThirdPerson = !cameraModeRef.current.isThirdPerson;
                        }
                        inputStateRef.current.keys.C = false; break;
                    // Add other keys later
                }
            }
        };

        const handleMouseMove = (event) => {
            // NEW: Log entry into the handler
            console.log('handleMouseMove fired.');
            // NEW: Log pointer lock status
            console.log('Pointer Lock Element:', document.pointerLockElement);

            // Need camera defined before use - ensure initGame runs first or check existence
            if (!document.pointerLockElement || !cameraRef.current) return;

            const movementX = event.movementX || 0;
            const movementY = event.movementY || 0;
            const sensitivity = 0.002;

            const euler = new THREE.Euler(0, 0, 0, 'YXZ');
            euler.setFromQuaternion(cameraRef.current.quaternion);
            euler.y -= movementX * sensitivity;
            euler.x -= movementY * sensitivity;
            euler.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, euler.x));
            cameraRef.current.quaternion.setFromEuler(euler);

            // Update lookQuat in input state
            inputStateRef.current.lookQuat.x = cameraRef.current.quaternion.x;
            inputStateRef.current.lookQuat.y = cameraRef.current.quaternion.y;
            inputStateRef.current.lookQuat.z = cameraRef.current.quaternion.z;
            inputStateRef.current.lookQuat.w = cameraRef.current.quaternion.w;
        };

        const handlePointerLockChange = () => {
            // NEW: Log pointer lock changes
            if (document.pointerLockElement === canvasElement) {
                console.log('Pointer Locked (handlePointerLockChange)');
            } else {
                console.log('Pointer Unlocked (handlePointerLockChange)');
            }
        };

        // NEW: Mouse Down/Up for Aiming
        const handleMouseDown = (event) => {
            if (event.button === 2) { // Right mouse button
                inputStateRef.current.isAiming = true;
            }
        };
        const handleMouseUp = (event) => {
            if (event.button === 2) {
                inputStateRef.current.isAiming = false;
            }
        };
        // >>> End Moved Input Handlers <<<

        // --- Animation Helper (Modified for FPV Target) ---
        const playFpvAnimation = (weaponId, actionName, loop = true) => {
            // Access FPV elements via ref
            const weaponData = fpvElementsRef.current.weaponModels[weaponId];
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

                // >>> ADD CONSOLE LOGS HERE <<<
                console.log('[GameViewFPS Props] mapId:', mapId);
                console.log('[GameViewFPS Props] localPlayerCharacterId:', localPlayerCharacterId);
                console.log('[GameViewFPS Props] opponentPlayerCharacterId:', opponentPlayerCharacterId);
                console.log('[GameViewFPS Available Configs] MAP_CONFIGS_FPS:', MAP_CONFIGS_FPS);
                console.log('[GameViewFPS Available Configs] CHARACTER_CONFIG_FPS:', CHARACTER_CONFIG_FPS);

                setIsLoading(true);
                setConnectionStatus('initializing');

                // --- Access Config based on Props ---
                const mapConfig = MAP_CONFIGS_FPS[mapId];
                const localCharConfig = CHARACTER_CONFIG_FPS[localPlayerCharacterId];
                const remoteCharConfig = CHARACTER_CONFIG_FPS[opponentPlayerCharacterId];
                if (!mapConfig || !localCharConfig || !remoteCharConfig) {
                    throw new Error("Missing required map or character config on client!");
                }
                const localCharacterVisualYOffset = localCharConfig.visualYOffset || 0.0;
                // We'll get the remote character's visualYOffset later when we have gameState

                console.log("Configuration accessed."); // Log progress

                // --- Asset Loaders ---
                const loader = new GLTFLoader();
                
                console.log("Loaders created."); // Log progress

                // --- Three.js Core Setup ---
                // Assign to refs
                rendererRef.current = new THREE.WebGLRenderer({ canvas: canvasElement, antialias: true });
                rendererRef.current.setSize(canvasElement.clientWidth, canvasElement.clientHeight);
                rendererRef.current.setPixelRatio(window.devicePixelRatio);
                rendererRef.current.shadowMap.enabled = true;

                sceneRef.current = new THREE.Scene();
                sceneRef.current.background = new THREE.Color(0x6699cc); // Example sky blue

                cameraRef.current = new THREE.PerspectiveCamera(75, canvasElement.clientWidth / canvasElement.clientHeight, 0.1, 1000);
                cameraRef.current.position.set(0, 1.6, 5); // Initial placeholder position
                sceneRef.current.add(cameraRef.current);

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
                sceneRef.current.add(mapMesh); // Add to scene via ref
                console.log(`Map ${mapId} visuals loaded.`);

                // --- Load Character Models ---
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

                // Assign to refs
                localPlayerRef.current.mesh = localCharacterGltf.scene;
                remotePlayerRef.current.mesh = remoteCharacterGltf.scene;

                // Log all animation names for the local character model
                if (localCharacterGltf.animations && localCharacterGltf.animations.length > 0) {
                    console.log('Character Model Animations:');
                    localCharacterGltf.animations.forEach((clip, idx) => {
                        console.log(`  [${idx}] ${clip.name}`);
                    });
                } else {
                    console.warn('No animations found in the loaded character model!');
                }

                playerAnimationActionsRef.current = {}; // Use ref
                localCharacterGltf.animations.forEach(clip => {
                    playerAnimationActionsRef.current[clip.name] = clip; // Assign to ref
                });

                localPlayerRef.current.mesh.traverse(node => { if (node.isMesh) node.castShadow = true; });
                remotePlayerRef.current.mesh.traverse(node => { if (node.isMesh) node.castShadow = true; });
                sceneRef.current.add(localPlayerRef.current.mesh); // Add to scene via ref
                sceneRef.current.add(remotePlayerRef.current.mesh); // Add to scene via ref
                localPlayerRef.current.mesh.visible = false;
                remotePlayerRef.current.mesh.visible = false;

                // Assign to refs
                localPlayerRef.current.mixer = new THREE.AnimationMixer(localPlayerRef.current.mesh);
                remotePlayerRef.current.mixer = new THREE.AnimationMixer(remotePlayerRef.current.mesh);
                console.log("Character models loaded and mixers created.");

                // ... after loading localPlayer.mesh and remotePlayer.mesh, before adding to scene ...
                localPlayerRef.current.mesh.scale.set(0.3, 0.3, 0.3); // DEBUG: Reduce character size
                remotePlayerRef.current.mesh.scale.set(0.3, 0.3, 0.3); // DEBUG: Reduce character size
                console.log('[DEBUG] Character model scale set to (0.3, 0.3, 0.3)');

                // --- Load FPV Arms/Weapons (NEW - logic from 2.1.2 adapted) ---
                console.log("Loading FPV assets...");
                fpvElementsRef.current.weaponModels = {}; // Reset via ref

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

                        // Store model, mixer, and animations together in ref
                        fpvElementsRef.current.weaponModels[weaponId] = {
                            model: weaponGroup,
                            mixer: weaponMixer,
                            animations: weaponAnimations,
                        };

                        fpvElementsRef.current.camera.add(weaponGroup); // Add to FPV camera via ref

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
                // Assign to ref
                fpvElementsRef.current.grappleRopeMaterial = new THREE.LineBasicMaterial({ color: 0xffffff, linewidth: 2 });
                console.log("Grapple visuals placeholder ready."); // Log progress

                // --- Rapier Setup ---
                console.log('Initializing Client Rapier...');
                await RAPIER.init();
                if (!isMounted) return; // Check after await
                // Assign to ref
                rapierWorldRef.current = new RAPIER.World({ x: 0.0, y: -9.81, z: 0.0 });
                console.log('Client Rapier World created.'); // Log progress

                // --- Load Map Physics (Client - Mirroring server 1.2.2) ---
                console.log(`Loading Client Physics for Map ID: ${mapId}...`);
                const clientMapConfig = MAP_CONFIGS_FPS[mapId]; // Use a different variable name
                if (!clientMapConfig || !clientMapConfig.physicsData) {
                    console.warn(`Client: No physicsData found for map ${mapId}.`);
                } else {
                    const clientPhysicsData = clientMapConfig.physicsData;
                    console.log("Client: Found Physics Data:", JSON.stringify(clientPhysicsData, null, 2)); // Log physics data

                    // --- Only support Trimesh Loading ---
                    if (clientPhysicsData.vertices && clientPhysicsData.vertices.length > 0 && clientPhysicsData.indices && clientPhysicsData.indices.length > 0) {
                        console.log(`[Client Physics Load] Attempting to load TR MESH...`);
                        try {
                            const rigidBodyDesc = RAPIER.RigidBodyDesc.fixed();
                            const body = rapierWorldRef.current.createRigidBody(rigidBodyDesc);
                            const trimeshDesc = RAPIER.ColliderDesc.trimesh(clientPhysicsData.vertices, clientPhysicsData.indices);
                            console.log(`[Client Physics Load] TrimeshDesc created.`);
                            // IMPORTANT: Set Collision Groups - MUST MATCH SERVER
                            const groups = interactionGroups(
                                CollisionGroup.WORLD,
                                [CollisionGroup.PLAYER_BODY, CollisionGroup.GRENADE, CollisionGroup.PROJECTILE]
                            );
                            trimeshDesc.setCollisionGroups(groups);
                            console.log(`[Client Physics Load] Trimesh Set collision groups to:`, groups);
                            // Use rapierWorldRef
                            const collider = rapierWorldRef.current.createCollider(trimeshDesc, body);
                            console.log(`[Client Physics Load] SUCCESS: Created client trimesh map collider handle: ${collider.handle}`);
                        } catch (error) {
                            console.error(`[Client Physics Load] ERROR: Failed to create client trimesh collider for map ${mapId}:`, error);
                            // No fallback to primitives
                        }
                    } else {
                        console.error(`[Client Physics Load] No valid trimesh data found for map ${mapId}. Physics loading failed.`);
                    }
                }
                console.log('Client Map Physics Loading Attempt Complete.');

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
                console.log("Resize handler set."); // Log progress

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
                        // >>> ADDED LOG <<<
                        console.error('[PointerLock] Error acquiring pointer lock:', event);
                    }, { once: true });

                    const pointerLockClickListener = () => {
                        // Only request pointer lock if NOT in debug/orbital mode
                        if (!isDebugModeEnabled && !document.pointerLockElement) {
                            // >>> ADDED LOG <<<
                            console.log('[PointerLock] Attempting to request pointer lock...');
                            if (typeof canvasElement.requestPointerLock === 'function') {
                                canvasElement.requestPointerLock(); // No .catch(), synchronous in most browsers
                                cameraModeRef.current.isOrbital = false; // <<< Disable debug when locking pointer
                                // >>> ADDED LOG <<<
                                console.log('[PointerLock] requestPointerLock() called.');
                            } else {
                                console.error('[PointerLock] Error: canvasElement.requestPointerLock is not a function!');
                            }
                        } else if (isDebugModeEnabled) {
                            console.log('[PointerLock] Debug mode active, not requesting pointer lock.');
                        } else {
                            // >>> ADDED LOG <<<
                            console.log('[PointerLock] Pointer already locked.');
                        }
                    };
                    canvasElement.addEventListener('click', pointerLockClickListener, { signal: abortController.signal });
                    console.log("[PointerLock] Click listener attached.");
                } else {
                    console.error("[PointerLock] Canvas element not found at pointer lock setup!");
                }

                // --- Render Loop ---
                let lastTimestamp = performance.now();
                const clock = new THREE.Clock(); // Use Clock for mixer updates
                const thirdPersonOffset = new THREE.Vector3(0, 2, -2); // Camera offset behind player (changed from -4 to -2)
                const tempPlayerPos = new THREE.Vector3(); // Temporary vectors for calculations
                const tempCameraPos = new THREE.Vector3();
                const tempLookAt = new THREE.Vector3();

                const render = (timestamp) => {
                    if (!isMounted) return;
                    renderLoopIdRef.current = requestAnimationFrame(render);

                    const deltaTime = Math.min(0.05, (timestamp - lastTimestamp) / 1000); // Clamp delta time
                    const mixerDeltaTime = clock.getDelta(); // Use clock delta for mixers
                    lastTimestamp = timestamp;

                    // Get Local Player State
                    const localState = gameStateRef.current?.players?.[localPlayerUserId];

                    // >>> NEW: Send Input State Periodically <<<
                    const now = performance.now();
                    if (socketRef.current?.connected && now - lastInputSendTimeRef.current > INPUT_SEND_INTERVAL) {
                        inputStateRef.current.sequence++; // Increment sequence number
                        // Ensure all relevant keys are included in the payload
                        const payload = {
                            sequence: inputStateRef.current.sequence,
                            deltaTime: deltaTime, // Include frame delta time
                            keys: { ...inputStateRef.current.keys }, // Send current key state
                            lookQuat: { ...inputStateRef.current.lookQuat }
                        };
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

                    // --- Physics Simulation --- (NEW - Step 2.2.1 Client Prediction)
                    // 1. Apply Local Input Prediction (Before stepping world)
                    if (localPlayerRef.current.rapierBody && localState && localState.state === 'alive') {
                        // >>> ADDED LOG <<<
                        console.log(`[Predict] Applying input: W=${inputStateRef.current.keys.W} | Body Vel: ${localPlayerRef.current.rapierBody.linvel().x.toFixed(2)},${localPlayerRef.current.rapierBody.linvel().y.toFixed(2)},${localPlayerRef.current.rapierBody.linvel().z.toFixed(2)}`);
                        // Apply physics using the helper function
                        applyInputPhysics(localPlayerRef.current.rapierBody, inputStateRef.current.keys, inputStateRef.current.lookQuat, deltaTime);
                    }

                    // 2. Step Client Physics World
                    if (rapierWorldRef.current) {
                        rapierWorldRef.current.step();
                        // >>> ADDED LOG <<<
                        if (localPlayerRef.current.rapierBody) {
                             console.log(`[Predict] After Step: Body Pos: ${localPlayerRef.current.rapierBody.translation().x.toFixed(2)},${localPlayerRef.current.rapierBody.translation().y.toFixed(2)},${localPlayerRef.current.rapierBody.translation().z.toFixed(2)}`);
                        }
                    }
                    // --- End Physics Simulation ---

                    // --- Update Player Mixers ---
                    localPlayerRef.current.mixer?.update(mixerDeltaTime);
                    remotePlayerRef.current.mixer?.update(mixerDeltaTime);

                    // --- Character Animation Logic (Movement Animations) ---
                    if (localPlayerRef.current.mixer && playerAnimationActionsRef.current) {
                        const keys = inputStateRef.current.keys;
                        let targetAnim = null;

                        if (keys.W && keys.Shift) {
                            targetAnim = 'rifle run forward';
                        } else if (keys.W) {
                            targetAnim = 'walk';
                        } else if (keys.S) {
                            targetAnim = 'walking backwards';
                        } else if (keys.A) {
                            targetAnim = 'strafe left';
                        } else if (keys.D) {
                            targetAnim = 'strafe right';
                        } else {
                            targetAnim = 'idle';
                        }

                        // Optionally, override with aim idle if aiming
                        // if (inputStateRef.current.isAiming && playerAnimationActionsRef.current['aim idle']) {
                        //     targetAnim = 'aim idle';
                        // }

                        const mixer = localPlayerRef.current.mixer;
                        const actions = playerAnimationActionsRef.current;
                        const newAction = actions[targetAnim] ? mixer.clipAction(actions[targetAnim]) : null;
                        const prevAction = currentPlayerActionRef.current;

                        if (newAction && prevAction !== newAction) {
                            if (prevAction) {
                                prevAction.fadeOut(0.2);
                            }
                            newAction.reset().setEffectiveTimeScale(1).setEffectiveWeight(1).fadeIn(0.2).play();
                            newAction.loop = THREE.LoopRepeat;
                            currentPlayerActionRef.current = newAction;
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

                    // --- Update Player Mesh Visibility & Position (Placeholder) ---
                    if (localPlayerRef.current.mesh) {
                        localPlayerRef.current.mesh.visible = cameraModeRef.current.isThirdPerson;
                        // NEW: Update mesh from predicted Rapier body state
                        if (localPlayerRef.current.rapierBody) {
                            const totalCapsuleHalfHeightForVisuals = PLAYER_VISUAL_TOTAL_HEIGHT / 2;

                            const predictedPos = localPlayerRef.current.rapierBody.translation(); 
                            const predictedRot = localPlayerRef.current.rapierBody.rotation(); 
                            
                            localPlayerRef.current.mesh.position.set(
                                predictedPos.x,
                                predictedPos.y - totalCapsuleHalfHeightForVisuals + localCharacterVisualYOffset, 
                                predictedPos.z
                            );
                            
                            if (!cameraModeRef.current.isThirdPerson) {
                                localPlayerRef.current.mesh.quaternion.set(predictedRot.x, predictedRot.y, predictedRot.z, predictedRot.w);
                            } else {
                                const bodyQuaternion = new THREE.Quaternion(predictedRot.x, predictedRot.y, predictedRot.z, predictedRot.w);
                                const euler = new THREE.Euler().setFromQuaternion(bodyQuaternion, 'YXZ');
                                localPlayerRef.current.mesh.rotation.y = euler.y; 
                            }
                        } else if (localState && localState.position && localState.rotation) {
                            // Fallback to lerping server state if body missing (e.g., before spawn)
                            localPlayerRef.current.mesh.position.lerp(localState.position, 0.3);
                            localPlayerRef.current.mesh.quaternion.slerp(localState.rotation, 0.3);
                        }
                    }
                    if (remotePlayerRef.current.mesh) {
                         const remoteState = gameStateRef.current?.players?.[opponentPlayerId];
                         if (remoteState && remoteState.position && remoteState.rotation) {
                            remotePlayerRef.current.mesh.visible = true; 
                            const totalCapsuleHalfHeightForVisuals = PLAYER_VISUAL_TOTAL_HEIGHT / 2;
                            
                            const opponentActualCharId = remoteState.characterId; // Get the opponent's actual characterId from gameState
                            const opponentCharConfig = CHARACTER_CONFIG_FPS[opponentActualCharId];
                            const remoteCharacterVisualYOffset = opponentCharConfig?.visualYOffset || 0.0;

                            const targetPosition = new THREE.Vector3(
                                remoteState.position.x,
                                remoteState.position.y - totalCapsuleHalfHeightForVisuals + remoteCharacterVisualYOffset, 
                                remoteState.position.z
                            );
                            remotePlayerRef.current.mesh.position.lerp(targetPosition, 0.3); 
                            
                            const remoteQuaternion = new THREE.Quaternion(remoteState.rotation.x, remoteState.rotation.y, remoteState.rotation.z, remoteState.rotation.w);
                            remotePlayerRef.current.mesh.quaternion.slerp(remoteQuaternion, 0.3);
                        } else {
                            remotePlayerRef.current.mesh.visible = false;
                         }
                    }

                    // --- Camera Controls Setup ---
                    // OrbitControls logic removed, handled by DebugControls

                    // --- Update Camera Position ---
                    // ONLY update camera based on game state if Orbital mode is OFF
                    if (!cameraModeRef.current.isOrbital) {
                        if (cameraModeRef.current.isThirdPerson && localPlayerRef.current.mesh) {
                            // Third-person camera logic
                            tempCameraPos.copy(thirdPersonOffset);
                            tempCameraPos.applyQuaternion(localPlayerRef.current.mesh.quaternion);
                            tempCameraPos.add(localPlayerRef.current.mesh.position);
                            cameraRef.current.position.lerp(tempCameraPos, 0.1);
                            tempLookAt.copy(localPlayerRef.current.mesh.position).add(new THREE.Vector3(0, 1.0, 0));
                            cameraRef.current.lookAt(tempLookAt);
                        } else {
                            // First-person camera logic (Look handled by mousemove, position follows predicted body)
                             if (localPlayerRef.current.rapierBody) {
                                 const predictedPos = localPlayerRef.current.rapierBody.translation();
                                cameraRef.current.position.set(
                                    predictedPos.x,
                                    predictedPos.y + 1.6, // FPV camera height offset
                                    predictedPos.z
                                );
                             } else if (localState && localState.position) {
                                 // Fallback if body not ready
                                cameraRef.current.position.set(
                                    localState.position.x,
                                    localState.position.y + 1.6,
                                    localState.position.z
                                );
                            }
                             // Note: First-person camera rotation is directly handled by handleMouseMove
                        }
                    } else {
                        // Orbital mode is active - DO NOTHING here, let DebugControls handle it completely.
                        // Prevent any game logic from updating camera position or rotation.
                        console.log('[Debug Mode] Orbital camera active, game camera updates disabled.');
                    }

                    // Render Scene
                    if (rendererRef.current && sceneRef.current && cameraRef.current) {
                        // >>> MODIFIED: Only one render call needed <<<
                        rendererRef.current.render(sceneRef.current, cameraRef.current);
                    }

                    if (!localPlayerRef.current.mesh) {
                        console.warn('[DEBUG] localPlayer.mesh is missing!');
                    }
                    if (!localPlayerRef.current.rapierBody) {
                        console.warn('[DEBUG] localPlayer.rapierBody is missing!');
                    }
                    if (!localState) {
                        console.warn('[DEBUG] localState is missing!');
                    } else if (localState.state !== 'alive') {
                        console.log(`[DEBUG] localState is not 'alive' (state: ${localState.state}), prediction/input might be ignored.`);
                    }
                    if (localPlayerRef.current.mesh && localPlayerRef.current.rapierBody) {
                        console.log(`[DEBUG] Mesh position: (${localPlayerRef.current.mesh.position.x}, ${localPlayerRef.current.mesh.position.y}, ${localPlayerRef.current.mesh.position.z})`);
                        console.log(`[DEBUG] Camera position: (${cameraRef.current.position.x}, ${cameraRef.current.position.y}, ${cameraRef.current.position.z})`);
                    }
                };
                console.log("Starting render loop...");
                renderLoopIdRef.current = requestAnimationFrame(render); // Use ref

                // --- Socket.IO Connection --- (Refined Retry Logic)
                const connectToServer = () => {
                    // Use ref
                    if (rapierWorldRef.current && !localPlayerRef.current.rapierBody) {
                       console.log("Creating CLIENT-SIDE Rapier body for prediction...");
                       // Use placeholder initial position, server state will correct it
                       const initialClientPos = {x:0, y:1, z:0};
                       const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
                         .setTranslation(initialClientPos.x, initialClientPos.y, initialClientPos.z)
                         .setCanSleep(false).setCcdEnabled(true)
                         .lockRotations(); // Ensure rotations are locked for the client-side body
                       const body = rapierWorldRef.current.createRigidBody(bodyDesc);
                       const playerHeight = PLAYER_VISUAL_TOTAL_HEIGHT; const playerRadius = PLAYER_VISUAL_RADIUS;
                       const colliderDesc = RAPIER.ColliderDesc.capsule(playerHeight / 2 - playerRadius, playerRadius);
                       // Apply properties after creation
                       colliderDesc.setDensity(1.0);
                       colliderDesc.setFriction(0.7);
                       colliderDesc.setRestitution(0.2);
                       // NEW: Set Collision Groups for client player body
                       colliderDesc.setCollisionGroups(interactionGroups(
                           CollisionGroup.PLAYER_BODY,
                           [CollisionGroup.WORLD, CollisionGroup.PLAYER_BODY, CollisionGroup.GRENADE] // Match server player body interactions
                       ));
                       // Set active events AFTER setting groups
                       colliderDesc.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);

                       // Use rapierWorldRef
                       const collider = rapierWorldRef.current.createCollider(colliderDesc, body);
                       collider.userData = { type: 'playerBody', playerId: localPlayerUserId }; // Set userData on the created collider
                       localPlayerRef.current.rapierBody = body;
                       console.log("Client-side Rapier body created.");
                    }

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
                            console.log('[DEBUG] Received GAME_STATE_FPS:', gameState);
                            if (!isMounted) return;
                            const serverPlayerState = gameState.players?.[localPlayerUserId];

                            // Apply reconciliation if server state received
                            if (serverPlayerState && serverPlayerState.lastProcessedSequence !== undefined && localPlayerRef.current.rapierBody) {
                                const lastProcessedSequence = serverPlayerState.lastProcessedSequence;

                                // Remove acknowledged inputs from pending buffer
                                inputStateRef.current.pendingInputs = inputStateRef.current.pendingInputs.filter(
                                    input => input.sequence > lastProcessedSequence
                                );

                                // Reset client physics state to authoritative server state
                                localPlayerRef.current.rapierBody.setTranslation(serverPlayerState.position, true);
                                localPlayerRef.current.rapierBody.setRotation(serverPlayerState.rotation, true);
                                localPlayerRef.current.rapierBody.setLinvel(serverPlayerState.velocity, true);
                                localPlayerRef.current.rapierBody.setAngvel({ x: 0, y: 0, z: 0 }, true); // Reset angular velocity too

                                // Re-apply pending (unacknowledged) inputs on top of server state
                                inputStateRef.current.pendingInputs.forEach(input => {
                                    // Use the same physics application function
                                    applyInputPhysics(localPlayerRef.current.rapierBody, input.keys, input.lookQuat, input.deltaTime);
                                    // Optionally, re-step the physics world for each pending input?
                                    // rapierWorldRef.current?.step(); // This might be too expensive
                                });
                                // After re-applying inputs, the rapierBody is now the corrected predicted state

                            } else if (serverPlayerState && localPlayerRef.current.rapierBody) {
                                // No sequence number? Maybe initial state or server doesn't support reconciliation fully yet.
                                // Just hard-set state without replaying inputs for now.
                                localPlayerRef.current.rapierBody.setTranslation(serverPlayerState.position, true);
                                localPlayerRef.current.rapierBody.setRotation(serverPlayerState.rotation, true);
                                localPlayerRef.current.rapierBody.setLinvel(serverPlayerState.velocity, true);
                                localPlayerRef.current.rapierBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
                            }

                            // Always update the overall game state for rendering remote players, HUD, etc.
                            gameStateRef.current = gameState;
                            setGameStateVersion(v => v + 1); // Trigger UI updates if needed
                        });
                        // Add other listeners...

                        newSocket.on('disconnect', (reason) => {
                            if (!isMounted) return;
                            console.log('Disconnected. Reason:', reason);
                            socketRef.current = null;
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
                rendererRef.current.dispose();
            }
            // OrbitControls disposal removed, handled by DebugControls
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

            {/* Conditionally render DebugControls */}
            <DebugControls
                isEnabled={isDebugModeEnabled}
                camera={cameraRef.current}
                renderer={rendererRef.current}
                scene={sceneRef.current}
                rapierWorld={rapierWorldRef.current}
            />

            {/* Potential UI Overlays */}
        </div>
    );
}

export default GameViewFPS; 