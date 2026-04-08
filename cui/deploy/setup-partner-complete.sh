#!/bin/bash
# ============================================================================
# CUI Partner Server — Complete Setup (Master Script)
# ============================================================================
# Runs ALL setup steps in order. Execute on the DEV SERVER.
#
# USAGE:
#   ./setup-partner-complete.sh <partner-ip> [users-input.json]
#
# What this does (in order):
#   Phase 1 — Server provisioning (runs ON partner via SSH)
#     1. setup-partner-server.sh  — packages, Node, claude-user, Tailscale, firewall
#
#   Phase 2 — Secrets & auth (runs FROM dev-server)
#     2. setup-partner-infisical.sh — Infisical helpers + limited workspace access
#     3. PAUSE: Tailscale auth (manual browser step)
#     4. setup-claude-auth.sh — Claude OAuth tokens
#     5. PAUSE: Claude login (manual browser step)
#
#   Phase 3 — Application (runs FROM dev-server)
#     6. deploy-to-partner.sh — build, sync, systemd service
#     7. create-partner-users.sh — user accounts (batch or interactive)
#     8. Install git hooks on partner workspaces
#
#   Phase 4 — Verification
#     9. Health check: CUI running, Infisical connected, users loaded
#
# PREREQUISITES:
#   - SSH access to partner as root (key-based)
#   - Dev server has all repos and Infisical configured
#   - Optional: users-input.json for batch user creation
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="${1:-}"
USERS_JSON="${2:-}"

if [ -z "$TARGET" ]; then
  echo "Usage: $0 <partner-ip> [users-input.json]"
  echo ""
  echo "Examples:"
  echo "  $0 100.119.199.86"
  echo "  $0 100.119.199.86 users.json"
  exit 1
fi

passed=0
failed=0
pass() { passed=$((passed + 1)); echo "  OK: $1"; }
fail() { failed=$((failed + 1)); echo "  FAIL: $1"; }

echo "========================================"
echo "  CUI Partner Server — Complete Setup"
echo "========================================"
echo "  Target:  $TARGET"
echo "  Users:   ${USERS_JSON:-interactive (later)}"
echo "  Time:    $(date '+%Y-%m-%d %H:%M:%S')"
echo "========================================"
echo ""

# ══════════════════════════════════════════════════════════════════════════
# Phase 1: Server Provisioning
# ══════════════════════════════════════════════════════════════════════════
echo "┌──────────────────────────────────────┐"
echo "│  Phase 1: Server Provisioning        │"
echo "└──────────────────────────────────────┘"

echo "[1/9] Running setup-partner-server.sh on $TARGET..."
scp "$SCRIPT_DIR/setup-partner-server.sh" "root@$TARGET:/tmp/setup-partner-server.sh"
ssh "root@$TARGET" "chmod +x /tmp/setup-partner-server.sh && /tmp/setup-partner-server.sh"

# Mark as partner server (used by git hooks)
ssh "root@$TARGET" "touch /etc/cui-partner"

echo ""
echo "Phase 1 complete."
echo ""

# ══════════════════════════════════════════════════════════════════════════
# Phase 2: Secrets & Auth
# ══════════════════════════════════════════════════════════════════════════
echo "┌──────────────────────────────────────┐"
echo "│  Phase 2: Secrets & Auth             │"
echo "└──────────────────────────────────────┘"

# Check if Tailscale is already connected
TAILSCALE_STATUS=$(ssh "root@$TARGET" "tailscale status --json 2>/dev/null | jq -r '.Self.Online // false'" 2>/dev/null || echo "false")

if [ "$TAILSCALE_STATUS" != "true" ]; then
  echo ""
  echo "╔══════════════════════════════════════════════════════╗"
  echo "║  MANUAL STEP: Tailscale Authentication              ║"
  echo "║                                                     ║"
  echo "║  SSH into the partner server and run:               ║"
  echo "║    ssh root@$TARGET"
  echo "║    tailscale up                                     ║"
  echo "║                                                     ║"
  echo "║  Follow the browser URL to authenticate.            ║"
  echo "╚══════════════════════════════════════════════════════╝"
  echo ""
  echo -n "Press ENTER when Tailscale auth is complete..."
  read -r
fi

echo "[2/9] Setting up Infisical on partner..."
bash "$SCRIPT_DIR/setup-partner-infisical.sh" "$TARGET"

echo ""

# Check if Claude auth exists
CLAUDE_AUTH=$(ssh "root@$TARGET" "[ -f /home/claude-user/.claude/.credentials.json ] && echo 'yes' || echo 'no'" 2>/dev/null || echo "no")

if [ "$CLAUDE_AUTH" != "yes" ]; then
  echo ""
  echo "╔══════════════════════════════════════════════════════╗"
  echo "║  MANUAL STEP: Claude Code Authentication            ║"
  echo "║                                                     ║"
  echo "║  SSH into the partner server and run:               ║"
  echo "║    ssh root@$TARGET                                 ║"
  echo "║    su - claude-user                                 ║"
  echo "║    claude login                                     ║"
  echo "║                                                     ║"
  echo "║  Follow the browser URL to authenticate.            ║"
  echo "╚══════════════════════════════════════════════════════╝"
  echo ""
  echo -n "Press ENTER when Claude auth is complete..."
  read -r
else
  echo "[3/9] Claude auth already configured — skipping"
fi

echo ""
echo "Phase 2 complete."
echo ""

# ══════════════════════════════════════════════════════════════════════════
# Phase 3: Application Deployment
# ══════════════════════════════════════════════════════════════════════════
echo "┌──────────────────────────────────────┐"
echo "│  Phase 3: Application Deployment     │"
echo "└──────────────────────────────────────┘"

