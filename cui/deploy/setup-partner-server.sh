#!/bin/bash
# ============================================================================
# CUI Partner Server — Automated Provisioning
# ============================================================================
# Run on a FRESH Ubuntu 22.04/24.04 Hetzner VPS as root.
#
# What this does:
#   1. Installs Node.js 20, npm, essential tools
#   2. Creates claude-user system account
#   3. Installs Claude Code CLI
#   4. Installs Tailscale and joins the tailnet
#   5. Sets up /run/cui-sessions tmpfiles
#   6. Creates directory structure
#   7. Installs cui-session-wrapper
#   8. Configures UFW firewall
#
# USAGE:
#   curl -fsSL <this-script-url> | bash
#   OR: scp to server, then: chmod +x setup-partner-server.sh && ./setup-partner-server.sh
#
# AFTER running:
#   1. Run `tailscale up` to join tailnet (requires browser auth)
#   2. Deploy CUI with deploy-to-partner.sh
#   3. Set up Claude OAuth tokens (claude login)
#   4. Create users.json with hash-password.sh
# ============================================================================
set -euo pipefail

echo "========================================"
echo "  CUI Partner Server — Setup"
echo "========================================"
echo ""

# ── Sanity checks ──────────────────────────────────────────────────────────
if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: This script must be run as root" >&2
  exit 1
fi

if ! grep -qiE 'ubuntu|debian' /etc/os-release 2>/dev/null; then
  echo "WARNING: This script is designed for Ubuntu/Debian. Proceed? (y/N)"
  read -r reply
  [ "$reply" = "y" ] || exit 1
fi

# ── 1. System packages ────────────────────────────────────────────────────
echo "[1/8] Installing system packages..."
apt-get update -qq
apt-get install -y -qq \
  curl wget git jq unzip \
  build-essential python3 python3-pip python3-venv python3.12-venv \
  ufw fail2ban \
  ca-certificates gnupg

# PyJWT needed for Infisical token generation
pip3 install pyjwt --break-system-packages 2>/dev/null || python3 -m pip install pyjwt --break-system-packages 2>/dev/null || true

# ── 1b. Swap (2GB) — required for Next.js builds on 4GB RAM servers ──────
echo "[1b] Setting up 2GB swap..."
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "  Swap: 2GB created and enabled"
else
  echo "  Swap: already present"
fi

