#!/bin/bash
# ============================================================================
# CUI Workspace - Local Build Script
# ============================================================================
# USAGE: npm run build:local
# This script provides: Stop → Build → Validate → Start
# Prevents race conditions where running server corrupts build files
# ============================================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

# Load environment variables
[ -f /home/claude-user/.bashrc ] && source /home/claude-user/.bashrc || true

# Read configuration from app-config.json
if [ ! -f "app-config.json" ]; then
    echo "❌ ERROR: app-config.json not found!"
    exit 1
fi

APP_NAME=$(jq -r '.app_id' app-config.json)
APP_PORT=$(jq -r '.ports.local' app-config.json)

echo "========================================"
echo "  ${APP_NAME^^} - LOCAL BUILD"
echo "========================================"
echo "  Port: $APP_PORT"
echo "========================================"
echo ""

# ============================================================================
# [1/4] STOP SERVER BEFORE BUILDING
# ============================================================================
echo "[1/4] Stopping server..."

# Multi-method PID detection
SERVER_PIDS=""

# Method 1: ss (socket statistics)
SERVER_PIDS=$(sudo ss -tlnp 2>/dev/null | grep ":$APP_PORT " | grep -oP 'pid=\K[0-9]+' || echo "")

# Method 2: lsof (fallback)
if [ -z "$SERVER_PIDS" ]; then
  SERVER_PIDS=$(sudo lsof -ti:$APP_PORT 2>/dev/null || echo "")
fi

# Method 3: pgrep (fallback for tsx)
if [ -z "$SERVER_PIDS" ]; then
  SERVER_PIDS=$(pgrep -f "tsx server/index.ts" 2>/dev/null || echo "")
fi

# Method 4: fuser (last resort)
if [ -z "$SERVER_PIDS" ]; then
  SERVER_PIDS=$(fuser $APP_PORT/tcp 2>/dev/null | awk '{print $1}' || echo "")
fi

if [ -n "$SERVER_PIDS" ]; then
    for PID in $SERVER_PIDS; do
        sudo kill $PID 2>/dev/null || true
    done
    echo "✓ Server stopped (PID: $SERVER_PIDS)"

    # Wait for port to be free (max 4 seconds)
    for i in {1..20}; do
        PORT_CHECK=$(sudo ss -tlnp 2>/dev/null | grep ":$APP_PORT " || echo "")
        if [ -z "$PORT_CHECK" ]; then
            echo "✓ Port $APP_PORT is free"
            break
        fi
        sleep 0.2
    done
else
    echo "✓ No server running"
fi
echo ""

# ============================================================================
# [2/4] BUILD
# ============================================================================
echo "[2/4] Building frontend..."

npm run build

if [ $? -ne 0 ]; then
    echo "❌ Build failed!"
    exit 1
fi

echo "✓ Build complete"
echo ""

# ============================================================================
# [3/4] VALIDATE
# ============================================================================
echo "[3/4] Validating build..."

if [ ! -f "dist/index.html" ]; then
    echo "❌ Build validation failed: dist/index.html not found"
    exit 1
fi

echo "✓ Build artifacts validated"
echo ""

# ============================================================================
# [4/4] START SERVER
# ============================================================================
echo "[4/4] Starting server..."

# Start via nohup (detached from shell)
nohup npm run start:local > /tmp/cui-build.log 2>&1 &
SERVER_PID=$!

echo "✓ Server started (PID: $SERVER_PID)"
echo ""

# Wait for server to be ready (max 30 seconds)
echo "Waiting for server to respond..."
for i in {1..60}; do
    if curl -s http://localhost:$APP_PORT/api/version > /dev/null 2>&1; then
        echo "✓ Server is ready!"
        echo ""
        echo "========================================"
        echo "  ✓ BUILD COMPLETE"
        echo "========================================"
        echo "  URL: http://localhost:$APP_PORT"
        echo "  Logs: /tmp/cui-build.log"
        echo "========================================"
        exit 0
    fi
    sleep 0.5
done

echo "⚠ Server started but did not respond to health check"
echo "  Check logs: tail -f /tmp/cui-build.log"
exit 0
