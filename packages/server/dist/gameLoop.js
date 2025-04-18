"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startGameLoop = startGameLoop;
exports.stopGameLoop = stopGameLoop;
const physics_1 = require("./physics");
const playerManager_1 = require("./playerManager");
// --- Game Loop Constants ---
const SERVER_TICK_RATE_HZ = 30;
const SERVER_TICK_INTERVAL_MS = 1000 / SERVER_TICK_RATE_HZ;
let gameLoopIntervalId = null;
let lastTickTime = 0;
// --- Game Loop Logic ---
function tick(io) {
    const now = Date.now();
    const deltaTime = (now - lastTickTime) / 1000.0;
    lastTickTime = now;
    // 1. Step Physics World
    const fixedTimeStep = 1 / SERVER_TICK_RATE_HZ;
    const maxSubSteps = 3;
    physics_1.physicsWorld.step(fixedTimeStep, deltaTime, maxSubSteps);
    // 2. Prepare State Updates (reading from physics bodies)
    const playerStates = (0, playerManager_1.getAllPlayerStates)();
    const gameStateUpdates = {};
    for (const [id, playerState] of playerStates.entries()) {
        // Update internal state position (optional, could just read for broadcast)
        // playerState.position.x = playerState.physicsBody.position.x;
        // playerState.position.y = playerState.physicsBody.position.y;
        // playerState.position.z = playerState.physicsBody.position.z;
        // Create payload with plain objects
        gameStateUpdates[id] = {
            p: {
                x: playerState.physicsBody.position.x,
                y: playerState.physicsBody.position.y,
                z: playerState.physicsBody.position.z
            },
            r: playerState.rotation, // Assuming this is already { pitch, yaw }
            seq: playerState.lastProcessedInputSequence
        };
        console.log(`[GameLoop] Player ${id} state prepared for broadcast (Seq: ${playerState.lastProcessedInputSequence})`);
    }
    // 3. Broadcast State Updates
    if (Object.keys(gameStateUpdates).length > 0) {
        const updateMsg = {
            type: "gameStateUpdate" /* MessageType.GAME_STATE_UPDATE */,
            state: gameStateUpdates,
            timestamp: now // Use current tick time
        };
        io.sockets.emit(updateMsg.type, updateMsg);
        // console.log(`[GameLoop] Broadcasting game state: ${Object.keys(gameStateUpdates).length} players`); // Commented out
    }
}
// --- Public Control Functions ---
function startGameLoop(io) {
    if (gameLoopIntervalId) {
        console.warn("[GameLoop] Loop already running.");
        return;
    }
    console.log(`[GameLoop] Starting game loop with ${SERVER_TICK_RATE_HZ} Hz tick rate...`);
    lastTickTime = Date.now(); // Initialize tick time
    // Use setInterval for consistent timing
    gameLoopIntervalId = setInterval(() => tick(io), SERVER_TICK_INTERVAL_MS);
}
function stopGameLoop() {
    if (gameLoopIntervalId) {
        console.log("[GameLoop] Stopping game loop.");
        clearInterval(gameLoopIntervalId);
        gameLoopIntervalId = null;
    }
    else {
        console.warn("[GameLoop] Loop not running.");
    }
}
