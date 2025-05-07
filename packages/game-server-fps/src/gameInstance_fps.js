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
    // Set user data on the collider after creation
    const collider = rapierWorld.createCollider(colliderDesc, body);
    if (collider) {
        collider.userData = { type: 'playerBody', playerId: playerId };
    }

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
        console.warn(`[Physics Load] No physicsData found for map ${mapId}. No map colliders will be created.`);
        return;
    }
   

    // --- Only support Trimesh Loading ---
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
            // No fallback to primitives
        }
    } else {
        console.error(`[Physics Load] No valid trimesh data found for map ${mapId}. Physics loading failed.`);
    }
    console.log(`[Physics Load] Physics loading attempt complete for Map ${mapId}.`);
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
            position: { x: 0, y: 0, z: 0 }, // Will be set on spawn
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

    // Immediately spawn both players at their correct spawn points
    respawnPlayer(p1Info.userId);
    respawnPlayer(p2Info.userId);
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
        
        // [DELETE/REPLACE] Remove any old PLAYER_FIRE_FPS handler or TODOs
        // [REPLACE] Implement robust PLAYER_FIRE_FPS handler:
        socket.on(MessageTypeFPS.PLAYER_FIRE_FPS, (fireData) => {
            // Validate player
            if (!associatedUserId || !players[associatedUserId] || players[associatedUserId].state !== 'alive') return;
            const playerState = players[associatedUserId];
            const activeWeaponId = playerState.weaponSlots[playerState.activeWeaponSlot];
            const weaponConfig = WEAPON_CONFIG_FPS[activeWeaponId];
            if (!weaponConfig) return;
            // Ammo check
            if (playerState.currentAmmoInClip <= 0) return;
            // Fire rate check
            const now = Date.now();
            if (now - playerState.serverLastFireTime < weaponConfig.fireRate) return;
            playerState.serverLastFireTime = now;
            // Lag compensation: get authoritative state at fireData.sequence
            const inputHist = playerState.inputHistory[fireData.sequence];
            const authoritativePos = inputHist ? playerState.position : playerState.position;
            const authoritativeRot = inputHist ? inputHist.lookQuat : playerState.rotation;
            // Apply spread
            let direction = { ...fireData.direction };
            const spread = playerState.currentSpread || weaponConfig.baseSpread;
            direction.x += (Math.random() - 0.5) * spread;
            direction.y += (Math.random() - 0.5) * spread;
            direction.z += (Math.random() - 0.5) * spread;
            // Normalize direction
            const mag = Math.sqrt(direction.x**2 + direction.y**2 + direction.z**2);
            if (mag > 1e-6) { direction.x /= mag; direction.y /= mag; direction.z /= mag; }
            // Decrement ammo
            playerState.currentAmmoInClip--;
            playerState[`ammoInClipSlot${playerState.activeWeaponSlot}`] = playerState.currentAmmoInClip;
            // Raycast
            const ray = new RAPIER.Ray(authoritativePos, direction);
            const hit = rapierWorld.castRay(ray, weaponConfig.range, true);
            let hitPlayerId = null;
            if (hit) {
                // Check if hit a player
                const collider = rapierWorld.getCollider(hit.collider);
                const userData = collider && collider.userData;
                if (userData && userData.type === 'playerBody' && userData.playerId !== associatedUserId) {
                    hitPlayerId = userData.playerId;
                    // Damage calculation
                    let damage = weaponConfig.damage;
                    // Damage amp ability
                    if (playerState.damageAmpActiveUntil && playerState.damageAmpActiveUntil > now) {
                        damage *= ABILITY_CONFIG_FPS[playerState.ability1Type]?.effectValue || 1.0;
                    }
                    // Apply damage to shield/health
                    const victim = players[hitPlayerId];
                    if (victim) {
                        let shieldDmg = Math.min(victim.shield, damage);
                        victim.shield -= shieldDmg;
                        let healthDmg = damage - shieldDmg;
                        if (healthDmg > 0) victim.health = Math.max(0, victim.health - healthDmg);
                        // Log event
                        console.log(`[SHOT_HIT] ${associatedUserId} hit ${hitPlayerId} for ${damage} (${shieldDmg} shield, ${healthDmg} health)`);
                        // Broadcast hit confirmation
                        io.emit(MessageTypeFPS.HIT_CONFIRMED_FPS, { shooterId: associatedUserId, victimId: hitPlayerId, damage, position: hit.point });
                        // Check for death
                        if (victim.health <= 0) {
                            victim.state = 'dead';
                            victim.deaths++;
                            playerState.kills++;
                            io.emit(MessageTypeFPS.PLAYER_DIED_FPS, { victimId: hitPlayerId, killerId: associatedUserId });
                        }
                    }
                }
            }
            // Broadcast updated state
            broadcastGameState();
        });
        // [DELETE/REPLACE] Remove any old SWITCH_WEAPON_FPS handler or TODOs
        // [REPLACE] Implement robust SWITCH_WEAPON_FPS handler:
        socket.on(MessageTypeFPS.SWITCH_WEAPON_FPS, (data) => {
            if (!associatedUserId || !players[associatedUserId] || players[associatedUserId].state !== 'alive') return;
            const playerState = players[associatedUserId];
            const targetSlot = data.targetSlot;
            if (typeof targetSlot !== 'number' || (targetSlot !== 0 && targetSlot !== 1)) return;
            if (targetSlot === playerState.activeWeaponSlot) return;
            // Cancel reload if switching
            if (playerState.isReloading) playerState.isReloading = false;
            // Store current ammo in the old slot
            playerState[`ammoInClipSlot${playerState.activeWeaponSlot}`] = playerState.currentAmmoInClip;
            // Switch slot
            playerState.activeWeaponSlot = targetSlot;
            // Load ammo for new slot
            playerState.currentAmmoInClip = playerState[`ammoInClipSlot${targetSlot}`] ?? WEAPON_CONFIG_FPS[playerState.weaponSlots[targetSlot]]?.ammoCapacity ?? 0;
            // Reset spread for new weapon
            playerState.currentSpread = WEAPON_CONFIG_FPS[playerState.weaponSlots[targetSlot]]?.baseSpread ?? 0;
            // Log event
            console.log(`[SWITCH_WEAPON] ${associatedUserId} switched to slot ${targetSlot} (${playerState.weaponSlots[targetSlot]})`);
            // Broadcast updated state
            broadcastGameState();
        });
        // [DELETE/REPLACE] Remove any old RELOAD_WEAPON_FPS handler or TODOs
        // [REPLACE] Implement robust RELOAD_WEAPON_FPS handler:
        socket.on(MessageTypeFPS.RELOAD_WEAPON_FPS, () => {
            if (!associatedUserId || !players[associatedUserId] || players[associatedUserId].state !== 'alive') return;
            const playerState = players[associatedUserId];
            if (playerState.isReloading) return;
            const activeWeaponId = playerState.weaponSlots[playerState.activeWeaponSlot];
            const weaponConfig = WEAPON_CONFIG_FPS[activeWeaponId];
            if (!weaponConfig) return;
            if (playerState.currentAmmoInClip >= weaponConfig.ammoCapacity) return;
            // Start reload
            playerState.isReloading = true;
            console.log(`[RELOAD_START] ${associatedUserId} started reloading ${activeWeaponId}`);
            broadcastGameState();
            setTimeout(() => {
                // Check if player is still alive and reloading the same weapon
                if (!players[associatedUserId] || players[associatedUserId].state !== 'alive' || !playerState.isReloading) return;
                // Complete reload
                playerState.currentAmmoInClip = weaponConfig.ammoCapacity;
                playerState[`ammoInClipSlot${playerState.activeWeaponSlot}`] = weaponConfig.ammoCapacity;
                playerState.isReloading = false;
                console.log(`[RELOAD_COMPLETE] ${associatedUserId} reloaded ${activeWeaponId}`);
                broadcastGameState();
            }, weaponConfig.reloadTime);
        });
        // [DELETE/REPLACE] Remove any old THROW_GRENADE_FPS handler or TODOs
        // [REPLACE] Implement robust THROW_GRENADE_FPS handler:
        socket.on(MessageTypeFPS.THROW_GRENADE_FPS, (data) => {
            if (!associatedUserId || !players[associatedUserId] || players[associatedUserId].state !== 'alive') return;
            const playerState = players[associatedUserId];
            const grenadeType = data.type;
            if (!grenadeType || !playerState.grenades[grenadeType] || playerState.grenades[grenadeType] <= 0) return;
            const grenadeConfig = GRENADE_CONFIG_FPS[grenadeType];
            if (!grenadeConfig) return;
            // Decrement grenade count
            playerState.grenades[grenadeType]--;
            // Calculate throw origin and direction
            const throwOrigin = { ...playerState.position };
            const throwDir = data.direction || { x: 0, y: 1, z: 0 };
            const throwVel = 20; // Tune as needed
            // Create grenade physics object
            const grenadeId = `g_${Date.now()}_${Math.floor(Math.random()*10000)}`;
            const grenadeBodyDesc = RAPIER.RigidBodyDesc.dynamic()
                .setTranslation(throwOrigin.x, throwOrigin.y, throwOrigin.z)
                .setLinvel(throwDir.x * throwVel, throwDir.y * throwVel, throwDir.z * throwVel)
                .setCcdEnabled(true);
            const grenadeBody = rapierWorld.createRigidBody(grenadeBodyDesc);
            const grenadeRadius = 0.1;
            const grenadeColliderDesc = RAPIER.ColliderDesc.ball(grenadeRadius)
                .setCollisionGroups(interactionGroups(CollisionGroup.GRENADE, [CollisionGroup.WORLD, CollisionGroup.PLAYER_BODY]))
                .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
                .setRestitution(0.5)
                .setDensity(1.0);
            const grenadeCollider = rapierWorld.createCollider(grenadeColliderDesc, grenadeBody);
            // Store grenade state
            if (!global.activeGrenades) global.activeGrenades = {};
            global.activeGrenades[grenadeId] = {
                id: grenadeId,
                type: grenadeType,
                body: grenadeBody,
                collider: grenadeCollider,
                ownerId: associatedUserId,
                startTime: Date.now(),
                fuseTimer: null,
            };
            // Start fuse timer
            global.activeGrenades[grenadeId].fuseTimer = setTimeout(() => {
                // Detonate grenade
                const grenade = global.activeGrenades[grenadeId];
                if (!grenade) return;
                const pos = grenade.body.translation();
                // AoE effect
                if (grenadeType === GrenadeType.FRAG || grenadeType === GrenadeType.SEMTEX) {
                    const explosionShape = new RAPIER.Ball(grenadeConfig.effectRadius);
                    rapierWorld.intersectionsWithShape(pos, {w:1}, explosionShape, null, (collider) => {
                        const userData = collider.userData;
                        if (userData && userData.type === 'playerBody' && players[userData.playerId]) {
                            const victim = players[userData.playerId];
                            let damage = grenadeConfig.damage;
                            let shieldDmg = Math.min(victim.shield, damage);
                            victim.shield -= shieldDmg;
                            let healthDmg = damage - shieldDmg;
                            if (healthDmg > 0) victim.health = Math.max(0, victim.health - healthDmg);
                            if (victim.health <= 0) {
                                victim.state = 'dead';
                                victim.deaths++;
                                playerState.kills++;
                                io.emit(MessageTypeFPS.PLAYER_DIED_FPS, { victimId: userData.playerId, killerId: associatedUserId });
                            }
                        }
                        return true;
                    });
                } else if (grenadeType === GrenadeType.FLASHBANG) {
                    // Flash effect (simplified)
                    for (const pid in players) {
                        const victim = players[pid];
                        if (victim && victim.state === 'alive') {
                            victim.isFlashedUntil = Date.now() + (grenadeConfig.flashDuration || 2000);
                        }
                    }
                }
                // Broadcast explosion event
                io.emit(MessageTypeFPS.GRENADE_EXPLODED_FPS, { id: grenadeId, type: grenadeType, position: pos });
                // Cleanup
                rapierWorld.removeCollider(grenade.collider, false);
                rapierWorld.removeRigidBody(grenade.body);
                clearTimeout(grenade.fuseTimer);
                delete global.activeGrenades[grenadeId];
                broadcastGameState();
            }, grenadeConfig.fuseTime);
            // Log event
            console.log(`[GRENADE_THROWN] ${associatedUserId} threw ${grenadeType} (${grenadeId})`);
            broadcastGameState();
        });

        socket.on(MessageTypeFPS.USE_ABILITY_FPS, (data) => {
            if (!associatedUserId || !players[associatedUserId] || players[associatedUserId].state !== 'alive') return;
            const playerState = players[associatedUserId];
            const abilitySlot = data.abilitySlot;
            if (abilitySlot !== 1 || playerState.ability1CooldownRemaining > 0) return;
            const abilityType = playerState.ability1Type;
            const abilityConfig = ABILITY_CONFIG_FPS[abilityType];
            if (!abilityConfig) return;
            // Start cooldown
            playerState.ability1CooldownRemaining = abilityConfig.cooldown;
            // Apply effect
            if (abilityType === 'dash') {
                // Dash: apply impulse in look direction
                const body = playerState.rapierBody;
                if (body) {
                    const lookQuat = playerState.rotation;
                    // Calculate forward vector from quaternion
                    const q = lookQuat;
                    const forward = {
                        x: 2 * (q.x * q.z + q.w * q.y),
                        y: 0,
                        z: 1 - 2 * (q.y * q.y + q.x * q.x)
                    };
                    const mag = Math.sqrt(forward.x**2 + forward.z**2);
                    if (mag > 1e-6) { forward.x /= mag; forward.z /= mag; }
                    const dashImpulse = { x: forward.x * abilityConfig.effectValue, y: 0.5, z: forward.z * abilityConfig.effectValue };
                    body.applyImpulse(dashImpulse, true);
                }
            } else if (abilityType === 'heal_burst') {
                // Heal: restore shield, then health
                const maxShield = CHARACTER_CONFIG_FPS[playerState.characterId].baseShield;
                const maxHealth = CHARACTER_CONFIG_FPS[playerState.characterId].baseHealth;
                let healLeft = abilityConfig.effectValue;
                const shieldHeal = Math.min(maxShield - playerState.shield, healLeft);
                playerState.shield += shieldHeal;
                healLeft -= shieldHeal;
                if (healLeft > 0) {
                    const healthHeal = Math.min(maxHealth - playerState.health, healLeft);
                    playerState.health += healthHeal;
                }
            } else if (abilityType === 'damage_amp') {
                // Damage amp: set active until timestamp
                playerState.damageAmpActiveUntil = Date.now() + (abilityConfig.duration || 5000);
            }
            // Log event
            console.log(`[ABILITY_USED] ${associatedUserId} used ${abilityType}`);
            // Broadcast ability use event and updated state
            io.emit(MessageTypeFPS.ABILITY_USED_FPS, { playerId: associatedUserId, abilityType });
            broadcastGameState();
        });

        // [DELETE/REPLACE] Remove any old FIRE_GRAPPLE_FPS and RELEASE_GRAPPLE_FPS handlers or TODOs
        // [REPLACE] Implement robust grapple gun handlers:
        socket.on(MessageTypeFPS.FIRE_GRAPPLE_FPS, (data) => {
            if (!associatedUserId || !players[associatedUserId] || players[associatedUserId].state !== 'alive') return;
            const playerState = players[associatedUserId];
            if (playerState.grappleState.active) return;
            const target = data.targetPoint;
            if (!target) return;
            const body = playerState.rapierBody;
            if (!body) return;
            const pos = body.translation();
            // Check range
            const dx = target.x - pos.x, dy = target.y - pos.y, dz = target.z - pos.z;
            const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
            const MAX_GRAPPLE_RANGE = 31;
            if (dist > MAX_GRAPPLE_RANGE) return;
            // Server-side raycast for line of sight
            const ray = new RAPIER.Ray(pos, { x: dx/dist, y: dy/dist, z: dz/dist });
            const hit = rapierWorld.castRay(ray, dist + 0.1, true);
            if (!hit || hit.toi > dist + 0.05) return;
            // Set grapple state
            playerState.grappleState = {
                active: true,
                targetPoint: { x: target.x, y: target.y, z: target.z },
                startTime: Date.now(),
            };
            console.log(`[GRAPPLE_FIRED] ${associatedUserId} grappled to (${target.x},${target.y},${target.z})`);
            broadcastGameState();
        });
        socket.on(MessageTypeFPS.RELEASE_GRAPPLE_FPS, () => {
            if (!associatedUserId || !players[associatedUserId] || players[associatedUserId].state !== 'alive') return;
            const playerState = players[associatedUserId];
            if (!playerState.grappleState.active) return;
            playerState.grappleState = { active: false, targetPoint: null, startTime: null };
            console.log(`[GRAPPLE_RELEASED] ${associatedUserId} released grapple`);
            broadcastGameState();
        });

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


