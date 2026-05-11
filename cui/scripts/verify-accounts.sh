#!/bin/bash
# Verify Account Identities — SSOT Check
#
# Liest /home/claude-user/.claude/accounts/registry.json und prüft fuer jeden
# Account:
#   1. OAuth-Token in credentials_path → anthropic-organization-id == expected
#   2. Cookie sessionKey in cookie_path → claude.ai org uuid == expected
#
# Bei Drift: schreibt /tmp/account-drift.flag (JSON) und exit 1.
# Bei OK: löscht das Flag und exit 0.
#
# Aufruf:
#   - Manuell: ./scripts/verify-accounts.sh
#   - Pre-Start: in CUI startup hook
#   - Cron: */5 * * * *

set -uo pipefail

# SSOT location — overridable via REGISTRY_PATH env var (partner-server may use registry-partner.json)
REGISTRY="${REGISTRY_PATH:-/home/claude-user/.claude/accounts/registry.json}"
DRIFT_FLAG="/tmp/account-drift.flag"
LOG_FILE="/var/log/account-verify.log"
# Falls /var/log nicht beschreibbar: fallback auf /tmp
[ ! -w "$(dirname $LOG_FILE)" ] && LOG_FILE="/tmp/account-verify.log"
touch "$LOG_FILE" 2>/dev/null || LOG_FILE="/tmp/account-verify.log"

ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "[$(ts)] $*" | tee -a "$LOG_FILE"; }

if [ ! -f "$REGISTRY" ]; then
  log "FATAL: Registry not found at $REGISTRY"
  exit 2
fi

DRIFTS=()
declare -A RESULTS

# Iteriere durch Registry
ACCOUNT_IDS=$(python3 -c "
import json
with open('$REGISTRY') as f:
    r = json.load(f)
for a in r['accounts']:
    print(a['id'])")

for acc_id in $ACCOUNT_IDS; do
  ENTRY=$(python3 -c "
import json
with open('$REGISTRY') as f:
    r = json.load(f)
for a in r['accounts']:
    if a['id'] == '$acc_id':
        print(json.dumps(a))
        break")

  EXPECTED_ORG=$(echo "$ENTRY" | python3 -c "import json,sys; print(json.load(sys.stdin)['anthropic_org_id'])")
  CRED_PATH=$(echo "$ENTRY" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('credentials_path',''))")
  COOKIE_PATH=$(echo "$ENTRY" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('cookie_path',''))")

  # === A) OAuth Token Check ===
  TOKEN_ORG=""
  if [ -f "$CRED_PATH" ]; then
    TOKEN=$(python3 -c "
import json
try:
    d = json.load(open('$CRED_PATH'))
    print(d['claudeAiOauth']['accessToken'])
except Exception as e:
    print('', end='')")
    if [ -n "$TOKEN" ]; then
      HEADERS=$(mktemp)
      curl -s --max-time 10 -D "$HEADERS" -o /dev/null -X POST https://api.anthropic.com/v1/messages \
        -H "Authorization: Bearer $TOKEN" \
        -H "anthropic-version: 2023-06-01" \
        -H "anthropic-beta: oauth-2025-04-20" \
        -H "content-type: application/json" \
        -d '{"model":"claude-haiku-4-5","max_tokens":1,"messages":[{"role":"user","content":"."}]}' 2>/dev/null || true
      TOKEN_ORG=$(grep -i "anthropic-organization-id" "$HEADERS" 2>/dev/null | cut -d' ' -f2 | tr -d '\r\n' || echo "")
      rm -f "$HEADERS"
    fi
  fi

  # === B) Cookie Check ===
  COOKIE_ORG=""
  if [ -f "$COOKIE_PATH" ]; then
    SK=$(python3 -c "
import json
try:
    d=json.load(open('$COOKIE_PATH'))
    for c in d.get('cookies', []):
        if c['name']=='sessionKey':
            print(c['value'])
            break
except: pass")
    if [ -n "$SK" ]; then
      RESPONSE=$(/usr/local/bin/curl_chrome116 -s --max-time 10 \
        "https://claude.ai/api/organizations" \
        -H "Cookie: sessionKey=$SK" 2>/dev/null || echo "[]")
      COOKIE_ORG=$(echo "$RESPONSE" | python3 -c "
import json,sys
try:
    d = json.loads(sys.stdin.read())
    if isinstance(d, list) and d:
        print(d[0].get('uuid',''))
except: pass" 2>/dev/null)
    fi
  fi

  # === C) Compare ===
  # Token check is mandatory. Cookie check is skipped if cookie_path empty (partner-server has no cookies).
  TOKEN_OK="❌"
  COOKIE_OK="N/A"
  [ "$TOKEN_ORG" = "$EXPECTED_ORG" ] && TOKEN_OK="✅"
  if [ -n "$COOKIE_PATH" ]; then
    COOKIE_OK="❌"
    [ "$COOKIE_ORG" = "$EXPECTED_ORG" ] && COOKIE_OK="✅"
  fi

  STATUS="OK"
  if [ "$TOKEN_OK" = "❌" ] || [ "$COOKIE_OK" = "❌" ]; then
    STATUS="DRIFT"
    DRIFTS+=("$acc_id")
  fi

  log "[$acc_id] $STATUS  expected=$EXPECTED_ORG  token=$TOKEN_OK($TOKEN_ORG)  cookie=$COOKIE_OK($COOKIE_ORG)"

  RESULTS[$acc_id]=$(python3 -c "
import json
print(json.dumps({
  'id': '$acc_id',
  'expected_org_id': '$EXPECTED_ORG',
  'token_org_id': '$TOKEN_ORG',
  'cookie_org_id': '$COOKIE_ORG',
  'token_match': '$TOKEN_OK' == '✅',
  'cookie_match': '$COOKIE_OK' == '✅',
  'status': '$STATUS'
}))")
done

# Drift-Flag schreiben oder loeschen
if [ ${#DRIFTS[@]} -gt 0 ]; then
  python3 -c "
import json
results = [$(IFS=,; echo "${RESULTS[*]}")]
with open('$DRIFT_FLAG', 'w') as f:
    json.dump({
        'timestamp': '$(ts)',
        'drifts': '${DRIFTS[*]}'.split(),
        'results': results
    }, f, indent=2)"
  log "FAIL: ${#DRIFTS[@]} account(s) drift: ${DRIFTS[*]} — flag written to $DRIFT_FLAG"
  exit 1
else
  rm -f "$DRIFT_FLAG"
  log "OK: all 4 accounts pass identity check"
  exit 0
fi
