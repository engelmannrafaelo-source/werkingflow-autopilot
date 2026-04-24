#!/bin/bash
# ============================================================================
# Setup Git Infrastructure on Partner Server (one-time)
# ============================================================================
# Run from DEV SERVER before the first git-based deploy.
# Creates /opt/cui-workspace-bare.git with post-receive hook on Partner.
#
# USAGE:
#   ./setup-partner-git.sh [tailscale-ip]    # default: 100.119.199.86
# ============================================================================
set -euo pipefail

TARGET="${1:-100.119.199.86}"
BARE_REPO="/opt/cui-workspace-bare.git"
WORK_TREE="/opt/cui-workspace"
BRANCH="develop"

echo "Setting up git infrastructure on $TARGET..."

ssh "root@$TARGET" bash <<REMOTE
set -euo pipefail

if [ -d "$BARE_REPO" ] && [ -f "$BARE_REPO/HEAD" ]; then
  echo "  Bare repo already exists: $BARE_REPO — updating hook only"
else
  git init --bare "$BARE_REPO"
  echo "  Created: $BARE_REPO"
fi

cat > "$BARE_REPO/hooks/post-receive" <<'HOOK'
#!/bin/bash
set -e
BRANCH="develop"
WORK_TREE="/opt/cui-workspace"
GIT_DIR="/opt/cui-workspace-bare.git"

while read oldrev newrev refname; do
  branch="\${refname#refs/heads/}"
  if [ "\$branch" = "\$BRANCH" ]; then
    echo "[post-receive] Deploying \$branch → \$WORK_TREE"
    GIT_WORK_TREE="\$WORK_TREE" GIT_DIR="\$GIT_DIR" git checkout -f "\$BRANCH"
    cd "\$WORK_TREE"
    echo "[post-receive] npm install..."
    npm install
    echo "[post-receive] vite build..."
    npx vite build
    echo "[post-receive] Restarting service..."
    systemctl restart cui-workspace 2>/dev/null && echo "[post-receive] Restarted OK" || echo "[post-receive] WARNING: restart failed"
    echo "[post-receive] Done"
  fi
done
HOOK

chmod +x "$BARE_REPO/hooks/post-receive"
echo "  post-receive hook installed"
mkdir -p "$WORK_TREE"
echo "  Work tree ready: $WORK_TREE"
echo "Git infrastructure ready."
REMOTE

echo "Done. Run ./deploy/deploy-to-partner.sh to deploy."
