#!/bin/bash
# Robust CUI Server Restart Script
# Called by /api/rebuild-frontend after successful build

set -e

CUI_DIR="/root/projekte/werkingflow/autopilot/cui"
LOG_FILE="/tmp/cui-server-restart.log"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] CUI Server Restart initiated" >> "$LOG_FILE"

# Step 1: Find and kill old server process
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Killing old server..." >> "$LOG_FILE"
pkill -9 -f "tsx server/index.ts" 2>/dev/null || true
pkill -9 -f "server/index.ts" 2>/dev/null || true
sleep 1

# Step 2: Wait for port 4005 to be free
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Waiting for port 4005 to be free..." >> "$LOG_FILE"
for i in {1..10}; do
  if ! lsof -ti:4005 >/dev/null 2>&1; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Port 4005 is free" >> "$LOG_FILE"
    break
  fi
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Port still in use, waiting..." >> "$LOG_FILE"
  sleep 1
done

# Step 3: Start new server
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting new server..." >> "$LOG_FILE"
cd "$CUI_DIR"
nohup npm run dev:server > /tmp/cui-server.log 2>&1 &
NEW_PID=$!
echo "[$(date '+%Y-%m-%d %H:%M:%S')] New server started with PID: $NEW_PID" >> "$LOG_FILE"

# Step 4: Wait for server to be ready
sleep 3
if curl -s http://localhost:4005/api/version >/dev/null 2>&1; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Server is UP and responding!" >> "$LOG_FILE"
else
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] WARNING: Server may not be ready yet" >> "$LOG_FILE"
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Restart complete" >> "$LOG_FILE"
