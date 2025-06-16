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

// NEW: Player Physics Dimensions Constants
const PLAYER_TOTAL_HEIGHT = 0.5; // New smaller height
const PLAYER_RADIUS = 0.12;       // New smaller radius

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
let activeProjectiles = {}; // NEW: To store active projectiles
let nextProjectileId = 0; // NEW: To generate unique projectile IDs
// let timeRemaining = 0; // Managed by match flow later

// NEW: Define variables for imported types in the module scope
let MapId, CharacterId, GrenadeType, MessageTypeFPS, MAP_CONFIGS_FPS, CHARACTER_CONFIG_FPS, WEAPON_CONFIG_FPS, ABILITY_CONFIG_FPS, CollisionGroup, interactionGroups;

// --- Constants for Movement ---
const TICK_RATE = 60; // Ticks per second
const TICK_INTERVAL_MS = 1000 / TICK_RATE;     
const WALK_SPEED = 2.5; // Further reduced to match client
const RUN_SPEED = 5; // Further reduced to match client
const JUMP_IMPULSE = 5.0; // Further reduced to match client
const ACCELERATION_FORCE = 800.0; // Further reduced to match client
const MAX_ACCEL_FORCE = 20.0; // Further reduced to match client
const AIR_CONTROL_FACTOR = 0.2; // How much control player has in air
const MAX_PLAYER_SPEED = 5.0; // Reduced to match new run speed
const DAMPING_FACTOR = 0.95; // Add damping factor for smoother movement
const MAX_SLOPE_ANGLE_RAD = 50 * Math.PI / 180; // Max angle (~50 degrees) player can stand on

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
    // Use the new constants
    const capsuleHalfHeight = PLAYER_TOTAL_HEIGHT / 2 - PLAYER_RADIUS;

    // Create RigidBody
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(position.x, position.y, position.z)
        .setCanSleep(false)
        .setCcdEnabled(true)
        .lockRotations() // Prevent capsule from falling over
        .setLinearDamping(3.0) // Increased from 2.0 to 3.0 for even smoother movement
        .setAngularDamping(8.0); // Increased from 5.0 to 8.0 for better stability
    const body = rapierWorld.createRigidBody(bodyDesc);

    // Create Collider (Capsule)
    const colliderDesc = RAPIER.ColliderDesc.capsule(capsuleHalfHeight, PLAYER_RADIUS)
        .setDensity(700.0) // NEW: Significantly increased density
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
                [CollisionGroup.PLAYER_BODY, CollisionGroup.GRENADE, CollisionGroup.PROJECTILE, CollisionGroup.PLAYER_UTILITY_RAY] // Collides with Players, Grenades, Projectiles, AND UTILITY RAYS
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
            if (!playerId) return;
    
            const playerState = players[playerId];
            if (!playerState || playerState.state !== 'alive') return;
    
            const weaponConfig = WEAPON_CONFIG_FPS[playerState.weaponSlots[playerState.activeWeaponSlot]];
            if (!weaponConfig) return;
    
            if (playerState.isReloading) {
                return; // Prevent firing if reloading
            }
            
            if (playerState.currentAmmoInClip <= 0) {
                return; // Prevent firing if ammo is empty
            }
    
            const now = performance.now();
            if (now - playerState.lastFireTime < weaponConfig.fireRate) {
                return; // Authoritative fire rate check
            }
    
            playerState.lastFireTime = now;
            playerState.currentAmmoInClip--;

            // NEW: Increase spread with each shot
            playerState.currentSpread = Math.min(
                weaponConfig.maxSpread,
                playerState.currentSpread + weaponConfig.spreadIncreasePerShot
            );
    
            if (playerState.activeWeaponSlot === 0) {
                playerState.ammoInClip[0] = playerState.currentAmmoInClip;
            } else {
                playerState.ammoInClip[1] = playerState.currentAmmoInClip;
            }
    
            // --- REVERTED: Back to Raycasting for hit detection ---
            const authoritativeState = getPlayerAuthoritativeStateAtSequence(playerId, fireData.sequence);
            const fireOrigin = authoritativeState.position;
            const fireDirectionQuat = authoritativeState.lookQuat;
            const fireDirectionWithSpread = applySpreadToDirection(fireDirectionQuat, playerState);
    
            const ray = new RAPIER.Ray(fireOrigin, fireDirectionWithSpread);
            const maxDistance = weaponConfig.range;
            const hit = rapierWorld.castRayAndGetNormal(
                ray,
                maxDistance,
                true,
                interactionGroups(CollisionGroup.PROJECTILE, [CollisionGroup.WORLD, CollisionGroup.PLAYER_BODY])
            );
    
            let endPosition;
            if (hit) {
                const hitCollider = rapierWorld.getCollider(hit.colliderHandle);
                const hitUserData = hitCollider?.userData;
                const hitPoint = ray.pointAt(hit.toi);
                endPosition = hitPoint;
                processHit(playerId, hitCollider, hitUserData, hitPoint, weaponConfig.damage);
            } else {
                // If no hit, calculate a point far along the ray for the visual
                endPosition = {
                    x: fireOrigin.x + fireDirectionWithSpread.x * maxDistance,
                    y: fireOrigin.y + fireDirectionWithSpread.y * maxDistance,
                    z: fireOrigin.z + fireDirectionWithSpread.z * maxDistance,
                };
            }

            // Broadcast the visual effect to all clients
            io.emit(MessageTypeFPS.SHOT_FIRED_VISUAL_FPS, {
                ownerId: playerId,
                startPosition: fireOrigin,
                endPosition: endPosition,
                weaponId: weaponConfig.id,
                uniqueId: `${playerId}-${Date.now()}` // Simple unique ID
            });
            // --- End Raycasting Logic ---
            
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

            // Cancel reload if they were reloading
            if (playerState.isReloading) {
                playerState.isReloading = false;
                // We might need to clear a reload timeout if it's stored on the playerState
            }

            // Switch slot
            playerState.activeWeaponSlot = (playerState.activeWeaponSlot === 0) ? 1 : 0;
            
            // Update current ammo
            playerState.currentAmmoInClip = playerState.ammoInClip[playerState.activeWeaponSlot];

            // Reset spread for the new weapon
            const newWeaponId = playerState.weaponSlots[playerState.activeWeaponSlot];
            const newWeaponConfig = WEAPON_CONFIG_FPS[newWeaponId];
            playerState.currentSpread = newWeaponConfig?.baseSpread ?? 0;

            console.log(`Player ${playerId} switched to weapon slot ${playerState.activeWeaponSlot} (${newWeaponId})`);
            broadcastGameState();
        });
    
        socket.on(MessageTypeFPS.RELOAD_WEAPON_FPS, () => {
            const playerId = getPlayerIdFromSocket(socket);
            if (!playerId) return;
    
            const playerState = players[playerId];
            if (!playerState || playerState.state !== 'alive' || playerState.isReloading) {
                return;
            }
    
            const activeWeaponId = playerState.weaponSlots[playerState.activeWeaponSlot];
            const weaponConfig = WEAPON_CONFIG_FPS[activeWeaponId];
    
            if (!weaponConfig || playerState.currentAmmoInClip >= weaponConfig.ammoCapacity) {
                return;
            }
    
            console.log(`Player ${playerId}: Starting reload for ${activeWeaponId}`);
            playerState.isReloading = true;
            
            broadcastGameState();
    
            setTimeout(() => {
                const currentPlayerState = players[playerId];
                if (
                    !currentPlayerState ||
                    currentPlayerState.state !== 'alive' ||
                    !currentPlayerState.isReloading ||
                    currentPlayerState.weaponSlots[currentPlayerState.activeWeaponSlot] !== activeWeaponId
                ) {
                    console.log(`Player ${playerId}: Reload for ${activeWeaponId} was interrupted.`);
                    if (currentPlayerState && currentPlayerState.state === 'alive') {
                        currentPlayerState.isReloading = false;
                        broadcastGameState();
                    }
                    return;
                }
    
                console.log(`Player ${playerId}: Reload complete for ${activeWeaponId}`);
                const newAmmo = weaponConfig.ammoCapacity;
                currentPlayerState.currentAmmoInClip = newAmmo;
    
                if (currentPlayerState.activeWeaponSlot === 0) {
                    currentPlayerState.ammoInClip[0] = newAmmo;
                } else {
                    currentPlayerState.ammoInClip[1] = newAmmo;
                }
    
                currentPlayerState.isReloading = false;
                
                broadcastGameState();
    
            }, weaponConfig.reloadTime);
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
        }

        // 2. Update Player States from Physics & Handle Game Logic
        for (const playerId in players) {
             const playerState = players[playerId];
             if (playerState.rapierBody) {
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
         matchState: currentMatchState,
         timeRemaining: 0, // TODO: Add timer state
         currentRound: 1, // TODO: Add round state
         roundWins: { p1: 0, p2: 0 }, // TODO: Add round wins state
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
    const { sequence, deltaTime, keys, lookQuat } = inputData;
    // Sequence validation (allow some out-of-order, but ignore duplicates)
    if (sequence <= playerState.lastProcessedSequence) return;

    // Store the full look quaternion for accurate shooting direction
    playerState.lookDirection = { ...lookQuat };

    // Store input for reconciliation/lag comp
    const MAX_INPUT_HISTORY = 120;
    playerState.inputHistory[sequence] = { keys, lookQuat, deltaTime };
    const historyKeys = Object.keys(playerState.inputHistory);
    if (historyKeys.length > MAX_INPUT_HISTORY) delete playerState.inputHistory[historyKeys[0]];
    // Apply input to physics
    applyMovementInputToPlayer(playerId, playerState.rapierBody, keys, lookQuat, deltaTime);
    playerState.lastProcessedSequence = sequence;

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

    // Speed validation (allow higher if dash/grapple active)
    const currentLinvel = playerState.rapierBody.linvel();
    let allowedMaxSpeed = MAX_PLAYER_SPEED;
    if (playerState.ability1Type === ABILITY_CONFIG_FPS.DASH && playerState.ability1CooldownRemaining > ABILITY_CONFIG_FPS[ABILITY_CONFIG_FPS.DASH].cooldown - 1000) allowedMaxSpeed *= 1.5;
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
        // Invert final movement vector to match user expectation
        moveDirection.x *= -1;
        moveDirection.z *= -1;

        const mag = Math.sqrt(moveDirection.x**2 + moveDirection.z**2);
        if (mag > 1e-6) { moveDirection.x /= mag; moveDirection.z /= mag; }
        const targetSpeed = keys.Shift ? RUN_SPEED : WALK_SPEED;
        desiredVelocity.x = moveDirection.x * targetSpeed;
        desiredVelocity.z = moveDirection.z * targetSpeed;
    }

    // Apply force
    const currentLinvel = playerBody.linvel();
    
    // Apply damping to current velocity for smoother movement (match client)
    const dampedVelocity = {
        x: currentLinvel.x * DAMPING_FACTOR,
        y: currentLinvel.y, // Don't damp Y velocity (gravity/jumping)
        z: currentLinvel.z * DAMPING_FACTOR
    };
    
    // Calculate force needed to reach desired velocity
    let force = { x: 0, y: 0, z: 0 };
    const velocityDiffX = desiredVelocity.x - dampedVelocity.x;
    const velocityDiffZ = desiredVelocity.z - dampedVelocity.z;

    // Use smaller, smoother force application (match client)
    force.x = velocityDiffX * ACCELERATION_FORCE * deltaTime * 0.5; // Reduced force multiplier
    force.z = velocityDiffZ * ACCELERATION_FORCE * deltaTime * 0.5;

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

    // --- NEW: Slope Force Projection ---
    // If on a valid slope, project the horizontal force onto the slope's plane.
    // This ensures the force is applied along the slope, not into it.
    if (isOnGround && playerState.slopeAngle > 0.01 && playerState.groundNormal) {
        const groundNormal = playerState.groundNormal;
        
        // Project the force vector F onto the plane with normal N: F_proj = F - dot(F, N) * N
        // Since our initial force is purely horizontal (force.y = 0), the dot product simplifies.
        const dotProduct = (force.x * groundNormal.x) + (force.z * groundNormal.z);
        
        // The projected force will now have a vertical component to climb the slope.
        force.x = force.x - dotProduct * groundNormal.x;
        force.y = -dotProduct * groundNormal.y; // The 'y' component of the projected force.
        force.z = force.z - dotProduct * groundNormal.z;
    }

    // Apply the smoothed velocity first, then the force (match client)
    playerBody.setLinvel(dampedVelocity, true);
    if (Math.sqrt(force.x**2 + force.y**2 + force.z**2) > 0.1) { // Check magnitude of the final (potentially 3D) force
        // NEW: Prevent NaN forces from crashing physics
        if (isNaN(force.x) || isNaN(force.y) || isNaN(force.z)) {
            console.error(`[Movement NaN] Detected NaN in force calculation for player ${playerId}. Aborting impulse.`);
        } else {
            playerBody.applyImpulse(force, true);
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
        filterGroups // ADDED: Filter to only hit world geometry
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

    // NEW: Apply a "snap to ground" force to improve stability on slopes
    if (playerState.isOnGround) {
        const snapForce = 15.0; // A small constant downward force
        body.applyImpulse({ x: 0, y: -snapForce * (TICK_INTERVAL_MS / 1000), z: 0 }, true);
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
    // NEW LOGGING
    console.log(`[Match Check] Checking start conditions. State: ${currentMatchState}, Connected: ${Object.keys(connectedPlayers).length}`);
    const isReady = currentMatchState === 'waiting';
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
    if (currentMatchState === 'finished') {
        console.log('Match has already been ended.');
        return;
    }
    console.log(`Match is ending. Winner: ${winnerId || 'N/A (Forfeit/Draw)'}`);
    
    currentMatchState = 'finished';
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
    const forward = { x: 0, y: 0, z: -1 };
    const directionVec = applyQuaternion(forward, directionQuat);

    const spread = playerState.currentSpread;
    if (spread === 0) {
        return directionVec;
    }

    // Create a random vector in a 2D circle for the spread offset
    const randomAngle = Math.random() * 2 * Math.PI;
    const randomRadius = Math.random() * spread;
    const spreadOffset = {
        x: Math.cos(randomAngle) * randomRadius,
        y: Math.sin(randomAngle) * randomRadius,
    };

    // Create a stable orthonormal basis (a 3D coordinate system) from the direction vector
    let up, right;
    if (Math.abs(directionVec.x) < 1e-6 && Math.abs(directionVec.z) < 1e-6) {
        // Edge case: Looking almost perfectly straight up or down.
        // The global X axis can be our "right" vector.
        right = { x: 1, y: 0, z: 0 };
    } else {
        // Standard case: Create "right" vector by crossing with the global up vector {0,1,0}.
        // This gives a vector that is horizontal and perpendicular to the direction.
        right = { x: -directionVec.z, y: 0, z: directionVec.x };
        const mag = Math.sqrt(right.x * right.x + right.z * right.z);
        // Normalize to make it a unit vector
        if (mag > 1e-9) {
            right.x /= mag;
            right.z /= mag;
        }
    }

    // The final "up" for our basis is the cross product of the direction and our new "right".
    up = {
        x: directionVec.y * right.z - directionVec.z * right.y,
        y: directionVec.z * right.x - directionVec.x * right.z,
        z: directionVec.x * right.y - directionVec.y * right.x,
    };

    // Apply the 2D spread offset to the 3D basis to get the final direction
    directionVec.x += spreadOffset.x * right.x + spreadOffset.y * up.x;
    directionVec.y += spreadOffset.x * right.y + spreadOffset.y * up.y;
    directionVec.z += spreadOffset.x * right.z + spreadOffset.y * up.z;

    // Normalize the final vector to ensure it's a valid direction (unit vector)
    const finalMag = Math.sqrt(directionVec.x**2 + directionVec.y**2 + directionVec.z**2);
    if (finalMag > 1e-9) {
        directionVec.x /= finalMag;
        directionVec.y /= finalMag;
        directionVec.z /= finalMag;
    } else {
        console.warn("[applySpreadToDirection] Final direction vector was zero. Returning default.");
        return { x: 0, y: 0, z: -1 }; // Return a safe default
    }

    return directionVec;
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
    if (hitUserData && hitUserData.type === 'playerBody' && hitUserData.playerId) {
        const victimId = hitUserData.playerId;

        if (shooterId === victimId) return;

        const victimState = players[victimId];
        if (!victimState || victimState.state !== 'alive') return;
        
        const damageMultiplier = 1.0; 
        const finalDamage = baseDamage * damageMultiplier;

        console.log(`Player ${shooterId} hit ${victimId} for ${finalDamage} damage.`);
        const shooterSocket = connectedPlayers[shooterId]?.socket;
        if(shooterSocket) {
            shooterSocket.emit(MessageTypeFPS.HIT_CONFIRMED_FPS, { victimId, hitPoint });
        }
        
        applyDamage(victimId, shooterId, finalDamage);
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
            lookQuat: playerState.rotation
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

// --- Entry Point ---
initialize().catch(err => {
    console.error("Initialization failed:", err);
    process.exit(1);
});