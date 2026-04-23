#!/bin/bash
# Kill any existing CUI server instance on port 4005 before starting a new one.
# Defends against zombies: parallel tsx server/index.ts processes have caused
# duplicate setInterval timers (sub-session reminder spam) and drifting
# in-memory parentSessions maps.
#
# NEVER kill cui-session-wrapper processes here — they are long-lived and
# independent of the server (Claude Code sessions). Wrapper cleanup happens
# in claude-cli.ts on server start (orphaned wrappers with PPID=1).
#
# Strategy per port: SIGTERM → wait 3s → SIGKILL if still alive.
set -u

PORTS="${CUI_PORTS:-4005 5001 5002 5003 5004}"

_port_pids() {
  ss -tlnp 2>/dev/null | awk -v p=":$1 " '$0 ~ p { match($0,/pid=[0-9]+/); if(RLENGTH>0) print substr($0,RSTART+4,RLENGTH-4) }' | sort -u
}

for p in $PORTS; do
  pids=$(_port_pids "$p")
  [ -z "$pids" ] && continue
  echo "[pre-start-cleanup] port $p in use by PID(s): $pids — sending SIGTERM"
  for pid in $pids; do kill -TERM "$pid" 2>/dev/null || true; done

  # Grace period
  for _ in 1 2 3; do
    sleep 1
    remaining=$(_port_pids "$p")
    [ -z "$remaining" ] && break
  done

  remaining=$(_port_pids "$p")
  if [ -n "$remaining" ]; then
    echo "[pre-start-cleanup] port $p still occupied by: $remaining — sending SIGKILL"
    for pid in $remaining; do kill -KILL "$pid" 2>/dev/null || true; done
    sleep 1
  fi

  # Last-resort fuser as fallback for any leftover holders
  fuser -k "$p"/tcp 2>/dev/null || true
done

# Final guard: refuse to continue if port 4005 is still occupied — fail loud.
final=$(_port_pids 4005)
if [ -n "$final" ]; then
  echo "[pre-start-cleanup] FATAL: port 4005 still occupied after cleanup: $final" >&2
  exit 1
fi

exit 0
