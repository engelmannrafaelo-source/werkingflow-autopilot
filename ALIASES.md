# WerkingFlow Autopilot - Shell Aliases

Füge diese Aliases zu deiner `~/.zshrc` oder `~/.bashrc` hinzu:

```bash
# WerkingFlow Autopilot Aliases
export AUTOPILOT_DIR="$HOME/Documents/GitHub/werkingflow-autopilot"

# Morning Workflow - Jeden Tag als erstes ausführen
alias autopilot-morning="cd $AUTOPILOT_DIR && ./orchestrator/plan.sh --morning"

# Daily Routine - Nur Cleanup und Health Checks
alias autopilot-daily="cd $AUTOPILOT_DIR && ./orchestrator/plan.sh --daily"

# Interaktiver Modus
alias autopilot="cd $AUTOPILOT_DIR && ./orchestrator/plan.sh"

# Schnell einen Plan erstellen
alias autopilot-plan="cd $AUTOPILOT_DIR && ./orchestrator/plan.sh --auto"

# Autonome Ausführung
alias autopilot-execute="cd $AUTOPILOT_DIR && ./orchestrator/plan.sh --execute"

# Direkt loop.sh für ein Projekt
alias autopilot-loop="cd $AUTOPILOT_DIR && ./orchestrator/loop.sh"

# Mode-spezifische Shortcuts
alias autopilot-cleanup="cd $AUTOPILOT_DIR && ./orchestrator/loop.sh --mode cleanup"
alias autopilot-arch="cd $AUTOPILOT_DIR && ./orchestrator/loop.sh --mode architecture"
alias autopilot-features="cd $AUTOPILOT_DIR && ./orchestrator/loop.sh --mode features"
```

## Verwendung

### Morgendlicher Workflow (empfohlen)
```bash
autopilot-morning
```
Führt aus:
1. Daily Routine (Cleanup, Health Checks)
2. Zeigt Branch-Übersicht
3. Fragt was gemerged werden soll
4. Bietet weitere Optionen

### Nur Daily Checks
```bash
autopilot-daily
```
Führt nur die 9 Standard-Checks aus ohne weitere Interaktion.

### Interaktiver Modus
```bash
autopilot
```
Öffnet das interaktive Menü.

### Plan erstellen und ausführen
```bash
autopilot-execute werkflow
```
Erstellt Plan für werkflow und führt ihn autonom aus.

### Direkter Loop
```bash
autopilot-loop werkflow --timeout 1h
```
Startet direkt den autonomen Loop für ein Projekt.

## Mode-Auswahl (NEU!)

Du kannst gezielt nur bestimmte Aufgaben ausführen lassen:

### Nur Cleanup (console.log, dead code, etc.)
```bash
autopilot-loop werkflow --mode cleanup
# oder kurz:
autopilot-cleanup werkflow
```

### Nur Architektur (Refactoring, DRY, etc.)
```bash
autopilot-loop werkflow --mode architecture
# oder kurz:
autopilot-arch werkflow
```

### Nur Features (neue Funktionalität)
```bash
autopilot-loop werkflow --mode features
# oder kurz:
autopilot-features werkflow
```

### Full Mode (alles, Default)
```bash
autopilot-loop werkflow --mode full
# oder einfach:
autopilot-loop werkflow
```

## Live Monitoring

Mit `--watch` siehst du eine Live-Statusleiste während Claude arbeitet:

```bash
autopilot-loop werkflow --watch
```

Zeigt:
- ⏱ Elapsed Time
- 📝 Modified Files
- 📋 Log Size
- Project Name

## Outputs

- **Logs**: `logs/YYYY-MM-DD/projekt.log` - Vollständige Claude-Ausgabe
- **Summaries**: `summaries/projekt-YYYY-MM-DD-HHMM.md` - Merge-Summary
- **SUMMARY.md**: Im Projekt-Repo - Was wurde gemacht
- **BLOCKED.md**: Im Projekt-Repo - Falls Claude blockiert ist

## Nach Installation

```bash
source ~/.zshrc  # oder ~/.bashrc
autopilot-morning
```
