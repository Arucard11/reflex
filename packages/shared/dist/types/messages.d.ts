export declare const enum MessageType {
    ECHO = "echo",
    PING = "ping",
    PONG = "pong",
    PLAYER_INPUT = "playerInput",
    GAME_STATE_UPDATE = "gameStateUpdate",
    WELCOME = "WELCOME"
}
export interface BaseMessage {
    type: MessageType;
    timestamp: number;
}
export interface EchoMessage extends BaseMessage {
    type: MessageType.ECHO;
    payload: string;
}
export interface PingMessage extends BaseMessage {
    type: MessageType.PING;
}
export interface PongMessage extends BaseMessage {
    type: MessageType.PONG;
}
export interface PlayerInputMessage extends BaseMessage {
    type: MessageType.PLAYER_INPUT;
    sequence: number;
    input: {
        forward: boolean;
        backward: boolean;
        left: boolean;
        right: boolean;
        jump: boolean;
        deltaYaw: number;
        deltaPitch: number;
    };
}
export interface GameStateUpdateMessage extends BaseMessage {
    type: MessageType.GAME_STATE_UPDATE;
    timestamp: number;
    state: {
        [id: string]: {
            p: {
                x: number;
                y: number;
                z: number;
            };
            r: {
                pitch: number;
                yaw: number;
            };
            seq: number;
        };
    };
}
export interface WelcomeMessage extends BaseMessage {
    type: MessageType.WELCOME;
    clientId: string;
}
export type GameMessage = EchoMessage | PingMessage | PongMessage | PlayerInputMessage | GameStateUpdateMessage | WelcomeMessage;
//# sourceMappingURL=messages.d.ts.map