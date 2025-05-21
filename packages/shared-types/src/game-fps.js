// packages/shared-types/src/game-fps.js

// --- Import Extracted Map Physics Data ---
import { map1Vertices, map1Indices } from './map1_physics_data.js';
import { map2Vertices, map2Indices } from './map2_physics_data.js';
// Map 3 data extraction failed, keep using primitives for now.

// --- Core Enums / Constants ---
export const GrenadeType = {
    FRAG: 'frag',
    SEMTEX: 'semtex',
    FLASHBANG: 'flashbang',
};

export const AbilityType = { // Example types
    DASH: 'dash',
    HEAL_BURST: 'heal_burst',
    DAMAGE_AMP: 'damage_amp',
    // Add more as needed
};

export const CharacterId = {
    CHAR_A: 'charA',
    // CHAR_B: 'charB', // Removed
    // CHAR_C: 'charC', // Removed
};

export const MapId = {
    MAP_1: 'map1',
    // MAP_2: 'map2', // Removed
    // MAP_3: 'map3', // Removed
};

// --- NEW: Physics Collision Groups ---
/**
 * Defines bitmasks for different collision categories.
 * Each object belongs to one group (memberships) and defines which groups it can interact with (filter).
 */
export const CollisionGroup = {
    // Membership groups (powers of 2)
    WORLD: 1 << 0,        // Static map geometry
    PLAYER_BODY: 1 << 1,  // Player physics capsule
    PLAYER_HITBOX: 1 << 2,// Separate hitboxes for damage
    GRENADE: 1 << 3,      // Thrown grenades
    PROJECTILE: 1 << 4,   // Bullets, if modeled as objects (currently raycast)
    PLAYER_UTILITY_RAY: 1 << 5, // NEW: For player's internal raycasts like ground checks
    // ... add more as needed (e.g., vehicles, interactables)

    // Interaction Masks (combinations)
    ALL: 0xFFFFFFFF, // Collides with everything
    NONE: 0x00000000, // Collides with nothing
};

/**
 * Rapier helper function to generate interaction groups bitmask.
 * @param {number} memberships - Which group(s) this object belongs to (use CollisionGroup constants).
 * @param {Array<number>} filter - Which group(s) this object can collide with (array of CollisionGroup constants).
 * @returns {number} The combined bitmask for collider.setCollisionGroups().
 */
export function interactionGroups(memberships, filter) {
    const filterMask = filter.reduce((acc, group) => acc | group, 0);
    return (memberships << 16) | filterMask;
}
// --- End Physics Collision Groups ---

// --- Configuration Structures ---

/**
 * @typedef {Object} WeaponConfigFPS
 * @property {string} id
 * @property {number} fireRate - ms between shots
 * @property {number} damage
 * @property {number} range
 * @property {number} baseSpread
 * @property {number} spreadIncreasePerShot
 * @property {number} maxSpread
 * @property {number} spreadRecoveryRate
 * @property {number} visualRecoilUp
 * @property {number} visualRecoilSide
 * @property {number} recoilRecoverySpeed
 * @property {number} ammoCapacity - NEW: Magazine size
 * @property {number} reloadTime - NEW: ms for reload
 * // Add properties for other weapon types (e.g., isAutomatic)
 */
export const WEAPON_CONFIG_FPS = {
    rifle: { id: 'rifle', fireRate: 100, damage: 25, range: 100, baseSpread: 0.02, spreadIncreasePerShot: 0.008, maxSpread: 0.08, spreadRecoveryRate: 0.03, visualRecoilUp: 0.15, visualRecoilSide: 0.08, recoilRecoverySpeed: 4, ammoCapacity: 30, reloadTime: 2500, fpvModelPath: '/assets/fps_1v1/models/gun_carbine.glb' /*, isAutomatic: true */},
    // NEW: Add sniper, shotgun, etc.
    sniper: { id: 'sniper', fireRate: 1500, damage: 150, range: 500, baseSpread: 0.001, spreadIncreasePerShot: 0.0, maxSpread: 0.001, spreadRecoveryRate: 0.1, visualRecoilUp: 0.8, visualRecoilSide: 0.2, recoilRecoverySpeed: 1, ammoCapacity: 5, reloadTime: 4000, fpvModelPath: '/assets/fps_1v1/models/sniper_animated.glb' }, // Example sniper values
};

/**
 * @typedef {Object} GrenadeConfigFPS
 * @property {GrenadeType} type
 * @property {number} fuseTime - ms (0 for semtex impact)
 * @property {number} effectRadius
 * @property {number} damage - For frag/semtex
 * @property {number} flashDuration - For flashbang
 * // Add physics properties (mass, velocity) if needed
 */
