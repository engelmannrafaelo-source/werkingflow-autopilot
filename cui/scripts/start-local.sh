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

# Load .env if present (key=value pairs)
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

echo "========================================"
echo "  CUI WORKSPACE - STARTING SERVER"
echo "========================================"
echo "  Port: ${PORT:-4005}"
echo "  Mode: ${NODE_ENV:-production}"
echo "========================================"
echo ""

# Start server
exec npx tsx server/index.ts
