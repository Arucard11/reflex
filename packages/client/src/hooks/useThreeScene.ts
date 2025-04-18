import { useRef, useEffect, useCallback, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
;

interface UseThreeSceneProps {
    mountRef: React.RefObject<HTMLDivElement | null>;
    characterModelPath: string;
    mapModelPath: string;
    onModelsLoaded?: (models: { 
        character: THREE.Group; 
        map: THREE.Group; 
        animations: THREE.AnimationClip[];
    }) => void;
}

interface LoadedModels {
    character: THREE.Group | null;
    map: THREE.Group | null;
    animations: THREE.AnimationClip[];
}

export function useThreeScene({
    mountRef,
    characterModelPath,
    mapModelPath,
    onModelsLoaded,
}: UseThreeSceneProps) {
    const sceneRef = useRef<THREE.Scene | null>(null);
    const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
    const characterModelRef = useRef<THREE.Group | null>(null);
    const mapModelRef = useRef<THREE.Object3D | null>(null);

    // Define addFallbackGeometry OUTSIDE useEffect but INSIDE the hook body
    const addFallbackGeometry = useCallback((scene: THREE.Scene) => {
        console.warn("Using fallback ground plane");
        const groundGeometry = new THREE.PlaneGeometry(50, 50);
        const groundMaterial = new THREE.MeshStandardMaterial({ color: 0x444444 });
        const ground = new THREE.Mesh(groundGeometry, groundMaterial);
        ground.rotation.x = -Math.PI / 2;
        ground.receiveShadow = true;
        scene.add(ground);
        const group = new THREE.Group();
        group.add(ground);
        mapModelRef.current = group; // Still store ref if needed elsewhere
    }, []); // Empty dependency array as it now takes scene as argument

    // --- Initialization Effect ---
    useEffect(() => {
        if (!mountRef.current) return;
        const currentMount = mountRef.current;

        // 1. Scene Setup
        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x222222); // Dark grey background
        sceneRef.current = scene;

        // 2. Renderer Setup
        const renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setSize(currentMount.clientWidth, currentMount.clientHeight);
        renderer.setPixelRatio(window.devicePixelRatio);
        renderer.shadowMap.enabled = true; // Enable shadows
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        renderer.setClearColor(0x87CEEB); // Sky Blue
        currentMount.appendChild(renderer.domElement);
        rendererRef.current = renderer;

        // 3. Basic Lighting (Crucial for seeing non-basic materials)
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.5); // Soft white light
        scene.add(ambientLight);

        const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
        directionalLight.position.set(5, 10, 7.5);
        directionalLight.castShadow = true;
        // Configure shadow properties if needed
        directionalLight.shadow.mapSize.width = 1024;
        directionalLight.shadow.mapSize.height = 1024;
        directionalLight.shadow.camera.near = 0.5;
        directionalLight.shadow.camera.far = 50;
        scene.add(directionalLight);

        // 5. Model Loading
        const loader = new GLTFLoader();
        // Optional: DRACOLoader setup if your models use it
        // const dracoLoader = new DRACOLoader();
        // dracoLoader.setDecoderPath('/path/to/draco/decoders/'); // Set path to Draco decoders
        // loader.setDRACOLoader(dracoLoader);

        let characterLoaded = false;
        let mapLoaded = false;
        let loadedModels: { 
            character: THREE.Group | null, 
            map: THREE.Group | null, 
            animations: THREE.AnimationClip[]
        } = { character: null, map: null, animations: [] };

        const checkLoadingComplete = () => {
            if (characterLoaded && mapLoaded && onModelsLoaded && loadedModels.character && loadedModels.map) {
                console.log("useThreeScene: Both models loaded, calling onModelsLoaded.");
                onModelsLoaded({ 
                    character: loadedModels.character, 
                    map: loadedModels.map, 
                    animations: loadedModels.animations
                });
            }
        };

        // Load Character Model
        loader.load(
            characterModelPath,
            (gltf) => {
                console.log("useThreeScene: Character model loaded successfully.");
                const model = gltf.scene;
                const animations = gltf.animations;
                // Scale the model down
                const scaleFactor = 0.5; // Adjust as needed
                model.scale.set(scaleFactor, scaleFactor, scaleFactor);

                model.traverse((node) => { // Enable shadows on all meshes
                    if ((node as THREE.Mesh).isMesh) {
                        node.castShadow = true;
                        node.receiveShadow = true;
                    }
                });
                characterModelRef.current = model;
                scene.add(model); // Add character model to scene
                loadedModels.character = model;
                loadedModels.animations = animations;
                characterLoaded = true;
                checkLoadingComplete();
            },
            undefined, // onProgress callback (optional)
            (error) => {
                console.error('useThreeScene: Error loading character model:', error);
                characterLoaded = true; // Mark as loaded (even on error) to proceed
                checkLoadingComplete();
            }
        );

        // Load Map Model
        loader.load(
            mapModelPath,
            (gltf) => {
                console.log("useThreeScene: Map model loaded successfully.");
                const model = gltf.scene;
                model.traverse((node) => { // Enable shadows on all meshes
                    if ((node as THREE.Mesh).isMesh) {
                        node.castShadow = true;
                        node.receiveShadow = true;
                    }
                });
                mapModelRef.current = model;
                scene.add(model); // Add map model to scene
                loadedModels.map = model;
                mapLoaded = true;
                checkLoadingComplete();
            },
            undefined, // onProgress callback (optional)
            (error) => {
                console.error('useThreeScene: Error loading map model:', error);
                addFallbackGeometry(scene);
                mapLoaded = true;
                checkLoadingComplete();
            }
        );

        // 6. Resize Handling
        const handleResize = () => {
            if (!rendererRef.current || !currentMount) return;
            const width = currentMount.clientWidth;
            const height = currentMount.clientHeight;
            rendererRef.current.setSize(width, height);
            // Note: Camera aspect ratio update is handled in useCameraControls
        };
        window.addEventListener('resize', handleResize);

        // 7. Cleanup
        return () => {
            console.log("useThreeScene: Cleaning up scene and renderer.");
            window.removeEventListener('resize', handleResize);
            if (mountRef.current && rendererRef.current?.domElement) {
                mountRef.current.removeChild(rendererRef.current.domElement);
            }
            rendererRef.current?.dispose();
            scene.traverse(object => { // Dispose geometries and materials
                if (object instanceof THREE.Mesh) {
                    object.geometry?.dispose();
                    if (Array.isArray(object.material)) {
                        object.material.forEach(material => material.dispose());
                    } else {
                        object.material?.dispose();
                    }
                }
            });
            sceneRef.current = null;
            rendererRef.current = null;
            characterModelRef.current = null; // Clear model refs too
            mapModelRef.current = null;
        };
    }, [mountRef, characterModelPath, mapModelPath, onModelsLoaded, addFallbackGeometry]); // Dependencies for initialization


    // --- Render Function ---
    const renderScene = useCallback((camera: THREE.Camera) => {
        if (rendererRef.current && sceneRef.current) {
            rendererRef.current.render(sceneRef.current, camera);
        } else {
            console.warn("renderScene called before renderer or scene initialized.");
        }
    }, []); // No dependencies needed here

    return { sceneRef, characterModelRef, mapModelRef, renderScene };
} 