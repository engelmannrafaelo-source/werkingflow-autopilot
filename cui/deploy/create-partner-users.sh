#!/bin/bash
# ============================================================================
# Create users.json for a partner server
# ============================================================================
# Supports BOTH interactive and batch mode.
#
# USAGE:
#   Interactive:  ./create-partner-users.sh [output-path]
#   Batch:        ./create-partner-users.sh --from-json users-input.json [output-path]
#
# Batch JSON format:
#   [
#     {"id": "rafael", "name": "Rafael Engelmann", "email": "rafael@werkingflow.com",
#      "password": "SecurePass123", "role": "admin", "claudeAccountId": "default"},
#     {"id": "david-steiner", "name": "David Steiner", "email": "david@steiner.at",
#      "password": "SecurePass456", "role": "product-owner"}
#   ]
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Role-based defaults ─────────────────────────────────────────────────
get_role_defaults() {
  local role="$1"
  case "$role" in
    admin)
      PANELS='"*"'
      WORKSPACES='"*"'
      CAN_GIT_PUSH=true
      CAN_APPROVE=true
      ;;
    product-owner)
      PANELS='["cui-lite","chat","browser","preview","notes","mission","qa-dashboard","architecture"]'
      WORKSPACES='"*"'
      CAN_GIT_PUSH=true
      CAN_APPROVE=true
      ;;
    fachpartner)
      PANELS='["cui-lite","chat","browser","preview","notes"]'
      WORKSPACES='"*"'
      CAN_GIT_PUSH=false
      CAN_APPROVE=false
      ;;
    *)
      echo "ERROR: Unknown role '$role'. Must be: admin, product-owner, fachpartner" >&2
      return 1
      ;;
  esac
}

# ── Build user JSON object ──────────────────────────────────────────────
build_user_json() {
  local id="$1" name="$2" email="$3" password="$4" role="$5" claude_account="${6:-default}"

  get_role_defaults "$role" || return 1

  local hash="sha256:$(echo -n "$password" | sha256sum | cut -d' ' -f1)"

  cat <<USEREOF
{
  "id": "$id",
  "name": "$name",
  "email": "$email",
  "passwordHash": "$hash",
  "role": "$role",
  "claudeAccountId": "$claude_account",
  "allowedPanels": $PANELS,
  "allowedWorkspaces": $WORKSPACES,
  "canGitPush": $CAN_GIT_PUSH,
  "canApproveEdits": $CAN_APPROVE,
  "active": true
}
USEREOF
}

# ── BATCH MODE ──────────────────────────────────────────────────────────
if [ "${1:-}" = "--from-json" ]; then
  INPUT_JSON="${2:-}"
  OUTPUT="${3:-$SCRIPT_DIR/../data/users.json}"

  if [ -z "$INPUT_JSON" ] || [ ! -f "$INPUT_JSON" ]; then
    echo "ERROR: Input JSON file required: --from-json <input.json> [output-path]" >&2
    echo "" >&2
    echo "Format:" >&2
    echo '  [{"id":"rafael","name":"Rafael Engelmann","email":"rafael@werkingflow.com",' >&2
    echo '    "password":"SecurePass","role":"admin"}]' >&2
    exit 1
  fi

  echo "========================================"
  echo "  Create Partner Users (Batch Mode)"
  echo "========================================"
  echo "  Input:  $INPUT_JSON"
  echo "  Output: $OUTPUT"
  echo ""

  USERS_JSON='{"version":"1.0","users":[]}'
  USER_COUNT=0

  # Read each user from input JSON
  while IFS= read -r user_line; do
    id=$(echo "$user_line" | jq -r '.id')
    name=$(echo "$user_line" | jq -r '.name')
    email=$(echo "$user_line" | jq -r '.email')
    password=$(echo "$user_line" | jq -r '.password')
    role=$(echo "$user_line" | jq -r '.role // "product-owner"')
    claude_account=$(echo "$user_line" | jq -r '.claudeAccountId // "default"')

    if [ -z "$id" ] || [ "$id" = "null" ]; then
      echo "  SKIP: Entry missing 'id'" >&2
      continue
    fi
    if [ -z "$password" ] || [ "$password" = "null" ]; then
      echo "  SKIP: $id missing 'password'" >&2
      continue
    fi

    USER_OBJ=$(build_user_json "$id" "$name" "$email" "$password" "$role" "$claude_account")
    if [ $? -ne 0 ]; then
      echo "  SKIP: $id — invalid role" >&2
      continue
    fi

    USERS_JSON=$(echo "$USERS_JSON" | jq --argjson user "$USER_OBJ" '.users += [$user]')
    USER_COUNT=$((USER_COUNT + 1))
    echo "  + $id ($role) — $email"
  done < <(jq -c '.[]' "$INPUT_JSON")

  if [ "$USER_COUNT" -eq 0 ]; then
    echo "ERROR: No valid users found in $INPUT_JSON" >&2
    exit 1
  fi

  mkdir -p "$(dirname "$OUTPUT")"
  echo "$USERS_JSON" | jq '.' > "$OUTPUT"

  echo ""
  echo "========================================"
  echo "  Created $USER_COUNT user(s) in $OUTPUT"
  echo "========================================"
  exit 0
fi

# ── INTERACTIVE MODE ────────────────────────────────────────────────────
OUTPUT="${1:-$SCRIPT_DIR/../data/users.json}"

if [ -f "$OUTPUT" ]; then
  echo "WARNING: $OUTPUT already exists."
  echo -n "Overwrite? (y/N) "
  read -r reply
  [ "$reply" = "y" ] || exit 0
fi

echo "========================================"
echo "  Create Partner Users (Interactive)"
echo "========================================"
echo ""

USERS_JSON='{"version":"1.0","users":[]}'
USER_COUNT=0

while true; do
  echo "--- User $((USER_COUNT + 1)) ---"

  echo -n "User ID (e.g. david): "
  read -r USER_ID
  [ -z "$USER_ID" ] && break

  echo -n "Full name: "
  read -r USER_NAME

  echo -n "Email: "
  read -r USER_EMAIL

  echo -n "Password: "
  read -rs USER_PASS
  echo ""

  echo "Roles: admin, product-owner, fachpartner"
  echo -n "Role [product-owner]: "
  read -r USER_ROLE
  USER_ROLE="${USER_ROLE:-product-owner}"

  echo -n "Claude Account ID [default]: "
  read -r CLAUDE_ACCOUNT
  CLAUDE_ACCOUNT="${CLAUDE_ACCOUNT:-default}"

  USER_OBJ=$(build_user_json "$USER_ID" "$USER_NAME" "$USER_EMAIL" "$USER_PASS" "$USER_ROLE" "$CLAUDE_ACCOUNT")
  if [ $? -ne 0 ]; then
    continue
  fi

  USERS_JSON=$(echo "$USERS_JSON" | jq --argjson user "$USER_OBJ" '.users += [$user]')
  USER_COUNT=$((USER_COUNT + 1))

  echo ""
  echo -n "Add another user? (y/N) "
  read -r more
  [ "$more" = "y" ] || break
  echo ""
done

if [ "$USER_COUNT" -eq 0 ]; then
  echo "No users created. Exiting."
  exit 0
fi

mkdir -p "$(dirname "$OUTPUT")"
echo "$USERS_JSON" | jq '.' > "$OUTPUT"

echo ""
echo "========================================"
echo "  Created $USER_COUNT user(s) in $OUTPUT"
echo "========================================"
echo ""
cat "$OUTPUT"
