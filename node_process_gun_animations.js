const THREE = require('three');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url'); // Import pathToFileURL

// gltf-transform imports
const { NodeIO } = require('@gltf-transform/core');

// Required for GLTFLoader in Node.js if not using a specific Node loader
global.window = { document: { createElementNS: () => { return {} } } }; // Mock for loader
global.document = { createElement: () => ({ getContext: () => ({}) }) }; // Mock for loader
global.Image = function() {}; // Mock for TextureLoader used by GLTFLoader
global.self = global; // Add this line to define self

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
                // This is a simplification. A full Blob-to-DataURL would be more complex.
                // Forcing an error if it's not a direct ArrayBuffer to keep mock simple.
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

// Dynamically import JSM modules
let GLTFLoader, AnimationUtils;

async function loadThreeJSModules() {
    const threeExamplesPath = path.join(require.resolve('three'), '..', '..', 'examples', 'jsm');
    
    // Convert paths to file URLs before importing
    const gltfLoaderPath = path.join(threeExamplesPath, 'loaders', 'GLTFLoader.js');

    // Use .href to get the string URL
    GLTFLoader = (await import(pathToFileURL(gltfLoaderPath).href)).GLTFLoader;
    AnimationUtils = THREE.AnimationUtils; // It's part of THREE.AnimationUtils directly
}


// --- Configuration ---
// Assuming the script is run from the root of your "Gladiator" workspace
const inputFile = path.resolve(__dirname, './apps/web/public/assets/fps_1v1/models/gun_carbine.glb');
const outputFile = path.resolve(__dirname, './apps/web/public/assets/fps_1v1/models/gun_carbine_textured_anims.glb'); // Save to a new file to be safe

const FPS = 24;

const animationSegments = [
    { name: 'shoot', startSeconds: 0.00, endSeconds: 0.18 },
    { name: 'reload', startSeconds: 0.23, endSeconds: 3.23 },
    { name: 'idle', startSeconds: 6.63, endSeconds: 7.35 },
    { name: 'melee', startSeconds: 7.35, endSeconds: 8.10 }
];

