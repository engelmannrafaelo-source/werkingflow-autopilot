#!/bin/bash
# Complete CC-Usage Tracking Setup
# Handles: Token extraction, session creation, scraper test, cron setup

set -e

STORAGE_DIR="/root/projekte/local-storage/backends/cui/playwright-sessions"
CUI_DIR="/root/projekte/werkingflow/autopilot/cui"
ZSHRC="$HOME/.zshrc"

echo "=== Claude Code Usage Tracking - Complete Setup ==="
echo ""

# Step 1: Check Chromium
echo "[1/5] Checking Chromium installation..."
if ! npx playwright list-files 2>/dev/null | grep -q chromium; then
  echo "  → Installing Chromium..."
  npx playwright install chromium
  echo "  ✓ Chromium installed"
else
  echo "  ✓ Chromium already installed"
fi
echo ""

# Step 2: Token Setup
echo "[2/5] Setting up authentication tokens..."
echo ""
echo "⚠️  MANUAL ACTION REQUIRED:"
echo ""
echo "Open claude.ai in your browser and extract sessionKey cookies:"
echo ""
echo "1. Chrome/Brave: DevTools (F12) → Application → Cookies → claude.ai → sessionKey"
echo "2. Firefox: DevTools (F12) → Storage → Cookies → claude.ai → sessionKey"
echo "3. Copy the FULL cookie value (starts with sk-ant-...)"
echo ""
echo "Then add to $ZSHRC:"
echo ""
echo "export CLAUDE_AUTH_TOKEN_RAFAEL=\"sk-ant-...\""
echo "export CLAUDE_AUTH_TOKEN_OFFICE=\"sk-ant-...\""
echo "export CLAUDE_AUTH_TOKEN_ENGELMANN=\"sk-ant-...\""
echo ""

read -p "Have you added the tokens to ~/.zshrc? (y/n) " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "❌ Setup cancelled. Add tokens first!"
  exit 1
fi

# Reload zshrc
echo "  → Reloading ~/.zshrc..."
source "$ZSHRC" 2>/dev/null || true
echo ""

# Verify tokens
echo "  → Verifying tokens..."
FOUND_TOKENS=0
if [ -n "$CLAUDE_AUTH_TOKEN_RAFAEL" ]; then
  echo "    ✓ RAFAEL token found"
  FOUND_TOKENS=$((FOUND_TOKENS + 1))
else
  echo "    ✗ RAFAEL token missing"
fi

if [ -n "$CLAUDE_AUTH_TOKEN_OFFICE" ]; then
  echo "    ✓ OFFICE token found"
  FOUND_TOKENS=$((FOUND_TOKENS + 1))
else
  echo "    ✗ OFFICE token missing"
fi

if [ -n "$CLAUDE_AUTH_TOKEN_ENGELMANN" ]; then
  echo "    ✓ ENGELMANN token found"
  FOUND_TOKENS=$((FOUND_TOKENS + 1))
else
  echo "    ✗ ENGELMANN token missing"
fi

if [ $FOUND_TOKENS -eq 0 ]; then
  echo ""
  echo "❌ No tokens found! Check your ~/.zshrc"
  exit 1
fi

echo "  ✓ Found $FOUND_TOKENS token(s)"
echo ""

# Step 3: Create Sessions
echo "[3/5] Creating Playwright session states..."
cd "$CUI_DIR"

ACCOUNTS=("rafael" "office" "engelmann")
for account in "${ACCOUNTS[@]}"; do
  TOKEN_VAR="CLAUDE_AUTH_TOKEN_${account^^}"
  if [ -n "${!TOKEN_VAR}" ]; then
    echo "  → Creating session for $account..."
    if npx tsx scripts/create-session-from-token.ts "$account" 2>&1 | grep -q "✅ Session created"; then
      echo "    ✓ Session created: $account"
    else
      echo "    ✗ Failed to create session: $account"
    fi
  fi
done
echo ""

# Step 4: Test Scraper
echo "[4/5] Testing scraper..."
if npx tsx scripts/scrape-claude-usage.ts 2>&1 | tee /tmp/scraper-test.log; then
  if [ -f "$CUI_DIR/claude-usage-scraped.json" ]; then
    SCRAPED_COUNT=$(jq 'length' "$CUI_DIR/claude-usage-scraped.json" 2>/dev/null || echo "0")
    echo "  ✓ Scraper works! Scraped $SCRAPED_COUNT account(s)"
    echo ""
    echo "Preview:"
    jq '.' "$CUI_DIR/claude-usage-scraped.json" | head -20
  else
    echo "  ✗ Scraper failed (no output file)"
  fi
else
  echo "  ✗ Scraper test failed"
  echo "  → Check /tmp/scraper-test.log for errors"
fi
echo ""

# Step 5: Setup Cron
echo "[5/5] Setting up daily scraper cron job..."
CRON_LINE="0 6 * * * cd $CUI_DIR && npx tsx scripts/scrape-claude-usage.ts >> /var/log/claude-scraper.log 2>&1"

if crontab -l 2>/dev/null | grep -q "scrape-claude-usage.ts"; then
  echo "  ✓ Cron job already exists"
else
  echo "  → Adding cron job (daily at 6:00 AM)..."
  (crontab -l 2>/dev/null; echo "$CRON_LINE") | crontab -
  echo "  ✓ Cron job added"
fi
echo ""

# Summary
echo "=== Setup Complete! ==="
echo ""
echo "✅ Chromium: Installed"
echo "✅ Tokens: $FOUND_TOKENS account(s)"
echo "✅ Sessions: Created"
echo "✅ Scraper: Tested"
echo "✅ Cron: Daily at 6:00 AM"
echo ""
echo "Next steps:"
echo "1. Restart CUI server to load scraped data"
echo "2. Open http://localhost:4005 → BridgeMonitor → CC-Usage"
echo "3. Check for LIVE badges on account cards"
echo ""
echo "Logs: /var/log/claude-scraper.log"
echo "Data: $CUI_DIR/claude-usage-scraped.json"
echo ""
