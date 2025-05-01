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
const { performance } = require('perf_hooks'); // For precise timing

// Import necessary config and types
// REMOVED: Static require for shared types
// const {
//     MessageTypeFPS,
//     MapId,
//     CharacterId,
//     GrenadeType,
//     MAP_CONFIGS_FPS,
//     CHARACTER_CONFIG_FPS,
//     WEAPON_CONFIG_FPS,
//     GRENADE_CONFIG_FPS,
//     ABILITY_CONFIG_FPS,
//     // NEW: Import collision group utils
//     CollisionGroup,
//     interactionGroups
// } = require('@shared-types/game-fps');
const { initMetrics, gameMetrics } = require('./metrics');

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
let MapId, CharacterId, GrenadeType, MessageTypeFPS, MAP_CONFIGS_FPS, CHARACTER_CONFIG_FPS, WEAPON_CONFIG_FPS, ABILITY_CONFIG_FPS, CollisionGroup, interactionGroups;

// --- Constants for Movement ---
const TICK_RATE = 60; // Ticks per second
const TICK_INTERVAL_MS = 1000 / TICK_RATE;
const WALK_SPEED = 5.0;
const RUN_SPEED = 8.0;
const JUMP_IMPULSE = 7.0;
const ACCELERATION_FORCE = 2000.0; // Force applied per second
const MAX_ACCEL_FORCE = 50.0; // Max force applied per tick (scaled by deltaTime)
const AIR_CONTROL_FACTOR = 0.2; // How much control player has in air
const MAX_PLAYER_SPEED = 9.0; // Absolute max speed for validation

