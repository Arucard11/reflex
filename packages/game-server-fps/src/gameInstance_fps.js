// Import yargs
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

// Import Core Server Dependencies
const RAPIER = require('@dimforge/rapier3d-compat');
const { Server } = require("socket.io");
const http = require('http');
const fs = require('fs'); // For loading map data/keypair later
// NEW: Import express for metrics server
const { performance } = require('perf_hooks'); // For precise timing

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
let currentMatchState = {
    matchState: 'loading',
    currentRound: 1,
    timeRemaining: 0,
    roundWins: { p1: 0, p2: 0 }
}; // Initial state object
let activeProjectiles = {}; // NEW: To store active projectiles
let nextProjectileId = 0; // NEW: To generate unique projectile IDs
// let timeRemaining = 0; // Managed by match flow later

// NEW: Define variables for imported types in the module scope
let MapId, CharacterId, GrenadeType, MessageTypeFPS, MAP_CONFIGS_FPS, CHARACTER_CONFIG_FPS, WEAPON_CONFIG_FPS, ABILITY_CONFIG_FPS, CollisionGroup, interactionGroups, MAX_SLOPE_ANGLE_RAD;

// NEW: Define variables for physics constants
let CHARACTER_VISUAL_SCALE, PLAYER_TOTAL_HEIGHT, PLAYER_RADIUS, WALK_SPEED, RUN_SPEED, JUMP_IMPULSE, ACCELERATION_FORCE, MAX_ACCEL_FORCE, AIR_CONTROL_FACTOR, MIN_FORCE_THRESHOLD, STOP_FORCE_MULTIPLIER, VELOCITY_SMOOTHING;

// --- Constants for Movement ---
const TICK_RATE = 60; // Ticks per second
const TICK_INTERVAL_MS = 1000 / TICK_RATE;     
// DELETED: All movement constants are now imported from the shared package.
const MAX_PLAYER_SPEED = 5.0; // Reduced to match new run speed
const DAMPING_FACTOR = 0.95;

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
        MAX_SLOPE_ANGLE_RAD = sharedTypes.MAX_SLOPE_ANGLE_RAD;
        
        // NEW: Load physics constants from shared package
        const physicsConstants = sharedTypes.PHYSICS_CONSTANTS;
        CHARACTER_VISUAL_SCALE = physicsConstants.CHARACTER_VISUAL_SCALE;
        PLAYER_TOTAL_HEIGHT = physicsConstants.PLAYER_TOTAL_HEIGHT;
        PLAYER_RADIUS = physicsConstants.PLAYER_RADIUS;
        WALK_SPEED = physicsConstants.WALK_SPEED;
        RUN_SPEED = physicsConstants.RUN_SPEED;
        JUMP_IMPULSE = physicsConstants.JUMP_IMPULSE;
        ACCELERATION_FORCE = physicsConstants.ACCELERATION_FORCE;
        MAX_ACCEL_FORCE = physicsConstants.MAX_ACCEL_FORCE;
        AIR_CONTROL_FACTOR = physicsConstants.AIR_CONTROL_FACTOR;
        MIN_FORCE_THRESHOLD = physicsConstants.MIN_FORCE_THRESHOLD;
        STOP_FORCE_MULTIPLIER = physicsConstants.STOP_FORCE_MULTIPLIER;
        VELOCITY_SMOOTHING = physicsConstants.VELOCITY_SMOOTHING;
        
        console.log("Shared types and physics constants loaded dynamically.");
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
        .option('mapId', { type: 'string', demandOption: true, describe: 'ID of the map to load' })
        // Player Info (Plan 1.2.1)
        .option('player1UserId', { type: 'string', demandOption: true })
        .option('player1Wallet', { type: 'string', demandOption: true })
        .option('player1CharId', { type: 'string', demandOption: true, describe: 'Character ID for Player 1' })
        .option('player2UserId', { type: 'string', demandOption: true })
        .option('player2Wallet', { type: 'string', demandOption: true })
        .option('player2CharId', { type: 'string', demandOption: true, describe: 'Character ID for Player 2' })
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
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(position.x, position.y, position.z)
        .setCanSleep(false)
        .setCcdEnabled(true) // Enable continuous collision detection
        .lockRotations() // Lock rotations to prevent capsule from falling over
        .setLinearDamping(0.9) // Reduced from 4.2 to prevent "stuck in mud" feeling
        .setAngularDamping(1.0); // Reduced from 8.0 for stability
    const rapierBody = rapierWorld.createRigidBody(bodyDesc);

    // Using a capsule for the player body
    const capsuleHalfHeight = PLAYER_TOTAL_HEIGHT / 2 - PLAYER_RADIUS;
    const colliderDesc = RAPIER.ColliderDesc.capsule(capsuleHalfHeight, PLAYER_RADIUS)
        .setDensity(800.0) // High density to push objects
        .setFriction(0.8) // Standard friction
        .setRestitution(0.02) // Minimal bounce
        .setCollisionGroups(interactionGroups(
            CollisionGroup.PLAYER_BODY, // This object is a PLAYER_BODY
            [CollisionGroup.WORLD, CollisionGroup.PLAYER_BODY, CollisionGroup.GRENADE, CollisionGroup.PROJECTILE] // It collides with WORLD, other PLAYER_BODY, GRENADES, and PROJECTILES
        ))
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);

    const collider = rapierWorld.createCollider(colliderDesc, rapierBody);
    
    // IMPORTANT: Set userData for hit detection
    collider.userData = {
        type: 'playerBody',
        playerId: playerId
    };

    console.log(`Physics body created for ${playerId} with handle: ${rapierBody.handle}`);
    return rapierBody; // Return the created body
}

// Step 3: Load Map Physics (1.2.2 - Modified for No Fallback)
function loadMapPhysics(mapId) {
    console.log(`Loading Physics for Map ID: ${mapId}...`);
    let loadedSuccessfully = false;
    const mapConfig = MAP_CONFIGS_FPS[mapId];

    if (!mapConfig || !mapConfig.physicsData) {
        console.error(`[Physics Load] FATAL: No map config or physics data found for map: ${mapId}`);
    } else {
        const physicsData = mapConfig.physicsData;
        if (physicsData.vertices && physicsData.vertices.length > 0 && physicsData.indices && physicsData.indices.length > 0) {
            if (validateTrimeshData(physicsData.vertices, physicsData.indices)) {
                try {
                    const rigidBodyDesc = RAPIER.RigidBodyDesc.fixed();
                    const body = rapierWorld.createRigidBody(rigidBodyDesc);
                    const trimeshDesc = RAPIER.ColliderDesc.trimesh(physicsData.vertices, physicsData.indices);
                    console.log('[Physics Load] TrimeshDesc created.');
                    
                    const groups = interactionGroups(
                        CollisionGroup.WORLD,
                        [CollisionGroup.PLAYER_BODY, CollisionGroup.GRENADE, CollisionGroup.PROJECTILE, CollisionGroup.PLAYER_UTILITY_RAY]
                    );
                    trimeshDesc.setCollisionGroups(groups);
                    console.log(`[Physics Load] Trimesh Set collision groups to: ${groups}`);

                    const collider = rapierWorld.createCollider(trimeshDesc, body);
                    console.log(`[Physics Load] SUCCESS: Created trimesh map collider handle: ${collider.handle} attached to body handle: ${body.handle}`);
                    loadedSuccessfully = true;
                } catch (error) {
                    console.error(`[Physics Load] FATAL: Failed to create trimesh collider for map ${mapId}:`, error);
                }
            } else {
                console.error(`[Physics Load] FATAL: Trimesh data for map ${mapId} is invalid.`);
            }
        } else {
            console.error(`[Physics Load] FATAL: No valid trimesh data found for map ${mapId}.`);
        }
    }

    if (!loadedSuccessfully) {
        console.error(`[Physics Load] CRITICAL: Map physics could not be loaded for map '${mapId}'. The server will now exit.`);
        exitProcess(1); // Exit with an error code.
    }

    console.log(`[Physics Load] Physics loading attempt complete for Map ${mapId}.`);
}

