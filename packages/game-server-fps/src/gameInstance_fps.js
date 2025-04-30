// Import yargs
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const { register, tickDurationHist } = require('./metrics.js');

// Import Core Server Dependencies
const RAPIER = require('@dimforge/rapier3d-compat');
const { Server } = require("socket.io");
const http = require('http');
const fs = require('fs'); // For loading map data/keypair later
// NEW: Import express for metrics server
const express = require('express');

console.log('FPS Game Instance Starting...');

// --- Argument Parsing (Placeholder) ---
// Will be populated by parseArguments function
let config = {};

// --- Core Game State Variables ---
let rapierWorld = null;
let io = null;
let gameLoopInterval = null; // Game loop starts later
let players = {}; // Authoritative player state mapped by userId
let connectedPlayers = {}; // Socket info mapped by userId
let currentMatchState = 'loading'; // Initial state
// let timeRemaining = 0; // Managed by match flow later

// NEW: Define variables for imported types in the module scope
let MapId, CharacterId, GrenadeType, MessageTypeFPS, MAP_CONFIGS_FPS, CHARACTER_CONFIG_FPS, WEAPON_CONFIG_FPS, ABILITY_CONFIG_FPS;

// --- Initialization Sequence ---
async function initialize() {
    console.log('Initializing Core Systems...');

    // NEW: Dynamically import shared types first
    try {
        const sharedTypes = await import('@shared-types/game-fps');
        MapId = sharedTypes.MapId;
        CharacterId = sharedTypes.CharacterId;
        GrenadeType = sharedTypes.GrenadeType;
        MessageTypeFPS = sharedTypes.MessageTypeFPS;
        MAP_CONFIGS_FPS = sharedTypes.MAP_CONFIGS_FPS;
        CHARACTER_CONFIG_FPS = sharedTypes.CHARACTER_CONFIG_FPS;
        WEAPON_CONFIG_FPS = sharedTypes.WEAPON_CONFIG_FPS;
        ABILITY_CONFIG_FPS = sharedTypes.ABILITY_CONFIG_FPS;
        console.log("Shared types loaded successfully.");
    } catch (error) {
        console.error("Failed to load shared types:", error);
        process.exit(1); // Cannot proceed without shared types
    }

    // Step 1: Parse Args (1.2.1)
    parseArguments();

    // Step 2: Init Rapier (1.2.2)
    await initRapier();

    // Step 3: Load Specific Map Physics (1.2.2)
    loadMapPhysics(config.mapId);

    // Step 4: Initialize Player States (1.2.2)
    initializePlayerStates();

    // Step 5: Init Socket.IO (1.2.2)
    initSocketIO(); // Creates server but doesn't start listening yet

    // Step 6: Start Listener & Signal Readiness (1.2.3)
    await signalReadyToPlatform(); // Contains the httpServer.listen call

    // Step 7: Start Game Loop (Deferred to Phase 3)
    // startGameLoop(); // Moved out of initial setup

    console.log('Initialization Complete. Waiting for connections...');
    // currentMatchState is set to 'waiting' inside signalReadyToPlatform
}

// --- Implementation Functions ---

