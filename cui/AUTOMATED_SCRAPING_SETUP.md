# Automated Claude.ai Usage Scraping

**Goal**: Automatically scrape claude.ai/settings/usage every 6 hours and update CC-Usage dashboard in CUI.

## Problem Solved

Session cookies from Mac browsers don't work on the server due to device/IP binding by Claude.ai. Solution: **Server logs in directly** and maintains persistent session state.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ 1. ONE-TIME SETUP (Interactive Login)                       │
│    npx tsx scripts/login-claude.ts rafael                  │
│    → Opens browser, manual login, saves session state      │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ 2. AUTOMATED SCRAPING (Cron Every 6h)                      │
│    npx tsx scripts/scrape-claude-usage.ts                  │
│    → Uses saved session, scrapes data, saves JSON          │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ 3. DATA CONVERSION                                          │
│    npx tsx scripts/convert-scraped-to-override.ts          │
│    → Converts to claude-limits-override.json format        │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ 4. CUI SERVER READS OVERRIDE FILE                          │
│    GET /api/claude-code/stats-v2                           │
│    → Merges JSONL data with override, shows "LIVE" badge   │
└─────────────────────────────────────────────────────────────┘
```

## Setup Steps

### 1. Install Chromium (One-Time)

```bash
cd /root/projekte/werkingflow/autopilot/cui
npx playwright install chromium
```

### 2. Interactive Login for Each Account

Run for each account you want to track:

```bash
# Rafael's account
npx tsx scripts/login-claude.ts rafael

# Office account
npx tsx scripts/login-claude.ts office

# Engelmann account
npx tsx scripts/login-claude.ts engelmann
```

**What happens:**
- Opens visible browser window (headless=false)
- Waits for you to manually log in with the account email
- Detects successful login automatically
- Saves session state to `/root/projekte/local-storage/backends/cui/playwright-sessions/{account}.json`

**Important:**
- You must use the **server's browser** (not Mac browser)
- Complete any 2FA/verification when prompted
- Wait until chat interface appears before closing
- Session persists indefinitely (until Claude.ai invalidates it)

### 3. Test Manual Scrape

```bash
npx tsx scripts/scrape-claude-usage.ts
```

**Expected output:**
```
[Scraper] Navigating to claude.ai/settings/usage for rafael...
[Scraper] ✓ Scraped rafael: 83% weekly
[Scraper] Navigating to claude.ai/settings/usage for office...
[Scraper] ✓ Scraped office: 42% weekly
...
[Scraper] ✓ Saved 3 accounts to claude-usage-scraped.json
```

### 4. Test Conversion

```bash
npx tsx scripts/convert-scraped-to-override.ts
```

**Expected output:**
```
✓ Updated 3 accounts in claude-limits-override.json
```

Check the override file:

```bash
cat claude-limits-override.json
```

### 5. Setup Cron (Automated Every 6h)

```bash
crontab -e
```

Add this line:

```cron
0 */6 * * * /root/projekte/werkingflow/autopilot/cui/scripts/auto-scrape-claude-usage.sh >> /tmp/claude-scraper.log 2>&1
```

**Schedule:** Runs at 00:00, 06:00, 12:00, 18:00 daily

**Logs:** Check `/tmp/claude-scraper.log` for scrape results

### 6. Verify in CUI

1. Restart CUI server (loads new endpoint)
2. Navigate to **BridgeMonitor → CC-Usage**
3. You should see "LIVE" badges on account cards
4. Metrics update every 6 hours automatically

## Files

| File | Purpose |
|------|---------|
| `scripts/login-claude.ts` | Interactive login, saves session state |
| `scripts/scrape-claude-usage.ts` | Headless scrape using saved session |
| `scripts/convert-scraped-to-override.ts` | Convert scraped data to override format |
| `scripts/auto-scrape-claude-usage.sh` | Cron wrapper script |
| `claude-limits-override.json` | Override file read by CUI server |
| `/root/projekte/local-storage/backends/cui/playwright-sessions/*.json` | Saved session states |

## Troubleshooting

### "No session state found for rafael"

Run the interactive login again:

```bash
npx tsx scripts/login-claude.ts rafael
```

### Session expired (scraper fails after working before)

Claude.ai invalidated the session. Re-run interactive login:

```bash
npx tsx scripts/login-claude.ts rafael
```

### Cron not running

Check cron logs:

```bash
tail -f /tmp/claude-scraper.log
```

Verify cron job is installed:

```bash
crontab -l
```

### Scraper hangs/times out

Check network connectivity:

```bash
curl -I https://claude.ai
```

Increase timeout in `scrape-claude-usage.ts` if needed.

## Session Lifecycle

**How long do sessions last?**
- Claude.ai sessions typically last **30-90 days**
- Sessions may expire earlier if security events occur (IP change, suspicious activity)

**When to re-login:**
- Scraper starts failing with "Page not found" or login redirects
- After major Claude.ai updates
- If you see 401/403 errors in logs

**Monitoring:**
- Check `/tmp/claude-scraper.log` weekly
- If scrape fails for 2+ consecutive runs → re-login

## Security

**Session state files** (`*.json`) contain authentication tokens. Permissions:

```bash
chmod 600 /root/projekte/local-storage/backends/cui/playwright-sessions/*.json
```

**Do NOT** commit session state files to git (already in `.gitignore`).

## Cost

**Zero cost** - Uses existing Claude.ai Pro accounts, no additional API calls needed.

## Next Steps

- [ ] Complete setup for all 3 accounts (rafael, office, engelmann)
- [ ] Verify cron runs successfully at next 6h interval
- [ ] Monitor `/tmp/claude-scraper.log` for first week
- [ ] Set calendar reminder to check logs monthly
