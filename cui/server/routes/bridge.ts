import { Router } from 'express';
import { resolve, join } from 'path';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { execFile } from 'child_process';
import { ACCOUNT_CONFIG } from './claude-cli.js';

const router = Router();

// --- Claude Code Usage Stats (CC-Usage) ---
// Account config from single source of truth (claude-cli.ts)
const CC_ACCOUNTS = ACCOUNT_CONFIG.map(a => ({ id: a.id, displayName: a.label, homeDir: a.home }));
// bridge.ts lives in server/routes/ → go up 2 levels to reach cui/ where scraped file lives
const SCRAPED_FILE = resolve(import.meta.dirname ?? ".", "..", "..", "claude-usage-scraped.json");
const WEEKLY_LIMIT_ESTIMATE = 45_000_000; // Conservative Pro plan estimate

// --- JSONL Background Cache ---
// All accounts share the same projects dir via symlink, so we only parse once.
// Parsing runs in a child process to avoid blocking the event loop (2.6GB+ of JSONL).
interface JsonlCache {
  data: JsonlStats | null;
  computedAt: number;
  computing: boolean;
}

interface JsonlStats {
  totalSessions: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreation: number;
  totalCacheRead: number;
  totalTokens: number;
  models: Record<string, number>;
  burnRatePerHour: number;
  storageBytes: number;
  lastActivity: string | null;
  workspaceCount: number;
}

const JSONL_CACHE_TTL = 10 * 60 * 1000; // 10 minutes
const jsonlCache: JsonlCache = { data: null, computedAt: 0, computing: false };

function triggerJsonlCompute(): void {
  if (jsonlCache.computing) return;
  jsonlCache.computing = true;

  // Use 'du' for storage size (fast, kernel-level) instead of iterating files
  const projectsDir = join(CC_ACCOUNTS[0]?.homeDir ?? "", ".claude", "projects");
  if (!existsSync(projectsDir)) {
    jsonlCache.computing = false;
    return;
  }

  // Run JSONL parsing in a subprocess to not block the event loop.
  // The script reads all JSONL files, aggregates token stats, and outputs JSON to stdout.
  const script = `
    const { readdirSync, readFileSync, statSync } = require('fs');
    const { join } = require('path');
    const dir = ${JSON.stringify(projectsDir)};
    const now = Date.now();
    const ONE_DAY = 86400000;
    let totalSessions = 0, totalInput = 0, totalOutput = 0, totalCacheCreate = 0, totalCacheRead = 0;
    let lastActivity = null, recentTokens = 0, storageBytes = 0;
    const models = {};
    let workspaceCount = 0;
    try {
      const wsDirs = readdirSync(dir).filter(d => { try { return statSync(join(dir, d)).isDirectory(); } catch { return false; } });
      workspaceCount = wsDirs.length;
      for (const ws of wsDirs) {
        const wsDir = join(dir, ws);
        let files;
        try { files = readdirSync(wsDir).filter(f => f.endsWith('.jsonl') && /^[0-9a-f]{8}-/.test(f)); } catch { continue; }
        totalSessions += files.length;
        for (const f of files) {
          const fp = join(wsDir, f);
          try { storageBytes += statSync(fp).size; } catch { continue; }
          let content;
          try { content = readFileSync(fp, 'utf-8'); } catch { continue; }
          const lines = content.split('\\n');
          for (const line of lines) {
            if (!line) continue;
            let entry;
            try { entry = JSON.parse(line); } catch { continue; }
            if (entry.type !== 'assistant' || !entry.message?.usage) continue;
            const u = entry.message.usage;
            const inp = u.input_tokens || 0;
            const out = u.output_tokens || 0;
            totalInput += inp;
            totalOutput += out;
            totalCacheCreate += u.cache_creation_input_tokens || 0;
            totalCacheRead += u.cache_read_input_tokens || 0;
            const model = entry.message.model || 'unknown';
            models[model] = (models[model] || 0) + inp + out;
            if (entry.timestamp && (!lastActivity || entry.timestamp > lastActivity)) lastActivity = entry.timestamp;
            const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : 0;
            if (ts > now - ONE_DAY) recentTokens += inp + out;
          }
        }
      }
    } catch (e) { process.stderr.write('JSONL parse error: ' + e.message + '\\n'); }
    const burnRate = recentTokens > 0 ? Math.round(recentTokens / 24) : 0;
    process.stdout.write(JSON.stringify({
      totalSessions, totalInputTokens: totalInput, totalOutputTokens: totalOutput,
      totalCacheCreation: totalCacheCreate, totalCacheRead: totalCacheRead,
      totalTokens: totalInput + totalOutput, models, burnRatePerHour: burnRate,
      storageBytes, lastActivity, workspaceCount
    }));
  `;

  execFile('node', ['-e', script], { timeout: 120_000, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
    jsonlCache.computing = false;
    if (err) {
      console.error("[CC-Usage] JSONL background compute failed:", err.message, stderr);
      return;
    }
    try {
      jsonlCache.data = JSON.parse(stdout);
      jsonlCache.computedAt = Date.now();
      console.log("[CC-Usage] JSONL cache refreshed:", jsonlCache.data?.totalSessions, "sessions,", jsonlCache.data?.totalTokens, "tokens");
    } catch (parseErr: any) {
      console.error("[CC-Usage] JSONL parse failed:", parseErr.message);
    }
  });
}