// --- Initialization Sequence ---
async function initialize() {
    console.log('Initializing Core Systems...');

    // NEW: Dynamically import shared types first
    try {
        const sharedTypes = await import('@shared-types/game-fps');
        // Assign to module-scoped variables
        MapId = sharedTypes.MapId;
        CharacterId = sharedTypes.CharacterId;
        GrenadeType = sharedTypes.GrenadeType;
        MessageTypeFPS = sharedTypes.MessageTypeFPS;
        MAP_CONFIGS_FPS = sharedTypes.MAP_CONFIGS_FPS;
        CHARACTER_CONFIG_FPS = sharedTypes.CHARACTER_CONFIG_FPS;
        WEAPON_CONFIG_FPS = sharedTypes.WEAPON_CONFIG_FPS;
        ABILITY_CONFIG_FPS = sharedTypes.ABILITY_CONFIG_FPS;
        CollisionGroup = sharedTypes.CollisionGroup;
        interactionGroups = sharedTypes.interactionGroups;
        console.log("Shared types loaded dynamically.");
    } catch (error) {
        console.error("Failed to dynamically load shared types:", error);
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

// Function to create player physics representation
function createPlayerPhysicsBody(playerId, position) {
    console.log(`Creating physics body for ${playerId} at ${JSON.stringify(position)}`);
    const playerHeight = 1.8;
    const playerRadius = 0.4;
    const capsuleHalfHeight = playerHeight / 2 - playerRadius;

    // Create RigidBody
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(position.x, position.y, position.z)
        .setCanSleep(false)
        .setCcdEnabled(true)
        .lockRotations(); // Prevent capsule from falling over
    const body = rapierWorld.createRigidBody(bodyDesc);

    // Create Collider (Capsule)
    const colliderDesc = RAPIER.ColliderDesc.capsule(capsuleHalfHeight, playerRadius)
        .setDensity(1.0)
        .setFriction(0.7)
        .setRestitution(0.2)
        // NEW: Set Collision Groups
        .setCollisionGroups(interactionGroups(
            CollisionGroup.PLAYER_BODY, // Belongs to PLAYER_BODY group
            [CollisionGroup.WORLD, CollisionGroup.PLAYER_BODY, CollisionGroup.GRENADE] // Collides with World, other Players, Grenades
        ))
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS); // Needed for ground detection
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
    console.log("Using Map Config:", JSON.stringify(mapConfig, null, 2)); // Log the full config

    const physicsData = mapConfig.physicsData;
    if (!physicsData) {
        console.warn(`[Physics Load] No physicsData found for map ${mapId}. No map colliders will be created.`);
        return;
    }
    console.log("[Physics Load] Found Physics Data:", JSON.stringify(physicsData, null, 2)); // Log the physics data

    // NEW: Check for trimesh data first
    if (physicsData.vertices && physicsData.vertices.length > 0 && physicsData.indices && physicsData.indices.length > 0) {
        console.log(`[Physics Load] Found vertices (${physicsData.vertices.length / 3}) and indices (${physicsData.indices.length / 3}). Attempting to load TR MESH...`);
        try {
            const rigidBodyDesc = RAPIER.RigidBodyDesc.fixed();
            const body = rapierWorld.createRigidBody(rigidBodyDesc);
            const trimeshDesc = RAPIER.ColliderDesc.trimesh(physicsData.vertices, physicsData.indices);
            console.log(`[Physics Load] TrimeshDesc created.`);
            // Set Collision Groups for trimesh map geometry
            const groups = interactionGroups(
                CollisionGroup.WORLD, // Belongs to WORLD group
                [CollisionGroup.PLAYER_BODY, CollisionGroup.GRENADE, CollisionGroup.PROJECTILE] // Collides with Players, Grenades, Projectiles
            );
            trimeshDesc.setCollisionGroups(groups);
            console.log(`[Physics Load] Trimesh Set collision groups to:`, groups);
            const collider = rapierWorld.createCollider(trimeshDesc, body);
            console.log(`[Physics Load] SUCCESS: Created trimesh map collider handle: ${collider.handle} attached to body handle: ${body.handle}`);
        } catch (error) {
            console.error(`[Physics Load] ERROR: Failed to create trimesh collider for map ${mapId}:`, error);
            // Optionally, fallback to primitives if trimesh fails? Or just error out?
            console.warn(`[Physics Load] Trimesh loading failed. Falling back to primitives if available...`);
            // Proceed to check for colliders array as fallback
            loadPrimitiveColliders(physicsData, mapId);
        }

    } else {
        // If no valid trimesh data, check for primitive colliders
        console.log(`[Physics Load] No valid trimesh data found (Vertices: ${physicsData.vertices?.length || 0}, Indices: ${physicsData.indices?.length || 0}). Checking for primitive colliders...`);
        loadPrimitiveColliders(physicsData, mapId);
    }

    console.log(`[Physics Load] Physics loading attempt complete for Map ${mapId}.`);
}

// NEW: Helper function to load primitive colliders
function loadPrimitiveColliders(physicsData, mapId) {
    if (physicsData.colliders && physicsData.colliders.length > 0) {
        console.log(`[Physics Load - Primitives] Found ${physicsData.colliders.length} primitive colliders. Loading...`);
        physicsData.colliders.forEach((colliderData, index) => {
            // console.log(`[Collider ${index}] Data:`, JSON.stringify(colliderData)); // Optional detailed log
            let colliderDesc;
            let rigidBodyDesc = RAPIER.RigidBodyDesc.fixed(); // Assume static map geometry

            if (colliderData.position) {
                rigidBodyDesc.setTranslation(colliderData.position.x, colliderData.position.y, colliderData.position.z);
            }
            // TODO: Set rotation if provided: rigidBodyDesc.setRotation(...)

            if (colliderData.type === 'cuboid') {
                if (!colliderData.dimensions) { console.warn(`[Collider ${index}] Cuboid missing dimensions`); return; }
                colliderDesc = RAPIER.ColliderDesc.cuboid(colliderData.dimensions.x / 2, colliderData.dimensions.y / 2, colliderData.dimensions.z / 2);
            } else if (colliderData.type === 'ball') {
                console.warn(`[Collider ${index}] Collider type '${colliderData.type}' creation not fully implemented.`); return;
            } else if (colliderData.type === 'capsule'){
                 console.warn(`[Collider ${index}] Collider type '${colliderData.type}' creation not fully implemented.`); return;
            } else {
                console.warn(`[Collider ${index}] Unsupported collider type: ${colliderData.type}`);
                return;
            }

            if (colliderDesc) {
                // Set Collision Groups for map geometry
                const groups = interactionGroups(
                    CollisionGroup.WORLD, // Belongs to WORLD group
                    [CollisionGroup.PLAYER_BODY, CollisionGroup.GRENADE, CollisionGroup.PROJECTILE] // Collides with Players, Grenades, Projectiles (bullets)
                );
                colliderDesc.setCollisionGroups(groups);
                // console.log(`[Collider ${index}] Set collision groups to:`, groups); // Optional detailed log

                const body = rapierWorld.createRigidBody(rigidBodyDesc);
                const collider = rapierWorld.createCollider(colliderDesc, body); // Pass body handle
                // console.log(`[Collider ${index}] Created map collider handle: ${collider.handle} attached to body handle: ${body.handle}`); // Optional detailed log
            } else {
                console.warn(`[Collider ${index}] Failed to create ColliderDesc.`);
            }
        });
         console.log(`[Physics Load - Primitives] Finished loading primitive colliders.`);
    } else {
        console.warn(`[Physics Load] No primitive colliders found in physicsData for map ${mapId}.`);
    }
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
        const defaultWeapon2 = 'pistol'; // Ensure this is a valid key in WEAPON_CONFIG_FPS

        players[playerInfo.userId] = {
            userId: playerInfo.userId,
            wallet: playerInfo.wallet, // Store wallet for escrow later
            characterId: playerInfo.charId,
            state: 'waiting', // Initial state before spawn
            position: { x: 0, y: 1, z: 0 }, // Placeholder, set on spawn
            rotation: { x: 0, y: 0, z: 0, w: 1 }, // Placeholder, set on spawn/input
            velocity: { x: 0, y: 0, z: 0 }, // Updated from Rapier
            health: charConfig.baseHealth,
            shield: charConfig.baseShield,
            kills: 0,
            deaths: 0,
            lastProcessedSequence: -1, // NEW: Initialize for client reconciliation
            grenades: {
                [GrenadeType.SEMTEX]: 1,
                [GrenadeType.FLASHBANG]: 1,
                [GrenadeType.FRAG]: 1,
            },
            ability1CooldownRemaining: 0,
            ability1Type: charConfig.ability1,
            weaponSlots: [defaultWeapon1, defaultWeapon2],
            activeWeaponSlot: 0,
            currentAmmoInClip: WEAPON_CONFIG_FPS[defaultWeapon1]?.ammoCapacity || 0,
            [`ammoInClipSlot0`]: WEAPON_CONFIG_FPS[defaultWeapon1]?.ammoCapacity || 0, // NEW: Store ammo per slot
            [`ammoInClipSlot1`]: WEAPON_CONFIG_FPS[defaultWeapon2]?.ammoCapacity || 0, // NEW: Store ammo per slot
            grappleState: { active: false, targetPoint: null, startTime: null },
            isReloading: false,
            damageAmpActiveUntil: 0, // NEW: Ability state flag
            isFlashedUntil: 0, // NEW: Grenade state flag
            // Server-internal state
            rapierBody: null, // Created when player spawns/respawns
            inputHistory: {}, // Stores recent inputs { sequence: { keys, lookQuat, deltaTime } }
            positionHistory: [], // Stores recent positions { timestamp, position, rotation } - For lag comp
            serverLastFireTime: 0,
            currentSpread: WEAPON_CONFIG_FPS[defaultWeapon1]?.baseSpread || 0,
            isOnGround: false, // NEW: Track ground status for jumping/air control
            lastJumpTime: 0, // NEW: Prevent jump spam
        };
        console.log(`Initialized state for ${playerInfo.userId} (Char: ${playerInfo.charId})`);
    });
}

