#!/bin/bash
# Quick Token Setup - Interactive

set -e

echo "=== CC-Usage Quick Token Setup ==="
echo ""
echo "Ich brauche die sessionKey Cookies von deinen Claude.ai Accounts."
echo ""
echo "So findest du sie:"
echo "1. Öffne claude.ai im Browser (Chrome/Brave)"
echo "2. DevTools: Cmd+Opt+I (Mac) oder F12 (Windows/Linux)"
echo "3. Tab: Application → Cookies → https://claude.ai"
echo "4. Cookie 'sessionKey' → Value kopieren (sk-ant-...)"
echo ""
echo "─────────────────────────────────────────────────────────"
echo ""

# Get tokens interactively
read -p "Token für RAFAEL (rafael@werk-ing.com): " TOKEN_RAFAEL
read -p "Token für OFFICE (office@werk-ing.com): " TOKEN_OFFICE
read -p "Token für ENGELMANN (engelmann@werk-ing.com): " TOKEN_ENGELMANN

echo ""
echo "─────────────────────────────────────────────────────────"
echo ""

# Validate tokens (basic check)
if [[ ! $TOKEN_RAFAEL =~ ^sk-ant- ]] || [[ ! $TOKEN_OFFICE =~ ^sk-ant- ]] || [[ ! $TOKEN_ENGELMANN =~ ^sk-ant- ]]; then
  echo "❌ Tokens müssen mit 'sk-ant-' beginnen!"
  echo "Bitte nochmal prüfen und erneut ausführen."
  exit 1
fi

echo "✓ Tokens sehen gut aus!"
echo ""
echo "Schreibe in ~/.zshrc..."

# Backup existing zshrc
cp ~/.zshrc ~/.zshrc.backup-$(date +%Y%m%d-%H%M%S)

# Remove old token entries if they exist
sed -i '/CLAUDE_AUTH_TOKEN_/d' ~/.zshrc

# Append new tokens
cat >> ~/.zshrc <<EOF

# Claude.ai Authentication Tokens (CC-Usage Tracking)
export CLAUDE_AUTH_TOKEN_RAFAEL="$TOKEN_RAFAEL"
export CLAUDE_AUTH_TOKEN_OFFICE="$TOKEN_OFFICE"
export CLAUDE_AUTH_TOKEN_ENGELMANN="$TOKEN_ENGELMANN"
EOF

echo "✓ Tokens in ~/.zshrc gespeichert"
echo ""

# Reload
echo "Reloading ~/.zshrc..."
source ~/.zshrc
echo "✓ Environment reloaded"
echo ""

# Verify
echo "Verifying tokens in environment..."
if [ -n "$CLAUDE_AUTH_TOKEN_RAFAEL" ] && [ -n "$CLAUDE_AUTH_TOKEN_OFFICE" ] && [ -n "$CLAUDE_AUTH_TOKEN_ENGELMANN" ]; then
  echo "✓ All tokens loaded!"
else
  echo "❌ Tokens not loaded - manuelle source ~/.zshrc nötig"
  exit 1
fi

echo ""
echo "─────────────────────────────────────────────────────────"
echo ""
echo "✅ Tokens eingerichtet!"
echo ""
echo "Nächster Schritt: Komplettes Setup"
echo ""
read -p "Soll ich jetzt das komplette Setup ausführen? (y/n) " -n 1 -r
echo ""

if [[ $REPLY =~ ^[Yy]$ ]]; then
  echo ""
  echo "Führe setup-cc-usage.sh aus..."
  echo ""
  cd /root/projekte/werkingflow/autopilot/cui
  ./scripts/setup-cc-usage.sh
else
  echo ""
  echo "Setup abgebrochen. Später ausführen mit:"
  echo "  cd /root/projekte/werkingflow/autopilot/cui"
  echo "  ./scripts/setup-cc-usage.sh"
fi
