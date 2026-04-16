#!/bin/bash
# =============================================================================
# Sync Worker Routing — Scrape + Route in einem Schritt
# =============================================================================
# 1. Scraped Account-Limits von claude.ai (→ JSON + Bridge Push)
# 2. Triggert smart-worker-routing.sh auf der Bridge (→ nginx Update)
#
# Cron: */5 * * * * /root/projekte/werkingflow/autopilot/cui/scripts/sync-worker-routing.sh >> /var/log/sync-worker-routing.log 2>&1
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CUI_DIR="$(dirname "$SCRIPT_DIR")"
BRIDGE_HOST="49.12.72.66"
LOG_TAG="[sync-routing]"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $LOG_TAG $*"; }

# ---- 1. Scrape account usage from claude.ai ----
log "Scraping claude.ai account usage..."
cd "$CUI_DIR"

# Source env for AI_BRIDGE_URL + AI_BRIDGE_API_KEY
[ -f /root/.bash_env ] && source /root/.bash_env 2>/dev/null

if npx tsx scripts/scrape-claude-usage.ts 2>&1 | tail -5; then
    log "Scrape complete. Data pushed to Bridge."
else
    log "WARNING: Scrape failed (session expired?). Smart-routing uses last known data."
fi

# ---- 2. Trigger smart-routing on Bridge ----
log "Triggering smart-worker-routing on Bridge..."
if ssh -o ConnectTimeout=5 -o BatchMode=yes "root@$BRIDGE_HOST" \
    'bash /root/werkingflow-bridge/scripts/smart-worker-routing.sh' 2>&1 | while read -r line; do log "  [bridge] $line"; done; then
    log "Smart routing updated."
else
    log "WARNING: Could not reach Bridge for routing update."
fi

log "Done."
