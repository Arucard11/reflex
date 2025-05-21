const THREE = require('three');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

// Mocks for Three.js JSM modules in Node.js
global.window = { document: { createElementNS: () => { return {} } } };
global.document = { createElement: () => ({ getContext: () => ({}) }) };
global.Image = function() {};
global.self = global;

// Enhanced FileReader Mock
global.FileReader = class FileReader {
    constructor() {
        this.listeners = {};
        this.readyState = 0; // EMPTY
        this.result = null;
        this.error = null;
    }
    addEventListener(type, listener) {
        this.listeners[type] = this.listeners[type] || [];
        this.listeners[type].push(listener);
    }
    removeEventListener(type, listener) { 
        if (this.listeners[type]) {
            const index = this.listeners[type].indexOf(listener);
            if (index !== -1) this.listeners[type].splice(index, 1);
        }
    }
    dispatchEvent(event) {
        const eventType = event.type;
        if (this.listeners[eventType]) {
            this.listeners[eventType].forEach(listener => listener.call(this, event));
        }
        if (typeof this[`on${eventType}`] === 'function') {
            this[`on${eventType}`].call(this, event);
        }
    }
    _finish(result, error) {
        this.readyState = 2; // DONE
        if (error) {
            this.error = error;
            this.dispatchEvent({ type: 'error', error: error, target: this });
        } else {
            this.result = result;
            this.dispatchEvent({ type: 'load', target: this });
        }
        this.dispatchEvent({ type: 'loadend', target: this });
    }
    readAsArrayBuffer(blob) {
        this.readyState = 1; // LOADING
        if (blob instanceof ArrayBuffer) {
            setTimeout(() => this._finish(blob), 1);
        } else if (blob && typeof blob.arrayBuffer === 'function') {
            blob.arrayBuffer()
                .then(buffer => this._finish(buffer))
                .catch(err => this._finish(null, err));
        } else {
            setTimeout(() => this._finish(null, new Error('FileReader: readAsArrayBuffer expects Blob or ArrayBuffer')), 1);
        }
    }
    readAsDataURL(blob) {
        this.readyState = 1; // LOADING
        try {
            let inputBuffer;
            if (blob instanceof ArrayBuffer) {
                inputBuffer = blob;
            } else if (blob && typeof blob.arrayBuffer === 'function') {
                throw new Error('FileReader mock: readAsDataURL with a complex Blob needs a more advanced mock or direct ArrayBuffer input.');
            } else {
                 throw new Error("FileReader: readAsDataURL expects ArrayBuffer or Blob-like object with arrayBuffer method.");
            }
            const base64 = Buffer.from(inputBuffer).toString('base64');
            setTimeout(() => this._finish('data:application/octet-stream;base64,' + base64), 1);
        } catch (e) {
            setTimeout(() => this._finish(null, e), 1);
        }
    }
    abort() {
        this.readyState = 2; // DONE
        this.error = new Error('Aborted'); // DOMException
        this.dispatchEvent({ type: 'abort', target: this });
        this.dispatchEvent({ type: 'loadend', target: this });
    }
};

// --- Module Variables --- 
let GLTFLoader, GLTFExporter, AnimationUtils; // For Three.js
let NodeIO_gltf, Document_gltf; // For gltf-transform

// --- Load Three.js Modules --- 
async function loadThreeJSModules() {
    const threeExamplesPath = path.join(require.resolve('three'), '..', '..', 'examples', 'jsm');
    const gltfLoaderPath = path.join(threeExamplesPath, 'loaders', 'GLTFLoader.js');
    const gltfExporterPath = path.join(threeExamplesPath, 'exporters', 'GLTFExporter.js');
    GLTFLoader = (await import(pathToFileURL(gltfLoaderPath).href)).GLTFLoader;
    GLTFExporter = (await import(pathToFileURL(gltfExporterPath).href)).GLTFExporter;
    AnimationUtils = THREE.AnimationUtils;
    console.log('Three.js modules loaded.');
}

// --- Load glTF-Transform Modules --- 
async function loadGLTFTransformModules() {
    // Corrected import for NodeIO from @gltf-transform/core
    // Document is also from @gltf-transform/core
    const gltfTransformCore = await import('@gltf-transform/core');
    NodeIO_gltf = gltfTransformCore.NodeIO;
    Document_gltf = gltfTransformCore.Document;
    console.log('glTF-Transform modules loaded.');
    if (!NodeIO_gltf) {
        console.error('Failed to load NodeIO from @gltf-transform/core. Ensure @gltf-transform/core is installed correctly.');
        throw new Error('NodeIO not loaded');
    }
}

