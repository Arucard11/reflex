"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setupConnectionHandler = setupConnectionHandler;
const playerManager_1 = require("./playerManager");
function setupConnectionHandler(io) {
    io.on('connection', (socket) => {
        console.log(`[Connection] Client connected: ${socket.id}`);
        // Send Welcome message immediately
        const welcomeMsg = {
            type: "WELCOME" /* MessageType.WELCOME */,
            timestamp: Date.now(),
            clientId: socket.id,
        };
        socket.emit(welcomeMsg.type, welcomeMsg); // Send only to the connecting client
        // Create player state and physics body
        (0, playerManager_1.createPlayer)(socket.id);
        // --- Register Message Handlers for this Socket --- 
        socket.on("echo" /* MessageType.ECHO */, (data) => {
            console.log(`[Connection] Received ECHO from ${socket.id}:`, data.payload);
            socket.emit("echo" /* MessageType.ECHO */, data); // Echo back
        });
        socket.on("ping" /* MessageType.PING */, (data) => {
            // console.log(`[Connection] Received PING from ${socket.id}`);
            const pongMsg = {
                type: "pong" /* MessageType.PONG */,
                timestamp: data.timestamp
            };
            socket.emit(pongMsg.type, pongMsg);
        });
        socket.on("playerInput" /* MessageType.PLAYER_INPUT */, (data) => {
            console.log(`[Connection] Received PLAYER_INPUT (Seq: ${data.sequence}) from ${socket.id}`);
            const state = (0, playerManager_1.getPlayerState)(socket.id);
            if (!state || !state.physicsBody) {
                console.warn(`[Connection] Received input for unknown or body-less player: ${socket.id}`);
                return;
            }
            console.log(`[Connection] Checking Input: Incoming Seq ${data.sequence}, Server Seq ${state.lastProcessedInputSequence}`);
            // Discard old inputs
            if (data.sequence <= state.lastProcessedInputSequence) {
                console.log(`[Connection] Discarding old input (Seq: ${data.sequence} <= ${state.lastProcessedInputSequence})`);
                return;
            }
            // Delegate input processing to PlayerManager
            (0, playerManager_1.updatePlayerInput)(socket.id, data, state.physicsBody, state);
            console.log(`[Connection] State after update attempt: Server Seq ${state.lastProcessedInputSequence}`);
            // Note: Position is now updated via physics simulation in the game loop,
            // not directly here.
        });
        // --- Handle Disconnect and Errors --- 
        socket.on('disconnect', (reason) => {
            console.log(`[Connection] Client disconnected: ${socket.id}. Reason: ${reason}`);
            (0, playerManager_1.removePlayer)(socket.id); // Clean up player state and physics body
        });
        socket.on('error', (error) => {
            console.error(`[Connection] Socket error for ${socket.id}:`, error);
            // Consider disconnecting the player on critical errors
            (0, playerManager_1.removePlayer)(socket.id);
            socket.disconnect(true);
        });
    });
}
