#!/bin/bash

# --- Configuration ---
# Fake Solana Addresses (Base58 format)
PLAYER1_WALLET="F4keP1Wa11etAddre55So1anaP1ayer1FakeAddr"
PLAYER2_WALLET="F4keP2Wa11etAddre55So1anaP2ayer2FakeAddr"

# Fake Server Authority Keypair Path (File does NOT exist)
# Adjust path if needed, e.g., to ./server_key.json if you create one in root
SERVER_KEY_PATH="/path/to/fake/server_key.json"

# Fake Solana Program IDs
ESCROW_PROGRAM_ID="FakeEscrowProgram111111111111111111111111"
PROFILE_PROGRAM_ID="FakeProfileProgram11111111111111111111111"

# Game Configuration
PORT=3001
MATCH_ID="test-match-$(date +%s)" # Unique ID using timestamp
MAP_ID="map1" # Example map
PLAYER1_USERID="player1_test"
PLAYER1_CHARID="charA"       # Changed to charA
PLAYER2_USERID="player2_test"
PLAYER2_CHARID="charA"       # Changed to charA
BET_LAMPORTS=1000000

# Solana RPC URL (Using Devnet)
RPC_URL="https://api.devnet.solana.com"

# Platform API URL (Adjust if your platform API runs elsewhere)
PLATFORM_API_URL="http://localhost:8080/api" 

# --- Command ---

node packages/game-server-fps/src/gameInstance_fps.js \
  --port ${PORT} \
  --matchId ${MATCH_ID} \
  --mapId ${MAP_ID} \
  --player1UserId ${PLAYER1_USERID} \
  --player1Wallet ${PLAYER1_WALLET} \
  --player1CharId ${PLAYER1_CHARID} \
  --player2UserId ${PLAYER2_USERID} \
  --player2Wallet ${PLAYER2_WALLET} \
  --player2CharId ${PLAYER2_CHARID} \
  --betAmountLamports ${BET_LAMPORTS} \
  --serverAuthorityKeyPath ${SERVER_KEY_PATH} \
  --rpcUrl ${RPC_URL} \
  --platformApiUrl ${PLATFORM_API_URL} \
  --programIdEscrow ${ESCROW_PROGRAM_ID} \
  --programIdProfile ${PROFILE_PROGRAM_ID}

# Optional: Add pause or read command if running in a double-click environment
# read -p "Press Enter to exit..." 