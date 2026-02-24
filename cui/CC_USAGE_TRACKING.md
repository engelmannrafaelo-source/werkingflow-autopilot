# Claude Code Usage Tracking

**Account-based CC-Usage monitoring with automated scraping from claude.ai**

## Overview

Tracks Claude Code usage across multiple accounts (rafael, office, engelmann, local) by:
1. Analyzing local `.claude/projects/**/*.jsonl` files for token usage
2. Automatically scraping real limits from `claude.ai/settings/usage` via Playwright
3. Displaying combined data in CUI BridgeMonitor with alerts and projections

## Architecture

### Why Account-Level Tracking?

Claude Code limits are **per account**, not per workspace. Multiple workspaces can share the same account:

```
rafael@werk-ing.com (Account)
  ├─ /root/orchestrator/workspaces/administration (Workspace)
  ├─ /root/orchestrator/workspaces/team (Workspace)
  └─ /root/projekte/orchestrator (Workspace)

office@werk-ing.com (Account)
  ├─ /root/orchestrator/workspaces/werking-report
  └─ /root/orchestrator/workspaces/werking-energy

engelmann@werk-ing.com (Account)
  └─ /root/orchestrator/workspaces/engelmann-ai-hub

local@werk-ing.com (Account)
  ├─ /root/projekte/werkingflow
  └─ /tmp
```

Usage aggregates across all workspaces of the same account.

### Data Sources

1. **JSONL Files** (`~/.claude/projects/**/*.jsonl`):
   - Token usage per message (input_tokens, output_tokens, cache_*)
   - Timestamps for 5h-window detection
   - Model usage breakdown
   - Storage size tracking

2. **Scraped Live Data** (`claude-usage-scraped.json`):
   - Real weekly limit percentage from claude.ai
   - Current session percentage
   - Reset times (weekly, 5h-window)
   - Sonnet-specific limits

### Hybrid Calculation

- **JSONL-only**: Estimates weekly projection from burn rate (less accurate)
- **With Scraped Data**: Uses real percentage from claude.ai, calculates actual limit from `total_tokens / (percent / 100)`
- **Display**: Shows "LIVE" badge when scraped data is active

## Setup

### 1. Install Chromium (one-time)

```bash
cd /root/projekte/werkingflow/autopilot/cui
npx playwright install chromium
```

### 2. Setup Authentication Tokens (one-time)

Add your long-lived Claude.ai authentication tokens to `~/.zshrc`:

```bash
# Edit ~/.zshrc
nano ~/.zshrc

# Add at the end:
export CLAUDE_AUTH_TOKEN_RAFAEL="sk-ant-..."
export CLAUDE_AUTH_TOKEN_OFFICE="sk-ant-..."
export CLAUDE_AUTH_TOKEN_ENGELMANN="sk-ant-..."

# Reload
source ~/.zshrc
```

**Where to get tokens:**
- These are your existing 1-year authentication tokens from Claude.ai
- Extract from browser cookies (`sessionKey` cookie)
- Or from existing authentication setup

### 3. Create Session States (one-time per account)

Generate Playwright session states from your tokens:

```bash
cd /root/projekte/werkingflow/autopilot/cui

# Create session for rafael account
npx tsx scripts/create-session-from-token.ts rafael

# Create session for office account
npx tsx scripts/create-session-from-token.ts office

# Create session for engelmann account
npx tsx scripts/create-session-from-token.ts engelmann
```

**What happens:**
1. Reads token from environment variable
2. Creates Playwright browser context with cookie
3. Verifies token by navigating to `claude.ai/settings/usage`
4. Saves session state to `/root/projekte/local-storage/backends/cui/playwright-sessions/{account}.json`

**No interactive login needed!** Runs headless, preserves your existing auth tokens.

### 4. Run Scraper (automated)

Once logged in, scraping works headless:

```bash
cd /root/projekte/werkingflow/autopilot/cui
npx tsx scripts/scrape-claude-usage.ts
```

**Output**: `claude-usage-scraped.json` with real usage data for all accounts.

### 5. Setup Cron (daily scraping)

