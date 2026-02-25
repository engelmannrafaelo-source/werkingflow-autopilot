#!/bin/bash
# Capture all Virtual Office views using Screenshot Request API
# Requires: Rafael's browser open with Virtual Office tab active

API="http://localhost:4005"
OUTPUT="/root/orchestrator/workspaces/team"

echo "🎯 Capturing All Virtual Office Views"
echo "================================================"
echo ""
echo "⚠️  IMPORTANT: Make sure you have:"
echo "  1. CUI open in your browser (http://localhost:4005)"
echo "  2. Virtual Office tab active"
echo "  3. You are on the Dashboard view"
echo ""
echo "Press Enter to start capturing..."
read

# Function to capture screenshot
capture() {
    local panel=$1
    local name=$2
    local wait=${3:-5000}

    echo "📸 Capturing: $name..."
    response=$(curl -s -X POST "$API/api/control/screenshot/request" \
        -H "Content-Type: application/json" \
        -d "{\"panel\": \"$panel\", \"wait\": $wait}")

    if echo "$response" | grep -q '"ok":true'; then
        url=$(echo "$response" | python3 -c "import sys, json; print(json.load(sys.stdin)['url'])")
        filename="$OUTPUT/$(echo $name | tr ' ' '-' | tr '[:upper:]' '[:lower:]').png"

        curl -s "$API$url" -o "$filename"
        echo "  ✅ Saved: $filename"
        sleep 1
    else
        echo "  ❌ Failed: $response"
    fi
}

# Capture full Virtual Office
capture "virtual-office" "Virtual-Office-Full" 6000

# Capture individual panels
capture "activity-stream" "Activity-Stream" 5000
capture "agent-grid" "Agent-Grid" 5000
capture "action-items" "Action-Items" 5000

echo ""
echo "================================================"
echo "✅ Capture Complete!"
echo "📁 Screenshots saved to: $OUTPUT/"
echo "================================================"
