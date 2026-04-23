#!/bin/bash
# CUI Server Startup Script with Environment Loading

# Pre-start cleanup: terminate zombie tsx servers on port 4005 before starting.
# Without this, parallel servers caused duplicate setInterval timers (sub-session
# reminder spam) and drifting in-memory parentSessions maps.
bash "$(dirname "$0")/scripts/pre-start-cleanup.sh"

# Load environment variables
if [ -f .env.server ]; then
  set -a  # automatically export all variables
  source .env.server
  set +a
  echo "✅ Loaded environment from .env.server"
else
  echo "⚠️ Warning: .env.server not found"
fi

# Start server with tsx (via npx if not in PATH)
if command -v tsx &> /dev/null; then
  exec tsx server/index.ts
else
  exec npx tsx server/index.ts
fi
