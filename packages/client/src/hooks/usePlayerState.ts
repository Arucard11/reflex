import { useRef, useCallback, useState, useEffect } from 'react';
import * as THREE from 'three';
import { PlayerInputMessage, GameStateUpdateMessage, MessageType } from '@shared/types/messages';
import { FrameInputState } from './useInputControls'; // Assuming FrameInputState is exported
import { sendPlayerInput, getClientId } from '../network'; // Import network functions

// Interfaces (can be shared or defined here)
export interface PlayerState { // Export for use in CameraControls and GameView
    position: THREE.Vector3;
    yaw: number;
    velocityY: number;
    isGrounded: boolean;
}

interface BufferedInput {
    sequence: number;
    input: PlayerInputMessage['input']; // Store the input sent to server
    predictedState: PlayerState; // Store the state *after* applying this input locally
}

interface UsePlayerStateProps {
    mapModel: THREE.Group | null;
    characterModelRef: React.RefObject<THREE.Group | null>; // Pass ref for visual updates
    characterModel: THREE.Group | null; // <-- ADD PROP for triggering effect
    initialPosition?: THREE.Vector3;
    initialYaw?: number;
    gravity?: number;
    jumpForce?: number;
    moveSpeed?: number;
    maxSlopeAngle?: number;
    scaleFactor?: number; // Needed for calculating dimensions
    onStateReady?: (initialState: PlayerState) => void; // Callback when state is initialized AFTER model is ready
}

