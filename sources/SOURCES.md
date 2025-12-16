# Kontext-Quellen Definition

> Dieses File definiert, welche Quellen automatisch den CONTEXT.md aktualisieren können.

## Konzept

Der Kontext (CONTEXT.md) ist nicht statisch. Er kann automatisch aus verschiedenen Quellen aktualisiert werden:

```
Quellen (Emails, Dateien, APIs)
        │
        ▼
   Source Collector
        │
        ▼
   Context Updater
        │
        ▼
    CONTEXT.md (aktualisiert)
```

## Definierte Quellen

### 1. Coach MCP (Emails & Produktivität)

```yaml
source: coach_mcp
enabled: true
update_frequency: daily
extracts:
  - priorities: "Aktuelle Prioritäten aus Morning/Evening Rituals"
  - decisions: "Offene Entscheidungen aus Emails"
  - project_updates: "Projekt-Status Updates"
integration:
  tool: mcp__coach__coach_email_summary
  scope: last_7_days
```

**Was wird extrahiert:**
- Prioritäten aus täglichen Ritualen
- Projekt-Updates aus Email-Threads
- Offene Entscheidungen/Fragen

### 2. Git Repositories

```yaml
source: git_repos
enabled: true
update_frequency: on_change
repos:
  - path: /Users/rafael/Documents/GitHub/werkflow
    extracts:
      - recent_commits: "Letzte 10 Commits für Kontext"
      - open_issues: "Offene GitHub Issues"
  - path: /Users/rafael/Documents/GitHub/ai-bridge
    extracts:
      - recent_commits: "Änderungen am AI Gateway"
```

**Was wird extrahiert:**
- Letzte Commits (was wurde kürzlich gemacht)
- Offene Issues (was steht noch an)
- Branch-Status

### 3. Lokale Dokumentation

```yaml
source: local_files
enabled: true
update_frequency: weekly
files:
  - path: ~/Documents/Business/Strategie.md
    section: "Aktuelle Prioritäten"
  - path: ~/Documents/Kunden/Übersicht.md
    section: "Mein Business"
```

**Was wird extrahiert:**
- Strategische Dokumente
- Kunden-Übersichten
- Business-Pläne

### 4. Manuelle Updates

```yaml
source: manual
enabled: true
description: "Direkte Änderungen an CONTEXT.md"
```

## Update-Prozess

### Automatisch (geplant)

```bash
# Täglich um 6:00 Uhr
0 6 * * * /path/to/werkingflow-autopilot/orchestrator/update-context.sh
```

### Manuell

```bash
# Kontext jetzt aktualisieren
./orchestrator/update-context.sh

# Nur bestimmte Quelle
./orchestrator/update-context.sh --source coach_mcp
```

## Beispiel: Kontext-Update aus Email

**Input** (Email via Coach MCP):
```
Von: kunde@teufel.at
Betreff: Risikoanalyse - Änderung Deadline

Hallo Rafael,
die Deadline für den PoC verschiebt sich auf Ende Januar...
```

**Output** (CONTEXT.md Update):
```markdown
## Aktuelle Prioritäten
...
- Teufel Risikoanalyse-PoC: **Deadline verschoben auf Ende Januar**
```

## Sicherheit & Datenschutz

- Quellen werden **lokal** verarbeitet
- Keine Daten verlassen das System
- Sensitive Informationen werden gefiltert
- CONTEXT.md enthält keine Passwörter/Tokens

## Erweiterbarkeit

Neue Quellen können einfach hinzugefügt werden:

```yaml
source: neue_quelle
enabled: true
type: api | file | mcp | custom
handler: path/to/handler.py  # Optional: Custom Handler
extracts:
  - field_name: "Beschreibung was extrahiert wird"
```

## Status

| Quelle | Status | Letzte Aktualisierung |
|--------|--------|----------------------|
| coach_mcp | Geplant | - |
| git_repos | Geplant | - |
| local_files | Geplant | - |
| manual | Aktiv | Initial |
