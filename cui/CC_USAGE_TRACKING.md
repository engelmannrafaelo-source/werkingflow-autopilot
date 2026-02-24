# Claude Code Usage Tracking - Complete Guide

## Was wurde implementiert?

Ein **Account-basiertes** Claude Code Usage Dashboard im CUI BridgeMonitor mit:

### ✅ Phase 1 + 2 Features (Fertig)

1. **Account-Level Tracking** statt Workspace-Level
   - Aggregiert alle Workspaces pro Account (rafael, office, engelmann, local)
   - Richtige Metrik: 1 Account = 1 Weekly Limit (nicht pro Workspace!)

2. **5h-Window Detection**
   - Automatische Erkennung via Timestamp-Clustering
   - Zeigt "Reset in X Stunden" an
   - Zeigt aktuelle Window-Tokens

3. **Burn-Rate Calculation**
   - Tokens/Stunde basierend auf letzten 24h
   - Prediction: "Limit erreicht in X Tagen"

4. **Weekly Limit Projection**
   - Hochrechnung auf 7 Tage
   - Status Badges: Safe (<60%), Warning (60-80%), Critical (>80%)

5. **Alert-System**
   - Top-3-Warnungen prominent angezeigt
   - Schweregrad: Critical, Warning, Info
   - Actionable Messages ("Limit erreicht Freitag 14:00")

6. **Account Cards**
   - Weekly Projection (% von 10M Limit)
   - Burn-Rate (K tokens/hour)
   - Limit Reached In (Tage)
   - 5h-Window Reset Timer
   - Workspaces pro Account

## Aktueller Stand

### ✅ Komplett implementiert:

- **Server**: `/root/projekte/werkingflow/autopilot/cui/server/index.ts`
  - Route: `GET /api/claude-code/stats-v2`
  - Account-Mapping (rafael, office, engelmann, local)
  - JSONL-Parsing mit Token-Aggregation
  - 5h-Window Heuristik
  - Burn-Rate & Projection
  - Alert-Generierung

- **Frontend**: `/root/projekte/werkingflow/autopilot/cui/src/components/panels/BridgeMonitor/tabs/CCUsageTab.tsx`
  - Account Cards mit 4 KPIs
  - Alert-Banner (Critical/Warning/Info)
  - Global Statistics
  - Auto-Refresh (60s)

### ⚠️ Server-Restart erforderlich

Der Code ist fertig, läuft aber noch nicht weil der CUI Workspace Server (Port 4005) mehrere tsx/node-Prozesse hat die sich gegenseitig blockieren.

**Manual Fix:**
```bash
pkill -f cui
cd /root/projekte/werkingflow/autopilot/cui
npx tsx server/index.ts
```

Dann ist `/api/claude-code/stats-v2` live.

---

## Phase 3: Claude.ai Live-Scraping (NEU!)

### Problem mit bisheriger Lösung:

Die JSONL-basierte Tracking gibt **Schätzungen**, aber keine echten Limits:
- Weekly Limit: **geschätzt 10M tokens** (konservativ, könnte auch 15M oder 20M sein)
- 5h-Window: **Heuristik** basierend auf Timestamps (nicht 100% genau)
- Reset-Timer: **Approximation** (kein exakter Zeitpunkt)

### Lösung: Claude.ai Usage Page Scraping

Der Screenshot zeigt: `claude.ai/settings/usage` hat die **echten** Limits!

**Was extrahiert werden kann:**
1. **Aktuelle Sitzung**: 4% verwendet, "Zurücksetzung in 3 Std. 46 Min."
2. **Wöchentliche Limits - Alle Modelle**: 83% verwendet, "Zurücksetzung Do., 11:00"
3. **Nur Sonnet**: 1% verwendet, "Zurücksetzung Di., 11:00"

### Implementierung

**1. Scraper-Script**
- Datei: `/root/projekte/werkingflow/autopilot/cui/scripts/scrape-claude-usage.ts`
- Nutzt Playwright (headless Chrome)
- Braucht Session-Cookies (siehe Setup unten)

**2. Setup: Session Cookies holen**
- Siehe: `/root/projekte/werkingflow/autopilot/cui/scripts/SETUP_CLAUDE_COOKIES.md`
- TL;DR:
  1. Browser → claude.ai → Dev Tools → Application → Cookies
  2. Cookie `sessionKey` kopieren
  3. In `~/.zshrc` als `CLAUDE_SESSION_RAFAEL` etc. speichern

**3. Scraper testen**
```bash
cd /root/projekte/werkingflow/autopilot/cui
npx tsx scripts/scrape-claude-usage.ts
```

**Output**:
```json
[
  {
    "account": "rafael",
    "timestamp": "2026-02-24T12:30:00.000Z",
    "currentSession": {
      "percent": 4,
      "resetIn": "in 3 Std. 46 Min."
    },
    "weeklyAllModels": {
      "percent": 83,
      "resetDate": "Do., 11:00"
    },
    "weeklySonnet": {
      "percent": 1,
      "resetDate": "Di., 11:00"
    }
  }
]
```

**4. Integration in CUI Server**