// Step 1: Argument Parsing (1.2.1)
function parseArguments() {
    console.log('Parsing Arguments...');
    const argv = yargs(hideBin(process.argv))
        .option('port', { alias: 'p', type: 'number', demandOption: true, describe: 'Port to listen on' })
        .option('matchId', { type: 'string', demandOption: true, describe: 'Unique Match ID' })
        // NEW: Map Selection (Plan 1.2.1)
        .option('mapId', { choices: Object.values(MapId), demandOption: true, describe: 'ID of the map to load' })
        // Player Info (Plan 1.2.1)
        .option('player1UserId', { type: 'string', demandOption: true })
        .option('player1Wallet', { type: 'string', demandOption: true })
        .option('player1CharId', { choices: Object.values(CharacterId), demandOption: true, describe: 'Character ID for Player 1' })
        .option('player2UserId', { type: 'string', demandOption: true })
        .option('player2Wallet', { type: 'string', demandOption: true })
        .option('player2CharId', { choices: Object.values(CharacterId), demandOption: true, describe: 'Character ID for Player 2' })
        // Other platform args (Existing)
        .option('betAmountLamports', { type: 'number', demandOption: true })
        .option('serverAuthorityKeyPath', { type: 'string', demandOption: true, describe: 'Path to server authority keypair file' })
        .option('rpcUrl', { type: 'string', demandOption: true, describe: 'Solana RPC URL' })
        .option('platformApiUrl', { type: 'string', demandOption: true, describe: 'Platform internal API URL' })
        .option('programIdEscrow', { type: 'string', demandOption: true })
        .option('programIdProfile', { type: 'string', demandOption: true })
        .option('gameConfigPath', { type: 'string', describe: 'Optional path to override game config JSON' })
        .help()
        .alias('help', 'h')
        .parseSync();

    // Store parsed args in the global 'config' object (Plan 1.2.1)
    config = {
        port: argv.port,
        matchId: argv.matchId,
        mapId: argv.mapId,
        playersInfo: {
            p1: { userId: argv.player1UserId, wallet: argv.player1Wallet, charId: argv.player1CharId },
            p2: { userId: argv.player2UserId, wallet: argv.player2Wallet, charId: argv.player2CharId }
        },
        betAmountLamports: argv.betAmountLamports,
        serverAuthorityKeyPath: argv.serverAuthorityKeyPath,
        rpcUrl: argv.rpcUrl,
        platformApiUrl: argv.platformApiUrl,
        programIds: {
            escrow: argv.programIdEscrow,
            profile: argv.programIdProfile
        },
        gameConfigPath: argv.gameConfigPath,
    };
    console.log('Parsed Config:', config);
}

// Step 2: Initialize Rapier (1.2.2 - Existing, Verified)
async function initRapier() {
    console.log('Initializing Rapier...');
    await RAPIER.init();
    const gravity = { x: 0.0, y: -9.81, z: 0.0 };
    rapierWorld = new RAPIER.World(gravity);
    console.log('Rapier World created.');
}

// Helper to create the player's physics body (NEW - Step 2.2.1 related)
function createPlayerPhysicsBody(playerId, position) {
    console.log(`Creating physics body for ${playerId} at ${JSON.stringify(position)}`);
    const playerState = players[playerId];
    if (!playerState) {
        console.error(`Cannot create body for unknown player: ${playerId}`);
        return null;
    }

    // Rigid body setup (Dynamic, Locked Rotations)
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(position.x, position.y, position.z)
        .setCanSleep(false) // Prevent sleeping for active players
        .setCcdEnabled(true) // Enable CCD for potentially fast movement
        .lockRotations(); // Prevent capsule tipping

    const body = rapierWorld.createRigidBody(bodyDesc);

    // Collider setup (Capsule Shape)
    const playerHeight = 1.8; // Example dimensions
    const playerRadius = 0.4;
    const colliderDesc = RAPIER.ColliderDesc.capsuleY(playerHeight / 2 - playerRadius, playerRadius)
        .setDensity(1.0) // Affects mass
        .setFriction(0.7)
        .setRestitution(0.2)
        // TODO: Set collision groups properly
        // .setCollisionGroups(interactionGroups(CollisionGroup.PLAYER_BODY, [CollisionGroup.WORLD, CollisionGroup.PLAYER_BODY, CollisionGroup.GRENADE, ...]))
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS); // For detecting ground contact, etc.

    // Store player ID in collider userdata for hit detection
    colliderDesc.setUserData({ type: 'playerBody', playerId: playerId });

    rapierWorld.createCollider(colliderDesc, body); // Attach collider to body

    console.log(`Physics body created for ${playerId} with handle: ${body.handle}`);
    return body; // Return the created body
}

