# Adaptive Hierarchie - Registry-basiert

## Kern-Konzept

**Levels sind NICHT global fixiert** - jedes Projekt definiert seine eigenen Levels in `CONFIG.yaml`.

```
Autopilot (Scanner)
     │
     ▼
Registry (projects/)
     │
     ├── werkflow/
     │   ├── CONFIG.yaml  ← Definiert 4 Levels: Vision → Module → Features → Tasks
     │   └── GOAL.md
     │
     └── teufel-ai/
         ├── CONFIG.yaml  ← Definiert 3 Levels: PoC Status → Phasen → Phase Details
         └── GOAL.md
```

## Warum adaptiv?

Verschiedene Projekte brauchen verschiedene Strukturen:

| Projekt | Sinnvolle Levels |
|---------|-----------------|
| **werkflow** | Vision → Module → Features → Tasks |
| **teufel-ai** | PoC → Phasen → Details |
| **kleine-app** | Ziel → Tasks (nur 2!) |
| **enterprise** | Strategy → Domain → Module → Feature → Task (5!) |

## CONFIG.yaml

Jedes Projekt definiert seine Struktur:

```yaml
# projects/mein-projekt/CONFIG.yaml

name: "mein-projekt"
repo: "/path/to/repo"

# Adaptive Levels - so viele wie nötig
levels:
  - name: "Vision"
    file: "GOAL.md"
    description: "Was soll das Projekt werden?"

  - name: "Features"
    file: "FEATURES.md"
    description: "Geplante Features"

  - name: "Tasks"
    file: "TASKS.md"
    description: "Konkrete Aufgaben"

# Projekt-spezifische Prompts
prompts:
  analyze: |
    Analysiere dieses Projekt...
  plan: |
    Plane die nächsten Schritte...
  execute: |
    Implementiere den Plan...

# Git-Einstellungen
git:
  branch_prefix: "mein-projekt"
  main_branch: "main"

priority: 1
```

## Autopilot als Scanner

Der Autopilot selbst macht nur:

1. **Scannt** die Registry (projects/)
2. **Liest** CONFIG.yaml pro Projekt
3. **Zeigt** die Levels adaptiv an
4. **Navigiert** durch die Struktur

Die **konkreten Prompts** und **Ausführungslogik** sind in den Projekten!

## Workflow

```
$ ./orchestrator/plan.sh

╔═══════════════════════════════════════════════════╗
║        WerkingFlow Autopilot - Registry           ║
╚═══════════════════════════════════════════════════╝

🔍 Scanne Registry...

Projekte:
  ▸ werkflow (Prio: 1, Levels: 4)
    Vision → Module → Features → Tasks

  ▸ teufel-ai (Prio: 1, Levels: 3)
    PoC Status → Phasen → Phase Details

autopilot> show werkflow
[Zeigt Level 0: Vision]

autopilot> deeper werkflow
[Zeigt Level 1: Module]

autopilot> go werkflow
✅ Starte Arbeit an: werkflow
  1. cd /path/to/werkflow
  2. claude  # Claude liest automatisch GOAL.md + CONFIG.yaml
```

## Vorteile

1. **Flexibel**: Jedes Projekt hat seine eigene Struktur
2. **Skalierbar**: Neue Projekte = neuer Ordner mit CONFIG.yaml
3. **Dezentral**: Prompts leben im Projekt, nicht im Autopilot
4. **Erweiterbar**: Projekt kann beliebig viele Levels haben
5. **Übersichtlich**: Autopilot zeigt nur, was existiert

## Migration

Wenn ein Projekt nur GOAL.md hat (kein CONFIG.yaml):
- Autopilot verwendet Fallback mit einem Level
- Bei Bedarf: CONFIG.yaml hinzufügen für mehr Struktur
