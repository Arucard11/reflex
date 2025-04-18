"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.PLAYER_RADIUS = void 0;
exports.getPlayerState = getPlayerState;
exports.getAllPlayerStates = getAllPlayerStates;
exports.createPlayer = createPlayer;
exports.removePlayer = removePlayer;
exports.updatePlayerInput = updatePlayerInput;
const CANNON = __importStar(require("cannon-es"));
const physics_1 = require("./physics");
// --- Player Management Map ---
// Encapsulated within this module
const playerStates = new Map();
// --- Player Constants ---
exports.PLAYER_RADIUS = 0.5;
// export const PLAYER_HEIGHT = 1.8; // Keep if using a more complex shape later
const PLAYER_MASS = 70;
const INITIAL_SPAWN_POS = new CANNON.Vec3(0, 5, 5); // Start slightly above ground
// --- Public Functions ---
function getPlayerState(id) {
    return playerStates.get(id);
}
function getAllPlayerStates() {
    return playerStates;
}
function createPlayer(id) {
    console.log(`[PlayerManager] Creating player: ${id}`);
    const playerShape = new CANNON.Sphere(exports.PLAYER_RADIUS); // Start with Sphere
    const playerBody = new CANNON.Body({
        mass: PLAYER_MASS,
        position: INITIAL_SPAWN_POS.clone(), // Use clone to avoid modifying original
        shape: playerShape,
        material: physics_1.playerMaterial,
        fixedRotation: true,
        linearDamping: 0.5, // Helps prevent infinite sliding
        angularDamping: 1.0, // Prevents sphere spinning wildly
    });
    physics_1.physicsWorld.addBody(playerBody);
    const initialState = {
        id,
        position: { x: playerBody.position.x, y: playerBody.position.y, z: playerBody.position.z },
        rotation: { pitch: 0, yaw: 0 },
        lastInputTimestamp: Date.now(),
        lastProcessedInputSequence: 0,
        physicsBody: playerBody,
    };
    playerStates.set(id, initialState);
    console.log(`[PlayerManager] Added player ${id} to state. Total players: ${playerStates.size}`);
    return initialState;
}
function removePlayer(id) {
    const state = playerStates.get(id);
    console.log(`[PlayerManager] Removing player: ${id}`);
    if (state && state.physicsBody) {
        physics_1.physicsWorld.removeBody(state.physicsBody);
        console.log(`[PlayerManager] Removed physics body for ${id}`);
    }
    playerStates.delete(id);
    console.log(`[PlayerManager] Removed state for ${id}. Players remaining: ${playerStates.size}`);
}
function updatePlayerInput(id, inputData, // Consider using a specific type from shared/types
physicsBody, currentState) {
    console.log(`[PlayerManager] ENTERED updatePlayerInput for ${id} with Seq: ${inputData.sequence}`);
    // This function will now contain the logic from the PLAYER_INPUT handler
    // related to applying forces/velocity based on input.
    // It modifies the physicsBody directly.
    // 1. Update Rotation (remains the same, visual only for server)
    currentState.rotation.yaw += inputData.input.deltaYaw;
    currentState.rotation.pitch += inputData.input.deltaPitch;
    currentState.rotation.pitch = Math.max(-Math.PI / 2 * 0.99, Math.min(Math.PI / 2 * 0.99, currentState.rotation.pitch));
    // 2. Calculate Desired Velocity based on Input and Rotation
    const inputVector = { x: 0, z: 0 };
    const forward = new CANNON.Vec3(Math.sin(currentState.rotation.yaw), 0, Math.cos(currentState.rotation.yaw));
    const right = new CANNON.Vec3(Math.sin(currentState.rotation.yaw + Math.PI / 2), 0, Math.cos(currentState.rotation.yaw + Math.PI / 2));
    if (inputData.input.forward) {
        inputVector.x += forward.x;
        inputVector.z += forward.z;
    }
    if (inputData.input.backward) {
        inputVector.x -= forward.x;
        inputVector.z -= forward.z;
    }
    if (inputData.input.left) {
        inputVector.x -= right.x;
        inputVector.z -= right.z;
    }
    if (inputData.input.right) {
        inputVector.x += right.x;
        inputVector.z += right.z;
    }
    const desiredVelocity = new CANNON.Vec3(0, physicsBody.velocity.y, 0); // Preserve Y velocity (gravity)
    const MOVE_SPEED = 5.0; // Consider moving this constant here or to physics.ts
    const JUMP_FORCE = 6.0; // Consider moving this constant here or to physics.ts
    const lenSq = inputVector.x * inputVector.x + inputVector.z * inputVector.z;
    if (lenSq > 0.001) {
        const len = Math.sqrt(lenSq);
        const normalizedInputX = inputVector.x / len;
        const normalizedInputZ = inputVector.z / len;
        desiredVelocity.x = normalizedInputX * MOVE_SPEED;
        desiredVelocity.z = normalizedInputZ * MOVE_SPEED;
    }
    else {
        // Apply damping/friction when no input
        desiredVelocity.x = physicsBody.velocity.x * 0.8;
        desiredVelocity.z = physicsBody.velocity.z * 0.8;
        if (Math.abs(desiredVelocity.x) < 0.1)
            desiredVelocity.x = 0;
        if (Math.abs(desiredVelocity.z) < 0.1)
            desiredVelocity.z = 0;
    }
    // 3. Apply Calculated Velocity
    physicsBody.velocity.x = desiredVelocity.x;
    physicsBody.velocity.z = desiredVelocity.z;
    // 4. Handle Jump
    const isGrounded = Math.abs(physicsBody.velocity.y) < 0.1; // Basic ground check
    if (inputData.input.jump && isGrounded) {
        console.log(`[PlayerManager] Player ${id} attempting jump`);
        physicsBody.velocity.y = JUMP_FORCE;
    }
    // 5. Update Timestamps and Sequence (on the ServerPlayerState object passed in)
    console.log(`[PlayerManager] Updating sequence for ${id}: Current=${currentState.lastProcessedInputSequence}, Incoming=${inputData.sequence}`);
    currentState.lastInputTimestamp = inputData.timestamp;
    currentState.lastProcessedInputSequence = inputData.sequence;
    console.log(`[PlayerManager] Sequence after update for ${id}: ${currentState.lastProcessedInputSequence}`);
}