// Step 3: Load Map Physics (1.2.2)
function loadMapPhysics(mapId) {
    console.log(`Loading Physics for Map ID: ${mapId}...`);
    const mapConfig = MAP_CONFIGS_FPS[mapId];
    if (!mapConfig) {
        throw new Error(`Map config not found for mapId: ${mapId}`);
    }
    const physicsData = mapConfig.physicsData;
    if (!physicsData) {
        console.warn(`No physicsData found for map ${mapId}`);
        return;
    }

    // Load from colliders array (Plan 1.2.2)
    if (physicsData.colliders) {
        physicsData.colliders.forEach(colliderData => {
            let colliderDesc;
            let rigidBodyDesc = RAPIER.RigidBodyDesc.fixed(); // Assume static map geometry

            if (colliderData.position) {
                rigidBodyDesc.setTranslation(colliderData.position.x, colliderData.position.y, colliderData.position.z);
            }
            // TODO: Set rotation if provided: rigidBodyDesc.setRotation(...)

            if (colliderData.type === 'cuboid') {
                if (!colliderData.dimensions) { console.warn('Cuboid missing dimensions'); return; }
                colliderDesc = RAPIER.ColliderDesc.cuboid(colliderData.dimensions.x / 2, colliderData.dimensions.y / 2, colliderData.dimensions.z / 2);
            } else if (colliderData.type === 'ball') {
                // Example: colliderDesc = RAPIER.ColliderDesc.ball(colliderData.radius);
                console.warn(`Collider type '${colliderData.type}' creation not fully implemented.`); return;
            } else if (colliderData.type === 'capsule'){
                 console.warn(`Collider type '${colliderData.type}' creation not fully implemented.`); return;
            } else {
                console.warn(`Unsupported collider type: ${colliderData.type}`);
                return;
            }

            if (colliderDesc) {
                // TODO: Set friction, restitution, collision groups etc. if needed
                // colliderDesc.setCollisionGroups(interactionGroups(CollisionGroup.WORLD, [CollisionGroup.PLAYER_BODY, CollisionGroup.PLAYER_SHOOTER]));
                const body = rapierWorld.createRigidBody(rigidBodyDesc);
                rapierWorld.createCollider(colliderDesc, body); // Pass body handle
                console.log(`Created map collider: ${colliderData.type} at ${JSON.stringify(colliderData.position)}`);
            }
        });
    }

    // Load from trimesh data (Plan 1.2.2)
    if (physicsData.vertices && physicsData.indices) {
        console.log(`Creating trimesh collider for map ${mapId}...`);
        const rigidBodyDesc = RAPIER.RigidBodyDesc.fixed();
        const body = rapierWorld.createRigidBody(rigidBodyDesc);
        const trimeshDesc = RAPIER.ColliderDesc.trimesh(physicsData.vertices, physicsData.indices);
        // TODO: Set collision groups
        // trimeshDesc.setCollisionGroups(interactionGroups(CollisionGroup.WORLD, [CollisionGroup.PLAYER_BODY, CollisionGroup.PLAYER_SHOOTER]));
        rapierWorld.createCollider(trimeshDesc, body);
    }

    console.log(`Physics for Map ${mapId} Loaded.`);
}