# ── 2. Node.js 20 via NodeSource ──────────────────────────────────────────
echo "[2/8] Installing Node.js 20 + pnpm..."
if ! command -v node &>/dev/null || [[ "$(node --version)" != v20* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi
echo "  Node: $(node --version)"
echo "  npm:  $(npm --version)"

# pnpm — required for monorepo workspace: protocol
if ! command -v pnpm &>/dev/null; then
  npm install -g pnpm
fi
echo "  pnpm: $(pnpm --version)"

# ── 3. Create claude-user ────────────────────────────────────────────────
echo "[3/8] Creating claude-user..."
if ! id claude-user &>/dev/null; then
  useradd -r -m -d /home/claude-user -s /bin/bash claude-user
  echo "  Created claude-user"
else
  echo "  claude-user already exists"
fi

# Ensure claude-user can read /root dirs (for project access)
usermod -aG root claude-user 2>/dev/null || true

# Create essential directories
mkdir -p /home/claude-user/.claude
mkdir -p /home/claude-user/.claude/projects
chown -R claude-user:claude-user /home/claude-user

# ── 4. Install Claude Code CLI ───────────────────────────────────────────
echo "[4/8] Installing Claude Code CLI..."
if ! command -v claude &>/dev/null; then
  npm install -g @anthropic-ai/claude-code
  echo "  Installed: $(claude --version)"
else
  echo "  Already installed: $(claude --version)"
fi

# ── 5. Install Tailscale ────────────────────────────────────────────────
echo "[5/8] Installing Tailscale..."
if ! command -v tailscale &>/dev/null; then
  curl -fsSL https://tailscale.com/install.sh | sh
  systemctl enable --now tailscaled
  echo "  Installed: $(tailscale version | head -1)"
  echo ""
  echo "  *** IMPORTANT: Run 'tailscale up' after this script to join the tailnet ***"
  echo ""
else
  echo "  Already installed: $(tailscale version | head -1)"
fi

# ── 6. Set up /run/cui-sessions (tmpfiles.d for boot persistence) ────────
echo "[6/8] Setting up session runtime directory..."
cat > /etc/tmpfiles.d/cui-sessions.conf <<'EOF'
d /run/cui-sessions 0770 claude-user claude-user -
EOF
systemd-tmpfiles --create
echo "  /run/cui-sessions ready"

# ── 7. Install cui-session-wrapper ───────────────────────────────────────
echo "[7/8] Installing cui-session-wrapper..."
cat > /usr/local/bin/cui-session-wrapper <<'WRAPPER'
#!/bin/bash
# CUI Session Wrapper — persistent Claude CLI process
# Survives server restarts via setsid (new session group)
# Communicates via FIFO (stdin) and regular file (stdout)
#
# Usage: setsid cui-session-wrapper SESSION_ID ACCOUNT_ID FIFO_DIR [CLAUDE_ARGS...]

set -uo pipefail

SESSION_ID="$1"; ACCOUNT_ID="$2"; FIFO_DIR="$3"; shift 3
FIFO="$FIFO_DIR/$SESSION_ID.fifo"
STDOUT_FILE="$FIFO_DIR/$SESSION_ID.stdout"
STDERR_FILE="$FIFO_DIR/$SESSION_ID.stderr"
PID_FILE="$FIFO_DIR/$SESSION_ID.pid"
META_FILE="$FIFO_DIR/$SESSION_ID.meta"

# Clean up stale FIFO if exists
rm -f "$FIFO"
mkfifo "$FIFO"
chmod 660 "$FIFO"

# Write wrapper PID
echo "$$" > "$PID_FILE"

# Metadata for reconnect
echo "{\"accountId\":\"$ACCOUNT_ID\",\"startedAt\":$(date +%s),\"args\":$(printf '%s\n' "$@" | jq -R . | jq -s .)}" > "$META_FILE"

# Open FIFO read-write (fd 3)
exec 3<>"$FIFO"

# Start Claude CLI: reads from FIFO (via fd 3), appends to stdout file
claude "$@" <&3 >> "$STDOUT_FILE" 2>> "$STDERR_FILE" &
CLAUDE_PID=$!
echo "$CLAUDE_PID" >> "$PID_FILE"

# Wait for Claude to exit
wait $CLAUDE_PID 2>/dev/null || true
EXIT_CODE=$?

# Cleanup
exec 3>&-
rm -f "$FIFO" "$PID_FILE"
echo "{\"type\":\"wrapper-exit\",\"exitCode\":$EXIT_CODE,\"sessionId\":\"$SESSION_ID\",\"timestamp\":\"$(date -Iseconds)\"}" >> "$STDOUT_FILE"
WRAPPER
chmod +x /usr/local/bin/cui-session-wrapper
echo "  Installed /usr/local/bin/cui-session-wrapper"

# ── 8. Configure UFW Firewall ────────────────────────────────────────────
echo "[8/8] Configuring UFW firewall..."
ufw --force reset >/dev/null 2>&1
ufw default deny incoming
ufw default allow outgoing

# SSH always allowed
ufw allow 22/tcp

# Tailscale interface — allow all traffic (internal VPN)
ufw allow in on tailscale0

# Enable firewall
ufw --force enable
echo "  UFW configured: SSH + Tailscale only"

# ── Summary ──────────────────────────────────────────────────────────────
TAILSCALE_IP=$(tailscale ip -4 2>/dev/null || echo "NOT_CONNECTED")

echo ""
echo "========================================"
echo "  SETUP COMPLETE"
echo "========================================"
echo ""
echo "  Node.js:      $(node --version)"
echo "  Claude CLI:   $(claude --version 2>/dev/null || echo 'installed')"
echo "  Tailscale IP: $TAILSCALE_IP"
echo "  Firewall:     SSH + Tailscale only"
echo ""
echo "  NEXT STEPS:"
echo "  1. tailscale up                           # Join tailnet (browser auth)"
echo "  2. Deploy CUI:  deploy-to-partner.sh      # From dev-server"
echo "  3. Claude auth: su - claude-user && claude login"
echo "  4. Create users: hash-password.sh <password>"
echo "  5. Start:        systemctl start cui-workspace"
echo ""
