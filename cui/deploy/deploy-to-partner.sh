#!/bin/bash
# ============================================================================
# Deploy CUI to Partner Server — Git Push-based
# ============================================================================
# Run from the DEV SERVER. Splits the autopilot/cui subtree into standalone
# commits and pushes to Partner's bare receive repo. The post-receive hook
# on Partner checks out files, runs npm install + vite build, restarts service.
#
# USAGE:
#   ./deploy-to-partner.sh [tailscale-ip]            # default: 100.119.199.86
#   DRY_RUN=1 ./deploy-to-partner.sh                 # skip push, validate only
#
# Prerequisites (one-time):
#   ./deploy/setup-partner-git.sh [ip]               # sets up bare repo + hook
#
# Architecture:
#   Dev-server:
#     /root/projekte/werkingflow/autopilot/ (git, branch: develop)
#       cui/                               CUI code subdirectory
#
#   Partner-server:
#     /opt/cui-workspace-bare.git/         bare receive repo + post-receive hook
#     /opt/cui-workspace/                  live checkout (work tree)
# ============================================================================
set -euo pipefail

TARGET="${1:-100.119.199.86}"
DRY_RUN="${DRY_RUN:-0}"
AUTOPILOT_DIR="/root/projekte/werkingflow/autopilot"
PARTNER_BARE="root@$TARGET:/opt/cui-workspace-bare.git"
BRANCH="develop"

echo "========================================"
echo "  Deploy CUI → $TARGET  (git push)"
[ "$DRY_RUN" = "1" ] && echo "  DRY RUN — push skipped"
echo "========================================"

# ── 1. Verify Partner bare repo exists ──────────────────────────────────
if ! ssh "root@$TARGET" "[ -d /opt/cui-workspace-bare.git/.git ] || [ -f /opt/cui-workspace-bare.git/HEAD ]" 2>/dev/null; then
  echo "ERROR: Partner bare repo not found at /opt/cui-workspace-bare.git"
  echo "Run: ./deploy/setup-partner-git.sh $TARGET"
  exit 1
fi

# ── 2. Subtree split: extract cui/ as standalone commits ─────────────────
echo "[1/3] Splitting autopilot/cui subtree..."
cd "$AUTOPILOT_DIR"
SPLIT_COMMIT=$(git subtree split --prefix=cui -b _cui-split-tmp 2>/dev/null)
echo "  Split commit: ${SPLIT_COMMIT:0:12}"

# ── 3. Push to Partner (triggers post-receive: checkout + npm + build + restart)
if [ "$DRY_RUN" = "1" ]; then
  git branch -D _cui-split-tmp 2>/dev/null || true
  echo ""
  echo "  DRY RUN: would git push --force $PARTNER_BARE _cui-split-tmp:$BRANCH"
  echo "  Post-receive hook would: git checkout → npm install → vite build → systemctl restart"
  echo ""
  echo "  Dry run complete. Remove DRY_RUN=1 to deploy."
  exit 0
fi

echo "[2/3] Pushing to Partner (triggers: checkout + npm install + build + restart)..."
git push --force "$PARTNER_BARE" "_cui-split-tmp:$BRANCH"
git branch -D _cui-split-tmp 2>/dev/null || true
echo "  Push complete — waiting for Partner post-receive hook..."
sleep 30  # Hook runs npm install + vite build (takes ~20-30s)

# ── 4. Sync orchestrator/bin + verify ───────────────────────────────────
echo "[3/3] Syncing orchestrator/bin + verifying..."

ORCH_BIN="/root/projekte/orchestrator/bin"
if [ -d "$ORCH_BIN" ]; then
  ssh "root@$TARGET" "mkdir -p /root/projekte/orchestrator/bin"
  rsync -avz --delete \
    "$ORCH_BIN/" "root@$TARGET:/root/projekte/orchestrator/bin/"
  ssh "root@$TARGET" "chmod +x /root/projekte/orchestrator/bin/*"
  echo "  orchestrator/bin synced"
fi

# ── 4b. Ensure tester-po image is present on Partner ─────────────────────
# Idempotent — skipped if image already loaded with matching ID.
HAS_IMAGE=$(ssh "root@$TARGET" "docker image inspect tester-po:latest --format '{{.Id}}' 2>/dev/null || echo missing")
if [ "$HAS_IMAGE" = "missing" ]; then
  echo "  tester-po:latest missing on Partner — shipping..."
  SHIP_SCRIPT="$(dirname "$0")/ship-tester-po-image.sh"
  if [ -x "$SHIP_SCRIPT" ]; then
    "$SHIP_SCRIPT" "$TARGET"
  else
    echo "  WARNING: $SHIP_SCRIPT not executable — PO test runs will fail until image is shipped"
  fi
else
  echo "  tester-po:latest present (${HAS_IMAGE:0:23}...)"
fi

STATUS=$(ssh "root@$TARGET" "systemctl is-active cui-workspace" 2>/dev/null || echo "failed")
AUTH_CHECK=$(ssh "root@$TARGET" "curl -sf http://localhost:4005/api/auth/status 2>/dev/null || echo 'unreachable'")

echo ""
echo "========================================"
if [ "$STATUS" = "active" ]; then
  echo "  DEPLOY SUCCESS"
  echo "  CUI at: http://$TARGET:4005"
  echo "  Auth:   $AUTH_CHECK"
  if echo "$AUTH_CHECK" | grep -q '"partnerCui":true'; then
    echo "  PARTNER_MODE: ACTIVE ✓"
  else
    echo "  WARNING: partnerCui not true — check PARTNER_MODE env var on Partner"
  fi
else
  echo "  DEPLOY FAILED: service status = $STATUS"
  echo "  Logs: ssh root@$TARGET journalctl -u cui-workspace -n 50"
fi
echo "========================================"
