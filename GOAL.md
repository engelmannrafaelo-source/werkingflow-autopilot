# WerkingFlow Autopilot - Meta Goal

> Dieses File definiert, was der Autopilot SELBST werden soll.
> Ein AI-Agent kann dieses File lesen und den Autopilot weiterentwickeln.

---

## Vision

Ein System, das **hierarchische AI-Entwicklung** ermöglicht durch **Plan-Propagation mit Approval Gates**.

**Kernidee**:
- Du sagst "Entwickle weiter!"
- AI erstellt **MASTER_PLAN** (Top-Level)
- Du entscheidest: **"Go!"** oder **"Deeper"** für mehr Details
- Pläne propagieren von High → Low Level
- Du behältst **volle Kontrolle** über die Tiefe

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
- ❌ Alt: "Mach alles autonom" (Zu riskant)
- ✅ Neu: "Plane hierarchisch, ich entscheide die Tiefe" (Controlled Autonomy)

**Adaptive Hierarchie (Registry-basiert):**
```
Autopilot scannt Registry (projects/)
     │
     ├── werkflow/CONFIG.yaml    → 4 Levels: Vision → Module → Features → Tasks
     └── teufel-ai/CONFIG.yaml   → 3 Levels: PoC → Phasen → Details
```

Levels sind **NICHT global fixiert** - jedes Projekt definiert eigene Struktur!

**Approval Gates:**
- Nach jedem Level: STOPP und warte auf "Go!" oder "Deeper"
- Du entscheidest wie tief du gehen willst
- Mehr Vertrauen = weniger Tiefe nötig

**Komponenten:**
1. **CONTEXT.md** - Wer bin ich, was ist mein Business, Tech-Stack
2. **CONFIG.yaml pro Projekt** - Levels, Prompts, Git-Settings (NEU!)
3. **GOAL.md pro Projekt** - Was soll entstehen (langfristig)
4. **SYSTEM.md** - AI-Rolle als Planner (nicht autonom!)
5. **HIERARCHY.md** - Adaptive Levels erklärt
6. **plan.sh** - Registry-Scanner mit interaktiven Befehlen

---

## Erfolgskriterien

### Phase 1: Definition (Markdown Only)
- [x] README.md erklärt Vision
- [x] CONTEXT.md mit dynamischen Quellen-Konzept
- [x] SYSTEM.md definiert AI-Rolle (Planner, nicht autonom)
- [x] GOAL.md für Autopilot selbst (dieses File)
- [x] Beispiel-Projekte (werkflow, teufel-ai)
- [x] SOURCES.md für Kontext-Quellen
- [x] _template/ für neue Projekte
- [x] GitHub Repository erstellt
- [x] HIERARCHY.md - 4 Ebenen mit Approval Gates
- [x] GIT_STRATEGY.md - Branch-Logik für hierarchische Pläne

### Phase 2: Basic Implementation ✅
- [x] plan.sh - Registry-Scanner mit adaptiven Levels
- [x] Interaktive Befehle: list, show, deeper, go, branch, status
- [x] CONFIG.yaml pro Projekt für Level-Definition
- [x] Projekt-spezifische Prompts in CONFIG.yaml
- [x] Logs werden geschrieben
- [x] Status-Tracking pro Projekt/Level
- [x] Git Branching bei "go" und "branch" automatisiert

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

1. **Lies diese Files in Reihenfolge:**
   - GOAL.md (dieses File) - Was soll entstehen
   - CONTEXT.md - Wer ist Rafael
   - orchestrator/SYSTEM.md - Deine Rolle
   - orchestrator/HIERARCHY.md - Die 4 Ebenen
   - orchestrator/GIT_STRATEGY.md - Branch-Logik

2. **Verstehe das Prinzip:**
   - Du bist PLANNER, nicht autonomer Executor
   - Erstelle Pläne, warte auf Approval
   - "Go!" = ausführen, "Deeper" = mehr Details

3. **Check die Erfolgskriterien** - Was fehlt noch?

4. **Entwickle Phase 2** - plan.sh und interaktive Befehle

---

## Aktueller Status

**Phase**: 2 (Basic Implementation) ✅ ABGESCHLOSSEN
**Nächster Schritt**: Phase 3 - Kontext-Automatisierung
**Blocker**: Keine

**Architektur**: Adaptive Levels, Registry-basiert, Git Branching automatisiert

**GitHub**: https://github.com/engelmannrafaelo-source/werkingflow-autopilot
