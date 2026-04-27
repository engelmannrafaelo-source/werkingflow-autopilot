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
# Auto-deploy hook — triggered by git push from dev-server
set -e
BRANCH="develop"
WORK_TREE="/opt/cui-workspace"
GIT_DIR="/opt/cui-workspace-bare.git"

# Resolve CUI_DATA_DIR from systemd Drop-in (post-Phase-2 migration); legacy
# fallback is the in-tree data/ folder. When migrated, the git-checked-out
# data/ in WORK_TREE is "dead" — server reads from CUI_DATA_DIR instead.
DATA_DIR=\$(systemctl show cui-workspace -p Environment 2>/dev/null \\
  | tr ' ' '\\n' | sed -n 's/^CUI_DATA_DIR=//p' | head -1)
DATA_DIR="\${DATA_DIR:-\$WORK_TREE/data}"

while read oldrev newrev refname; do
  branch="\${refname#refs/heads/}"
  if [ "\$branch" = "\$BRANCH" ]; then
    echo "[post-receive] Deploying \$branch → \$WORK_TREE"
    GIT_WORK_TREE="\$WORK_TREE" GIT_DIR="\$GIT_DIR" git checkout -f "\$BRANCH"

    # Seed-merge: copy NEW tracked data/ files into runtime dir.
    # cp -rn = recursive, no-clobber → never overwrites runtime state, only
    # propagates seed files that don't exist yet at destination. Tradeoff:
    # upstream edits to existing seeds do NOT propagate (manual merge needed).
    if [ "\$DATA_DIR" != "\$WORK_TREE/data" ] && [ -d "\$WORK_TREE/data" ]; then
      mkdir -p "\$DATA_DIR"
      ADDED=\$(cp -rnv "\$WORK_TREE/data/." "\$DATA_DIR/" 2>&1 | wc -l)
      echo "[post-receive] Seed-merge → \$DATA_DIR (\$ADDED new files copied; existing preserved)"
    fi

    cd "\$WORK_TREE"
    echo "[post-receive] Installing deps..."
    npm install
    echo "[post-receive] Building frontend..."
    npx vite build
    echo "[post-receive] Restarting cui-workspace..."
    systemctl restart cui-workspace 2>/dev/null && echo "[post-receive] Service restarted" || echo "[post-receive] WARNING: restart failed"
    echo "[post-receive] Deploy complete"
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
