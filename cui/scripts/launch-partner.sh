#!/bin/bash
# Launch CUI Electron App in Partner Mode
# Connects to https://partner.werking.tools
#
# Usage:
#   ./scripts/launch-partner.sh          (production build + launch)
#   ./scripts/launch-partner.sh --quick  (launch without rebuild)

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CUI_DIR="$(dirname "$SCRIPT_DIR")"

cd "$CUI_DIR"

if [ "${1:-}" = "--quick" ]; then
  echo "[CUI Partner] Launching without rebuild..."
  npx electron . --partner
else
  echo "[CUI Partner] Building frontend + launching..."
  NODE_ENV=production npx vite build
  npx electron . --partner
fi
