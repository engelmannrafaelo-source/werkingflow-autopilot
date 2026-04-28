#!/bin/bash
# ============================================================================
# Build tester-po image on Dev + ship to Partner via docker save | docker load
# ============================================================================
# Run from Dev. Idempotent — re-runs cheap thanks to layer caching.
#
# USAGE:
#   ./ship-tester-po-image.sh [tailscale-ip]   # default: 100.119.199.86
#   DRY_RUN=1 ./ship-tester-po-image.sh        # build only, no ship
# ============================================================================
set -euo pipefail

TARGET="${1:-100.119.199.86}"
DRY_RUN="${DRY_RUN:-0}"
IMAGE="tester-po:latest"
CTX_DIR="$(cd "$(dirname "$0")/../tester-po" && pwd)"

echo "========================================"
echo "  Build + ship tester-po → $TARGET"
echo "  Context: $CTX_DIR"
echo "========================================"

# 1. Build on Dev
echo "[1/3] docker build $IMAGE..."
docker build -t "$IMAGE" "$CTX_DIR"

if [ "$DRY_RUN" = "1" ]; then
  echo "  DRY RUN — skipping ship"
  exit 0
fi

# 2. Ship via save|load (atomic — partner sees old image until load completes)
echo "[2/3] Saving + loading on $TARGET (may take 1-2 min, image ~1GB)..."
docker save "$IMAGE" | ssh "root@$TARGET" 'docker load'

# 3. Verify
echo "[3/3] Verifying image on $TARGET..."
ssh "root@$TARGET" "docker image inspect $IMAGE --format '{{.Id}} {{.Created}}'"

echo ""
echo "========================================"
echo "  ship-tester-po-image: SUCCESS"
echo "========================================"
