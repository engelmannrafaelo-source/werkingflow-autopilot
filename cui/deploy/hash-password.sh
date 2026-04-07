#!/bin/bash
# ============================================================================
# Hash Password for users.json
# ============================================================================
# Generates a SHA-256 hash for use in users.json passwordHash field.
#
# USAGE:
#   ./hash-password.sh                    # Interactive (prompts for password)
#   ./hash-password.sh "MyPassword123"    # Direct
#
# OUTPUT:
#   sha256:a1b2c3d4...   (paste this into users.json "passwordHash" field)
# ============================================================================

if [ -n "${1:-}" ]; then
  PASSWORD="$1"
else
  echo -n "Enter password: "
  read -rs PASSWORD
  echo ""
  echo -n "Confirm password: "
  read -rs PASSWORD2
  echo ""
  if [ "$PASSWORD" != "$PASSWORD2" ]; then
    echo "ERROR: Passwords do not match" >&2
    exit 1
  fi
fi

if [ -z "$PASSWORD" ]; then
  echo "ERROR: Password cannot be empty" >&2
  exit 1
fi

HASH=$(echo -n "$PASSWORD" | sha256sum | cut -d' ' -f1)
echo "sha256:$HASH"