// Step 4: Initialize Player States (1.2.2)
function initializePlayerStates() {
    console.log('Initializing player states...');
    const p1Info = config.playersInfo.p1;
    const p2Info = config.playersInfo.p2;

    [p1Info, p2Info].forEach((playerInfo) => {
        const charConfig = CHARACTER_CONFIG_FPS[playerInfo.charId];
        if (!charConfig) {
            throw new Error(`Character config not found for charId: ${playerInfo.charId}`);
        }
        const defaultWeapon1 = 'rifle'; // Ensure this is a valid key in WEAPON_CONFIG_FPS
        const defaultWeapon2 = 'sniper'; // Ensure this is a valid key in WEAPON_CONFIG_FPS
        const weapon1Config = WEAPON_CONFIG_FPS[defaultWeapon1];
        const weapon2Config = WEAPON_CONFIG_FPS[defaultWeapon2];

        players[playerInfo.userId] = {
            userId: playerInfo.userId,
            wallet: playerInfo.wallet,
            characterId: playerInfo.charId,
            state: 'waiting', // Initial state before spawn
            position: { x: 0, y: 1, z: 0 }, // Placeholder, set on spawn
            rotation: { x: 0, y: 0, z: 0, w: 1 },
            velocity: { x: 0, y: 0, z: 0 },
            health: charConfig.baseHealth,
            shield: charConfig.baseShield,
            kills: 0,
            deaths: 0,
            lastProcessedSequence: -1,
            grenades: { // Initial count per round (Plan 1.2.2)
                [GrenadeType.SEMTEX]: 1,
                [GrenadeType.FLASHBANG]: 1,
                [GrenadeType.FRAG]: 1,
            },
            ability1CooldownRemaining: 0,
            ability1Type: charConfig.ability1,
            weaponSlots: [defaultWeapon1, defaultWeapon2],
            activeWeaponSlot: 0,
            currentAmmoInClip: weapon1Config?.ammoCapacity || 0,
            // Store ammo per slot internally for reload/switch logic (See Plan 3.1.4)
            ammoInClipSlot0: weapon1Config?.ammoCapacity || 0,
            ammoInClipSlot1: weapon2Config?.ammoCapacity || 0,
            grappleState: { active: false, targetPoint: null, startTime: null },
            isReloading: false,
            // Server-internal state (placeholders)
            rapierBody: null,
            positionHistory: [],
            inputHistory: {},
            serverLastFireTime: 0,
            currentSpread: weapon1Config?.baseSpread || 0,
        };
        console.log(`Initialized state for ${playerInfo.userId} (Char: ${playerInfo.charId})`);

        // NEW: Create the physics body immediately (at a temporary off-map location)
        // Respawn logic will move it to the correct spawn point later.
        const initialPosition = { x: 0, y: -500, z: index * 10 }; // Start off-map
        players[playerInfo.userId].rapierBody = createPlayerPhysicsBody(playerInfo.userId, initialPosition);
    });
}

