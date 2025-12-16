# WerkingFlow Autopilot

**Autonome AI-Entwicklung durch Goal-Oriented Prompting**

## Vision

Ein System wo du nur **Projekt-Definitionen** reinwirfst (Emails, Kontext, Ziele) und Opus 4.5 **autonom entwickelt** bis das Ziel erreicht ist.

## Paradigmenwechsel

| Alt (Prescriptive) | Neu (Goal-Oriented) |
|-------------------|---------------------|
| "Tu genau das" | "Das ist das Ziel, finde heraus wie" |
| Detaillierte Anweisungen | Situation + Ziel |
| AI folgt Schritten | AI entscheidet selbst |

## Kernidee

Opus 4.5 ist intelligent genug. Gib ihm:

1. **Deine Situation** (CONTEXT.md) - Wer du bist, Business, Tech-Stack
2. **Projekt-Definition** (GOAL.md) - Was soll entstehen, wann ist es "fertig"
3. **Aktueller Stand** - Das echte Repository

Der Rest passiert autonom.

## Struktur

```
werkingflow-autopilot/
├── CONTEXT.md              # Deine Situation (dynamisch aus Quellen!)
├── sources/                # Quellen für automatische Kontext-Updates
│   └── SOURCES.md          # Welche Quellen sollen verwendet werden?
├── orchestrator/
│   └── SYSTEM.md           # AI Rolle und Autonomie
├── projects/               # Projekt-Definitionen
│   ├── werkflow/
│   │   ├── GOAL.md         # Was soll entstehen?
│   │   ├── repo.txt        # Pfad zum echten Repository
│   │   └── context/        # Emails, Meeting-Notes, etc.
│   └── teufel-ai/
│       ├── GOAL.md
│       └── context/
└── logs/                   # Was wurde gemacht?
```

## Dynamische Kontext-Quellen

Das System kann den Kontext automatisch aus verschiedenen Quellen aktualisieren:

- **Emails** - Via Coach MCP oder IMAP
- **Dateien** - Lokale Dokumente, die sich ändern
- **APIs** - Externe Datenquellen
- **Git** - Repository-Änderungen

Siehe [sources/SOURCES.md](sources/SOURCES.md) für Details.

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

# 4. Starten
./orchestrator/loop.sh neuer-kunde
```

## Warum das funktioniert

1. **Opus 4.5 ist SMART** - Braucht keine detaillierten Anweisungen
2. **Kontext ist König** - CONTEXT.md gibt ihm DEIN Wissen
3. **Ziele statt Tasks** - GOAL.md sagt WAS, nicht WIE
4. **Autonomie** - Er entscheidet selbst den besten Weg
5. **Skalierbar** - Neue Projekte = neuer Ordner + GOAL.md

## Status

**Phase**: Definition (nur Markdown)
**Nächste Phase**: Implementierung (loop.sh, Integration mit Claude Code CLI)