```bash
# Add to crontab
crontab -e

# Scrape every day at 6:00 AM
0 6 * * * cd /root/projekte/werkingflow/autopilot/cui && npx tsx scripts/scrape-claude-usage.ts >> /var/log/claude-scraper.log 2>&1
```

## Usage

### View in CUI

1. Navigate to CUI: http://localhost:4005
2. Open **BridgeMonitor** panel
3. Click **CC-Usage** tab

### Account Cards

Each account shows:

- **Weekly Usage**: Real percentage (LIVE badge) or projected
- **Burn Rate**: Tokens/hour from last 24h
- **Limit Reached In**: Time until hitting weekly limit at current burn rate
- **5h-Window Reset**: When current session window resets

### Status Badges

- 🟢 **Safe** (<60%): Normal usage
- 🟡 **Warning** (60-80%): Elevated usage
- 🔴 **Critical** (>80%): Near limit, slow down!

### Alerts Panel

Shows actionable alerts:

- **Critical**: >80% weekly usage → "Reduce usage immediately"
- **Warning**: >60% weekly usage → "Monitor usage closely"
- **Info**: High burn rate → "Will reach limit in X hours"

## API Endpoint

**GET** `/api/claude-code/stats-v2`

```json
{
  "accounts": [
    {
      "accountName": "rafael",
      "workspaces": ["administration", "team", "diverse"],
      "totalTokens": 8500000,
      "weeklyLimitPercent": 83.0,
      "weeklyLimitActual": 10240964,
      "burnRatePerHour": 25000,
      "status": "critical",
      "nextWindowReset": "2026-02-24T17:46:00Z",
      "dataSource": "scraped",
      "scrapedTimestamp": "2026-02-24T12:30:00Z"
    }
  ],
  "alerts": [
    {
      "severity": "critical",
      "title": "rafael: 83% weekly limit",
      "description": "Reduce usage immediately. Limit reached in 5 hours at current burn rate.",
      "accountName": "rafael"
    }
  ],
  "weeklyLimit": 10000000,
  "timestamp": "2026-02-24T14:00:00Z"
}
```

## Files

| File | Purpose |
|------|---------|
| `scripts/create-session-from-token.ts` | Create session state from auth token |
| `scripts/scrape-claude-usage.ts` | Automated scraper using saved sessions |
| `server/index.ts` | `/api/claude-code/stats-v2` endpoint |
| `src/components/panels/BridgeMonitor/tabs/CCUsageTab.tsx` | Frontend component |
| `claude-usage-scraped.json` | Scraped data output (updated daily) |
| `/root/projekte/local-storage/backends/cui/playwright-sessions/*.json` | Saved session states |

## Troubleshooting

### "No session state found"

Run `npx tsx scripts/create-session-from-token.ts {account}` to create session.

### Scraper times out

Token may have expired. Get new token from browser and update `~/.zshrc`, then re-run session creation.

### "Token invalid - got redirected to login"

Token expired or incorrect. Extract fresh `sessionKey` cookie from browser:
1. Open claude.ai in browser
2. DevTools → Application → Cookies → `sessionKey`
3. Copy value to `~/.zshrc` as `CLAUDE_AUTH_TOKEN_{ACCOUNT}`
4. Run `source ~/.zshrc`
5. Re-run `npx tsx scripts/create-session-from-token.ts {account}`

### LIVE badge not showing

- Check if `claude-usage-scraped.json` exists
- Verify scraped data has valid `weeklyAllModels.percent`
- Restart CUI server to reload scraped data

## Maintenance

- **Token Renewal**: Update tokens in `~/.zshrc` if they expire (~1 year)
- **Session Refresh**: Re-run `create-session-from-token.ts` after token update
- **Cron Monitoring**: Check `/var/log/claude-scraper.log` for errors
- **Data Freshness**: `scrapedTimestamp` field shows last scrape time

## Token Security

- Tokens are **1-year authentication tokens** with full account access
- Store ONLY in `~/.zshrc` (never commit to git!)
- Never expose in logs or API responses
- Each account has separate token (rafael, office, engelmann)

---

**Last Updated**: 2026-02-24
