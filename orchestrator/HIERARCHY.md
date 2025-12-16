# Plan-Hierarchie mit Approval Gates

## Konzept

Du entscheidest bei JEDER Ebene, ob du:
- **"Go!"** → Alles darunter wird ausgeführt
- **"Deeper"** → Zeig mir die nächste Ebene
- **"Adjust"** → Plan anpassen bevor weiter

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│   Level 0: MASTER_PLAN.md                                   │
│   ════════════════════════                                  │
│   "Was muss über ALLE Projekte passieren?"                  │
│                                                             │
│   ┌─────────────────────────────────────────────────────┐   │
│   │ • werkflow: Auth verbessern, Billing Dashboard      │   │
│   │ • teufel-ai: Phase 3 abschließen                    │   │
│   │ • Cross-Project: Shared Types extrahieren           │   │
│   └─────────────────────────────────────────────────────┘   │
│                                                             │
│   Du: "Go!" ──────────────────► Führt ALLES aus             │
│   Du: "Deeper" ───────────────► Zeigt Level 1               │
│                                                             │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼ (wenn "Deeper")
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│   Level 1: projects/*/PLAN.md                               │
│   ════════════════════════════                              │
│   "Was muss in DIESEM Projekt passieren?"                   │
│                                                             │
│   werkflow/PLAN.md:                                         │
│   ┌─────────────────────────────────────────────────────┐   │
│   │ • Feature: Multi-Tenant Auth Refactor               │   │
│   │ • Feature: Billing Dashboard Erweiterung            │   │
│   │ • Fix: Session Handling Bug                         │   │
│   └─────────────────────────────────────────────────────┘   │
│                                                             │
│   Du: "Go!" ──────────────────► Führt werkflow-Plan aus     │
│   Du: "Deeper" ───────────────► Zeigt Level 2               │
│                                                             │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼ (wenn "Deeper")
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│   Level 2: Feature-Plans                                    │
│   ══════════════════════                                    │
│   "WIE wird dieses Feature umgesetzt?"                      │
│                                                             │
│   werkflow/plans/auth-refactor.md:                          │
│   ┌─────────────────────────────────────────────────────┐   │
│   │ 1. Middleware extrahieren nach /lib/auth            │   │
│   │ 2. Session-Types in shared-types                    │   │
│   │ 3. Tests für alle Auth-Flows                        │   │
│   │ 4. Migration für bestehende Sessions                │   │
│   └─────────────────────────────────────────────────────┘   │
│                                                             │
│   Du: "Go!" ──────────────────► Führt Feature aus           │
│   Du: "Deeper" ───────────────► Zeigt einzelne Tasks        │
│                                                             │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼ (wenn "Deeper")
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│   Level 3: Task-Level                                       │
│   ═══════════════════                                       │
│   "Exakt welche Dateien, welcher Code?"                     │
│                                                             │
│   Task: "Middleware extrahieren"                            │
│   ┌─────────────────────────────────────────────────────┐   │
│   │ • Erstelle: /lib/auth/middleware.ts                 │   │
│   │ • Verschiebe: validateSession() von api/auth        │   │
│   │ • Update: 12 API routes die middleware nutzen       │   │
│   │ • Test: middleware.test.ts                          │   │
│   └─────────────────────────────────────────────────────┘   │
│                                                             │
│   Du: "Go!" ──────────────────► Führt Task aus              │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Vertrauens-Level

| Vertrauen | Aktion | Ergebnis |
|-----------|--------|----------|
| **Hoch** | "Go!" auf Level 0 | Alles wird autonom ausgeführt |
| **Mittel** | "Go!" auf Level 1 | Pro-Projekt Ausführung |
| **Niedrig** | "Go!" auf Level 2/3 | Feature/Task-weise Ausführung |
| **Review** | "Deeper" überall | Alle Pläne prüfen vor Ausführung |

## Beispiel-Session

```
Du: "Entwickle weiter!"

Autopilot:
📋 MASTER_PLAN.md erstellt:

## Sprint 2024-12-16

### werkflow (Priorität: Hoch)
- [ ] Auth Middleware Refactor
- [ ] Billing Dashboard: Token-Tracking

### teufel-ai (Priorität: Hoch)
- [ ] Phase 3: Vision Validation abschließen
- [ ] Phase 4: Report Generation starten

### Cross-Project
- [ ] Shared Types Package erstellen

Wie tief willst du gehen?
- "Go!" → Alles ausführen
- "Deeper werkflow" → werkflow Plan zeigen
- "Deeper teufel-ai" → teufel-ai Plan zeigen
- "Adjust" → Plan ändern

─────────────────────────────────────

Du: "Deeper werkflow"

Autopilot:
📋 werkflow/PLAN.md erstellt:

## Auth Middleware Refactor

### Warum?
- Auth-Logik ist über 12 API Routes verstreut
- Keine zentrale Session-Validierung
- Schwer zu testen

### Tasks
1. [ ] Middleware nach /lib/auth extrahieren
2. [ ] Session-Types definieren
3. [ ] 12 API Routes migrieren
4. [ ] Tests schreiben

### Git Branch
`feature/auth-middleware-refactor`

Wie tief willst du gehen?
- "Go!" → Feature ausführen
- "Deeper 1" → Task 1 Details
- "Adjust" → Plan ändern

─────────────────────────────────────

Du: "Go!"

Autopilot:
🚀 Starte Auth Middleware Refactor...
📁 Branch: feature/auth-middleware-refactor
[... arbeitet ...]
✅ Fertig! PR ready for review.
```

## Datei-Struktur

```
werkingflow-autopilot/
├── MASTER_PLAN.md              # Level 0 - Aktueller Sprint
├── projects/
│   ├── werkflow/
│   │   ├── GOAL.md             # Langfristige Ziele
│   │   ├── PLAN.md             # Level 1 - Aktueller Plan
│   │   └── plans/              # Level 2 - Feature Plans
│   │       ├── auth-refactor.md
│   │       └── billing-extension.md
│   └── teufel-ai/
│       ├── GOAL.md
│       ├── PLAN.md
│       └── plans/
└── logs/
    └── 2024-12-16/
        ├── master.log
        └── werkflow.log
```

## Approval Gates

```
MASTER_PLAN erstellt
        │
        ▼
   ⏸️ APPROVAL GATE 0
   "Sieht der Master Plan gut aus?"
        │
        ▼ (Go! oder Deeper)

PROJECT_PLAN erstellt
        │
        ▼
   ⏸️ APPROVAL GATE 1
   "Sieht der Projekt-Plan gut aus?"
        │
        ▼ (Go! oder Deeper)

FEATURE_PLAN erstellt
        │
        ▼
   ⏸️ APPROVAL GATE 2
   "Sieht der Feature-Plan gut aus?"
        │
        ▼ (Go!)

   🚀 AUSFÜHRUNG
```

## Wann welche Tiefe?

| Situation | Empfohlene Tiefe |
|-----------|------------------|
| Routine Cleanup | Level 0 "Go!" |
| Bekanntes Feature | Level 1 "Go!" |
| Neues/Komplexes Feature | Level 2 Review |
| Kritische Änderung | Level 3 Review |
| Erstes Mal mit Projekt | Immer "Deeper" |
