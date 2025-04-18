// Define constants for message types to avoid typos
export const enum MessageType {
  ECHO = 'echo',
  PING = 'ping',
  PONG = 'pong',
  PLAYER_INPUT = 'playerInput',
  GAME_STATE_UPDATE = 'gameStateUpdate',
  // Add other message types here as needed
  // e.g., GAME_STATE = 'gameState'
  WELCOME = 'WELCOME', // Server -> Client on connect
}

// Base interface for all messages
export interface BaseMessage {
  type: MessageType;
  timestamp: number; // Good practice to include a timestamp
}

// Example: Echo message for testing
export interface EchoMessage extends BaseMessage {
  type: MessageType.ECHO;
  payload: string;
}

// Ping message (sent from client to server)
export interface PingMessage extends BaseMessage {
  type: MessageType.PING;
  // No additional payload needed, timestamp is in BaseMessage
}

// Pong message (sent from server to client)
export interface PongMessage extends BaseMessage {
  type: MessageType.PONG;
  // No additional payload needed, timestamp is echoed from PingMessage
}

// Player Input message (sent from client to server)
export interface PlayerInputMessage extends BaseMessage {
  type: MessageType.PLAYER_INPUT;
  sequence: number; // For sequencing inputs and reconciliation
  input: {
    forward: boolean;
    backward: boolean;
    left: boolean;
    right: boolean;
    jump: boolean;
    // delta changes are usually better for mouse look
    deltaYaw: number;
    deltaPitch: number;
  };
}

// Game State Update message (sent from server to clients)
export interface GameStateUpdateMessage extends BaseMessage {
  type: MessageType.GAME_STATE_UPDATE;
  timestamp: number;
  state: {
    [id: string]: {
        p: { x: number; y: number; z: number };
        r: { pitch: number; yaw: number };
        seq: number;
    };
  };
}

// Interface for the new Welcome message
export interface WelcomeMessage extends BaseMessage {
  type: MessageType.WELCOME;
  clientId: string; // The ID assigned by the server
  // Add any other initial data the client might need (e.g., server tick rate)
}

// Union type for type safety on the receiving end
export type GameMessage = EchoMessage | PingMessage | PongMessage | PlayerInputMessage | GameStateUpdateMessage | WelcomeMessage;
// Add other message types here | ...