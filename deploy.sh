#!/bin/bash
# ─────────────────────────────────────────────────────
# deploy.sh — Deploy WM Monitoring to DigitalOcean droplet
# Usage: ./deploy.sh
# ─────────────────────────────────────────────────────
set -e

SERVER="root@138.197.44.252"
REMOTE_DIR="/root/wm-monitoring"
APP_NAME="wm-monitoring"

echo ""
echo "🚀 WM Plus Monitoring — Deployment"
echo "   Server : $SERVER"
echo "   Remote : $REMOTE_DIR"
echo "──────────────────────────────────────"

# 1. Sync files (exclude local-only dirs)
echo "📦 Syncing files..."
rsync -avz --progress \
  --exclude='node_modules/' \
  --exclude='clients/' \
  --exclude='.env' \
  --exclude='*.db' \
  --exclude='.git/' \
  --exclude='Backstop-Monitoring/' \
  ./ "$SERVER:$REMOTE_DIR/"

# 2. Copy server-side .env if it doesn't exist
echo "🔧 Setting up .env on server..."
ssh "$SERVER" "
  if [ ! -f $REMOTE_DIR/.env ]; then
    cat > $REMOTE_DIR/.env <<'ENVEOF'
PORT=3000
NODE_ENV=production
CHROMIUM_PATH=/usr/bin/chromium-browser
DASHBOARD_URL=https://backstop.webmarketersdev.ca
ENVEOF
    echo '   Created .env'
  else
    echo '   .env already exists, skipping'
  fi
"

# 3. Install dependencies
echo "📥 Installing npm dependencies..."
ssh "$SERVER" "cd $REMOTE_DIR && npm install --production"

# 4. Start/restart with PM2
echo "⚙️  Starting app with PM2..."
ssh "$SERVER" "
  cd $REMOTE_DIR
  if pm2 describe $APP_NAME > /dev/null 2>&1; then
    pm2 restart $APP_NAME
    echo '   Restarted existing PM2 process'
  else
    pm2 start server.js --name $APP_NAME --env production
    pm2 save
    echo '   Started new PM2 process'
  fi
"

# 5. Verify
echo "🔍 Checking app status..."
sleep 2
ssh "$SERVER" "pm2 show $APP_NAME | grep -E 'status|cpu|memory|uptime' | head -6"

echo ""
echo "✅ Deployment complete!"
echo "   App running at: http://138.197.44.252:3000"
echo ""
echo "📌 Next steps on the server:"
echo "   - Update Nginx to proxy port 3000 for the dashboard domain"
echo "   - Add the existing crash-test client via the dashboard UI"
echo ""
