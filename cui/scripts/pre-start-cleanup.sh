#!/bin/bash
# Kill processes on CUI ports
for p in 4005 5001 5002 5003 5004; do
  fuser -k $p/tcp 2>/dev/null || true
done
# Kill orphan tail processes
pkill -f "tail.*cui-sessions" 2>/dev/null || true
sleep 1
exit 0
