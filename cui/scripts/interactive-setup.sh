#!/bin/bash
# Interactive CC-Usage Setup - Asks for tokens, does everything else automatically

set -e

CUI_DIR="/root/projekte/werkingflow/autopilot/cui"
ZSHRC="$HOME/.zshrc"

echo "╔═══════════════════════════════════════════════════════════╗"
echo "║   Claude Code Usage Tracking - Interactive Setup         ║"
echo "╚═══════════════════════════════════════════════════════════╝"
echo ""

cd "$CUI_DIR"

# Step 1: Extract tokens from browser
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Step 1: Extract Tokens from Browser"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Open this script in browser DevTools Console:"
echo ""
echo "📄 File: $CUI_DIR/scripts/extract-token-devtools.js"
echo ""
echo "Instructions:"
echo "  1. Open claude.ai in browser (each account)"
echo "  2. DevTools: F12 (or Cmd+Opt+I on Mac)"
echo "  3. Console tab"
echo "  4. Copy-paste entire extract-token-devtools.js"
echo "  5. Press Enter"
echo "  6. Copy the 'export' line output"
echo ""
echo "Or show the script now?"
read -p "Show extract script? (y/n) " -n 1 -r SHOW_SCRIPT
echo ""

if [[ $SHOW_SCRIPT =~ ^[Yy]$ ]]; then
  echo ""
  cat scripts/extract-token-devtools.js
  echo ""
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Step 2: Enter Tokens"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Ask for each token
echo "Enter tokens (or press Enter to skip):"
echo ""

read -p "RAFAEL token (sk-ant-...): " RAFAEL_TOKEN
read -p "OFFICE token (sk-ant-...): " OFFICE_TOKEN
read -p "ENGELMANN token (sk-ant-...): " ENGELMANN_TOKEN

echo ""

# Count how many tokens provided
TOKENS_PROVIDED=0
if [ -n "$RAFAEL_TOKEN" ]; then TOKENS_PROVIDED=$((TOKENS_PROVIDED + 1)); fi
if [ -n "$OFFICE_TOKEN" ]; then TOKENS_PROVIDED=$((TOKENS_PROVIDED + 1)); fi
if [ -n "$ENGELMANN_TOKEN" ]; then TOKENS_PROVIDED=$((TOKENS_PROVIDED + 1)); fi

if [ $TOKENS_PROVIDED -eq 0 ]; then
  echo "❌ No tokens provided. Setup cancelled."
  echo ""
  echo "Get tokens from browser first, then run this script again."
  exit 1
fi

echo "✓ Received $TOKENS_PROVIDED token(s)"
echo ""

# Step 3: Write to ~/.zshrc
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Step 3: Writing Tokens to ~/.zshrc"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Backup zshrc
cp "$ZSHRC" "$ZSHRC.backup-$(date +%s)"
echo "✓ Backed up ~/.zshrc"

# Remove old token lines (if any)
sed -i '/CLAUDE_AUTH_TOKEN_/d' "$ZSHRC"

# Add new tokens
echo "" >> "$ZSHRC"
echo "# Claude.ai Authentication Tokens (added by setup-cc-usage.sh)" >> "$ZSHRC"
if [ -n "$RAFAEL_TOKEN" ]; then
  echo "export CLAUDE_AUTH_TOKEN_RAFAEL=\"$RAFAEL_TOKEN\"" >> "$ZSHRC"
  echo "  ✓ RAFAEL token added"
fi
if [ -n "$OFFICE_TOKEN" ]; then
  echo "export CLAUDE_AUTH_TOKEN_OFFICE=\"$OFFICE_TOKEN\"" >> "$ZSHRC"
  echo "  ✓ OFFICE token added"
fi
if [ -n "$ENGELMANN_TOKEN" ]; then
  echo "export CLAUDE_AUTH_TOKEN_ENGELMANN=\"$ENGELMANN_TOKEN\"" >> "$ZSHRC"
  echo "  ✓ ENGELMANN token added"
fi

# Reload
source "$ZSHRC"
echo "  ✓ Reloaded ~/.zshrc"
echo ""

# Step 4: Install Chromium
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Step 4: Installing Chromium"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if npx playwright list-files 2>/dev/null | grep -q chromium; then
  echo "✓ Chromium already installed"
else
  echo "Installing Chromium..."
  npx playwright install chromium
  echo "✓ Chromium installed"
fi
echo ""

# Step 5: Create Session States
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Step 5: Creating Session States"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

ACCOUNTS=()
if [ -n "$RAFAEL_TOKEN" ]; then ACCOUNTS+=("rafael"); fi
if [ -n "$OFFICE_TOKEN" ]; then ACCOUNTS+=("office"); fi
if [ -n "$ENGELMANN_TOKEN" ]; then ACCOUNTS+=("engelmann"); fi

for account in "${ACCOUNTS[@]}"; do
  echo "Creating session for $account..."
  if npx tsx scripts/create-session-from-token.ts "$account"; then
    echo "  ✓ $account session created"
  else
    echo "  ✗ $account session failed"
  fi
  echo ""
done

# Step 6: Test Scraper
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Step 6: Testing Scraper"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

echo "Running scraper test..."
if npx tsx scripts/scrape-claude-usage.ts; then
  echo ""
  echo "✓ Scraper works!"
  echo ""

  if [ -f "claude-usage-scraped.json" ]; then
    SCRAPED_COUNT=$(jq 'length' claude-usage-scraped.json 2>/dev/null || echo "0")
    echo "Scraped $SCRAPED_COUNT account(s):"
    jq -r '.[] | "  - \(.account): \(.weeklyAllModels.percent)% weekly"' claude-usage-scraped.json 2>/dev/null || true
  fi
else
  echo ""
  echo "⚠️  Scraper test failed (check logs above)"
fi
echo ""

# Step 7: Setup Cron
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Step 7: Setting Up Daily Cron Job"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

CRON_LINE="0 6 * * * cd $CUI_DIR && npx tsx scripts/scrape-claude-usage.ts >> /var/log/claude-scraper.log 2>&1"

if crontab -l 2>/dev/null | grep -q "scrape-claude-usage.ts"; then
  echo "✓ Cron job already exists"
else
  echo "Adding cron job (daily at 6:00 AM)..."
  (crontab -l 2>/dev/null; echo "$CRON_LINE") | crontab -
  echo "✓ Cron job added"
fi
echo ""

# Summary
echo "╔═══════════════════════════════════════════════════════════╗"
echo "║                    Setup Complete! ✅                     ║"
echo "╚═══════════════════════════════════════════════════════════╝"
echo ""
echo "Setup Summary:"
echo "  ✅ Tokens: $TOKENS_PROVIDED account(s) configured"
echo "  ✅ Sessions: Created for all accounts"
echo "  ✅ Scraper: Tested successfully"
echo "  ✅ Cron: Daily scraping at 6:00 AM"
echo ""
echo "Next Steps:"
echo ""
echo "  1. Restart CUI server:"
echo "     curl -X POST http://localhost:9090/api/app/cui/restart"
echo ""
echo "  2. Open in browser:"
echo "     http://localhost:4005"
echo ""
echo "  3. Check CC-Usage tab:"
echo "     BridgeMonitor → CC-Usage → Look for LIVE badges"
echo ""
echo "Logs:"
echo "  tail -f /var/log/claude-scraper.log"
echo ""
echo "Manual scraper run:"
echo "  npx tsx scripts/scrape-claude-usage.ts"
echo ""
