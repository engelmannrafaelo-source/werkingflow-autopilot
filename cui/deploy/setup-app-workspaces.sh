#!/bin/bash
# ============================================================================
# CUI Partner Server — App Workspace Setup
# ============================================================================
# Syncs monorepo app workspaces to partner server and builds all apps.
# Run from the DEV SERVER after deploy-to-partner.sh.
#
# USAGE:
#   ./setup-app-workspaces.sh <partner-tailscale-ip>
#
# What this does:
#   1. For each app workspace (energy, report, safety, engelmann):
#      a. Syncs monorepo via rsync (excluding node_modules, .next, .git)
#      b. Runs pnpm install (from monorepo root)
#      c. Sets up Python venvs for backend apps (energy, safety)
#      d. Generates .env.partner for apps needing Infisical secrets (engelmann)
#      e. Runs build:local (energy, report, safety) or build:live (engelmann)
#   2. Verifies all builds pass verify-build-integrity
#
# Apps and their build modes:
#   werking-energy   → build:local  (no Supabase, local storage)
#   werking-report   → build:local  (no Supabase, local storage)
#   werking-safety   → build:local  (no Supabase, local storage)
#   engelmann        → build:live   (requires Supabase, .env.partner for secrets)
#
# Prerequisites:
#   - deploy-to-partner.sh already ran (CUI + orchestrator/bin present)
#   - setup-partner-infisical.sh already ran (Infisical access configured)
#   - SSH access to partner as root (via Tailscale)
# ============================================================================
set -euo pipefail

TARGET="${1:-}"
MONOREPO_DIR="/root/projekte/werkingflow-production"
REMOTE_WORKSPACE_BASE="/opt/cui-workspace/data/workspaces"
ORCH_BIN="/root/projekte/orchestrator/bin"

if [ -z "$TARGET" ]; then
  echo "Usage: $0 <partner-tailscale-ip>"
  echo "Example: $0 100.119.199.86"
  exit 1
fi

source /root/.infisical/infisical-api.sh 2>/dev/null || true

echo "========================================"
echo "  App Workspace Setup → $TARGET"
echo "========================================"
echo ""

# App workspace definitions: workspace_name:app_dir:build_mode:has_backend
WORKSPACES=(
  "werking-energy:apps/werking-energy:local:yes"
  "werking-report:apps/werking-report:local:no"
  "werkingsafety:apps/werking-safety:local:yes"
  "engelmann-ai-hub:apps/engelmann:live:no"
)

# CLAUDE.md source files (relative to this script's deploy/ directory)
CLAUDE_MD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/workspace-claude-mds"

# ── 1. Sync each workspace ─────────────────────────────────────────────
echo "[1/4] Syncing monorepo to workspaces..."
for entry in "${WORKSPACES[@]}"; do
  WS_NAME="${entry%%:*}"
  rest="${entry#*:}"
  APP_SUBDIR="${rest%%:*}"

  echo "  Syncing $WS_NAME..."
  ssh "root@$TARGET" "mkdir -p $REMOTE_WORKSPACE_BASE/$WS_NAME"

  rsync -az --delete \
    --exclude 'node_modules' \
    --exclude '.next' \
    --exclude '.git' \
    --exclude '*.log' \
    --exclude 'apps/*/data/' \
    "$MONOREPO_DIR/" \
    "root@$TARGET:$REMOTE_WORKSPACE_BASE/$WS_NAME/"

  # Deploy workspace CLAUDE.md (user guide for this workspace)
  CLAUDE_MD_SRC="$CLAUDE_MD_DIR/$WS_NAME.md"
  if [ -f "$CLAUDE_MD_SRC" ]; then
    scp "$CLAUDE_MD_SRC" "root@$TARGET:$REMOTE_WORKSPACE_BASE/$WS_NAME/CLAUDE.md"
    echo "    CLAUDE.md deployed"
  else
    echo "    WARNING: No CLAUDE.md found at $CLAUDE_MD_SRC"
  fi

  echo "    Done"
done
echo ""

# ── 2. Setup Python backends ───────────────────────────────────────────
echo "[2/4] Setting up Python backends..."
for entry in "${WORKSPACES[@]}"; do
  IFS=':' read -r WS_NAME APP_SUBDIR BUILD_MODE HAS_BACKEND <<< "$entry"
  if [ "$HAS_BACKEND" != "yes" ]; then continue; fi

  BACKEND_DIR="$REMOTE_WORKSPACE_BASE/$WS_NAME/$APP_SUBDIR/backend"
  echo "  Setting up backend: $WS_NAME..."

  ssh "root@$TARGET" "
    if [ -f '$BACKEND_DIR/requirements.txt' ]; then
      rm -rf '$BACKEND_DIR/venv'
      python3 -m venv '$BACKEND_DIR/venv'
      '$BACKEND_DIR/venv/bin/pip' install -r '$BACKEND_DIR/requirements.txt' -q
      echo '    Backend venv ready: $WS_NAME'
    else
      echo '    No requirements.txt: $WS_NAME — skipping'
    fi
  "