// --- Main Processing Function ---
async function processAnimationsWithGltfTransform() {
    try {
        await loadThreeJSModules(); // Load Three.js modules for sub-clipping

        // Step 1 & 2: Load with Three.js and create sub-clips
        console.log(`Loading GLB with Three.js for animation processing: ${inputFile}`);
        const glbDataThree = fs.readFileSync(inputFile);
        const threeLoader = new GLTFLoader();
        const threeGltf = await new Promise((resolve, reject) => {
            threeLoader.parse(glbDataThree.buffer.slice(glbDataThree.byteOffset, glbDataThree.byteOffset + glbDataThree.byteLength), '', resolve, reject);
        });
        console.log('Three.js GLB loaded successfully.');

        if (!threeGltf.animations || threeGltf.animations.length === 0) {
            console.error('No animations found by Three.js loader.'); return;
        }
        const sourceClipThree = threeGltf.animations[0]; // Assuming the main animation is the first
        console.log(`Source Three.js animation: "${sourceClipThree.name}", Duration: ${sourceClipThree.duration.toFixed(2)}s`);

        const newThreeJSClips = [];
        for (const segment of animationSegments) {
            const startFrame = Math.round(segment.startSeconds * FPS);
            const endFrame = Math.round(segment.endSeconds * FPS);
            const subClip = AnimationUtils.subclip(sourceClipThree, segment.name, startFrame, endFrame, FPS);
            if (subClip && subClip.tracks.length > 0) {
                newThreeJSClips.push(subClip);
                console.log(`  Created Three.js subclip: "${subClip.name}", Duration: ${subClip.duration.toFixed(2)}s`);
            }
        }
        if (newThreeJSClips.length === 0) {
            console.error('No new Three.js subclips created.'); return;
        }

        // Step 3: Load the original GLB with gltf-transform to preserve everything (textures, materials, scene)
        console.log(`\nLoading GLB with gltf-transform for final assembly: ${inputFile}`);
        const io = new NodeIO();
        const document = await io.read(inputFile); // Reads into gltf-transform's Document model
        const root = document.getRoot();
        console.log('gltf-transform Document loaded successfully.');

        // Step 4: Clear existing animations from the gltf-transform document (optional, but good practice)
        const existingAnimations = root.listAnimations();
        if (existingAnimations.length > 0) {
            console.log(`Removing ${existingAnimations.length} existing animation(s) from gltf-transform document.`);
            existingAnimations.forEach(anim => anim.dispose());
        }
        
        // Step 5: Convert Three.js AnimationClips to gltf-transform Animations and add them
        console.log('Converting and adding new animations to gltf-transform document...');
        for (const threeClip of newThreeJSClips) {
            const newAnim = document.createAnimation(threeClip.name);

            for (const threeTrack of threeClip.tracks) {
                // Create Accessors for time and value - this is the core conversion
                const timesAccessor = document.createAccessor(threeTrack.name + '.times')
                    .setArray(threeTrack.times) // Float32Array
                    .setType('SCALAR');

                const valuesAccessor = document.createAccessor(threeTrack.name + '.values')
                    .setArray(threeTrack.values); // Float32Array

                let accessorType;
                const valueSize = threeTrack.getValueSize(); // Method on KeyframeTrack

                if (threeTrack.ValueTypeName === 'quaternion') {
                    accessorType = 'VEC4'; // GLTF stores quaternions as VEC4
                } else if (threeTrack.ValueTypeName === 'vector') {
                    if (valueSize === 3) {
                        accessorType = 'VEC3';
                    } else if (valueSize === 2) {
                        accessorType = 'VEC2';
                    } else if (valueSize === 4) { // Could be other VEC4 data
                        accessorType = 'VEC4';
                    } else {
                        console.warn(`Unsupported valueSize ${valueSize} for 'vector' track: ${threeTrack.name}. Skipping track.`);
                        continue; // Skip this track if unsure
                    }
                } else if (threeTrack.ValueTypeName === 'number') {
                    accessorType = 'SCALAR';
                } else {
                    console.warn(`Unsupported ValueTypeName: ${threeTrack.ValueTypeName} for track ${threeTrack.name}. Skipping track.`);
                    continue; // Skip this track
                }
                valuesAccessor.setType(accessorType);

                // Create Sampler
                const sampler = document.createAnimationSampler(threeTrack.name + '.sampler')
                    .setInput(timesAccessor)
                    .setOutput(valuesAccessor);

                // Correctly set interpolation based on Three.js enum
                const threeInterpolationMode = threeTrack.getInterpolation();
                let gltfInterpolation = 'LINEAR'; // Default
                if (threeInterpolationMode === THREE.InterpolateDiscrete) {
                    gltfInterpolation = 'STEP'; // GLTF uses STEP for discrete
                } else if (threeInterpolationMode === THREE.InterpolateLinear) {
                    gltfInterpolation = 'LINEAR';
                } else if (threeInterpolationMode === THREE.InterpolateSmooth) {
                    gltfInterpolation = 'CUBICSPLINE';
                }
                sampler.setInterpolation(gltfInterpolation);

                // Create Channel - Target path needs to be resolved carefully
                // threeTrack.name is like "CharacterArmature.quaternion" or "mesh_0.position"
                // We need to find the gltf-transform Node that corresponds to this.
                // This requires a mapping or careful naming conventions.
                // For simplicity, this example assumes node names in GLTF match parts of track names.
                // This part is CRITICAL and might need adjustment based on your model structure.

                const [nodeName, propertyPath] = threeTrack.name.split('.');
                let targetNode = null;
                
                // Attempt to find the target node by name (simplistic approach)
                // A more robust approach might involve iterating and checking UUIDs if available from Three.js load,
                // or ensuring your Blender export names nodes clearly.
                for (const scene of root.listScenes()) {
                    scene.traverse((node) => {
                        if (node.getName() === nodeName) {
                            targetNode = node;
                        }
                    });
                    if (targetNode) break;
                }
                // If not found in scenes, check root nodes (e.g. if armature is a root node)
                if (!targetNode) {
                    root.listNodes().forEach(node => {
                        if (node.getName() === nodeName) {
                            targetNode = node;
                        }
                    });
                }


                if (targetNode && propertyPath) {
                    const channel = document.createAnimationChannel(threeTrack.name + '.channel')
                        .setSampler(sampler)
                        .setTargetNode(targetNode)
                        .setTargetPath(propertyPath.toLowerCase()); // 'translation', 'rotation', 'scale', 'weights'
                    newAnim.addChannel(channel).addSampler(sampler);
                } else {
                    console.warn(`  Could not find target node "${nodeName}" or valid path for track "${threeTrack.name}". Skipping this track.`);
                }
            }
            if (newAnim.listChannels().length === 0 && newAnim.listSamplers().length === 0 && threeClip.tracks.length > 0) {
                 console.warn(`Animation "${threeClip.name}" was created but ended up with no channels/samplers. Original track count: ${threeClip.tracks.length}. This often means target node names didn't match.`);
            } else if (newAnim.listChannels().length > 0) {
                console.log(`  Added animation "${newAnim.getName()}" to gltf-transform document with ${newAnim.listChannels().length} channels.`);
            }
        }
        
        // Step 6: Write with gltf-transform
        console.log(`\nWriting final GLB with textures and new animations to: ${outputFile}`);
        await io.write(outputFile, document);
        console.log('GLB successfully written with gltf-transform!');

        // Optional: Verification by reloading with gltf-transform
        console.log('\nVerifying animations in the gltf-transform saved GLB...');
        const verifiedDocument = await io.read(outputFile);
        const verifiedAnims = verifiedDocument.getRoot().listAnimations();
        if (verifiedAnims.length > 0) {
            console.log(`Found ${verifiedAnims.length} animation(s) in the saved file:`);
            verifiedAnims.forEach(anim => {
                const duration = मानविकी.getAnimationDuration(anim); // Helper to calculate duration
                console.log(`  - Name: "${anim.getName()}", Channels: ${anim.listChannels().length}, Duration: ~${duration ? duration.toFixed(2) : 'N/A'}s`);
            });
        } else {
            console.log('No animations found in the gltf-transform saved file.');
        }

    } catch (error) {
        console.error('Error in processAnimationsWithGltfTransform:', error);
    } finally {
        // Clean up Three.js mocks
        delete global.window; delete global.document; delete global.Image; delete global.self; delete global.FileReader;
    }
}

// Run the script
processAnimationsWithGltfTransform();

// Helper for gltf-transform animation duration (conceptual - actual calculation can be complex)
// For a more accurate duration, you'd find the max time in all input accessors of samplers.
const मानविकी = { // Renamed from 'anim' to avoid conflict
    getAnimationDuration: (gltfAnim) => {
        let maxTime = 0;
        for (const sampler of gltfAnim.listSamplers()) {
            const input = sampler.getInput();
            if (input) {
                for (let i = 0; i < input.getCount(); i++) {
                    maxTime = Math.max(maxTime, input.getElement(i, [])[0]);
                }
            }
        }
        return maxTime;
    }
};