// NEW: Validate trimesh data for corruption
function validateTrimeshData(vertices, indices) {
    try {
        // Check for reasonable data sizes
        if (vertices.length < 9 || indices.length < 3) {
            console.error(`[Trimesh Validation] Data too small: vertices=${vertices.length}, indices=${indices.length}`);
            return false;
        }
        
        // Check for NaN or infinite values
        for (let i = 0; i < Math.min(100, vertices.length); i++) {
            if (!isFinite(vertices[i])) {
                console.error(`[Trimesh Validation] Invalid vertex value at index ${i}: ${vertices[i]}`);
                return false;
            }
        }
        
        // Check for valid indices
        const maxVertexIndex = (vertices.length / 3) - 1;
        for (let i = 0; i < Math.min(100, indices.length); i++) {
            if (indices[i] < 0 || indices[i] > maxVertexIndex) {
                console.error(`[Trimesh Validation] Invalid index at ${i}: ${indices[i]} (max: ${maxVertexIndex})`);
                return false;
            }
        }
        
        console.log(`[Trimesh Validation] Data appears valid. Vertices: ${vertices.length/3}, Triangles: ${indices.length/3}`);
        return true;
    } catch (error) {
        console.error(`[Trimesh Validation] Validation failed:`, error);
        return false;
    }
}

// NEW: Create a simple ground plane as fallback
function createFallbackGroundPlane() {
    console.log(`[Physics Load] Creating fallback ground plane...`);
    try {
        const rigidBodyDesc = RAPIER.RigidBodyDesc.fixed();
        const body = rapierWorld.createRigidBody(rigidBodyDesc);
        
        // Create a large ground plane at Y=0
        const colliderDesc = RAPIER.ColliderDesc.cuboid(50, 0.1, 50) // 100x0.2x100 ground plane
            .setTranslation(0, -0.1, 0) // Position slightly below Y=0
            .setCollisionGroups(interactionGroups(
                CollisionGroup.WORLD,
                [CollisionGroup.PLAYER_BODY, CollisionGroup.GRENADE, CollisionGroup.PROJECTILE, CollisionGroup.PLAYER_UTILITY_RAY]
            ));
        
        const collider = rapierWorld.createCollider(colliderDesc, body);
        console.log(`[Physics Load] SUCCESS: Created fallback ground plane collider handle: ${collider.handle}`);
    } catch (error) {
        console.error(`[Physics Load] CRITICAL: Failed to create fallback ground plane:`, error);
        throw new Error("Cannot create any physics collision geometry");
    }
}

const getPlayerIds = () => [config.playersInfo.p1.userId, config.playersInfo.p2.userId];

// Step 4: Initialize Player States (1.2.2)
function initializePlayerStates() {
    console.log('Initializing player states...');
    const playerIds = getPlayerIds();

    playerIds.forEach((playerId, index) => {
        const playerInfo = (index === 0) ? config.playersInfo.p1 : config.playersInfo.p2;
        const charConfig = CHARACTER_CONFIG_FPS[playerInfo.charId];
        if (!charConfig) {
            throw new Error(`Character config not found for charId: ${playerInfo.charId}`);
        }
        
        const defaultWeapon1 = 'rifle';
        const defaultWeapon2 = 'sniper';
        const weapon1Config = WEAPON_CONFIG_FPS[defaultWeapon1];
        const weapon2Config = WEAPON_CONFIG_FPS[defaultWeapon2];

        players[playerId] = {
            userId: playerId,
            wallet: playerInfo.wallet,
            characterId: playerInfo.charId,
            state: 'waiting',
            position: { x: 0, y: 1, z: 0 },
            rotation: { x: 0, y: 0, z: 0, w: 1 },
            lookDirection: { x: 0, y: 0, z: 0, w: 1 }, // NEW: To store the full look quaternion for accurate shooting
            velocity: { x: 0, y: 0, z: 0 },
            health: charConfig.baseHealth,
            shield: charConfig.baseShield,
            kills: 0,
            deaths: 0,
            roundWins: 0,
            lastProcessedSequence: -1,
            grenades: {
                [GrenadeType.SEMTEX]: 1,
                [GrenadeType.FLASHBANG]: 1,
                [GrenadeType.FRAG]: 1,
            },
            ability1CooldownRemaining: 0,
            ability1Type: charConfig.ability1,
            
            weaponSlots: [defaultWeapon1, defaultWeapon2],
            activeWeaponSlot: 0,
            isReloading: false,
            ammoInClip: {
                0: weapon1Config?.ammoCapacity || 0,
                1: weapon2Config?.ammoCapacity || 0,
            },
            currentAmmoInClip: weapon1Config?.ammoCapacity || 0,
            
            keys: {}, // To store the current input state
            
            grappleState: { active: false, targetPoint: null, startTime: null },
            
            rapierBody: null,
            positionHistory: [],
            inputHistory: {},
            lastInputTimestamp: performance.now(),
            lastBroadcastState: null,
            isOnGround: false,
            groundNormal: null, // NEW: For slope calculations
            slopeAngle: 0, // NEW: For slope calculations
            lastGroundContactTime: 0,
            lastJumpTime: 0, // NEW: For jump cooldown
            currentSpread: WEAPON_CONFIG_FPS[defaultWeapon1]?.baseSpread || 0,
            lastFireTime: 0,
            spreadRecoveryTimer: null,
            // NEW: Add weapon switching delay timer
            weaponSwitchTimer: 0,
            weaponSwitchDelay: 250, // ms delay for weapon switching (for balance)
            
            // NEW: Replace setTimeout-based reload with deltaTime-based timer
            reloadTimer: 0,        // Current reload progress in ms
            reloadDuration: 0,     // Total reload duration for current weapon
        };
        console.log(`Initialized state for ${playerId} (Char: ${playerInfo.charId})`);
    });
}

