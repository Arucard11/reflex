import React, { useRef, useEffect, useCallback, useState } from 'react';
import * as THREE from 'three';
import * as CANNON from 'cannon-es'; // Import cannon-es
// Import network functions (assuming they exist)
import { connectWebSocket, disconnectWebSocket, setServerUpdateCallback, sendMessage, setReadyCallback } from '../network';
// Import shared message types
import { MessageType, GameMessage } from '@shared/types/messages';
// Import the hook
import { useThreeScene } from '../hooks/useThreeScene';
import { useInputControls, FrameInputState } from '../hooks/useInputControls'; // Import input hook
import { threeMeshToCannonBody } from '../utils/physicsUtils'; // Import the helper

// Physics Constants (moved outside for clarity)
const fixedTimeStep = 1 / 60; // seconds
const maxSubSteps = 3; // Max physics steps per frame

// Network/Heartbeat Constants
const PING_INTERVAL = 5000; // ms (5 seconds)
const DISCONNECT_TIMEOUT = 15000; // ms (15 seconds)

const GameView: React.FC = () => {
    const mountRef = useRef<HTMLDivElement>(null);
    const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
    const animationFrameId = useRef<number | null>(null);
    const clockRef = useRef(new THREE.Clock());
    const [modelsLoaded, setModelsLoaded] = useState(false);

    // --- Physics Setup Function for Map (defined before hooks that use it) ---
    const setupMapPhysics = useCallback((mapGroup: THREE.Group) => {
        const world = physicsWorldRef.current; 
        if (!world) {
            console.error("setupMapPhysics: Physics world not ready.");
            return;
        }

        console.log("setupMapPhysics: Traversing map model and creating physics bodies...");
        let bodiesAdded = 0;
        mapGroup.traverse((node) => {
            if ((node as THREE.Mesh).isMesh) {
                const mesh = node as THREE.Mesh;
                 // Attempt to create a physics body for the mesh
                 const body = threeMeshToCannonBody(mesh); 
                 if (body) {
                    // Keep this log commented unless needed for specific debugging
                    // console.log(`setupMapPhysics: Adding body for mesh: ${mesh.name || 'Unnamed Mesh'}`);
                    world.addBody(body);
                    bodiesAdded++;
                    // TODO: Store references to these bodies if they need cleanup later
                 }
             }
        });

        if (bodiesAdded > 0) {
            console.log(`setupMapPhysics: Added ${bodiesAdded} physics bodies for the map.`);
        } else {
            console.warn("setupMapPhysics: No suitable meshes found in the map model to create physics bodies.");
        }

    }, []); // Dependency on refs will be implicit via parent scope

    // --- Hooks --- 
    const { sceneRef, characterModelRef, renderScene } = useThreeScene({
        mountRef,
        characterModelPath: '/models/animatedCharacter.glb',
        mapModelPath: '/models/map1.glb',
        onModelsLoaded: useCallback((models: { 
            character: THREE.Group; 
            map: THREE.Group; 
            animations: THREE.AnimationClip[]; // <-- Receive animations
        }) => {
            console.log("GameView: Models loaded via hook!", models);
            setModelsLoaded(true);

            // --- Animation Setup --- 
            if (models.character && models.animations.length > 0) {
                const mixer = new THREE.AnimationMixer(models.character);
                animationMixerRef.current = mixer;
                const actionsMap = new Map<string, THREE.AnimationAction>();
                models.animations.forEach((clip) => {
                    actionsMap.set(clip.name, mixer.clipAction(clip));
                    console.log(`GameView: Stored animation action: ${clip.name}`);
                });
                animationActionsRef.current = actionsMap;

                // Attempt to play a default animation (adjust name if needed)
                const idleAction = actionsMap.get('Idle') || actionsMap.get('idle') || actionsMap.get(models.animations[0].name); // Fallback to first animation
                if (idleAction) {
                    idleAction.play();
                    console.log(`GameView: Playing default animation: ${idleAction.getClip().name}`);
                } else {
                    console.warn("GameView: Could not find default 'Idle' animation.");
                }
            } else {
                console.warn("GameView: Character model loaded, but no animations found or model missing.");
            }
            // --- End Animation Setup ---

            // 1. Setup map physics *first*
            setupMapPhysics(models.map);

            // 2. *After* map physics, create player physics body
            const world = physicsWorldRef.current;
            if (world) {
                 console.log("GameView: Map physics should be ready, creating player body...");
                 const visualScaleFactor = 0.5; // Match the scale in useThreeScene
                 const baseRadius = 0.5; // Original radius assumption
                 const playerRadius = baseRadius * visualScaleFactor;
                 const playerShape = new CANNON.Sphere(playerRadius);
                 
                 // Get default material safely from the world instance
                 let playerMaterial: CANNON.Material | undefined;
                 if (world.defaultContactMaterial?.materials?.length > 0) {
                     playerMaterial = world.defaultContactMaterial.materials[0];
                 } else {
                     console.warn("GameView: Default physics material not found on world, using fallback.");
                     // Create a fallback material if needed, although world should have one
                     playerMaterial = new CANNON.Material("playerDefault");
                 }

                 const playerBody = new CANNON.Body({
                     mass: 70, // Example mass
                     material: playerMaterial, 
                     shape: playerShape,
                     angularDamping: 0.8, // Reduce spinning
                     linearDamping: 0.1 // Optional air resistance/friction
                 });
                 playerBody.position.set(0, 5, 0); // START HIGHER to ensure it's above potential ground
                 world.addBody(playerBody);
                 playerBodyRef.current = playerBody; // Assign the ref HERE
                 console.log("GameView: Cannon-es player sphere body added AFTER map setup.");
             } else {
                 console.error("GameView onModelsLoaded: Could not add player body, physics world not ready.");
             }
        }, [setupMapPhysics, setModelsLoaded]) // Dependencies: setupMapPhysics (callback), setModelsLoaded (state setter)
    });
    const { getFrameInput, accumulatedYaw, accumulatedPitch, isPointerLocked } = useInputControls({ mountRef });
    
    // --- Physics & Heartbeat Refs (Single Declaration Block) ---
    const physicsWorldRef = useRef<CANNON.World | null>(null);
    const playerBodyRef = useRef<CANNON.Body | null>(null);
    const pingIntervalId = useRef<NodeJS.Timeout | null>(null);
    const disconnectTimeoutId = useRef<NodeJS.Timeout | null>(null);
    // Add refs for animations
    const animationMixerRef = useRef<THREE.AnimationMixer | null>(null);
    const animationActionsRef = useRef<Map<string, THREE.AnimationAction> | null>(null);
    // --- End Refs ---

    // Resize Handler (Still needed for camera)
    const handleResize = useCallback(() => {
        if (!mountRef.current || !cameraRef.current) return;
        const width = mountRef.current.clientWidth;
        const height = mountRef.current.clientHeight;
        cameraRef.current.aspect = width / height;
        cameraRef.current.updateProjectionMatrix();
        // Renderer size is handled by useThreeScene hook
        console.log("GameView: Resized - Camera updated.");
    }, [mountRef]); // Add cameraRef dependency? Mount ref should be stable

    // Animation Loop (Updated dependencies)
    const animate = useCallback(() => {
        const camera = cameraRef.current;
        const characterModel = characterModelRef.current;
        const playerBody = playerBodyRef.current;

        if (!camera || !playerBody) { // Also wait for playerBody
            console.warn("Animate loop waiting: Camera or PlayerBody not ready.");
            animationFrameId.current = requestAnimationFrame(animate);
            return;
        }

        animationFrameId.current = requestAnimationFrame(animate);

        // --- Get Input --- 
        const input: FrameInputState = getFrameInput(); // Get input state for this frame

        // --- Physics Update --- 
        const deltaTime = clockRef.current.getDelta();
        if (physicsWorldRef.current) {
            // Apply Yaw rotation from input to the physics body
            const yaw = accumulatedYaw.current;
            const q = new CANNON.Quaternion();
            q.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), yaw); // Yaw around Y axis
            playerBody.quaternion.copy(q);

            // TODO: Apply movement based on input (forward, backward, etc.)
            // Example (Needs refinement for direction based on yaw):
            const moveSpeed = 5;
            const moveDirection = new CANNON.Vec3(0, 0, 0);
            if (input.forward) moveDirection.z -= 1;
            if (input.backward) moveDirection.z += 1;
            if (input.left) moveDirection.x -= 1;
            if (input.right) moveDirection.x += 1;
            
            // Rotate moveDirection by player yaw
            moveDirection.normalize(); // Normalize in place
            const moveVelocity = moveDirection.scale(moveSpeed); // Scale the normalized vector
            const worldVelocity = playerBody.quaternion.vmult(moveVelocity);
            playerBody.velocity.x = worldVelocity.x;
            playerBody.velocity.z = worldVelocity.z;
            // Keep existing y velocity for gravity/jumps
            // playerBody.velocity.y = worldVelocity.y; 

            // TODO: Implement Jump logic (input.jump)
            // if (input.jump && playerBody.position.y < 0.1) { // Simple ground check
            //    playerBody.velocity.y = 5; // Adjust jump force
            // }
            
            physicsWorldRef.current.step(fixedTimeStep, deltaTime, maxSubSteps);

            // --- Animation Update --- 
            if (animationMixerRef.current) {
                animationMixerRef.current.update(deltaTime);
            }
            // --- End Animation Update ---

            // Sync visual character with physics body
            if (characterModel) {
                characterModel.position.copy(playerBody.position as unknown as THREE.Vector3);
                // Let physics handle character model rotation based on playerBody quaternion
                characterModel.quaternion.copy(playerBody.quaternion as unknown as THREE.Quaternion);
            }
        }

        // --- Camera Update (Third-Person with Pitch/Yaw) ---
        if (modelsLoaded) { 
            const playerPhysicsPosition = new THREE.Vector3(
                playerBody.position.x,
                playerBody.position.y,
                playerBody.position.z
            );
            
            // Define base offset (behind the player)
            const baseOffset = new THREE.Vector3(0, 2.0, 5.0); // Adjusted Y and Z for better view

            // Create Quaternions for Yaw and Pitch
            const yawQuaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), accumulatedYaw.current);
            const pitchQuaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), accumulatedPitch.current);
            
            // Combine rotations: Apply Yaw first, then Pitch
            const combinedRotation = yawQuaternion.multiply(pitchQuaternion); // Order might matter

            // Apply combined rotation to the base offset vector
            const rotatedOffset = baseOffset.clone().applyQuaternion(combinedRotation);

            // Calculate desired camera position
            const desiredPosition = playerPhysicsPosition.clone().add(rotatedOffset);
            
            // TODO: Add camera collision check (raycast from player towards desiredPosition)
            
            camera.position.copy(desiredPosition); 

            // Look at a point slightly above the player's physics position
            const lookAtTarget = playerPhysicsPosition.clone().add(new THREE.Vector3(0, 1.0, 0)); 
            camera.lookAt(lookAtTarget);

            // Keep camera logs commented unless needed for specific debugging
            // console.log(`Camera Pos: ${desiredPosition.x.toFixed(2)}, ${desiredPosition.y.toFixed(2)}, ${desiredPosition.z.toFixed(2)}`);
            // console.log(`LookAt: ${lookAtTarget.x.toFixed(2)}, ${lookAtTarget.y.toFixed(2)}, ${lookAtTarget.z.toFixed(2)}`);

        }

        // --- Rendering ---
        renderScene(camera);

    }, [renderScene, modelsLoaded, characterModelRef, getFrameInput, accumulatedYaw, accumulatedPitch]); // Add hook outputs to dependencies

    // Initialization Effect
    useEffect(() => {
        console.log("GameView: useEffect START - Physics + Network (Scene/Render handled by hook)");
        const currentMount = mountRef.current;
        if (!currentMount) {
            console.error("GameView: Mount point not found!");
            return;
        }

        // --- Basic Three.js Setup ---
        // Scene, Renderer, and Lighting are now handled by useThreeScene hook

        // 3. Camera (Still needs to be initialized here or moved to a hook)
        const camera = new THREE.PerspectiveCamera(
            75, // FOV
            currentMount.clientWidth / currentMount.clientHeight, // Aspect Ratio
            0.1, // Near clipping plane
            1000 // Far clipping plane
        );
        // Position camera to potentially see loaded models at origin
        camera.position.set(0, 1.5, 5); // Slightly elevated, further back
        camera.lookAt(0, 0, 0); // Look at the origin
        cameraRef.current = camera;
        // Add camera to the scene managed by the hook *once* during setup
        if (sceneRef.current) {
             console.log("GameView useEffect: Adding camera to scene provided by hook.");
             sceneRef.current.add(camera);
         } else {
             console.warn("GameView useEffect: Scene ref not available from hook when trying to add camera initially.");
             // Consider moving camera creation/addition into the useThreeScene hook or its callback
         }


    

        // --- Cannon-es Setup ---
        const world = new CANNON.World();
        world.gravity.set(0, -9.82, 0);
        world.broadphase = new CANNON.NaiveBroadphase();
        world.solver = new CANNON.GSSolver();
        (world.solver as CANNON.GSSolver).iterations = 10;
        physicsWorldRef.current = world;
        console.log("GameView: Cannon-es world created.");

        // Physics Materials
        const defaultMaterial = new CANNON.Material("default");
        const defaultContactMaterial = new CANNON.ContactMaterial(
            defaultMaterial, defaultMaterial,
            { friction: 0.1, restitution: 0.7 }
        );
        world.addContactMaterial(defaultContactMaterial);
        world.defaultContactMaterial = defaultContactMaterial;

     

        // --- Network Setup ---
        console.log("GameView: Setting up server update callback...");
        // Ensure message has a proper type, GameMessage is a good base
        setServerUpdateCallback((message: GameMessage) => { 
            // Keep this commented unless needed for specific debugging
            // console.log('GameView: Received message from server:', message);

            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
            if (message.type === MessageType.PONG) { // Suppress potential false positive comparison warning
                // **Heartbeat Logic: Reset timeout on PONG**
                // 1. Clear any existing timeout
                if (disconnectTimeoutId.current) {
                    clearTimeout(disconnectTimeoutId.current);
                }
                // 2. Set a new timeout to check for the *next* PONG
                disconnectTimeoutId.current = setTimeout(() => {
                    console.error("GameView: Disconnect timeout reached (no PONG received recently). Connection likely lost.");
                    // Handle disconnection
                    disconnectWebSocket(); // Clean up WebSocket
                    if (pingIntervalId.current) {
                         clearInterval(pingIntervalId.current); // Stop pings if disconnected
                         pingIntervalId.current = null;
                    }
                    disconnectTimeoutId.current = null; // Clear the ref after firing
                }, DISCONNECT_TIMEOUT);
            }
            // Handle other message types (e.g., GameStateUpdate) here
            // if (message.type === MessageType.GAME_STATE_UPDATE) {
            //     // Process game state
            // }
        });

        console.log("GameView: Connecting WebSocket...");
        // Set a callback for when connection is ready (includes getting client ID)
        setReadyCallback(() => {
            console.log("GameView: WebSocket ready (connected + client ID received). Starting heartbeat.");
            // Start heartbeat ping ONLY when connection is fully ready
            // Clear any previous interval just in case
            if (pingIntervalId.current) clearInterval(pingIntervalId.current);

            pingIntervalId.current = setInterval(() => {
                // Send ping message - This interval ONLY sends pings now
                sendMessage(MessageType.PING, { timestamp: Date.now() }); 

                // REMOVED: Do not set the disconnect timeout here anymore
                // if (!disconnectTimeoutId.current) { ... }
            }, PING_INTERVAL);
        });

        // Initiate connection - no .then()/.catch() needed here now
        connectWebSocket(); 


        // --- Start Render Loop & Resize Listener Setup ---
        if (animationFrameId.current === null) {
            console.log("GameView: Starting animation loop.");
            handleResize(); // Call once after initial setup
            console.log("GameView: Initial resize handled.");
            animationFrameId.current = requestAnimationFrame(animate);
        }

        window.addEventListener('resize', handleResize);
        console.log("GameView: Added resize listener.");

        // --- Cleanup ---
        return () => {
            console.log("GameView: Cleanup START - Physics + Network");
            // Stop animation loop
            if (animationFrameId.current) {
                cancelAnimationFrame(animationFrameId.current);
                animationFrameId.current = null;
                console.log("GameView: Animation frame cancelled.");
            }

            // Remove Resize Listener
            window.removeEventListener('resize', handleResize);
            console.log("GameView: Removed resize listener.");

            // Dispose Three.js objects (minimal, scene hook handles its own objects)
            // Remove camera if it was added to the scene from the hook
            if (sceneRef.current && cameraRef.current && cameraRef.current.parent === sceneRef.current) {
                 sceneRef.current.remove(cameraRef.current);
                 console.log("GameView cleanup: Removed camera from scene.");
            }
            // REMOVE disposal of test cube/ground visuals
            // cubeMeshRef.current?.geometry.dispose();
            // if (cubeMeshRef.current?.material instanceof THREE.Material) {
            //     cubeMeshRef.current.material.dispose();
            // }
            // groundMesh.geometry.dispose(); // groundMesh is not defined here anymore
            // if (groundMesh.material instanceof THREE.Material) { // groundMesh is not defined here anymore
            //     groundMesh.material.dispose();
            // }

            // Remove player physics body
            if (physicsWorldRef.current && playerBodyRef.current) {
                physicsWorldRef.current.removeBody(playerBodyRef.current);
                console.log("GameView cleanup: Removed player physics body.");
            }
            // Remove map physics bodies (if any were added - requires tracking them)
            // TODO: Add cleanup for map bodies

            // REMOVED cleanup for test cube physics body

            // REMOVED cleanup for old ground plane

            // Renderer and main scene cleanup is handled by useThreeScene hook

            // Clear refs
            // rendererRef.current = null; // Handled by hook
            // sceneRef.current = null; // Handled by hook
            cameraRef.current = null;
            physicsWorldRef.current = null;
            playerBodyRef.current = null; // Clear player body ref

            // --- Network Cleanup ---
            console.log("GameView: Disconnecting WebSocket and clearing intervals...");
            if (pingIntervalId.current) {
                clearInterval(pingIntervalId.current);
                pingIntervalId.current = null;
            }
            if (disconnectTimeoutId.current) {
                clearTimeout(disconnectTimeoutId.current);
                disconnectTimeoutId.current = null;
            }
            disconnectWebSocket();

            console.log("GameView: Cleanup complete.");
        };
    }, []); // <-- FORCE single run on mount/unmount

    // Add basic styles to indicate pointer lock state (optional)
    const divStyle: React.CSSProperties = {
        width: '100%', 
        height: '100vh', 
        display: 'block',
        cursor: isPointerLocked.current ? 'none' : 'pointer' // Hide cursor when locked
    };

    return <div ref={mountRef} style={divStyle} />;
};

export default GameView;
