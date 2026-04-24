#!/bin/bash
# ============================================================================
# CUI Workspace - Staging Stop Script
# ============================================================================
# Stops the staging instance on port 4105. NEVER touches port 4005.
# ============================================================================
set -e

STAGING_PORT=4105
STAGING_PID_FILE=/tmp/cui-staging.pid

# ── Find PID ──────────────────────────────────────────────────────────────────
TARGET_PID=""

if [ -f "$STAGING_PID_FILE" ]; then
  STORED_PID=$(cat "$STAGING_PID_FILE")
  # Verify PID exists AND is bound to the staging port (not live port!)
  if kill -0 "$STORED_PID" 2>/dev/null; then
    if ss -tlnp 2>/dev/null | grep ":${STAGING_PORT} " | grep -q "pid=${STORED_PID},"; then
      TARGET_PID="$STORED_PID"
    else
      echo "[staging] WARNING: Stored PID $STORED_PID is not listening on :${STAGING_PORT} — stale PID file"
    fi
  fi
fi

# Fallback: find via ss
if [ -z "$TARGET_PID" ]; then
  TARGET_PID=$(ss -tlnp 2>/dev/null | grep ":${STAGING_PORT} " | grep -oP 'pid=\K[0-9]+' | head -1 || true)
fi

if [ -z "$TARGET_PID" ]; then
  echo "[staging] No staging instance found on port ${STAGING_PORT}."
  rm -f "$STAGING_PID_FILE"
  exit 0
fi

# ── Safety: never kill port 4005 ─────────────────────────────────────────────
LIVE_PORT=4005
if ss -tlnp 2>/dev/null | grep ":${LIVE_PORT} " | grep -q "pid=${TARGET_PID},"; then
  echo "[staging] ERROR: PID ${TARGET_PID} is listening on live port ${LIVE_PORT} — refusing to kill!"
  exit 1
fi

# ── Stop ──────────────────────────────────────────────────────────────────────
echo "[staging] Stopping PID ${TARGET_PID} (port ${STAGING_PORT})..."
kill -TERM "$TARGET_PID" 2>/dev/null || true

for i in $(seq 1 5); do
  sleep 1
  if ! kill -0 "$TARGET_PID" 2>/dev/null; then
    break
  fi
done

if kill -0 "$TARGET_PID" 2>/dev/null; then
  echo "[staging] SIGTERM ignored — sending SIGKILL..."
  kill -9 "$TARGET_PID" 2>/dev/null || true
fi

rm -f "$STAGING_PID_FILE"
echo "[staging] Staging instance stopped."
