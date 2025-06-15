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
import HUD from './HUD'; // NEW: Import the HUD component

// NEW: Player Physics Dimensions Constants (must match server)
const PLAYER_VISUAL_TOTAL_HEIGHT = 0.5; // New smaller height for visual alignment
const PLAYER_VISUAL_RADIUS = 0.12;       // New smaller radius (used for client physics body)

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

    // --- Refs for Three.js/Rapier objects ---
    const cameraRef = useRef(null);
    const rendererRef = useRef(null);
    const sceneRef = useRef(null);
    const rapierWorldRef = useRef(null);
    const localPlayerRef = useRef({ mesh: null, rapierBody: null, mixer: null });
    const remotePlayerRef = useRef({ mesh: null, mixer: null });
    const fpvElementsRef = useRef({ camera: null, weaponModels: {}, grappleRopeMaterial: null });
    const playerAnimationActionsRef = useRef({});
    const remotePlayerAnimationActionsRef = useRef({}); // Add remote player animations ref
    const renderLoopIdRef = useRef(null); // Ref for render loop ID
    const projectilesRef = useRef(new Map()); // NEW: For tracking projectile meshes
    const projectilePoolRef = useRef([]); // NEW: For reusing projectile meshes
    const activeVisualProjectilesRef = useRef([]); // NEW: For animating visual projectiles

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
        isFiring: false, // NEW: Track left mouse button state for firing
        lastFireTime: 0, // NEW: Track client-side fire rate
        // NEW: Separate mouse look components
        cameraPitch: 0, // Up/down rotation for camera
        characterYaw: 0, // Left/right rotation for character
    });
    const lastInputSendTimeRef = useRef(0);
    const INPUT_SEND_INTERVAL = 1000 / 30; // Increased to 30Hz for smoother input

    // Use the existing cameraModeRef for all camera state:
    const cameraModeRef = useRef({
        isThirdPerson: true,
        isOrbital: false
    });

    // NEW: Add recoil recovery state
    const recoilStateRef = useRef({
        pitch: 0,
        yaw: 0,
        recoverySpeed: 4, // default, will be updated by weapon
    });

    // NEW: Add smoothing state for better interpolation
    const smoothingStateRef = useRef({
        lastServerUpdate: 0,
        targetPosition: new THREE.Vector3(),
        targetRotation: new THREE.Quaternion(),
        targetVelocity: new THREE.Vector3(),
        interpolationAlpha: 0,
    });

    // --- Client-Side Prediction & Movement Engine ---
    const applyInputPhysics = useCallback((playerBody, inputKeys, inputLookQuat, physicsDeltaTime, isOnGround) => {
        if (!playerBody || physicsDeltaTime <= 0) return;
        
        // Reduced speeds and forces for smoother movement
        const walkSpeed = 5; // Further reduced from 3.0
        const runSpeed = 10; // Further reduced from 5.0
        const jumpImpulse = 5.0; // Further reduced from 6.0
        const accelerationForce = 800.0; // Further reduced from 1200.0
        const maxAccelForce = 20.0; // Further reduced from 30.0
        const airControlFactor = 0.2;
        const dampingFactor = 0.95; // Add damping to smooth out movement
        
        let desiredVelocity = new THREE.Vector3(0, 0, 0);
        let moveDirection = new THREE.Vector3(0, 0, 0);
        let isMoving = false;
        
        // FIX: Use only the character yaw for movement direction, not the full look quaternion
        // This ensures the character moves forward relative to their body orientation, not camera pitch
        const characterYawQuat = new THREE.Quaternion();
        characterYawQuat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), inputStateRef.current.characterYaw);
        
        const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(characterYawQuat);
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(characterYawQuat);
        // No need to zero Y or normalize since we're using pure yaw rotation
        
        if (inputKeys.W) { moveDirection.add(forward); isMoving = true; }
        if (inputKeys.S) { moveDirection.sub(forward); isMoving = true; }
        if (inputKeys.A) { moveDirection.sub(right); isMoving = true; }
        if (inputKeys.D) { moveDirection.add(right); isMoving = true; }
        
        if (isMoving) {
            moveDirection.negate(); // Invert final movement vector
            moveDirection.normalize();
            const targetSpeed = inputKeys.Shift ? runSpeed : walkSpeed;
            desiredVelocity.x = moveDirection.x * targetSpeed;
            desiredVelocity.z = moveDirection.z * targetSpeed;
        }
        
        const currentLinvel = playerBody.linvel();
        
        // Apply damping to current velocity for smoother movement
        const dampedVelocity = {
            x: currentLinvel.x * dampingFactor,
            y: currentLinvel.y, // Don't damp Y velocity (gravity/jumping)
            z: currentLinvel.z * dampingFactor
        };
        
        // Calculate force needed to reach desired velocity
        let force = new THREE.Vector3(0, 0, 0);
        const velocityDiffX = desiredVelocity.x - dampedVelocity.x;
        const velocityDiffZ = desiredVelocity.z - dampedVelocity.z;
        
        // Use smaller, smoother force application
        force.x = velocityDiffX * accelerationForce * physicsDeltaTime * 0.5; // Reduced force multiplier
        force.z = velocityDiffZ * accelerationForce * physicsDeltaTime * 0.5;
        
        // TODO: Air control factor application needs ground check state
        // const isOnGround = true; // Placeholder
        // if (!isOnGround) { force.x *= airControlFactor; force.z *= airControlFactor; }
        
        // Clamp force magnitude for stability
        const forceMagnitude = force.length();
        if (forceMagnitude > maxAccelForce) {
            force.multiplyScalar(maxAccelForce / forceMagnitude);
        }
        
        // Apply the smoothed velocity first, then the force
        playerBody.setLinvel(dampedVelocity, true);
        if (forceMagnitude > 0.1) { // Only apply force if it's significant
            playerBody.applyImpulse({ x: force.x, y: 0, z: force.z }, true);
        }
        
        // Jumping - reduced impulse for smoother feel
        if (inputKeys.Space && isOnGround) {
            playerBody.applyImpulse({ x: 0, y: jumpImpulse, z: 0 }, true);
        }
        
        // Grapple Gun Physics (if active) -- placeholder for client prediction
        // ...
    }, []);

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
                'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'KeyC'
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
                    case 'KeyC': inputStateRef.current.keys.C = true; break; // Camera toggle still needs lock
                    case 'KeyQ': // NEW: Weapon Switch Key
                        inputStateRef.current.keys.WeaponSwitch = true;
                        // Send immediately, no need to hold
                        socketRef.current?.emit(MessageTypeFPS.SWITCH_WEAPON_FPS);
                        break;
                    case 'KeyR':
                        inputStateRef.current.keys.Reload = true;
                        // Client-side logic to request a reload
                        const localPlayerState = gameStateRef.current?.players?.[localPlayerUserId];
                        if (localPlayerState && !localPlayerState.isReloading) {
                            const activeWeaponId = localPlayerState.weaponSlots[localPlayerState.activeWeaponSlot];
                            const weaponConfig = WEAPON_CONFIG_FPS[activeWeaponId];
                            if (weaponConfig && localPlayerState.currentAmmoInClip < weaponConfig.ammoCapacity) {
                                console.log("Client: Requesting reload...");
                                socketRef.current?.emit(MessageTypeFPS.RELOAD_WEAPON_FPS);
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
            inputStateRef.current.characterYaw -= movementX * sensitivity;

            // Clamp camera pitch to prevent over-rotation
            inputStateRef.current.cameraPitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, inputStateRef.current.cameraPitch));

            // Create TOTAL visual rotation including recoil for the camera
            const totalPitch = inputStateRef.current.cameraPitch + recoilStateRef.current.pitch;
            const totalYaw = inputStateRef.current.characterYaw + recoilStateRef.current.yaw;
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

            const localPlayerState = gameStateRef.current?.players[localPlayerUserId];
            if (localPlayerState) {
                const activeWeaponId = localPlayerState.weaponSlots[localPlayerState.activeWeaponSlot];
                const weaponConfig = WEAPON_CONFIG_FPS[activeWeaponId];

                // Firing logic
                if (localPlayerState.state === 'alive' && !localPlayerState.isReloading && localPlayerState.currentAmmoInClip > 0 && inputStateRef.current.isFiring) {
                    const now = performance.now();
                    if (now - inputStateRef.current.lastFireTime >= weaponConfig.fireRate) {
                        inputStateRef.current.lastFireTime = now;
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
            if (event.button === 0) { // Left mouse button
                inputStateRef.current.isFiring = true;
            }
            if (event.button === 2) { // Right mouse button
                inputStateRef.current.isAiming = true;
            }
        };
        const handleMouseUp = (event) => {
            if (event.button === 0) { // Left mouse button
                inputStateRef.current.isFiring = false;
            }
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
                cameraRef.current.position.set(0, 1.6, 5); // Initial placeholder position
                sceneRef.current.add(cameraRef.current);

                // DEBUG: Log initial camera direction
                const initialDirection = new THREE.Vector3();
                cameraRef.current.getWorldDirection(initialDirection);
                console.log('Initial Camera Facing Direction:', initialDirection);

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
                const mapGltf = await loader.loadAsync(mapConfig.visualAssetPath);
                const mapMesh = mapGltf.scene;
                mapMesh.traverse(node => { // Enable shadows on map objects
                    if (node.isMesh) {
                        node.castShadow = true;
                        node.receiveShadow = true;
                    }
                });
                sceneRef.current.add(mapMesh); // Add to scene via ref
                
                // --- Load Character Models ---
                const localModelPath = localCharConfig.modelPath;
                const remoteModelPath = remoteCharConfig.modelPath;
                
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
                    console.log('--- AVAILABLE LOCAL PLAYER ANIMATIONS ---');
                    localCharacterGltf.animations.forEach((clip, idx) => {
                        console.log(`[${idx}]: ${clip.name}`);
                    });
                    console.log('------------------------------------');
                } else {
                    console.log('--- NO LOCAL PLAYER ANIMATIONS FOUND ---');
                }

                // Log all animation names for the remote character model
                if (remoteCharacterGltf.animations && remoteCharacterGltf.animations.length > 0) {
                    console.log('--- AVAILABLE REMOTE PLAYER ANIMATIONS ---');
                    remoteCharacterGltf.animations.forEach((clip, idx) => {
                        console.log(`[${idx}]: ${clip.name}`);
                    });
                    console.log('-----------------------------------------');
                } else {
                    console.log('--- NO REMOTE PLAYER ANIMATIONS FOUND ---');
                }

                // Store animations for both players
                playerAnimationActionsRef.current = {}; // Local player animations
                remotePlayerAnimationActionsRef.current = {}; // Remote player animations
                
                localCharacterGltf.animations.forEach(clip => {
                    playerAnimationActionsRef.current[clip.name] = clip; // Local player
                });
                
                remoteCharacterGltf.animations.forEach(clip => {
                    remotePlayerAnimationActionsRef.current[clip.name] = clip; // Remote player
                });

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

                // Apply 14% size reduction (scale by 0.86)
                const characterScale = 0.30;
                localPlayerRef.current.mesh.scale.setScalar(characterScale);
                remotePlayerRef.current.mesh.scale.setScalar(characterScale);

                localPlayerRef.current.mesh.traverse(node => { if (node.isMesh) node.castShadow = true; });
                remotePlayerRef.current.mesh.traverse(node => { if (node.isMesh) node.castShadow = true; });
                sceneRef.current.add(localPlayerRef.current.mesh); // Add to scene via ref
                sceneRef.current.add(remotePlayerRef.current.mesh); // Add to scene via ref
                localPlayerRef.current.mesh.visible = false;
                remotePlayerRef.current.mesh.visible = false;

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
                        weaponGroup.position.set(0.12, -0.18, -0.01); // Default FPV: Right, Down, Close
                        weaponGroup.scale.set(.10, .10, .10);
                        weaponGroup.rotation.set(0, Math.PI, 0);

                        weaponGroup.visible = false; // Hide initially

                    } catch (e) {
                         console.error(`FPV model '${modelPath}' failed to load or process:`, e);
                    }
                }
                
                // --- Load Grapple Visuals ---
                // Assign to ref
                fpvElementsRef.current.grappleRopeMaterial = new THREE.LineBasicMaterial({ color: 0xffffff, linewidth: 2 });
                
                // --- NEW: Create Projectile Pool ---
                const projectileGeometry = new THREE.SphereGeometry(0.05, 8, 8);
                const projectileMaterial = new THREE.MeshBasicMaterial({ color: 0xffff00 });
                for (let i = 0; i < 50; i++) { // Create a pool of 50 projectiles
                    const projectileMesh = new THREE.Mesh(projectileGeometry, projectileMaterial);
                    projectileMesh.visible = false;
                    sceneRef.current.add(projectileMesh);
                    projectilePoolRef.current.push(projectileMesh);
                }
                // --- End Projectile Pool ---

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
                                [CollisionGroup.PLAYER_BODY, CollisionGroup.GRENADE, CollisionGroup.PROJECTILE]
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

                const render = (timestamp) => {
                    if (!isMounted) return;
                    renderLoopIdRef.current = requestAnimationFrame(render);

                    const deltaTime = Math.min(0.05, (timestamp - lastTimestamp) / 1000); // Clamp delta time
                    const mixerDeltaTime = clock.getDelta(); // Use clock delta for mixers
                    lastTimestamp = timestamp;

                    // Get Local Player State
                    const localState = gameStateRef.current?.players?.[localPlayerUserId];

                    // --- NEW: Visual Projectile Animation ---
                    const stillActiveProjectiles = [];
                    for (const proj of activeVisualProjectilesRef.current) {
                        // Move projectile towards its target
                        const direction = proj.target.clone().sub(proj.mesh.position).normalize();
                        const distance = proj.mesh.position.distanceTo(proj.target);
                        const moveDistance = proj.speed * deltaTime;

                        if (distance <= moveDistance) {
                            // Reached target, return to pool
                            proj.mesh.visible = false;
                            projectilePoolRef.current.push(proj.mesh);
                        } else {
                            proj.mesh.position.add(direction.multiplyScalar(moveDistance));
                            stillActiveProjectiles.push(proj);
                        }
                    }
                    activeVisualProjectilesRef.current = stillActiveProjectiles;
                    // --- End Visual Projectile Animation ---

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
                            // Recover pitch
                            if (recoilStateRef.current.pitch > 0) {
                                const pitchRecovery = recoilStateRef.current.pitch * recoverySpeed * deltaTime;
                                recoilStateRef.current.pitch -= pitchRecovery;
                            } else {
                                recoilStateRef.current.pitch = 0;
                            }
                            // Recover yaw
                            if (Math.abs(recoilStateRef.current.yaw) > 0.001) {
                                const yawRecovery = recoilStateRef.current.yaw * recoverySpeed * deltaTime;
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
                            deltaTime: deltaTime, // Include frame delta time
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

                    // --- Physics Simulation --- (NEW - Step 2.2.1 Client Prediction)
                    // 1. Apply Local Input Prediction (Before stepping world)
                    if (localPlayerRef.current.rapierBody && localState && localState.state === 'alive') {
                        // Apply physics using the helper function
                        applyInputPhysics(
                            localPlayerRef.current.rapierBody,
                            inputStateRef.current.keys,
                            inputStateRef.current.lookQuat,
                            deltaTime,
                            localState.isOnGround // NEW: Pass ground status
                        );
                    }

                    // 2. Step Client Physics World
                    if (rapierWorldRef.current) {
                        rapierWorldRef.current.step();
                        if (localPlayerRef.current.rapierBody) {
                        }
                    }
                    // --- End Physics Simulation ---

                    // --- Update Player Mixers ---
                    localPlayerRef.current.mixer?.update(mixerDeltaTime);
                    remotePlayerRef.current.mixer?.update(mixerDeltaTime);

                    // --- Character Animation Logic (Movement Animations) ---
                    if (localPlayerRef.current.mixer && playerAnimationActionsRef.current) {
                        const keys = inputStateRef.current.keys;
                        const localState = gameStateRef.current?.players?.[localPlayerUserId];
                        
                        let targetAnim = null;

                        // >>> NEW: Prioritize action animations over movement <<<
                        if (localState && localState.isReloading) {
                            targetAnim = 'reloadIdle'; // Assuming 'reloadIdle' from mapping is for 3p model too
                        } else {
                            // Use the actual animation names from the GLB file
                            if (keys.W && keys.Shift) {
                                targetAnim = 'runFowardFire'; // Note: GLB has typo "Foward" instead of "Forward"
                            } else if (keys.W) {
                                targetAnim = 'walkForward';
                            } else if (keys.S) {
                                targetAnim = 'walkBackward';
                            } else if (keys.A) {
                                targetAnim = 'strafeLeft';
                            } else if (keys.D) {
                                targetAnim = 'strafeRight';
                            } else {
                                // Use logical 'idle' - mapping will convert to correct GLB animation
                                targetAnim = 'idle';
                            }
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
                        // NEW: Update mesh from predicted Rapier body state
                        if (localPlayerRef.current.rapierBody) {
                            // Fetch localCharConfig to get visualYOffset
                            const localCharConfig = CHARACTER_CONFIG_FPS[localPlayerCharacterId];
                            const localCharacterVisualYOffset = localCharConfig?.visualYOffset || 0.0;

                            const totalCapsuleHalfHeightForVisuals = PLAYER_VISUAL_TOTAL_HEIGHT / 2;

                            const predictedPos = localPlayerRef.current.rapierBody.translation();

                            const targetPosition = new THREE.Vector3(
                                predictedPos.x,
                                predictedPos.y - totalCapsuleHalfHeightForVisuals + localCharacterVisualYOffset,
                                predictedPos.z
                            );

                            // Fast position update for responsive FPS feel
                            localPlayerRef.current.mesh.position.lerp(targetPosition, 0.8);

                            // FPS CHARACTER ROTATION: Character should instantly face camera's horizontal direction
                            // In FPS games, the character model rotates immediately to match camera yaw
                            const characterYawQuaternion = new THREE.Quaternion();
                            characterYawQuaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), inputStateRef.current.characterYaw);
                            
                            // Instant rotation for FPS responsiveness (no lerp/slerp)
                            localPlayerRef.current.mesh.quaternion.copy(characterYawQuaternion);

                        } else if (localState && localState.position && localState.rotation) {
                            // Fallback to lerping server state if body missing (e.g., before spawn)
                            const localCharConfig = CHARACTER_CONFIG_FPS[localPlayerCharacterId];
                            const localCharacterVisualYOffset = localCharConfig?.visualYOffset || 0.0;
                            const totalCapsuleHalfHeightForVisuals = PLAYER_VISUAL_TOTAL_HEIGHT / 2;
                            const serverTargetPosition = new THREE.Vector3(
                                localState.position.x,
                                localState.position.y - totalCapsuleHalfHeightForVisuals + localCharacterVisualYOffset,
                                localState.position.z
                            );
                            localPlayerRef.current.mesh.position.lerp(serverTargetPosition, 0.8);
                            
                            // Use server rotation for mesh when physics body not available
                            const serverQuaternion = new THREE.Quaternion(localState.rotation.x, localState.rotation.y, localState.rotation.z, localState.rotation.w);
                            localPlayerRef.current.mesh.quaternion.copy(serverQuaternion);
                        }
                    }
                    if (remotePlayerRef.current.mesh) {
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
                         
                         if (remoteState && remoteState.position && remoteState.rotation && remoteState.state === 'alive') {
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
                            
                            console.log(`Remote player visible at: ${targetPosition.x.toFixed(2)}, ${targetPosition.y.toFixed(2)}, ${targetPosition.z.toFixed(2)}`);
                        } else {
                            remotePlayerRef.current.mesh.visible = false;
                            if (remoteState) {
                                console.log(`Remote player hidden - state: ${remoteState.state}, hasPosition: ${!!remoteState.position}, hasRotation: ${!!remoteState.rotation}`);
                            } else {
                                console.log('No remote player state found');
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
                            
                            // Calculate camera offset based on character's yaw rotation (not pitch)
                            tempCameraPos.copy(thirdPersonOffset);
                            const characterYawQuat = new THREE.Quaternion();
                            characterYawQuat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), inputStateRef.current.characterYaw);
                            tempCameraPos.applyQuaternion(characterYawQuat);
                            tempCameraPos.add(characterPos);
                            
                            // Fast camera positioning for FPS responsiveness
                            cameraRef.current.position.lerp(tempCameraPos, 0.6); // Much faster than 0.1
                            
                            // Camera should look in the full direction the player is looking (pitch + yaw)
                            // This gives proper FPS third-person aiming
                            const lookDirection = new THREE.Vector3(0, 0, 1);
                            const fullLookQuat = new THREE.Quaternion(
                                inputStateRef.current.lookQuat.x,
                                inputStateRef.current.lookQuat.y,
                                inputStateRef.current.lookQuat.z,
                                inputStateRef.current.lookQuat.w
                            );
                            lookDirection.applyQuaternion(fullLookQuat);
                            
                            // Instant camera look direction for FPS precision
                            tempLookAt.copy(cameraRef.current.position).add(lookDirection.multiplyScalar(10));
                            cameraRef.current.lookAt(tempLookAt);
                        } else {
                            // First-person camera logic (Look handled by mousemove, position follows predicted body)
                             if (localPlayerRef.current.rapierBody) {
                                 const predictedPos = localPlayerRef.current.rapierBody.translation();
                                const targetCameraPos = new THREE.Vector3(
                                    predictedPos.x,
                                    predictedPos.y + 1.6, // FPV camera height offset
                                    predictedPos.z
                                );
                                // Fast position update for FPS responsiveness
                                cameraRef.current.position.lerp(targetCameraPos, 0.7);
                             } else if (localState && localState.position) {
                                 // Fallback if body not ready
                                const targetCameraPos = new THREE.Vector3(
                                    localState.position.x,
                                    localState.position.y + 1.6,
                                    localState.position.z
                                );
                                cameraRef.current.position.lerp(targetCameraPos, 0.7);
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
                            rendererRef.current.render(fpvElementsRef.current.camera, cameraRef.current); // Render FPV Camera objects using main camera's projection
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
                        setConnectionStatus('connected');
                        setRetryAttempt(0);
                        if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);

                        // Send identification
                        newSocket.emit(MessageTypeFPS.IDENTIFY_PLAYER, { userId: localPlayerUserId, matchId: matchId });

                        // Setup listeners
                        newSocket.on(MessageTypeFPS.GAME_STATE_FPS, (gameState) => {
                            // NEW: Log detailed server state for local player
                            const serverPlayerState = gameState.players?.[localPlayerUserId];
                            if (serverPlayerState) {
                                console.log(`[Game State] Local player at: ${serverPlayerState.position?.x?.toFixed(2)}, ${serverPlayerState.position?.y?.toFixed(2)}, ${serverPlayerState.position?.z?.toFixed(2)}`);
                            }
                            
                            // Debug: Log all players in game state
                            if (gameState.players) {
                                console.log(`[Game State] Players in state:`, Object.keys(gameState.players));
                                for (const [userId, playerState] of Object.entries(gameState.players)) {
                                    console.log(`[Game State] Player ${userId}: state=${playerState.state}, pos=${playerState.position?.x?.toFixed(2)},${playerState.position?.y?.toFixed(2)},${playerState.position?.z?.toFixed(2)}`);
                                }
                            }
                            
                            if (!isMounted) return;

                            // NEW: Improved reconciliation with better smoothing
                            if (serverPlayerState && localPlayerRef.current.rapierBody) {
                                const currentTime = performance.now();
                                
                                // Update smoothing targets
                                smoothingStateRef.current.targetPosition.set(
                                    serverPlayerState.position.x,
                                    serverPlayerState.position.y,
                                    serverPlayerState.position.z
                                );
                                smoothingStateRef.current.targetVelocity.set(
                                    serverPlayerState.velocity.x,
                                    serverPlayerState.velocity.y,
                                    serverPlayerState.velocity.z
                                );
                                smoothingStateRef.current.targetRotation.set(
                                    serverPlayerState.rotation.x,
                                    serverPlayerState.rotation.y,
                                    serverPlayerState.rotation.z,
                                    serverPlayerState.rotation.w
                                );
                                smoothingStateRef.current.lastServerUpdate = currentTime;

                                // Handle input reconciliation if sequence numbers are available
                                if (serverPlayerState.lastProcessedSequence !== undefined) {
                                    const lastProcessedSequence = serverPlayerState.lastProcessedSequence;

                                    // Remove acknowledged inputs from pending buffer
                                    inputStateRef.current.pendingInputs = inputStateRef.current.pendingInputs.filter(
                                        input => input.sequence > lastProcessedSequence
                                    );

                                    const currentPos = localPlayerRef.current.rapierBody.translation();
                                    const currentVel = localPlayerRef.current.rapierBody.linvel();

                                    // Calculate difference between client and server
                                    const posDiff = Math.sqrt(
                                        Math.pow(currentPos.x - serverPlayerState.position.x, 2) +
                                        Math.pow(currentPos.y - serverPlayerState.position.y, 2) +
                                        Math.pow(currentPos.z - serverPlayerState.position.z, 2)
                                    );

                                    // Only apply correction if difference is significant, but use much gentler corrections
                                    if (posDiff > 0.05) { // Reduced threshold from 0.1
                                        // Use very gentle correction instead of snapping
                                        const correctionStrength = Math.min(0.1, posDiff * 0.2); // Much gentler correction
                                        
                                        const targetPos = {
                                            x: currentPos.x + (serverPlayerState.position.x - currentPos.x) * correctionStrength,
                                            y: currentPos.y + (serverPlayerState.position.y - currentPos.y) * correctionStrength,
                                            z: currentPos.z + (serverPlayerState.position.z - currentPos.z) * correctionStrength
                                        };
                                        
                                        localPlayerRef.current.rapierBody.setTranslation(targetPos, true);
                                    }

                                    // Much gentler velocity corrections
                                    const velDiff = Math.sqrt(
                                        Math.pow(currentVel.x - serverPlayerState.velocity.x, 2) +
                                        Math.pow(currentVel.y - serverPlayerState.velocity.y, 2) +
                                        Math.pow(currentVel.z - serverPlayerState.velocity.z, 2)
                                    );

                                    if (velDiff > 0.2) { // Reduced threshold
                                        const velCorrectionStrength = 0.05; // Much gentler velocity correction
                                        const targetVel = {
                                            x: currentVel.x + (serverPlayerState.velocity.x - currentVel.x) * velCorrectionStrength,
                                            y: currentVel.y + (serverPlayerState.velocity.y - currentVel.y) * velCorrectionStrength,
                                            z: currentVel.z + (serverPlayerState.velocity.z - currentVel.z) * velCorrectionStrength
                                        };
                                        localPlayerRef.current.rapierBody.setLinvel(targetVel, true);
                                    }

                                    // Re-apply pending inputs with reduced impact
                                    inputStateRef.current.pendingInputs.forEach((input, index) => {
                                        // Reduce the impact of re-applied inputs to prevent over-correction
                                        const scaledDeltaTime = input.deltaTime * 0.3; // Scale down re-applied inputs
                                        applyInputPhysics(localPlayerRef.current.rapierBody, input.keys, input.lookQuat, scaledDeltaTime, localState.isOnGround);
                                    });
                                }
                            }

                            // Always update the overall game state for rendering remote players, HUD, etc.
                            gameStateRef.current = gameState;
                            setGameStateVersion(v => v + 1); // Trigger UI updates if needed
                        });
                        // Add other listeners...
                        newSocket.on(MessageTypeFPS.SHOT_FIRED_VISUAL_FPS, (shotData) => {
                            if (!isMounted) return;
                        
                            if (projectilePoolRef.current.length > 0) {
                                const projectileMesh = projectilePoolRef.current.pop();
                                
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
                            } else {
                                console.warn("No available projectiles in the pool to display shot visual.");
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
                rendererRef.current.dispose();
            }
            // OrbitControls disposal removed, handled by DebugControls
        };
    }, [serverIp, serverPort, matchId, mapId, localPlayerCharacterId, opponentPlayerCharacterId, localPlayerUserId]); // Essential props that trigger re-init

    // --- NEW: Prepare props for the HUD ---
    const gameState = gameStateRef.current;
    const localPlayerState = gameState?.players?.[localPlayerUserId] || null;
    const opponentPlayerState = gameState?.players?.[opponentPlayerId] || null;

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

            {/* NEW: Render the HUD */}
            <HUD
                localPlayer={localPlayerState}
                opponent={opponentPlayerState}
                matchState={gameState?.matchState}
                roundWins={gameState?.roundWins}
                localPlayerUserId={localPlayerUserId}
                opponentPlayerId={opponentPlayerId}
            />

            {/* Potential UI Overlays */}
        </div>
    );
}

export default GameViewFPS; 