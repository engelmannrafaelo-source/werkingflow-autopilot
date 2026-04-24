#!/bin/bash
# ============================================================================
# CUI Workspace - Staging Start Script (:4105)
# ============================================================================
# Starts a PARALLEL staging instance on port 4105 for sub-session testing.
# Uses /tmp/cui-staging-data as isolated data directory.
# Shares the existing dist/ snapshot (frontend not rebuilt).
#
# USAGE:
#   npm run start:staging          # normal start
#   npm run reset:staging          # reset data + start
#
# ZERO-IMPACT: Never touches port 4005 or the live data/ directory.
# ============================================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

STAGING_PORT=4105
LIVE_PORT=4005
STAGING_DATA=/tmp/cui-staging-data
STAGING_PID_FILE=/tmp/cui-staging.pid
STAGING_LOG=/tmp/cui-staging.log
RESET_DATA=false

# ── Parse flags ─────────────────────────────────────────────────────────────
for arg in "$@"; do
  case "$arg" in
    --reset-data) RESET_DATA=true ;;
    *) echo "[staging] Unknown argument: $arg" && exit 1 ;;
  esac
done

# ── 1. Guard: Live CUI must be up ────────────────────────────────────────────
if ! ss -tlnp 2>/dev/null | grep -q ":${LIVE_PORT} "; then
  echo "[staging] ERROR: Live CUI (port ${LIVE_PORT}) is NOT running."
  echo "[staging] Staging is only useful when live CUI is active — aborting."
  exit 1
fi

# ── 2. Guard: Staging port must be free ──────────────────────────────────────
if ss -tlnp 2>/dev/null | grep -q ":${STAGING_PORT} "; then
  echo "[staging] ERROR: Port ${STAGING_PORT} is already in use."
  echo "[staging] Run 'npm run stop:staging' first."
  exit 1
fi

# ── 3. Init or reset staging data ────────────────────────────────────────────
if [ "$RESET_DATA" = "true" ] && [ -d "$STAGING_DATA" ]; then
  echo "[staging] Resetting staging data..."
  rm -rf "$STAGING_DATA"
fi

if [ ! -d "$STAGING_DATA" ]; then
  echo "[staging] Initializing staging data from data/..."
  cp -r data/ "$STAGING_DATA"
  echo "[staging] Staging data ready at $STAGING_DATA"
else
  echo "[staging] Using existing staging data at $STAGING_DATA (use --reset-data to reset)"
fi

# ── 4. Load Infisical helpers (same as start-local.sh) ───────────────────────
INFISICAL_LOADED=false

if [ -f /home/claude-user/.bashrc ]; then
  source /home/claude-user/.bashrc 2>/dev/null || true
fi

if ! type infisical_get_secret &>/dev/null; then
  for api_script in \
    "${CUI_INFISICAL_API_SCRIPT:-}" \
    /root/.infisical/infisical-api.sh \
    /home/claude-user/.infisical/infisical-api.sh \
    /opt/infisical/infisical-api.sh; do
    if [ -n "$api_script" ] && [ -f "$api_script" ]; then
      source "$api_script" 2>/dev/null || true
      break
    fi
  done
fi

if type infisical_get_secret &>/dev/null; then
  INFISICAL_LOADED=true
fi

# ── 5. Inject secrets from Infisical ─────────────────────────────────────────
_inject_infisical_secret() {
  local var_name="$1" ws_id="$2" env="$3" secret_name="$4"
  eval "local current_val=\${$var_name}"
  if [ -n "$current_val" ]; then return 0; fi
  if [ "$INFISICAL_LOADED" != "true" ]; then return 0; fi
  local val
  val=$(infisical_get_secret "$ws_id" "$env" "$secret_name" 2>/dev/null) || true
  if [ -n "$val" ] && [ "$val" != "NOT_FOUND" ]; then
    export "$var_name=$val"
  fi
  return 0
}

if [ "$INFISICAL_LOADED" = "true" ]; then
  _inject_infisical_secret AI_BRIDGE_API_KEY "${INFISICAL_WS_DEV_SERVER:-}" dev AI_BRIDGE_API_KEY
  _inject_infisical_secret VERCEL_TOKEN "${INFISICAL_WS_DEV_SERVER:-}" dev VERCEL_TOKEN
  _inject_infisical_secret WERKING_REPORT_ADMIN_SECRET "${INFISICAL_WS_WERKING_REPORT:-}" dev ADMIN_SECRET

  if [ -z "$INFISICAL_API_TOKEN" ] && type _infisical_token &>/dev/null; then
    _token=$(_infisical_token 2>/dev/null) || true
    [ -n "$_token" ] && export INFISICAL_API_TOKEN="$_token"
    unset _token
  fi

  _inject_infisical_secret CUI_APP_HOST "${INFISICAL_WS_DEV_SERVER:-}" dev CUI_APP_HOST
  _inject_infisical_secret ERROR_WEBHOOK_SECRET "${INFISICAL_WS_DEV_SERVER:-}" dev ERROR_WEBHOOK_SECRET
  _inject_infisical_secret IONOS_EMAIL     "${INFISICAL_WS_DEV_SERVER:-}" dev IONOS_EMAIL
  _inject_infisical_secret IONOS_PASSWORD  "${INFISICAL_WS_DEV_SERVER:-}" dev IONOS_PASSWORD
  _inject_infisical_secret IONOS_FROM_NAME "${INFISICAL_WS_DEV_SERVER:-}" dev IONOS_FROM_NAME
fi

if [ -f .env ]; then
  set -a; source .env || true; set +a
fi

# ── 6. Start staging server ───────────────────────────────────────────────────
echo ""
echo "========================================"
echo "  CUI STAGING - STARTING (:${STAGING_PORT})"
echo "========================================"
echo "  Live port:     ${LIVE_PORT} (untouched)"
echo "  Staging port:  ${STAGING_PORT}"
echo "  Data dir:      ${STAGING_DATA}"
echo "  Log:           ${STAGING_LOG}"
echo "  Infisical:     $([ "$INFISICAL_LOADED" = "true" ] && echo 'connected' || echo 'NOT AVAILABLE')"
echo "========================================"
echo ""

export PORT="${STAGING_PORT}"
export CUI_LOCAL_MODE=true
export CUI_DATA_DIR="${STAGING_DATA}"
export NODE_ENV=production

nohup npx tsx server/index.ts > "$STAGING_LOG" 2>&1 &
STAGING_PID=$!
echo "$STAGING_PID" > "$STAGING_PID_FILE"

# ── 7. Wait for readiness (max 30s) ──────────────────────────────────────────
echo "[staging] Waiting for server to start (PID=$STAGING_PID)..."
READY=false
for i in $(seq 1 30); do
  sleep 1
  if curl -sf "http://localhost:${STAGING_PORT}/api/panels/inspect" > /dev/null 2>&1; then
    READY=true
    break
  fi
  if ! kill -0 "$STAGING_PID" 2>/dev/null; then
    echo "[staging] ERROR: Server process died. Check log: $STAGING_LOG"
    exit 1
  fi
done

if [ "$READY" = "true" ]; then
  echo ""
  echo "[staging] ✓ Staging CUI running"
  echo "  URL:  http://localhost:${STAGING_PORT}"
  echo "  PID:  $STAGING_PID"
  echo "  Log:  $STAGING_LOG"
  echo ""
else
  echo "[staging] ERROR: Server did not respond within 30s. Check: $STAGING_LOG"
  kill "$STAGING_PID" 2>/dev/null || true
  rm -f "$STAGING_PID_FILE"
  exit 1
fi
