#!/usr/bin/env bash
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
gh repo create wagerword --public \
  --description "WagerWord — Wordle on Stellar. Each guess costs XLM. Solve in 6 to win the prize pool." \
  --source "${ROOT}" --remote origin --push
ENV="${ROOT}/frontend/.env"
CONTRACT_ID=$(grep VITE_CONTRACT_ID "$ENV" | cut -d= -f2 | tr -d '[:space:]')
XLM_TOKEN=$(grep VITE_XLM_TOKEN "$ENV" | cut -d= -f2 | tr -d '[:space:]')
ADMIN=$(grep VITE_ADMIN_ADDRESS "$ENV" | cut -d= -f2 | tr -d '[:space:]')
USER=$(gh api user -q .login)
gh secret set VITE_CONTRACT_ID   --body "$CONTRACT_ID" --repo "$USER/wagerword"
gh secret set VITE_XLM_TOKEN     --body "$XLM_TOKEN"   --repo "$USER/wagerword"
gh secret set VITE_ADMIN_ADDRESS --body "$ADMIN"        --repo "$USER/wagerword"
cd "${ROOT}/frontend" && vercel --prod --yes
echo "✓ WagerWord published!"
