// Shim for browser environment
if (typeof self === 'undefined') {
  global.self = global;
}

// extract_map_data.js
const fs = require('fs');
const path = require('path');
const THREE = require('three');
// GLTFLoader will be imported dynamically

// --- Configuration ---
const mapsToProcess = [
    {
        name: 'map1',
        inputPath: path.resolve(__dirname, '../../../apps/web/public/assets/fps_1v1/models/map1.glb'), // Adjusted path relative to script
        outputPath: path.resolve(__dirname, 'map1_physics_data.js'),
        vertexVarName: 'map1Vertices',
        indexVarName: 'map1Indices',
    },
    {
        name: 'map2',
        inputPath: path.resolve(__dirname, '../../../apps/web/public/assets/fps_1v1/models/map2.glb'), // Adjusted path relative to script
        outputPath: path.resolve(__dirname, 'map2_physics_data.js'),
        vertexVarName: 'map2Vertices',
        indexVarName: 'map2Indices',
    },
    {
        name: 'map3',
        inputPath: path.resolve(__dirname, '../../../apps/web/public/assets/fps_1v1/models/map3.glb'), // Adjusted path relative to script
        outputPath: path.resolve(__dirname, 'map3_physics_data.js'),
        vertexVarName: 'map3Vertices',
        indexVarName: 'map3Indices',
    },
];
// --- End Configuration ---

