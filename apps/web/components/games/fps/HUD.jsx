import React from 'react';

// A simple functional component for the HUD
// It receives the necessary parts of the game state as props
const HUD = ({ localPlayer, opponent, matchState, roundWins, localPlayerUserId, opponentPlayerId, weaponPredictionState }) => {

    // DEBUG: Log what we're receiving
    console.log('🎮 [HUD] Rendering with props:', {
        hasLocalPlayer: !!localPlayer,
        matchState,
        hasRoundWins: !!roundWins,
        localPlayerUserId,
        opponentPlayerId
    });

    // TEMPORARY: Show debug info instead of returning null
    if (!localPlayer || !matchState) {
        return (
            <div style={{
                position: 'absolute',
                top: '50px',
                left: '50px',
                color: 'red',
                background: 'rgba(0,0,0,0.8)',
                padding: '20px',
                fontFamily: 'monospace',
                fontSize: '14px',
                zIndex: 1000
            }}>
                <div>🎮 HUD DEBUG INFO:</div>
                <div>localPlayer: {localPlayer ? 'EXISTS' : 'NULL'}</div>
                <div>matchState: {matchState || 'NULL'}</div>
                <div>localPlayerUserId: {localPlayerUserId}</div>
                <div>opponentPlayerId: {opponentPlayerId}</div>
                {localPlayer && (
                    <div>
                        <div>Player health: {localPlayer.health}</div>
                        <div>Player state: {localPlayer.state}</div>
                    </div>
                )}
            </div>
        );
    }

    const healthPercentage = (localPlayer.health / 100) * 100; // Assuming max health is 100
    const shieldPercentage = (localPlayer.shield / 50) * 100; // Assuming max shield is 50

    const abilityCooldown = localPlayer.ability1CooldownRemaining || 0;
    const isAbilityReady = abilityCooldown <= 0;

    const p1Id = localPlayerUserId;
    const p2Id = opponentPlayerId;

    const p1Wins = roundWins?.p1 || 0;
    const p2Wins = roundWins?.p2 || 0;
    
    // Determine who is player 1 and who is player 2 for display
    // This assumes the props localPlayerUserId and opponentPlayerId are passed correctly
    const isLocalPlayerP1 = localPlayer.userId === p1Id;

    const localPlayerRoundWins = isLocalPlayerP1 ? p1Wins : p2Wins;
    const opponentRoundWins = isLocalPlayerP1 ? p2Wins : p1Wins;

    // Determine opponent info - use the opponent object directly
    const opponentHealth = opponent?.health ?? 0;
    const opponentShield = opponent?.shield ?? 0;
    const opponentAmmo = opponent?.currentAmmoInClip ?? 0; // Assuming server sends this for opponent
    const opponentMaxAmmo = 30; // Placeholder, this should ideally come from WEAPON_CONFIG

    // DEBUG: Log what the HUD is calculating
    console.log(`🎮 [HUD] Calculated Values: localHealth=${localPlayer.health}, localShield=${localPlayer.shield}, opponentHealth=${opponentHealth}, opponentShield=${opponentShield}`);

    return (
        <div style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            color: 'white',
            fontFamily: '"Roboto Mono", monospace',
            pointerEvents: 'none', // Allow mouse events to pass through to the canvas
            textShadow: '1px 1px 2px rgba(0,0,0,0.7)',
        }}>
            {/* 1. Crosshair - Fixed positioning */}
            <div style={{
                position: 'absolute',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                width: '4px',
                height: '4px',
                backgroundColor: 'rgba(255, 255, 255, 0.9)',
                borderRadius: '50%',
                zIndex: 1000,
                boxShadow: '0 0 4px rgba(0,0,0,0.8)'
            }}></div>
            
            {/* Crosshair lines for better visibility */}
            <div style={{
                position: 'absolute',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                width: '20px',
                height: '2px',
                backgroundColor: 'rgba(255, 255, 255, 0.6)',
                zIndex: 999
            }}></div>
            <div style={{
                position: 'absolute',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                width: '2px',
                height: '20px',
                backgroundColor: 'rgba(255, 255, 255, 0.6)',
                zIndex: 999
            }}></div>

            {/* 2. Top Center: Score & Match State */}
            <div style={{
                position: 'absolute',
                top: '20px',
                left: '50%',
                transform: 'translateX(-50%)',
                textAlign: 'center',
            }}>
                <div style={{ fontSize: '2.5em', fontWeight: 'bold' }}>
                    <span>{`[ ${localPlayerRoundWins} ]`}</span>
                    <span style={{ margin: '0 20px' }}>-</span>
                    <span>{`[ ${opponentRoundWins} ]`}</span>
                </div>
                {matchState.startsWith('countdown') && (
                    <div style={{ fontSize: '3em', marginTop: '150px' }}>{matchState.split('_')[1]}</div>
                )}
                 {matchState === 'round_over' && (
                    <div style={{ fontSize: '2em', marginTop: '20px' }}>ROUND OVER</div>
                )}
                 {matchState === 'match_over' && (
                    <div style={{ fontSize: '3em', marginTop: '150px' }}>MATCH OVER</div>
                )}
            </div>

            {/* 3. Bottom Left: Health & Shield */}
            <div style={{
                position: 'absolute',
                bottom: '20px',
                left: '20px',
                width: '250px',
            }}>
                {/* Health Bar */}
                <div style={{ marginBottom: '10px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                        <span>HEALTH</span>
                        <span>{localPlayer.health}</span>
                    </div>
                    <div style={{ background: 'rgba(0,0,0,0.5)', border: '1px solid white', padding: '2px' }}>
                        <div style={{
                            width: `${healthPercentage}%`,
                            height: '15px',
                            background: `linear-gradient(90deg, rgba(170,255,170,1) 0%, rgba(20,150,20,1) 100%)`,
                            transition: 'width 0.3s ease'
                        }}></div>
                    </div>
                </div>
                {/* Shield Bar */}
                <div>
                     <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                        <span>SHIELD</span>
                        <span>{localPlayer.shield}</span>
                    </div>
                    <div style={{ background: 'rgba(0,0,0,0.5)', border: '1px solid white', padding: '2px' }}>
                        <div style={{
                            width: `${shieldPercentage}%`,
                            height: '15px',
                            background: `linear-gradient(90deg, rgba(170,170,255,1) 0%, rgba(20,20,150,1) 100%)`,
                            transition: 'width 0.3s ease'
                        }}></div>
                    </div>
                </div>
            </div>

            {/* 4. Bottom Right: Ammo, Grenades, Ability */}
            <div style={{
                position: 'absolute',
                bottom: '20px',
                right: '20px',
                textAlign: 'right',
            }}>
                {/* Ammo - Use predicted state for immediate feedback */}
                <div style={{ fontSize: '3em', fontWeight: 'bold' }}>
                    {(() => {
                        // Use predicted weapon state if available for immediate feedback
                        const isPredictedReloading = weaponPredictionState?.isReloading ?? localPlayer.isReloading;
                        const predictedAmmo = weaponPredictionState?.currentAmmoInClip ?? localPlayer.currentAmmoInClip;
                        
                        // Show reload progress if reloading
                        if (isPredictedReloading && weaponPredictionState?.reloadStartTime) {
                            const elapsed = performance.now() - weaponPredictionState.reloadStartTime;
                            const progress = Math.min(elapsed / weaponPredictionState.reloadDuration, 1.0);
                            const percentage = Math.floor(progress * 100);
                            return (
                                <span style={{ color: '#ffaa00' }}>
                                    RELOADING ({percentage}%)
                                </span>
                            );
                        }
                        
                        // Show weapon switching feedback
                        if (weaponPredictionState?.isPredictingSwitch) {
                            return (
                                <span style={{ color: '#00aaff' }}>
                                    SWITCHING...
                                </span>
                            );
                        }
                        
                        // Normal ammo display
                        return <span>{predictedAmmo ?? '-'}</span>;
                    })()}
                    <span style={{ fontSize: '0.5em', marginLeft: '5px' }}>/ --</span>
                </div>

                {/* Grenades & Ability */}
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '15px', marginTop: '10px' }}>
                     <div style={{ padding: '8px', border: '1px solid white', background: localPlayer.grenades?.frag > 0 ? 'rgba(0,0,0,0.5)' : 'rgba(150,0,0,0.5)' }}>
                        G {localPlayer.grenades?.frag}
                    </div>
                     <div style={{ padding: '8px', border: '1px solid white', background: localPlayer.grenades?.semtex > 0 ? 'rgba(0,0,0,0.5)' : 'rgba(150,0,0,0.5)' }}>
                        S {localPlayer.grenades?.semtex}
                    </div>
                    <div style={{ padding: '8px', border: '1px solid white', background: isAbilityReady ? 'rgba(0,0,0,0.5)' : 'rgba(150,0,0,0.5)' }}>
                        {isAbilityReady ? 'READY' : `${(abilityCooldown / 1000).toFixed(1)}s`}
                    </div>
                </div>
            </div>
        </div>
    );
};

export default HUD; 