// --- Helper: Get Extension from MimeType ---
function getExtensionFromMimeType(mimeType) {
    if (!mimeType) return 'bin'; // Default extension
    switch (mimeType.toLowerCase()) {
        case 'image/png': return 'png';
        case 'image/jpeg':
        case 'image/jpg': return 'jpg';
        case 'image/webp': return 'webp';
        case 'image/gif': return 'gif';
        // Add more mappings if needed
        default:
            console.warn(`Unsupported MIME type for extension: ${mimeType}, using .bin`);
            return 'bin';
    }
}

// --- Configuration ---
const inputFile = path.resolve(__dirname, './apps/web/public/assets/fps_1v1/models/gun_carbine.glb');
const intermediateOutputFile = path.resolve(__dirname, './apps/web/public/assets/fps_1v1/models/gun_carbine_anim_only.glb');
const finalOutputFile = path.resolve(__dirname, './apps/web/public/assets/fps_1v1/models/gun_carbine_final.glb');
const texturesInputDirectory = path.resolve(__dirname, './apps/web/public/assets/fps_1v1/textures/');

const FPS = 24;
const animationSegments = [
    { name: 'shoot', startSeconds: 0.00, endSeconds: 0.18 },
    { name: 'reload', startSeconds: 0.23, endSeconds: 3.23 },
    { name: 'idle', startSeconds: 6.63, endSeconds: 7.35 },
    { name: 'melee', startSeconds: 7.35, endSeconds: 8.10 }
];

// --- Part 1 & 2: Animation Processing (Three.js) ---
async function processAnimationsWithThreeJS() {
    console.log("--- Starting Animation Processing (Three.js) ---");
    console.log(`Loading GLB for animation processing: ${inputFile}`);
        const glbData = fs.readFileSync(inputFile);
        const loader = new GLTFLoader();
        const gltf = await new Promise((resolve, reject) => {
            loader.parse(glbData.buffer.slice(glbData.byteOffset, glbData.byteOffset + glbData.byteLength), '', resolve, reject);
        });
    console.log('GLB loaded successfully for animation processing.');

    if (!gltf.animations || gltf.animations.length === 0) throw new Error('No animations found in the input GLB file.');
        const sourceClip = gltf.animations[0];
    if (!sourceClip) throw new Error('Source animation clip not found in the input GLB.');
        console.log(`Source animation: "${sourceClip.name}", Duration: ${sourceClip.duration.toFixed(2)}s, Tracks: ${sourceClip.tracks.length}`);

        const newAnimations = [];
        for (const segment of animationSegments) {
            const startFrame = Math.round(segment.startSeconds * FPS);
            const endFrame = Math.round(segment.endSeconds * FPS);
            console.log(`Creating subclip: "${segment.name}" from ${segment.startSeconds.toFixed(2)}s (frame ${startFrame}) to ${segment.endSeconds.toFixed(2)}s (frame ${endFrame})`);
            if (startFrame >= Math.round(sourceClip.duration * FPS) || endFrame > Math.round(sourceClip.duration * FPS) || startFrame >= endFrame) {
            console.warn(`Segment "${segment.name}" has invalid frame times. Skipping.`); continue;
            }
            const subClip = AnimationUtils.subclip(sourceClip, segment.name, startFrame, endFrame, FPS);
            if (subClip && subClip.tracks.length > 0) {
                newAnimations.push(subClip);
            console.log(`  Created "${subClip.name}" (Three.js clip) with duration ${subClip.duration.toFixed(2)}s, Tracks: ${subClip.tracks.length}`);
            } else {
            console.warn(`  Failed to create subclip "${segment.name}".`);
        }
        }
    if (newAnimations.length === 0) throw new Error('No new animations were successfully created by Three.js.');
        
    console.log(`Exporting GLB with ${newAnimations.length} new animations (Three.js) to intermediate file: ${intermediateOutputFile}`);
    console.log('\n=== Starting Three.js Export ===');
        const exporter = new GLTFExporter();
    console.log('Three.js Exporter created');

    const exportPromise = new Promise((resolve, reject) => {
        console.log('Beginning Three.js exporter.parse() call...');
            exporter.parse(
            gltf.scene, // Export the original scene graph
            (result) => {
                console.log('Three.js Exporter.parse - onDone callback triggered.');
                if (result instanceof ArrayBuffer) {
                    console.log('Three.js Export: ArrayBuffer received, length:', result.byteLength);
                    resolve(result);
                } else {
                    reject(new Error(`Three.js Export: Unexpected result type: ${typeof result}`));
                }
            },
            (error) => {
                console.error('Three.js Exporter.parse - onError callback triggered:', error);
                reject(error);
            },
            { animations: newAnimations, binary: true, trs: true }
        );
        console.log('... Three.js exporter.parse() call made (async operation pending).');
    });

    const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Three.js Exporter promise timed out after 30 seconds')), 30000);
    });

    let exportResult;
    try {
        exportResult = await Promise.race([exportPromise, timeoutPromise]);
    } catch (e) {
        console.error('Error during Three.js export Promise.race:', e);
        throw e; 
    }

    if (!exportResult || !(exportResult instanceof ArrayBuffer)) throw new Error('Three.js export result is not a valid ArrayBuffer.');
    if (exportResult.byteLength < 100) throw new Error('Error: Three.js exported ArrayBuffer is too small for a valid GLB.');
    
    fs.writeFileSync(intermediateOutputFile, Buffer.from(exportResult));
    console.log(`Intermediate GLB with processed animations saved to: ${intermediateOutputFile}`);
    console.log("--- Finished Animation Processing (Three.js) ---");
}