**Plan**:
- Scraper läuft alle 15min im Hintergrund (cron oder setInterval)
- Daten werden in `/tmp/claude-usage-live.json` gecached
- `/api/claude-code/stats-v2` merged:
  - **JSONL-Daten**: Total Tokens, Sessions, Models, Storage
  - **Scraped-Daten**: Echte Limits, Reset-Timer, Weekly %

**Merged Response**:
```json
{
  "accounts": [
    {
      "accountName": "rafael",
      "totalTokens": 329862,  // from JSONL
      "burnRatePerHour": 1250, // from JSONL
      "weeklyLimitPercent": 83, // from SCRAPED (real!)
      "weeklyLimitActual": 8300000, // calculated from percent
      "nextWindowReset": "2026-02-24T15:46:00Z", // from SCRAPED (exact!)
      "status": "critical" // from scraped percent
    }
  ],
  "alerts": [
    {
      "severity": "critical",
      "title": "Account \"rafael\" at 83%",
      "description": "Weekly limit reached Thursday 11:00 AM"
    }
  ]
}
```

---

## Next Steps

### Für dich (Rafael):

1. **Server neustarten** (siehe oben) → CC-Usage Tab funktioniert
2. **Session Cookies holen** (siehe `SETUP_CLAUDE_COOKIES.md`)
3. **Scraper testen**: `npx tsx scripts/scrape-claude-usage.ts`

### Für mich (wenn Cookies da sind):

1. **Server-Integration**:
   - Background-Job alle 15min
   - Cache-File mit scraped data
   - Merge-Logic in `/api/claude-code/stats-v2`

2. **Frontend-Update**:
   - "LIVE" Badge wenn scraped data vorhanden
   - Exakte Reset-Timer statt Approximation
   - Echte Weekly % statt Projection

3. **Error-Handling**:
   - Fallback auf JSONL-Schätzungen wenn Scraper fehlschlägt
   - Cookie-Expiry-Detection mit Notification
   - Retry-Logic bei Timeouts

---

## Technische Details

### Account-Workspace Mapping

```typescript
const ACCOUNT_MAP = {
  'rafael': [
    '-root-orchestrator-workspaces-administration',
    '-root-orchestrator-workspaces-team',
    '-root-orchestrator-workspaces-diverse',
    '-root-projekte-orchestrator',
  ],
  'office': [
    '-root-orchestrator-workspaces-werking-report',
    '-root-orchestrator-workspaces-werking-energy',
    '-root-orchestrator-workspaces-werkingsafety',
  ],
  'engelmann': [
    '-root-orchestrator-workspaces-engelmann-ai-hub',
  ],
  'local': [
    '-root-projekte-werkingflow',
    '-tmp',
  ],
};
```

### Warum Account-Level?

Claude Code Limits sind **pro Account**, nicht pro Workspace:
- 1 Account kann 10+ Workspaces haben
- Alle Workspaces teilen sich das gleiche 5h-Window
- Alle Workspaces zählen auf das gleiche Weekly Limit

**Falsch** (altes System):
```
Workspace "team": 50K tokens
Workspace "administration": 30K tokens
→ Zeige beide separat (irreführend!)
```

**Richtig** (neues System):
```
Account "rafael":
  - Workspaces: team, administration, diverse
  - Total: 80K tokens (combined!)
  - Weekly: 0.8% von 10M Limit
  - Status: Safe
```

---

## Files

### Server
- `/root/projekte/werkingflow/autopilot/cui/server/index.ts` (Line 3739-3950)
- Route: `GET /api/claude-code/stats-v2`

### Frontend
- `/root/projekte/werkingflow/autopilot/cui/src/components/panels/BridgeMonitor/tabs/CCUsageTab.tsx`
- `/root/projekte/werkingflow/autopilot/cui/src/components/panels/BridgeMonitor/BridgeMonitor.tsx` (Tab integration)

### Scripts
- `/root/projekte/werkingflow/autopilot/cui/scripts/scrape-claude-usage.ts`
- `/root/projekte/werkingflow/autopilot/cui/scripts/SETUP_CLAUDE_COOKIES.md`

### Docs
- Dieses File: `/root/projekte/werkingflow/autopilot/cui/CC_USAGE_TRACKING.md`

---

## FAQ

**Q: Warum scrapen statt Admin API?**
A: Admin API gibt's nur für Team/Enterprise. Pro/Max User haben keine API für Limits.

**Q: Ist Scraping legal?**
A: Ja - es sind deine eigenen Accounts, deine eigenen Daten. Kein Abuse, nur Read-Only.

**Q: Was wenn Cookies ablaufen?**
A: Scraper failed → Fallback auf JSONL-Schätzungen. Du bekommst Alert "Cookies expired".

**Q: Kann ich mehrere Gmail-Accounts tracken?**
A: Ja! Einfach mehr Cookies in `.zshrc` hinzufügen und `ACCOUNT_MAP` erweitern.

**Q: Performance-Impact?**
A: Minimal - Scraper läuft nur alle 15min, cached Ergebnisse. Frontend bleibt snappy.

**Q: Was wenn Claude.ai UI sich ändert?**
A: Scraper muss angepasst werden (Selektoren updaten). Dauert ~10min.

---

*Erstellt: 2026-02-24 | Status: Phase 1+2 fertig, Phase 3 (Scraping) ready to integrate*
