#!/bin/bash
# ============================================================================
# Set up Claude OAuth Token on Partner Server
# ============================================================================
# Creates the account directory structure for a single Claude account.
# Run this on the partner server as root.
#
# USAGE:
#   ./setup-claude-auth.sh <account-id> <account-name>
#   ./setup-claude-auth.sh 1 "Partner"
#
# Then: su - claude-user && HOME=/home/claude-user/.cui-account1 claude login
# ============================================================================
set -euo pipefail

ACCOUNT_NUM="${1:-1}"
ACCOUNT_NAME="${2:-Partner}"

CLAUDE_HOME="/home/claude-user"
ACCOUNT_DIR="$CLAUDE_HOME/.cui-account$ACCOUNT_NUM"

echo "Setting up Claude account $ACCOUNT_NUM ($ACCOUNT_NAME)..."

# Create account directory structure
mkdir -p "$ACCOUNT_DIR/.claude/accounts"
mkdir -p "$ACCOUNT_DIR/.claude/projects"

# Create settings.json (all permissions pre-allowed)
cat > "$ACCOUNT_DIR/.claude/settings.json" <<'EOF'
{
  "permissions": {
    "allow": ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebSearch", "WebFetch", "mcp__*"],
    "deny": [],
    "ask": []
  },
  "model": "opus",
  "hasCompletedOnboarding": true,
  "skipDangerousModePermissionPrompt": true,
  "autoUpdaterStatus": "disabled"
}
EOF

# Create account name mapping
cat > "$ACCOUNT_DIR/.claude/accounts/names.json" <<EOF
{"$ACCOUNT_NUM": "$ACCOUNT_NAME"}
EOF

# Symlink shared projects directory
if [ -d "$CLAUDE_HOME/.claude/projects" ]; then
  rm -rf "$ACCOUNT_DIR/.claude/projects"
  ln -sf "$CLAUDE_HOME/.claude/projects" "$ACCOUNT_DIR/.claude/projects"
fi

# Create bashrc for this account
cat > "$ACCOUNT_DIR/.bashrc" <<'EOF'
# CUI Account bashrc
[ -f /home/claude-user/.bashrc ] && source /home/claude-user/.bashrc 2>/dev/null || true
EOF

cat > "$ACCOUNT_DIR/.profile" <<'EOF'
[ -f ~/.bashrc ] && source ~/.bashrc
EOF

# Fix ownership
chown -R claude-user:claude-user "$ACCOUNT_DIR"

echo ""
echo "Account directory created: $ACCOUNT_DIR"
echo ""
echo "NEXT: Log in to Claude (opens browser for OAuth):"
echo "  su - claude-user"
echo "  HOME=$ACCOUNT_DIR claude login"
echo ""
echo "After login, verify:"
echo "  HOME=$ACCOUNT_DIR claude --version"
echo ""