// Step 5: Initialize Socket.IO (1.2.2 + 1.3.3 Server)
function initSocketIO() {
    console.log(`Initializing Socket.IO on port ${config.port}...`);
    const httpServer = http.createServer();
    io = new Server(httpServer, {
        cors: { origin: "*", methods: ["GET", "POST"] } // Restrict in prod!
    });

    // --- Socket.IO Connection Logic (REVISED HANDSHAKE) ---
    io.on('connection', (socket) => {
        console.log(`Client socket connected: ${socket.id}, awaiting identification...`);

        const identificationTimeout = setTimeout(() => {
            console.warn(`Socket ${socket.id} did not identify in time. Disconnecting.`);
            socket.disconnect(true);
        }, 5000); // 5 second timeout to identify

        // Listen for the client to identify itself
        socket.once(MessageTypeFPS.IDENTIFY_PLAYER, (data) => {
            clearTimeout(identificationTimeout);
            const receivedUserId = data?.userId;

            console.log(`Socket ${socket.id} identified as User ID: ${receivedUserId}`);

            // --- Validate User ID --- //
            const p1UserId = config.playersInfo.p1.userId;
            const p2UserId = config.playersInfo.p2.userId;

            if (!receivedUserId || (receivedUserId !== p1UserId && receivedUserId !== p2UserId)) {
                console.warn(`Socket ${socket.id} provided invalid User ID: ${receivedUserId}. Expected ${p1UserId} or ${p2UserId}. Disconnecting.`);
                socket.disconnect(true);
                return;
            }

            // --- Associate Socket with Validated User ID --- //
            // Check if this user is already connected with a different socket
            if (connectedPlayers[receivedUserId] && connectedPlayers[receivedUserId].socketId !== socket.id) {
                console.log(`Player ${receivedUserId} reconnected with new socket ${socket.id}. Disconnecting old socket ${connectedPlayers[receivedUserId].socketId}.`);
                connectedPlayers[receivedUserId].socket?.disconnect(true);
                // Allow the new socket to take over below
            }

            // Associate the socket
            connectedPlayers[receivedUserId] = { socketId: socket.id, socket: socket };
            if (players[receivedUserId]) { // Ensure player state exists
                 players[receivedUserId].state = 'connected';
            } else {
                 console.error(`State object missing for player ${receivedUserId} upon connection!`);
                 // Handle this error appropriately
            }
            console.log(`Socket ${socket.id} successfully associated with User ID: ${receivedUserId}`);

            // Send initial full game state to the connecting player
            socket.emit(MessageTypeFPS.GAME_STATE_FPS, getFullGameStatePayload());

            // TODO: Trigger match start countdown when both players are connected (Phase 3)
            // if (connectedPlayers[p1UserId] && connectedPlayers[p2UserId]) { startMatchCountdown(); }

            // --- Standard Event Listeners --- //
            socket.on('disconnect', (reason) => {
                console.log(`Client socket disconnected: ${socket.id}, Reason: ${reason}`);

                // Introduce a small delay before processing the disconnect fully
                // This gives the rapid reconnect (from StrictMode) a chance to identify
                setTimeout(() => {
                    // Check if this socket ID is still associated with a player
                    // (i.e., hasn't been replaced by a quick reconnect)
                    let disconnectedUserId = null;
                    for (const userId in connectedPlayers) {
                        if (connectedPlayers[userId]?.socketId === socket.id) {
                            disconnectedUserId = userId;
                            break; // Found the user associated with the disconnecting socket
                        }
                    }

                    // Only process disconnect if the socket ID wasn't replaced by a newer one
                    if (disconnectedUserId) {
                        // Check if the disconnecting socket is STILL the active one for this user
                        if (connectedPlayers[disconnectedUserId]?.socketId === socket.id) {
                            console.log(`Processing delayed disconnect for User ${disconnectedUserId} (Active Socket ${socket.id})`);
                            delete connectedPlayers[disconnectedUserId];
                            if (players[disconnectedUserId]) {
                                players[disconnectedUserId].state = 'disconnected';
                                // TODO: Handle game state changes due to disconnect (e.g., pause, forfeit)
                            }
                            console.log(`User ${disconnectedUserId} marked as disconnected.`);
                        } else {
                            // This socket was already replaced by a newer one for the same user
                            console.log(`Delayed disconnect for User ${disconnectedUserId}'s OLD socket ${socket.id} ignored (already replaced).`);
                        }
                    } else {
                        // This socket was never fully identified or associated
                        console.log(`Delayed disconnect for unidentified/old Socket ${socket.id} ignored.`);
                    }

                }, 500); // Delay of 500ms (adjust if needed)

            });

            // TODO: Add handlers for other game-specific messages (PLAYER_INPUT_FPS, etc.)
            // Example: socket.on(MessageTypeFPS.PLAYER_INPUT_FPS, (inputData) => handlePlayerInput(receivedUserId, inputData));

        }); // End of IDENTIFY_PLAYER listener

        // >>> NEW: Add listener for Player Input <<< (Plan 2.2.1)
        socket.on(MessageTypeFPS.PLAYER_INPUT_FPS, (inputData) => {
            // Need userId associated with this socket
            let userId = null;
            for (const id in connectedPlayers) {
                if (connectedPlayers[id]?.socketId === socket.id) {
                    userId = id;
                    break;
                }
            }
            if (userId) {
                handlePlayerInput(userId, inputData);
            } else {
                // console.warn(`Received input from unidentified socket: ${socket.id}`);
            }
        });

    }); // End of io.on('connection')

    // Add metrics server
    const metricsApp = express();
    metricsApp.get('/metrics', async (_, res) => {
        res.set('Content-Type', register.contentType);
        res.end(await register.metrics());
    });
    metricsApp.listen(config.port + 1, () => console.log(`Metrics on :${config.port+1}/metrics`));
}

