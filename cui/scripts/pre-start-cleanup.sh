#!/bin/bash
# Kill ONLY the CUI server process on its ports.
# NEVER kill tail processes or session wrappers here — they must survive server restarts.
# Claude Code sessions (cui-session-wrapper) are long-lived and independent of the server.
for p in 4005 5001 5002 5003 5004; do
  fuser -k $p/tcp 2>/dev/null || true
done
sleep 1
exit 0
