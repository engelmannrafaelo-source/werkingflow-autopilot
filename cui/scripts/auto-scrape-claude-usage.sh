#!/bin/bash
# Auto-Scrape Claude Usage (Runs via Cron)
#
# Scrapes claude.ai/settings/usage for all accounts with saved sessions
# Updates claude-limits-override.json automatically
#
# Setup:
#   crontab -e
#   0 */6 * * * /root/projekte/werkingflow/autopilot/cui/scripts/auto-scrape-claude-usage.sh >> /tmp/claude-scraper.log 2>&1

set -e

CUI_DIR="/root/projekte/werkingflow/autopilot/cui"
OVERRIDE_FILE="$CUI_DIR/claude-limits-override.json"
SCRAPED_FILE="$CUI_DIR/claude-usage-scraped.json"

cd "$CUI_DIR"

echo "[$(date)] Starting Claude usage scrape..."

# Run scraper
npx tsx scripts/scrape-claude-usage.ts

# Check if scrape was successful
if [ ! -f "$SCRAPED_FILE" ]; then
  echo "[$(date)] ERROR: Scrape failed, no output file"
  exit 1
fi

# Convert scraped data to override format
npx tsx scripts/convert-scraped-to-override.ts

echo "[$(date)] ✓ Claude usage updated successfully"