// Wrap extraction logic in an async function to use dynamic import
async function extractMapData(mapConfig) {
    console.log(`\n--- Processing Map: ${mapConfig.name} ---`);
    const { inputPath, outputPath, vertexVarName, indexVarName } = mapConfig;

    // Dynamically import GLTFLoader
    let GLTFLoader;
    try {
        const loaderModule = await import('three/examples/jsm/loaders/GLTFLoader.js');
        GLTFLoader = loaderModule.GLTFLoader;
    } catch (err) {
        console.error("Error dynamically importing GLTFLoader:", err);
        return; // Cannot proceed without loader
    }

    // Check if file exists
    if (!fs.existsSync(inputPath)) {
        console.error(`Error: Map file not found for ${mapConfig.name} at path: ${inputPath}`);
        return; // Skip this map
    }

    console.log(`Loading GLB file from: ${inputPath}`);
    // Load GLB file data using Node.js fs
    const fileData = fs.readFileSync(inputPath);
    const arrayBuffer = fileData.buffer.slice(fileData.byteOffset, fileData.byteOffset + fileData.byteLength);

    // Use GLTFLoader to parse the loaded data
    const loader = new GLTFLoader();

    return new Promise((resolve, reject) => {
        loader.parse(
            arrayBuffer,
            '', // baseURL - not needed when data is provided
            (gltf) => {
                console.log(`GLTF loaded successfully for ${mapConfig.name}.`);

                let combinedVertices = [];
                let combinedIndices = [];
                let vertexOffset = 0;

                gltf.scene.traverse((child) => {
                    if (child.isMesh) {
                        // console.log(`Processing mesh: ${child.name}`); // Less verbose logging
                        const geometry = child.geometry;

                        if (!geometry.isBufferGeometry) {
                            console.warn(`Skipping non-BufferGeometry mesh: ${child.name}`);
                            return;
                        }

                        const positionAttribute = geometry.attributes.position;
                        const indexAttribute = geometry.index;

                        if (!positionAttribute) {
                            console.warn(`Skipping mesh without position attribute: ${child.name}`);
                            return;
                        }

                        child.updateMatrixWorld(true); // Ensure world matrix is updated
                        const vertices = [];
                        const tempVertex = new THREE.Vector3();
                        for (let i = 0; i < positionAttribute.count; i++) {
                            tempVertex.fromBufferAttribute(positionAttribute, i);
                            tempVertex.applyMatrix4(child.matrixWorld); // Apply transformation
                            vertices.push(tempVertex.x, tempVertex.y, tempVertex.z);
                        }
                        combinedVertices.push(...vertices);

                        if (indexAttribute) {
                            const indices = [];
                            for (let i = 0; i < indexAttribute.count; i++) {
                                indices.push(indexAttribute.getX(i) + vertexOffset);
                            }
                            combinedIndices.push(...indices);
                        } else {
                             console.warn(`Mesh ${child.name} has no index buffer. Generating indices assuming triangles.`);
                             const indices = [];
                            for (let i = 0; i < positionAttribute.count; i += 3) {
                                indices.push(i + vertexOffset, i + 1 + vertexOffset, i + 2 + vertexOffset);
                            }
                            combinedIndices.push(...indices);
                        }
                        vertexOffset += positionAttribute.count;
                    }
                });

                if (combinedVertices.length === 0) {
                    console.error(`Error: No suitable mesh geometry found in the GLB file for ${mapConfig.name}.`);
                    resolve(); // Resolve anyway to process next map
                    return;
                }

                console.log(`Extraction Summary for ${mapConfig.name}:`);
                console.log(` -> Total Vertices: ${combinedVertices.length / 3}`);
                console.log(` -> Total Triangles: ${combinedIndices.length / 3}`);

                // --- Format Output for File ---
                let fileContent = `// Physics data extracted from ${path.basename(inputPath)}\n`;
                fileContent += `// Total Vertices: ${combinedVertices.length / 3}\n`;
                fileContent += `// Total Triangles: ${combinedIndices.length / 3}\n\n`;

                fileContent += `export const ${vertexVarName} = [\n`;
                for (let i = 0; i < combinedVertices.length; i += 3) {
                    const x = combinedVertices[i].toFixed(4);
                    const y = combinedVertices[i + 1].toFixed(4);
                    const z = combinedVertices[i + 2].toFixed(4);
                    fileContent += `  ${x}, ${y}, ${z},${((i + 3) % 15 === 0 && i + 3 < combinedVertices.length) ? '\n' : ''}`;
                }
                fileContent += '\n];\n\n';

                fileContent += `export const ${indexVarName} = [\n`;
                for (let i = 0; i < combinedIndices.length; i += 3) {
                    const i1 = combinedIndices[i];
                    const i2 = combinedIndices[i + 1];
                    const i3 = combinedIndices[i + 2];
                    fileContent += `  ${i1}, ${i2}, ${i3},${((i + 3) % 15 === 0 && i + 3 < combinedIndices.length) ? '\n' : ''}`;
                }
                fileContent += '\n];\n';

                // --- Write to File ---
                try {
                    // IMPORTANT: Output file should be .js for easy import elsewhere
                    // Even though the script is .cjs, the output can be ES module format.
                    fs.writeFileSync(outputPath, fileContent);
                    console.log(`Successfully wrote physics data for ${mapConfig.name} to: ${outputPath}`);
                } catch (error) {
                    console.error(`Error writing physics data to file: ${outputPath}`, error);
                }
                resolve(); // Resolve after processing this map
            },
            (error) => {
                console.error(`Error parsing GLTF data for ${mapConfig.name}:`, error);
                reject(error); // Reject the promise on parsing error
            }
        );
    });
}

// --- Main Execution --- (Remains async)
async function processAllMaps() {
    console.log("Starting map data extraction process...");
    // Ensure three.js is installed locally for the script
    try {
        require.resolve('three');
    } catch (e) {
        console.error("Error: 'three' package not found. Please install it in 'packages/shared-types' (`pnpm add three --filter shared-types`) before running this script.");
        process.exit(1);
    }

    for (const mapConfig of mapsToProcess) {
        try {
            await extractMapData(mapConfig);
        } catch (error) {
             console.error(`Failed processing map ${mapConfig.name}. Moving to next map. Error:`, error);
        }
    }
    console.log("\nMap data extraction process finished.");
}

processAllMaps(); // Run the main function