// --- NEW: Part 0: Extract and Save Textures (glTF-Transform) ---
async function extractAndSaveTextures(sourceGlbPath, outputDir) {
    console.log("\n--- Starting Texture Extraction (glTF-Transform) ---");
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
        console.log(`Created texture output directory: ${outputDir}`);
    } else {
        console.log(`Texture output directory already exists: ${outputDir}`);
    }

    const io = new NodeIO_gltf();
    const doc = await io.read(sourceGlbPath);
    const root = doc.getRoot();
    const materials = root.listMaterials();
    let texturesExtractedCount = 0;

    console.log(`Found ${materials.length} material(s) in the source GLB: ${sourceGlbPath}`);

    for (const material of materials) {
        const materialName = material.getName() || `material${materials.indexOf(material)}`;
        console.log(`  Processing material for texture extraction: "${materialName}"`);

        // Define texture slots and their corresponding getter methods and filename parts
        const textureSlotMappings = {
            baseColor: { getter: material.getBaseColorTexture, name: 'basecolor' },
            normal: { getter: material.getNormalTexture, name: 'normal' },
            metallicRoughness: { getter: material.getMetallicRoughnessTexture, name: 'metallicroughness' },
            occlusion: { getter: material.getOcclusionTexture, name: 'occlusion' },
            emissive: { getter: material.getEmissiveTexture, name: 'emissive' },
        };

        for (const slotKey in textureSlotMappings) {
            const mapping = textureSlotMappings[slotKey];
            const texture = mapping.getter.call(material); // Call the getter method
            const slotFilenamePart = mapping.name;

            if (texture) {
                const imageData = texture.getImage(); // This is Uint8Array
                if (imageData && imageData.byteLength > 0) {
                    const mimeType = texture.getMimeType() || 'image/png'; // Default to png if not set
                    const extension = getExtensionFromMimeType(mimeType);
                    const textureFilename = `${materialName}_${slotFilenamePart}.${extension}`;
                    const outputPath = path.join(outputDir, textureFilename);
                    try {
                        fs.writeFileSync(outputPath, Buffer.from(imageData));
                        console.log(`    Extracted and saved: ${textureFilename} (MIME: ${mimeType}, Size: ${imageData.byteLength} bytes)`);
                        texturesExtractedCount++;
                    } catch (e) {
                        console.error(`    Error saving texture ${textureFilename}:`, e);
                    }
                } else {
                    console.warn(`    Texture in slot '${slotKey}' for material '${materialName}' has no image data or is empty.`);
                }
            }
        }
    }

    if (texturesExtractedCount > 0) {
        console.log(`${texturesExtractedCount} texture(s) extracted to: ${outputDir}`);
    } else {
        console.warn(`No textures were extracted. Ensure the source GLB has embedded textures, or check material and texture setup.`);
    }
    console.log("--- Finished Texture Extraction (glTF-Transform) ---");
}

