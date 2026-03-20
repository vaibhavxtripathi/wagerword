#!/usr/bin/env bash
set -e
GREEN='\033[0;32m'; CYAN='\033[0;36m'; NC='\033[0m'

echo -e "${CYAN}WAGERWORD — DEPLOY${NC}"

stellar keys generate --global wordmaster --network testnet 2>/dev/null || true
stellar keys generate --global player1   --network testnet 2>/dev/null || true
stellar keys fund wordmaster --network testnet
stellar keys fund player1    --network testnet
MASTER=$(stellar keys address wordmaster)
PLAYER=$(stellar keys address player1)
XLM_TOKEN=$(stellar contract id asset --asset native --network testnet)
echo -e "${GREEN}✓ Wordmaster: ${MASTER}${NC}"
echo -e "${GREEN}✓ Player    : ${PLAYER}${NC}"

cd contract
cargo build --target wasm32-unknown-unknown --release
WASM="target/wasm32-unknown-unknown/release/wagerword.wasm"
cd ..

WASM_HASH=$(stellar contract upload --network testnet --source wordmaster --wasm contract/${WASM})
CONTRACT_ID=$(stellar contract deploy --network testnet --source wordmaster --wasm-hash ${WASM_HASH})
echo -e "${GREEN}✓ CONTRACT_ID: ${CONTRACT_ID}${NC}"

# Initialize — secret word is "CHAIN" (5 letters), 0.5 XLM per guess
stellar contract invoke --network testnet --source wordmaster --id ${CONTRACT_ID} \
  -- initialize \
  --admin ${MASTER} \
  --xlm_token ${XLM_TOKEN} \
  --guess_fee 5000000 \
  --secret_word '"chain"' 2>&1 || true

echo -e "${GREEN}✓ Initialized with secret word 'chain' (5 XLM per guess)${NC}"

# Player1 places proof guess
stellar contract invoke --network testnet --source player1 --id ${XLM_TOKEN} \
  -- approve --from ${PLAYER} --spender ${CONTRACT_ID} \
  --amount 50000000 --expiration_ledger 3110400 2>&1 || true

TX_RESULT=$(stellar contract invoke \
  --network testnet --source player1 --id ${CONTRACT_ID} \
  -- guess \
  --player ${PLAYER} \
  --word '"stare"' 2>&1)

TX_HASH=$(echo "$TX_RESULT" | grep -oP '[0-9a-f]{64}' | head -1)
echo -e "${GREEN}✓ Proof TX: ${TX_HASH}${NC}"

cat > frontend/.env << EOF
VITE_CONTRACT_ID=${CONTRACT_ID}
VITE_XLM_TOKEN=${XLM_TOKEN}
VITE_ADMIN_ADDRESS=${MASTER}
VITE_NETWORK_PASSPHRASE=Test SDF Network ; September 2015
VITE_SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
EOF

echo ""
echo -e "${CYAN}CONTRACT   : ${CONTRACT_ID}${NC}"
echo -e "${CYAN}SECRET WORD: chain (change with new_round for live play)${NC}"
echo -e "${CYAN}PROOF TX   : ${TX_HASH}${NC}"
echo -e "${CYAN}EXPLORER   : https://stellar.expert/explorer/testnet/contract/${CONTRACT_ID}${NC}"
echo "Next: cd frontend && npm install && npm run dev"
