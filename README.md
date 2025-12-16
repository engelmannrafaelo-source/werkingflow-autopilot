# WerkingFlow Autopilot

**Hierarchische AI-Entwicklung mit Plan-Propagation & Approval Gates**

> **AI Agent?** Start hier: [GOAL.md](GOAL.md) - Definiert was dieses Repo werden soll und wie du es weiterentwickeln kannst.

---

## Vision

Ein System für **kontrollierte AI-Entwicklung** durch hierarchische Plan-Propagation.

**Du behältst die Kontrolle** - AI plant, du entscheidest die Tiefe.

## Paradigmenwechsel

| Alt (Prescriptive) | Neu (Hierarchical) |
|-------------------|---------------------|
| "Tu genau das" | "Das ist das Ziel, plane die Umsetzung" |
| Detaillierte Anweisungen | Plan-Hierarchie mit Approval Gates |
| AI folgt blind | AI plant, User genehmigt |
| Alles oder nichts | Variable Tiefe nach Bedarf |

## Kernidee

```
PLANE ZUERST → WARTE AUF APPROVAL → DANN AUSFÜHREN
```

Opus 4.5 ist intelligent genug zum Planen. Aber **DU entscheidest**:

1. **"Go!"** → Plan ausführen (auf aktueller Ebene)
2. **"Deeper"** → Mehr Details zeigen (nächste Ebene)
3. **"Adjust"** → Plan anpassen

## Adaptive Levels (Registry-basiert)

Levels sind **NICHT global fixiert** - jedes Projekt definiert eigene Struktur!

```
Autopilot scannt Registry (projects/)
     │
     ├── werkflow/CONFIG.yaml    → 4 Levels: Vision → Module → Features → Tasks
     └── teufel-ai/CONFIG.yaml   → 3 Levels: PoC → Phasen → Details
```

Siehe [orchestrator/HIERARCHY.md](orchestrator/HIERARCHY.md) für Details.

## Struktur

```
werkingflow-autopilot/
├── GOAL.md                 # ⭐ META: Was soll der Autopilot selbst werden?
├── CONTEXT.md              # Deine Situation (dynamisch aus Quellen!)
├── sources/
│   └── SOURCES.md          # Quellen für automatische Kontext-Updates
├── orchestrator/
│   ├── plan.sh             # 🚀 Interaktiver Registry-Scanner
│   ├── SYSTEM.md           # AI Rolle: Hierarchischer Planner
│   ├── HIERARCHY.md        # Adaptive Levels erklärt
│   └── GIT_STRATEGY.md     # Branch-Logik pro Ebene
├── projects/               # = REGISTRY (Ordner = Projekt)
│   ├── _template/          # Template für neue Projekte
│   ├── werkflow/
│   │   ├── CONFIG.yaml     # 🆕 Levels, Prompts, Git-Settings
│   │   ├── GOAL.md         # Erfolgskriterien
│   │   └── repo.txt        # Pfad zum echten Repository
│   └── teufel-ai/
│       ├── CONFIG.yaml     # 🆕 Projekt-spezifische Konfiguration
│       └── GOAL.md
└── logs/                   # Was wurde gemacht?
```

## Quick Start

```bash
# 1. Starten
./orchestrator/plan.sh

# 2. Interaktive Befehle
autopilot> list                    # Registry Overview
autopilot> show werkflow           # Projekt-Details
autopilot> deeper werkflow         # Nächstes Level
autopilot> branch werkflow auth    # Feature-Branch erstellen
autopilot> go werkflow             # Projekt starten (mit optionalem Branch)
```

### Neues Projekt anlegen

```bash
# 1. Ordner erstellen
mkdir -p projects/neuer-kunde

# 2. CONFIG.yaml anlegen (definiert Levels + Prompts)
cat > projects/neuer-kunde/CONFIG.yaml << 'EOF'
name: "neuer-kunde"
repo: "/path/to/repo"
levels:
  - name: "Ziel"
    file: "GOAL.md"
  - name: "Features"
    file: "FEATURES.md"
priority: 1
EOF

# 3. GOAL.md anlegen
cat > projects/neuer-kunde/GOAL.md << 'EOF'
# Projekt: Neuer Kunde
## Wann fertig
- [ ] Login funktioniert
- [ ] Reports generierbar
EOF

# 4. Fertig - erscheint automatisch in der Registry!
```

## Git-Strategie

Jede Plan-Ebene → eigener Branch:

```
main
 └── autopilot/sprint-2024-12-16          ← MASTER_PLAN Branch
      ├── werkflow/auth-refactor          ← Feature Branch
      ├── werkflow/billing-extension
      └── teufel-ai/phase-3
```

Siehe [orchestrator/GIT_STRATEGY.md](orchestrator/GIT_STRATEGY.md) für Details.

## Warum das funktioniert

1. **Opus 4.5 ist SMART** - Plant intelligent auf jeder Ebene
2. **Kontext ist König** - CONTEXT.md gibt ihm DEIN Wissen
3. **Kontrolle** - Du entscheidest die Tiefe
4. **Skalierbar** - Neue Projekte = neuer Ordner + GOAL.md
5. **Git-Native** - Saubere Branches pro Plan-Ebene

## Für AI Agents

Wenn du dieses Repo weiterentwickeln sollst:

1. **Lies [GOAL.md](GOAL.md)** - Was soll der Autopilot werden?
2. **Lies [CONTEXT.md](CONTEXT.md)** - Wer ist Rafael, was ist sein Stack?
3. **Lies [orchestrator/SYSTEM.md](orchestrator/SYSTEM.md)** - Wie sollst du arbeiten?
4. **Lies [orchestrator/HIERARCHY.md](orchestrator/HIERARCHY.md)** - Die 4 Ebenen verstehen
5. **Check Erfolgskriterien** in GOAL.md - Was fehlt noch?
6. **Erstelle Plan** - Warte auf Approval vor Ausführung!

## Status

**Phase**: 2 - Basic Implementation ✅
**Nächste Phase**: 3 - Kontext-Automatisierung

Features:
- ✅ `plan.sh` - Interaktiver Registry-Scanner
- ✅ Adaptive Levels pro Projekt (CONFIG.yaml)
- ✅ Git Branching Automation
- ✅ Projekt-spezifische Prompts

Siehe [GOAL.md](GOAL.md) für detaillierte Erfolgskriterien.