// Step 5: Initialize Socket.IO (1.2.2 / 1.3.2)
function initSocketIO() {
    console.log(`Initializing Socket.IO...`); // Port info moved to listen call
    const httpServer = http.createServer();
    io = new Server(httpServer, {
        cors: { origin: "*", methods: ["GET", "POST"] } // Restrict in prod!
    });

    // --- Socket.IO Connection Logic ---
    io.on('connection', (socket) => {
        console.log(`Client socket connected: ${socket.id}`);
        let associatedUserId = null; // Track the ID associated with this socket

        // --- Player Identification --- (Modified from Plan 1.2.2)
        socket.on(MessageTypeFPS.IDENTIFY_PLAYER, (data) => {
            const userId = data.userId;
            console.log(`Received IDENTIFY_PLAYER for userId: ${userId} from socket ${socket.id}`);

            // Validate user ID against expected players
            if (userId === config.playersInfo.p1.userId || userId === config.playersInfo.p2.userId) {
                // Check if this user ID is already connected via another socket
                if (connectedPlayers[userId]) {
                    console.warn(`User ${userId} already connected with socket ${connectedPlayers[userId].socketId}. Disconnecting new socket ${socket.id}.`);
            socket.disconnect(true);
                    return;
                }
                // Check if this socket is already associated (shouldn't happen)
                if (associatedUserId) {
                     console.warn(`Socket ${socket.id} already associated with ${associatedUserId}. Ignoring IDENTIFY for ${userId}.`);
                     return;
                }

                console.log(`Socket ${socket.id} successfully associated with User ID: ${userId}`);
                associatedUserId = userId; // Associate this socket
                connectedPlayers[userId] = { socketId: socket.id, socket: socket };

                if (players[userId]) {
                     players[userId].state = 'connected';
                     // Send initial full game state ONLY to this connecting player
                     socket.emit(MessageTypeFPS.GAME_STATE_FPS, getFullGameStatePayload(userId));
                     console.log(`Sent initial game state to ${userId}`);
                } else {
                     console.error(`Player state not found for identified user: ${userId}`);
                socket.disconnect(true);
                return;
            }

                // Check if match can start
                checkStartMatch();

            } else {
                console.warn(`Unknown user ID ${userId} tried to identify. Disconnecting socket ${socket.id}.`);
                socket.disconnect(true);
            }
        });

        // --- Game Message Handlers ---
        socket.on(MessageTypeFPS.PLAYER_INPUT_FPS, (inputData) => {
            console.log(`[Input Received] User: ${associatedUserId}, Seq: ${inputData?.sequence}, Keys: ${JSON.stringify(inputData?.keys)}`); // Log receipt
            if (!associatedUserId || !players[associatedUserId] || players[associatedUserId].state !== 'alive') {
                // Ignore input if player isn't identified, doesn't exist, or isn't alive
                return;
            }

            const { sequence, deltaTime, keys, lookQuat } = inputData;

            // --- Server-Side Validation (Basic Sequence Check) ---
            // We expect sequence numbers to generally increase, but allow for out-of-order packets to some extent.
            // A more robust system would handle packet loss and reordering explicitly.
            if (sequence <= players[associatedUserId].lastProcessedSequence) {
                 // console.warn(`Received old input sequence ${sequence} from ${associatedUserId} (last was ${players[associatedUserId].lastProcessedSequence}). Ignoring.`);
                 // return; // Don't strictly reject old inputs, as they might be valid if UDP reordered
            }

            // Store input for potential rollback/lag compensation later
            // Limit history size
            const MAX_INPUT_HISTORY = 120; // ~2 seconds at 60hz
            players[associatedUserId].inputHistory[sequence] = { keys, lookQuat, deltaTime };
            const historyKeys = Object.keys(players[associatedUserId].inputHistory);
            if (historyKeys.length > MAX_INPUT_HISTORY) {
                delete players[associatedUserId].inputHistory[historyKeys[0]]; // Remove oldest entry
            }

            // --- Apply Input to Physics ---
            applyMovementInputToPlayer(associatedUserId, players[associatedUserId].rapierBody, keys, lookQuat, deltaTime);

            // --- Update Server State ---
            players[associatedUserId].lastProcessedSequence = sequence; // Acknowledge processing this input sequence

            // Update player look direction (important for shooting direction later)
            // Directly use the client's quaternion for looking up/down/left/right
            players[associatedUserId].rotation = { ...lookQuat }; // Store the look rotation
            // Apply this rotation to the physics body ONLY if not locked (e.g., for turning, but capsule has locked rotations)
            // players[associatedUserId].rapierBody.setRotation(lookQuat, true); // This would make capsule lean/turn if rotations weren't locked

            // Basic Speed Validation (Plan 6.2.1)
            const currentLinvel = players[associatedUserId].rapierBody.linvel();
            const currentSpeed = Math.sqrt(currentLinvel.x**2 + currentLinvel.y**2 + currentLinvel.z**2);
            let allowedMaxSpeed = MAX_PLAYER_SPEED;
            // TODO: Increase allowedMaxSpeed if abilities like Dash or Grapple are active
            if (currentSpeed > allowedMaxSpeed) {
                console.warn(`Player ${associatedUserId} exceeded max speed! Speed: ${currentSpeed.toFixed(2)}`);
                // Option: Clamp velocity?
                // const clampScale = allowedMaxSpeed / currentSpeed;
                // players[associatedUserId].rapierBody.setLinvel({ x: currentLinvel.x * clampScale, y: currentLinvel.y, z: currentLinvel.z * clampScale }, true);
            }
        });
        // TODO: Add handlers for other messages (FIRE, SWITCH_WEAPON, RELOAD, etc.)
        // socket.on(MessageTypeFPS.PLAYER_FIRE_FPS, (fireData) => handlePlayerFire(associatedUserId, fireData));
        // socket.on(MessageTypeFPS.SWITCH_WEAPON_FPS, (switchData) => handleWeaponSwitch(associatedUserId, switchData));
        // socket.on(MessageTypeFPS.RELOAD_WEAPON_FPS, () => handleReload(associatedUserId));
        // socket.on(MessageTypeFPS.THROW_GRENADE_FPS, (grenadeData) => handleThrowGrenade(associatedUserId, grenadeData));
        // socket.on(MessageTypeFPS.USE_ABILITY_FPS, (abilityData) => handleUseAbility(associatedUserId, abilityData));
        // socket.on(MessageTypeFPS.FIRE_GRAPPLE_FPS, (grappleData) => handleFireGrapple(associatedUserId, grappleData));
        // socket.on(MessageTypeFPS.RELEASE_GRAPPLE_FPS, () => handleReleaseGrapple(associatedUserId));

        socket.on('disconnect', (reason) => {
            console.log(`Client socket disconnected: ${socket.id}, Reason: ${reason}`);
            if (associatedUserId) {
                console.log(`User ${associatedUserId} disconnected.`);
                delete connectedPlayers[associatedUserId];
                if (players[associatedUserId]) {
                    players[associatedUserId].state = 'disconnected';
                    // Optionally remove player physics body or pause simulation
                    // if(players[associatedUserId].rapierBody) {
                    //     rapierWorld.removeRigidBody(players[associatedUserId].rapierBody);
                    //     players[associatedUserId].rapierBody = null;
                    // }
                }
                // TODO: Handle game interruption (pause, end match if critical?)
                // Maybe checkEndConditions() or similar
            } else {
                console.log(`Unassociated socket ${socket.id} disconnected.`);
            }
        });

        // Error Handling (Example)
        socket.on('error', (error) => {
             console.error(`Socket error for ${associatedUserId || socket.id}:`, error);
        });
    });
}