// --- Input Handler: Receives PLAYER_INPUT_FPS, validates, stores, and applies to physics ---
function handlePlayerInput(playerId, inputData) {
    // Validate player state
    const playerState = players[playerId];
    if (!playerState || playerState.state !== 'alive' || !playerState.rapierBody) return;
    const { sequence, deltaTime, keys, lookQuat } = inputData;
    // Sequence validation (allow some out-of-order, but ignore duplicates)
    if (sequence <= playerState.lastProcessedSequence) return;
    // Store input for reconciliation/lag comp
    const MAX_INPUT_HISTORY = 120;
    playerState.inputHistory[sequence] = { keys, lookQuat, deltaTime };
    const historyKeys = Object.keys(playerState.inputHistory);
    if (historyKeys.length > MAX_INPUT_HISTORY) delete playerState.inputHistory[historyKeys[0]];
    // Apply input to physics
    applyMovementInputToPlayer(playerId, playerState.rapierBody, keys, lookQuat, deltaTime);
    playerState.lastProcessedSequence = sequence;
    playerState.rotation = { ...lookQuat };
    // Speed validation (allow higher if dash/grapple active)
    const currentLinvel = playerState.rapierBody.linvel();
    let allowedMaxSpeed = MAX_PLAYER_SPEED;
    if (playerState.ability1Type === ABILITY_CONFIG_FPS.DASH && playerState.ability1CooldownRemaining > 0) allowedMaxSpeed *= 1.5;
    if (playerState.grappleState.active) allowedMaxSpeed *= 2.0;
    const currentSpeed = Math.sqrt(currentLinvel.x**2 + currentLinvel.y**2 + currentLinvel.z**2);
    if (currentSpeed > allowedMaxSpeed) {
        // Clamp velocity
        const clampScale = allowedMaxSpeed / currentSpeed;
        playerState.rapierBody.setLinvel({ x: currentLinvel.x * clampScale, y: currentLinvel.y, z: currentLinvel.z * clampScale }, true);
    }
}

