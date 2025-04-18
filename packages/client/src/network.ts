import { io, Socket } from 'socket.io-client';
import {
    GameMessage,
    MessageType,
    EchoMessage,
    PingMessage,
    PongMessage,
    PlayerInputMessage,
    GameStateUpdateMessage,
    WelcomeMessage,
} from '@shared/types/messages'; // Import shared types

// Type for the callback function
type ServerUpdateCallback = (update: GameStateUpdateMessage) => void;

// Replace with your server URL in production
const SERVER_URL = 'http://localhost:3001';

let socket: Socket | null = null;
let pingInterval: NodeJS.Timeout | null = null;
let pongTimeout: NodeJS.Timeout | null = null;
let lastPongReceived: number = 0;
let serverUpdateCallback: ServerUpdateCallback | null = null; // Store the callback
let clientId: string | null = null; // Store the client ID
let isReadyCallback: (() => void) | null = null; // Callback for when connection + ID is ready

const PING_INTERVAL_MS = 5000; // Send ping every 5 seconds
const PONG_TIMEOUT_MS = 15000; // Disconnect if no pong received within 15 seconds

const startPing = () => {
    if (pingInterval) clearInterval(pingInterval); // Clear existing interval if any

    pingInterval = setInterval(() => {
        if (socket && socket.connected) {
            const pingMsg: PingMessage = {
                type: MessageType.PING,
                timestamp: Date.now()
            };
            console.log('Sending PING');
            socket.emit(pingMsg.type, pingMsg);

            // Set a timeout to expect a pong
            if (pongTimeout) clearTimeout(pongTimeout);
            pongTimeout = setTimeout(() => {
                console.error('Pong timeout! Disconnecting due to inactivity.');
                disconnectWebSocket(); // Or trigger reconnection logic
            }, PONG_TIMEOUT_MS);
        } else {
            console.warn('Cannot send PING: WebSocket not connected.');
            stopPing(); // Stop pinging if disconnected
        }
    }, PING_INTERVAL_MS);
};

const stopPing = () => {
    if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
    }
    if (pongTimeout) {
        clearTimeout(pongTimeout);
        pongTimeout = null;
    }
    console.log('Stopped PING interval.');
};

// NEW function to register the callback
export const setServerUpdateCallback = (callback: ServerUpdateCallback | null) => {
    console.log('Setting server update callback:', callback ? 'Provided' : 'Null');
    serverUpdateCallback = callback;
};

// NEW function to register a callback for when the connection is ready
export const setReadyCallback = (callback: () => void) => {
    isReadyCallback = callback;
    // If we are already ready, call it immediately
    if (clientId && socket?.connected) {
        callback();
    }
};

// NEW getter for the client ID
export const getClientId = (): string | null => {
    return clientId;
};

