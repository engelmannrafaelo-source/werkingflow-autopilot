# CC-Usage Tracking - Jetzt einrichten! 🚀

## Status Checker zuerst ausführen:

```bash
cd /root/projekte/werkingflow/autopilot/cui
./scripts/check-setup.sh
```

→ Zeigt was fehlt und was als nächstes zu tun ist!

---

## Schritt 1: Tokens vom Mac extrahieren

**Auf deinem Mac (lokal):**

```bash
# Option A: Python Script (automatisch)
cd ~/Downloads
# Kopiere extract-tokens-mac.py vom Server nach ~/Downloads
python3 extract-tokens-mac.py

# Option B: Manuell aus Browser
# 1. Chrome/Brave öffnen: claude.ai
# 2. DevTools: Cmd+Opt+I
# 3. Tab: Application → Cookies → https://claude.ai
# 4. Cookie "sessionKey" → Value kopieren (sk-ant-...)
```

**Output sieht so aus:**
```
✅ Found 3 unique token(s):

[1] sk-ant-api03-xyz123...abc789
[2] sk-ant-api03-def456...ghi012
[3] sk-ant-api03-jkl789...mno345

📋 Copy these to server's ~/.zshrc:

export CLAUDE_AUTH_TOKEN_RAFAEL="sk-ant-api03-xyz123...abc789"
export CLAUDE_AUTH_TOKEN_OFFICE="sk-ant-api03-def456...ghi012"
export CLAUDE_AUTH_TOKEN_ENGELMANN="sk-ant-api03-jkl789...mno345"
```

---

## Schritt 2: Tokens auf Server eintragen

**Auf dem Server:**

```bash
# ~/.zshrc editieren
nano ~/.zshrc

# Am Ende einfügen (von Mac kopiert):
export CLAUDE_AUTH_TOKEN_RAFAEL="sk-ant-..."
export CLAUDE_AUTH_TOKEN_OFFICE="sk-ant-..."
export CLAUDE_AUTH_TOKEN_ENGELMANN="sk-ant-..."

# Speichern: Ctrl+O, Enter, Ctrl+X

# Reload
source ~/.zshrc

# Verify
echo $CLAUDE_AUTH_TOKEN_RAFAEL
```

→ Sollte Token ausgeben (nicht leer!)

---

## Schritt 3: Automatisches Setup

```bash
cd /root/projekte/werkingflow/autopilot/cui
./scripts/setup-cc-usage.sh
```

**Das Script macht:**
1. ✅ Chromium installieren (falls fehlt)
2. ✅ Tokens validieren
3. ✅ Session States erstellen (rafael, office, engelmann)
4. ✅ Scraper testen
5. ✅ Cron Job einrichten (täglich 6:00 AM)

**Output am Ende:**
```
=== Setup Complete! ===

✅ Chromium: Installed
✅ Tokens: 3 account(s)
✅ Sessions: Created
✅ Scraper: Tested
✅ Cron: Daily at 6:00 AM
```

---

## Schritt 4: CUI Server neu starten

```bash
# Server lädt scraped data beim Start
curl -X POST http://localhost:9090/api/app/cui/restart

# Warte 5 Sekunden
sleep 5

# Browser öffnen
open http://localhost:4005
```

---

## Schritt 5: Verify im Frontend

1. **BridgeMonitor öffnen** (Tab Bar)
2. **CC-Usage Tab** auswählen
3. **LIVE Badges** prüfen auf Account-Cards
4. **Percentages** sollten real sein (nicht 0%)

**Du solltest sehen:**
```
┌─────────────────────────────────┐
│ rafael@werk-ing.com        LIVE │
│                                 │
│ Weekly All Models: 45%          │
│ Weekly Sonnet: 23%              │
│ Current Session: 12%            │
│                                 │
│ Reset: Mo, 24. Feb, 06:00       │
└─────────────────────────────────┘
```

---

## Troubleshooting

### "Token invalid - redirected to login"

→ Token abgelaufen. Neu extrahieren vom Mac:
```bash
# Mac: DevTools → Cookies → sessionKey kopieren
# Server:
nano ~/.zshrc
# Token updaten
source ~/.zshrc
npx tsx scripts/create-session-from-token.ts rafael
```

### "Usage page did not load"

→ Screenshot ansehen:
```bash
ls -lh /tmp/scraper-load-fail-*.png
open /tmp/scraper-load-fail-rafael.png
```

→ Zeigt was schief ging

### Scraper läuft nicht täglich

→ Cron Logs prüfen:
```bash
tail -f /var/log/claude-scraper.log

# Cron Job anzeigen
crontab -l | grep scrape-claude
```

### LIVE Badge fehlt im Frontend

→ Server neu starten (lädt scraped data):
```bash
curl -X POST http://localhost:9090/api/app/cui/restart
```

---

## Manuelle Scraper-Ausführung

```bash
cd /root/projekte/werkingflow/autopilot/cui
npx tsx scripts/scrape-claude-usage.ts

# Output prüfen
cat claude-usage-scraped.json | jq .
```

---

## Files & Scripts

| File | Purpose |
|------|---------|
| `check-setup.sh` | Status prüfen + Next Steps |
| `extract-tokens-mac.py` | Mac: Tokens aus Browsern extrahieren |
| `setup-cc-usage.sh` | Server: Komplettes Auto-Setup |
| `create-session-from-token.ts` | Token → Session State |
| `scrape-claude-usage.ts` | Täglicher Scraper (Cron) |
| `claude-usage-scraped.json` | Live Data (Server lädt beim Start) |

---

## Quick Commands

```bash
# Status prüfen
./scripts/check-setup.sh

# Session neu erstellen
npx tsx scripts/create-session-from-token.ts rafael

# Scraper manuell ausführen
npx tsx scripts/scrape-claude-usage.ts

# Logs anschauen
tail -f /var/log/claude-scraper.log

# CUI neu starten
curl -X POST http://localhost:9090/api/app/cui/restart
```

---

**Vollständige Doku**: `CC_USAGE_TRACKING.md`
**Quick Start**: `QUICKSTART_CC_USAGE.md`

**Jetzt loslegen**: `./scripts/check-setup.sh` 🚀
