# Claude.ai Session Cookie Setup

## Warum?

Der Scraper braucht die `sessionKey` Cookies deiner Claude.ai Accounts um die echten Usage-Daten von `claude.ai/settings/usage` zu extrahieren.

## Wie komme ich an meine Session Cookies?

### 1. Browser öffnen (Chrome/Arc)
1. Gehe zu https://claude.ai
2. Öffne Developer Tools (Cmd+Option+I auf Mac)
3. Gehe zum **Application** Tab
4. Links unter **Storage** > **Cookies** > `https://claude.ai`
5. Suche nach dem Cookie `sessionKey`
6. Kopiere den **Value** (langer String mit ca. 200 Zeichen)

### 2. Für jeden Account wiederholen

Du musst das für ALLE Claude.ai Accounts machen die du tracken willst:
- **rafael**: engelmann.rafael@gmail.com
- **office**: dein Office-Account
- **engelmann**: dein Engelmann-Account

**Pro Account**:
1. Logout in Claude.ai
2. Login mit dem jeweiligen Account
3. Cookie aus Dev Tools kopieren
4. Notiere: Account-Name + Cookie-Value

### 3. Cookies in `.zshrc` speichern

Füge in `/root/.zshrc` hinzu:

```bash
# Claude.ai Session Cookies (für Usage Scraping)
export CLAUDE_SESSION_RAFAEL="sk-ant-sid01-..."  # dein rafael cookie
export CLAUDE_SESSION_OFFICE="sk-ant-sid01-..."   # dein office cookie
export CLAUDE_SESSION_ENGELMANN="sk-ant-sid01-..." # dein engelmann cookie
```

**WICHTIG**:
- Cookies sind SENSIBEL! Niemals in Git committen
- Cookies laufen ab (nach ~30 Tagen) → dann neu holen
- Nur auf dem Dev-Server speichern (nicht in .env!)

### 4. `.zshrc` neu laden

```bash
source ~/.zshrc
```

### 5. Testen

```bash
cd /root/projekte/werkingflow/autopilot/cui
npm install playwright  # falls nicht installiert
npx tsx scripts/scrape-claude-usage.ts
```

**Erwartete Ausgabe:**
```
[Scraper] Navigating to claude.ai/settings/usage for rafael...
[Scraper] ✓ Scraped rafael: 83% weekly
[Scraper] Navigating to claude.ai/settings/usage for office...
[Scraper] ✓ Scraped office: 45% weekly
...
[Scraper] ✓ Saved 3 accounts to claude-usage-scraped.json

--- USAGE SUMMARY ---
RAFAEL:
  Current Session: 4% (resets in 3 Std. 46 Min.)
  Weekly All: 83% (resets Do., 11:00)
  Weekly Sonnet: 1% (resets Di., 11:00)
```

## 6. Integration in CUI Server

Sobald das funktioniert, integriere ich den Scraper in den `/api/claude-code/stats-v2` Endpoint:
- Scraper läuft alle 15min im Hintergrund
- Daten werden gecached
- CUI Dashboard zeigt **echte Claude.ai Limits** statt Schätzungen

## Troubleshooting

**"Failed to scrape: timeout"**
→ Cookie abgelaufen, neu holen (Schritt 1-2 wiederholen)

**"No session cookie for rafael"**
→ `CLAUDE_SESSION_RAFAEL` nicht in `.zshrc` gesetzt oder `.zshrc` nicht neu geladen

**"403 Forbidden"**
→ Cookie ungültig, neu holen

**"Cannot find selector"**
→ Claude.ai UI hat sich geändert, Scraper muss angepasst werden (melde dich bei mir)
