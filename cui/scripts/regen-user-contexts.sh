#!/bin/bash
# ============================================================================
# regen-user-contexts.sh — Generates per-user CLAUDE.md from users.json
# ============================================================================
# Reads users.json and writes a personalized CLAUDE.md to /home/<user-id>/
# so Claude Code automatically picks it up via hierarchical CLAUDE.md discovery.
#
# Each user's CLAUDE.md tells Claude:
#   - Who they are (name, email, role)
#   - Which dev port range they own (devPortRange)
#   - Which workspaces they can access
#   - Their git/edit permissions
#
# Run as root (CUI service user lacks write perms on user homes).
#
# USAGE:
#   regen-user-contexts.sh                          # uses default users.json
#   USERS_JSON=/path/to/users.json regen-user-contexts.sh
#
# Idempotent — safe to run on every CUI service start.
# ============================================================================
set -e

USERS_JSON="${USERS_JSON:-/opt/cui-workspace-data/users.json}"

if [ ! -f "$USERS_JSON" ]; then
  echo "[regen-user-contexts] users.json not found at $USERS_JSON — skipping"
  exit 0
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "[regen-user-contexts] jq not installed — cannot parse users.json"
  exit 1
fi

WRITTEN=0
SKIPPED=0

# Stream user records as TSV: id\tname\temail\trole\trange\tworkspaces\tgitpush\tapprove
jq -r '.users[] | [
  .id,
  .name,
  .email,
  .role,
  (if .devPortRange == "*" then "*"
   elif (.devPortRange | type) == "array" then "\(.devPortRange[0])-\(.devPortRange[1])"
   else "none" end),
  (if .allowedWorkspaces == "*" then "*"
   elif (.allowedWorkspaces | type) == "array" then (.allowedWorkspaces | join(", "))
   else "none" end),
  (.canGitPush | tostring),
  (.canApproveEdits | tostring)
] | @tsv' "$USERS_JSON" | while IFS=$'\t' read -r id name email role range workspaces gitpush approve; do
  HOME_DIR="/home/$id"
  if [ ! -d "$HOME_DIR" ]; then
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  TARGET="$HOME_DIR/CLAUDE.md"

  # Pretty range hint
  case "$range" in
    "*")    RANGE_HINT="**alle Ports erlaubt** (Admin)" ;;
    "none") RANGE_HINT="**kein eigener Port-Range** (nur shared infra ports)" ;;
    *)      RANGE_HINT="**$range** — eigene Mockups/Dev-Server hier laufen lassen" ;;
  esac

  cat > "$TARGET" <<EOF
# Dein Setup — $name

> Auto-generiert von CUI aus \`users.json\`. Nicht manuell editieren — wird bei
> jedem CUI-Service-Start (oder via \`regen-user-contexts.sh\`) überschrieben.

## Wer Du bist

- **User-ID:** \`$id\`
- **Name:** $name
- **Email:** $email
- **Rolle:** \`$role\`

## Deine Ports

- **Dev-Port-Range:** $RANGE_HINT
- **Shared Infra Ports** (für alle User): 3006 (Safety), 3007 (Energy), 3008 (Report), 3009 (Engelmann)

→ Wenn Du eigene Mockups/Dev-Server startest, nutze **immer** Deinen Range.
→ Außerhalb Deines Range + Shared Ports gibt es **HTTP 403**.

## Deine Workspaces

$workspaces

## Berechtigungen

- **Git Push:** $gitpush
- **Approve Edits:** $approve

---

## Wie Du eine App startest und siehst

Apps laufen **unverändert auf ihrem Port** — kein basePath, kein Asset-Rewrite,
kein Build-Trick. Wie Remote-Desktop: starten, anschauen, fertig.

\`\`\`bash
# Im Projekt-Verzeichnis:
npm run dev   # Port via package.json scripts.dev festgelegt
# ODER explizit:
PORT=$(echo "$range" | cut -d- -f1) npm run dev
\`\`\`

**Erreichbar unter:** \`https://<port>.partner.werking.tools/\`
(Wildcard-Subdomain proxy → \`localhost:<port>\` mit Auth-Gate.)

Beispiel: \`PORT=$(echo "$range" | cut -d- -f1) npm run dev\` → Browser öffnet
\`https://$(echo "$range" | cut -d- -f1).partner.werking.tools/\`.

Browser-Panel in CUI nutzt automatisch dieses Pattern — sobald der Workspace-Default-Port
korrekt gesetzt ist musst Du nichts manuell tippen.
EOF

  chown "$id:$id" "$TARGET" 2>/dev/null || true
  chmod 644 "$TARGET"
  WRITTEN=$((WRITTEN + 1))
done

echo "[regen-user-contexts] done"