// Kick off initial JSONL computation on startup
setTimeout(triggerJsonlCompute, 5000);

router.get("/api/claude-code/stats-v2", async (_req, res) => {
  try {
    // Load scraped data (source of truth for usage %, small file, instant)
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

    // Refresh JSONL cache if stale
    if (Date.now() - jsonlCache.computedAt > JSONL_CACHE_TTL) {
      triggerJsonlCompute();
    }

    const accounts: any[] = [];
    const alerts: any[] = [];

    for (const acc of CC_ACCOUNTS) {
      const scraped = scrapedMap[acc.id];
      const scrapedTimestamp = scraped?.timestamp || null;

      // Weekly limit — scraped data is authoritative
      let weeklyLimitPercent = scraped?.weeklyAllModels?.percent ?? 0;
      const dataSource = scraped ? (jsonlCache.data ? "hybrid" : "scraped") : (jsonlCache.data ? "jsonl-estimated" : "none");

      // Status determination
      let status: string = "safe";
      if (weeklyLimitPercent >= 80) status = "critical";
      else if (weeklyLimitPercent >= 50) status = "warning";
      // Extra usage budget exhaustion overrides
      const extraPct = scraped?.extraUsage?.percent ?? 0;
      const extraBalance = scraped?.extraUsage?.balance;
      if (extraPct >= 100 && extraBalance && parseFloat(extraBalance) <= 0) {
        status = "critical";
      }

      // Generate alerts
      if (status === "critical") {
        const isExtraBudgetDepleted = extraPct >= 100 && extraBalance && parseFloat(extraBalance) <= 0;
        const isWeeklyFull = weeklyLimitPercent >= 80;
        const reason = isExtraBudgetDepleted && !isWeeklyFull
          ? `Extra-Budget aufgebraucht (${scraped?.extraUsage?.spent} / ${scraped?.extraUsage?.limit}). Account blockiert!`
          : isExtraBudgetDepleted && isWeeklyFull
          ? `Weekly ${weeklyLimitPercent.toFixed(0)}% + Extra-Budget aufgebraucht. Account blockiert!`
          : `Weekly usage at ${weeklyLimitPercent.toFixed(0)}%. Consider switching workload.`;
        alerts.push({ severity: "critical", title: `${acc.displayName}: Limit erreicht`, description: reason });
      }

      accounts.push({
        accountId: acc.id,
        accountName: acc.displayName,
        workspaces: [],
        totalTokens: jsonlCache.data?.totalTokens ?? 0,
        totalSessions: jsonlCache.data?.totalSessions ?? 0,
        totalInputTokens: jsonlCache.data?.totalInputTokens ?? 0,
        totalOutputTokens: jsonlCache.data?.totalOutputTokens ?? 0,
        totalCacheCreation: jsonlCache.data?.totalCacheCreation ?? 0,
        totalCacheRead: jsonlCache.data?.totalCacheRead ?? 0,
        lastActivity: jsonlCache.data?.lastActivity ?? null,
        models: jsonlCache.data?.models ?? {},
        storageBytes: jsonlCache.data?.storageBytes ?? 0,
        burnRatePerHour: jsonlCache.data?.burnRatePerHour ?? 0,
        weeklyProjection: 0,
        weeklyLimitPercent: Math.round(weeklyLimitPercent * 10) / 10,
        weeklyLimitActual: 0,
        status,
        nextWindowReset: null,
        currentWindowTokens: 0,
        dataSource,
        scrapedTimestamp,
        scraped: scraped ? { plan: scraped.plan, currentSession: scraped.currentSession, weeklyAllModels: scraped.weeklyAllModels, weeklySonnet: scraped.weeklySonnet, extraUsage: scraped.extraUsage } : null,
      });
    }

    // Combined JSONL stats (shared across all accounts via symlink)
    const combinedJsonl = jsonlCache.data ?? null;

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

const BRIDGE_URL = process.env.AI_BRIDGE_URL || 'http://49.12.72.66:8000';
const BRIDGE_API_KEY = process.env.AI_BRIDGE_API_KEY || '';

async function bridgeFetch(path: string, options: any = {}) {
  const headers = {
    'Authorization': `Bearer ${BRIDGE_API_KEY}`,
    ...options.headers,
  };

  // Simple retry logic: 2 attempts, 1s delay between (skip retry on 404 — endpoint doesn't exist)
  let lastError: any;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetch(`${BRIDGE_URL}${path}`, {
        ...options,
        headers,
        signal: AbortSignal.timeout(8000)
      });
      if (!response.ok) {
        const err = new Error(`Bridge API error: ${response.status}`);
        (err as any).status = response.status;
        throw err;
      }
      return response.json();
    } catch (err: any) {
      lastError = err;
      // Don't retry on 404 (endpoint doesn't exist) or 401 (auth error)
      if (err.status === 404 || err.status === 401) break;
      if (attempt < 2) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }
  throw lastError;
}

// Overview: Quick stats + Sankey data
// Simple proxy endpoints to new Bridge metrics API

// Helper: bridge metric endpoint with empty-data fallback on error
function bridgeMetricHandler(name: string, path: string | ((req: any) => string), emptyData: any = {}) {
  return async (req: any, res: any) => {
    try {
      const p = typeof path === 'function' ? path(req) : path;
      const data = await bridgeFetch(p);
      res.json(data);
    } catch (err: any) {
      // Downgrade to warn — these are expected when Bridge endpoints are unavailable
      console.warn(`[Bridge] ${name}: ${err.message}`);
      res.json({ ...emptyData, _error: err.message, _note: 'Bridge endpoint not available' });
    }
  };
}

// Overview: Composite from /stats + /health + /v1/sessions/stats + /rate-limits
router.get('/api/bridge/metrics/overview', async (_req, res) => {
  try {
    const [stats, health, sessions, rateLimits] = await Promise.all([
      bridgeFetch('/stats').catch(() => null),
      bridgeFetch('/health').catch(() => null),
      bridgeFetch('/v1/sessions/stats').catch(() => null),
      bridgeFetch('/rate-limits').catch(() => null),
    ]);
    console.log('[Bridge] Overview: stats=%s health=%s sessions=%s limits=%s',
      stats ? 'ok' : 'fail', health ? 'ok' : 'fail', sessions ? 'ok' : 'fail', rateLimits ? 'ok' : 'fail');
    res.json({
      health: health?.status ?? stats?.status ?? 'unknown',
      worker: rateLimits?.current_worker ?? health?.worker_instance ?? '-',
      uptime_hours: 0,
      total_requests: stats?.request_limiting?.total_requests ?? 0,
      avg_response_time: 0,
      success_rate: stats?.request_limiting?.rejected_requests === 0 ? 100 : 99,
      active_sessions: sessions?.session_stats?.active_sessions ?? 0,
      active_requests: stats?.request_limiting?.active_requests ?? 0,
      max_concurrent: stats?.request_limiting?.max_concurrent ?? 0,
      memory_usage_percent: stats?.request_limiting?.memory_usage_percent ?? 0,
      memory_used_gb: stats?.request_limiting?.memory_used_gb ?? 0,
      can_accept_requests: stats?.can_accept_requests ?? false,
      rate_limited: rateLimits?.current_worker_rate_limited ?? false,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    console.warn('[Bridge] Overview error:', err.message);
    res.json({ _error: err.message, _note: 'Bridge not reachable' });
  }
});
router.get('/api/bridge/metrics/usage', bridgeMetricHandler('Usage', '/v1/sessions/stats', { session_stats: {} }));
router.get('/api/bridge/metrics/cost', bridgeMetricHandler('Cost', '/v1/metrics', { metrics: {} }));
router.get('/api/bridge/metrics/limits', bridgeMetricHandler('Limits', '/rate-limits', { current_worker: 'unknown', all_rate_limits: {} }));
router.get('/api/bridge/metrics/activity', bridgeMetricHandler('Activity', (req) => `/v1/sessions${req.query.limit ? `?limit=${req.query.limit}` : ''}`, { sessions: [], total: 0 }));

// Persistent metrics from PostgreSQL (survives worker restarts)
router.get("/api/bridge/metrics/persistent", bridgeMetricHandler("Persistent", "/v1/metrics/persistent", { source: "postgresql", realtime: {}, daily: [], endpoints: [], models: [], apps: [] }));

// Per-app metrics breakdown (connected frontend apps)
router.get("/api/bridge/metrics/apps", bridgeMetricHandler("Apps", "/v1/metrics/apps", { source: "postgresql", apps_period: [], apps_realtime: [] }));


// ── Generic Bridge Proxy ────────────────────────────────────────────────────
// Forwards any request from /api/bridge-proxy/* to the Bridge server.
// This allows the frontend to call Bridge API endpoints through the CUI server
// (required when browser can't reach Bridge IP directly, e.g., Mac → Hetzner).
router.use('/api/bridge-proxy', async (req: any, res: any) => {
  const bridgePath = req.path || '/';
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    const url = `${BRIDGE_URL}${bridgePath}${qs}`;
  try {
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${BRIDGE_API_KEY}`,
    };
    if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'] as string;

    const fetchOpts: RequestInit = {
      method: req.method,
      headers,
      signal: AbortSignal.timeout(30000),
    };
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.body) {
      fetchOpts.body = JSON.stringify(req.body);
    }

    const response = await fetch(url, fetchOpts);
    const contentType = response.headers.get('content-type') || '';

    // Stream the response
    res.status(response.status);
    if (contentType) res.setHeader('Content-Type', contentType);

    // HEAD requests: just return status, no body
    if (req.method === 'HEAD') {
      res.status(response.status).end();
      return;
    }

    if (contentType.includes('json')) {
      const data = await response.json();
      res.json(data);
    } else {
      const text = await response.text();
      res.send(text);
    }
  } catch (err: any) {
    console.warn(`[Bridge-Proxy] ${req.method} ${bridgePath}: ${err.message}`);
    res.status(502).json({ error: `Bridge proxy error: ${err.message}`, path: bridgePath });
  }
});

export default router;
