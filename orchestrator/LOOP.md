# Orchestrator Loop Definition

> Diese Datei definiert wie der Loop funktionieren soll.
> Die eigentliche Implementierung (loop.sh) kommt später.

## Konzept

```
┌─────────────────────────────────────────────────────────────┐
│                     AUTOPILOT LOOP                          │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────┐
              │   1. PROJEKT WÄHLEN     │
              │   (Argument oder Menu)   │
              └─────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────┐
              │   2. KONTEXT LADEN      │
              │   - CONTEXT.md          │
              │   - GOAL.md             │
              │   - SYSTEM.md           │
              └─────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────┐
              │   3. CLAUDE STARTEN     │
              │   Mit vollem Kontext    │
              │   --dangerously-skip-   │
              │   permissions           │
              └─────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────┐
              │   4. AUTONOME ARBEIT    │
              │   Claude arbeitet bis:  │
              │   - Ziel erreicht       │
              │   - Blockiert           │
              │   - Timeout             │
              └─────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────┐
              │   5. LOG SPEICHERN      │
              │   logs/YYYY-MM-DD/      │
              │   projekt.log           │
              └─────────────────────────┘
```

## Pseudo-Implementation

```bash
#!/bin/bash
# orchestrator/loop.sh (kommt später)

PROJECT=$1
AUTOPILOT_DIR="$(dirname "$0")/.."
PROJECT_DIR="$AUTOPILOT_DIR/projects/$PROJECT"
REPO_PATH=$(cat "$PROJECT_DIR/repo.txt")
LOG_DIR="$AUTOPILOT_DIR/logs/$(date +%Y-%m-%d)"

# Verzeichnis erstellen
mkdir -p "$LOG_DIR"

# In Repo wechseln
cd "$REPO_PATH"

# Kontext zusammenbauen
CONTEXT=$(cat "$AUTOPILOT_DIR/CONTEXT.md")
GOAL=$(cat "$PROJECT_DIR/GOAL.md")
SYSTEM=$(cat "$AUTOPILOT_DIR/orchestrator/SYSTEM.md")

# Claude Code starten
claude \
    --system-prompt "$SYSTEM" \
    --prompt "
KONTEXT:
$CONTEXT

PROJEKT-ZIEL:
$GOAL

Analysiere den aktuellen Stand dieses Repos und arbeite autonom
auf das Ziel hin. Logge deinen Fortschritt.
" \
    --dangerously-skip-permissions \
    2>&1 | tee "$LOG_DIR/${PROJECT}.log"
```

## Aufruf-Varianten

### Einzelnes Projekt
```bash
./orchestrator/loop.sh werkflow
./orchestrator/loop.sh teufel-ai
```

### Alle Projekte nacheinander
```bash
for project in projects/*/; do
    ./orchestrator/loop.sh "$(basename "$project")"
done
```

### Als Alias
```bash
# In ~/.bashrc oder ~/.zshrc
alias autopilot="cd ~/werkingflow-autopilot && for p in projects/*/; do ./orchestrator/loop.sh \$(basename \$p); done"
```

### Mit Cron (täglich)
```bash
# 0 6 * * * = Jeden Tag um 6:00 Uhr
0 6 * * * /Users/rafael/werkingflow-autopilot/orchestrator/loop.sh werkflow
0 7 * * * /Users/rafael/werkingflow-autopilot/orchestrator/loop.sh teufel-ai
```

## Erweiterungen (Zukunft)

### Parallele Ausführung
```bash
# Mehrere Projekte gleichzeitig
parallel ./orchestrator/loop.sh ::: werkflow teufel-ai engelmann
```

### Mit Timeout
```bash
# Max 2 Stunden pro Projekt
timeout 2h ./orchestrator/loop.sh werkflow
```

### Mit Notification
```bash
# Slack/Discord Notification nach Abschluss
./orchestrator/loop.sh werkflow && \
    curl -X POST $WEBHOOK_URL -d '{"text":"Autopilot: werkflow fertig"}'
```

## Status-Tracking

Nach jedem Run wird gespeichert:
- `logs/YYYY-MM-DD/projekt.log` - Vollständiges Log
- `logs/YYYY-MM-DD/projekt.status` - Kurz-Status

Status-Format:
```yaml
project: werkflow
started: 2025-12-16T06:00:00
finished: 2025-12-16T08:30:00
duration: 2h30m
result: success | blocked | timeout | error
commits: 5
tasks_completed: 3
tasks_remaining: 2
```
