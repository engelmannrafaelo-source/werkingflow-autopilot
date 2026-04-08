#!/bin/bash
# ============================================================================
# CUI Workspace - Start Local Server
# ============================================================================
# USAGE: npm run start:local  OR  systemd (cui-workspace.service)
# Starts the CUI server with proper environment variables
# ============================================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

# Load environment variables from bashrc (loads infisical helpers + WS IDs)
if [ -f /home/claude-user/.bashrc ]; then
  source /home/claude-user/.bashrc || true
fi

# Load .env if present (key=value pairs)
if [ -f .env ]; then
  set -a
  source .env || true
  set +a
fi

# ── Infisical Token Injection ──────────────────────────────────────────────
# Loads secrets from Infisical at startup using the JWT token generator.
# Pattern: check if var is set, if not try to load from Infisical.

_inject_infisical_secret() {
  local var_name="$1" ws_id="$2" env="$3" secret_name="$4"
  eval "local current_val=\${$var_name}"
  if [ -n "$current_val" ]; then return 0; fi  # already set
  if ! type infisical_get_secret &>/dev/null; then return 0; fi
  local val
  val=$(infisical_get_secret "$ws_id" "$env" "$secret_name" 2>/dev/null) || true
  if [ -n "$val" ] && [ "$val" != "NOT_FOUND" ]; then
    export "$var_name=$val"
    echo "[Infisical] $var_name loaded"
  else
    echo "[Infisical] WARNING: $var_name not found ($secret_name in $env)"
  fi
  return 0
}

echo "[Startup] Injecting secrets from Infisical..."

# AI Bridge API Key (from Engelmann workspace, shared across all apps)
_inject_infisical_secret AI_BRIDGE_API_KEY "${INFISICAL_WS_ENGELMANN:-}" prod AI_BRIDGE_API_KEY

# WR Admin Secret (from werking-report workspace)
_inject_infisical_secret WERKING_REPORT_ADMIN_SECRET "${INFISICAL_WS_WERKING_REPORT:-}" prod ADMIN_SECRET

# Admin Seed Secret (from werking-report workspace)
_inject_infisical_secret ADMIN_SEED_SECRET "${INFISICAL_WS_WERKING_REPORT:-}" prod ADMIN_SEED_SECRET

# Vercel API Token (from platform workspace)
_inject_infisical_secret VERCEL_TOKEN "${INFISICAL_WS_PLATFORM:-}" prod VERCEL_TOKEN

# Infisical API Token (fresh JWT for Infisical Monitor panel)
if [ -z "$INFISICAL_API_TOKEN" ] && type _infisical_token &>/dev/null; then
  _token=$(_infisical_token 2>/dev/null) || true
  if [ -n "$_token" ]; then
    export INFISICAL_API_TOKEN="$_token"
    echo "[Infisical] INFISICAL_API_TOKEN generated (fresh JWT)"
  else
    echo "[Infisical] WARNING: Could not generate INFISICAL_API_TOKEN"
  fi
  unset _token
fi

# Syncthing API Key (from config.xml — may not be readable by claude-user)
if [ -z "$SYNCTHING_API_KEY" ]; then
  _skey=""
  for cfg in /root/.local/state/syncthing/config.xml /home/claude-user/.local/state/syncthing/config.xml /etc/syncthing/config.xml; do
    if [ -r "$cfg" ]; then
      _skey=$(sed -n 's/.*<apikey>\(.*\)<\/apikey>.*/\1/p' "$cfg" 2>/dev/null) || true
      [ -n "$_skey" ] && break
    fi
  done
  if [ -n "$_skey" ]; then
    export SYNCTHING_API_KEY="$_skey"
    echo "[Startup] SYNCTHING_API_KEY loaded from syncthing config"
  else
    # Fallback: try infisical
    _inject_infisical_secret SYNCTHING_API_KEY "${INFISICAL_WS_DEV_SERVER:-}" prod SYNCTHING_API_KEY
  fi
  unset _skey
fi

# CUI Rebuild Token (generate deterministic token from machine-id if not set)
if [ -z "$CUI_REBUILD_TOKEN" ]; then
  _rtoken=$(echo -n "cui-rebuild-$(cat /etc/machine-id 2>/dev/null || hostname)" | sha256sum 2>/dev/null | cut -d' ' -f1) || true
  if [ -n "$_rtoken" ]; then
    export CUI_REBUILD_TOKEN="$_rtoken"
    echo "[Startup] CUI_REBUILD_TOKEN generated from machine-id"
  fi
  unset _rtoken
fi

echo ""
echo "========================================"
echo "  CUI WORKSPACE - STARTING SERVER"
echo "========================================"
echo "  Port: ${PORT:-4005}"
echo "  Mode: ${NODE_ENV:-production}"
echo "  AI Bridge:     $([ -n "$AI_BRIDGE_API_KEY" ] && echo 'configured' || echo 'NOT SET')"
echo "  Infisical API: $([ -n "$INFISICAL_API_TOKEN" ] && echo 'configured' || echo 'NOT SET')"
echo "  Syncthing:     $([ -n "$SYNCTHING_API_KEY" ] && echo 'configured' || echo 'NOT SET')"
echo "  Rebuild Token: $([ -n "$CUI_REBUILD_TOKEN" ] && echo 'configured' || echo 'NOT SET')"
echo "  WR Admin:      $([ -n "$WERKING_REPORT_ADMIN_SECRET" ] && echo 'configured' || echo 'NOT SET')"
echo "  Vercel:        $([ -n "$VERCEL_TOKEN" ] && echo 'configured' || echo 'NOT SET')"
echo "========================================"
echo ""

# Start server
exec npx tsx server/index.ts
