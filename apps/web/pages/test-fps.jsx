import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import GameViewFPS from '../components/games/fps/GameViewFPS'; // Corrected path
import { CharacterId, MapId } from '@shared-types/game-fps'; // Corrected import path

// --- TEMPORARY Placeholder Match Data & Role Simulation ---
const getTestMatchData = (matchId) => {
    // Simulate fetching data or use static data for testing
    console.log(`Using static test data for match: ${matchId}`);
    return {
        matchId: matchId,
        serverIp: '127.0.0.1',
        serverPort: 3001,
        player1UserId: 'player1_test', // Match server startup arg
        player2UserId: 'player2_test', // Match server startup arg
        mapId: 'map1',
        player1CharId: 'charA',
        player2CharId: 'charB',
    };
};

export default function TestFpsPage() {
    const router = useRouter();
    const matchId = (router.query.matchId || 'test-match-placeholder');

    const [gameProps, setGameProps] = useState(null);
    const [isPlayerTwo, setIsPlayerTwo] = useState(false); // Track which player this browser simulates

    useEffect(() => {
        // --- Simple Role Simulation using localStorage ---
        // Check if the flag is set to force this instance to be Player 2
        const forceP2 = localStorage.getItem('forcePlayer2') === 'true';
        setIsPlayerTwo(forceP2);
        console.log(`Simulating as: ${forceP2 ? 'Player 2' : 'Player 1'}`);
        // --- End Simulation ---

        const matchData = getTestMatchData(matchId);

        let localId = null;
        let opponentId = null;
        let localCharId = null;
        let opponentCharId = null;

        if (forceP2) {
            // This browser acts as Player 2
            localId = matchData.player2UserId;
            opponentId = matchData.player1UserId;
            localCharId = matchData.player2CharId;
            opponentCharId = matchData.player1CharId;
        } else {
            // This browser acts as Player 1 (default)
            localId = matchData.player1UserId;
            opponentId = matchData.player2UserId;
            localCharId = matchData.player1CharId;
            opponentCharId = matchData.player2CharId;
        }

        // Set the props needed for GameViewFPS
        setGameProps({
            serverIp: matchData.serverIp,
            serverPort: matchData.serverPort,
            matchId: matchData.matchId,
            localPlayerUserId: localId,
            opponentPlayerId: opponentId,
            mapId: matchData.mapId,
            localPlayerCharacterId: localCharId,
            opponentPlayerCharacterId: opponentCharId,
            // NOTE: Wallets are omitted in this simple setup
        });

    }, [matchId]); // Re-run only if matchId changes

    if (!gameProps) {
         return <div>Preparing Game...</div>;
    }

    // Render the GameViewFPS component with the derived props
    return (
        <div style={{ width: '100vw', height: '100vh' }}>
            <h1>FPS Game: {gameProps.matchId}</h1>
            <p>
                Simulating as: <strong>{isPlayerTwo ? 'Player 2' : 'Player 1'}</strong><br />
                Local User: {gameProps.localPlayerUserId} ({gameProps.localPlayerCharacterId}) vs Opponent: {gameProps.opponentPlayerId} ({gameProps.opponentPlayerCharacterId})
            </p>
            {/* Simple instruction */}
            <p style={{fontSize: '0.8em', color: '#aaa'}}>
                (To test as Player 2, open browser console and run: localStorage.setItem('forcePlayer2', 'true'); then reload. Run localStorage.removeItem('forcePlayer2'); to revert to Player 1.)
            </p>
            <GameViewFPS
                serverIp={gameProps.serverIp}
                serverPort={gameProps.serverPort}
                matchId={gameProps.matchId}
                localPlayerUserId={gameProps.localPlayerUserId}
                opponentPlayerId={gameProps.opponentPlayerId}
                localPlayerCharacterId={CharacterId.CHAR_A}
                opponentPlayerCharacterId={CharacterId.CHAR_A}
                mapId={MapId.MAP_1}
            />
        </div>
    );
} 