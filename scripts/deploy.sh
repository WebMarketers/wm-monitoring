#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# Webmarketers Monitoring — deploy to DigitalOcean droplet
# Usage:  npm run deploy
# ─────────────────────────────────────────────────────────────
set -e

REMOTE="root@138.197.44.252"
REMOTE_DIR="/root/wm-monitoring"
BOLD="\033[1m"
GREEN="\033[0;32m"
YELLOW="\033[0;33m"
RESET="\033[0m"

echo ""
echo -e "${BOLD}🚀  Deploying Webmarketers Monitoring…${RESET}"
echo -e "${YELLOW}    Target: backstop.webmarketersdev.ca${RESET}"
echo ""

# ── Sync files ────────────────────────────────────────────────
rsync -az --checksum \
  --exclude='node_modules/' \
  --exclude='clients/' \
  --exclude='.env' \
  --exclude='*.db' \
  --exclude='.git/' \
  --exclude='Backstop-Monitoring/' \
  --exclude='.DS_Store' \
  --exclude='scripts/' \
  ./ "$REMOTE:$REMOTE_DIR/"

# ── Restart server ────────────────────────────────────────────
ssh "$REMOTE" "
  cd $REMOTE_DIR
  npm install --production --silent 2>/dev/null
  pm2 restart webmarketers-monitoring --silent
  sleep 1
  STATUS=\$(pm2 jlist | python3 -c \"import sys,json; procs=json.load(sys.stdin); p=[x for x in procs if x['name']=='webmarketers-monitoring'][0]; print(p['pm2_env']['status'])\" 2>/dev/null || echo 'unknown')
  echo \"  PM2 status: \$STATUS\"
"

echo ""
echo -e "${GREEN}✅  Deployed to https://backstop.webmarketersdev.ca${RESET}"
echo ""
