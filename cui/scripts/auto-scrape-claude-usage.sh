#\!/bin/bash
# Auto-Scrape Claude Usage (Runs via Cron)
#
# Crontab:
#   0 */4 * * * /root/projekte/werkingflow/autopilot/cui/scripts/auto-scrape-claude-usage.sh >> /var/log/claude-scraper.log 2>&1

set -e

CUI_DIR="/root/projekte/werkingflow/autopilot/cui"
SCRAPED_FILE="$CUI_DIR/claude-usage-scraped.json"

cd "$CUI_DIR"

echo ""
echo "=== [$(date)] Starting Claude usage scrape ==="

# Run scraper
npx tsx scripts/scrape-claude-usage.ts

# Verify output
if [ \! -f "$SCRAPED_FILE" ]; then
  echo "[$(date)] ERROR: No output file"
  exit 1
fi

COUNT=$(python3 -c "import json; print(len(json.load(open())))" 2>/dev/null || echo "0")
echo "[$(date)] OK: Scraped $COUNT accounts"
