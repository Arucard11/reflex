import { Server as SocketIOServer, Socket } from 'socket.io';
import {
    MessageType,
    EchoMessage,
    PingMessage,
    PongMessage,
    PlayerInputMessage,
    WelcomeMessage,
} from '@shared/types/messages';
import {
    createPlayer,
    removePlayer,
    getPlayerState,
    updatePlayerInput
} from './playerManager';

export function setupConnectionHandler(io: SocketIOServer) {
    io.on('connection', (socket: Socket) => {
        console.log(`[Connection] Client connected: ${socket.id}`);

        // Send Welcome message immediately
        const welcomeMsg: WelcomeMessage = {
            type: MessageType.WELCOME,
            timestamp: Date.now(),
            clientId: socket.id,
        };
        socket.emit(welcomeMsg.type, welcomeMsg); // Send only to the connecting client

        // Create player state and physics body
        createPlayer(socket.id);

        // --- Register Message Handlers for this Socket --- 

        socket.on(MessageType.ECHO, (data: EchoMessage) => {
            console.log(`[Connection] Received ECHO from ${socket.id}:`, data.payload);
            socket.emit(MessageType.ECHO, data); // Echo back
        });

        socket.on(MessageType.PING, (data: PingMessage) => {
            // console.log(`[Connection] Received PING from ${socket.id}`);
            const pongMsg: PongMessage = {
                type: MessageType.PONG,
                timestamp: data.timestamp
            };
            socket.emit(pongMsg.type, pongMsg);
        });

        socket.on(MessageType.PLAYER_INPUT, (data: PlayerInputMessage) => {
            console.log(`[Connection] Received PLAYER_INPUT (Seq: ${data.sequence}) from ${socket.id}`);

            const state = getPlayerState(socket.id);
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
            updatePlayerInput(socket.id, data, state.physicsBody, state);

            console.log(`[Connection] State after update attempt: Server Seq ${state.lastProcessedInputSequence}`);

            // Note: Position is now updated via physics simulation in the game loop,
            // not directly here.
        });

        // --- Handle Disconnect and Errors --- 

        socket.on('disconnect', (reason) => {
            console.log(`[Connection] Client disconnected: ${socket.id}. Reason: ${reason}`);
            removePlayer(socket.id); // Clean up player state and physics body
        });

        socket.on('error', (error) => {
            console.error(`[Connection] Socket error for ${socket.id}:`, error);
            // Consider disconnecting the player on critical errors
            removePlayer(socket.id);
            socket.disconnect(true); 
        });
    });
} 