// Step 5: Initialize Socket.IO (1.2.2)
function initSocketIO() {
    console.log(`Initializing Socket.IO on port ${config.port}...`);
    const httpServer = http.createServer();
    io = new Server(httpServer, {
        cors: { origin: "*", methods: ["GET", "POST"] } // Restrict in prod
    });

    io.on('connection', (socket) => {
        console.log(`Client socket connected: ${socket.id}`);
        let associatedUserId = null;

        const identifyTimeout = setTimeout(() => {
            if (!associatedUserId) {
                console.log(`Socket ${socket.id} did not identify in time. Disconnecting.`);
                socket.disconnect(true);
            }
        }, 2000);

        socket.on(MessageTypeFPS.IDENTIFY_PLAYER, (data) => {
            const { userId, matchId } = data;
            console.log(`Socket ${socket.id} attempting to identify as User ID: ${userId} for Match ID: ${matchId}`);

            if (matchId !== config.matchId) {
                console.warn(`Socket ${socket.id} provided wrong matchId. Expected ${config.matchId}, got ${matchId}. Disconnecting.`);
                socket.disconnect(true);
                return;
            }

            const playerIds = getPlayerIds();
            if (!playerIds.includes(userId)) {
                console.warn(`Socket ${socket.id} provided unknown userId ${userId}. Disconnecting.`);
                socket.disconnect(true);
                return;
            }
            
            if (connectedPlayers[userId]) {
                console.warn(`User ${userId} already has an active connection. Disconnecting new socket ${socket.id}.`);
                socket.disconnect(true);
                return;
            }

            clearTimeout(identifyTimeout);
            associatedUserId = userId;
            connectedPlayers[userId] = { socketId: socket.id, socket: socket };
            if(players[userId]) {
                players[userId].state = 'connected';
            }
            
            console.log(`Socket ${socket.id} successfully associated with User ID: ${associatedUserId}`);
            
            // NEW: Send physics constants to the client first
            const physicsConstants = {
                CHARACTER_VISUAL_SCALE: CHARACTER_VISUAL_SCALE,
                PLAYER_TOTAL_HEIGHT: PLAYER_TOTAL_HEIGHT,
                PLAYER_RADIUS: PLAYER_RADIUS,
                WALK_SPEED: WALK_SPEED,
                RUN_SPEED: RUN_SPEED,
                JUMP_IMPULSE: JUMP_IMPULSE,
                ACCELERATION_FORCE: ACCELERATION_FORCE,
                MAX_ACCEL_FORCE: MAX_ACCEL_FORCE,
                AIR_CONTROL_FACTOR: AIR_CONTROL_FACTOR,
                VELOCITY_SMOOTHING: VELOCITY_SMOOTHING,
                MIN_FORCE_THRESHOLD: MIN_FORCE_THRESHOLD
            };
            socket.emit(MessageTypeFPS.GAME_CONSTANTS_FPS, physicsConstants);
            console.log(`📋 [SERVER] Sent game constants to ${associatedUserId}:`, physicsConstants);
            
            socket.emit(MessageTypeFPS.GAME_STATE_FPS, getFullGameStatePayload(associatedUserId));
            
            checkStartMatch();
        });

        const getPlayerIdFromSocket = (sock) => {
            for (const userId in connectedPlayers) {
                if (connectedPlayers[userId]?.socketId === sock.id) {
                    return userId;
                }
            }
            return null;
        };
        
        socket.on(MessageTypeFPS.PLAYER_INPUT_FPS, (inputData) => {
            const playerId = getPlayerIdFromSocket(socket);
            if (playerId) {
                handlePlayerInput(playerId, inputData);
            }
        });
        
        socket.on(MessageTypeFPS.PLAYER_FIRE_FPS, (fireData) => {
            const playerId = getPlayerIdFromSocket(socket);
            if (!playerId || !players[playerId] || players[playerId].state !== 'alive') return;

            const playerState = players[playerId];
            const weaponConfig = WEAPON_CONFIG_FPS[playerState.weaponSlots[playerState.activeWeaponSlot]];
            if (!weaponConfig || playerState.isReloading || playerState.currentAmmoInClip <= 0) return;

            const now = performance.now();
            if (now - playerState.lastFireTime < weaponConfig.fireRate) return;

            playerState.lastFireTime = now;
            playerState.currentAmmoInClip--;
            playerState.currentSpread = Math.min(
                weaponConfig.maxSpread,
                playerState.currentSpread + weaponConfig.spreadIncreasePerShot
            );

            if (playerState.activeWeaponSlot === 0) {
                playerState.ammoInClip[0] = playerState.currentAmmoInClip;
            } else {
                playerState.ammoInClip[1] = playerState.currentAmmoInClip;
            }

            const authoritativeState = getPlayerAuthoritativeStateAtSequence(playerId, fireData.sequence);
            const fireDirectionQuat = authoritativeState.lookQuat;
            
            // NEW: Set raycast origin to 75% of player height for more realistic firing origin
            const fireOriginHeight = PLAYER_TOTAL_HEIGHT * 0.75;

            // Start the ray from the player's physics body position, elevated to the new origin height.
            const fireOrigin = { 
                x: authoritativeState.position.x, 
                y: authoritativeState.position.y + fireOriginHeight - (PLAYER_TOTAL_HEIGHT / 2), // Adjust for capsule center
                z: authoritativeState.position.z 
            };
            
            const fireDirection = applySpreadToDirection(fireDirectionQuat, playerState);

            const ray = new RAPIER.Ray(fireOrigin, fireDirection);
            const maxDistance = weaponConfig.range;
            
            // Define the groups the ray can interact with: WORLD and other PLAYER_BODYs
            const filterGroups = interactionGroups(
                CollisionGroup.PROJECTILE, 
                [CollisionGroup.WORLD, CollisionGroup.PLAYER_BODY]
            );

            // Get the shooter's collider to exclude it from the raycast
            const shooterCollider = playerState.rapierBody.collider(0);
            
            // The hit filter ensures we don't hit the shooter themselves.
            const hit = rapierWorld.castRayAndGetNormal(
                ray,
                maxDistance,
                true, // solid
                undefined, // queryDisptacher
                filterGroups, // collision groups
                shooterCollider, // collider to exclude
                undefined // rigid body to exclude
            );

            let endPosition;
            let hitResult = null;
            
            if (hit) {
                const hitCollider = rapierWorld.getCollider(hit.colliderHandle);
                const hitUserData = hitCollider?.userData;
                const hitPoint = ray.pointAt(hit.toi);
                endPosition = hitPoint;

                // DIAGNOSTIC: Add more detailed logging
                console.log(`🎯 [SERVER] RAY HIT! ColliderHandle: ${hit.colliderHandle}, ParentBodyHandle: ${hitCollider.parent()?.handle}, UserData:`, hitUserData, `Distance: ${hit.toi.toFixed(3)}`);
                
                hitResult = { hit: true, point: hitPoint, distance: hit.toi, userData: hitUserData };
                processHit(playerId, hitCollider, hitUserData, hitPoint, weaponConfig.damage);

            } else {
                console.log(`🎯 [SERVER] RAY MISS!`);
                endPosition = {
                    x: fireOrigin.x + fireDirection.x * maxDistance,
                    y: fireOrigin.y + fireDirection.y * maxDistance,
                    z: fireOrigin.z + fireDirection.z * maxDistance,
                };
                hitResult = { hit: false, point: endPosition, distance: maxDistance };
            }
            
            io.emit(MessageTypeFPS.SHOT_FIRED_VISUAL_FPS, {
                ownerId: playerId,
                startPosition: fireOrigin,
                endPosition: endPosition,
                weaponId: weaponConfig.id,
                uniqueId: `${playerId}-${Date.now()}`,
                hitResult: hitResult
            });
            
            resetSpreadRecoveryTimer(playerState, weaponConfig);
        });
    
        socket.on(MessageTypeFPS.THROW_GRENADE_FPS, (data) => {
            const playerId = getPlayerIdFromSocket(socket);
            if(playerId) handleGrenadeThrow(playerId, data);
        });
    
        socket.on(MessageTypeFPS.SWITCH_WEAPON_FPS, () => {
            const playerId = getPlayerIdFromSocket(socket);
            if (!playerId) return;
    
            const playerState = players[playerId];
            if (!playerState || playerState.state !== 'alive') {
                return;
            }

            // NEW: Check if weapon switching is on cooldown
            if (playerState.weaponSwitchTimer > 0) {
                console.log(`Player ${playerId}: Weapon switch on cooldown (${playerState.weaponSwitchTimer}ms remaining)`);
                return;
            }

            // Cancel reload if they were reloading
            if (playerState.isReloading) {
                console.log(`Player ${playerId}: Cancelling reload to switch weapons`);
                playerState.isReloading = false;
                playerState.reloadTimer = 0;
                playerState.reloadDuration = 0;
            }

            // Switch slot
            const previousSlot = playerState.activeWeaponSlot;
            playerState.activeWeaponSlot = (playerState.activeWeaponSlot === 0) ? 1 : 0;
            
            // Update current ammo
            playerState.currentAmmoInClip = playerState.ammoInClip[playerState.activeWeaponSlot];

            // Reset spread for the new weapon
            const newWeaponId = playerState.weaponSlots[playerState.activeWeaponSlot];
            const newWeaponConfig = WEAPON_CONFIG_FPS[newWeaponId];
            playerState.currentSpread = newWeaponConfig?.baseSpread ?? 0;

            // NEW: Start weapon switch timer for balanced gameplay
            playerState.weaponSwitchTimer = playerState.weaponSwitchDelay;

            console.log(`Player ${playerId} switched from slot ${previousSlot} to slot ${playerState.activeWeaponSlot} (${newWeaponId})`);
            broadcastGameState();
        });
    
        socket.on(MessageTypeFPS.RELOAD_WEAPON_FPS, () => {
            const playerId = getPlayerIdFromSocket(socket);
            if (!playerId) return;
    
            const playerState = players[playerId];
            if (!playerState || playerState.state !== 'alive' || playerState.isReloading) {
                return;
            }

            // NEW: Check if weapon switching is in progress
            if (playerState.weaponSwitchTimer > 0) {
                console.log(`Player ${playerId}: Cannot reload while switching weapons`);
                return;
            }
    
            const activeWeaponId = playerState.weaponSlots[playerState.activeWeaponSlot];
            const weaponConfig = WEAPON_CONFIG_FPS[activeWeaponId];
    
            if (!weaponConfig || playerState.currentAmmoInClip >= weaponConfig.ammoCapacity) {
                console.log(`Player ${playerId}: Cannot reload ${activeWeaponId} (already full or invalid weapon)`);
                return;
            }
    
            console.log(`Player ${playerId}: Starting reload for ${activeWeaponId} (${weaponConfig.reloadTime}ms)`);
            
            // NEW: Start deltaTime-based reload timer
            playerState.isReloading = true;
            playerState.reloadTimer = 0;
            playerState.reloadDuration = weaponConfig.reloadTime;
            
            broadcastGameState();
        });

        socket.on('disconnect', (reason) => {
            console.log(`Client socket disconnected: ${socket.id}, Reason: ${reason}`);
            const playerId = getPlayerIdFromSocket(socket);
            if (playerId) {
                console.log(`User ${playerId} disconnected.`);
                delete connectedPlayers[playerId];
                if(players[playerId]) {
                    players[playerId].state = 'disconnected';
                }
                
                if (currentMatchState.matchState !== 'finished') {
                    console.log(`Player ${playerId} disconnected mid-game. Ending match.`);
                    const otherPlayerId = getPlayerIds().find(id => id !== playerId);
                    endMatch(otherPlayerId); 
                }
            }
        });
    });

    return httpServer;
}

