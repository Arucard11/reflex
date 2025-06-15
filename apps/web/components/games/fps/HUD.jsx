import React from 'react';

// A simple functional component for the HUD
// It receives the necessary parts of the game state as props
const HUD = ({ localPlayer, opponent, matchState, roundWins, localPlayerUserId, opponentPlayerId }) => {

    if (!localPlayer || !matchState) {
        // Don't render anything if the essential state isn't available yet
        return null;
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
            {/* 1. Crosshair */}
            <div style={{
                position: 'absolute',
                top: '50%',
                left: '52%',
                transform: 'translate(-50%, -50%)',
                width: '4px',
                height: '4px',
                backgroundColor: 'rgba(255, 255, 255, 0.8)',
                borderRadius: '50%',
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
                {/* Ammo */}
                <div style={{ fontSize: '3em', fontWeight: 'bold' }}>
                    <span>{localPlayer.isReloading ? 'RELOADING' : `${localPlayer.currentAmmoInClip ?? '-'}`}</span>
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