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
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.physicsWorld = exports.mapMaterial = exports.playerMaterial = exports.GRAVITY = void 0;
exports.loadMapGeometry = loadMapGeometry;
const CANNON = __importStar(require("cannon-es"));
const gltf_1 = require("@loaders.gl/gltf");
const core_1 = require("@loaders.gl/core");
const path_1 = __importDefault(require("path"));
const promises_1 = __importDefault(require("fs/promises"));
// --- Physics Constants ---
exports.GRAVITY = new CANNON.Vec3(0, -9.82, 0);
// --- Materials ---
exports.playerMaterial = new CANNON.Material("playerMaterial");
exports.mapMaterial = new CANNON.Material("mapMaterial");
// --- Physics World Setup ---
exports.physicsWorld = new CANNON.World({
    gravity: exports.GRAVITY,
});
// --- Contact Materials Setup ---
function setupContactMaterials(world) {
    // Player <-> Map Interaction
    const mapPlayerContactMaterial = new CANNON.ContactMaterial(exports.mapMaterial, exports.playerMaterial, {
        friction: 0.1, // Low friction
        restitution: 0.1, // Low bounciness
    });
    world.addContactMaterial(mapPlayerContactMaterial);
    // Add other contact materials if needed (e.g., player <-> player)
}
setupContactMaterials(exports.physicsWorld);
// --- Map Loading --- 
function loadMapGeometry(world) {
    return __awaiter(this, void 0, void 0, function* () {
        // IMPORTANT: Ensure this path is correct relative to the built output (e.g., dist/)
        // Let's construct the path relative to the project root for more robustness
        // Assuming the server process runs from the monorepo root or has access relative to it.
        // If running from packages/server/dist, adjust accordingly.
        const mapPath = path_1.default.resolve(__dirname, './maps/lowpoly__fps__tdm__game__map.glb');
        console.log(`[Physics] Attempting to load map geometry from: ${mapPath}`);
        // Check existence using fs.promises.access
        try {
            yield promises_1.default.access(mapPath); // Check if file exists and is accessible
        }
        catch (accessError) {
            console.error(`[Physics] Map file not found or inaccessible at ${mapPath}. Adding default ground plane. Error:`, accessError);
            addDefaultGroundPlane(world);
            return;
        }
        try {
            // 1. Read the file content as a Buffer
            const fileBuffer = yield promises_1.default.readFile(mapPath);
            // 2. Convert Node.js Buffer to ArrayBuffer
            // Create an ArrayBuffer with the same size as the Buffer
            const arrayBuffer = new ArrayBuffer(fileBuffer.length);
            // Create a Uint8Array view of the ArrayBuffer
            const uint8Array = new Uint8Array(arrayBuffer);
            // Copy the data from the Buffer into the Uint8Array
            fileBuffer.copy(uint8Array);
            console.log(`[Physics] Read map file successfully (${(arrayBuffer.byteLength / 1024 / 1024).toFixed(2)} MB). Parsing GLTF...`);
            // 3. Parse the ArrayBuffer using the GLTFLoader
            const gltf = yield (0, core_1.parse)(arrayBuffer, gltf_1.GLTFLoader, { gltf: { loadBuffers: true } }); // Ensure buffers are loaded during parse
            const { json: gltfJson, buffers: gltfBuffers, images: gltfImages } = gltf; // Destructure for clarity
            // More robust validation check
            console.log("[Physics Debug] Checking GLTF properties:");
            const hasJson = !!gltfJson;
            console.log(`  gltf exists: ${!!gltf}`);
            console.log(`  gltf.json exists: ${hasJson}`);
            // Explicitly check for presence and type for scene index
            const hasSceneIndex = hasJson && typeof gltfJson.scene === 'number' && gltfJson.scene >= 0;
            console.log(`  gltf.json.scene is valid index: ${hasSceneIndex}`);
            const hasScenesArray = hasJson && Array.isArray(gltfJson.scenes);
            console.log(`  gltf.json.scenes exists: ${hasScenesArray}`);
            const hasNodesArray = hasJson && Array.isArray(gltfJson.nodes);
            console.log(`  gltf.json.nodes exists: ${hasNodesArray}`);
            const hasMeshesArray = hasJson && Array.isArray(gltfJson.meshes);
            console.log(`  gltf.json.meshes exists: ${hasMeshesArray}`);
            const hasAccessorsArray = hasJson && Array.isArray(gltfJson.accessors);
            console.log(`  gltf.json.accessors exists: ${hasAccessorsArray}`);
            const hasBufferViewsArray = hasJson && Array.isArray(gltfJson.bufferViews);
            console.log(`  gltf.json.bufferViews exists: ${hasBufferViewsArray}`);
            // Note: gltf.buffers is checked separately now via gltfBuffers
            console.log("Loaded GLTF structure:", Object.keys(gltf || {}));
            console.log("Loaded GLTF JSON structure:", Object.keys(gltfJson || {}));
            // Check if all essential components are present before proceeding
            if (!hasJson || !hasSceneIndex || !hasScenesArray || !hasNodesArray || !hasMeshesArray || !hasAccessorsArray || !hasBufferViewsArray || !gltfBuffers) {
                const missing = [
                    !hasJson && "'json' object",
                    !hasSceneIndex && "'json.scene' (valid index)",
                    !hasScenesArray && "'json.scenes' array",
                    !hasNodesArray && "'json.nodes' array",
                    !hasMeshesArray && "'json.meshes' array",
                    !hasAccessorsArray && "'json.accessors' array",
                    !hasBufferViewsArray && "'json.bufferViews' array",
                    !gltfBuffers && "'buffers' data"
                ].filter(Boolean).join(', ');
                throw new Error(`Loaded GLTF data structure is missing essential properties: ${missing}. Cannot process map geometry.`);
            }
            console.log("[Physics] GLTF structure validated. Proceeding with mesh extraction...");
            let foundPrimitive = null;
            let foundVerticesData = null;
            let foundIndicesData = null;
            function findMeshRecursive(nodeIndex) {
                var _a;
                if (foundPrimitive)
                    return;
                // Access nodes via gltfJson
                const node = gltfJson.nodes[nodeIndex];
                if ((node === null || node === void 0 ? void 0 : node.mesh) !== undefined) {
                    // Access meshes via gltfJson
                    const mesh = gltfJson.meshes[node.mesh];
                    if (mesh === null || mesh === void 0 ? void 0 : mesh.primitives) {
                        // Add explicit type for 'p'
                        const primitive = mesh.primitives.find((p) => {
                            var _a;
                            return typeof ((_a = p.attributes) === null || _a === void 0 ? void 0 : _a.POSITION) === 'number' &&
                                (p.indices === undefined || typeof p.indices === 'number');
                        });
                        if (primitive && typeof ((_a = primitive.attributes) === null || _a === void 0 ? void 0 : _a.POSITION) === 'number') {
                            const positionAccessorIndex = primitive.attributes.POSITION;
                            // Access accessors via gltfJson
                            const positionAccessor = gltfJson.accessors[positionAccessorIndex];
                            const indicesAccessorIndex = primitive.indices;
                            const hasValidIndices = typeof indicesAccessorIndex === 'number';
                            // Access accessors via gltfJson
                            let indicesAccessor = hasValidIndices ? gltfJson.accessors[indicesAccessorIndex] : null;
                            if (positionAccessor && (!primitive.indices || indicesAccessor)) {
                                const getTypedArrayFromAccessor = (accessor) => {
                                    if (!accessor || accessor.bufferView === undefined)
                                        return null;
                                    // Access bufferViews via gltfJson
                                    const bufferView = gltfJson.bufferViews[accessor.bufferView];
                                    if (!bufferView || bufferView.buffer === undefined)
                                        return null;
                                    // Access buffers via top-level gltfBuffers
                                    const buffer = gltfBuffers[bufferView.buffer];
                                    // Check buffer.data or buffer.buffer depending on loader version
                                    const bufferData = buffer === null || buffer === void 0 ? void 0 : buffer.arrayBuffer; // Access the actual ArrayBuffer
                                    if (!bufferData || !(bufferData instanceof ArrayBuffer)) { // Ensure it's an ArrayBuffer
                                        console.error("[Physics] Buffer data is missing or not an ArrayBuffer. Expected buffer.arrayBuffer.", buffer);
                                        return null;
                                    }
                                    const byteOffset = (bufferView.byteOffset || 0) + (accessor.byteOffset || 0);
                                    const componentType = accessor.componentType;
                                    const count = accessor.count;
                                    const type = accessor.type;
                                    let elementSize;
                                    switch (type) {
                                        case 'SCALAR':
                                            elementSize = 1;
                                            break;
                                        case 'VEC2':
                                            elementSize = 2;
                                            break;
                                        case 'VEC3':
                                            elementSize = 3;
                                            break;
                                        case 'VEC4':
                                            elementSize = 4;
                                            break;
                                        default:
                                            console.warn("[Physics] Unsupported accessor type:", type);
                                            return null;
                                    }
                                    const totalComponents = count * elementSize;
                                    let byteLength;
                                    switch (componentType) {
                                        case 5126: // FLOAT
                                            byteLength = totalComponents * 4;
                                            if (byteOffset + byteLength > bufferData.byteLength) {
                                                console.error(`[Physics] Float32Array bounds error: offset ${byteOffset} + length ${byteLength} > buffer size ${bufferData.byteLength}`);
                                                return null;
                                            }
                                            return new Float32Array(bufferData, byteOffset, totalComponents);
                                        case 5123: // UNSIGNED_SHORT
                                            byteLength = totalComponents * 2;
                                            if (byteOffset + byteLength > bufferData.byteLength) {
                                                console.error(`[Physics] Uint16Array bounds error: offset ${byteOffset} + length ${byteLength} > buffer size ${bufferData.byteLength}`);
                                                return null;
                                            }
                                            return new Uint16Array(bufferData, byteOffset, totalComponents);
                                        case 5125: // UNSIGNED_INT
                                            byteLength = totalComponents * 4;
                                            if (byteOffset + byteLength > bufferData.byteLength) {
                                                console.error(`[Physics] Uint32Array bounds error: offset ${byteOffset} + length ${byteLength} > buffer size ${bufferData.byteLength}`);
                                                return null;
                                            }
                                            return new Uint32Array(bufferData, byteOffset, totalComponents);
                                        default:
                                            console.warn("[Physics] Unsupported component type:", componentType);
                                            return null;
                                    }
                                };
                                const verticesArray = getTypedArrayFromAccessor(positionAccessor);
                                const indicesArray = indicesAccessor ? getTypedArrayFromAccessor(indicesAccessor) : null;
                                // Validate that we got the expected types
                                if (verticesArray instanceof Float32Array && (!indicesAccessor || indicesArray instanceof Uint16Array || indicesArray instanceof Uint32Array)) {
                                    foundPrimitive = primitive; // Keep track of the primitive itself if needed elsewhere
                                    foundVerticesData = verticesArray;
                                    // Assign indices ONLY if they exist AND are the correct type (Uint16/32)
                                    if (indicesArray instanceof Uint16Array || indicesArray instanceof Uint32Array) {
                                        foundIndicesData = indicesArray;
                                        return; // Found valid indexed geometry, stop searching
                                    }
                                    else {
                                        // Handle non-indexed geometry or cases where indicesArray was null/unexpected type
                                        console.warn("[Physics] Found geometry primitive without indices. CANNON.Trimesh requires indices.");
                                        // Clear the potentially found data if we require indexed meshes only.
                                        foundPrimitive = null;
                                        foundVerticesData = null;
                                        // Continue searching...
                                    }
                                }
                                else {
                                    console.warn("[Physics] Skipping primitive due to unexpected data types after accessor lookup.");
                                }
                            }
                        }
                    }
                }
                if (node === null || node === void 0 ? void 0 : node.children) {
                    for (const childIndex of node.children) {
                        findMeshRecursive(childIndex);
                    }
                }
            }
            // Access scene and nodes via gltfJson
            const scene = gltfJson.scenes[gltfJson.scene];
            if (scene === null || scene === void 0 ? void 0 : scene.nodes) {
                for (const rootNodeIndex of scene.nodes) {
                    findMeshRecursive(rootNodeIndex);
                    if (foundPrimitive)
                        break;
                }
            }
            // We now require indexed geometry because CANNON.Trimesh needs indices.
            if (!foundPrimitive || !foundVerticesData || !foundIndicesData) {
                throw new Error("Could not find a suitable *indexed* mesh primitive with POSITION (Float32Array) and indices (Uint16Array or Uint32Array) attribute in the GLTF scene graph after resolving accessors.");
            }
            // If the code reaches here, the checks passed, and the data is guaranteed non-null.
            console.log(`[Physics] Found indexed mesh primitive with ${foundVerticesData.length / 3} vertices and ${foundIndicesData.length / 3} faces.`);
            const cannonVertices = Array.from(foundVerticesData);
            const cannonIndices = Array.from(foundIndicesData);
            const mapShape = new CANNON.Trimesh(cannonVertices, cannonIndices);
            const mapBody = new CANNON.Body({
                mass: 0, // Static
                shape: mapShape,
                material: exports.mapMaterial,
            });
            world.addBody(mapBody);
            console.log("[Physics] Successfully added map Trimesh body to the physics world.");
        }
        catch (error) {
            console.error("[Physics] Error loading or processing map geometry:", error);
            addDefaultGroundPlane(world);
        }
    });
}
function addDefaultGroundPlane(world) {
    const groundShape = new CANNON.Plane();
    const groundBody = new CANNON.Body({ mass: 0, shape: groundShape, material: exports.mapMaterial });
    groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    world.addBody(groundBody);
    console.log('[Physics] Added default ground plane as fallback.');
}
