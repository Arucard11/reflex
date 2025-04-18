"use strict";
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
const express_1 = __importDefault(require("express"));
const http_1 = __importDefault(require("http"));
const socket_io_1 = require("socket.io");
// Import modular components
const physics_1 = require("./physics");
const connectionHandler_1 = require("./connectionHandler");
const gameLoop_1 = require("./gameLoop");
// --- Server Initialization ---
const app = (0, express_1.default)();
const server = http_1.default.createServer(app);
const io = new socket_io_1.Server(server, {
    cors: {
        origin: "*", // Allow all origins (restrict in production)
        methods: ["GET", "POST"]
    }
});
const PORT = process.env.PORT || 3001;
// --- Start Server ---
function startServer() {
    return __awaiter(this, void 0, void 0, function* () {
        console.log("[Server] Initializing...");
        // 1. Load Map Geometry (Physics world is initialized in physics.ts)
        console.log("[Server] Loading map geometry...");
        yield (0, physics_1.loadMapGeometry)(physics_1.physicsWorld);
        // 2. Setup WebSocket Connection Handling
        console.log("[Server] Setting up connection handler...");
        (0, connectionHandler_1.setupConnectionHandler)(io);
        // 3. Start the Server Listening
        server.listen(PORT, () => {
            console.log(`[Server] HTTP server listening on port ${PORT}`);
            console.log(`[Server] WebSocket server attached`);
            // 4. Start the Game Loop AFTER server is listening
            (0, gameLoop_1.startGameLoop)(io);
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
    });
}
// --- Run the Server --- 
startServer().catch(error => {
    console.error("[Server] Failed to start server:", error);
    process.exit(1);
});
