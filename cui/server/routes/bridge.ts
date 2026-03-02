import { Router } from 'express';
import { resolve, join } from 'path';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';

const router = Router();

// --- Claude Code Usage Stats (CC-Usage) ---
const CC_ACCOUNTS = [
  { id: "engelmann", displayName: "Engelmann", homeDir: "/home/claude-user/.cui-account2" },
  { id: "rafael", displayName: "Gmail", homeDir: "/home/claude-user/.cui-account1" },
  { id: "office", displayName: "Office", homeDir: "/home/claude-user/.cui-account3" },
];
const SCRAPED_FILE = resolve(import.meta.dirname ?? ".", "..", "claude-usage-scraped.json");
const WEEKLY_LIMIT_ESTIMATE = 45_000_000; // Conservative Pro plan estimate

router.get("/api/claude-code/stats-v2", async (_req, res) => {
  try {
    // Load scraped data if available
    let scrapedMap: Record<string, any> = {};
    try {
      if (existsSync(SCRAPED_FILE)) {
        const scraped = JSON.parse(readFileSync(SCRAPED_FILE, "utf-8"));
        for (const entry of scraped) {
          const key = entry.account?.toLowerCase().replace(/@.*/, "").replace(/\..+/, "");
          if (key) scrapedMap[key] = entry;
        }
      }
    } catch { /* scraped data optional */ }

    const now = Date.now();
    const ONE_HOUR = 3600_000;
    const ONE_DAY = 86400_000;
    const ONE_WEEK = 7 * ONE_DAY;
    const accounts: any[] = [];
    const alerts: any[] = [];

    for (const acc of CC_ACCOUNTS) {
      const projectsDir = join(acc.homeDir, ".claude", "projects");
      let workspaces: string[] = [];
      let totalSessions = 0;
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let totalCacheCreation = 0;
      let totalCacheRead = 0;
      let lastActivity: string | null = null;
      let models: Record<string, number> = {};
      let recentTokens = 0; // last 24h
      let windowTokens = 0; // last 5h
      let lastWindowMsg: string | null = null;

      try {
        if (existsSync(projectsDir)) {
          workspaces = readdirSync(projectsDir).filter(d => {
            try { return statSync(join(projectsDir, d)).isDirectory(); } catch { return false; }
          });

          for (const ws of workspaces) {
            const wsDir = join(projectsDir, ws);
            let jsonlFiles: string[] = [];
            try {
              jsonlFiles = readdirSync(wsDir).filter(f => f.endsWith(".jsonl") && /^[0-9a-f]{8}-/.test(f));
            } catch { continue; }

            totalSessions += jsonlFiles.length;

            for (const file of jsonlFiles) {
              try {
                const content = readFileSync(join(wsDir, file), "utf-8");
                const lines = content.split("\n").filter(Boolean);

                for (const line of lines) {
                  try {
                    const entry = JSON.parse(line);
                    if (entry.type !== "assistant" || !entry.message?.usage) continue;

                    const usage = entry.message.usage;
                    const model = entry.message.model || "unknown";
                    const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : 0;

                    const input = (usage.input_tokens || 0);
                    const output = (usage.output_tokens || 0);
                    const cacheCreate = (usage.cache_creation_input_tokens || 0);
                    const cacheRead = (usage.cache_read_input_tokens || 0);

                    totalInputTokens += input;
                    totalOutputTokens += output;
                    totalCacheCreation += cacheCreate;
                    totalCacheRead += cacheRead;

                    models[model] = (models[model] || 0) + input + output;

                    if (entry.timestamp && (!lastActivity || entry.timestamp > lastActivity)) {
                      lastActivity = entry.timestamp;
                    }

                    // Recent activity tracking
                    if (ts > now - ONE_DAY) {
                      recentTokens += input + output;
                    }
                    if (ts > now - 5 * ONE_HOUR) {
                      windowTokens += input + output;
                      if (!lastWindowMsg || (entry.timestamp && entry.timestamp > lastWindowMsg)) {
                        lastWindowMsg = entry.timestamp;
                      }
                    }
                  } catch { /* skip malformed lines */ }
                }
              } catch { /* skip unreadable files */ }
            }
          }
        }
      } catch { /* account dir issues */ }

      const totalTokens = totalInputTokens + totalOutputTokens;
      const burnRatePerHour = recentTokens > 0 ? recentTokens / 24 : 0;
      const weeklyProjection = burnRatePerHour * 24 * 7;

      // Merge with scraped data
      const scraped = scrapedMap[acc.id];
      let weeklyLimitPercent = weeklyProjection > 0 ? (weeklyProjection / WEEKLY_LIMIT_ESTIMATE) * 100 : 0;
      let weeklyLimitActual = 0;
      let dataSource: string = "jsonl-estimated";
      let scrapedTimestamp: string | null = null;
      let nextWindowReset: string | null = null;

      if (scraped) {
        weeklyLimitPercent = scraped.weeklyAllModels?.percent ?? weeklyLimitPercent;
        weeklyLimitActual = scraped.weeklyAllModels?.percent ? Math.round(WEEKLY_LIMIT_ESTIMATE * scraped.weeklyAllModels.percent / 100) : 0;
        dataSource = totalTokens > 0 ? "hybrid" : "scraped";
        scrapedTimestamp = scraped.timestamp || null;
      }

      // Calculate 5h window reset
      if (lastWindowMsg) {
        const windowStart = new Date(lastWindowMsg).getTime();
        nextWindowReset = new Date(windowStart + 5 * ONE_HOUR).toISOString();
      }

      // Status determination
      let status: string = "safe";
      if (weeklyLimitPercent >= 80) { status = "critical"; }
      else if (weeklyLimitPercent >= 50) { status = "warning"; }
      // Also check extra usage budget exhaustion
      if (scraped?.extraUsage?.balance === "0.00 EUR" && (scraped?.extraUsage?.percent ?? 0) >= 100) {
        status = "critical";
      }

      // Generate alerts
      if (status === "critical") {
        const isExtraBudgetDepleted = scraped?.extraUsage?.balance === "0.00 EUR" && (scraped?.extraUsage?.percent ?? 0) >= 100;
        const isWeeklyFull = weeklyLimitPercent >= 80;
        const reason = isExtraBudgetDepleted && !isWeeklyFull
          ? `Extra-Budget aufgebraucht (${scraped?.extraUsage?.spent} / ${scraped?.extraUsage?.limit}). Account blockiert!`
          : isExtraBudgetDepleted && isWeeklyFull
          ? `Weekly ${weeklyLimitPercent.toFixed(0)}% + Extra-Budget aufgebraucht. Account blockiert!`
          : `Weekly usage at ${weeklyLimitPercent.toFixed(0)}%. Consider switching workload.`;
        alerts.push({
          severity: "critical",
          title: `${acc.displayName}: Limit erreicht`,
          description: reason,
          accountName: acc.displayName,
        });
      }

      // Calculate storage
      let storageBytes = 0;
      try {
        if (existsSync(projectsDir)) {
          const dirs = readdirSync(projectsDir);
          for (const d of dirs) {
            try {
              const files = readdirSync(join(projectsDir, d));
              for (const f of files) {
                try { storageBytes += statSync(join(projectsDir, d, f)).size; } catch (err) { /* stat error, skip */ }
              }
            } catch (err) { /* dir read error, skip */ }
          }
        }
      } catch (err) { /* storage calc error, skip */ }

      accounts.push({
        accountId: acc.id,
        accountName: acc.displayName,
        workspaces,
        totalTokens,
        totalSessions,
        totalInputTokens,
        totalOutputTokens,
        totalCacheCreation,
        totalCacheRead,
        lastActivity,
        models,
        storageBytes,
        burnRatePerHour: Math.round(burnRatePerHour),
        weeklyProjection: Math.round(weeklyProjection),
        weeklyLimitPercent: Math.round(weeklyLimitPercent * 10) / 10,
        weeklyLimitActual,
        status,
        nextWindowReset,
        currentWindowTokens: windowTokens,
        dataSource,
        scrapedTimestamp,
        scraped: scraped ? { plan: scraped.plan, currentSession: scraped.currentSession, weeklyAllModels: scraped.weeklyAllModels, weeklySonnet: scraped.weeklySonnet, extraUsage: scraped.extraUsage } : null,
      });
    }
    // Combined JSONL stats (all accounts share the same projects dir via symlink)
    const first = accounts[0];
    const combinedJsonl = first ? {
      totalTokens: first.totalTokens,
      totalSessions: first.totalSessions,
      totalInputTokens: first.totalInputTokens,
      totalOutputTokens: first.totalOutputTokens,
      totalCacheCreation: first.totalCacheCreation,
      totalCacheRead: first.totalCacheRead,
      burnRatePerHour: first.burnRatePerHour,
      models: first.models,
      storageBytes: first.storageBytes,
      lastActivity: first.lastActivity,
      workspaceCount: first.workspaces.length,
    } : null;

    res.json({
      accounts,
      combinedJsonl,
      alerts,
      weeklyLimit: WEEKLY_LIMIT_ESTIMATE,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error("[CC-Usage] Stats error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/claude-code/scrape-now - Trigger on-demand usage scrape
router.post("/api/claude-code/scrape-now", async (req, res) => {
  const { exec } = await import("child_process");
  const scriptPath = resolve(import.meta.dirname ?? ".", "..", "scripts", "scrape-claude-usage.ts");

  console.log("[CC-Usage] Starting on-demand scrape...");

  exec(`cd ${resolve(import.meta.dirname ?? ".", "..")} && npx tsx ${scriptPath}`, (err, stdout, stderr) => {
    if (err) {
      console.error("[CC-Usage] Scrape failed:", err.message);
      return res.status(500).json({ error: err.message, stderr });
    }

    console.log("[CC-Usage] Scrape completed:", stdout);

    // Return success with scraped data
    try {
      const scrapedData = JSON.parse(readFileSync(SCRAPED_FILE, "utf-8"));
      res.json({
        success: true,
        accounts: scrapedData.length,
        timestamp: new Date().toISOString(),
        data: scrapedData
      });
    } catch (parseErr: any) {
      res.json({ success: true, warning: "Scrape completed but could not parse result", stdout });
    }
  });
});

// ========================================
// Bridge Monitor API Endpoints
// ========================================

const BRIDGE_URL = 'http://49.12.72.66:8000';
const BRIDGE_API_KEY = process.env.AI_BRIDGE_API_KEY || '';

let _bridgeFailCount = 0;
let _bridgeCircuitOpenUntil = 0;

async function bridgeFetch(path: string, options: any = {}) {
  // Circuit breaker: skip requests when bridge is known-down
  if (_bridgeCircuitOpenUntil > Date.now()) {
    throw new Error('Bridge circuit breaker open — skipping request');
  }
  const headers = {
    'Authorization': `Bearer ${BRIDGE_API_KEY}`,
    ...options.headers,
  };
  try {
    const response = await fetch(`${BRIDGE_URL}${path}`, { ...options, headers, signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Bridge API error: ${response.status}`);
    _bridgeFailCount = 0; // Reset on success
    return response.json();
  } catch (err) {
    _bridgeFailCount++;
    if (_bridgeFailCount >= 3) {
      _bridgeCircuitOpenUntil = Date.now() + 60000; // Open circuit for 60s
      console.warn(`[Bridge] Circuit breaker OPEN after ${_bridgeFailCount} failures — pausing 60s`);
      _bridgeFailCount = 0;
    }
    throw err;
  }
}

// Overview: Quick stats + Sankey data
// Simple proxy endpoints to new Bridge metrics API

router.get('/api/bridge/metrics/overview', async (_req, res) => {
  try {
    const data = await bridgeFetch('/metrics/overview');
    res.json(data);
  } catch (err: any) {
    console.error('[Bridge] Overview error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/bridge/metrics/usage', async (req, res) => {
  try {
    const limit = req.query.limit ? `?limit=${req.query.limit}` : '';
    const data = await bridgeFetch(`/metrics/usage${limit}`);
    res.json(data);
  } catch (err: any) {
    console.error('[Bridge] Usage error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/bridge/metrics/cost', async (_req, res) => {
  try {
    const data = await bridgeFetch('/metrics/cost');
    res.json(data);
  } catch (err: any) {
    console.error('[Bridge] Cost error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/bridge/metrics/limits', async (_req, res) => {
  try {
    const data = await bridgeFetch('/metrics/limits');
    res.json(data);
  } catch (err: any) {
    console.error('[Bridge] Limits error:', err.message);
    // Fallback: Return empty data if endpoint doesn't exist (404)
    res.json({
      providers: [],
      history: [],
      lastUpdated: new Date().toISOString(),
      _note: 'Bridge endpoint not available - showing empty state',
    });
  }
});

router.get('/api/bridge/metrics/activity', async (req, res) => {
  try {
    const limit = req.query.limit ? `?limit=${req.query.limit}` : '';
    const data = await bridgeFetch(`/metrics/activity${limit}`);
    res.json(data);
  } catch (err: any) {
    console.error('[Bridge] Activity error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
