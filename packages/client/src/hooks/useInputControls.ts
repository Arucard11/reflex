import { useRef, useEffect, useCallback, useState } from 'react';
import * as THREE from 'three';

export interface FrameInputState {
    deltaYaw: number;
    deltaPitch: number;
    forward: boolean;
    backward: boolean;
    left: boolean;
    right: boolean;
    jump: boolean;
}

interface UseInputControlsProps {
    mountRef: React.RefObject<HTMLElement | null>;
    initialYaw?: number;
}

const MOUSE_SENSITIVITY = 0.002;
const PITCH_LIMIT = Math.PI / 2 - 0.01; // Limit pitch to avoid camera flipping

export const useInputControls = ({ mountRef, initialYaw = 0 }: UseInputControlsProps) => {
    const isPointerLocked = useRef(false);
    const accumulatedYaw = useRef(initialYaw);
    const accumulatedPitch = useRef(0);
    const frameDeltaYaw = useRef(0);
    const frameDeltaPitch = useRef(0);

    const keysPressed = useRef<Record<string, boolean>>({
        KeyW: false,
        KeyS: false,
        KeyA: false,
        KeyD: false,
        Space: false,
    });

    // --- Pointer Lock Logic --- 
    const handlePointerLockChange = useCallback(() => {
        isPointerLocked.current = document.pointerLockElement === mountRef.current;
        console.log('Pointer Lock Changed:', isPointerLocked.current);
        // Force a re-render if necessary to update UI elements dependent on lock state (e.g., cursor style)
        // Usually handled by state update in the component using the hook
    }, [mountRef]);

    const handlePointerLockError = useCallback(() => {
        console.error('Pointer Lock Error');
    }, []);

    const requestPointerLock = useCallback(() => {
        mountRef.current?.requestPointerLock();
    }, [mountRef]);

    useEffect(() => {
        const mountElement = mountRef.current;
        if (!mountElement) return;

        document.addEventListener('pointerlockchange', handlePointerLockChange, false);
        document.addEventListener('pointerlockerror', handlePointerLockError, false);
        mountElement.addEventListener('click', requestPointerLock);

        return () => {
            document.removeEventListener('pointerlockchange', handlePointerLockChange, false);
            document.removeEventListener('pointerlockerror', handlePointerLockError, false);
            mountElement.removeEventListener('click', requestPointerLock);
            if (document.pointerLockElement === mountElement) {
                document.exitPointerLock();
            }
        };
    }, [mountRef, handlePointerLockChange, handlePointerLockError, requestPointerLock]);

    // --- Mouse Movement Logic --- 
    const handleMouseMove = useCallback((event: MouseEvent) => {
        if (!isPointerLocked.current) return;

        const deltaX = event.movementX || 0;
        const deltaY = event.movementY || 0;

        const yawChange = deltaX * MOUSE_SENSITIVITY;
        const pitchChange = deltaY * MOUSE_SENSITIVITY;

        accumulatedYaw.current -= yawChange; // Subtract because positive movementX is right
        accumulatedPitch.current -= pitchChange; // Subtract because positive movementY is down

        // Clamp pitch
        accumulatedPitch.current = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, accumulatedPitch.current));

        // Accumulate frame deltas for consumption by getFrameInput
        frameDeltaYaw.current -= yawChange;
        frameDeltaPitch.current -= pitchChange;

    }, []);

    useEffect(() => {
        if (isPointerLocked.current) {
             document.addEventListener('mousemove', handleMouseMove, false);
        }
         // Re-attach or detach listener if pointer lock state changes outside the initial effect
        const currentLockState = isPointerLocked.current;
        const lockChangeHandler = () => {
             if (isPointerLocked.current && !currentLockState) {
                 document.addEventListener('mousemove', handleMouseMove, false);
             } else if (!isPointerLocked.current && currentLockState) {
                 document.removeEventListener('mousemove', handleMouseMove, false);
             }
        }
        document.addEventListener('pointerlockchange', lockChangeHandler); 

        return () => {
            document.removeEventListener('mousemove', handleMouseMove, false);
             document.removeEventListener('pointerlockchange', lockChangeHandler); 
        };
    }, [handleMouseMove]); // Rerun if handler changes

    // --- Keyboard Input Logic --- 
    const handleKeyDown = useCallback((event: KeyboardEvent) => {
        if (keysPressed.current.hasOwnProperty(event.code)) {
            keysPressed.current[event.code] = true;
        }
    }, []);

    const handleKeyUp = useCallback((event: KeyboardEvent) => {
        if (keysPressed.current.hasOwnProperty(event.code)) {
            keysPressed.current[event.code] = false;
        }
    }, []);

    useEffect(() => {
        window.addEventListener('keydown', handleKeyDown);
        window.addEventListener('keyup', handleKeyUp);
        return () => {
            window.removeEventListener('keydown', handleKeyDown);
            window.removeEventListener('keyup', handleKeyUp);
        };
    }, [handleKeyDown, handleKeyUp]);

    // --- Get Frame Input Function --- 
    const getFrameInput = useCallback((): FrameInputState => {
        const inputState: FrameInputState = {
            deltaYaw: frameDeltaYaw.current,
            deltaPitch: frameDeltaPitch.current, // Note: This is the raw pitch delta for this frame
            forward: keysPressed.current['KeyW'] || false,
            backward: keysPressed.current['KeyS'] || false,
            left: keysPressed.current['KeyA'] || false,
            right: keysPressed.current['KeyD'] || false,
            jump: keysPressed.current['Space'] || false,
        };

        // Reset frame deltas after they've been read
        frameDeltaYaw.current = 0;
        frameDeltaPitch.current = 0;

        return inputState;
    }, []);

    return {
        isPointerLocked, // Return the ref directly
        getFrameInput,
        accumulatedYaw,   // Ref containing the total yaw
        accumulatedPitch, // Ref containing the total pitch
    };
}; 