done
echo ""

# ── 3. Generate .env.partner for apps that need Infisical secrets ──────
echo "[3/4] Generating .env.partner files..."

# Engelmann needs Supabase secrets from Infisical (prod)
if [ -n "${INFISICAL_WS_ENGELMANN:-}" ]; then
  echo "  Generating .env.partner for engelmann (Supabase secrets)..."
  ENGELMANN_SECRETS=$(fetch_infisical_secrets "$INFISICAL_WS_ENGELMANN" prod 2>/dev/null)
  if [ -n "$ENGELMANN_SECRETS" ]; then
    # Convert "export KEY='val'" to "KEY=val" format
    ENV_CONTENT=$(echo "$ENGELMANN_SECRETS" | sed "s/^export //; s/='\\(.*\\)'$/=\\1/")
    ssh "root@$TARGET" "cat > $REMOTE_WORKSPACE_BASE/engelmann-ai-hub/apps/engelmann/.env.partner << 'ENVEOF'
$ENV_CONTENT
ENVEOF"
    echo "    .env.partner written for engelmann"
  else
    echo "    WARNING: Could not fetch Engelmann secrets from Infisical"
  fi
else
  echo "  WARNING: INFISICAL_WS_ENGELMANN not set — skipping .env.partner"
fi
echo ""

# ── 4. Build all apps (sequential — RAM constraint) ────────────────────
echo "[4/4] Building apps (sequential to avoid OOM)..."

# Stop CUI to free RAM during builds
echo "  Stopping CUI service to free RAM..."
ssh "root@$TARGET" "systemctl stop cui-workspace.service 2>/dev/null || true"
sleep 2

BUILD_ERRORS=0

for entry in "${WORKSPACES[@]}"; do
  IFS=':' read -r WS_NAME APP_SUBDIR BUILD_MODE HAS_BACKEND <<< "$entry"
  APP_DIR="$REMOTE_WORKSPACE_BASE/$WS_NAME"
  APP_NAME=$(basename "$APP_SUBDIR")

  echo ""
  echo "  ── Building: $APP_NAME (build:$BUILD_MODE) ──"

  BUILD_LOG="/tmp/partner-build-$APP_NAME.log"

  # Run pnpm install + build sequentially
  ssh "root@$TARGET" "
    cd '$APP_DIR'
    echo y | pnpm install --frozen-lockfile 2>&1 | tail -2 || pnpm install 2>&1 | tail -2
    cd '$APP_SUBDIR'
    npm run build:$BUILD_MODE > '$BUILD_LOG' 2>&1
    tail -5 '$BUILD_LOG'
  " && echo "    ✅ $APP_NAME built successfully" || {
    echo "    ❌ $APP_NAME build FAILED — check $BUILD_LOG on partner server"
    BUILD_ERRORS=$((BUILD_ERRORS + 1))
  }
done

# Restart CUI
echo ""
echo "  Starting CUI service..."
ssh "root@$TARGET" "systemctl start cui-workspace.service"
sleep 3

# ── Verify all builds ──────────────────────────────────────────────────
echo ""
echo "Verifying build integrity..."
VERIFY_ERRORS=0
for entry in "${WORKSPACES[@]}"; do
  IFS=':' read -r WS_NAME APP_SUBDIR BUILD_MODE HAS_BACKEND <<< "$entry"
  APP_NAME=$(basename "$APP_SUBDIR")
  APP_BUILD_DIR="$REMOTE_WORKSPACE_BASE/$WS_NAME/$APP_SUBDIR"

  RESULT=$(ssh "root@$TARGET" "/root/projekte/orchestrator/bin/verify-build-integrity '$APP_BUILD_DIR' 2>&1 | head -1")
  if echo "$RESULT" | grep -q "✅"; then
    echo "  ✅ $APP_NAME"
  else
    echo "  ❌ $APP_NAME: $RESULT"
    VERIFY_ERRORS=$((VERIFY_ERRORS + 1))
  fi
done

# ── Summary ────────────────────────────────────────────────────────────
TOTAL_ERRORS=$((BUILD_ERRORS + VERIFY_ERRORS))
echo ""
echo "========================================"
if [ "$TOTAL_ERRORS" -eq 0 ]; then
  echo "  APP WORKSPACE SETUP COMPLETE"
  echo "  All apps built and verified"
else
  echo "  APP WORKSPACE SETUP: $TOTAL_ERRORS error(s)"
  echo "  Check build logs on partner server: /tmp/partner-build-*.log"
fi
echo "========================================"
