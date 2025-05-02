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
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';

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
    const linesRef = useRef(null); // <-- Move this here

    // State for loading/connection status
    const [isLoading, setIsLoading] = useState(true);
    // Provide more detailed statuses
    const [connectionStatus, setConnectionStatus] = useState('disconnected'); // 'connecting', 'connected', 'error', 'retrying', 'disconnected'
    const [retryAttempt, setRetryAttempt] = useState(0); // Track retry attempts
    // NEW: Add state to hold the merged game state received from server (Plan 1.1.2)
    const gameStateRef = useRef(null);
    const [gameStateVersion, setGameStateVersion] = useState(0); // Only for UI updates

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

    // Use the existing cameraModeRef for all camera state:
    const cameraModeRef = useRef({
        isThirdPerson: true,
        isOrbital: false
    });

    // >>> NEW: Function to apply physics based on input <<< (Used by prediction & reconciliation)
    const applyInputPhysics = useCallback((playerBody, inputKeys, inputLookQuat, physicsDeltaTime) => {
        if (!playerBody || physicsDeltaTime <= 0) return;

        // Constants should ideally match server
        const walkSpeed = 5.0;
        const runSpeed = 8.0;
        const jumpImpulse = 7.0;
        const accelerationForce = 2000.0; // Force applied per second
        const maxAccelForce = 50.0; // Max force per tick (scaled by deltaTime)
        const airControlFactor = 0.2;

        let desiredVelocity = new THREE.Vector3(0, 0, 0);
        let moveDirection = new THREE.Vector3(0, 0, 0);
        let isMoving = false;

        // Use the provided lookQuat for direction calculation
        const _lookQuat = new THREE.Quaternion(inputLookQuat.x, inputLookQuat.y, inputLookQuat.z, inputLookQuat.w);
        const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(_lookQuat);
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(_lookQuat);
        forward.y = 0; // Project onto ground plane
        right.y = 0;
        forward.normalize();
        right.normalize();

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

        // Apply force based on velocity difference
        const currentLinvel = playerBody.linvel();
        let force = new THREE.Vector3(0, 0, 0);
        const velocityDiffX = desiredVelocity.x - currentLinvel.x;
        const velocityDiffZ = desiredVelocity.z - currentLinvel.z;

        force.x = velocityDiffX * accelerationForce * physicsDeltaTime;
        force.z = velocityDiffZ * accelerationForce * physicsDeltaTime;

        // TODO: Air control factor application needs ground check state
        // const isOnGround = true; // Placeholder - get from Rapier contacts or server state
        // if (!isOnGround) {
        //     force.x *= airControlFactor;
        //     force.z *= airControlFactor;
        // }

        // Clamp force
        const forceMagnitude = force.length(); // Use THREE.Vector3 length
        if (forceMagnitude > maxAccelForce) {
            force.multiplyScalar(maxAccelForce / forceMagnitude);
        }
        playerBody.applyImpulse({ x: force.x, y: 0, z: force.z }, true);

        // Jumping
        // TODO: Needs reliable client-side ground check
        const isOnGround = true; // Placeholder
        if (inputKeys.Space && isOnGround /* && !wasJumpingLastFrame */) {
            playerBody.applyImpulse({ x: 0, y: jumpImpulse, z: 0 }, true);
            // TODO: Prevent spamming jump impulse
        }

    }, []); // Empty dependency array as it uses constants and args

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
        let physicsDebugRenderer = null; // <<< NEW: Ref for debug renderer
        // MODIFIED: Updated fpvElements structure
        let fpvElements = {
            camera: null,
            weaponModels: {}, // { weaponId: { model: THREE.Group, mixer: THREE.AnimationMixer, animations: { animName: THREE.AnimationClip } } }
            grappleRopeMaterial: null,
        };
        let playerAnimationActions = {}; // Store shared player animations

        // >>> NEW: Move Input Handlers outside initGame <<< Plan 2.2.1 / 2.2.2
        const handleKeyDown = (event) => {
            console.log(`[DEBUG] KeyDown: code=${event.code}, key=${event.key}`);
            // Prevent browser default actions for game keys
            if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'KeyC'].includes(event.code)) {
                event.preventDefault();
            }

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
                case 'KeyB': // B key for debug camera
                    cameraModeRef.current.isOrbital = !cameraModeRef.current.isOrbital;
                    if (cameraModeRef.current.isOrbital) {
                        console.log('Enabling orbital debug camera');
                        document.exitPointerLock();
                    }
                    break;
            }
        };
        const handleKeyUp = (event) => {
            console.log(`[DEBUG] KeyUp: code=${event.code}, key=${event.key}`);
            // Prevent browser default actions for game keys
            if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'KeyC'].includes(event.code)) {
                event.preventDefault();
            }

            switch (event.code) {
                case 'KeyW': inputStateRef.current.keys.W = false; break;
                case 'KeyA': inputStateRef.current.keys.A = false; break;
                case 'KeyS': inputStateRef.current.keys.S = false; break;
                case 'KeyD': inputStateRef.current.keys.D = false; break;
                case 'Space': inputStateRef.current.keys.Space = false; break;
                case 'ShiftLeft': inputStateRef.current.keys.Shift = false; break;
                // NEW: Toggle Camera Key Release
                case 'KeyC':
                    if (inputStateRef.current.keys.C) {
                        cameraModeRef.current.isThirdPerson = !cameraModeRef.current.isThirdPerson;
                    }
                    inputStateRef.current.keys.C = false; break;
                // Add other keys later
            }
        };

        const handleMouseMove = (event) => {
            // NEW: Log entry into the handler
            console.log('handleMouseMove fired.');
            // NEW: Log pointer lock status
            console.log('Pointer Lock Element:', document.pointerLockElement);

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
            // NEW: Log pointer lock changes
            if (document.pointerLockElement === canvasElement) {
                console.log('Pointer Locked (handlePointerLockChange)');
            } else {
                console.log('Pointer Unlocked (handlePointerLockChange)');
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

                // ... after loading localPlayer.mesh and remotePlayer.mesh, before adding to scene ...
                localPlayer.mesh.scale.set(0.3, 0.3, 0.3); // DEBUG: Reduce character size
                remotePlayer.mesh.scale.set(0.3, 0.3, 0.3); // DEBUG: Reduce character size
                console.log('[DEBUG] Character model scale set to (0.3, 0.3, 0.3)');

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

                // >>> NEW: Move debug lines creation here, assign to outer scope variable <<<
                linesRef.current = new THREE.LineSegments(
                    new THREE.BufferGeometry(),
                    new THREE.LineBasicMaterial({ color: 0xffffff, vertexColors: true })
                );
                scene.add(linesRef.current);

                // --- Load Map Physics (Client - Mirroring server 1.2.2) ---
                console.log(`Loading Client Physics for Map ID: ${mapId}...`);
                const clientMapConfig = MAP_CONFIGS_FPS[mapId]; // Use a different variable name
                if (!clientMapConfig || !clientMapConfig.physicsData) {
                    console.warn(`Client: No physicsData found for map ${mapId}.`);
                } else {
                    const clientPhysicsData = clientMapConfig.physicsData;
                    console.log("Client: Found Physics Data:", JSON.stringify(clientPhysicsData, null, 2)); // Log physics data

                    // --- Prioritize Trimesh Loading --- (NEW)
                    if (clientPhysicsData.vertices && clientPhysicsData.vertices.length > 0 && clientPhysicsData.indices && clientPhysicsData.indices.length > 0) {
                        console.log(`[Client Physics Load] Attempting to load TR MESH...`);
                        try {
                            const rigidBodyDesc = RAPIER.RigidBodyDesc.fixed();
                            const body = rapierWorld.createRigidBody(rigidBodyDesc);
                            const trimeshDesc = RAPIER.ColliderDesc.trimesh(clientPhysicsData.vertices, clientPhysicsData.indices);
                            console.log(`[Client Physics Load] TrimeshDesc created.`);

                            // IMPORTANT: Set Collision Groups - MUST MATCH SERVER
                            const groups = interactionGroups(
                                CollisionGroup.WORLD,
                                [CollisionGroup.PLAYER_BODY, CollisionGroup.GRENADE, CollisionGroup.PROJECTILE]
                            );
                            trimeshDesc.setCollisionGroups(groups);
                            console.log(`[Client Physics Load] Trimesh Set collision groups to:`, groups);

                            const collider = rapierWorld.createCollider(trimeshDesc, body);
                            console.log(`[Client Physics Load] SUCCESS: Created client trimesh map collider handle: ${collider.handle}`);
                        } catch (error) {
                            console.error(`[Client Physics Load] ERROR: Failed to create client trimesh collider for map ${mapId}:`, error);
                            console.warn(`[Client Physics Load] Falling back to primitive colliders if available...`);
                            loadClientPrimitiveColliders(clientPhysicsData, mapId); // Call helper as fallback
                        }
                    } else {
                         console.log(`[Client Physics Load] No valid trimesh data found. Checking for primitive colliders...`);
                         loadClientPrimitiveColliders(clientPhysicsData, mapId); // Call helper if no trimesh
                    }
                }
                console.log('Client Map Physics Loading Attempt Complete.'); // Log progress

                // Helper function for loading client primitive colliders (NEW)
                function loadClientPrimitiveColliders(physicsData, mapId) {
                     if (physicsData.colliders && physicsData.colliders.length > 0) {
                        console.log(`[Client Physics Load - Primitives] Processing ${physicsData.colliders.length} primitive colliders...`);
                        physicsData.colliders.forEach((colliderData, index) => {
                            console.log(`[Client Collider ${index}] Data:`, JSON.stringify(colliderData));
                            let colliderDesc;
                            let rigidBodyDesc = RAPIER.RigidBodyDesc.fixed();

                            if (colliderData.position) {
                                rigidBodyDesc.setTranslation(colliderData.position.x, colliderData.position.y, colliderData.position.z);
                            }
                            // TODO: Set rotation if provided

                            if (colliderData.type === 'cuboid') {
                                if (!colliderData.dimensions) { console.warn(`[Client Collider ${index}] Cuboid missing dimensions`); return; }
                                colliderDesc = RAPIER.ColliderDesc.cuboid(colliderData.dimensions.x / 2, colliderData.dimensions.y / 2, colliderData.dimensions.z / 2);
                            } // Add other types if needed
                            else {
                                console.warn(`[Client Collider ${index}] Unsupported collider type: ${colliderData.type}`);
                                return;
                            }

                            if (colliderDesc) {
                                console.log(`[Client Collider ${index}] ColliderDesc created.`);
                                // IMPORTANT: Ensure client sets collision groups identically to server!
                                const groups = interactionGroups(
                                    CollisionGroup.WORLD,
                                    [CollisionGroup.PLAYER_BODY, CollisionGroup.GRENADE, CollisionGroup.PROJECTILE]
                                );
                                colliderDesc.setCollisionGroups(groups); // <<< ADDED MISSING CALL
                                console.log(`[Client Collider ${index}] Set collision groups to:`, groups);

                                const body = rapierWorld.createRigidBody(rigidBodyDesc);
                                const collider = rapierWorld.createCollider(colliderDesc, body);
                                console.log(`[Client Collider ${index}] Created map collider handle: ${collider.handle} attached to body handle: ${body.handle}`);
                            } else {
                                console.warn(`[Client Collider ${index}] Failed to create ColliderDesc.`);
                            }
                        });
                    } else {
                        console.log("Client: No primitive colliders defined in physicsData.");
                    }
                 }

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
                        // >>> ADDED LOG <<<
                        console.error('[PointerLock] Error acquiring pointer lock:', event);
                    }, { once: true });

                    const pointerLockClickListener = () => {
                         // >>> ADDED LOG <<<
                        console.log('[PointerLock] Canvas clicked.');
                        if (!document.pointerLockElement) {
                             // >>> ADDED LOG <<<
                            console.log('[PointerLock] Attempting to request pointer lock...');
                            if (typeof canvasElement.requestPointerLock === 'function') {
                                canvasElement.requestPointerLock(); // No .catch(), synchronous in most browsers
                                // >>> ADDED LOG <<<
                                console.log('[PointerLock] requestPointerLock() called.');
                            } else {
                                console.error('[PointerLock] Error: canvasElement.requestPointerLock is not a function!');
                            }
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
                const thirdPersonOffset = new THREE.Vector3(0, 2, -4); // Camera offset behind player
                const tempPlayerPos = new THREE.Vector3(); // Temporary vectors for calculations
                const tempCameraPos = new THREE.Vector3();
                const tempLookAt = new THREE.Vector3();

                let orbitControls = null;

                const render = (timestamp) => {
                    if (!isMounted) return;
                    renderLoopId = requestAnimationFrame(render);

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
                    if (localPlayer.rapierBody && localState && localState.state === 'alive') {
                        // >>> ADDED LOG <<<
                        console.log(`[Predict] Applying input: W=${inputStateRef.current.keys.W} | Body Vel: ${localPlayer.rapierBody.linvel().x.toFixed(2)},${localPlayer.rapierBody.linvel().y.toFixed(2)},${localPlayer.rapierBody.linvel().z.toFixed(2)}`);
                        // Apply physics using the helper function
                        applyInputPhysics(localPlayer.rapierBody, inputStateRef.current.keys, inputStateRef.current.lookQuat, deltaTime);
                    }

                    // 2. Step Client Physics World
                    if (rapierWorld) {
                        rapierWorld.step();
                        // >>> ADDED LOG <<<
                        if (localPlayer.rapierBody) {
                             console.log(`[Predict] After Step: Body Pos: ${localPlayer.rapierBody.translation().x.toFixed(2)},${localPlayer.rapierBody.translation().y.toFixed(2)},${localPlayer.rapierBody.translation().z.toFixed(2)}`);
                        }
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
                    // >> NEW: Control overall FPV camera visibility first <<
                    const isFirstPerson = !cameraModeRef.current.isThirdPerson && !cameraModeRef.current.isOrbital;
                    if (fpvElements.camera) {
                        fpvElements.camera.visible = isFirstPerson;
                    }
                    // >> END NEW <<

                    // Keep this logic: Only make the *active* weapon model visible *when* FPV is active
                    for (const weaponId in fpvElements.weaponModels) {
                        const weaponData = fpvElements.weaponModels[weaponId];
                        if (weaponData?.model) {
                            weaponData.model.visible = isFirstPerson && (weaponId === activeWeaponId);
                        }
                    }

                    // --- Update Player Mesh Visibility & Position (Placeholder) ---
                    if (localPlayer.mesh) {
                        localPlayer.mesh.visible = cameraModeRef.current.isThirdPerson;
                        // NEW: Update mesh from predicted Rapier body state
                        if (localPlayer.rapierBody) {
                            // Define capsule dimensions (must match server/client creation)
                            const playerHeight = 1.8;
                            const playerRadius = 0.4;
                            const capsuleHalfHeight = playerHeight / 2;
                            const visualMeshOffsetY = -capsuleHalfHeight; // Offset model down

                            const predictedPos = localPlayer.rapierBody.translation();
                            const predictedRot = localPlayer.rapierBody.rotation(); // Rapier returns {x,y,z,w}
                            // >>> ADDED LOG <<<
                            console.log(`[Predict] Syncing Mesh: Body Pos=(${predictedPos.x.toFixed(2)}, ${predictedPos.y.toFixed(2)}, ${predictedPos.z.toFixed(2)})`);
                            // Apply offset to align model feet with capsule bottom
                            localPlayer.mesh.position.set(predictedPos.x, predictedPos.y + visualMeshOffsetY, predictedPos.z);
                            // >>> ADDED LOG <<<
                            console.log(`[Predict] Syncing Mesh: Mesh Pos=(${localPlayer.mesh.position.x.toFixed(2)}, ${localPlayer.mesh.position.y.toFixed(2)}, ${localPlayer.mesh.position.z.toFixed(2)})`);
                            // Don't directly set mesh rotation from body if using third person lookAt
                            if (!cameraModeRef.current.isThirdPerson) {
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
                         const remoteState = gameStateRef.current?.players?.[opponentPlayerId];
                         if (remoteState && remoteState.position && remoteState.rotation) {
                            remotePlayer.mesh.visible = true; // Show remote player always
                            remotePlayer.mesh.position.lerp(remoteState.position, 0.3);
                            remotePlayer.mesh.quaternion.slerp(remoteState.rotation, 0.3);
                        } else {
                            remotePlayer.mesh.visible = false;
                         }
                    }

                    // --- Camera Controls Setup ---
                    if (cameraModeRef.current.isOrbital) {
                        if (!orbitControls && camera && renderer?.domElement) {
                            // Add null check for camera and renderer.domElement
                            if (!document.body.contains(renderer.domElement)) {
                                console.error('Renderer DOM element not attached to document');
                                return;
                            }
                            
                            // Verify camera has valid matrix
                            camera.updateMatrixWorld();
                            orbitControls = new OrbitControls(camera, renderer.domElement);
                            orbitControls.enableDamping = true;
                            orbitControls.dampingFactor = 0.05;
                            orbitControls.screenSpacePanning = true;
                            orbitControls.minDistance = 1;
                            orbitControls.maxDistance = 50;
                            
                            // Force initial update
                            orbitControls.update();
                        }
                    } else if (orbitControls) {
                        orbitControls.dispose();
                        orbitControls = null;
                    }

                    // --- Update Camera Position ---
                    if (orbitControls) {
                        orbitControls.update();
                    } else if (cameraModeRef.current.isThirdPerson && localPlayer.mesh) {
                        // Third-person camera logic
                        tempCameraPos.copy(thirdPersonOffset);
                        tempCameraPos.applyQuaternion(localPlayer.mesh.quaternion);
                        tempCameraPos.add(localPlayer.mesh.position);
                        camera.position.lerp(tempCameraPos, 0.1);
                        tempLookAt.copy(localPlayer.mesh.position).add(new THREE.Vector3(0, 1.0, 0));
                        camera.lookAt(tempLookAt);
                    } else {
                        // First-person camera logic
                        if (localState && localState.position) {
                            camera.position.set(
                                localState.position.x,
                                localState.position.y + 1.7,
                                localState.position.z
                            );
                        }
                    }

                    // Render Scene
                    if (renderer && scene && camera) {
                        // >>> MODIFIED: Only one render call needed <<<
                        renderer.render(scene, camera);

                        // >>> REMOVED redundant/incorrect FPV render pass <<<
                        // if (fpvElements.camera) {
                        //     renderer.autoClear = false;
                        //     renderer.clearDepth();
                        //     renderer.render(scene, fpvElements.camera); // REMOVED
                        //     renderer.autoClear = true;
                        // }
                    }

                    // >>> NEW: Render Physics Debug Wireframes <<<
                    if (rapierWorld && linesRef.current) {
                         // >> MODIFIED: Only show debug lines when orbital camera is active <<
                         linesRef.current.visible = cameraModeRef.current.isOrbital;
                         if (linesRef.current.visible) {
                             const buffers = rapierWorld.debugRender();
                             linesRef.current.geometry.setAttribute('position', new THREE.BufferAttribute(buffers.vertices, 3));
                             linesRef.current.geometry.setAttribute('color', new THREE.BufferAttribute(buffers.colors, 4));
                         }
                    }

                    if (!localPlayer.mesh) {
                        console.warn('[DEBUG] localPlayer.mesh is missing!');
                    }
                    if (!localPlayer.rapierBody) {
                        console.warn('[DEBUG] localPlayer.rapierBody is missing!');
                    }
                    if (!localState) {
                        console.warn('[DEBUG] localState is missing!');
                    } else if (localState.state !== 'alive') {
                        console.log(`[DEBUG] localState is not 'alive' (state: ${localState.state}), prediction/input might be ignored.`);
                    }
                    if (localPlayer.mesh && localPlayer.rapierBody) {
                        console.log(`[DEBUG] Mesh position: (${localPlayer.mesh.position.x}, ${localPlayer.mesh.position.y}, ${localPlayer.mesh.position.z})`);
                        console.log(`[DEBUG] Camera position: (${camera.position.x}, ${camera.position.y}, ${camera.position.z})`);
                    }
                };
                console.log("Starting render loop...");
                renderLoopId = requestAnimationFrame(render); // Start the loop

                // --- Socket.IO Connection --- (Refined Retry Logic)
                const connectToServer = () => { // <<< NOTE: Consider creating player body client-side here too for prediction
                    // Example: Create client-side player body after rapier init
                    // This body will be driven by prediction and corrected by server state.
                    if (rapierWorld && !localPlayer.rapierBody) {
                       console.log("Creating CLIENT-SIDE Rapier body for prediction...");
                       // Use placeholder initial position, server state will correct it
                       const initialClientPos = {x:0, y:1, z:0};
                       const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
                         .setTranslation(initialClientPos.x, initialClientPos.y, initialClientPos.z)
                         .setCanSleep(false).setCcdEnabled(true); // Removed .lockRotations()
                       const body = rapierWorld.createRigidBody(bodyDesc);
                       const playerHeight = 1.8; const playerRadius = 0.4;
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

                       const collider = rapierWorld.createCollider(colliderDesc, body);
                       collider.userData = { type: 'playerBody', playerId: localPlayerUserId }; // Set userData on the created collider
                       localPlayer.rapierBody = body;
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
                            if (serverPlayerState && serverPlayerState.lastProcessedSequence !== undefined && localPlayer.rapierBody) {
                                const lastProcessedSequence = serverPlayerState.lastProcessedSequence;

                                // Remove acknowledged inputs from pending buffer
                                inputStateRef.current.pendingInputs = inputStateRef.current.pendingInputs.filter(
                                    input => input.sequence > lastProcessedSequence
                                );

                                // Reset client physics state to authoritative server state
                                localPlayer.rapierBody.setTranslation(serverPlayerState.position, true);
                                localPlayer.rapierBody.setRotation(serverPlayerState.rotation, true);
                                localPlayer.rapierBody.setLinvel(serverPlayerState.velocity, true);
                                localPlayer.rapierBody.setAngvel({ x: 0, y: 0, z: 0 }, true); // Reset angular velocity too

                                // Re-apply pending (unacknowledged) inputs on top of server state
                                inputStateRef.current.pendingInputs.forEach(input => {
                                    // Use the same physics application function
                                    applyInputPhysics(localPlayer.rapierBody, input.keys, input.lookQuat, input.deltaTime);
                                    // Optionally, re-step the physics world for each pending input?
                                    // rapierWorld?.step(); // This might be too expensive
                                });
                                // After re-applying inputs, the rapierBody is now the corrected predicted state

                            } else if (serverPlayerState && localPlayer.rapierBody) {
                                // No sequence number? Maybe initial state or server doesn't support reconciliation fully yet.
                                // Just hard-set state without replaying inputs for now.
                                localPlayer.rapierBody.setTranslation(serverPlayerState.position, true);
                                localPlayer.rapierBody.setRotation(serverPlayerState.rotation, true);
                                localPlayer.rapierBody.setLinvel(serverPlayerState.velocity, true);
                                localPlayer.rapierBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
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
            if (orbitControls) {
                orbitControls.dispose();
                orbitControls = null; // Important to prevent memory leaks
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