echo "[4/9] Deploying CUI to partner..."
bash "$SCRIPT_DIR/deploy-to-partner.sh" "$TARGET"

echo ""

echo "[5/9] Setting up app workspaces (sync + build — takes ~10 min)..."
bash "$SCRIPT_DIR/setup-app-workspaces.sh" "$TARGET"

echo ""

# Users
if [ -n "$USERS_JSON" ] && [ -f "$USERS_JSON" ]; then
  echo "[6/9] Creating users (batch mode)..."
  REMOTE_USERS_DIR="/opt/cui-workspace/data"
  ssh "root@$TARGET" "mkdir -p $REMOTE_USERS_DIR"
  bash "$SCRIPT_DIR/create-partner-users.sh" --from-json "$USERS_JSON" "/tmp/cui-users.json"
  scp "/tmp/cui-users.json" "root@$TARGET:$REMOTE_USERS_DIR/users.json"
  ssh "root@$TARGET" "chown claude-user:claude-user $REMOTE_USERS_DIR/users.json"
  rm -f "/tmp/cui-users.json"
  echo "  Users deployed to partner"
else
  echo "[6/9] No users JSON provided — skipping batch user creation"
  echo "  Create users later: ./create-partner-users.sh --from-json users.json"
fi

echo ""

# Git hooks
echo "[7/9] Installing git hooks on partner workspaces..."
HOOK_SRC="$SCRIPT_DIR/hooks/pre-push"
if [ -f "$HOOK_SRC" ]; then
  scp "$HOOK_SRC" "root@$TARGET:/tmp/pre-push-hook"
  ssh "root@$TARGET" bash <<'HOOKSCRIPT'
chmod +x /tmp/pre-push-hook
# Install hook in all git repos under common locations
for gitdir in /opt/cui-workspace/.git /home/claude-user/projects/*/.git; do
  if [ -d "$gitdir" ]; then
    cp /tmp/pre-push-hook "$gitdir/hooks/pre-push"
    chmod +x "$gitdir/hooks/pre-push"
    echo "  Hook installed: $gitdir/hooks/pre-push"
  fi
done
rm -f /tmp/pre-push-hook
HOOKSCRIPT
else
  echo "  WARNING: Hook file not found at $HOOK_SRC"
fi

echo ""
echo "Phase 3 complete."
echo ""

# ══════════════════════════════════════════════════════════════════════════
# Phase 4: Verification
# ══════════════════════════════════════════════════════════════════════════
echo "┌──────────────────────────────────────┐"
echo "│  Phase 4: Verification               │"
echo "└──────────────────────────────────────┘"

echo "[8/10] Verifying CUI service..."
sleep 3
SVC_STATUS=$(ssh "root@$TARGET" "systemctl is-active cui-workspace" 2>/dev/null || echo "inactive")
if [ "$SVC_STATUS" = "active" ]; then
  pass "CUI service running"
else
  fail "CUI service not running (status: $SVC_STATUS)"
fi

echo "[9/10] Verifying Infisical connectivity..."
INFISICAL_OK=$(ssh "root@$TARGET" "source /root/.infisical/infisical-api.sh && type fetch_infisical_secrets" 2>/dev/null && echo "yes" || echo "no")
if [ "$INFISICAL_OK" = "yes" ]; then
  pass "Infisical helpers loaded (incl. fetch_infisical_secrets)"
else
  fail "Infisical helpers not available"
fi

echo "[10/10] Verifying partner marker + app builds..."
MARKER=$(ssh "root@$TARGET" "[ -f /etc/cui-partner ] && echo 'yes' || echo 'no'" 2>/dev/null)
if [ "$MARKER" = "yes" ]; then
  pass "Partner marker (/etc/cui-partner) present"
else
  fail "Partner marker missing"
fi

# Check app builds
for APP_DIR in \
  /opt/cui-workspace/data/workspaces/werking-energy/apps/werking-energy \
  /opt/cui-workspace/data/workspaces/werking-report/apps/werking-report \
  /opt/cui-workspace/data/workspaces/werkingsafety/apps/werking-safety \
  /opt/cui-workspace/data/workspaces/engelmann-ai-hub/apps/engelmann; do
  APP_NAME=$(basename "$APP_DIR")
  RESULT=$(ssh "root@$TARGET" "/root/projekte/orchestrator/bin/verify-build-integrity '$APP_DIR' 2>&1 | head -1")
  if echo "$RESULT" | grep -q "✅"; then
    pass "$APP_NAME build verified"
  else
    fail "$APP_NAME build not verified: $RESULT"
  fi
done

# Check users
USERS_EXIST=$(ssh "root@$TARGET" "[ -f /opt/cui-workspace/data/users.json ] && echo 'yes' || echo 'no'" 2>/dev/null || echo "no")
if [ "$USERS_EXIST" = "yes" ]; then
  USER_COUNT=$(ssh "root@$TARGET" "jq '.users | length' /opt/cui-workspace/data/users.json" 2>/dev/null || echo "0")
  pass "users.json present ($USER_COUNT users)"
else
  echo "  INFO: No users.json yet — create with create-partner-users.sh"
fi

# Summary
PARTNER_IP=$(ssh "root@$TARGET" "tailscale ip -4" 2>/dev/null || echo "$TARGET")

echo ""
echo "========================================"
echo "  SETUP COMPLETE"
echo "========================================"
echo ""
echo "  Results: $passed passed, $failed failed"
echo "  CUI URL: http://$PARTNER_IP:4005"
echo ""
if [ "$failed" -gt 0 ]; then
  echo "  Some checks failed — review output above."
  echo "  Logs:  ssh root@$TARGET journalctl -u cui-workspace -n 50"
fi
echo ""
echo "  Quick test:"
echo "    curl -s http://$PARTNER_IP:4005/api/health | jq ."
echo ""
