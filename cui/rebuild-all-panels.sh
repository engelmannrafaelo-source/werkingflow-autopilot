#!/bin/bash
# Rebuild All Panels - CUI + All Panel Dependencies
# Startet ALLE Backend-Services die von CUI Panels benötigt werden

set -e

echo "===================================================================="
echo "  REBUILD ALL PANELS - Full System Restart"
echo "===================================================================="

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="/tmp"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Panel dependencies (service name → port → directory)
declare -A PANELS=(
    ["Platform"]="3004:/root/projekte/werkingflow/platform"
    ["Dashboard"]="3333:/root/projekte/werkingflow/dashboard"
    ["Werking-Report"]="3008:/root/projekte/werking-report"
    ["Werking-Energy"]="3007:/root/projekte/apps/werking-energy"
    ["Engelmann"]="3009:/root/projekte/engelmann-ai-hub"
    ["TECC-Safety"]="3005:/root/projekte/werking-safety/frontend"
)

echo ""
echo -e "${BLUE}[1/3]${NC} Checking Panel Dependencies..."
echo "--------------------------------------------------------------------"

MISSING_PANELS=()
RUNNING_PANELS=()

for panel in "${!PANELS[@]}"; do
    IFS=':' read -r port dir <<< "${PANELS[$panel]}"
    
    if lsof -ti:$port >/dev/null 2>&1; then
        echo -e "  ${GREEN}✓${NC} $panel (Port $port)"
        RUNNING_PANELS+=("$panel")
    else
        echo -e "  ${RED}✗${NC} $panel (Port $port) - NOT RUNNING"
        MISSING_PANELS+=("$panel:$port:$dir")
    fi
done

echo ""
if [ ${#MISSING_PANELS[@]} -eq 0 ]; then
    echo -e "${GREEN}All panel dependencies are running!${NC}"
else
    echo -e "${YELLOW}WARNING: ${#MISSING_PANELS[@]} panel(s) not running:${NC}"
    for item in "${MISSING_PANELS[@]}"; do
        IFS=':' read -r panel port dir <<< "$item"
        echo -e "  ${YELLOW}⚠${NC} $panel (Port $port)"
        echo -e "     ${BLUE}→${NC} Start with: cd $dir && npm run build:local"
    done
    echo ""
    echo -e "${YELLOW}CUI will rebuild, but panels will show errors until started!${NC}"
    echo ""
    read -p "Continue anyway? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Aborted."
        exit 1
    fi
fi

echo ""
echo -e "${BLUE}[2/3]${NC} Rebuilding CUI Frontend..."
echo "--------------------------------------------------------------------"

cd "$SCRIPT_DIR"
"$SCRIPT_DIR/build-with-restart.sh" 2>&1 | grep -E "===|✓|✗|Started" || true

echo ""
echo -e "${BLUE}[3/3]${NC} Health Check..."
echo "--------------------------------------------------------------------"

# Wait for CUI to be ready
sleep 3

if curl -s -o /dev/null -w "%{http_code}" http://localhost:4005/ | grep -q "200"; then
    echo -e "  ${GREEN}✓${NC} CUI (Port 4005) - ONLINE"
else
    echo -e "  ${RED}✗${NC} CUI (Port 4005) - FAILED"
    echo ""
    echo -e "${RED}ERROR: CUI did not start properly${NC}"
    echo "Check log: tail -50 /tmp/cui-server.log"
    exit 1
fi

# Re-check all panels
for panel in "${!PANELS[@]}"; do
    IFS=':' read -r port dir <<< "${PANELS[$panel]}"
    
    if lsof -ti:$port >/dev/null 2>&1; then
        echo -e "  ${GREEN}✓${NC} $panel (Port $port)"
    else
        echo -e "  ${YELLOW}⚠${NC} $panel (Port $port) - Still not running"
    fi
done

echo ""
echo "===================================================================="
echo -e "  ${GREEN}✓ REBUILD COMPLETE${NC}"
echo "===================================================================="
echo ""
echo "CUI Workspace: http://localhost:4005"
echo ""

if [ ${#MISSING_PANELS[@]} -gt 0 ]; then
    echo -e "${YELLOW}Note: Some panels are still offline and will show errors.${NC}"
    echo "Start them manually:"
    echo ""
    for item in "${MISSING_PANELS[@]}"; do
        IFS=':' read -r panel port dir <<< "$item"
        echo "  $panel:  cd $dir && npm run build:local"
    done
    echo ""
fi

echo "Done!"
