# WerkingFlow Autopilot - Meta Goal

> Dieses File definiert, was der Autopilot SELBST werden soll.
> Ein AI-Agent kann dieses File lesen und den Autopilot weiterentwickeln.

---

## Vision

Ein System, das **autonome AI-Entwicklung** ermöglicht durch **Goal-Oriented Prompting**.

**Kernidee**: Du wirfst Projekt-Definitionen rein (Emails, Kontext, Ziele) → Opus 4.5 entwickelt autonom bis das Ziel erreicht ist.

---

## Was ist das Problem?

1. **Manuelle Entwicklung ist langsam** - Ständig muss man dem AI sagen, was zu tun ist
2. **Prescriptive Prompts limitieren** - "Tu genau das" nutzt nicht die volle AI-Intelligenz
3. **Kontext geht verloren** - Jede Session startet bei Null
4. **Cleanup/Architektur nervt** - Niemand will manuell aufräumen

---

## Was ist die Lösung?

**Paradigmenwechsel:**
- ❌ Alt: "Tu genau das" (Prescriptive)
- ✅ Neu: "Das ist das Ziel, finde heraus wie" (Goal-Oriented)

**Komponenten:**
1. **CONTEXT.md** - Wer bin ich, was ist mein Business, Tech-Stack
2. **GOAL.md pro Projekt** - Was soll entstehen, Erfolgskriterien als Checkboxen
3. **SYSTEM.md** - AI-Rolle, Autonomie, Grenzen
4. **Loop** - Assess → Plan → Execute → Validate → Log → Repeat

---

## Erfolgskriterien

### Phase 1: Definition (Markdown Only)
- [x] README.md erklärt Vision
- [x] CONTEXT.md mit dynamischen Quellen-Konzept
- [x] SYSTEM.md definiert AI-Rolle
- [x] GOAL.md für Autopilot selbst (dieses File)
- [x] Beispiel-Projekte (werkflow, teufel-ai)
- [x] SOURCES.md für Kontext-Quellen
- [x] _template/ für neue Projekte
- [ ] GitHub Repository erstellt

### Phase 2: Basic Implementation
- [ ] loop.sh funktioniert mit Claude Code CLI
- [ ] Projekt ohne Repo → Repo wird erstellt
- [ ] Projekt mit Repo → AI arbeitet daran
- [ ] Logs werden geschrieben
- [ ] Status-Tracking (success/blocked/timeout)

### Phase 3: Kontext-Automatisierung
- [ ] Coach MCP Integration für Emails
- [ ] Git Integration für Repo-Änderungen
- [ ] Automatische CONTEXT.md Updates
- [ ] Cron-Job für tägliche Ausführung

### Phase 4: Intelligence
- [ ] AI erkennt wann Ziel erreicht
- [ ] AI fragt nur wenn wirklich nötig
- [ ] AI lernt aus vorherigen Sessions (Logs)
- [ ] Parallele Projekt-Ausführung

### Phase 5: Self-Improvement
- [ ] Autopilot verbessert sich selbst
- [ ] Neue Patterns werden erkannt
- [ ] SYSTEM.md wird optimiert
- [ ] Effizienz-Metriken

---

## Constraints

- **Keine Overengineering** - Start simple, iterate
- **Bash + Claude Code CLI** - Keine komplexe Infrastruktur
- **Markdown First** - Definition vor Implementation
- **Privacy** - Alles lokal, keine Cloud-Abhängigkeit

---

## Wie starte ich?

Als AI der dieses Repo weiterentwickeln soll:

1. **Lies alle Markdown-Files** in diesem Repo
2. **Verstehe die Vision** aus diesem GOAL.md
3. **Check die Erfolgskriterien** - Was fehlt noch?
4. **Entwickle den nächsten Schritt** - Eine Phase nach der anderen
5. **Teste** - Funktioniert der Loop?
6. **Iterate** - Bis alle Checkboxen ✅

---

## Aktueller Status

**Phase**: 1 (Definition) - Fast abgeschlossen
**Nächster Schritt**: GitHub Repository erstellen, dann Phase 2 (loop.sh)
**Blocker**: Keine
