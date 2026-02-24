#!/bin/bash
# Check CC-Usage Tracking Setup Status

echo "=== CC-Usage Tracking - Setup Status ==="
echo ""

# Check 1: Tokens in environment
echo "[1] Authentication Tokens"
echo ""

TOKENS_FOUND=0

if [ -n "$CLAUDE_AUTH_TOKEN_RAFAEL" ]; then
  echo "  ✓ RAFAEL token: ${CLAUDE_AUTH_TOKEN_RAFAEL:0:20}...${CLAUDE_AUTH_TOKEN_RAFAEL: -10}"
  TOKENS_FOUND=$((TOKENS_FOUND + 1))
else
  echo "  ✗ RAFAEL token missing"
fi

if [ -n "$CLAUDE_AUTH_TOKEN_OFFICE" ]; then
  echo "  ✓ OFFICE token: ${CLAUDE_AUTH_TOKEN_OFFICE:0:20}...${CLAUDE_AUTH_TOKEN_OFFICE: -10}"
  TOKENS_FOUND=$((TOKENS_FOUND + 1))
else
  echo "  ✗ OFFICE token missing"
fi

if [ -n "$CLAUDE_AUTH_TOKEN_ENGELMANN" ]; then
  echo "  ✓ ENGELMANN token: ${CLAUDE_AUTH_TOKEN_ENGELMANN:0:20}...${CLAUDE_AUTH_TOKEN_ENGELMANN: -10}"
  TOKENS_FOUND=$((TOKENS_FOUND + 1))
else
  echo "  ✗ ENGELMANN token missing"
fi

echo ""
echo "  Status: $TOKENS_FOUND/3 tokens found"
echo ""

# Check 2: Session states
echo "[2] Playwright Session States"
echo ""

SESSION_DIR="/root/projekte/local-storage/backends/cui/playwright-sessions"
SESSIONS_FOUND=0

if [ -f "$SESSION_DIR/rafael.json" ]; then
  SIZE=$(stat -f%z "$SESSION_DIR/rafael.json" 2>/dev/null || stat -c%s "$SESSION_DIR/rafael.json" 2>/dev/null || echo "0")
  echo "  ✓ rafael.json ($SIZE bytes)"
  SESSIONS_FOUND=$((SESSIONS_FOUND + 1))
else
  echo "  ✗ rafael.json missing"
fi

if [ -f "$SESSION_DIR/office.json" ]; then
  SIZE=$(stat -f%z "$SESSION_DIR/office.json" 2>/dev/null || stat -c%s "$SESSION_DIR/office.json" 2>/dev/null || echo "0")
  echo "  ✓ office.json ($SIZE bytes)"
  SESSIONS_FOUND=$((SESSIONS_FOUND + 1))
else
  echo "  ✗ office.json missing"
fi

if [ -f "$SESSION_DIR/engelmann.json" ]; then
  SIZE=$(stat -f%z "$SESSION_DIR/engelmann.json" 2>/dev/null || stat -c%s "$SESSION_DIR/engelmann.json" 2>/dev/null || echo "0")
  echo "  ✓ engelmann.json ($SIZE bytes)"
  SESSIONS_FOUND=$((SESSIONS_FOUND + 1))
else
  echo "  ✗ engelmann.json missing"
fi

echo ""
echo "  Status: $SESSIONS_FOUND/3 sessions found"
echo ""

# Check 3: Scraped data
echo "[3] Scraped Data"
echo ""

SCRAPED_FILE="/root/projekte/werkingflow/autopilot/cui/claude-usage-scraped.json"
if [ -f "$SCRAPED_FILE" ]; then
  ACCOUNTS=$(jq 'length' "$SCRAPED_FILE" 2>/dev/null || echo "0")
  TIMESTAMP=$(jq -r '.[0].timestamp // "unknown"' "$SCRAPED_FILE" 2>/dev/null)
  echo "  ✓ claude-usage-scraped.json"
  echo "    Accounts: $ACCOUNTS"
  echo "    Last scrape: $TIMESTAMP"
else
  echo "  ✗ claude-usage-scraped.json missing"
fi

echo ""

# Check 4: Cron job
echo "[4] Cron Job"
echo ""

if crontab -l 2>/dev/null | grep -q "scrape-claude-usage.ts"; then
  CRON_LINE=$(crontab -l 2>/dev/null | grep "scrape-claude-usage.ts")
  echo "  ✓ Cron job exists:"
  echo "    $CRON_LINE"
else
  echo "  ✗ Cron job not configured"
fi

echo ""
echo "=== Next Steps ==="
echo ""

if [ $TOKENS_FOUND -eq 0 ]; then
  echo "1. Extract tokens from browser:"
  echo "   - Mac: python3 scripts/extract-tokens-mac.py"
  echo "   - Linux: Manual extraction from DevTools"
  echo ""
  echo "2. Add to ~/.zshrc:"
  echo "   export CLAUDE_AUTH_TOKEN_RAFAEL=\"sk-ant-...\""
  echo "   export CLAUDE_AUTH_TOKEN_OFFICE=\"sk-ant-...\""
  echo "   export CLAUDE_AUTH_TOKEN_ENGELMANN=\"sk-ant-...\""
  echo ""
  echo "3. Reload: source ~/.zshrc"
  echo ""
  echo "4. Run: ./scripts/setup-cc-usage.sh"
elif [ $SESSIONS_FOUND -eq 0 ]; then
  echo "Tokens found! Create session states:"
  echo "  cd /root/projekte/werkingflow/autopilot/cui"
  echo "  npx tsx scripts/create-session-from-token.ts rafael"
  echo "  npx tsx scripts/create-session-from-token.ts office"
  echo "  npx tsx scripts/create-session-from-token.ts engelmann"
elif [ ! -f "$SCRAPED_FILE" ]; then
  echo "Sessions ready! Test scraper:"
  echo "  cd /root/projekte/werkingflow/autopilot/cui"
  echo "  npx tsx scripts/scrape-claude-usage.ts"
else
  echo "✅ Setup complete! Everything working."
  echo ""
  echo "View data:"
  echo "  cat /root/projekte/werkingflow/autopilot/cui/claude-usage-scraped.json | jq ."
fi

echo ""
