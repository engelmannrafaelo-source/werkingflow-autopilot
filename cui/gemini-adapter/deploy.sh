#!/bin/bash
# Deploy Gemini Adapter + CUI changes to dev server
# Run from Mac: bash /path/to/deploy.sh

set -e
DEV=root@100.121.161.109
CUI_LOCAL=/Users/rafael/Documents/GitHub/werkingflow/autopilot/cui
CUI_REMOTE=/root/projekte/werkingflow/autopilot/cui

echo "=== Deploying Gemini Adapter to dev server ==="

# 1. Sync gemini-adapter (new directory)
echo "[1/4] Syncing gemini-adapter..."
rsync -avz --exclude='node_modules' --exclude='.DS_Store' \
  "$CUI_LOCAL/gemini-adapter/" \
  "$DEV:$CUI_REMOTE/gemini-adapter/"

# 2. Sync modified server files
echo "[2/4] Syncing server changes..."
rsync -avz "$CUI_LOCAL/server/routes/proxy.ts" "$DEV:$CUI_REMOTE/server/routes/proxy.ts"
rsync -avz "$CUI_LOCAL/server/routes/mission.ts" "$DEV:$CUI_REMOTE/server/routes/mission.ts"

# 3. Sync modified frontend files
echo "[3/4] Syncing frontend changes..."
rsync -avz "$CUI_LOCAL/src/types/index.ts" "$DEV:$CUI_REMOTE/src/types/index.ts"
rsync -avz "$CUI_LOCAL/src/components/LayoutManager.tsx" "$DEV:$CUI_REMOTE/src/components/LayoutManager.tsx"
rsync -avz "$CUI_LOCAL/src/components/LayoutBuilder.tsx" "$DEV:$CUI_REMOTE/src/components/LayoutBuilder.tsx"
rsync -avz "$CUI_LOCAL/src/components/panels/CuiLitePanel.tsx" "$DEV:$CUI_REMOTE/src/components/panels/CuiLitePanel.tsx"

# 4. Install + build on dev server
echo "[4/4] Installing dependencies + building on dev server..."
ssh "$DEV" 'cd /root/projekte/werkingflow/autopilot/cui/gemini-adapter && npm install && npx tsc'

echo ""
echo "=== Files deployed! ==="
echo ""
echo "Now run ON THE DEV SERVER (ssh $DEV):"
echo ""
echo "  # 1. Upgrade Gemini CLI"
echo "  npm install -g @google/gemini-cli@latest"
echo ""
echo "  # 2. Copy OAuth credentials for claude-user"
echo "  cp -r /root/.gemini/ /home/claude-user/.gemini/"
echo "  chown -R claude-user:claude-user /home/claude-user/.gemini/"
echo ""
echo "  # 3. Start Gemini adapter (test)"
echo "  cd /root/projekte/werkingflow/autopilot/cui/gemini-adapter"
echo "  PORT=4010 node dist/index.js"
echo ""
echo "  # 4. In another terminal: rebuild + restart CUI"
echo "  cd /root/projekte/werkingflow/autopilot/cui && npm run build"
echo "  systemctl restart cui-workspace"
echo ""
echo "  # 5. Verify"
echo "  curl http://localhost:4010/api/health"