export const GRENADE_CONFIG_FPS = {
    [GrenadeType.FRAG]: { type: GrenadeType.FRAG, fuseTime: 3000, effectRadius: 8, damage: 80 },
    [GrenadeType.SEMTEX]: { type: GrenadeType.SEMTEX, fuseTime: 2000, effectRadius: 6, damage: 70 }, // Sticks, shorter fuse
    [GrenadeType.FLASHBANG]: { type: GrenadeType.FLASHBANG, fuseTime: 1500, effectRadius: 10, flashDuration: 4000 },
};

/**
 * @typedef {Object} AbilityConfigFPS
 * @property {AbilityType} type
 * @property {number} cooldown - ms
 * @property {number} duration - ms (if applicable)
 * @property {number} effectValue - (e.g., dash distance, heal amount)
 */
export const ABILITY_CONFIG_FPS = { // Example ability details
    [AbilityType.DASH]: { type: AbilityType.DASH, cooldown: 8000, effectValue: 10 }, // 10 units dash distance
    [AbilityType.HEAL_BURST]: { type: AbilityType.HEAL_BURST, cooldown: 15000, effectValue: 50 }, // Heal 50 hp/shield combined?
    [AbilityType.DAMAGE_AMP]: { type: AbilityType.DAMAGE_AMP, cooldown: 20000, duration: 5000, effectValue: 1.2 }, // 20% damage boost for 5s
};

/**
 * @typedef {Object} CharacterConfigFPS
 * @property {CharacterId} id
 * @property {number} baseHealth
 * @property {number} baseShield
 * @property {AbilityType | null} ability1 - Which ability they have
 * @property {string} modelPath - NEW: Path to the character's visual GLB model
 * @property {number} [visualYOffset] - Optional Y-offset for visual model alignment (positive values move model up)
 * // Add properties for visual variations if needed (e.g., texture paths)
 */
export const CHARACTER_CONFIG_FPS = {
    [CharacterId.CHAR_A]: { id: CharacterId.CHAR_A, baseHealth: 100, baseShield: 50, ability1: AbilityType.DASH, modelPath: '/assets/fps_1v1/models/soldier.glb', visualYOffset: 0.0 }, // Updated path to assets, Added visualYOffset. visualYOffset assumes model pivot is at its geometric center.
    // [CharacterId.CHAR_B]: { id: CharacterId.CHAR_B, baseHealth: 75, baseShield: 75, ability1: AbilityType.HEAL_BURST, modelPath: '/assets/fps_1v1/models/soldier.glb', visualYOffset: 0.0 }, // Removed
    // [CharacterId.CHAR_C]: { id: CharacterId.CHAR_C, baseHealth: 125, baseShield: 25, ability1: AbilityType.DAMAGE_AMP, modelPath: '/assets/fps_1v1/models/soldier.glb', visualYOffset: 0.0 }, // Removed
};

/**
 * @typedef {Object} MapPhysicsDataFPS - Structure for physics geometry
 * @property {Array<number>} [vertices] - Optional vertex buffer
 * @property {Array<number>} [indices] - Optional index buffer for trimesh
 * @property {Array<{x: number, y: number, z: number}>} spawnPoints - Define potential spawn locations
 */

/**
 * @typedef {Object} MapConfigFPS
 * @property {MapId} id
 * @property {string} name - Display name
 * @property {string} visualAssetPath - Path to the map's visual GLB model
 * @property {MapPhysicsDataFPS} physicsData - The geometry for Rapier
 */
export const MAP_CONFIGS_FPS = {
    [MapId.MAP_1]: {
        id: MapId.MAP_1, name: 'Map 1', visualAssetPath: '/assets/fps_1v1/models/map1.glb',
        physicsData: {
            // Use extracted trimesh data
            vertices: map1Vertices,
            indices: map1Indices,
            spawnPoints: [
                { x: 3, y: 6, z: -7 }, // Player 1 spawn
                { x: -3, y: 6, z: 7 }  // Player 2 spawn (Y changed from -6 to 6)
            ],
        }
    },
    // [MapId.MAP_2]: { // Removed
    //     id: MapId.MAP_2, name: 'Map 2', visualAssetPath: '/assets/fps_1v1/models/map2.glb',
    //     physicsData: {
    //         vertices: map2Vertices,
    //         indices: map2Indices,
    //         spawnPoints: [{ x: 0, y: 1, z: -10 }, { x: 0, y: 1, z: 10 }],
    //     }
    // },
    // [MapId.MAP_3]: { // Removed
    //     id: MapId.MAP_3, name: 'Map 3', visualAssetPath: '/assets/fps_1v1/models/map3.glb',
    //     // Map 3: No trimesh data available, leave vertices/indices undefined (physics loading will fail)
    //     physicsData: {
    //         spawnPoints: [{ x: -15, y: 1, z: 0 }, { x: 15, y: 1, z: 0 }]
    //     }
    // },
};

