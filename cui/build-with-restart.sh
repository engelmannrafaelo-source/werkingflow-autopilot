#!/bin/bash
# CUI Workspace - Robust Build + Restart Script
# Based on orchestrator's multi-method PID detection system

set -e

APP_NAME="CUI"
APP_DIR="/root/projekte/werkingflow/autopilot/cui"
PORT=4005
LOG_FILE="/tmp/cui-server.log"

echo "===[1/4]=== Stopping $APP_NAME Server ==="

# Multi-method PID detection (same as orchestrator build scripts)
PIDS=$(ss -tlnp 2>/dev/null | grep ":$PORT" | grep -oP 'pid=\K[0-9]+' | sort -u)
[ -z "$PIDS" ] && PIDS=$(lsof -ti:$PORT 2>/dev/null || true)
[ -z "$PIDS" ] && PIDS=$(pgrep -f "tsx server/index.ts" || true)
[ -z "$PIDS" ] && PIDS=$(fuser $PORT/tcp 2>/dev/null || true)

if [ -n "$PIDS" ]; then
  echo "Found PID(s): $PIDS"
  for pid in $PIDS; do
    echo "Killing PID $pid..."
    kill -9 $pid 2>/dev/null || true
  done
  sleep 2
else
  echo "No running server found"
fi

# Double-check port is free
for i in {1..5}; do
  if lsof -ti:$PORT >/dev/null 2>&1; then
    echo "Port $PORT still in use, waiting..."
    sleep 1
  else
    echo "Port $PORT is free"
    break
  fi
done

echo "===[2/4]=== Building Frontend ==="
cd "$APP_DIR"

# Load env vars
[ -f /root/.bash_env ] && source /root/.bash_env

# Build frontend
npm run build
echo "✓ Build complete"

echo "===[3/4]=== Validating Build ==="
if [ ! -f "$APP_DIR/dist/index.html" ]; then
  echo "✗ Build failed - no index.html found"
  exit 1
fi
echo "✓ Build artifacts present"

echo "===[4/4]=== Starting Server ==="
cd "$APP_DIR"
nohup npm run dev:server > "$LOG_FILE" 2>&1 &
NEW_PID=$!
echo "Started with PID: $NEW_PID"

# Wait for server to be ready
echo "Waiting for server..."
for i in {1..30}; do
  if curl -s -o /dev/null -w "%{http_code}" http://localhost:$PORT/api/version | grep -q "200"; then
    echo "✓ Server is UP and responding!"
    exit 0
  fi
  sleep 1
done

echo "✗ Server did not start within 30s"
echo "Last 20 lines of log:"
tail -20 "$LOG_FILE"
exit 1
