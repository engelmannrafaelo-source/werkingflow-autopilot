# CC-Usage Tracking - Quick Start

**Automated Claude Code Usage Tracking mit Token-Based Scraping**

## Auf deinem Mac (Tokens extrahieren):

```bash
# 1. Extractor lokal auf Mac ausführen
python3 ~/Downloads/extract-tokens-mac.py

# 2. Output kopieren (wird angezeigt):
export CLAUDE_AUTH_TOKEN_RAFAEL="sk-ant-..."
export CLAUDE_AUTH_TOKEN_OFFICE="sk-ant-..."
export CLAUDE_AUTH_TOKEN_ENGELMANN="sk-ant-..."
```

## Auf dem Server (Setup):

```bash
# 1. Tokens in ~/.zshrc eintragen
nano ~/.zshrc

# Am Ende einfügen (von Mac kopiert):
export CLAUDE_AUTH_TOKEN_RAFAEL="sk-ant-..."
export CLAUDE_AUTH_TOKEN_OFFICE="sk-ant-..."
export CLAUDE_AUTH_TOKEN_ENGELMANN="sk-ant-..."

# Speichern (Ctrl+O, Enter, Ctrl+X)

# 2. Reload
source ~/.zshrc

# 3. Automatisches Setup ausführen
cd /root/projekte/werkingflow/autopilot/cui
./scripts/setup-cc-usage.sh
```

**Das Setup-Script macht:**
- ✅ Chromium Installation
- ✅ Token Validierung
- ✅ Playwright Session States erstellen
- ✅ Scraper Test
- ✅ Cron Job (täglich 6:00 AM)

## Manuelle Token-Extraktion (falls Script fehlschlägt):

**Chrome/Brave:**
1. `claude.ai` öffnen
2. DevTools: `Cmd+Opt+I` (Mac) oder `F12` (Linux)
3. Tab: **Application** → **Cookies** → `https://claude.ai`
4. Cookie `sessionKey` → Value kopieren

**Firefox:**
1. `claude.ai` öffnen
2. DevTools: `Cmd+Opt+I`
3. Tab: **Storage** → **Cookies** → `https://claude.ai`
4. `sessionKey` → Value kopieren

## Nach Setup:

```bash
# CUI Server neu starten
curl -X POST http://localhost:9090/api/app/cui/restart

# Browser öffnen
open http://localhost:4005

# BridgeMonitor → CC-Usage Tab
# → Siehst LIVE Badges mit Real-Time Limits!
```

## Logs überwachen:

```bash
# Scraper Cron Logs
tail -f /var/log/claude-scraper.log

# Manuelle Scraper-Ausführung (Test)
cd /root/projekte/werkingflow/autopilot/cui
npx tsx scripts/scrape-claude-usage.ts
```

## Files:

| File | Purpose |
|------|---------|
| `extract-tokens-mac.py` | Mac: Token Extraktor |
| `setup-cc-usage.sh` | Server: Komplettes Setup |
| `create-session-from-token.ts` | Token → Session State |
| `scrape-claude-usage.ts` | Täglicher Scraper |
| `claude-usage-scraped.json` | Scraper Output (Live Data) |

## Troubleshooting:

**"No tokens found in environment"**
→ `source ~/.zshrc` nicht ausgeführt

**"Token invalid - got redirected to login"**
→ Token abgelaufen, neu extrahieren vom Mac

**"No session state found"**
→ `create-session-from-token.ts` ausführen

**LIVE Badge fehlt im Frontend**
→ Server neu starten (lädt `claude-usage-scraped.json`)

---

**Komplette Doku**: `CC_USAGE_TRACKING.md`
