import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';

// Import modular components
import { physicsWorld, loadMapGeometry } from './physics';
import { setupConnectionHandler } from './connectionHandler';
import { startGameLoop } from './gameLoop';

// --- Server Initialization ---
const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, {
    cors: { // Configure CORS for development
        origin: "*", // Allow all origins (restrict in production)
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3001;

// --- Start Server ---
async function startServer() {
    console.log("[Server] Initializing...");

    // 1. Load Map Geometry (Physics world is initialized in physics.ts)
    console.log("[Server] Loading map geometry...");
    await loadMapGeometry(physicsWorld);

    // 2. Setup WebSocket Connection Handling
    console.log("[Server] Setting up connection handler...");
    setupConnectionHandler(io);

    // 3. Start the Server Listening
    server.listen(PORT, () => {
        console.log(`[Server] HTTP server listening on port ${PORT}`);
        console.log(`[Server] WebSocket server attached`);

        // 4. Start the Game Loop AFTER server is listening
        startGameLoop(io);
    });

    // Graceful shutdown handling (optional but recommended)
    process.on('SIGTERM', () => {
        console.log('[Server] SIGTERM signal received: closing HTTP server');
        // Optional: Add logic here to notify clients before shutdown
        // Optional: Stop game loop, save state, etc.
        server.close(() => {
            console.log('[Server] HTTP server closed');
            process.exit(0);
        });
    });
}

// --- Run the Server --- 
startServer().catch(error => {
    console.error("[Server] Failed to start server:", error);
    process.exit(1);
}); 