// --- Prediction Logic (Copied and adapted from GameView) ---
// IMPORTANT: Ensure this matches server-side logic closely!
const applyInputPrediction = (
    currentState: PlayerState,
    input: FrameInputState, // Use FrameInputState here
    deltaTime: number,
    map: THREE.Group | null,
    playerHeight: number,
    gravity: number,
    jumpForce: number,
    moveSpeed: number,
    maxSlopeAngle: number,
    // camera: THREE.Camera // Camera not directly needed for physics prediction
): PlayerState => {
    if (!map) return currentState;

    const nextState: PlayerState = {
        position: currentState.position.clone(),
        // Yaw is updated directly based on input deltaYaw
        yaw: currentState.yaw + input.deltaYaw,
        velocityY: currentState.velocityY,
        isGrounded: currentState.isGrounded,
    };

    const playerPosition = nextState.position;
    const horizontalVelocity = new THREE.Vector3();
    const direction = new THREE.Vector3();
    const rightDirection = new THREE.Vector3();

    // Use the *next* state's yaw to determine direction vectors
    const tempObject = new THREE.Object3D();
    tempObject.rotation.y = nextState.yaw;
    tempObject.updateMatrixWorld(); // Ensure matrix is up-to-date
    tempObject.getWorldDirection(direction);
    direction.y = 0; // Project onto horizontal plane
    direction.normalize();
    // Calculate right direction based on predicted forward direction
    rightDirection.crossVectors(tempObject.up, direction).normalize();

    // Apply movement based on input flags
    if (input.forward) horizontalVelocity.add(direction);
    if (input.backward) horizontalVelocity.sub(direction);
    if (input.left) horizontalVelocity.add(rightDirection); // Strafe left
    if (input.right) horizontalVelocity.sub(rightDirection); // Strafe right

    // Normalize and scale velocity
    if (horizontalVelocity.lengthSq() > 0.0001) { // Use a small threshold
        horizontalVelocity.normalize();
    }
    horizontalVelocity.multiplyScalar(moveSpeed * deltaTime);

    // --- Vertical Movement & Collision ---
    nextState.velocityY -= gravity * deltaTime; // Apply gravity

    // Ground Check
    const groundCheckDist = 0.2;
    const groundRayOrigin = playerPosition.clone().add(new THREE.Vector3(0, 0.1, 0)); // Start slightly above feet
    const groundRaycaster = new THREE.Raycaster(groundRayOrigin, new THREE.Vector3(0, -1, 0), 0, groundCheckDist);
    const groundIntersects = groundRaycaster.intersectObject(map, true);

    // ---> Log Raycast Results <---
    if (groundIntersects.length > 0) {
        console.log(`Ground Check Hit: PlayerY=${playerPosition.y.toFixed(2)}, HitY=${groundIntersects[0].point.y.toFixed(2)}, Dist=${groundIntersects[0].distance.toFixed(2)}`);
    } else {
        console.log(`Ground Check Miss: PlayerY=${playerPosition.y.toFixed(2)}, RayOriginY=${groundRayOrigin.y.toFixed(2)}`);
    }
    // ---> End Log <---

    nextState.isGrounded = false;
    if (groundIntersects.length > 0) {
        const groundY = groundIntersects[0].point.y;
        // Check if player is at or slightly below the detected ground
        if (playerPosition.y <= groundY + 0.05) {
            nextState.isGrounded = true;
            // Snap to ground if moving downwards or standing still
            if (nextState.velocityY <= 0) {
                nextState.velocityY = 0;
                playerPosition.y = groundY; // Snap position to ground
            }
        }
    }

    // Jumping
    // Use currentState.isGrounded to prevent double jumps in one prediction step
    if (input.jump && currentState.isGrounded) {
        nextState.velocityY = jumpForce;
        nextState.isGrounded = false; // Instantly become not grounded
    }

    // Ceiling Check (only if moving upwards)
    if (nextState.velocityY > 0) {
        const ceilingCheckDist = nextState.velocityY * deltaTime + 0.1; // Check slightly ahead
        const ceilingRayOrigin = playerPosition.clone().add(new THREE.Vector3(0, playerHeight - 0.1, 0)); // Near top of head
        const ceilingRaycaster = new THREE.Raycaster(ceilingRayOrigin, new THREE.Vector3(0, 1, 0), 0, ceilingCheckDist);
        const ceilingIntersects = ceilingRaycaster.intersectObject(map, true);
        if (ceilingIntersects.length > 0) {
            nextState.velocityY = 0; // Stop upward movement
        }
    }

    // --- Horizontal Collision & Sliding ---
    const horizontalMoveDistance = horizontalVelocity.length();
    let horizontalCollisionDetected = false;
    if (horizontalMoveDistance > 0.001) { // Only check if moving significantly
        const moveDirection = horizontalVelocity.clone().normalize();
        const playerRadius = 0.25; // Approximate player width/depth
        const checkHeights = [0.1, playerHeight * 0.5, playerHeight - 0.1]; // Check low, mid, high
        const numRays = 8; // Rays around the player cylinder
        let collisionNormal: THREE.Vector3 | null = null;

        heightLoop:
        for (const heightOffset of checkHeights) {
            for (let i = 0; i < numRays; i++) {
                const angle = (i / numRays) * Math.PI * 2;
                const offsetX = Math.cos(angle) * playerRadius;
                const offsetZ = Math.sin(angle) * playerRadius;
                const rayOrigin = playerPosition.clone().add(new THREE.Vector3(offsetX, heightOffset, offsetZ));
                const raycaster = new THREE.Raycaster(rayOrigin, moveDirection, 0, horizontalMoveDistance + playerRadius * 0.5); // Check slightly ahead
                const intersections = raycaster.intersectObject(map, true);

                // Find the closest intersection that isn't starting inside geometry
                const validIntersection = intersections.find(intersect => intersect.distance > 0.01);

                if (validIntersection && validIntersection.distance <= horizontalMoveDistance + playerRadius * 0.1) {
                    horizontalCollisionDetected = true;
                    collisionNormal = validIntersection.face?.normal.clone() ?? null;
                    // console.log("Collision Normal:", collisionNormal);
                    break heightLoop; // Stop checking once a collision is found
                }
            }
        }

        if (horizontalCollisionDetected && collisionNormal) {
            const slopeAngle = Math.acos(collisionNormal.y); // Angle between normal and world up
            // console.log("Slope Angle:", slopeAngle * 180 / Math.PI);
            if (slopeAngle < maxSlopeAngle) {
                // Slide along the wall/slope
                const slideDirection = horizontalVelocity.clone().projectOnPlane(collisionNormal).normalize();
                horizontalVelocity.copy(slideDirection).multiplyScalar(horizontalMoveDistance);
                horizontalCollisionDetected = false; // Allow sliding movement
            } else {
                // Slope is too steep, stop horizontal movement
                horizontalVelocity.set(0, 0, 0);
            }
        } else if (horizontalCollisionDetected) {
            // Collision detected but no valid normal (unlikely) or flat wall
             horizontalVelocity.set(0, 0, 0);
        }
    }

    // Apply final velocities to position
    playerPosition.add(horizontalVelocity); // Apply horizontal movement
    // Apply vertical movement only if not grounded or moving upwards
    if (!nextState.isGrounded || nextState.velocityY > 0) {
        playerPosition.y += nextState.velocityY * deltaTime;
    }

    // Final ground snap after potential vertical movement this frame
    if (!nextState.isGrounded && nextState.velocityY <= 0) {
        const finalGroundRayOrigin = playerPosition.clone().add(new THREE.Vector3(0, 0.1, 0));
        const finalGroundRaycaster = new THREE.Raycaster(finalGroundRayOrigin, new THREE.Vector3(0, -1, 0), 0, 0.15);
        const finalGroundIntersects = finalGroundRaycaster.intersectObject(map, true);
        if (finalGroundIntersects.length > 0) {
            const groundY = finalGroundIntersects[0].point.y;
             if (playerPosition.y <= groundY + 0.05) {
                playerPosition.y = groundY;
                nextState.isGrounded = true;
                nextState.velocityY = 0;
             }
        }
    }


    return nextState;
};