// --- Part 3 & 4: Reapply Textures (glTF-Transform) & Save Final ---
async function reapplyTexturesAndSaveFinal() {
    console.log("\n--- Starting Texture Reapplication (glTF-Transform) ---");
    const io = new NodeIO_gltf();
    const doc = await io.read(intermediateOutputFile); // Read the model with new animations

    console.log(`Loaded intermediate file for texturing: ${intermediateOutputFile}`);
    console.log(`Expecting textures in: ${texturesInputDirectory}`);

    if (!fs.existsSync(texturesInputDirectory)) {
        console.warn(`Texture directory NOT FOUND: ${texturesInputDirectory}`);
        console.warn("Please create this directory and place your model's texture files (e.g., gun_carbine_basecolor.png) in it.");
        console.warn("Skipping texture reapplication.");
    } else {
        const materials = doc.getRoot().listMaterials();
        if (materials.length === 0) {
            console.warn('No materials found in the model. Cannot apply textures.');
        } else {
            console.log(`Found ${materials.length} material(s) in the model.`);
            // --- USER CUSTOMIZATION REQUIRED FOR TEXTURE MAPPING --- 
            // This is a very basic example. You need to map your specific texture files 
            // to the correct materials and texture slots (baseColor, normal, metallicRoughness, etc.)
            // You might iterate `materials` and apply textures based on material name or properties.

            for (const material of materials) {
                const materialName = material.getName();
                console.log(`Processing material: "${materialName || 'Unnamed Material'}"`);

                // Example for Base Color Texture
                // TRY TO GUESS FILENAME or use a predefined map
                // For this example, let's assume a simple naming convention or a specific file for the first material
                let baseColorTexturePath = path.join(texturesInputDirectory, `${materialName}_basecolor.png`);
                if (material === materials[0] && !fs.existsSync(baseColorTexturePath)) { // Fallback for first material example
                    baseColorTexturePath = path.join(texturesInputDirectory, 'gun_carbine_basecolor.png');
                }

                if (fs.existsSync(baseColorTexturePath)) {
                    try {
                        const imageBuffer = fs.readFileSync(baseColorTexturePath);
                        const texture = doc.createTexture(materialName + '_BaseColor')
                                         .setImage(imageBuffer) // setImage expects Uint8Array
                                         .setMimeType('image/png'); // Or image/jpeg
                        material.setBaseColorTexture(texture);
                        console.log(`  Applied BaseColor: ${baseColorTexturePath}`);
                    } catch (e) {
                        console.error(`  Error applying base color texture ${baseColorTexturePath} to material ${materialName}:`, e);
                    }
                } else {
                    console.warn(`  BaseColor texture not found for material "${materialName}": ${baseColorTexturePath}`);
                }

                // Example for Normal Texture
                let normalTexturePath = path.join(texturesInputDirectory, `${materialName}_normal.png`);
                if (material === materials[0] && !fs.existsSync(normalTexturePath)) { // Fallback for first material example
                    normalTexturePath = path.join(texturesInputDirectory, 'gun_carbine_normal.png');
                }
                if (fs.existsSync(normalTexturePath)) {
                    try {
                        const imageBuffer = fs.readFileSync(normalTexturePath);
                        const texture = doc.createTexture(materialName + '_Normal')
                                         .setImage(imageBuffer)
                                         .setMimeType('image/png');
                        material.setNormalTexture(texture);
                        // material.setNormalScale(1.0); // Set if needed
                        console.log(`  Applied Normal: ${normalTexturePath}`);
                    } catch (e) {
                        console.error(`  Error applying normal texture ${normalTexturePath} to material ${materialName}:`, e);
                    }
                } else {
                    console.warn(`  Normal texture not found for material "${materialName}": ${normalTexturePath}`);
                }
                
                // Add similar blocks for MetallicRoughness, Occlusion, Emissive textures
                // e.g., material.setMetallicRoughnessTexture(texture);
                // e.g., material.setOcclusionTexture(texture);
                // e.g., material.setEmissiveTexture(texture);
            }
            // --- END USER CUSTOMIZATION --- 
        }
    }

    await io.write(finalOutputFile, doc);
    console.log(`Final model with (attempted) reapplied textures saved to: ${finalOutputFile}`);
    console.log("--- Finished Texture Reapplication (glTF-Transform) ---");
}

// --- Main Execution Function ---
async function main() {
    try {
        await loadThreeJSModules();
        await loadGLTFTransformModules();

        // NEW: Call texture extraction before animation processing
        // This will populate texturesInputDirectory if textures are embedded in inputFile
        await extractAndSaveTextures(inputFile, texturesInputDirectory);

        await processAnimationsWithThreeJS();
        await reapplyTexturesAndSaveFinal();

        console.log("\n✅ Script finished successfully!");
        console.log(`Final model saved to: ${finalOutputFile}`);
        console.log("Don't forget to customize texture mapping in reapplyTexturesAndSaveFinal function if needed.");

    } catch (error) {
        console.error("Error in main script execution:", error);
        process.exitCode = 1; // Indicate failure
    } finally {
        // Clean up Three.js mocks
        delete global.window;
        delete global.document;
        delete global.Image;
        delete global.self;
        delete global.FileReader;
        console.log("Cleaned up global mocks.");
    }
}

main();
