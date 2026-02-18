#!/bin/bash
# Quick build script to bypass vite issues

echo "Building CUI workspace without vite..."

# Copy HTML
cp src/index.html dist/index.html

# Bundle JS with esbuild (simpler than vite)
npx esbuild src/main.tsx --bundle --outfile=dist/main.js \
  --loader:.tsx=tsx --loader:.ts=ts --loader:.jsx=jsx --loader:.js=js \
  --platform=browser --target=es2020 --sourcemap

echo "Build complete! Files in dist/"