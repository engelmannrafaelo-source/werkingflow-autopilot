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

## Die 4 Ebenen

```
Level 0: MASTER_PLAN.md     → "Was über alle Projekte?"      → "Go!" oder "Deeper"
Level 1: PROJECT_PLAN.md    → "Was in diesem Projekt?"       → "Go!" oder "Deeper"
Level 2: FEATURE_PLAN.md    → "Wie dieses Feature?"          → "Go!" oder "Deeper"
Level 3: TASK_EXECUTION     → Code schreiben                 → Automatisch
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
│   ├── SYSTEM.md           # AI Rolle: Hierarchischer Planner
│   ├── HIERARCHY.md        # Die 4 Ebenen erklärt
│   ├── GIT_STRATEGY.md     # Branch-Logik pro Ebene
│   └── LOOP.md             # Loop-Definition
├── projects/               # = REGISTRY (Ordner = Projekt)
│   ├── _template/          # Template für neue Projekte
│   ├── werkflow/
│   │   ├── GOAL.md         # Erfolgskriterien
│   │   ├── repo.txt        # Pfad zum echten Repository
│   │   └── context/        # Emails, Meeting-Notes, etc.
│   └── teufel-ai/
│       ├── GOAL.md
│       └── context/
└── logs/                   # Was wurde gemacht?
```

## Quick Start

```bash
# 1. Neues Projekt anlegen
mkdir -p projects/neuer-kunde/context

# 2. Email/Kontext reinkopieren
echo "Email von Kunde..." > projects/neuer-kunde/context/email.md

# 3. Ziel definieren
cat > projects/neuer-kunde/GOAL.md << 'EOF'
# Projekt: Neuer Kunde

## Was
App für Energieberater

## Wann fertig
- [ ] Login funktioniert
- [ ] Reports generierbar
EOF

# 4. Starten - AI erstellt MASTER_PLAN
./orchestrator/plan.sh

# 5. Entscheiden
# → "Go!" für Ausführung
# → "Deeper werkflow" für mehr Details
# → "Adjust [was]" für Änderungen
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

**Phase**: 1 - Definition (nur Markdown) ✅
**Nächste Phase**: 2 - Basic Implementation (plan.sh + Interaktion)

Siehe [GOAL.md](GOAL.md) für detaillierte Erfolgskriterien.