// Step 6: Start Listener & Signal Readiness (1.2.3)
async function signalReadyToPlatform() {
    return new Promise((resolve, reject) => {
        if (!io || !io.httpServer) {
            return reject(new Error("Socket.IO httpServer not initialized before signaling ready."));
        }
        const httpServer = io.httpServer;

        httpServer.listen(config.port, () => {
            console.log(`Socket.IO server listening on port ${config.port}`);

            // --- Signal Readiness to Platform (Plan 1.2.3) ---
            const canUseIPC = typeof process.send === 'function';
            if (canUseIPC) {
                const readyMessage = {
                    type: 'READY',
                    serverId: config.matchId,
                    port: config.port
                };
                try {
                    process.send(readyMessage);
                    console.log('Sent READY message via IPC:', readyMessage);
                } catch (error) {
                    console.error('Failed to send READY message via IPC:', error);
                    // Consider exiting if signalling readiness is critical
                    // process.exit(1);
                }
            } else {
                console.warn('IPC not available. Cannot send READY message to manager.');
                // TODO: Implement fallback API call if needed
            }
            // --- End Signal Readiness ---

            currentMatchState = 'waiting'; // Instance is ready for connections
            console.log("Instance is READY and waiting for players...");
            resolve(); // Resolve promise once listening and signaled
        });

        httpServer.on('error', (error) => {
             console.error(`Failed to start HTTP server on port ${config.port}:`, error);
             reject(error);
        });
    });
}

// Step 7: Start Game Loop (Placeholder, modified per 1.3.3)
function startGameLoop() {
    const FPS=20; const dt=1000/FPS;
    gameLoopInterval=setInterval(()=>{
        const end=tickDurationHist.startTimer();
        // physics step etc.
        end();
    },dt);
}

// --- Helper Functions for State Sync (1.3.3 Server) ---

// Function to generate the full state payload
function getFullGameStatePayload() {
    const playerStates = {};
    for (const userId in players) {
        playerStates[userId] = getSerializablePlayerState(userId);
    }

    return {
         serverTick: Date.now(), // Example tick
         mapId: config.mapId,
         matchState: currentMatchState,
         timeRemaining: 0, // Placeholder for now
         currentRound: 1, // Placeholder for now
         roundWins: { p1: 0, p2: 0 }, // Placeholder for now
         players: playerStates
    };
}

// Helper to extract serializable player state
function getSerializablePlayerState(userId) {
    const pState = players[userId];
    if (!pState) return null;
    // Return fields defined in PlayerStateFPS in shared types
    return {
        userId: pState.userId,
        characterId: pState.characterId,
        state: pState.state,
        position: pState.position,
        rotation: pState.rotation,
        velocity: pState.velocity,
        health: pState.health,
        shield: pState.shield,
        kills: pState.kills,
        deaths: pState.deaths,
        lastProcessedSequence: pState.lastProcessedSequence,
        grenades: pState.grenades,
        ability1CooldownRemaining: pState.ability1CooldownRemaining,
        weaponSlots: pState.weaponSlots,
        activeWeaponSlot: pState.activeWeaponSlot,
        currentAmmoInClip: pState.currentAmmoInClip,
        grappleState: pState.grappleState,
        isReloading: pState.isReloading,
        // NOTE: Don't send server-internal state like rapierBody, positionHistory etc.
    };
}

