#!/bin/bash
# Start CUI Workspace in production mode
cd $(dirname $0)

# Build frontend
echo "Building frontend..."
npx vite build 2>&1 | tail -3

# Kill existing server
lsof -ti:4005,5001 2>/dev/null | xargs -r kill 2>/dev/null
sleep 1

# Start in production mode
NODE_ENV=production PORT=4005 \
  WERKING_REPORT_ADMIN_SECRET="${WERKING_REPORT_ADMIN_SECRET:-${ADMIN_SECRET:-}}" \
  nohup npx tsx server/index.ts > /tmp/cui-server.log 2>&1 &
sleep 3

if curl -s http://localhost:4005/ > /dev/null 2>&1; then
    echo "CUI Workspace running in production mode on :4005"
else
    echo "ERROR: Server not responding"
    tail -5 /tmp/cui-server.log
fi
