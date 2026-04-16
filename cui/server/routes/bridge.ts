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

// GET /api/claude-code/best-account — Returns the least-loaded account for spawning new sessions
router.get("/api/claude-code/best-account", (_req, res) => {
  try {
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

    // Build account list with utilization
    const ranked = CC_ACCOUNTS.map(acc => {
      const scraped = scrapedMap[acc.id];
      const weeklyPercent = scraped?.weeklyAllModels?.percent ?? 0;
      const sessionPercent = scraped?.currentSession?.percent ?? 0;
      const extraBalance = scraped?.extraUsage?.balance ? parseFloat(scraped.extraUsage.balance) : Infinity;
      const extraDepleted = (scraped?.extraUsage?.percent ?? 0) >= 100 && extraBalance <= 0;

      let status: 'safe' | 'warning' | 'critical' = 'safe';
      if (weeklyPercent >= 80 || extraDepleted) status = 'critical';
      else if (weeklyPercent >= 50) status = 'warning';

      // Count active sessions per account
      const activeSessions = ACCOUNT_CONFIG.reduce((count, _) => count, 0); // placeholder — real count from claude-cli

      return {
        accountId: acc.id,
        accountName: acc.displayName,
        weeklyPercent: Math.round(weeklyPercent * 10) / 10,
        sessionPercent: Math.round(sessionPercent * 10) / 10,
        status,
        extraDepleted,
        available: status !== 'critical',
      };
    })
    .sort((a, b) => {
      // Sort: available first, then by lowest weekly usage
      if (a.available !== b.available) return a.available ? -1 : 1;
      return a.weeklyPercent - b.weeklyPercent;
    });

    const best = ranked.find(a => a.available) || ranked[0];

    res.json({
      bestAccount: best.accountId,
      accounts: ranked,
      timestamp: new Date().toISOString(),
    });
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
    const [stats, health, sessions, rateLimits, guardStatus] = await Promise.all([
      bridgeFetch('/stats').catch(() => null),
      bridgeFetch('/health').catch(() => null),
      bridgeFetch('/v1/sessions/stats').catch(() => null),
      bridgeFetch('/rate-limits').catch(() => null),
      // AI-Guard status (local service, fast)
      fetch('http://localhost:8050/status', { signal: AbortSignal.timeout(2000) })
        .then(r => r.json()).catch(() => null),
    ]);
    console.log('[Bridge] Overview: stats=%s health=%s sessions=%s limits=%s guard=%s',
      stats ? 'ok' : 'fail', health ? 'ok' : 'fail', sessions ? 'ok' : 'fail',
      rateLimits ? 'ok' : 'fail', guardStatus ? 'ok' : 'fail');
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
// Cost: Composite from /stats + /v1/metrics/request-log (Bridge has no native cost tracking)
router.get('/api/bridge/metrics/cost', async (_req, res) => {
  try {
    const [stats, requestLog] = await Promise.all([
      bridgeFetch('/stats').catch(() => null),
      bridgeFetch('/v1/metrics/request-log?hours=24&limit=2000').catch(() => null),
    ]);

    const totalRequests = stats?.request_limiting?.total_requests ?? 0;

    // Count requests by model from the request log (endpoint = /v1/chat/completions)
    const chatRequests = (requestLog?.entries ?? []).filter(
      (e: any) => e.endpoint === '/v1/chat/completions' && e.status === 200
    );

    // Estimate tokens/costs from duration (rough heuristic since Bridge doesn't track tokens)
    // Average: ~500 tokens/s output, ~2000 tokens input per request
    const estimatedTokens = chatRequests.length * 3000; // rough estimate
    const estimatedCost = chatRequests.length * 0.015; // ~$0.015 per sonnet request avg

    // Build model breakdown (we don't have model info in logs, show aggregate)
    const breakdown: Record<string, { requests: number; tokens: number; cost_usd: number }> = {};
    if (chatRequests.length > 0) {
      breakdown['claude-sonnet (estimated)'] = {
        requests: chatRequests.length,
        tokens: estimatedTokens,
        cost_usd: estimatedCost,
      };
    }

    res.json({
      total_requests: totalRequests,
      estimated_tokens: estimatedTokens,
      estimated_cost_usd: estimatedCost,
      breakdown,
      note: 'Cost estimates based on request count. Bridge does not track per-request token usage.',
      timestamp: new Date().toISOString(),
      _contractViolations: [{
        code: 'BRIDGE_COST_ESTIMATED', severity: 'error',
        message: 'Kosten sind Schätzwerte — nicht Token-basiert',
        detail: `${chatRequests.length} Requests x $0.015 Durchschnitt = $${estimatedCost.toFixed(2)}. Echte Token-Daten fehlen.`,
      }],
    });
  } catch (err: any) {
    console.warn('[Bridge] Cost composite error:', err.message);
    res.json({
      total_requests: 0,
      estimated_tokens: 0,
      estimated_cost_usd: 0,
      breakdown: {},
      note: 'Bridge not reachable',
      timestamp: new Date().toISOString(),
      _error: err.message,
    });
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

// Persistent metrics from PostgreSQL (survives worker restarts)
router.get("/api/bridge/metrics/persistent", bridgeMetricHandler("Persistent", "/v1/metrics/persistent", { source: "postgresql", realtime: {}, daily: [], endpoints: [], models: [], apps: [] }));

// Per-app metrics breakdown (connected frontend apps)
router.get("/api/bridge/metrics/apps", bridgeMetricHandler("Apps", "/v1/metrics/apps", { source: "postgresql", apps_period: [], apps_realtime: [] }));

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