// --- Movement Engine: Applies validated input to Rapier body ---
function applyMovementInputToPlayer(playerId, playerBody, keys, lookQuat, deltaTime) {
    if (!playerBody || deltaTime <= 0) return;
    const playerState = players[playerId];
    const isOnGround = playerState.isOnGround;
    const canJump = isOnGround && (Date.now() - playerState.lastJumpTime > 300);
    // Calculate desired movement
    let desiredVelocity = { x: 0, z: 0 };
    let moveDirection = { x: 0, z: 0 };
    let isMoving = false;
    // Yaw-only quaternion for ground movement
    const yawQuaternion = { x:0, y: lookQuat.y, z: 0, w: lookQuat.w };
    const yawMag = Math.sqrt(yawQuaternion.y**2 + yawQuaternion.w**2);
    if (yawMag > 1e-6) { yawQuaternion.y /= yawMag; yawQuaternion.w /= yawMag; } else { yawQuaternion.w = 1.0; }
    const _forward = {x: 0, y: 0, z: -1};
    const _right = {x: 1, y: 0, z: 0};
    const forward = applyQuaternion(_forward, yawQuaternion);
    const right = applyQuaternion(_right, yawQuaternion);
    if (keys.W) { moveDirection.x += forward.x; moveDirection.z += forward.z; isMoving = true; }
    if (keys.S) { moveDirection.x -= forward.x; moveDirection.z -= forward.z; isMoving = true; }
    if (keys.A) { moveDirection.x -= right.x; moveDirection.z -= right.z; isMoving = true; }
    if (keys.D) { moveDirection.x += right.x; moveDirection.z += right.z; isMoving = true; }
    if (isMoving) {
        const mag = Math.sqrt(moveDirection.x**2 + moveDirection.z**2);
        if (mag > 1e-6) { moveDirection.x /= mag; moveDirection.z /= mag; }
        const targetSpeed = keys.Shift ? RUN_SPEED : WALK_SPEED;
        desiredVelocity.x = moveDirection.x * targetSpeed;
        desiredVelocity.z = moveDirection.z * targetSpeed;
    }
    // Apply force
    const currentLinvel = playerBody.linvel();
    let force = { x: 0, y: 0, z: 0 };
    const velocityDiffX = desiredVelocity.x - currentLinvel.x;
    const velocityDiffZ = desiredVelocity.z - currentLinvel.z;
    force.x = velocityDiffX * ACCELERATION_FORCE * deltaTime;
    force.z = velocityDiffZ * ACCELERATION_FORCE * deltaTime;
    if (!isOnGround) { force.x *= AIR_CONTROL_FACTOR; force.z *= AIR_CONTROL_FACTOR; }
    const forceMagnitude = Math.sqrt(force.x**2 + force.z**2);
    if (forceMagnitude > MAX_ACCEL_FORCE) {
        const scale = MAX_ACCEL_FORCE / forceMagnitude;
        force.x *= scale; force.z *= scale;
    }
    playerBody.applyImpulse(force, true);
    // Jumping
    if (keys.Space && canJump) {
        playerBody.applyImpulse({ x: 0, y: JUMP_IMPULSE, z: 0 }, true);
        playerState.isOnGround = false;
        playerState.lastJumpTime = Date.now();
    }
    // Grapple Gun Physics (if active)
    if (playerState.grappleState.active && playerState.grappleState.targetPoint) {
        const pos = playerBody.translation();
        const target = playerState.grappleState.targetPoint;
        const dir = { x: target.x - pos.x, y: target.y - pos.y, z: target.z - pos.z };
        const dist = Math.sqrt(dir.x**2 + dir.y**2 + dir.z**2);
        if (dist > 0.5) {
            const norm = { x: dir.x/dist, y: dir.y/dist, z: dir.z/dist };
            const grappleForce = 60.0; // Tune as needed
            playerBody.applyImpulse({ x: norm.x * grappleForce * deltaTime, y: norm.y * grappleForce * deltaTime, z: norm.z * grappleForce * deltaTime }, true);
        } else {
            // Auto-release grapple if close
            playerState.grappleState.active = false;
            playerState.grappleState.targetPoint = null;
            playerState.grappleState.startTime = null;
        }
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
    const spawnPoints = mapConfig?.physicsData?.spawnPoints || [{x: 1, y: 4, z: 0}]; // Default spawn
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