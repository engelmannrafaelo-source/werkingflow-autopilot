#!/bin/bash
# ============================================================================
# Deploy CUI to Partner Server
# ============================================================================
# Run from the DEV SERVER. Syncs CUI code to a partner server via rsync/scp.
#
# USAGE:
#   ./deploy-to-partner.sh <tailscale-ip-or-hostname>
#   ./deploy-to-partner.sh 100.x.x.x
#   ./deploy-to-partner.sh partner-server
#
# What this does:
#   1. Builds the CUI frontend (vite build)
#   2. Syncs the built CUI to the partner server
#   3. Installs npm dependencies on the partner server
#   4. Installs/updates the systemd service
#   5. Restarts the CUI workspace service
#
# Prerequisites:
#   - Partner server has been provisioned with setup-partner-server.sh
#   - SSH access to partner server as root (via Tailscale)
#   - Claude OAuth tokens already set up on partner server
# ============================================================================
set -euo pipefail

TARGET="${1:-}"
CUI_DIR="/root/projekte/werkingflow/autopilot/cui"
REMOTE_CUI_DIR="/opt/cui-workspace"

if [ -z "$TARGET" ]; then
  echo "Usage: $0 <tailscale-ip-or-hostname>"
  echo ""
  echo "Example: $0 100.x.x.x"
  exit 1
fi

echo "========================================"
echo "  Deploy CUI → $TARGET"
echo "========================================"

# ── 1. Build frontend ────────────────────────────────────────────────────
echo "[1/5] Building CUI frontend..."
cd "$CUI_DIR"
npx vite build
echo "  Build complete"

# ── 2. Sync CUI code to partner ─────────────────────────────────────────
echo "[2/5] Syncing CUI to $TARGET:$REMOTE_CUI_DIR ..."

# Create target directory
ssh "root@$TARGET" "mkdir -p $REMOTE_CUI_DIR"

rsync -avz --delete \
  --exclude 'node_modules' \
  --exclude '.git' \
  --exclude 'data/users.json' \
  --exclude '.env' \
  --exclude 'data/layouts' \
  --exclude 'data/projects' \
  --exclude '*.log' \
  "$CUI_DIR/" "root@$TARGET:$REMOTE_CUI_DIR/"

echo "  Sync complete"

# ── 3. Install dependencies on partner ───────────────────────────────────
echo "[3/5] Installing npm dependencies on partner..."
ssh "root@$TARGET" "cd $REMOTE_CUI_DIR && npm install --production"
echo "  Dependencies installed"

# ── 4. Install/update systemd service ────────────────────────────────────
echo "[4/5] Installing systemd service..."
ssh "root@$TARGET" bash <<'REMOTE_SCRIPT'
cat > /etc/systemd/system/cui-workspace.service <<'SVC'
[Unit]
Description=CUI Workspace Server (Partner)
After=network.target tailscaled.service

[Service]
Type=simple
User=claude-user
Group=claude-user
WorkingDirectory=/opt/cui-workspace

ExecStartPre=+/bin/bash -c "fuser -k 4005/tcp 2>/dev/null || true; sleep 1"
ExecStart=/bin/bash scripts/start-local.sh

Environment=HOME=/home/claude-user
Environment=NODE_ENV=production
Environment=PORT=4005

KillMode=process
KillSignal=SIGTERM
TimeoutStopSec=15
Restart=always
RestartSec=10

StandardOutput=append:/var/log/cui-workspace.log
StandardError=append:/var/log/cui-workspace.log

[Install]
WantedBy=multi-user.target
SVC

systemctl daemon-reload
systemctl enable cui-workspace
REMOTE_SCRIPT
echo "  Service installed"

# ── 5. Sync orchestrator/bin scripts ────────────────────────────────────
echo "[5/7] Syncing orchestrator/bin scripts to partner..."
ORCH_BIN="/root/projekte/orchestrator/bin"
if [ -d "$ORCH_BIN" ]; then
  ssh "root@$TARGET" "mkdir -p /root/projekte/orchestrator/bin"
  rsync -avz --delete \
    "$ORCH_BIN/" "root@$TARGET:/root/projekte/orchestrator/bin/"
  ssh "root@$TARGET" "chmod +x /root/projekte/orchestrator/bin/*"
  echo "  orchestrator/bin synced"
else
  echo "  WARNING: $ORCH_BIN not found, skipping"
fi

# ── 6. Install git hooks ─────────────────────────────────────────────────
echo "[6/7] Installing git hooks on partner..."
HOOK_SRC="$CUI_DIR/deploy/hooks/pre-push"
if [ -f "$HOOK_SRC" ]; then
  scp "$HOOK_SRC" "root@$TARGET:/tmp/pre-push-hook"
  ssh "root@$TARGET" bash <<'HOOKSCRIPT'
chmod +x /tmp/pre-push-hook
for gitdir in /opt/cui-workspace/.git /home/claude-user/projects/*/.git; do
  if [ -d "$gitdir" ]; then
    cp /tmp/pre-push-hook "$gitdir/hooks/pre-push"
    chmod +x "$gitdir/hooks/pre-push"
    echo "  Hook installed: $gitdir/hooks/pre-push"
  fi
done
rm -f /tmp/pre-push-hook
HOOKSCRIPT
fi

# ── 7. Restart service ──────────────────────────────────────────────────
echo "[7/7] Restarting CUI workspace..."
ssh "root@$TARGET" "systemctl restart cui-workspace"

# Wait for startup
sleep 3
STATUS=$(ssh "root@$TARGET" "systemctl is-active cui-workspace" 2>/dev/null || echo "failed")

echo ""
echo "========================================"
if [ "$STATUS" = "active" ]; then
  PARTNER_IP=$(ssh "root@$TARGET" "tailscale ip -4" 2>/dev/null || echo "$TARGET")
  echo "  DEPLOY SUCCESS"
  echo "  CUI running at: http://$PARTNER_IP:4005"
else
  echo "  DEPLOY WARNING: Service status = $STATUS"
  echo "  Check logs: ssh root@$TARGET journalctl -u cui-workspace -n 50"
fi
echo "========================================"
