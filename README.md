# Reflex - 1v1 FPS Game (Zeum Platform)

Welcome to the Reflex 1v1 FPS Game! This is one of the first exciting titles being developed for the Zeum Gaming Platform (@https://github.com/Arucard11/zeum).

**Status: In Development**

Please note that this game is currently under active development and is incomplete. Features are being added and refined regularly.

## Overview

This project is a fast-paced 1v1 first-person shooter designed to showcase the capabilities of the Zeum platform, including:

- Real-time multiplayer gameplay
- Server-authoritative physics with RapierJS
- Client-side prediction and reconciliation
- Integration with Solana for potential on-chain elements (future)
- Dynamic map and character configurations

## Technology Stack

- **Client (Web):** Next.js, React, Three.js (for rendering), RapierJS (for client-side physics), Socket.io-client
- **Game Server (Node.js):** Node.js, RapierJS (for server-side physics), Socket.io
- **Shared Types:** TypeScript/JavaScript for code sharing between client and server
- **Monorepo Management:** PNPM Workspaces

## Getting Started

### Prerequisites

- Node.js (v18.x or later recommended)
- PNPM (Package manager)
- Git

### Setup

1.  **Clone the Gladiator Repository:**
    ```bash
    git clone <your-gladiator-repo-url>
    cd <gladiator-repo-directory>
    ```


3.  **Install Dependencies:**
    From the root of the Gladiator monorepo, install all package dependencies using PNPM:
    ```bash
    pnpm install
    ```

4.  **Build Shared Packages (if necessary):**
    Some shared packages (like `@shared-types`) might need to be built if you make changes to them.
    ```bash
    pnpm --filter @shared-types build
    ```

## Running and Testing the Game

This game uses a dedicated game server instance for each match.

### 1. Running the Game Server Instance

A test script `run_server_test.sh` is provided in the root of the Gladiator repository to simplify launching a local game server instance with predefined test parameters.

-   **Make the script executable (if you haven't already):**
    ```bash
    chmod +x run_server_test.sh
    ```
-   **Run the script:**
    ```bash
    ./run_server_test.sh
    ```
    This script will start the Node.js game server instance (`packages/game-server-fps/src/gameInstance_fps.js`) with arguments for:
    - Port (e.g., 3001)
    - Match ID
    - Map ID (e.g., `map1`)
    - Player User IDs and Character IDs (e.g., `player1_test` with `charA`)
    - Fake Solana wallet addresses and program IDs (for testing integration points)
    - RPC URL
    - Platform API URL

    You should see logs in your terminal indicating that the server is starting, loading the map, initializing players, and then listening for connections (e.g., "Instance is READY and waiting for players...").

### 2. Running the Web Client (Next.js App)

The web client is part of the `apps/web` package.

-   **Start the Next.js development server:**
    Navigate to the web app directory and run the development script:
    ```bash
    # From the root of the monorepo
    pnpm --filter web dev
    ```
    Or, if you are already in `apps/web`:
    ```bash
    pnpm dev
    ```
    This will typically start the client on `http://localhost:3000`.

### 3. Connecting to the Game

1.  Open your web browser and navigate to the Next.js client (e.g., `http://localhost:3000`).
2.  You will need a page or UI element that allows you to connect to the game instance. The `GameViewFPS` component is designed to be embedded into such a page.
    -   **For testing, you might need to manually navigate to a test page or modify an existing page to include `<GameViewFPS ... />` with the correct props matching the server instance.**
    -   The necessary props for `GameViewFPS` include:
        -   `serverIp`: "localhost" (or the IP of your server if not local)
        -   `serverPort`: The port the game server is running on (e.g., 3001, as set in `run_server_test.sh`)
        -   `matchId`: The Match ID used by the server (can be dynamic or fixed for testing)
        -   `localPlayerUserId`: e.g., "player1_test"
        -   `opponentPlayerId`: e.g., "player2_test"
        -   `mapId`: e.g., "map1"
        -   `localPlayerCharacterId`: e.g., "charA"
        -   `opponentPlayerCharacterId`: e.g., "charA"

    *Refer to the `run_server_test.sh` script for the default values used for these parameters when launching the server.* 

4.  **Open two browser windows/tabs** to simulate two players connecting to the same match. Configure one to act as `player1_test` and the other as `player2_test` (you might need to adjust how `localPlayerUserId` is passed to the component for each instance).

### Expected Behavior for Testing

-   The game server should log player connections.
-   Once both players connect, the server should start the match (e.g., log "Starting round...").
-   The client browsers should render the game view.
-   Players should be able to move around the map using WASD keys and look around with the mouse.
-   Movement animations should play.
-   Basic shooting, weapon switching, and other implemented features should be testable.

## Development Notes

-   The game uses a shared types package (`packages/shared-types`) to ensure consistency between the client and server. If you modify these types, you may need to rebuild the package.
-   Server-side physics are handled by RapierJS, providing an authoritative simulation.
-   Client-side rendering is done with Three.js, with client-side RapierJS for prediction.

## Contribution

This project is currently in early development. Contributions, bug reports, and feedback are welcome as the project matures. Please refer to the contribution guidelines of the main Zeum repository or this project for more details.

## Troubleshooting

-   **Connection Issues:** Ensure the game server is running and accessible. Check that the `serverIp` and `serverPort` props in the client match the server's configuration. Verify firewall settings if running on different machines.
-   **Physics/Movement Issues:** Check console logs on both client and server for RapierJS errors or warnings. Ensure map and character physics colliders are loading correctly.
-   **Dependency Issues:** Run `pnpm install` again if you suspect missing packages.

Happy Gaming! 