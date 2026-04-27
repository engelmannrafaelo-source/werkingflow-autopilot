#!/bin/bash
# ============================================================================
# CUI Workspace - Universal Start Script
# ============================================================================
# Works on BOTH dev-server and partner-server.
# ALL secrets are loaded from Infisical. No .env secrets needed.
#
# USAGE: npm run start:local  OR  systemd (cui-workspace.service)
#
# Requirements:
#   - Infisical helper: /root/.infisical/infisical-api.sh (or via .bashrc)
#   - Infisical workspace IDs as env vars ($INFISICAL_WS_*)
#   - Network access to Infisical server (Tailscale)
# ============================================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

# ── 0. Pre-start cleanup ────────────────────────────────────────────────
# Always run port-cleanup BEFORE starting. Prevents zombie tsx servers when
# launched manually (systemd already handles this via ExecStartPre, but manual
# `npm run start:local` invocations were producing parallel servers — duplicate
# setInterval timers caused weeks of sub-session reminder spam).
bash "$SCRIPT_DIR/pre-start-cleanup.sh"

# ── 1. Load Infisical helpers ────────────────────────────────────────────
# Try multiple paths: bashrc (dev-server), direct source, or env already set
INFISICAL_LOADED=false

# Path 1: bashrc (loads helpers + workspace IDs)
if [ -f /home/claude-user/.bashrc ]; then
  source /home/claude-user/.bashrc 2>/dev/null || true
fi

# Path 2: direct source if helpers not yet available
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

# ── 2. Load .env for non-secret config (URLs, feature flags) ────────────
# Secrets should NOT be in .env — they come from Infisical.
if [ -f .env ]; then
  set -a
  source .env || true
  set +a
fi

# ── 3. Inject secrets from Infisical ────────────────────────────────────
_inject_infisical_secret() {
  local var_name="$1" ws_id="$2" env="$3" secret_name="$4"
  eval "local current_val=\${$var_name}"
  if [ -n "$current_val" ]; then return 0; fi  # already set
  if [ "$INFISICAL_LOADED" != "true" ]; then return 0; fi
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

if [ "$INFISICAL_LOADED" = "true" ]; then
  echo "[Startup] Injecting secrets from Infisical..."

  # CUI operational secrets
  # AI_BRIDGE_API_KEY/URL: from dev-server/dev (CUI infra secret, not an app secret)
  _inject_infisical_secret AI_BRIDGE_API_KEY "${INFISICAL_WS_DEV_SERVER:-}" dev AI_BRIDGE_API_KEY
  # VERCEL_TOKEN: from dev-server/dev (CUI infra secret for ops/deployments panel)
  _inject_infisical_secret VERCEL_TOKEN "${INFISICAL_WS_DEV_SERVER:-}" dev VERCEL_TOKEN
  # WR Admin Secret: read directly from werking-report/dev (SST — no copy in dev-server)
  _inject_infisical_secret WERKING_REPORT_ADMIN_SECRET "${INFISICAL_WS_WERKING_REPORT:-}" dev ADMIN_SECRET

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

  # CUI App Host (server-specific URL for browser panel links)
  # Uses Infisical env based on hostname: dev-server → dev, partner-server → prod
  _cui_infisical_env="dev"
  if [ -f /etc/cui-partner ] || [ "$(hostname)" = "partner-cui" ]; then
    _cui_infisical_env="prod"
  fi
  _inject_infisical_secret CUI_APP_HOST "${INFISICAL_WS_DEV_SERVER:-}" "$_cui_infisical_env" CUI_APP_HOST

  # Error Webhook Secret (shared with Sentry webhook + partner-forward — same value in dev/prod)
  _inject_infisical_secret ERROR_WEBHOOK_SECRET "${INFISICAL_WS_DEV_SERVER:-}" "$_cui_infisical_env" ERROR_WEBHOOK_SECRET

  # IONOS Mail (IMAP + SMTP for MailPanel — office@werking.tools)
  _inject_infisical_secret IONOS_EMAIL     "${INFISICAL_WS_DEV_SERVER:-}" dev IONOS_EMAIL
  _inject_infisical_secret IONOS_PASSWORD  "${INFISICAL_WS_DEV_SERVER:-}" dev IONOS_PASSWORD
  _inject_infisical_secret IONOS_FROM_NAME "${INFISICAL_WS_DEV_SERVER:-}" dev IONOS_FROM_NAME

  unset _cui_infisical_env

  # Syncthing API Key (config.xml first, Infisical fallback)
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
    fi
    unset _skey
  fi
else
  echo "[Startup] WARNING: Infisical not available — secrets must be pre-set in environment"
  echo "[Startup] Install: copy /root/.infisical/ to this server + ensure Tailscale access"
fi

# ── 4. Generate deterministic tokens ────────────────────────────────────
if [ -z "$CUI_REBUILD_TOKEN" ]; then
  _rtoken=$(echo -n "cui-rebuild-$(cat /etc/machine-id 2>/dev/null || hostname)" | sha256sum 2>/dev/null | cut -d' ' -f1) || true
  if [ -n "$_rtoken" ]; then
    export CUI_REBUILD_TOKEN="$_rtoken"
    echo "[Startup] CUI_REBUILD_TOKEN generated from machine-id"
  fi
  unset _rtoken
fi

# ── 5. Status ───────────────────────────────────────────────────────────
echo ""
echo "========================================"
echo "  CUI WORKSPACE - STARTING SERVER"
echo "========================================"
echo "  Port:          ${PORT:-4005}"
echo "  Mode:          ${NODE_ENV:-production}"
echo "  Infisical:     $([ "$INFISICAL_LOADED" = "true" ] && echo 'connected' || echo 'NOT AVAILABLE')"
echo "  Auth:          $([ -f "${CUI_DATA_DIR:-data}/users.json" ] && echo 'ENABLED (users.json)' || echo 'disabled')"
echo "  AI Bridge:     $([ -n "$AI_BRIDGE_API_KEY" ] && echo 'configured' || echo 'NOT SET')"
echo "  Infisical API: $([ -n "$INFISICAL_API_TOKEN" ] && echo 'configured' || echo 'NOT SET')"
echo "  Syncthing:     $([ -n "$SYNCTHING_API_KEY" ] && echo 'configured' || echo 'NOT SET')"
echo "  Rebuild Token: $([ -n "$CUI_REBUILD_TOKEN" ] && echo 'configured' || echo 'NOT SET')"
echo "  WR Admin:      $([ -n "$WERKING_REPORT_ADMIN_SECRET" ] && echo 'configured' || echo 'NOT SET')"
echo "  Vercel:        $([ -n "$VERCEL_TOKEN" ] && echo 'configured' || echo 'NOT SET')"
echo "  App Host:      ${CUI_APP_HOST:-http://localhost (default)}"
echo "========================================"
echo ""

# Start server
exec npx tsx server/index.ts
