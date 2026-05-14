import { Router } from 'express';
import { resolve, join } from 'path';
import { existsSync, readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from 'fs';
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
  // routes/ → server/ → cui/ → scripts/
  const cuiDir = resolve(import.meta.dirname ?? ".", "..", "..");
  const scriptPath = resolve(cuiDir, "scripts", "scrape-claude-usage.ts");

  console.log("[CC-Usage] Starting on-demand scrape...");

  exec(`cd ${cuiDir} && npx tsx ${scriptPath}`, (err, stdout, stderr) => {
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

export interface RankedAccount {
  accountId: string;
  accountName: string;
  weeklyPercent: number;
  sessionPercent: number;
  status: 'safe' | 'warning' | 'critical';
  extraDepleted: boolean;
  available: boolean;
}

/**
 * Pure ranking function — usable in-process by mission.ts without a self-HTTP-fetch
 * (the route had `Authentication required`, so internal callers always fell through
 * to the hardcoded 'werking' fallback, which doesn't exist on partner-server).
 */
export function rankAccounts(): { bestAccount: string | null; accounts: RankedAccount[] } {
  const scrapedMap: Record<string, any> = {};
  try {
    if (existsSync(SCRAPED_FILE)) {
      const scraped = JSON.parse(readFileSync(SCRAPED_FILE, "utf-8"));
      for (const entry of scraped) {
        const key = entry.account?.toLowerCase().replace(/@.*/, "").replace(/\..+/, "");
        if (key) scrapedMap[key] = entry;
      }
    }
  } catch { /* scraped data optional */ }

  const ranked: RankedAccount[] = CC_ACCOUNTS.map(acc => {
    const scraped = scrapedMap[acc.id];
    const weeklyPercent = scraped?.weeklyAllModels?.percent ?? 0;
    const sessionPercent = scraped?.currentSession?.percent ?? 0;
    const extraBalance = scraped?.extraUsage?.balance ? parseFloat(scraped.extraUsage.balance) : Infinity;
    const extraDepleted = (scraped?.extraUsage?.percent ?? 0) >= 100 && extraBalance <= 0;

    let status: 'safe' | 'warning' | 'critical' = 'safe';
    if (weeklyPercent >= 80 || extraDepleted) status = 'critical';
    else if (weeklyPercent >= 50) status = 'warning';

    return {
      accountId: acc.id,
      accountName: acc.displayName,
      weeklyPercent: Math.round(weeklyPercent * 10) / 10,
      sessionPercent: Math.round(sessionPercent * 10) / 10,
      status,
      extraDepleted,
      available: status !== 'critical',
    };
  }).sort((a, b) => {
    if (a.available !== b.available) return a.available ? -1 : 1;
    return a.weeklyPercent - b.weeklyPercent;
  });

  const best = ranked.find(a => a.available);
  return { bestAccount: best?.accountId ?? null, accounts: ranked };
}

// GET /api/claude-code/best-account — Returns the least-loaded account for spawning new sessions
router.get("/api/claude-code/best-account", (_req, res) => {
  try {
    const { bestAccount, accounts } = rankAccounts();
    if (!bestAccount) {
      // All accounts critical (≥80% weekly OR extra balance depleted).
      // Caller MUST handle 503 — picking the least-bad account here just guarantees a quota fail.
      res.status(503).json({
        error: "all accounts critical",
        accounts,
        timestamp: new Date().toISOString(),
      });
      return;
    }
    res.json({ bestAccount, accounts, timestamp: new Date().toISOString() });
  } catch (err: any) {
    console.error("[CC-Usage] Best-account error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ========================================
// Bridge Monitor API Endpoints
// ========================================

import { BRIDGE_URL } from '../config/paths.js';
const BRIDGE_API_KEY = process.env.AI_BRIDGE_API_KEY || '';

async function bridgeFetch(path: string, options: any = {}) {
  const headers = {
    'Authorization': `Bearer ${BRIDGE_API_KEY}`,
    'X-App-ID': 'cui',
    'X-User-ID': 'cui-system',
    'X-Agent-ID': 'bridge-monitor',
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

// Overview: Composite from /stats + /health + /v1/sessions/stats + /rate-limits + AI-Guard
router.get('/api/bridge/metrics/overview', async (_req, res) => {
  try {
    const [stats, health, sessions, rateLimits, guardStatus, lbStatus, usageBreakdown] = await Promise.all([
      bridgeFetch('/stats').catch(() => null),
      bridgeFetch('/health').catch(() => null),
      bridgeFetch('/v1/sessions/stats').catch(() => null),
      bridgeFetch('/rate-limits').catch(() => null),
      // AI-Guard status (local service, fast)
      fetch('http://localhost:8050/status', { signal: AbortSignal.timeout(2000) })
        .then(r => r.json()).catch(() => null),
      // Worker health aggregate (metrics-reader)
      bridgeFetch('/lb-status').catch(() => null),
      // Historical usage from JSONL (24h)
      bridgeFetch('/v1/metrics/usage-breakdown?hours=24').catch(() => null),
    ]);
    console.log('[Bridge] Overview: stats=%s health=%s sessions=%s limits=%s guard=%s lb=%s usage=%s',
      stats ? 'ok' : 'fail', health ? 'ok' : 'fail', sessions ? 'ok' : 'fail',
      rateLimits ? 'ok' : 'fail', guardStatus ? 'ok' : 'fail',
      lbStatus ? 'ok' : 'fail', usageBreakdown ? 'ok' : 'fail');

    // Calculate cost from usage-breakdown
    const PRICING: Record<string, { input: number; output: number }> = {
      'claude-haiku-4-5-20251001':   { input: 0.80,  output: 4.00 },
      'claude-sonnet-4-5-20250929':  { input: 3.00,  output: 15.00 },
      'claude-opus-4-6':             { input: 15.00, output: 75.00 },
      'claude-opus-4-20250514':      { input: 15.00, output: 75.00 },
    };
    let totalCostUsd = 0;
    if (usageBreakdown?.models) {
      for (const m of usageBreakdown.models) {
        const p = PRICING[m.model];
        if (p) totalCostUsd += (m.input_tokens / 1_000_000) * p.input + (m.output_tokens / 1_000_000) * p.output;
      }
    }

    // Worker count from lb-status
    const workersUp = lbStatus?.workers?.up ?? 0;
    const workersTotal = lbStatus?.workers?.total ?? 0;

    res.json({
      health: health?.status ?? stats?.status ?? 'unknown',
      worker: rateLimits?.current_worker ?? health?.worker_instance ?? '-',
      uptime_hours: 0,
      total_requests: usageBreakdown?.summary?.total_calls ?? stats?.request_limiting?.total_requests ?? 0,
      avg_response_time: 0,
      success_rate: usageBreakdown?.summary?.total_calls > 0
        ? ((1 - (usageBreakdown.summary.total_errors / usageBreakdown.summary.total_calls)) * 100)
        : (stats?.request_limiting?.rejected_requests === 0 ? 100 : 99),
      active_sessions: sessions?.session_stats?.active_sessions ?? 0,
      active_requests: stats?.request_limiting?.active_requests ?? 0,
      max_concurrent: stats?.request_limiting?.max_concurrent ?? 0,
      memory_usage_percent: stats?.request_limiting?.memory_usage_percent ?? 0,
      memory_used_gb: stats?.request_limiting?.memory_used_gb ?? 0,
      can_accept_requests: stats?.can_accept_requests ?? false,
      rate_limited: rateLimits?.current_worker_rate_limited ?? false,
      // Historical data (24h from JSONL)
      usage_24h: usageBreakdown?.summary ? {
        total_calls: usageBreakdown.summary.total_calls,
        total_input_tokens: usageBreakdown.summary.total_input_tokens,
        total_output_tokens: usageBreakdown.summary.total_output_tokens,
        total_tokens: usageBreakdown.summary.total_tokens,
        total_errors: usageBreakdown.summary.total_errors,
        cost_usd: totalCostUsd,
        models: (usageBreakdown.models ?? []).length,
        apps: (usageBreakdown.apps ?? []).length,
      } : null,
      // Worker fleet status
      workers_status: lbStatus ? {
        up: workersUp,
        total: workersTotal,
        status: lbStatus.status,
      } : null,
      // AI-Guard data
      guard: guardStatus ? {
        running: true,
        slots: guardStatus.slots,
        queue: guardStatus.queue,
        queueLength: guardStatus.queueLength,
        metrics: guardStatus.metrics,
      } : { running: false },
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    console.warn('[Bridge] Overview error:', err.message);
    res.json({ _error: err.message, _note: 'Bridge not reachable' });
  }
});
// Usage: Composite from /stats + /v1/metrics/request-log to build the shape the frontend expects
router.get('/api/bridge/metrics/usage', async (_req, res) => {
  try {
    const [stats, requestLog] = await Promise.all([
      bridgeFetch('/stats').catch(() => null),
      bridgeFetch('/v1/metrics/request-log?hours=24&limit=1000').catch(() => null),
    ]);

    // Build endpoint breakdown from request log if available
    const endpointMap: Record<string, { requests: number; totalTime: number }> = {};
    if (requestLog?.entries && Array.isArray(requestLog.entries)) {
      for (const entry of requestLog.entries) {
        const ep = entry.endpoint || entry.path || 'unknown';
        if (!endpointMap[ep]) endpointMap[ep] = { requests: 0, totalTime: 0 };
        endpointMap[ep].requests++;
        endpointMap[ep].totalTime += entry.response_time ?? entry.duration ?? 0;
      }
    }

    const endpoints = Object.entries(endpointMap)
      .map(([endpoint, data]) => ({
        endpoint,
        requests: data.requests,
        avg_response_time: data.requests > 0 ? data.totalTime / data.requests : undefined,
      }))
      .sort((a, b) => b.requests - a.requests);

    res.json({
      total_requests: stats?.request_limiting?.total_requests ?? 0,
      endpoints,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    console.warn('[Bridge] Usage composite error:', err.message);
    res.json({
      total_requests: 0,
      endpoints: [],
      timestamp: new Date().toISOString(),
      _error: err.message,
    });
  }
});
// Cost: Real token data from usage-breakdown (JSONL-based, metrics-reader)
router.get('/api/bridge/metrics/cost', async (_req, res) => {
  try {
    const usage = await bridgeFetch('/v1/metrics/usage-breakdown?hours=24');
    if (!usage || !usage.summary) {
      throw new Error('usage-breakdown returned no data');
    }

    const PRICING: Record<string, { input: number; output: number }> = {
      'claude-haiku-4-5-20251001':   { input: 0.80,  output: 4.00 },
      'claude-sonnet-4-5-20250929':  { input: 3.00,  output: 15.00 },
      'claude-opus-4-6':             { input: 15.00, output: 75.00 },
      'claude-opus-4-20250514':      { input: 15.00, output: 75.00 },
    };

    const breakdown: Record<string, { requests: number; input_tokens: number; output_tokens: number; cost_usd: number }> = {};
    let totalCost = 0;

    for (const m of (usage.models ?? [])) {
      const p = PRICING[m.model];
      const cost = p
        ? (m.input_tokens / 1_000_000) * p.input + (m.output_tokens / 1_000_000) * p.output
        : 0;
      totalCost += cost;
      breakdown[m.model] = {
        requests: m.calls ?? 0,
        input_tokens: m.input_tokens ?? 0,
        output_tokens: m.output_tokens ?? 0,
        cost_usd: cost,
      };
    }

    res.json({
      total_requests: usage.summary.total_calls ?? 0,
      total_input_tokens: usage.summary.total_input_tokens ?? 0,
      total_output_tokens: usage.summary.total_output_tokens ?? 0,
      total_cost_usd: totalCost,
      breakdown,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    console.warn('[Bridge] Cost error:', err.message);
    res.status(502).json({ error: err.message });
  }
});
router.get('/api/bridge/metrics/limits', bridgeMetricHandler('Limits', '/rate-limits', { current_worker: 'unknown', all_rate_limits: {} }));
// Activity: Uses prompt-performance/calls for rich per-call data (user, app, model, tokens)
router.get('/api/bridge/metrics/activity', async (req: any, res: any) => {
  try {
    const limit = req.query.limit || '100';
    const hours = req.query.hours || '24';
    const app_id = req.query.app_id || '';
    const user_id = req.query.user_id || '';

    // Try new rich endpoint first, fall back to request-log
    let url = `/v1/metrics/prompt-performance/calls?hours=${hours}&limit=${limit}`;
    if (app_id) url += `&app_id=${encodeURIComponent(app_id)}`;
    if (user_id) url += `&user_id=${encodeURIComponent(user_id)}`;

    const data = await bridgeFetch(url);
    const calls = data?.calls ?? [];

    // Cost estimation per call (hardcoded pricing — same as Bridge usage_tracker.py)
    const PRICING: Record<string, { input: number; output: number }> = {
      'sonnet': { input: 3.0, output: 15.0 },
      'haiku': { input: 0.80, output: 4.0 },
      'opus': { input: 15.0, output: 75.0 },
    };
    function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
      const key = model.includes('opus') ? 'opus' : model.includes('haiku') ? 'haiku' : 'sonnet';
      const p = PRICING[key];
      return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
    }

    const requests = calls.map((c: any, idx: number) => ({
      id: `call-${Math.round((c.timestamp ?? 0) * 1000)}-${idx}`,
      timestamp: c.timestamp ? new Date(c.timestamp * 1000).toISOString() : new Date().toISOString(),
      user: c.user_id || 'anonymous',
      app: c.app_id || 'unknown',
      model: c.model || '-',
      provider: `worker:${c.worker || '?'}`,
      tokens: (c.input_tokens ?? 0) + (c.output_tokens ?? 0),
      cost: estimateCost(c.model || '', c.input_tokens ?? 0, c.output_tokens ?? 0),
      latency: c.duration_ms ?? 0,
      status: c.status === 'success' ? 'success' : c.status === 'timeout' ? 'timeout' : 'error',
      // Extra fields for detailed view
      agent_id: c.agent_id,
      input_tokens: c.input_tokens,
      output_tokens: c.output_tokens,
      session_id: c.session_id,
    }));

    // --- Layer-0 Contract Checks ---
    const _contractViolations: Array<{ code: string; severity: string; message: string; detail?: string; count?: number; total?: number }> = [];

    const noUser = requests.filter((r: any) => !r.user || r.user === 'anonymous' || r.user === '-');
    if (noUser.length > 0) {
      _contractViolations.push({
        code: 'BRIDGE_NO_USER', severity: 'error',
        message: `${noUser.length}/${requests.length} Calls ohne User-Attribution`,
        detail: 'Bridge sendet kein user_id — Kosten nicht zuordbar',
        count: noUser.length, total: requests.length,
      });
    }
    const noApp = requests.filter((r: any) => !r.app || r.app === 'unknown' || r.app === 'chat');
    if (noApp.length > 0) {
      _contractViolations.push({
        code: 'BRIDGE_NO_APP', severity: noApp.length === requests.length ? 'error' : 'warning',
        message: `${noApp.length}/${requests.length} Calls ohne App-Attribution`,
        detail: 'Bridge sendet kein app_id',
        count: noApp.length, total: requests.length,
      });
    }
    const successful = requests.filter((r: any) => r.status === 'success');
    const zeroTokens = successful.filter((r: any) => r.tokens === 0);
    if (zeroTokens.length > 0 && successful.length > 0) {
      _contractViolations.push({
        code: 'BRIDGE_NO_TOKENS', severity: zeroTokens.length > successful.length / 2 ? 'error' : 'warning',
        message: `Token-Tracking: ${zeroTokens.length}/${successful.length} Calls ohne Tokens`,
        detail: 'Kosten können nicht berechnet werden',
        count: zeroTokens.length, total: successful.length,
      });
    }

    if (_contractViolations.length > 0) {
      console.warn(`[Bridge] Contract violations on /activity: ${_contractViolations.map(v => v.code).join(', ')}`);
    }

    res.json({
      requests,
      total: data?.total ?? requests.length,
      _contractViolations,
    });
  } catch (err: any) {
    console.warn('[Bridge] Activity error:', err.message);
    // Fallback: try request-log (older Bridge without /calls endpoint)
    try {
      const limit = req.query.limit || '100';
      const chatLog = await bridgeFetch(`/v1/metrics/request-log?hours=24&limit=${limit}&endpoint=chat/completions`).catch(() => null);
      const entries = chatLog?.entries ?? [];
      const requests = entries.map((entry: any, idx: number) => ({
        id: `req-${Math.round((entry.ts ?? 0) * 1000)}-${idx}`,
        timestamp: entry.ts ? new Date(entry.ts * 1000).toISOString() : new Date().toISOString(),
        user: entry.client || '-',
        app: 'chat',
        model: 'claude-sonnet',
        provider: `worker:${entry.worker || '?'}`,
        tokens: 0,
        cost: 0,
        latency: Math.round((entry.duration_s ?? 0) * 1000),
        status: (entry.status ?? 0) < 400 ? 'success' : 'error',
      }));
      res.json({
        requests, total: chatLog?.summary?.total_requests ?? requests.length,
        _contractViolations: [{
          code: 'BRIDGE_FALLBACK', severity: 'error',
          message: 'Fallback auf request-log — keine Token/User/App-Daten verfügbar',
          detail: 'Bridge /v1/metrics/prompt-performance/calls Endpoint nicht erreichbar',
        }],
      });
    } catch {
      res.json({ requests: [], total: 0, _error: err.message });
    }
  }
});

// Usage Breakdown: Per-app, per-user, per-model aggregation with Sankey data
router.get('/api/bridge/metrics/usage-breakdown', async (req: any, res: any) => {
  const hours = req.query.hours || '24';
  try {
    const data = await bridgeFetch(`/v1/metrics/usage-breakdown?hours=${hours}`);
    // --- Layer-0 Contract Checks ---
    const violations: Array<{ code: string; severity: string; message: string; detail?: string; count?: number; total?: number }> = [];
    const summary = data?.summary || {};
    const users = data?.users || [];
    const anonUsers = users.filter((u: any) => !u.user_id || u.user_id === 'anonymous');
    if (anonUsers.length > 0) {
      const anonCalls = anonUsers.reduce((s: number, u: any) => s + (u.calls || 0), 0);
      violations.push({
        code: 'BRIDGE_NO_USER', severity: 'error',
        message: `${anonCalls} Calls von "anonymous" Users — nicht zuordbar`,
        detail: `${anonUsers.length} User-Einträge ohne echte User-ID`,
        count: anonCalls, total: summary.total_calls || 0,
      });
    }
    if (summary.total_tokens === 0 && summary.total_calls > 0) {
      violations.push({
        code: 'BRIDGE_NO_TOKENS', severity: 'error',
        message: `${summary.total_calls} Calls, aber 0 Tokens erfasst`,
        detail: 'Token-Tracking ist ausgefallen — Kosten-Berechnung unmöglich',
      });
    }
    res.json({ ...data, _contractViolations: violations.length > 0 ? violations : undefined });
  } catch (err: any) {
    console.warn(`[Bridge] UsageBreakdown: ${err.message}`);
    res.json({
      summary: { total_calls: 0, total_input_tokens: 0, total_output_tokens: 0, total_tokens: 0, total_errors: 0 },
      apps: [], users: [], models: [], sankey_links: [],
      period_hours: parseInt(hours as string) || 24,
      _error: err.message,
    });
  }
});

// Persistent metrics — composited from real JSONL-backed endpoints (survives worker restarts)
router.get("/api/bridge/metrics/persistent", async (req: any, res: any) => {
  try {
    const [usageBreakdown, promptPerf] = await Promise.all([
      bridgeFetch('/v1/metrics/usage-breakdown?hours=24').catch(() => null),
      bridgeFetch('/v1/metrics/prompt-performance?hours=168').catch(() => null),
    ]);

    const summary = usageBreakdown?.summary || {};
    const apps = (usageBreakdown?.apps || []).map((a: any) => ({
      app_id: a.app_id,
      total_requests: a.calls || 0,
      total_tokens: a.total_tokens || 0,
      total_cost_usd: estimateTokenCost(a.input_tokens || 0, a.output_tokens || 0),
      avg_response_time_ms: 0,
      success_rate: a.calls > 0 ? Math.round((1 - (a.errors || 0) / a.calls) * 100) : 100,
      last_seen: undefined,
      unique_users: a.users ? Object.keys(a.users).length : 0,
    }));
    const models = (usageBreakdown?.models || []).map((m: any) => ({
      model: m.model,
      total_requests: m.calls || 0,
      total_tokens: m.total_tokens || 0,
      total_cost_usd: estimateTokenCost(m.input_tokens || 0, m.output_tokens || 0),
    }));

    res.json({
      source: "jsonl",
      realtime: {
        total_requests: summary.total_calls || 0,
        total_tokens: summary.total_tokens || 0,
        total_cost_usd: estimateTokenCost(summary.total_input_tokens || 0, summary.total_output_tokens || 0),
        avg_response_time_ms: 0,
        success_rate: summary.total_calls > 0 ? Math.round((1 - (summary.total_errors || 0) / summary.total_calls) * 100) : 100,
      },
      daily: [],
      apps,
      models,
    });
  } catch (err: any) {
    console.warn(`[Bridge] Persistent: ${err.message}`);
    res.json({ source: "jsonl", realtime: {}, daily: [], apps: [], models: [], _error: err.message });
  }
});

function estimateTokenCost(inputTokens: number, outputTokens: number): number {
  // Default Sonnet pricing as rough estimate
  return (inputTokens / 1_000_000) * 3.0 + (outputTokens / 1_000_000) * 15.0;
}

// Per-app metrics breakdown (connected frontend apps)
// Bridge has no dedicated /v1/metrics/apps — derive from usage-breakdown instead
router.get("/api/bridge/metrics/apps", async (req: any, res: any) => {
  const hours = req.query.hours || '24';
  try {
    const data: any = await bridgeFetch(`/v1/metrics/usage-breakdown?hours=${hours}`);
    const apps = (data?.apps || []).map((a: any) => ({
      app_id: a.app_id,
      requests: a.calls ?? 0,
      total_requests: a.calls ?? 0,
      tokens: a.total_tokens ?? 0,
      total_tokens: a.total_tokens ?? 0,
      input_tokens: a.input_tokens ?? 0,
      output_tokens: a.output_tokens ?? 0,
      errors: a.errors ?? 0,
      error_rate: a.error_rate ?? 0,
      last_seen: null,
    }));
    res.json({ source: 'usage-breakdown', apps_period: apps, apps_realtime: apps });
  } catch (err: any) {
    console.warn(`[Bridge] Apps: ${err.message}`);
    res.json({ source: 'usage-breakdown', apps_period: [], apps_realtime: [], _error: err.message, _note: 'Bridge endpoint not available' });
  }
});

// Prompt Performance metrics (per app + agent — duration, error rate, tokens)
router.get("/api/bridge/metrics/prompt-performance", async (req: any, res: any) => {
  const hours = req.query.hours || '24';
  try {
    const data = await bridgeFetch(`/v1/metrics/prompt-performance?hours=${hours}`);
    res.json(data);
  } catch (err: any) {
    console.warn(`[Bridge] PromptPerformance: ${err.message}`);
    res.json({ agents: [], summary: { total_calls: 0, total_agents: 0, total_errors: 0, overall_error_rate: 0 }, period_hours: parseInt(hours) || 24, _error: err.message, _note: 'Bridge endpoint not available' });
  }
});

// Prompt Performance timeline (for charts — single agent over time)
router.get("/api/bridge/metrics/prompt-performance/timeline", async (req: any, res: any) => {
  try {
    const { app_id, agent_id, hours = '24', bucket_minutes = '60' } = req.query;
    const data = await bridgeFetch(`/v1/metrics/prompt-performance/timeline?app_id=${encodeURIComponent(app_id)}&agent_id=${encodeURIComponent(agent_id)}&hours=${hours}&bucket_minutes=${bucket_minutes}`);
    res.json(data);
  } catch (err: any) {
    console.warn(`[Bridge] PromptTimeline: ${err.message}`);
    res.json({ timeline: [], _error: err.message });
  }
});


// Persistent Request Log (all HTTP requests, stored on disk)
router.get("/api/bridge/metrics/request-log", async (req: any, res: any) => {
  const hours = req.query.hours || '24';
  const endpoint = req.query.endpoint || '';
  const status = req.query.status || '';
  const limit = req.query.limit || '200';
  try {
    let url = `/v1/metrics/request-log?hours=${hours}&limit=${limit}`;
    if (endpoint) url += `&endpoint=${encodeURIComponent(endpoint)}`;
    if (status) url += `&status=${encodeURIComponent(status)}`;
    const data = await bridgeFetch(url);
    res.json(data);
  } catch (err: any) {
    console.warn(`[Bridge] RequestLog: ${err.message}`);
    res.json({ entries: [], summary: {}, endpoints: {}, _error: err.message });
  }
});

// CC-Usage History (account limit snapshots over time)
router.get("/api/bridge/metrics/cc-usage-history", async (req: any, res: any) => {
  const hours = req.query.hours || '168';
  const limit = req.query.limit || '500';
  try {
    const data = await bridgeFetch(`/v1/metrics/cc-usage-history?hours=${hours}&limit=${limit}`);
    res.json(data);
  } catch (err: any) {
    console.warn(`[Bridge] CCUsageHistory: ${err.message}`);
    res.json({ snapshots: [], _error: err.message });
  }
});

// Queue Forecast (rolling per-worker rates + drain ETA + saturation)
router.get("/api/bridge/metrics/queue-forecast", async (req: any, res: any) => {
  const window = req.query.window || '60';
  try {
    const data = await bridgeFetch(`/v1/metrics/queue-forecast?window=${window}`);
    res.json(data);
  } catch (err: any) {
    console.warn(`[Bridge] QueueForecast: ${err.message}`);
    res.json({ workers: {}, totals: {}, forecast: {}, _error: err.message });
  }
});

// Adaptive limiter snapshots — fans out to all 4 workers (nginx round-robin)
// and aggregates the per-worker `adaptive_limiter` blocks. Each worker
// auto-tunes its own cap because each owns its own Anthropic OAuth account.
router.get("/api/bridge/metrics/limiters", async (_req: any, res: any) => {
  // 8 parallel calls is enough to hit each of 4 workers with high probability.
  const FANOUT = 8;
  try {
    const responses = await Promise.allSettled(
      Array.from({ length: FANOUT }).map(() =>
        bridgeFetch(`/v1/metrics/queue-forecast?window=60`)
      )
    );
    const limiters: Record<string, any> = {};
    let lastNow = 0;
    for (const r of responses) {
      if (r.status !== 'fulfilled') continue;
      const data = r.value as any;
      if (!data) continue;
      lastNow = Math.max(lastNow, data.now || 0);
      const al = data.adaptive_limiter;
      if (al && al.worker && !limiters[al.worker]) {
        limiters[al.worker] = al;
      }
    }
    // Bridge totals
    const caps = Object.values(limiters).map((l: any) => l.cap_tokens || 0);
    const inflights = Object.values(limiters).map((l: any) => l.inflight_tokens || 0);
    const inflightCounts = Object.values(limiters).map((l: any) => l.inflight_count || 0);
    const totals = {
      worker_count: Object.keys(limiters).length,
      cap_tokens: caps.reduce((a, b) => a + b, 0),
      inflight_tokens: inflights.reduce((a, b) => a + b, 0),
      inflight_count: inflightCounts.reduce((a, b) => a + b, 0),
      utilization_pct: 0,
    };
    if (totals.cap_tokens > 0) {
      totals.utilization_pct = Math.round((totals.inflight_tokens * 100) / totals.cap_tokens * 10) / 10;
    }
    res.json({ now: lastNow, limiters, totals, fanout: FANOUT, hits: Object.keys(limiters).length });
  } catch (err: any) {
    console.warn(`[Bridge] Limiters fanout: ${err.message}`);
    res.json({ limiters: {}, totals: {}, _error: err.message });
  }
});

// Usage Projection — time-series view: usage % curve + linear projection + error markers.
// Used by the "Forecast" tab to visually validate prognose vs actual rate-limit events.
router.get("/api/bridge/metrics/usage-projection", async (req: any, res: any) => {
  const days = req.query.days || '7';
  const metric = req.query.metric || 'weeklyAllModels';
  const projectMinutes = req.query.project_minutes || '0';
  try {
    const data = await bridgeFetch(
      `/v1/metrics/usage-projection?days=${days}&metric=${metric}&project_minutes=${projectMinutes}`
    );
    res.json(data);
  } catch (err: any) {
    console.warn(`[Bridge] UsageProjection: ${err.message}`);
    res.json({ workers: {}, totals: {}, _error: err.message });
  }
});

// Throughput — per-worker req/min + tokens/min timeline + empirical rate-limit ceiling.
// Used by the "Forecast" tab to derive a safe bridge throttle setting from observed
// throughput vs error events (instead of trusting Anthropic's quota %).
router.get("/api/bridge/metrics/throughput", async (req: any, res: any) => {
  const hours = req.query.hours || '24';
  const bucketSeconds = req.query.bucket_seconds || '60';
  try {
    const data = await bridgeFetch(
      `/v1/metrics/throughput?hours=${hours}&bucket_seconds=${bucketSeconds}`
    );
    res.json(data);
  } catch (err: any) {
    console.warn(`[Bridge] Throughput: ${err.message}`);
    res.json({ workers: {}, totals: {}, _error: err.message });
  }
});

// CC-Usage Snapshot Save (called after each scrape)
router.post("/api/bridge/metrics/cc-usage-snapshot", async (req: any, res: any) => {
  try {
    const data = await bridgeFetch('/v1/metrics/cc-usage-snapshot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
    });
    res.json(data);
  } catch (err: any) {
    console.warn(`[Bridge] CCUsageSnapshot save: ${err.message}`);
    res.json({ status: "error", _error: err.message });
  }
});

// ── AI-Guard Status ────────────────────────────────────────────────────────
// Local AI-Guard dispatcher — priority queue + concurrency control
router.get('/api/bridge/guard/status', async (_req, res) => {
  try {
    const response = await fetch('http://localhost:8050/status', { signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error(`Guard returned ${response.status}`);
    const data = await response.json();
    res.json({ ...data, running: true });
  } catch (err: any) {
    res.json({ running: false, _error: err.message });
  }
});

// ── Generic Bridge Proxy ────────────────────────────────────────────────────
// Forwards any request from /api/bridge-proxy/* to the Bridge server.
// This allows the frontend to call Bridge API endpoints through the CUI server
// (required when browser can't reach Bridge IP directly, e.g., Mac → Hetzner).
// Bridge platform-routes (Identity/Tenants/Budget/Billing/Activity/Admin-DB).
// These endpoints reject the LLM-routing Bearer token and require either a
// user JWT or the X-Bridge-Service-Token shared secret. CUI is trusted
// infrastructure (server-to-server), so we inject the service token here —
// the browser never sees it.
const PLATFORM_ROUTE_PREFIXES = [
  '/v1/users',
  '/v1/tenants',
  '/v1/app-licenses',
  '/v1/auth',
  '/v1/budget',
  '/v1/billing',
  '/v1/activity',
  '/v1/feedback',
  '/v1/audit',
  '/v1/developer-tokens',
  '/v1/stammdaten',
  '/v1/invoices',
  '/v1/system',
  '/v1/db',
];
const BRIDGE_SERVICE_TOKEN = process.env.BRIDGE_SERVICE_TOKEN || '';

router.use('/api/bridge-proxy', async (req: any, res: any) => {
  const bridgePath = req.path || '/';
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    const url = `${BRIDGE_URL}${bridgePath}${qs}`;
  try {
    const isPlatformRoute = PLATFORM_ROUTE_PREFIXES.some((p) => bridgePath.startsWith(p));
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${BRIDGE_API_KEY}`,
    };
    if (isPlatformRoute && BRIDGE_SERVICE_TOKEN) {
      // Service-token unlocks admin scope on the Bridge platform routes.
      // We still send Authorization Bearer so the LLM-routing path keeps
      // working for /v1/chat/* — the Bridge ignores Authorization on the
      // platform routes when X-Bridge-Service-Token is present.
      headers['X-Bridge-Service-Token'] = BRIDGE_SERVICE_TOKEN;
    }
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

// ============================================================================
// Error Feed — reads from rsync'd nginx access.jsonl on local disk.
// Independent of Bridge availability: panel works even when Bridge is down.
// Logs live at /root/projekte/local-storage/bridge-logs/{dev,prod}/nginx/
// ============================================================================
const BRIDGE_LOGS_DIR = '/root/projekte/local-storage/bridge-logs';

interface NginxLogEntry {
  ts: string;
  ts_epoch: number;
  remote: string;
  method: string;
  uri: string;
  status: number;
  bytes: number;
  req_time: number;
  upstream_addr: string;
  upstream_status: string;
  upstream_resp_time: string;
  upstream_conn_time: string;
  pool: string;
  priority: string;
  user_agent: string;
  app_id: string;
  user_id: string;
  workflow_id: string;
  job_id: string;
  agent_id: string;
  _source: 'dev' | 'prod';
}

function readLastLines(path: string, maxBytes: number): string[] {
  if (!existsSync(path)) return [];
  const stat = statSync(path);
  const start = Math.max(0, stat.size - maxBytes);
  const buf = Buffer.alloc(stat.size - start);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buf, 0, buf.length, start);
  } finally {
    closeSync(fd);
  }
  const text = buf.toString('utf-8');
  const lines = text.split('\n');
  if (start > 0) lines.shift();
  return lines.filter(Boolean);
}

// Scale the JSONL read-buffer to the requested time window.
// Primary emits ~3-5 MB/hour of nginx JSONL at peak — 10 MB/hour gives headroom.
// Floor keeps short windows usable; cap prevents reading absurd amounts.
function bytesForHours(hours: number): number {
  const perHour = 10 * 1024 * 1024;
  const minBytes = 20 * 1024 * 1024;
  const maxBytes = 500 * 1024 * 1024;
  return Math.min(maxBytes, Math.max(minBytes, Math.ceil(hours * perHour)));
}

router.get('/api/bridge/errors', async (req: any, res: any) => {
  try {
    const hours = parseFloat(req.query.hours || '24');
    const minStatus = parseInt(req.query.min_status || '400', 10);
    const limit = Math.min(parseInt(req.query.limit || '200', 10), 2000);
    const endpoint = (req.query.endpoint || '').toLowerCase();
    const app = (req.query.app || '').toLowerCase();
    const bridgeFilter = (req.query.bridge || 'all').toLowerCase() as 'all' | 'dev' | 'prod';
    // Read buffer sized to the requested window — ~10 MB/hour with 20 MB floor / 500 MB cap.
    const READ_BYTES = bytesForHours(hours);
    const cutoff = Date.now() / 1000 - hours * 3600;

    const allSources: Array<{ label: 'dev' | 'prod'; path: string }> = [
      { label: 'dev',  path: join(BRIDGE_LOGS_DIR, 'dev',  'nginx', 'access.jsonl') },
      { label: 'prod', path: join(BRIDGE_LOGS_DIR, 'prod', 'nginx', 'access.jsonl') },
    ];
    const sources = bridgeFilter === 'all'
      ? allSources
      : allSources.filter(s => s.label === bridgeFilter);

    const entries: NginxLogEntry[] = [];
    const sourceStats: Record<string, { present: boolean; mtime: number | null; bytes: number }> = {};

    for (const src of sources) {
      if (!existsSync(src.path)) {
        sourceStats[src.label] = { present: false, mtime: null, bytes: 0 };
        continue;
      }
      const s = statSync(src.path);
      sourceStats[src.label] = { present: true, mtime: s.mtimeMs, bytes: s.size };
      const lines = readLastLines(src.path, READ_BYTES);
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj.ts_epoch < cutoff) continue;
          if (obj.status < minStatus) continue;
          if (endpoint && !String(obj.uri || '').toLowerCase().includes(endpoint)) continue;
          if (app && String(obj.app_id || '').toLowerCase() !== app) continue;
          obj._source = src.label;
          entries.push(obj);
        } catch {
          // skip malformed line
        }
      }
    }

    entries.sort((a, b) => b.ts_epoch - a.ts_epoch);
    const trimmed = entries.slice(0, limit);

    // Aggregate summary
    const byStatus: Record<string, number> = {};
    const byEndpoint: Record<string, number> = {};
    const byApp: Record<string, number> = {};
    const byUpstream: Record<string, number> = {};
    for (const e of entries) {
      byStatus[String(e.status)] = (byStatus[String(e.status)] ?? 0) + 1;
      const ep = String(e.uri || '').split('?')[0];
      byEndpoint[ep] = (byEndpoint[ep] ?? 0) + 1;
      if (e.app_id) byApp[e.app_id] = (byApp[e.app_id] ?? 0) + 1;
      if (e.upstream_addr) byUpstream[e.upstream_addr] = (byUpstream[e.upstream_addr] ?? 0) + 1;
    }

    res.json({
      entries: trimmed,
      total_matched: entries.length,
      returned: trimmed.length,
      summary: { byStatus, byEndpoint, byApp, byUpstream },
      sources: sourceStats,
      query: { hours, minStatus, limit, endpoint, app, bridge: bridgeFilter },
    });
  } catch (err: any) {
    console.warn(`[Bridge] Errors: ${err.message}`);
    res.status(500).json({ entries: [], _error: err.message });
  }
});

// ============================================================================
// Events Feed — Pool summaries, failover stats, incidents for Status tab
// ============================================================================
// An "incident" = >=3 errors on same endpoint within 60s (grouped).
// A "rescued" request = multi-upstream with final status 2xx (failover worked).
// A "lost" request = final status 5xx (failover failed or none attempted).
// ============================================================================

// ── Worker Health — Autobahn-Prinzip ────────────────────────────────────────
// Per-worker health via /v1/metrics/queue-forecast fanout (nginx round-robin
// distributes across workers). Worker missing from fanout results = down.
// Queue > 85% cap = degraded even if Anthropic quota is green ("Auffahrt
// blockiert obwohl Spuren frei").
//
// 5xx per worker: upstream_addr in nginx logs uses Docker container names
// (e.g. "worker1:8000") — strip port to get worker name.

export interface WorkerHealth {
  name: string;                        // worker1..4
  status: 'healthy' | 'degraded' | 'down';
  inflight_tokens: number | null;
  cap_tokens: number | null;
  inflight_count: number | null;
  queue_pct: number | null;            // inflight_tokens / cap_tokens × 100
  errors_5min: number;                 // 5xx on this worker's upstream in last 5 min
  cooldown_remaining_s: number | null; // from account-pool-state
}

const EXPECTED_WORKERS = ['worker1', 'worker2', 'worker3', 'worker4'];

// Pure function — easy to test, no network calls.
export function countUpstreamErrors(
  entries: NginxLogEntry[],
  windowSec: number = 300,
  nowSec: number = Date.now() / 1000
): Record<string, number> {
  const cutoff = nowSec - windowSec;
  const errors: Record<string, number> = {};
  for (const e of entries) {
    if (e.ts_epoch < cutoff) continue;
    const addrs = String(e.upstream_addr || '').split(',').map(s => s.trim()).filter(Boolean);
    const statuses = String(e.upstream_status || '').split(',').map(s => s.trim());
    addrs.forEach((addr, i) => {
      if (parseInt(statuses[i] || '0', 10) >= 500) {
        // "worker1:8000" → "worker1"
        const name = addr.includes(':') ? addr.split(':')[0] : addr;
        errors[name] = (errors[name] ?? 0) + 1;
      }
    });
  }
  return errors;
}

// Pure function — easy to test, no network calls.
export function deriveWorkerStatus(
  limiterPresent: boolean,
  queuePct: number | null,
  errors5min: number
): WorkerHealth['status'] {
  if (!limiterPresent) return 'down';
  if ((queuePct !== null && queuePct > 85) || errors5min > 5) return 'degraded';
  return 'healthy';
}

// Fans out 12 requests to /v1/metrics/queue-forecast through the nginx LB.
// With 4 workers and fair round-robin, each worker gets ~3 calls.
// Returns map of worker name → adaptive_limiter data.
async function workerFanout(): Promise<Record<string, any>> {
  const FANOUT = 12;
  const responses = await Promise.allSettled(
    Array.from({ length: FANOUT }).map(() =>
      bridgeFetch('/v1/metrics/queue-forecast?window=60')
    )
  );
  const limiters: Record<string, any> = {};
  for (const r of responses) {
    if (r.status !== 'fulfilled') continue;
    const al = r.value?.adaptive_limiter;
    if (al?.worker && !limiters[al.worker]) limiters[al.worker] = al;
  }
  return limiters;
}

// Builds worker health array. Pure given the inputs.
export function buildWorkerHealth(
  limiters: Record<string, any>,
  poolState: any | null,
  allEntries: NginxLogEntry[]
): { workers: WorkerHealth[]; has_any_down: boolean; has_any_degraded: boolean } {
  const upstreamErrors = countUpstreamErrors(allEntries);

  // account-pool-state accounts sorted by key: account1, account2, … → worker1, worker2, …
  const accountEntries: Array<[string, any]> = poolState?.accounts
    ? Object.entries(poolState.accounts).sort(([a], [b]) => a.localeCompare(b))
    : [];

  let has_any_down = false;
  let has_any_degraded = false;

  const workers: WorkerHealth[] = EXPECTED_WORKERS.map((name, idx) => {
    const limiter = limiters[name];
    const isPresent = name in limiters;
    const accountData = accountEntries[idx]?.[1] as { cooldown_remaining_s?: number } | undefined;

    const inflight = limiter?.inflight_tokens ?? null;
    const cap = limiter?.cap_tokens ?? null;
    const queuePct = (inflight !== null && cap !== null && cap > 0)
      ? Math.round((inflight / cap) * 1000) / 10
      : null;

    const errors5min = upstreamErrors[name] ?? 0;
    const status = deriveWorkerStatus(isPresent, queuePct, errors5min);

    if (status === 'down') has_any_down = true;
    if (status === 'degraded') has_any_degraded = true;

    return {
      name,
      status,
      inflight_tokens: inflight,
      cap_tokens: cap,
      inflight_count: limiter?.inflight_count ?? null,
      queue_pct: queuePct,
      errors_5min: errors5min,
      cooldown_remaining_s: accountData?.cooldown_remaining_s ?? null,
    };
  });

  return { workers, has_any_down, has_any_degraded };
}

// Caller classification — Rafael-Prinzip 2026-04-29:
// "Wenn jemand auf die Autobahn nicht auffahren kann, ist es ein Ausfall."
// Failures count as failures regardless of caller_kind. caller_kind is
// metadata for drill-down only, NEVER a filter.
type CallerKind =
  | 'production_user'  // App users (app_id ∈ {engelmann, werking-*, acro-*, …})
  | 'workflow'         // Backend workflow runs (Energy, Safety, bridge-research)
  | 'platform'         // dev-server / CUI internal (BusinessAngel, Classifier, …)
  | 'test'             // unified-tester
  | 'monitoring';      // synthetic /health probes, no workload

const PRODUCTION_USER_APP_IDS = new Set([
  'engelmann', 'werking-report', 'werking-energy', 'werking-safety',
  'werking-noise', 'acro-community', 'platform-app',
]);
const WORKFLOW_APP_IDS = new Set([
  'workflow', 'workflow-engine', 'energy-workflow', 'safety-workflow',
  'bridge-research', 'workflows',
]);
const PLATFORM_APP_IDS = new Set([
  'cui', 'business-angel', 'peer-awareness', 'classifier', 'dev-server',
]);

export function classifyCaller(e: NginxLogEntry): CallerKind {
  const app = (e.app_id || '').trim().toLowerCase();
  const ua = (e.user_agent || '').toLowerCase();
  const uri = (e.uri || '').toLowerCase();

  // Synthetic health probes carry no workload — only these are "monitoring".
  if (uri === '/health' || uri === '/lb-status' || uri.startsWith('/v1/metrics')) {
    return 'monitoring';
  }
  if (app === 'unified-tester' || ua.includes('unified-tester')) return 'test';
  if (PRODUCTION_USER_APP_IDS.has(app)) return 'production_user';
  if (WORKFLOW_APP_IDS.has(app) || ua.includes('workflow')) return 'workflow';
  if (PLATFORM_APP_IDS.has(app) || ua.includes('cui') || ua.includes('claude-cli')) {
    return 'platform';
  }
  // No app_id and not a known probe path: still real workload — treat as platform
  // (an actual call that hit nginx, just unlabelled). NOT 'monitoring'.
  if (!app) return 'platform';
  return 'platform';
}

interface PoolSummary {
  requests: number;
  errors: number;          // all 4xx+5xx combined (legacy)
  client_errors: number;   // 4xx — not an infra problem
  server_errors: number;   // 5xx — infra problem
  error_rate: number;      // 4xx+5xx / total (%)
  server_error_rate: number; // 5xx / total (%)
  p50_ms: number;
  p95_ms: number;
  avg_ms: number;
  rescued: number;         // 5xx rescued by failover (success for customer)
  lost: number;            // total 5xx delivered — every caller_kind counted
  lost_by_caller: Record<CallerKind, number>;  // drill-down per caller, sums to `lost`
  /** @deprecated use `lost` (= total) and `lost_by_caller` */
  lost_user: number;
  /** @deprecated use `lost_by_caller.monitoring` */
  lost_monitoring: number;
  retry_count: number;
  present: boolean;
}

// Legacy classifier — kept only because two other tabs still read these fields.
// New code MUST use classifyCaller() and `lost_by_caller`.
const MONITORING_APP_IDS = new Set(['cui', 'unified-tester']);
function isMonitoringEntry(e: NginxLogEntry): boolean {
  const app = (e.app_id || '').trim().toLowerCase();
  if (!app) return true;
  return MONITORING_APP_IDS.has(app);
}

interface Incident {
  id: string;
  source: 'dev' | 'prod';
  endpoint: string;
  start_ts: number;
  end_ts: number;
  count: number;
  status_codes: Record<string, number>;
  apps: Record<string, number>;
  sample_user_agents: string[];
  last_msg: string;
  resolved: boolean;
  rescued_via_failover: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

function emptyLostByCaller(): Record<CallerKind, number> {
  return { production_user: 0, workflow: 0, platform: 0, test: 0, monitoring: 0 };
}

export function summarizePool(entries: NginxLogEntry[]): PoolSummary {
  if (entries.length === 0) {
    return {
      requests: 0, errors: 0, client_errors: 0, server_errors: 0,
      error_rate: 0, server_error_rate: 0,
      p50_ms: 0, p95_ms: 0, avg_ms: 0,
      rescued: 0, lost: 0, lost_by_caller: emptyLostByCaller(),
      lost_user: 0, lost_monitoring: 0,
      retry_count: 0, present: false,
    };
  }
  let errors = 0, clientErrors = 0, serverErrors = 0;
  let rescued = 0, lost = 0;
  const lostByCaller = emptyLostByCaller();
  let retries = 0, totalMs = 0;
  const durations: number[] = [];
  for (const e of entries) {
    if (e.status >= 400) {
      errors++;
      if (e.status >= 500) serverErrors++;
      else clientErrors++;
    }
    const hasMultiUpstream = typeof e.upstream_addr === 'string' && e.upstream_addr.includes(',');
    let wasLost = false;
    if (hasMultiUpstream) {
      const statuses = String(e.upstream_status || '').split(',').map(s => s.trim());
      retries += Math.max(0, statuses.length - 1);
      const finalStatus = parseInt(statuses[statuses.length - 1] || '0', 10);
      const earlierFailure = statuses.slice(0, -1).some(s => parseInt(s, 10) >= 500);
      if (earlierFailure && finalStatus >= 200 && finalStatus < 400) rescued++;
      else if (finalStatus >= 500) { lost++; wasLost = true; }
    } else if (e.status >= 500) {
      lost++;
      wasLost = true;
    }
    if (wasLost) {
      lostByCaller[classifyCaller(e)]++;
    }
    const ms = Math.max(0, (e.req_time || 0) * 1000);
    durations.push(ms);
    totalMs += ms;
  }
  durations.sort((a, b) => a - b);
  // Deprecated legacy fields — derived from new classifier so callers stay consistent.
  const lostUser = lostByCaller.production_user + lostByCaller.workflow + lostByCaller.platform;
  const lostMonitoring = lostByCaller.monitoring + lostByCaller.test;
  return {
    requests: entries.length,
    errors,
    client_errors: clientErrors,
    server_errors: serverErrors,
    error_rate: (errors / entries.length) * 100,
    server_error_rate: (serverErrors / entries.length) * 100,
    p50_ms: percentile(durations, 0.5),
    p95_ms: percentile(durations, 0.95),
    avg_ms: totalMs / entries.length,
    rescued,
    lost,
    lost_by_caller: lostByCaller,
    lost_user: lostUser,
    lost_monitoring: lostMonitoring,
    retry_count: retries,
    present: true,
  };
}

function clusterIncidents(errors: NginxLogEntry[]): Incident[] {
  // Group by endpoint + source. Within group, split into incidents when gap > 60s.
  const GAP_SEC = 60;
  const MIN_COUNT = 3;
  const groups: Record<string, NginxLogEntry[]> = {};
  for (const e of errors) {
    const endpoint = String(e.uri || '').split('?')[0];
    const key = `${e._source}::${endpoint}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(e);
  }
  const incidents: Incident[] = [];
  for (const [key, arr] of Object.entries(groups)) {
    arr.sort((a, b) => a.ts_epoch - b.ts_epoch);
    let bucket: NginxLogEntry[] = [];
    const flush = () => {
      if (bucket.length < MIN_COUNT) { bucket = []; return; }
      const first = bucket[0];
      const last = bucket[bucket.length - 1];
      const statusCodes: Record<string, number> = {};
      const apps: Record<string, number> = {};
      const userAgents = new Set<string>();
      let rescuedInBucket = 0;
      for (const e of bucket) {
        statusCodes[String(e.status)] = (statusCodes[String(e.status)] ?? 0) + 1;
        if (e.app_id) apps[e.app_id] = (apps[e.app_id] ?? 0) + 1;
        if (e.user_agent) userAgents.add(String(e.user_agent).slice(0, 40));
        const hasMulti = typeof e.upstream_addr === 'string' && e.upstream_addr.includes(',');
        if (hasMulti) {
          const statuses = String(e.upstream_status || '').split(',').map(s => s.trim());
          const finalStatus = parseInt(statuses[statuses.length - 1] || '0', 10);
          if (finalStatus >= 200 && finalStatus < 400) rescuedInBucket++;
        }
      }
      const nowEpoch = Date.now() / 1000;
      incidents.push({
        id: `${key}::${Math.floor(first.ts_epoch)}`,
        source: first._source,
        endpoint: key.split('::')[1],
        start_ts: first.ts_epoch,
        end_ts: last.ts_epoch,
        count: bucket.length,
        status_codes: statusCodes,
        apps,
        sample_user_agents: Array.from(userAgents).slice(0, 3),
        last_msg: `${bucket.length} errors · ${Object.keys(statusCodes).join('/')} · ${Object.keys(apps).slice(0, 2).join(', ')}`,
        resolved: (nowEpoch - last.ts_epoch) > 120,
        rescued_via_failover: rescuedInBucket,
      });
      bucket = [];
    };
    for (const e of arr) {
      if (bucket.length === 0) { bucket.push(e); continue; }
      const prev = bucket[bucket.length - 1];
      if (e.ts_epoch - prev.ts_epoch > GAP_SEC) flush();
      bucket.push(e);
    }
    flush();
  }
  incidents.sort((a, b) => b.end_ts - a.end_ts);
  return incidents;
}

// ============================================================================
// Stability Ledger — hourly availability snapshots, persists across restarts.
// Customer-impact metric: "lost" requests (5xx that weren't rescued).
// Uptime = minutes in hour with ZERO lost requests / total minutes with traffic.
// ============================================================================

const STABILITY_DIR = '/root/projekte/local-storage/bridge-stability';
const STABILITY_LEDGER = join(STABILITY_DIR, 'hourly.jsonl');

interface HourSnapshot {
  hour: string;             // ISO 2026-04-22T13:00:00Z
  hour_epoch: number;       // seconds since epoch, floor to hour
  dev: { requests: number; errors: number; server_errors: number; lost: number; outage_minutes: number };
  prod: { requests: number; errors: number; server_errors: number; lost: number; outage_minutes: number };
  generated_at: string;
}

function bucketEntriesByMinute(entries: NginxLogEntry[]): Map<number, { req: number; lost: number }> {
  const map = new Map<number, { req: number; lost: number }>();
  for (const e of entries) {
    const minute = Math.floor(e.ts_epoch / 60) * 60;
    let cell = map.get(minute);
    if (!cell) { cell = { req: 0, lost: 0 }; map.set(minute, cell); }
    cell.req++;
    const hasMulti = typeof e.upstream_addr === 'string' && e.upstream_addr.includes(',');
    if (hasMulti) {
      const statuses = String(e.upstream_status || '').split(',').map(s => s.trim());
      const finalStatus = parseInt(statuses[statuses.length - 1] || '0', 10);
      if (finalStatus >= 500) cell.lost++;
    } else if (e.status >= 500) {
      cell.lost++;
    }
  }
  return map;
}

function buildPoolSnapshot(entries: NginxLogEntry[]): HourSnapshot['dev'] {
  const summary = summarizePool(entries);
  const byMinute = bucketEntriesByMinute(entries);
  let outageMinutes = 0;
  for (const cell of byMinute.values()) {
    if (cell.lost > 0) outageMinutes++;
  }
  return {
    requests: summary.requests,
    errors: summary.errors,
    server_errors: summary.server_errors,
    lost: summary.lost,
    outage_minutes: outageMinutes,
  };
}

function readLedger(): HourSnapshot[] {
  if (!existsSync(STABILITY_LEDGER)) return [];
  try {
    const raw = readFileSync(STABILITY_LEDGER, 'utf-8');
    const snapshots: HourSnapshot[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { snapshots.push(JSON.parse(line)); } catch { /* skip */ }
    }
    return snapshots.sort((a, b) => a.hour_epoch - b.hour_epoch);
  } catch {
    return [];
  }
}

// The ledger is written by a dedicated cron:
//   /root/projekte/orchestrator/bin/bridge-stability-snapshot.py (*/15 min)
// This server ONLY reads from the ledger (single-writer architecture) and
// supplements with live-computed current-hour data for freshness.

router.get('/api/bridge/stability', async (_req: any, res: any) => {
  try {
    const ledger = readLedger();
    const now = Date.now() / 1000;

    // Also compute current (in-progress) hour from live JSONL
    const currentHourStart = Math.floor(now / 3600) * 3600;
    const sources: Array<{ label: 'dev' | 'prod'; path: string }> = [
      { label: 'dev',  path: join(BRIDGE_LOGS_DIR, 'dev',  'nginx', 'access.jsonl') },
      { label: 'prod', path: join(BRIDGE_LOGS_DIR, 'prod', 'nginx', 'access.jsonl') },
    ];
    const liveByPool: Record<'dev' | 'prod', NginxLogEntry[]> = { dev: [], prod: [] };
    for (const src of sources) {
      if (!existsSync(src.path)) continue;
      const lines = readLastLines(src.path, 20 * 1024 * 1024);
      for (const line of lines) {
        try {
          const obj: NginxLogEntry = JSON.parse(line);
          if (obj.ts_epoch < currentHourStart) continue;
          liveByPool[src.label].push(obj);
        } catch { /* skip */ }
      }
    }
    const currentHour: HourSnapshot = {
      hour: new Date(currentHourStart * 1000).toISOString(),
      hour_epoch: currentHourStart,
      dev: buildPoolSnapshot(liveByPool.dev),
      prod: buildPoolSnapshot(liveByPool.prod),
      generated_at: new Date().toISOString(),
    };

    const allHours = [...ledger.filter(h => h.hour_epoch !== currentHourStart), currentHour];

    // Aggregate over windows
    function aggregate(hours: HourSnapshot[]) {
      const dev = { requests: 0, errors: 0, server_errors: 0, lost: 0, outage_minutes: 0 };
      const prod = { requests: 0, errors: 0, server_errors: 0, lost: 0, outage_minutes: 0 };
      for (const h of hours) {
        dev.requests += h.dev.requests; dev.errors += h.dev.errors;
        dev.server_errors += h.dev.server_errors; dev.lost += h.dev.lost;
        dev.outage_minutes += h.dev.outage_minutes;
        prod.requests += h.prod.requests; prod.errors += h.prod.errors;
        prod.server_errors += h.prod.server_errors; prod.lost += h.prod.lost;
        prod.outage_minutes += h.prod.outage_minutes;
      }
      return { dev, prod, hours_covered: hours.length };
    }

    // Uptime = (total_minutes - outage_minutes) / total_minutes, only counting hours with traffic
    function uptimePct(aggregated: { requests: number; outage_minutes: number }, hoursCovered: number): number | null {
      if (hoursCovered === 0 || aggregated.requests === 0) return null;
      const totalMinutes = hoursCovered * 60;
      return Math.max(0, Math.min(100, ((totalMinutes - aggregated.outage_minutes) / totalMinutes) * 100));
    }

    const nowHour = Math.floor(now / 3600);
    const windows = {
      '24h': allHours.filter(h => (nowHour - Math.floor(h.hour_epoch / 3600)) < 24),
      '7d':  allHours.filter(h => (nowHour - Math.floor(h.hour_epoch / 3600)) < 24 * 7),
      '30d': allHours.filter(h => (nowHour - Math.floor(h.hour_epoch / 3600)) < 24 * 30),
    };
    const agg24h = aggregate(windows['24h']);
    const agg7d  = aggregate(windows['7d']);
    const agg30d = aggregate(windows['30d']);

    // Time since last Prod outage (last hour snapshot with prod.lost > 0)
    let lastProdOutage: { hour: string; lost: number } | null = null;
    for (let i = allHours.length - 1; i >= 0; i--) {
      if (allHours[i].prod.lost > 0) {
        lastProdOutage = { hour: allHours[i].hour, lost: allHours[i].prod.lost };
        break;
      }
    }
    const timeSinceProdOutageSec = lastProdOutage
      ? Math.floor(now - new Date(lastProdOutage.hour).getTime() / 1000)
      : null;

    // Tracking window
    const firstHour = allHours.length > 0 ? allHours[0].hour : null;
    const trackingSec = firstHour ? Math.floor(now - new Date(firstHour).getTime() / 1000) : 0;

    // Last 30 days daily aggregation (for sparkline/heatmap)
    const daily: Array<{ day: string; dev_requests: number; dev_lost: number; prod_requests: number; prod_lost: number; prod_uptime_pct: number | null }> = [];
    const byDay = new Map<string, HourSnapshot[]>();
    for (const h of windows['30d']) {
      const day = h.hour.slice(0, 10);
      let list = byDay.get(day);
      if (!list) { list = []; byDay.set(day, list); }
      list.push(h);
    }
    for (const [day, hours] of Array.from(byDay.entries()).sort()) {
      const agg = aggregate(hours);
      daily.push({
        day,
        dev_requests: agg.dev.requests,
        dev_lost: agg.dev.lost,
        prod_requests: agg.prod.requests,
        prod_lost: agg.prod.lost,
        prod_uptime_pct: uptimePct(agg.prod, hours.length),
      });
    }

    res.json({
      tracking_since: firstHour,
      tracking_duration_sec: trackingSec,
      last_prod_outage: lastProdOutage,
      time_since_prod_outage_sec: timeSinceProdOutageSec,
      windows: {
        '24h': {
          uptime_prod_pct: uptimePct(agg24h.prod, agg24h.hours_covered),
          uptime_dev_pct:  uptimePct(agg24h.dev,  agg24h.hours_covered),
          dev: agg24h.dev, prod: agg24h.prod, hours_covered: agg24h.hours_covered,
        },
        '7d': {
          uptime_prod_pct: uptimePct(agg7d.prod, agg7d.hours_covered),
          uptime_dev_pct:  uptimePct(agg7d.dev,  agg7d.hours_covered),
          dev: agg7d.dev, prod: agg7d.prod, hours_covered: agg7d.hours_covered,
        },
        '30d': {
          uptime_prod_pct: uptimePct(agg30d.prod, agg30d.hours_covered),
          uptime_dev_pct:  uptimePct(agg30d.dev,  agg30d.hours_covered),
          dev: agg30d.dev, prod: agg30d.prod, hours_covered: agg30d.hours_covered,
        },
      },
      daily,
      generated_at: new Date().toISOString(),
    });
  } catch (err: any) {
    console.warn(`[Bridge] Stability: ${err.message}`);
    res.status(500).json({ _error: err.message });
  }
});

router.get('/api/bridge/events', async (req: any, res: any) => {
  try {
    const hours = parseFloat(req.query.hours || '1');
    const READ_BYTES = bytesForHours(hours);
    const cutoff = Date.now() / 1000 - hours * 3600;

    const sources: Array<{ label: 'dev' | 'prod'; path: string }> = [
      { label: 'dev',  path: join(BRIDGE_LOGS_DIR, 'dev',  'nginx', 'access.jsonl') },
      { label: 'prod', path: join(BRIDGE_LOGS_DIR, 'prod', 'nginx', 'access.jsonl') },
    ];

    const byPool: Record<'dev' | 'prod', NginxLogEntry[]> = { dev: [], prod: [] };
    const sourceStats: Record<string, { present: boolean; mtime: number | null; bytes: number; age_sec: number | null }> = {};

    for (const src of sources) {
      if (!existsSync(src.path)) {
        sourceStats[src.label] = { present: false, mtime: null, bytes: 0, age_sec: null };
        continue;
      }
      const s = statSync(src.path);
      const age = (Date.now() - s.mtimeMs) / 1000;
      sourceStats[src.label] = { present: true, mtime: s.mtimeMs, bytes: s.size, age_sec: age };
      const lines = readLastLines(src.path, READ_BYTES);
      for (const line of lines) {
        try {
          const obj: NginxLogEntry = JSON.parse(line);
          if (obj.ts_epoch < cutoff) continue;
          obj._source = src.label;
          byPool[src.label].push(obj);
        } catch {
          // skip malformed line
        }
      }
    }

    const pools = {
      dev: summarizePool(byPool.dev),
      prod: summarizePool(byPool.prod),
    };

    const errors = [...byPool.dev, ...byPool.prod].filter(e => e.status >= 400);
    const incidents = clusterIncidents(errors);

    const failover = {
      dev_rescued: pools.dev.rescued,
      dev_lost: pools.dev.lost,
      prod_rescued: pools.prod.rescued,
      prod_lost: pools.prod.lost,
      total_retries: pools.dev.retry_count + pools.prod.retry_count,
      total_rescued: pools.dev.rescued + pools.prod.rescued,
      total_lost: pools.dev.lost + pools.prod.lost,
      success_rate: (pools.dev.rescued + pools.prod.rescued + pools.dev.lost + pools.prod.lost) > 0
        ? ((pools.dev.rescued + pools.prod.rescued) /
           (pools.dev.rescued + pools.prod.rescued + pools.dev.lost + pools.prod.lost)) * 100
        : 100,
    };

    const activeIncidents = incidents.filter(i => !i.resolved);

    // Worker-pool exhaustion + per-worker health — both fetch from Bridge concurrently.
    let poolExhaustion: { detected: boolean; cooldown_workers: number; total_workers: number } = {
      detected: false, cooldown_workers: 0, total_workers: 0,
    };
    let workerResult: ReturnType<typeof buildWorkerHealth> = {
      workers: [], has_any_down: false, has_any_degraded: false,
    };
    try {
      const [poolState, limiters] = await Promise.all([
        bridgeFetch('/v1/metrics/account-pool-state').catch(() => null),
        workerFanout().catch(() => ({} as Record<string, any>)),
      ]);
      const accounts = (poolState && typeof poolState === 'object' && poolState.accounts) || {};
      const accountList = Object.values(accounts) as Array<{ available?: boolean; cooldown_remaining_s?: number }>;
      if (accountList.length > 0) {
        const inCooldown = accountList.filter(a => a.available === false || (a.cooldown_remaining_s ?? 0) > 0).length;
        poolExhaustion = {
          detected: inCooldown > 0 && inCooldown === accountList.length,
          cooldown_workers: inCooldown,
          total_workers: accountList.length,
        };
      }
      // All nginx entries for the 5-min upstream-error window
      const allEntries = [...byPool.dev, ...byPool.prod];
      workerResult = buildWorkerHealth(limiters, poolState, allEntries);
    } catch { /* metrics-reader unreachable — leave defaults */ }

    // Rafael-Prinzip 2026-04-29: jeder 5xx ist ein Failure. KEIN Filter nach caller_kind.
    // Status ladder:
    //   critical : ANY lost on Prod, OR all workers in cooldown, OR any worker DOWN
    //   degraded : ANY lost on Dev, high 5xx rate, partial cooldown, workers DEGRADED,
    //              or pool quota green but workers sick ("Auffahrt blockiert")
    //   healthy  : zero lost, all workers healthy
    const prodActiveLost = activeIncidents
      .filter(i => i.source === 'prod')
      .some(i => (i.count - (i.rescued_via_failover || 0)) > 0);
    const devActiveLost = activeIncidents
      .filter(i => i.source === 'dev')
      .some(i => (i.count - (i.rescued_via_failover || 0)) > 0);
    const someWorkerInCooldown =
      poolExhaustion.cooldown_workers > 0 &&
      poolExhaustion.cooldown_workers < poolExhaustion.total_workers;
    const overall_status: 'healthy' | 'degraded' | 'critical' =
      (pools.prod.lost > 0 || prodActiveLost || poolExhaustion.detected || workerResult.has_any_down) ? 'critical' :
      (pools.dev.lost > 0 || devActiveLost ||
       pools.prod.server_error_rate >= 0.5 || someWorkerInCooldown ||
       !pools.dev.present || workerResult.has_any_degraded) ? 'degraded' :
      'healthy';

    // "Auffahrt blockiert": pool quota is NOT exhausted, but workers are sick.
    // This is the key lie the old monitor told: grüne Bars, kaputte Auffahrten.
    const auffahrt_blocked =
      !poolExhaustion.detected &&
      (workerResult.has_any_down || workerResult.has_any_degraded);

    res.json({
      overall_status,
      pools,
      failover,
      incidents: incidents.slice(0, 50),
      active_incidents: activeIncidents.length,
      pool_exhaustion: poolExhaustion,
      workers: workerResult.workers,
      auffahrt_blocked,
      window_hours: hours,
      sources: sourceStats,
      generated_at: new Date().toISOString(),
    });
  } catch (err: any) {
    console.warn(`[Bridge] Events: ${err.message}`);
    res.status(500).json({ _error: err.message });
  }
});

// --- Account Identity Health (Drift Detection) ---
// Source of truth: /home/claude-user/.claude/accounts/registry.json (CUI_CLAUDE_USER_HOME override).
// /tmp/account-drift.flag (written by scripts/verify-accounts.sh): present == drift detected.
router.get('/api/accounts/health', (_req, res) => {
  try {
    const claudeUserHome = process.env.CUI_CLAUDE_USER_HOME || '/home/claude-user';
    const registryPath = `${claudeUserHome}/.claude/accounts/registry.json`;
    if (!existsSync(registryPath)) {
      return res.status(500).json({ error: `Account registry not found at ${registryPath}` });
    }

    const registry = JSON.parse(readFileSync(registryPath, 'utf-8')) as {
      accounts: Array<{ id: string; display_name: string; color: string; anthropic_org_id: string }>;
    };
    if (!Array.isArray(registry.accounts) || registry.accounts.length === 0) {
      return res.status(500).json({ error: 'Registry has no accounts array' });
    }

    interface DriftResult {
      id: string;
      expected_org_id: string;
      token_org_id: string;
      cookie_org_id: string;
      token_match: boolean;
      cookie_match: boolean;
      status: string;
    }
    interface DriftPayload {
      timestamp?: string;
      drifts?: string[];
      results?: DriftResult[];
    }
    const DRIFT_FLAG = '/tmp/account-drift.flag';
    let driftPayload: DriftPayload | null = null;
    if (existsSync(DRIFT_FLAG)) {
      try { driftPayload = JSON.parse(readFileSync(DRIFT_FLAG, 'utf-8')); }
      catch { driftPayload = null; }
    }

    // Pick newest log path (verify-accounts.sh writes either /var/log or /tmp).
    let lastCheck: string | null = null;
    const candidates = ['/var/log/account-verify.log', '/tmp/account-verify.log'].filter(existsSync);
    if (candidates.length > 0) {
      const logPath = candidates
        .map(p => ({ p, mtime: statSync(p).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)[0].p;
      try {
        const content = readFileSync(logPath, 'utf-8');
        const lines = content.trim().split('\n').filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i--) {
          const m = lines[i].match(/^\[([\d\- :]+)\]/);
          if (m) { lastCheck = m[1]; break; }
        }
      } catch { /* silent — log read is best-effort */ }
    }

    const driftById: Record<string, DriftResult> = {};
    if (driftPayload?.results) {
      for (const r of driftPayload.results) driftById[r.id] = r;
    }

    const accounts = registry.accounts.map(a => {
      const r = driftById[a.id];
      let status: 'ok' | 'drift' | 'unknown' = 'unknown';
      let tokenOrgId = '';
      let cookieOrgId = '';
      if (r) {
        status = r.status === 'DRIFT' ? 'drift' : 'ok';
        tokenOrgId = r.token_org_id || '';
        cookieOrgId = r.cookie_org_id || '';
      } else if (!driftPayload) {
        status = 'ok';
      }
      return {
        id: a.id,
        display_name: a.display_name,
        color: a.color,
        status,
        expected_org_id: a.anthropic_org_id,
        token_org_id: tokenOrgId,
        cookie_org_id: cookieOrgId,
      };
    });

    res.json({
      timestamp: new Date().toISOString(),
      healthy: !driftPayload,
      accounts,
      last_check: lastCheck,
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'unknown error' });
  }
});

export default router;