// --- Shutdown Logic (Existing, Verified) ---
function shutdown() {
    console.log('Shutting down...');
    if (gameLoopInterval) clearInterval(gameLoopInterval);
    // Ensure io exists before closing
    if (io) io.close(() => { console.log('Socket.IO closed.'); });
    // TODO: Add other cleanup (Rapier world cleanup?)
    console.log('Shutdown complete.');
    // Give time for io close potentially
    setTimeout(() => process.exit(0), 500);
}

// Graceful shutdown handling
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// --- Start Initialization ---
initialize().catch(err => {
    console.error("Initialization failed:", err);
    process.exit(1);
});

// NEW: Input Handling Logic (Step 2.2.1 Server-Side)
function handlePlayerInput(playerId, inputData) {
    const playerState = players[playerId];
    if (!playerState || playerState.state !== 'alive' || !playerState.rapierBody) {
        // console.warn(`Input received for non-active player ${playerId} or missing body.`);
        return; // Ignore input if player not ready or body doesn't exist
    }

    const body = playerState.rapierBody;
    const { sequence, deltaTime, keys, lookQuat } = inputData;

    // Store input for lag compensation / validation
    // Limit history size if needed
    playerState.inputHistory[sequence] = inputData;
    playerState.lastProcessedSequence = sequence; // Acknowledge processed input

    // --- Movement Calculation ---
    const walkSpeed = 5.0;
    const runSpeed = 8.0;
    const jumpImpulse = 7.0;
    const accelerationForce = 2000.0; // Force applied to reach target velocity
    const maxAccelForce = 50.0; // Max force per frame to prevent crazy impulses

    let desiredVelocity = new RAPIER.Vector3(0, 0, 0);
    let moveDirection = new RAPIER.Vector3(0, 0, 0);
    let isMoving = false;

    // Calculate forward/right vectors based on look quaternion
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(lookQuat).normalize();
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(lookQuat).normalize();

    if (keys.W) {
        moveDirection.add(forward);
        isMoving = true;
    }
    if (keys.S) {
        moveDirection.sub(forward);
        isMoving = true;
    }
    if (keys.A) {
        moveDirection.sub(right);
        isMoving = true;
    }
    if (keys.D) {
        moveDirection.add(right);
        isMoving = true;
    }

    if (isMoving) {
        moveDirection.normalize();
        const targetSpeed = keys.Shift ? runSpeed : walkSpeed;
        desiredVelocity.x = moveDirection.x * targetSpeed;
        desiredVelocity.z = moveDirection.z * targetSpeed;
    }

    // Apply movement force (interpolate towards desired velocity)
    const currentVelocity = body.linvel();
    let force = new RAPIER.Vector3(0, 0, 0);

    const velocityDiffX = desiredVelocity.x - currentVelocity.x;
    const velocityDiffZ = desiredVelocity.z - currentVelocity.z;

    force.x = velocityDiffX * accelerationForce * deltaTime;
    force.z = velocityDiffZ * accelerationForce * deltaTime;

    // Clamp force magnitude
    const forceMagnitude = Math.sqrt(force.x * force.x + force.z * force.z);
    if (forceMagnitude > maxAccelForce) {
        const scale = maxAccelForce / forceMagnitude;
        force.x *= scale;
        force.z *= scale;
    }

    body.applyImpulse(force, true); // Apply horizontal movement force

    // --- Jumping ---
    // TODO: Add ground check using raycast or contact detection
    const isOnGround = true; // Placeholder - needs proper ground check
    if (keys.Space && isOnGround) {
        // Apply upward impulse only if grounded
        body.applyImpulse({ x: 0, y: jumpImpulse, z: 0 }, true);
    }

    // Update player state rotation (server doesn't need velocity/position here, Rapier handles it)
    playerState.rotation = { ...lookQuat };
}

// Import THREE only if needed server-side (e.g., for vector math)
// Ensure 'three' is added as a dependency to game-server-fps
const THREE = require('three');

// Function to check if both players are connected and start the match
function checkStartMatch() {
    // ... existing code ...
} 