export const connectWebSocket = () => {
    if (socket && socket.connected) {
        console.log('Already connected to WebSocket server.');
        return;
    }

    console.log('Attempting to connect to WebSocket server...');
    socket = io(SERVER_URL, {
        // Optional: connection options
        // transports: ['websocket'], // Force WebSocket transport
    });

    socket.on('connect', () => {
        console.log(`Connected to WebSocket server with id: ${socket?.id}`);
        // NOTE: socket.id might not be stable immediately or across reconnects
        // We will rely on the WELCOME message for the authoritative ID.
        if (!socket) {
            console.error("Socket became null unexpectedly after connect event!");
            return;
        }

        // Remove previous listeners before reconnecting
        socket.off(MessageType.ECHO);
        socket.off(MessageType.PONG);
        socket.off(MessageType.GAME_STATE_UPDATE);
        socket.off(MessageType.WELCOME); // Remove old welcome listener too

        // Add listener for the ECHO response
        socket.on(MessageType.ECHO, (data: EchoMessage) => {
            console.log('Received ECHO response from server:', data.payload, 'Timestamp:', data.timestamp);
        });

        // Add listener for the PONG response
        socket.on(MessageType.PONG, (data: PongMessage) => {
            lastPongReceived = Date.now();
            if (pongTimeout) clearTimeout(pongTimeout);
            const rtt = lastPongReceived - data.timestamp;
            console.log(`Received PONG (RTT: ${rtt}ms)`);
        });

        // **Listen for Welcome message FIRST**
        socket.on(MessageType.WELCOME, (data: WelcomeMessage) => {
            console.log(`Received WELCOME. Client ID: ${data.clientId}`);
            clientId = data.clientId; // Store the ID

            // Now we are truly ready to process game updates
            if (isReadyCallback) {
                isReadyCallback(); // Notify GameView (or other components)
            }
        });

        // Add listener for Game State Updates
        socket.on(MessageType.GAME_STATE_UPDATE, (data: GameStateUpdateMessage) => {
            // console.log('Received GAME_STATE_UPDATE:', data); // Can be very verbose
            if (!clientId) {
                // Should not happen if WELCOME arrives first, but as a safety check
                console.warn('Received GAME_STATE_UPDATE before WELCOME message. Ignoring.');
                return;
            }
            if (serverUpdateCallback) {
                serverUpdateCallback(data); // Call the registered callback
            } else {
                console.warn('Received GAME_STATE_UPDATE but no callback registered.');
            }
        });

        // Test sending an ECHO message after connection
        sendEchoMessage("Hello from client!");

        // Start sending pings
        startPing();
    });

    socket.on('disconnect', (reason) => {
        console.log('Disconnected from WebSocket server:', reason);
        stopPing(); // Stop pinging on disconnect
        clientId = null; // Clear client ID on disconnect
        // Optional: attempt reconnection logic here
    });

    socket.on('connect_error', (error) => {
        console.error('WebSocket connection error:', error);
    });

    // Handle custom events from the server
    socket.on('message', (data) => {
        console.log('Message received from server:', data);
    });

    // Add more event listeners as needed
};

export const disconnectWebSocket = () => {
    stopPing(); // Ensure ping stops before disconnecting
    if (socket) {
        console.log('Disconnecting from WebSocket server...');
        // Remove specific listeners before disconnecting
        socket.off(MessageType.ECHO);
        socket.off(MessageType.PONG);
        socket.off(MessageType.GAME_STATE_UPDATE);
        socket.off(MessageType.WELCOME); // Remove welcome listener too
        socket.disconnect();
        socket = null;
    }
    // Clear callback on disconnect
    serverUpdateCallback = null;
    clientId = null; // Clear client ID
    isReadyCallback = null; // Clear ready callback
};

// Specific function to send an EchoMessage
export const sendEchoMessage = (message: string) => {
    if (socket && socket.connected) {
        const echoMsg: EchoMessage = {
            type: MessageType.ECHO,
            payload: message,
            timestamp: Date.now()
        };
        socket.emit(echoMsg.type, echoMsg);
        console.log('Sent ECHO message:', message);
    } else {
        console.error('Cannot send ECHO message: WebSocket is not connected.');
    }
};

// Function to send Player Input
export const sendPlayerInput = (inputMsg: PlayerInputMessage) => {
    if (socket && socket.connected) {
        socket.emit(inputMsg.type, inputMsg);
        // Avoid excessive logging for frequent messages like input
        // console.log('Sent PLAYER_INPUT:', inputMsg.sequence);
    } else {
        console.error('Cannot send PLAYER_INPUT message: WebSocket is not connected.');
    }
};

// Generic message sender (renamed for consistency)
export const sendMessage = (event: string, data: any) => {
    if (socket && socket.connected) {
        socket.emit(event, data);
    } else {
        console.error('Cannot send message: WebSocket is not connected.');
    }
};

// Optional: expose the socket instance directly if needed, but prefer exported functions
export const getSocket = (): Socket | null => socket; 