// --- Network Message Payloads & State ---

/**
 * @typedef {Object} PlayerInputFPS
 * @property {number} sequence - Input sequence number
 * @property {number} deltaTime - Time delta for this input batch in seconds
 * @property {{W: boolean, A: boolean, S: boolean, D: boolean, Space: boolean, Shift: boolean, Ability1: boolean, GrenadeFrag: boolean, GrenadeSemtex: boolean, GrenadeFlash: boolean, Reload: boolean, Interact: boolean, GrappleFire: boolean, WeaponSwitch: boolean}} keys - Pressed state
 * @property {{x: number, y: number, z: number, w: number}} lookQuat - Player look direction quaternion
 */

/**
 * @typedef {Object} PlayerStateFPS - Represents a player's state on the server
 * @property {string} userId
 * @property {CharacterId} characterId - NEW: Which character is being played
 * @property {string} state - e.g., 'alive', 'dead', 'spawning'
 * @property {{x: number, y: number, z: number}} position
 * @property {{x: number, y: number, z: number, w: number}} rotation
 * @property {{x: number, y: number, z: number}} velocity
 * @property {number} health
 * @property {number} shield - NEW: Replaces armor
 * @property {number} kills
 * @property {number} deaths
 * @property {number} [lastProcessedSequence] - Server confirms processed input sequence for client reconciliation
 * @property {{ semtex: number, flashbang: number, frag: number }} grenades - NEW: Uses remaining this round
 * @property {number} ability1CooldownRemaining - NEW: Cooldown timer in ms
 * @property {Array<string>} weaponSlots - NEW: IDs of equipped weapons (e.g., ['rifle', 'pistol'])
 * @property {number} activeWeaponSlot - NEW: Index (0 or 1) of the active weapon in slots
 * @property {number} currentAmmoInClip - NEW: Ammo for the active weapon
 * @property {{ active: boolean, targetPoint: {x:number, y:number, z:number} | null, startTime: number | null }} grappleState - NEW: State of the grapple gun
 * @property {boolean} isReloading - NEW: Is player currently reloading?
 * // Add other effects like isFlashed, damageAmpActive, etc.
 */

/**
 * @typedef {Object} GameStateFPS - The main state broadcast from server
 * @property {number} serverTick - Server timestamp or tick number
 * @property {MapId} mapId - NEW: Current map ID
 * @property {string} matchState - e.g., 'countdown', 'in_progress', 'round_over'
 * @property {number} timeRemaining - Seconds left in countdown or round
 * @property {number} currentRound - Current round number
 * @property {{ p1: number, p2: number }} roundWins - NEW: Rounds won by each player
 * @property {Object<string, PlayerStateFPS>} players - Map of userId to player state
 */

export const MessageTypeFPS = {
    // Platform generic types might exist, define FPS specific ones
    // Client -> Server
    IDENTIFY_PLAYER: 'identify_player', // NEW: Add the identification message type
    PLAYER_INPUT_FPS: 'player_input_fps',
    PLAYER_FIRE_FPS: 'player_fire_fps', // Firing the active weapon
    SWITCH_WEAPON_FPS: 'switch_weapon_fps', // Request to switch active weapon slot
    RELOAD_WEAPON_FPS: 'reload_weapon_fps', // Request to reload active weapon
    THROW_GRENADE_FPS: 'throw_grenade_fps', // Includes grenade type
    USE_ABILITY_FPS: 'use_ability_fps', // Includes ability slot index (e.g., 1)
    FIRE_GRAPPLE_FPS: 'fire_grapple_fps', // Includes target point/direction
    RELEASE_GRAPPLE_FPS: 'release_grapple_fps', // Stop grappling

    // Server -> Client
    GAME_STATE_FPS: 'game_state_fps', // Full or delta game state update
    HIT_CONFIRMED_FPS: 'hit_confirmed_fps', // Server confirms your shot hit someone
    PLAYER_DIED_FPS: 'player_died_fps', // Announces a player death
    GRENADE_EXPLODED_FPS: 'grenade_exploded_fps', // Announces grenade detonation location/type
    ABILITY_USED_FPS: 'ability_used_fps', // Announces ability activation by a player
    GRAPPLE_STATE_UPDATE_FPS: 'grapple_state_update_fps', // Specific updates for grapple visuals/physics hints
    // ... other specific events like reload completion, flash effect start/end
};