// Step 6: Start Listener & Signal Readiness (1.2.3)
async function signalReadyToPlatform() {
    return new Promise((resolve, reject) => {
        if (!io) {
            return reject(new Error("Socket.IO server not initialized before signalling readiness."));
        }
        const httpServer = io.httpServer; // Access the http server instance from socket.io

        // --- Metrics Server ---
        // (Removed)
        // --- End Metrics Server ---

        httpServer.listen(config.port, () => {
            console.log(`Game server listening on port ${config.port}`);

            // --- Signal Readiness to Platform ---
            const canUseIPC = typeof process.send === 'function';
            if (canUseIPC) {
                const readyMessage = {
                    type: 'READY',
                    serverId: config.matchId,
                    port: config.port
                    // metricsPort: metricsPort // (Removed)
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

            currentMatchState.matchState = 'waiting';
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
    currentMatchState.matchState = 'in_progress'; // FIXED: Update the property, not the whole object

    gameLoopInterval = setInterval(() => {
        const tickStart = performance.now();

        // 1. Step Physics World
        if (rapierWorld) {
            rapierWorld.step();
        }

        // 2. Update Player States from Physics & Handle Game Logic
        for (const playerId in players) {
             const playerState = players[playerId];
             if (playerState.rapierBody && playerState.state === 'alive') {
                // Apply movement from last known input state
                if (playerState.keys) {
                    applyMovementInputToPlayer(
                        playerId,
                        playerState.rapierBody,
                        playerState.keys,
                        playerState.lookDirection,
                        TICK_INTERVAL_MS / 1000 // Use fixed server delta time
                    );
                }

                // >>> NEW: Check ground status <<< (Plan 2.2.1)
                updateGroundStatus(playerId);

                // Update position/velocity from Rapier body
                const pos = playerState.rapierBody.translation();
                const vel = playerState.rapierBody.linvel();
                playerState.position = { x: pos.x, y: pos.y, z: pos.z };
                playerState.velocity = { x: vel.x, y: vel.y, z: vel.z };
                
                // NEW: Store position history for lag compensation
                const MAX_HISTORY_LENGTH = 60; // Store ~1 second of history
                playerState.positionHistory.push({
                    sequence: playerState.lastProcessedSequence,
                    position: { ...playerState.position }
                });
                if (playerState.positionHistory.length > MAX_HISTORY_LENGTH) {
                    playerState.positionHistory.shift();
                }
                
                // NEW: Update weapon timers using deltaTime instead of setTimeout
                updateWeaponTimers(playerId, TICK_INTERVAL_MS);
            }

            // Update cooldowns (ability1, etc.)
            updateCooldowns(playerId, TICK_INTERVAL_MS);
        }

        // 3. Broadcast Game State
        broadcastGameState();

        // Record tick duration for metrics (REMOVED)
        // const tickEnd = performance.now();
        // tickDurationHist.observe(tickEnd - tickStart);

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
         matchState: currentMatchState.matchState, // Send just the string, not the whole object
         timeRemaining: currentMatchState.timeRemaining,
         currentRound: currentMatchState.currentRound,
         roundWins: currentMatchState.roundWins,
         players: playerStates,
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
        rotation: pState.rotation,
        velocity: pState.velocity,
        health: pState.health,
        shield: pState.shield,
        kills: pState.kills,
        deaths: pState.deaths,
        roundWins: pState.roundWins,
        grenades: pState.grenades,
        ability1CooldownRemaining: pState.ability1CooldownRemaining,
        weaponSlots: pState.weaponSlots,
        activeWeaponSlot: pState.activeWeaponSlot,
        isReloading: pState.isReloading,
        grappleState: pState.grappleState,
        isFlashedUntil: pState.isFlashedUntil,
        damageAmpActiveUntil: pState.damageAmpActiveUntil,
        currentAmmoInClip: pState.currentAmmoInClip,
        isOnGround: pState.isOnGround,
        lookDirection: pState.lookDirection,

        ...(isSelf && {
             lastProcessedSequence: pState.lastProcessedSequence,
             // Send the full ammo object only to the local player
             ammoInClip: pState.ammoInClip,
        })
    };

    return serializableState;
}

// NEW: Helper to get serializable state for active projectiles
function getSerializableProjectileState() {
    return Object.values(activeProjectiles).map(p => ({
        id: p.id,
        ownerId: p.ownerId,
        position: p.body.translation()
    }));
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
    const { sequence, keys, lookQuat } = inputData;
    // Sequence validation (allow some out-of-order, but ignore duplicates)
    if (sequence <= playerState.lastProcessedSequence) return;

    // Store the latest input state. This will be applied in the game loop.
    playerState.keys = keys;
    playerState.lookDirection = { ...lookQuat };
    playerState.lastProcessedSequence = sequence;

    // Restore input history for lag compensation
    const MAX_INPUT_HISTORY = 120;
    if (!playerState.inputHistory) playerState.inputHistory = {};
    playerState.inputHistory[sequence] = { keys, lookQuat };
    const historyKeys = Object.keys(playerState.inputHistory);
    if (historyKeys.length > MAX_INPUT_HISTORY) {
        delete playerState.inputHistory[historyKeys[0]];
    }

    // The player's body rotation (for broadcasting) should only have yaw.
    const yawQuaternion = { x: 0, y: lookQuat.y, z: 0, w: lookQuat.w };
    // Normalize the yaw-only quaternion
    const yawMag = Math.sqrt(yawQuaternion.y**2 + yawQuaternion.w**2);
    if (yawMag > 1e-6) {
        yawQuaternion.y /= yawMag;
        yawQuaternion.w /= yawMag;
    } else {
        yawQuaternion.y = 0;
        yawQuaternion.w = 1.0;
    }
    playerState.rotation = yawQuaternion;
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

    const _forward = {x: 0, y: 0, z: 1}; // FIXED: Use +Z as forward to match shooting logic
    const _right = {x: -1, y: 0, z: 0};   // FIXED: Right is negative X (inverted coordinate system)
    const forward = applyQuaternion(_forward, yawQuaternion);
    const right = applyQuaternion(_right, yawQuaternion);

    if (keys.W) { moveDirection.x += forward.x; moveDirection.z += forward.z; isMoving = true; }      // W key moves FORWARD (add forward vector)
    if (keys.S) { moveDirection.x -= forward.x; moveDirection.z -= forward.z; isMoving = true; }      // S key moves BACKWARD (subtract forward vector)
    if (keys.A) { moveDirection.x -= right.x; moveDirection.z -= right.z; isMoving = true; }        // A key moves LEFT (subtract right vector)
    if (keys.D) { moveDirection.x += right.x; moveDirection.z += right.z; isMoving = true; }        // D key moves RIGHT (add right vector)

    const currentLinvel = playerBody.linvel();
    const currentSpeed = Math.sqrt(currentLinvel.x**2 + currentLinvel.z**2);

    if (isMoving) {
        // Corrected normalization
        const mag = Math.sqrt(moveDirection.x**2 + moveDirection.z**2);
        if (mag > 1e-6) { moveDirection.x /= mag; moveDirection.z /= mag; }
        const targetSpeed = keys.Shift ? RUN_SPEED : WALK_SPEED;
        desiredVelocity.x = moveDirection.x * targetSpeed;
        desiredVelocity.z = moveDirection.z * targetSpeed;
    } else {
        // No input, so stop all horizontal movement directly.
        playerBody.setLinvel({ x: 0, y: currentLinvel.y, z: 0 }, true);
        desiredVelocity.x = 0;
        desiredVelocity.z = 0;
    }

    // Apply force with improved stability
    
    // NEW: Calculate velocity difference directly without smoothing to reduce lag
    const velocityDiffX = desiredVelocity.x - currentLinvel.x;
    const velocityDiffZ = desiredVelocity.z - currentLinvel.z;

    // Use velocity-based force calculation for more predictable movement
    let force = { x: 0, y: 0, z: 0 };
    
    // NEW: Apply force only if the difference is significant and not near target
    const targetSpeedXZ = Math.sqrt(desiredVelocity.x**2 + desiredVelocity.z**2);
    const currentSpeedXZ = Math.sqrt(currentLinvel.x**2 + currentLinvel.z**2);
    const speedDiff = Math.abs(targetSpeedXZ - currentSpeedXZ);
    
    // Only apply forces if we're not already close to the target velocity
    if (speedDiff > MIN_FORCE_THRESHOLD) {
        if (Math.abs(velocityDiffX) > MIN_FORCE_THRESHOLD) {
            force.x = velocityDiffX * ACCELERATION_FORCE * deltaTime;
        }
        if (Math.abs(velocityDiffZ) > MIN_FORCE_THRESHOLD) {
            force.z = velocityDiffZ * ACCELERATION_FORCE * deltaTime;
        }
    }

    // FIXED: Add stronger stopping forces when not moving to prevent sliding
    if (!isMoving && currentSpeed > 0.02) {
        // The setLinvel call above now handles stopping, this is redundant.
    }

    if (!isOnGround) {
        force.x *= AIR_CONTROL_FACTOR;
        force.z *= AIR_CONTROL_FACTOR;
    }

    // Clamp force magnitude for stability
    const forceMagnitude = Math.sqrt(force.x**2 + force.z**2);
    if (forceMagnitude > MAX_ACCEL_FORCE) {
        const scale = MAX_ACCEL_FORCE / forceMagnitude;
        force.x *= scale; 
        force.z *= scale;
    }

    // --- FIXED: Slope Force Projection (only when moving intentionally) ---
    // Only apply slope projection when the player is actively trying to move
    if (isOnGround && isMoving && playerState.slopeAngle > 0.01 && playerState.groundNormal) {
        const groundNormal = playerState.groundNormal;
        
        // Project the force vector F onto the plane with normal N: F_proj = F - dot(F, N) * N
        // Since our initial force is purely horizontal (force.y = 0), the dot product simplifies.
        const dotProduct = (force.x * groundNormal.x) + (force.z * groundNormal.z);
        
        // The projected force will now have a vertical component to climb the slope.
        force.x = force.x - dotProduct * groundNormal.x;
        force.y = -dotProduct * groundNormal.y; // The 'y' component of the projected force.
        force.z = force.z - dotProduct * groundNormal.z;
    }

    // Apply the impulse with additional safety checks
    const forceMagnitudeTotal = Math.sqrt(force.x**2 + force.y**2 + force.z**2);
    if (forceMagnitudeTotal > 0.05 && isMoving) { // REDUCED threshold for better responsiveness with small characters
        // NEW: Prevent NaN forces from crashing physics
        if (isNaN(force.x) || isNaN(force.y) || isNaN(force.z)) {
            console.error(`[Movement NaN] Detected NaN in force calculation for player ${playerId}. Aborting impulse.`);
        } else {
            // NEW: Additional safety check for reasonable force magnitudes
            if (forceMagnitudeTotal < 100.0) { // Prevent extremely large forces
                playerBody.applyImpulse(force, true);
            } else {
                console.warn(`[Movement] Force magnitude too large (${forceMagnitudeTotal.toFixed(2)}) for player ${playerId}. Clamping.`);
                const scale = 100.0 / forceMagnitudeTotal;
                playerBody.applyImpulse({ x: force.x * scale, y: force.y * scale, z: force.z * scale }, true);
            }
        }
    }

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
    // NEW: Guard against undefined or null quaternion
    if (!q) {
        console.warn("[applyQuaternion] Received undefined quaternion. Returning original vector.");
        return { ...vec };
    }

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
    const playerHeight = PLAYER_TOTAL_HEIGHT; // Use global constant
    const playerRadius = PLAYER_RADIUS;       // Use global constant
    const halfHeight = playerHeight / 2;
    const capsuleBottomOffset = halfHeight - playerRadius;
    const rayOrigin = { x: currentPos.x, y: currentPos.y - capsuleBottomOffset, z: currentPos.z };

    const rayDirection = { x: 0, y: -1, z: 0 };
    const rayLength = playerRadius + 0.15; // Cast just below the capsule radius + a small buffer

    const filterGroups = interactionGroups(CollisionGroup.PLAYER_UTILITY_RAY, [CollisionGroup.WORLD]); // Ray is part of UTILITY_RAY, wants to hit WORLD

    const ray = new RAPIER.Ray(rayOrigin, rayDirection);
    // NEW: Use castRayAndGetNormal to get slope information
    const hit = rapierWorld.castRayAndGetNormal(
        ray,
        rayLength,
        true, // Solid check
        undefined, // queryDispatcher
        filterGroups, // collision groups
        playerState.rapierBody.collider(0) // exclude player's own collider
    );

    const previouslyOnGround = playerState.isOnGround;
    playerState.groundNormal = null;
    playerState.slopeAngle = 0;

    if (hit) {
        playerState.groundNormal = { x: hit.normal.x, y: hit.normal.y, z: hit.normal.z };
        // The angle between the ground normal and the world up vector {0, 1, 0}
        // The dot product of two unit vectors is the cosine of the angle between them.
        // Dot product with {0,1,0} is just the normal's y component.
        playerState.slopeAngle = Math.acos(hit.normal.y);

        if (playerState.slopeAngle < MAX_SLOPE_ANGLE_RAD) {
            playerState.isOnGround = true;
        } else {
            // Slope is too steep, consider the player airborne so they slide.
            playerState.isOnGround = false;
        }
    } else {
        playerState.isOnGround = false;
    }


    // Debug logging for ground status changes
    if (previouslyOnGround !== playerState.isOnGround) {
        console.log(`Player ${playerId} ground status changed: ${playerState.isOnGround}. Slope Angle: ${(playerState.slopeAngle * 180 / Math.PI).toFixed(2)}°`);
    }

    // REMOVED: Position synchronization from ground check
    // Position should only be updated in the main game loop to prevent conflicts
    // This was causing position desync and jitter issues
}


// --- Match Lifecycle ---
function checkStartMatch() {
    // NEW LOGGING
    console.log(`[Match Check] Checking start conditions. State: ${currentMatchState.matchState}, Connected: ${Object.keys(connectedPlayers).length}`);
    const isReady = currentMatchState.matchState === 'waiting';
    const hasEnoughPlayers = Object.keys(connectedPlayers).length === 2;

    if (isReady && hasEnoughPlayers) {
        console.log('✅ Conditions MET. Starting match countdown...');
        startMatchCountdown();
    } else {
        console.log(`❌ Conditions NOT MET. isReady=${isReady}, hasEnoughPlayers=${hasEnoughPlayers}`);
    }
}

function startMatchCountdown() {
     // Example countdown
     let countdown = 5;
                     currentMatchState.matchState = `countdown_${countdown}`;
     broadcastGameState(); // Show initial countdown

     const countdownInterval = setInterval(() => {
          countdown--;
          if (countdown > 0) {
             currentMatchState.matchState = `countdown_${countdown}`;
             broadcastGameState();
          } else {
             clearInterval(countdownInterval);
             startRound(); // Start the first round
          }
     }, 1000);
}

function startRound() {
    console.log(`Starting Round ${currentMatchState.currentRound}`);
    currentMatchState.matchState = 'in_progress';
    currentMatchState.timeRemaining = 120; // Example round time
    
    // Respawn both players
    const playerIds = getPlayerIds();
    respawnPlayer(playerIds[0]);
    respawnPlayer(playerIds[1]);
    
    // Start the main game loop
    startGameLoop();
}

function endMatch(winnerId) {
    if (currentMatchState.matchState === 'finished') {
        console.log('Match has already been ended.');
        return;
    }
    console.log(`Match is ending. Winner: ${winnerId || 'N/A (Forfeit/Draw)'}`);
    
    currentMatchState.matchState = 'finished';
    stopGameLoop();

    // TODO: Phase 4 - Call Solana Escrow and Report to Platform API
    // For now, we just log the outcome and shut down.

    broadcastGameState(); // Send final state to clients

    console.log('Server instance will shut down in 5 seconds.');
    setTimeout(shutdown, 5000);
}

// --- Player Spawning/Death ---
function respawnPlayer(playerId) {
    const playerState = players[playerId];
    if (!playerState) return;

    // Get spawn point
    const mapConfig = MAP_CONFIGS_FPS[config.mapId];
    const spawnPoints = Array.isArray(mapConfig?.physicsData?.spawnPoints) && mapConfig.physicsData.spawnPoints.length > 0
        ? mapConfig.physicsData.spawnPoints
        : [{ x: 0, y: 5, z: 0 }, { x: 10, y: 5, z: 10 }];
    
    const playerIndex = (playerId === config.playersInfo.p1.userId) ? 0 : 1;
    const spawnPoint = spawnPoints[playerIndex % spawnPoints.length];

    console.log(`Respawning ${playerId} at ${JSON.stringify(spawnPoint)}`);

    // Reset State
    const charConfig = CHARACTER_CONFIG_FPS[playerState.characterId];
    playerState.state = 'alive';
    playerState.health = charConfig.baseHealth;
    playerState.shield = charConfig.baseShield;

    // Reset consumables/cooldowns
    playerState.grenades = { [GrenadeType.SEMTEX]: 1, [GrenadeType.FLASHBANG]: 1, [GrenadeType.FRAG]: 1 };
    playerState.ability1CooldownRemaining = 0;
    
    // Reset Ammo and Reloading State
    playerState.isReloading = false;
    const weaponId0 = playerState.weaponSlots[0];
    const weaponId1 = playerState.weaponSlots[1];
    const weapon0Config = WEAPON_CONFIG_FPS[weaponId0];
    const weapon1Config = WEAPON_CONFIG_FPS[weaponId1];
    
    playerState.ammoInClip[0] = weapon0Config?.ammoCapacity ?? 0;
    playerState.ammoInClip[1] = weapon1Config?.ammoCapacity ?? 0;

    playerState.currentAmmoInClip = playerState.ammoInClip[playerState.activeWeaponSlot];
    const activeWeaponConfig = WEAPON_CONFIG_FPS[playerState.weaponSlots[playerState.activeWeaponSlot]];
    playerState.currentSpread = activeWeaponConfig?.baseSpread ?? 0;

    // Reset Physics Body
    if (playerState.rapierBody) {
        resetPlayerPhysics(playerState.rapierBody, spawnPoint);
    } else {
        playerState.rapierBody = createPlayerPhysicsBody(playerId, spawnPoint);
    }

    console.log(`${playerId} respawned.`);
    
    // DEBUG: List all colliders in the world
    debugListColliders();
}

// NEW: Debug function to list all colliders and their properties
function debugListColliders() {
    console.log(`🔍 [DEBUG] === COLLIDER DEBUG INFO ===`);
    console.log(`🔍 [DEBUG] Total colliders in world: ${rapierWorld.colliders.len()}`);
    
    rapierWorld.colliders.forEach((collider) => {
        const handle = collider.handle; // Get handle directly from the collider object
        const userData = collider.userData;
        const position = collider.translation();
        const shape = collider.shape;
        console.log(`🔍 [DEBUG] Collider ${handle}: Type=${shape.type}, Pos=${position.x.toFixed(2)},${position.y.toFixed(2)},${position.z.toFixed(2)}, UserData:`, userData);
    });
    console.log(`🔍 [DEBUG] ========================`);
}

// Helper function for resetting physics (Plan 3.2.1)
function resetPlayerPhysics(rapierBody, position) {
    if (rapierBody) {
        rapierBody.setTranslation(position, true);
        rapierBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
        rapierBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
        rapierBody.setGravityScale(1, true);
        rapierBody.wakeUp();
        // NEW: Re-enable the body on respawn
        rapierBody.setEnabled(true);
    }
}

// --- NEW: Combat Logic Helpers ---

/**
 * Applies random spread to a given direction quaternion using a stable orthonormal basis method.
 * @param {{x,y,z,w}} directionQuat - The base direction of the shot.
 * @param {object} playerState - The state of the player shooting.
 * @returns {{x, y, z}} A new direction vector with spread applied.
 */
function applySpreadToDirection(directionQuat, playerState) {
    // Ensure we have a valid quaternion
    if (!directionQuat || typeof directionQuat.w !== 'number') {
        console.error("[applySpreadToDirection] Invalid quaternion:", directionQuat);
        return { x: 0, y: 0, z: 1 }; // Return default forward
    }

    const forward = { x: 0, y: 0, z: 1 }; // Reverted: Use +Z as forward to match server's quaternion logic
    const directionVec = applyQuaternion(forward, directionQuat);

    // DEBUG: Log input and output
    console.log(`🎯 [SERVER] Input quaternion:`, directionQuat);
    console.log(`🎯 [SERVER] Direction vector after applyQuaternion:`, directionVec);

    // Check if the quaternion transformation resulted in a valid vector
    const magnitude = Math.sqrt(directionVec.x**2 + directionVec.y**2 + directionVec.z**2);
    console.log(`🎯 [SERVER] Direction magnitude: ${magnitude}`);
    
    if (magnitude < 1e-9) {
        console.warn("[applySpreadToDirection] Direction vector was too small. Returning default forward direction.");
        return { x: 0, y: 0, z: 1 }; // Return a safe default forward direction
    }

    // Normalize the direction vector
    const normalizedDir = {
        x: directionVec.x / magnitude,
        y: directionVec.y / magnitude,
        z: directionVec.z / magnitude
    };

    // Apply spread (simplified for now)
    const spread = playerState.currentSpread || 0;
    if (spread <= 0) {
        return normalizedDir;
    }

    // Simple spread implementation - add random offset to direction
    const spreadAmount = spread * 0.5; // Reduce spread for testing
    const offsetX = (Math.random() - 0.5) * spreadAmount;
    const offsetY = (Math.random() - 0.5) * spreadAmount;
    
    const spreadDir = {
        x: normalizedDir.x + offsetX,
        y: normalizedDir.y + offsetY,
        z: normalizedDir.z
    };
    
    // Normalize again after adding spread
    const spreadMag = Math.sqrt(spreadDir.x**2 + spreadDir.y**2 + spreadDir.z**2);
    if (spreadMag > 1e-9) {
        return {
            x: spreadDir.x / spreadMag,
            y: spreadDir.y / spreadMag,
            z: spreadDir.z / spreadMag
        };
    }
    
    return normalizedDir; // Fallback to non-spread direction
}


/**
 * Manages the recovery of weapon spread over time.
 * @param {object} playerState - The state of the player.
 * @param {object} weaponConfig - The configuration of the weapon.
 */
function resetSpreadRecoveryTimer(playerState, weaponConfig) {
    if (playerState.spreadRecoveryTimer) {
        clearInterval(playerState.spreadRecoveryTimer);
    }

    const recoveryDelay = 200; 
    setTimeout(() => {
        if (playerState.spreadRecoveryTimer) clearInterval(playerState.spreadRecoveryTimer);

        const recoveryInterval = setInterval(() => {
            if (playerState.state !== 'alive' || !players[playerState.userId]) {
                clearInterval(recoveryInterval);
                playerState.spreadRecoveryTimer = null;
                return;
            }
            
            if (playerState.currentSpread > weaponConfig.baseSpread) {
                playerState.currentSpread -= weaponConfig.spreadRecoveryRate * (TICK_INTERVAL_MS / 100);
                playerState.currentSpread = Math.max(playerState.currentSpread, weaponConfig.baseSpread);
            } else {
                 clearInterval(recoveryInterval);
                 playerState.spreadRecoveryTimer = null;
            }
        }, TICK_INTERVAL_MS);
        playerState.spreadRecoveryTimer = recoveryInterval;
    }, recoveryDelay);
}

/**
 * Processes a confirmed hit from a raycast.
 * @param {string} shooterId - The ID of the player who shot.
 * @param {object} hitCollider - The Rapier collider that was hit.
 * @param {object} hitUserData - The user data associated with the collider.
 * @param {{x,y,z}} hitPoint - The world-space point of impact.
 * @param {number} baseDamage - The base damage of the weapon.
 */
function processHit(shooterId, hitCollider, hitUserData, hitPoint, baseDamage) {
    console.log(`🎯 [SERVER] processHit called: shooter=${shooterId}, userData=`, hitUserData);
    
    if (!hitCollider) {
        console.log(`🚫 [SERVER] processHit: No hit collider provided`);
        return;
    }
    
    if (hitUserData && hitUserData.type === 'playerBody' && hitUserData.playerId) {
        const victimId = hitUserData.playerId;
        console.log(`🎯 [SERVER] Processing player hit: ${shooterId} -> ${victimId}`);

        if (shooterId === victimId) {
            console.log(`🚫 [SERVER] Prevented self-damage: ${shooterId}`);
            return;
        }

        const victimState = players[victimId];
        if (!victimState || victimState.state !== 'alive') {
            console.log(`🚫 [SERVER] Victim ${victimId} not alive or doesn't exist. State: ${victimState?.state}`);
            return;
        }
        
        const damageMultiplier = 1.0; 
        const finalDamage = baseDamage * damageMultiplier;

        console.log(`💥 [SERVER] Player ${shooterId} hit ${victimId} for ${finalDamage} damage.`);
        const shooterSocket = connectedPlayers[shooterId]?.socket;
        if(shooterSocket) {
            shooterSocket.emit(MessageTypeFPS.HIT_CONFIRMED_FPS, { victimId, hitPoint });
        }
        
        applyDamage(victimId, shooterId, finalDamage);
    } else if (hitUserData) {
        console.log(`🎯 [SERVER] Hit non-player object: type=${hitUserData.type}`);
    } else {
        console.log(`🎯 [SERVER] Hit object with no userData (likely map geometry)`);
    }
}

/**
 * Applies damage to a player, handling shield and health reduction.
 * @param {string} victimId - The ID of the player taking damage.
 * @param {string} attackerId - The ID of the player dealing damage.
 * @param {number} damage - The amount of damage to apply.
 */
function applyDamage(victimId, attackerId, damage) {
    const victimState = players[victimId];
    if (!victimState || victimState.state === 'dead') return;

    let damageToShield = Math.min(victimState.shield, damage);
    victimState.shield -= damageToShield;

    let remainingDamage = damage - damageToShield;
    if (remainingDamage > 0) {
        victimState.health -= remainingDamage;
    }
    
    victimState.health = Math.max(0, victimState.health);
    victimState.shield = Math.max(0, victimState.shield);

    if (victimState.health <= 0) {
        handlePlayerDeath(victimId, attackerId);
    }
}

/**
 * Handles the logic when a player's health reaches zero.
 * @param {string} victimId - The ID of the player who died.
 * @param {string} killerId - The ID of the player who got the kill.
 */
function handlePlayerDeath(victimId, killerId) {
    const victimState = players[victimId];
    if (!victimState || victimState.state === 'dead') return;

    console.log(`Player ${victimId} was killed by ${killerId}.`);
    victimState.state = 'dead';
    victimState.deaths++;
    
    if(victimState.rapierBody) {
        victimState.rapierBody.setLinvel({x:0,y:0,z:0}, true);
        victimState.rapierBody.setEnabled(false);
    }

    if (killerId && players[killerId] && killerId !== victimId) {
        players[killerId].kills++;
    }

    io.emit(MessageTypeFPS.PLAYER_DIED_FPS, { victimId, killerId });
    
    const RESPAWN_DELAY_MS = 3000;
    setTimeout(() => {
        const currentVictimState = players[victimId];
        if(currentVictimState) { // Check if player is still in the game
            respawnPlayer(victimId);
            if(currentVictimState.rapierBody) {
                currentVictimState.rapierBody.setEnabled(true);
            }
        }
    }, RESPAWN_DELAY_MS);
}

/**
 * Placeholder for handling grenade throws.
 * @param {string} playerId 
 * @param {object} data 
 */
function handleGrenadeThrow(playerId, data) {
    console.log(`Player ${playerId} threw a grenade (not implemented). Data:`, data);
}

// --- Lag Compensation Helpers ---
/**
 * Finds the server-authoritative state of a player at a given input sequence time.
 * This is crucial for lag compensation.
 * @param {string} playerId - The ID of the player.
 * @param {number} sequence - The input sequence number from the client.
 * @returns {{position: {x,y,z}, lookQuat: {x,y,z,w}}} The interpolated state.
 */
function getPlayerAuthoritativeStateAtSequence(playerId, sequence) {
    const playerState = players[playerId];
    // More robust check
    if (!playerState) {
        console.error(`[LagComp] getPlayerAuthoritativeStateAtSequence called for non-existent player: ${playerId}`);
        // Return a default, safe state
        return {
            position: { x: 0, y: 0, z: 0 },
            lookQuat: { x: 0, y: 0, z: 0, w: 1 }
        };
    }

    if (playerState.positionHistory.length === 0) {
        // Fallback to current state if no history is available
        return {
            position: playerState.position,
            lookQuat: playerState.lookDirection  // FIXED: Use lookDirection instead of rotation
        };
    }

    // Find two history snapshots that bracket the target sequence's time.
    // This is a simplified approach; a real implementation might use timestamps.
    // For now, we find the closest available snapshot.
    let closestSnapshot = playerState.positionHistory[0];
    let smallestDiff = Math.abs(sequence - closestSnapshot.sequence);

    for (let i = 1; i < playerState.positionHistory.length; i++) {
        const diff = Math.abs(sequence - playerState.positionHistory[i].sequence);
        if (diff < smallestDiff) {
            smallestDiff = diff;
            closestSnapshot = playerState.positionHistory[i];
        }
    }

    // In a real-world scenario, you would interpolate between two snapshots.
    // For now, we'll just use the position from the closest snapshot and the lookQuat from input history.
    return {
        position: closestSnapshot.position,
        lookQuat: getInputDirectionFromSequence(playerId, sequence) // Get look direction from input history
    };
}

/**
 * Retrieves the look direction (quaternion) from the stored input history for a given sequence.
 * @param {string} playerId - The ID of the player.
 * @param {number} sequence - The input sequence number.
 * @returns {{x,y,z,w}} The look quaternion.
 */
function getInputDirectionFromSequence(playerId, sequence) {
    const playerState = players[playerId];
    // Add guard clauses for safety
    if (!playerState) {
        return { x: 0, y: 0, z: 0, w: 1 };
    }
    if (playerState.inputHistory[sequence]) {
        // Ensure lookQuat exists on the historical input
        return playerState.inputHistory[sequence].lookQuat || playerState.lookDirection;
    }
    // Fallback to the player's last known full look direction if the sequence is not found
    return playerState.lookDirection;
}

/**
 * Updates weapon-related timers using deltaTime instead of setTimeout
 * This is more predictable and compatible with client prediction
 */
function updateWeaponTimers(playerId, deltaTimeMs) {
    const playerState = players[playerId];
    if (!playerState) return;

    // Update weapon switch timer
    if (playerState.weaponSwitchTimer > 0) {
        playerState.weaponSwitchTimer -= deltaTimeMs;
        if (playerState.weaponSwitchTimer <= 0) {
            playerState.weaponSwitchTimer = 0;
            // Weapon switch delay complete
        }
    }

    // Update reload timer
    if (playerState.isReloading && playerState.reloadDuration > 0) {
        playerState.reloadTimer += deltaTimeMs;
        
        if (playerState.reloadTimer >= playerState.reloadDuration) {
            // Reload complete
            const activeWeaponId = playerState.weaponSlots[playerState.activeWeaponSlot];
            const weaponConfig = WEAPON_CONFIG_FPS[activeWeaponId];
            
            if (weaponConfig && playerState.state === 'alive') {
                console.log(`Player ${playerId}: Reload complete for ${activeWeaponId}`);
                
                const newAmmo = weaponConfig.ammoCapacity;
                playerState.currentAmmoInClip = newAmmo;
                
                // Update the per-slot ammo tracking
                playerState.ammoInClip[playerState.activeWeaponSlot] = newAmmo;
                
                playerState.isReloading = false;
                playerState.reloadTimer = 0;
                playerState.reloadDuration = 0;
                
                broadcastGameState();
            } else {
                // Reload was interrupted (player died, switched weapons, etc.)
                console.log(`Player ${playerId}: Reload interrupted for ${activeWeaponId}`);
                playerState.isReloading = false;
                playerState.reloadTimer = 0;
                playerState.reloadDuration = 0;
                broadcastGameState();
            }
        }
    }
}

// --- Entry Point ---
initialize().catch(err => {
    console.error("Initialization failed:", err);
    process.exit(1);
});