#!/bin/bash
# ============================================================================
# CUI Workspace - Cache Cleaning Script
# ============================================================================
# Cleans node_modules cache, vite cache, and build artifacts
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

echo "========================================"
echo "  CUI WORKSPACE - CACHE CLEANUP"
echo "========================================"

# Remove Vite cache
if [ -d "node_modules/.vite" ]; then
  rm -rf node_modules/.vite
  echo "✓ Removed node_modules/.vite"
fi

# Remove general node cache
if [ -d "node_modules/.cache" ]; then
  rm -rf node_modules/.cache
  echo "✓ Removed node_modules/.cache"
fi

# Remove dist (build output)
if [ -d "dist" ]; then
  rm -rf dist
  echo "✓ Removed dist/"
fi

# Remove esbuild cache
if [ -d "node_modules/.esbuild" ]; then
  rm -rf node_modules/.esbuild
  echo "✓ Removed node_modules/.esbuild"
fi

echo ""
echo "✓ Cache cleanup complete"