export function usePlayerState({
    mapModel,
    characterModelRef,
    characterModel,
    initialPosition = new THREE.Vector3(0, 10, 0),
    initialYaw = Math.PI,
    gravity = 9.82,
    jumpForce = 6.0,
    moveSpeed = 5.0,
    maxSlopeAngle = Math.PI / 4,
    scaleFactor = 0.35, // Default scale factor
    onStateReady
}: UsePlayerStateProps) {
    const playerStateRef = useRef<PlayerState>({ position: initialPosition.clone(), yaw: initialYaw, velocityY: 0, isGrounded: false });
    const sequenceNumber = useRef(1);
    const pendingInputsRef = useRef<BufferedInput[]>([]);
    const serverStateRef = useRef<PlayerState | null>(null);
    const lastServerSequenceRef = useRef<number>(0);

    // Character dimensions - Calculated based on the actual scaled model
    const scaledCharHeight = useRef<number>(1.8); // Default estimate
    const scaledCharBaseY = useRef<number>(0.0); // Offset from model origin to feet

    // Flag to ensure dimensions are calculated only once
    const dimensionsCalculated = useRef(false);

    // Helper function to apply visual state (position/rotation)
    // Defined using useCallback to stabilize its reference for useEffect dependencies
    const applyVisualState = useCallback((state: PlayerState) => {
        if (characterModelRef.current) {
            const model = characterModelRef.current;
            // Apply position, offsetting by the calculated base Y so feet are at state.position.y
            model.position.set(state.position.x, state.position.y + scaledCharBaseY.current, state.position.z);
            // Apply yaw rotation around the Y axis
            model.rotation.y = state.yaw;
        }
    }, [characterModelRef]); // Dependency: characterModelRef

     // Effect to calculate dimensions and set initial visual state WHEN the model is ready
    useEffect(() => {
        const playerModel = characterModel;
        console.log("PlayerState: Dimension calculation effect running. Model ready?", !!playerModel);

        // Ensure model exists (via prop) and dimensions haven't been calculated yet
        if (playerModel && !dimensionsCalculated.current) {
             console.log("PlayerState: Calculating dimensions...");
            // Apply scaling FIRST if not already done externally
            // playerModel.scale.set(scaleFactor, scaleFactor, scaleFactor); // Scene hook might handle this now

            const box = new THREE.Box3().setFromObject(playerModel);
            const size = new THREE.Vector3();
            box.getSize(size);

            // Check for valid size (avoid division by zero or NaN if model is empty)
            if (size.x <= 0 || size.y <= 0 || size.z <= 0) {
                console.error("PlayerState: Invalid model dimensions calculated!", size);
                // Decide how to handle this - maybe skip dimension calc?
                return; // Stop processing if dimensions are invalid
            }

            const bottomY = box.min.y; // Position of the bottom face in model's local space
            const yOffset = -bottomY; // How much to raise the model so its bottom is at y=0

            scaledCharHeight.current = size.y;
            scaledCharBaseY.current = yOffset;
            dimensionsCalculated.current = true; // Mark as calculated

             console.log(`PlayerState: Calculated dimensions H=${scaledCharHeight.current.toFixed(2)}, BaseYOffset=${scaledCharBaseY.current.toFixed(2)}`);

            // Apply initial visual state ONLY AFTER dimensions are known
            applyVisualState(playerStateRef.current);

            // Call the readiness callback *after* dimensions are calculated
            if (onStateReady) {
                 console.log("PlayerState: Dimensions calculated. Calling onStateReady...");
                 onStateReady(playerStateRef.current); // Pass the initial state
            } else {
                console.warn("PlayerState: onStateReady callback not provided.");
            }
        } else if (!playerModel) {
             console.log("PlayerState: Waiting for character model prop to populate...");
        } else {
             console.log("PlayerState: Dimensions previously calculated.");
             // Maybe call onStateReady here too if it wasn't called before?
             // This might be needed if the model ref updates but dimensions were already calc'd
             // However, the !dimensionsCalculated.current check should prevent re-calculation.
             // Let's see if the above call fixes it first.
        }
    }, [characterModel, onStateReady, applyVisualState]); // Updated dependencies


    // --- Reconciliation Logic (Handle Server Updates) ---
    const handleServerUpdate = useCallback((update: GameStateUpdateMessage) => {
        console.log("usePlayerState: handleServerUpdate called.", update);
        const clientId = getClientId();
        if (!clientId) return;

        // Add sequence reset logic
        if (lastServerSequenceRef.current === -1 && update.state[clientId]?.seq === 0) {
            console.log("Resetting client sequence to match server initial state");
            sequenceNumber.current = 0;
            lastServerSequenceRef.current = 0;
        }

        const ownState = update.state[clientId];
        if (!ownState) {
             console.log(`PlayerState: State for client ${clientId} not found in update.`); // Log if state is missing
            return; // Our state wasn't included
        }

        const serverPos = new THREE.Vector3(ownState.p.x, ownState.p.y, ownState.p.z);
        const serverYaw = ownState.r.yaw;
        const serverSequence = ownState.seq;
        console.log(`PlayerState: Received Server State (Seq: ${serverSequence}): Pos=(${serverPos.x.toFixed(2)}, ${serverPos.y.toFixed(2)}, ${serverPos.z.toFixed(2)}), Yaw=${serverYaw.toFixed(2)}`);

        serverStateRef.current = { position: serverPos.clone(), yaw: serverYaw, velocityY: 0, isGrounded: true }; // Store server state
        lastServerSequenceRef.current = serverSequence;

        const bufferIndex = pendingInputsRef.current.findIndex(input => input.sequence === serverSequence);

        if (bufferIndex !== -1) {
            // Found the corresponding client input
            const clientPredictedStateAtServerTime = pendingInputsRef.current[bufferIndex].predictedState;
            console.log(`PlayerState: Found Matching Client Prediction (Seq: ${serverSequence}): Pos=(${clientPredictedStateAtServerTime.position.x.toFixed(2)}, ${clientPredictedStateAtServerTime.position.y.toFixed(2)}, ${clientPredictedStateAtServerTime.position.z.toFixed(2)}), Yaw=${clientPredictedStateAtServerTime.yaw.toFixed(2)}`);

            // Calculate error
            const positionError = clientPredictedStateAtServerTime.position.distanceTo(serverPos);
            let yawDiff = clientPredictedStateAtServerTime.yaw - serverYaw;
            while (yawDiff <= -Math.PI) yawDiff += 2 * Math.PI;
            while (yawDiff > Math.PI) yawDiff -= 2 * Math.PI;
            const yawError = Math.abs(yawDiff);
            console.log(`PlayerState: Error Calculation (Seq: ${serverSequence}): Pos Err=${positionError.toFixed(3)}, Yaw Err=${yawError.toFixed(3)}`);

            // Define error thresholds
            const errorThresholdPos = 0.10;
            const errorThresholdYaw = 0.02;

            // Remove acknowledged input and older ones
            const acknowledgedInput = pendingInputsRef.current.splice(0, bufferIndex + 1);
            // console.log(`PlayerState: Ack seq ${serverSequence}. Removed ${acknowledgedInput.length} inputs.`);


            if (positionError > errorThresholdPos || yawError > errorThresholdYaw) {
                console.warn(`PlayerState: Reconciliation needed! Triggering replay from server state (Seq: ${serverSequence})`);

                // Start replay from the authoritative server state
                let replayedState: PlayerState = {
                    position: serverPos.clone(),
                    yaw: serverYaw,
                    // Estimate initial velocity/grounded based on server pos? Or just reset?
                    velocityY: 0, // Safer to reset and let prediction correct
                    isGrounded: true, // Assume grounded, prediction will correct
                };

                const fixedReplayDelta = 1 / 60; // Use a fixed delta matching prediction rate?

                // console.log(`PlayerState: Replaying ${pendingInputsRef.current.length} inputs...`);
                for (const bufferedInput of pendingInputsRef.current) {
                    if (!mapModel) break; // Need map for replay

                    // Adapt buffered input (PlayerInputMessage['input']) to FrameInputState
                    const frameInputAdapter: FrameInputState = {
                         forward: bufferedInput.input.forward,
                         backward: bufferedInput.input.backward,
                         left: bufferedInput.input.left,
                         right: bufferedInput.input.right,
                         jump: bufferedInput.input.jump,
                         deltaYaw: bufferedInput.input.deltaYaw,
                         deltaPitch: 0, // Pitch doesn't affect physics state prediction
                    };

                    replayedState = applyInputPrediction(
                        replayedState, // Pass the evolving replayed state
                        frameInputAdapter,
                        fixedReplayDelta, // Use fixed delta for replay consistency
                        mapModel,
                        scaledCharHeight.current, // Use calculated height
                        gravity,
                        jumpForce,
                        moveSpeed,
                        maxSlopeAngle
                    );
                    // Update the prediction stored *in the buffer* for this replayed input
                    bufferedInput.predictedState = { ...replayedState };
                }
                // console.log(`PlayerState: Replay finished.`);

                // After replaying, the final 'replayedState' is our corrected current state.
                playerStateRef.current = replayedState;
                // Apply the final corrected state visually
                applyVisualState(replayedState);
                console.log(`PlayerState: Reconciliation finished. Final Corrected State (Seq: ${serverSequence}): Pos=(${replayedState.position.x.toFixed(2)}, ${replayedState.position.y.toFixed(2)}, ${replayedState.position.z.toFixed(2)}), Yaw=${replayedState.yaw.toFixed(2)}`);

            } else {
                // Prediction was close enough for the acknowledged input.
                console.log(`PlayerState: Prediction OK for seq ${serverSequence}. No correction needed.`);
                // The current player state ref should naturally align with the latest
                // prediction from the remaining buffer (if any).
                 // console.log(`PlayerState: Prediction OK for seq ${serverSequence}.`);
                 // No explicit visual update needed here unless we strictly follow buffer
                 // applyVisualState(playerStateRef.current); // Could force sync visual with logical state
            }

        } else {
            // Server sent an update for a sequence we don't have (or buffer is empty).
            // Snap the client state directly to the server state.
             console.warn(`PlayerState: No matching client input for server sequence ${serverSequence}. Snapping state.`);
              playerStateRef.current = {
                position: serverPos.clone(),
                yaw: serverYaw,
                velocityY: 0, // Reset velocity
                isGrounded: true, // Assume grounded
              };
              // Clear pending inputs as they are based on a now-invalid history
              pendingInputsRef.current = [];
              // Apply the snapped state visually
              applyVisualState(playerStateRef.current);
              console.log(`PlayerState: Snapped to Server State (Seq: ${serverSequence}): Pos=(${playerStateRef.current.position.x.toFixed(2)}, ${playerStateRef.current.position.y.toFixed(2)}, ${playerStateRef.current.position.z.toFixed(2)}), Yaw=${playerStateRef.current.yaw.toFixed(2)}`);
        }
    }, [mapModel, gravity, jumpForce, moveSpeed, maxSlopeAngle, applyVisualState]); // Dependencies


    // --- Process Input & Update State (Called each frame) ---
    const processPlayerInput = useCallback((input: FrameInputState, delta: number) => {
        if (!mapModel || !dimensionsCalculated.current) {
            // console.warn("PlayerState: Skipping input processing - map or dimensions not ready.");
            return; // Need map and dimensions for prediction
        }

        // Get the state from the end of the *last* frame's prediction/reconciliation
        const currentState = playerStateRef.current;

        // Predict the next state based on current input and state
        const predictedState = applyInputPrediction(
            currentState,
            input,
            delta, // Use actual frame delta for local prediction
            mapModel,
            scaledCharHeight.current, // Use calculated height
            gravity,
            jumpForce,
            moveSpeed,
            maxSlopeAngle
        );

        // Update the ref to store the new predicted state (used for next frame's prediction)
        playerStateRef.current = predictedState;

        // --- Send Input to Server ---
        sequenceNumber.current++;
        const inputMessage: PlayerInputMessage = {
            type: MessageType.PLAYER_INPUT,
            sequence: sequenceNumber.current,
            timestamp: Date.now(),
            input: {
                forward: input.forward,
                backward: input.backward,
                left: input.left,
                right: input.right,
                jump: input.jump,
                deltaYaw: input.deltaYaw,
                deltaPitch: 0, // Server doesn't need pitch for state
            },
        };

        // ---> ADD LOG HERE <---
        console.log(`PlayerState: Sending Input (Seq: ${inputMessage.sequence})`);
        sendPlayerInput(inputMessage);

        // --- Buffer Input & Prediction ---
        pendingInputsRef.current.push({
            sequence: inputMessage.sequence,
            input: inputMessage.input, // Store the input *sent* to the server
            predictedState: { ...predictedState } // Store the resulting predicted state
        });

        // Limit buffer size
        if (pendingInputsRef.current.length > 120) {
            // console.log("PlayerState: Pruning input buffer.");
            pendingInputsRef.current.shift();
        }

        // Apply the *latest* predicted state visually in this frame
        applyVisualState(predictedState);

    }, [mapModel, gravity, jumpForce, moveSpeed, maxSlopeAngle, applyVisualState]); // Dependencies

    // Expose necessary state and functions
    const getPlayerState = useCallback(() => playerStateRef.current, []); // Function to get current state

    return {
        playerStateRef, // Expose the ref directly if needed
        getPlayerState,
        handleServerUpdate,
        processPlayerInput,
        // Don't necessarily need to expose height/base Y, prediction uses internal ref
    };
} 