// Step 6: Start Listener & Signal Readiness (1.2.3)
async function signalReadyToPlatform() {
    return new Promise((resolve, reject) => {
        if (!io) {
            return reject(new Error("Socket.IO server not initialized before signalling readiness."));
        }
        const httpServer = io.httpServer; // Access the http server instance from socket.io

        // --- Metrics Server ---
        const metricsApp = express();
        metricsApp.get('/metrics', async (req, res) => {
            res.set('Content-Type', register.contentType);
            res.end(await register.metrics());
        });
        const metricsPort = config.port + 1; // Use adjacent port
        const metricsServer = metricsApp.listen(metricsPort, () => {
            console.log(`Metrics server listening on port ${metricsPort}`);
        });
        // --- End Metrics Server ---


        httpServer.listen(config.port, () => {
            console.log(`Game server listening on port ${config.port}`);

            // --- Signal Readiness to Platform ---
            const canUseIPC = typeof process.send === 'function';
            if (canUseIPC) {
                const readyMessage = {
                    type: 'READY',
                    serverId: config.matchId,
                    port: config.port,
                    metricsPort: metricsPort // Inform manager about metrics port
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

            currentMatchState = 'waiting';
            console.log("Instance is READY and waiting for players...");
            resolve(); // Resolve the promise once listening starts
        });

        httpServer.on('error', (error) => {
             console.error("HTTP Server Error:", error);
             reject(error);
        });
    });
}

// --- Game Loop ---
function startGameLoop() {
    if (gameLoopInterval) {
        console.warn('Game loop already running.');
        return;
    }
    console.log('Starting Game Loop...');
    const loopStartTime = Date.now();
    currentMatchState = 'in_progress'; // Or countdown first

    gameLoopInterval = setInterval(() => {
        const tickStart = performance.now();

        // 1. Step Physics World
        if (rapierWorld) {
            rapierWorld.step();
            // TODO: Process collision events here (for ground checks, semtex stick, etc.)
        }

        // 2. Update Player States from Physics & Handle Game Logic
        for (const playerId in players) {
             const playerState = players[playerId];
             if (playerState.rapierBody) {
                // >>> NEW: Check ground status <<< (Plan 2.2.1)
                updateGroundStatus(playerId);

                // Update position/velocity from Rapier body
                const pos = playerState.rapierBody.translation();
                const rot = playerState.rapierBody.rotation();
                const vel = playerState.rapierBody.linvel();
                playerState.position = { x: pos.x, y: pos.y, z: pos.z };
                playerState.rotation = { x: rot.x, y: rot.y, z: rot.z, w: rot.w };
                playerState.velocity = { x: vel.x, y: vel.y, z: vel.z };

                // Check ground status (needs collision event processing)
                // updateGroundStatus(playerId);

                // Apply air control reduction (optional)
                // if (!playerState.isOnGround) { /* reduce forces? */ }

                // Update cooldowns (Abilities, Grenades?)
                updateCooldowns(playerId, TICK_INTERVAL_MS);

                // Regenerate Shield (Example)
                // if (playerState.shield < CHARACTER_CONFIG_FPS[playerState.characterId].baseShield && Date.now() > playerState.lastDamageTime + SHIELD_REGEN_DELAY) {
                //     playerState.shield += SHIELD_REGEN_RATE * (TICK_INTERVAL_MS / 1000);
                //     playerState.shield = Math.min(playerState.shield, CHARACTER_CONFIG_FPS[playerState.characterId].baseShield);
                // }

                // Update Spread recovery
                // if (playerState.currentSpread > WEAPON_CONFIG_FPS[playerState.weaponSlots[playerState.activeWeaponSlot]].baseSpread && Date.now() > playerState.serverLastFireTime + SPREAD_RECOVERY_DELAY) {
                //      playerState.currentSpread -= WEAPON_CONFIG_FPS[playerState.weaponSlots[playerState.activeWeaponSlot]].spreadRecoveryRate * (TICK_INTERVAL_MS / 1000);
                //      playerState.currentSpread = Math.max(playerState.currentSpread, WEAPON_CONFIG_FPS[playerState.weaponSlots[playerState.activeWeaponSlot]].baseSpread);
                // }
             }
        }


        // 3. Broadcast Game State
        broadcastGameState();

        // Record tick duration for metrics
        const tickEnd = performance.now();
        tickDurationHist.observe(tickEnd - tickStart);

    }, TICK_INTERVAL_MS);
}

// Helper to stop game loop
function stopGameLoop() {
    if (gameLoopInterval) {
        console.log('Stopping Game Loop.');
        clearInterval(gameLoopInterval);
        gameLoopInterval = null;
    }
}

// Helper to broadcast state (consider delta compression later - Phase 5)
function broadcastGameState() {
    if (!io) return;
    // Send full state for now
    const fullState = getFullGameStatePayload(); // Pass no specific userId to get full state
    io.emit(MessageTypeFPS.GAME_STATE_FPS, fullState);
}

// --- State Payload Generation ---
function getFullGameStatePayload(targetUserId = null) {
    const playerStates = {};
    for (const userId in players) {
        // Only include serializable state needed by clients
        playerStates[userId] = getSerializablePlayerState(userId, userId === targetUserId);
    }

    // Include other relevant match state
    return {
         serverTick: Date.now(), // Or a tick counter
         mapId: config.mapId,
         matchState: currentMatchState,
         timeRemaining: 0, // TODO: Add timer state
         currentRound: 1, // TODO: Add round state
         roundWins: { p1: 0, p2: 0 }, // TODO: Add round wins state
         players: playerStates,
         // TODO: Add active grenades state
         // activeGrenades: getSerializableGrenadeState(),
    };
}

// Helper to extract serializable player state
function getSerializablePlayerState(userId, isSelf = false) {
    const pState = players[userId];
    if (!pState) return null;

    const serializableState = {
        userId: pState.userId,
        characterId: pState.characterId,
        state: pState.state,
        position: pState.position,
        rotation: pState.rotation, // Send full rotation for remote players
        velocity: pState.velocity, // Needed for interpolation/prediction
        health: pState.health,
        shield: pState.shield,
        kills: pState.kills,
        deaths: pState.deaths,
        // Grenades/Ability cooldowns are needed by everyone for HUD/observation
        grenades: pState.grenades,
        ability1CooldownRemaining: pState.ability1CooldownRemaining,
        // Weapon state needed by everyone for visuals/audio
        weaponSlots: pState.weaponSlots,
        activeWeaponSlot: pState.activeWeaponSlot,
        isReloading: pState.isReloading,
        // Grapple state needed by everyone for visuals
        grappleState: pState.grappleState,
        // Effects needed by everyone for visuals
        isFlashedUntil: pState.isFlashedUntil,
        damageAmpActiveUntil: pState.damageAmpActiveUntil,
        // Only send detailed ammo/sequence to self for reconciliation/HUD
        ...(isSelf && {
             currentAmmoInClip: pState.currentAmmoInClip,
             lastProcessedSequence: pState.lastProcessedSequence, // Send last processed input sequence
        })
    };
    // If not self, optionally simplify rotation (e.g., just yaw) if bandwidth is critical?
    // if (!isSelf) { delete serializableState.rotation.x; delete serializableState.rotation.z; }

    return serializableState;
}


// --- Shutdown Logic ---
function shutdown() {
    console.log('Shutting down...');
    stopGameLoop(); // Ensure loop is stopped first
    // TODO: Report final results to platform before closing sockets
    // await reportMatchResults(...);
    if (io) {
        console.log('Closing Socket.IO server...');
        io.close(() => {
            console.log('Socket.IO server closed.');
            // Close metrics server?
            exitProcess();
        });
    } else {
        exitProcess();
    }
}
function exitProcess() {
    console.log('Exiting process.');
    // Optional: Clean up Rapier world?
    // rapierWorld?.free();
    process.exit(0); // Clean exit
}
// Graceful shutdown handling
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);


// --- Input Handling --- (Plan 2.2.1 / 2.3.2)
function handlePlayerInput(playerId, inputData) {
    const playerState = players[playerId];
    if (!playerState || playerState.state !== 'alive' || !playerState.rapierBody) {
        // console.warn(`Ignoring input for player ${playerId} in state ${playerState?.state}`);
        return; // Ignore input if player is not in a state to receive it
    }

    const { sequence, deltaTime, keys, lookQuat } = inputData;

    // --- Server-Side Validation (Basic Sequence Check) ---
    // We expect sequence numbers to generally increase, but allow for out-of-order packets to some extent.
    // A more robust system would handle packet loss and reordering explicitly.
    if (sequence <= playerState.lastProcessedSequence) {
         // console.warn(`Received old input sequence ${sequence} from ${playerId} (last was ${playerState.lastProcessedSequence}). Ignoring.`);
         // return; // Don't strictly reject old inputs, as they might be valid if UDP reordered
    }

    // Store input for potential rollback/lag compensation later
    // Limit history size
    const MAX_INPUT_HISTORY = 120; // ~2 seconds at 60hz
    playerState.inputHistory[sequence] = { keys, lookQuat, deltaTime };
    const historyKeys = Object.keys(playerState.inputHistory);
    if (historyKeys.length > MAX_INPUT_HISTORY) {
        delete playerState.inputHistory[historyKeys[0]]; // Remove oldest entry
    }

    // --- Apply Input to Physics ---
    applyMovementInputToPlayer(playerId, playerState.rapierBody, keys, lookQuat, deltaTime);

    // --- Update Server State ---
    playerState.lastProcessedSequence = sequence; // Acknowledge processing this input sequence

    // Update player look direction (important for shooting direction later)
    // Directly use the client's quaternion for looking up/down/left/right
    playerState.rotation = { ...lookQuat }; // Store the look rotation
    // Apply this rotation to the physics body ONLY if not locked (e.g., for turning, but capsule has locked rotations)
    // playerState.rapierBody.setRotation(lookQuat, true); // This would make capsule lean/turn if rotations weren't locked

    // Basic Speed Validation (Plan 6.2.1)
    const currentLinvel = playerState.rapierBody.linvel();
    const currentSpeed = Math.sqrt(currentLinvel.x**2 + currentLinvel.y**2 + currentLinvel.z**2);
    let allowedMaxSpeed = MAX_PLAYER_SPEED;
    // TODO: Increase allowedMaxSpeed if abilities like Dash or Grapple are active
    if (currentSpeed > allowedMaxSpeed) {
        console.warn(`Player ${playerId} exceeded max speed! Speed: ${currentSpeed.toFixed(2)}`);
        // Option: Clamp velocity?
        // const clampScale = allowedMaxSpeed / currentSpeed;
        // playerState.rapierBody.setLinvel({ x: currentLinvel.x * clampScale, y: currentLinvel.y, z: currentLinvel.z * clampScale }, true);
    }
}

// --- Physics Application ---
function applyMovementInputToPlayer(playerId, playerBody, keys, lookQuat, deltaTime) {
    if (!playerBody || deltaTime <= 0) return;

    const playerState = players[playerId]; // Access player state for ground check, etc.
    const isOnGround = playerState.isOnGround; // Assume this is updated elsewhere (collision checks)
    const canJump = isOnGround && (Date.now() - playerState.lastJumpTime > 300); // Simple jump cooldown

    const effectiveAccelForce = ACCELERATION_FORCE * deltaTime;
    const effectiveMaxAccelForce = MAX_ACCEL_FORCE; // Max force per tick, not scaled by deltaTime? Test this.

    // --- Calculate Desired Movement ---
    let desiredVelocity = { x: 0, z: 0 }; // Movement on XZ plane
    let moveDirection = { x: 0, z: 0 };
    let isMoving = false;

    // Get forward/right vectors based on lookQuat (Y component only for ground movement)
    // We need a stable forward/right projected onto the ground plane.
    // Create a quaternion representing only the yaw rotation.
    const yawQuaternion = { x:0, y: lookQuat.y, z: 0, w: lookQuat.w };
    // Normalize the yaw quaternion (important!)
    const yawMag = Math.sqrt(yawQuaternion.y**2 + yawQuaternion.w**2);
    if (yawMag > 1e-6) { // Avoid division by zero
        yawQuaternion.y /= yawMag;
        yawQuaternion.w /= yawMag;
    } else {
        yawQuaternion.w = 1.0; // Default to no rotation if magnitude is near zero
    }

    // Use THREE math temporarily for vector application (avoid adding full lib if possible)
    // TODO: Replace with pure math if THREE isn't added server-side
    const _forward = {x: 0, y: 0, z: -1}; // Base forward vector
    const _right = {x: 1, y: 0, z: 0};   // Base right vector

    // Apply yaw rotation (simplified quaternion rotation)
    const forward = applyQuaternion(_forward, yawQuaternion);
    const right = applyQuaternion(_right, yawQuaternion);

    console.log(`[ApplyInput] Applying for ${playerState.userId} Seq: ${sequence}, Keys: ${JSON.stringify(keys)}`); // Log Keys

    if (keys.W) { moveDirection.x += forward.x; moveDirection.z += forward.z; isMoving = true; }
    if (keys.S) { moveDirection.x -= forward.x; moveDirection.z -= forward.z; isMoving = true; }
    if (keys.A) { moveDirection.x -= right.x; moveDirection.z -= right.z; isMoving = true; }
    if (keys.D) { moveDirection.x += right.x; moveDirection.z += right.z; isMoving = true; }

    if (isMoving) {
        const mag = Math.sqrt(moveDirection.x**2 + moveDirection.z**2);
        if (mag > 1e-6) { // Normalize
            moveDirection.x /= mag;
            moveDirection.z /= mag;
        }
        const targetSpeed = keys.Shift ? RUN_SPEED : WALK_SPEED;
        desiredVelocity.x = moveDirection.x * targetSpeed;
        desiredVelocity.z = moveDirection.z * targetSpeed;
    }

    console.log(`[ApplyInput] MoveDirection Raw: ${JSON.stringify(moveDirection)}`); // Log Move Direction

    const moveLen = Math.sqrt(moveDirection.x**2 + moveDirection.z**2);
    if (isMoving && moveLen > 0.01) {
        desiredVelocity.x = moveDirection.x * targetSpeed;
        desiredVelocity.z = moveDirection.z * targetSpeed;
    }

    console.log(`[ApplyInput] Desired Velocity: ${JSON.stringify(desiredVelocity)}`); // Log Desired Velocity

    // --- Apply Force --- (Similar to client prediction logic)
    const currentLinvel = playerBody.linvel();
    let force = { x: 0, y: 0, z: 0 };
    const velocityDiffX = desiredVelocity.x - currentLinvel.x;
    const velocityDiffZ = desiredVelocity.z - currentLinvel.z;

    force.x = velocityDiffX * effectiveAccelForce;
    force.z = velocityDiffZ * effectiveAccelForce;

    // Apply air control factor if not on ground
    if (!isOnGround) {
        force.x *= AIR_CONTROL_FACTOR;
        force.z *= AIR_CONTROL_FACTOR;
    }

    // Clamp force per tick
    console.log(`[ApplyInput] Calculated Force (Pre-Clamp): ${JSON.stringify(force)}`); // Log Pre-Clamp Force
    const forceMagnitude = Math.sqrt(force.x**2 + force.z**2);
    if (forceMagnitude > effectiveMaxAccelForce) {
        const scale = effectiveMaxAccelForce / forceMagnitude;
        force.x *= scale;
        force.z *= scale;
    }
    playerBody.applyImpulse(force, true); // Apply impulse for ground movement force

    // --- Jumping ---
    if (keys.Space && canJump) {
        // Apply upward impulse only if on ground
        playerBody.applyImpulse({ x: 0, y: JUMP_IMPULSE, z: 0 }, true);
        playerState.isOnGround = false; // Assume player leaves ground immediately
        playerState.lastJumpTime = Date.now();
        console.log(`Player ${playerId} Jumped!`);
    }
}

// Temporary Quaternion Math (Replace if using a math library)
function applyQuaternion(vec, q) {
    const ix = q.w * vec.x + q.y * vec.z - q.z * vec.y;
    const iy = q.w * vec.y + q.z * vec.x - q.x * vec.z;
    const iz = q.w * vec.z + q.x * vec.y - q.y * vec.x;
    const iw = -q.x * vec.x - q.y * vec.y - q.z * vec.z;
    return {
        x: ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y,
        y: iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z,
        z: iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x,
    };
}
function updateCooldowns(playerId, deltaTimeMs) {
    // Example for ability cooldown
    // if (players[playerId].ability1CooldownRemaining > 0) {
    //      players[playerId].ability1CooldownRemaining -= deltaTimeMs;
    //      if (players[playerId].ability1CooldownRemaining < 0) players[playerId].ability1CooldownRemaining = 0;
    // }
}

// --- Ground Check Logic ---
function updateGroundStatus(playerId) {
    const playerState = players[playerId];
    if (!playerState || !playerState.rapierBody) return;

    // Use a short downward raycast from the capsule's bottom sphere center
    const body = playerState.rapierBody;
    const currentPos = body.translation();

    // Calculate capsule bottom sphere center (adjust based on capsule collider dimensions)
    const playerHeight = 1.8; // Must match createPlayerPhysicsBody
    const playerRadius = 0.4;
    const halfHeight = playerHeight / 2;
    const capsuleBottomOffset = halfHeight - playerRadius;
    const rayOrigin = { x: currentPos.x, y: currentPos.y - capsuleBottomOffset, z: currentPos.z };

    const rayDirection = { x: 0, y: -1, z: 0 };
    const rayLength = playerRadius + 0.15; // Cast just below the capsule radius + a small buffer

    // TODO: Define collision groups for raycast filtering (e.g., only hit WORLD)
    // const filterCollider = null; // Replace with actual collider handle to ignore self if needed
    // const filterGroups = interactionGroups(CollisionGroup.PLAYER_RAYCAST, [CollisionGroup.WORLD]);

    const ray = new RAPIER.Ray(rayOrigin, rayDirection);
    const hit = rapierWorld.castRay(
        ray,
        rayLength,
        true, // Solid check
        // filterGroups // Add collision group filter here when defined
        // filterCollider // Add self-collider filter here when defined
    );

    const previouslyOnGround = playerState.isOnGround;
    playerState.isOnGround = hit !== null;

    // Debug logging for ground status changes
    if (previouslyOnGround !== playerState.isOnGround) {
        console.log(`Player ${playerId} ground status changed: ${playerState.isOnGround}`);
    }

    // NEW: Log position change if significant
    const posChanged = Math.abs(playerState.position.x - currentPos.x) > 0.01 ||
                     Math.abs(playerState.position.y - currentPos.y) > 0.01 ||
                     Math.abs(playerState.position.z - currentPos.z) > 0.01;

    if (posChanged) {
       console.log(`[Physics Update] ${playerId} Pos: x:${currentPos.x.toFixed(2)}, y:${currentPos.y.toFixed(2)}, z:${currentPos.z.toFixed(2)}`);
    }

    // Update the playerState object directly (this is what gets sent)
    playerState.position.x = currentPos.x;
    playerState.position.y = currentPos.y;
    playerState.position.z = currentPos.z;
}


// --- Match Lifecycle ---
function checkStartMatch() {
    if (currentMatchState === 'waiting' && Object.keys(connectedPlayers).length === 2) {
        console.log('Both players connected. Starting match countdown...');
        // TODO: Implement countdown logic (Phase 3)
        startMatchCountdown();
    }
}

function startMatchCountdown() {
     // Example countdown
     let countdown = 5;
     currentMatchState = `countdown_${countdown}`;
     broadcastGameState(); // Show initial countdown

     const countdownInterval = setInterval(() => {
          countdown--;
          if (countdown > 0) {
             currentMatchState = `countdown_${countdown}`;
             broadcastGameState();
          } else {
             clearInterval(countdownInterval);
             startRound(); // Start the first round
          }
     }, 1000);
}

function startRound() {
    console.log("Starting round...");
    currentMatchState = 'in_progress';
    // Reset scores/timers if needed for the round start
    // Respawn players in starting positions
    respawnPlayer(config.playersInfo.p1.userId);
    respawnPlayer(config.playersInfo.p2.userId);
    startGameLoop(); // Start the main physics/broadcast loop
}

// TODO: Implement prepareNextRound, checkEndConditions (Phase 3.6)

// --- Player Spawning/Death ---
function respawnPlayer(playerId) {
    const playerState = players[playerId];
    if (!playerState) return; // Player doesn't exist?

    // Find spawn point using map config
    const mapConfig = MAP_CONFIGS_FPS[config.mapId];
    const spawnPoints = mapConfig?.physicsData?.spawnPoints || [{x: 0, y: 1, z: 0}]; // Default spawn
    // Simple alternating spawn (needs refinement for fairness)
    const p1Id = config.playersInfo.p1.userId;
    const p2Id = config.playersInfo.p2.userId;
    let spawnIndex = 0;
     if (playerId === p1Id) spawnIndex = (playerState.deaths) % spawnPoints.length; // Example: cycle spawns based on deaths
     if (playerId === p2Id) spawnIndex = (playerState.deaths + Math.floor(spawnPoints.length / 2)) % spawnPoints.length; // Try to spawn opponent away

    // Ensure spawnIndex is valid
    spawnIndex = Math.min(spawnPoints.length - 1, Math.max(0, Math.floor(spawnIndex)));
    const spawnPoint = spawnPoints[spawnIndex];

    console.log(`Respawning ${playerId} at index ${spawnIndex}: ${JSON.stringify(spawnPoint)}`);

    // Reset State using Character Config
    const charConfig = CHARACTER_CONFIG_FPS[playerState.characterId];
    playerState.state = 'alive';
    playerState.health = charConfig.baseHealth;
    playerState.shield = charConfig.baseShield; // Reset shield based on character
    playerState.position = { ...spawnPoint }; // Set initial position before physics body if needed
    playerState.rotation = { x: 0, y: 0, z: 0, w: 1 }; // Reset rotation

    // Reset per-round consumables/cooldowns (Plan 3.2.1)
    playerState.grenades = { [GrenadeType.SEMTEX]: 1, [GrenadeType.FLASHBANG]: 1, [GrenadeType.FRAG]: 1 };
    playerState.ability1CooldownRemaining = 0;
    playerState.isReloading = false;
    playerState.isFlashedUntil = 0;
    playerState.damageAmpActiveUntil = 0;
    playerState.grappleState = { active: false, targetPoint: null, startTime: null };

    // Reset ammo to full for both weapon slots
    const weaponId0 = playerState.weaponSlots[0];
    const weaponId1 = playerState.weaponSlots[1];
    const ammo0 = WEAPON_CONFIG_FPS[weaponId0]?.ammoCapacity ?? 0;
    const ammo1 = WEAPON_CONFIG_FPS[weaponId1]?.ammoCapacity ?? 0;
    playerState.currentAmmoInClip = (playerState.activeWeaponSlot === 0) ? ammo0 : ammo1;
    playerState[`ammoInClipSlot0`] = ammo0;
    playerState[`ammoInClipSlot1`] = ammo1;
    playerState.currentSpread = WEAPON_CONFIG_FPS[playerState.weaponSlots[playerState.activeWeaponSlot]]?.baseSpread ?? 0;
    playerState.isOnGround = false; // Reset ground state assumption
    playerState.lastJumpTime = 0;

    // Reset Physics Body
    if (playerState.rapierBody) {
        resetPlayerPhysics(playerState.rapierBody, spawnPoint);
    } else {
         // Create body if it doesn't exist yet (first spawn)
         playerState.rapierBody = createPlayerPhysicsBody(playerId, spawnPoint);
         if (!playerState.rapierBody) {
             console.error(`Failed to create physics body for ${playerId} on respawn!`);
             // Handle error state?
         }
    }

    // Broadcast needed immediately if spawning during active gameplay
     if (currentMatchState === 'in_progress') {
        broadcastGameState();
     }
    console.log(`${playerId} respawned.`);
}

// Helper function for resetting physics (Plan 3.2.1)
    // ... existing code ...
// --- Entry Point ---
initialize().catch(err => {
    console.error("Initialization failed:", err);
    process.exit(1);
}); 