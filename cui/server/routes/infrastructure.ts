import { Router, Request, Response } from 'express';
import { request as httpRequest } from 'http';
import { spawn } from 'child_process';
import { join } from 'path';

// Type for metricsDb dependency (mirrors metrics-db.ts exports)
interface MetricsDb {
  getRealtimeStats(hours: number): Promise<any>;
  getCostBreakdown(days: number): Promise<any>;
  getEndpointUsage(days: number): Promise<any>;
  getActivityFeed(limit: number): Promise<any>;
  refreshDailyStats(targetDate?: string): Promise<any>;
}

// Dependencies injected via factory
interface InfrastructureDeps {
  metricsDb: MetricsDb;
  broadcast: (data: Record<string, unknown>) => void;
  WORKSPACE_ROOT: string;
}

// --- Dev Server Watchdog Proxy ---
const WATCHDOG_HOST = 'localhost';
const WATCHDOG_PORT = 9090;

// --- Infrastructure Monitoring (Watchdog Integration) ---
const WATCHDOG_BASE = 'http://localhost:9090';

// Helper: restart CUI server after build
function restartCuiServer(WORKSPACE_ROOT: string) {
  console.log('[Restart] Triggering external restart script...');

  // Use external restart script for clean restart (kill old, start new)
  // spawn already imported at top of file (ESM — require() not available)
  const restartScript = join(WORKSPACE_ROOT, 'restart-server.sh');

  const restartChild = spawn('bash', [restartScript], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env }
  });
  restartChild.on('error', (err) => console.warn('[Server] restart script spawn error:', err));
  restartChild.unref();

  console.log('[Restart] Restart script launched, exiting in 500ms...');

  // Exit after launching restart script
  setTimeout(() => {
    console.log('[Restart] Exiting now');
    process.exit(0);
  }, 500);
}

// Helper: trigger watchdog to restart all enabled dev servers
function triggerWatchdogCheck() {
  try {
    const postReq = httpRequest({ hostname: WATCHDOG_HOST, port: WATCHDOG_PORT, path: '/api/check', method: 'POST', timeout: 3000 }, () => {
      console.log('[Rebuild] Watchdog check triggered');
    });
    postReq.on('error', () => { console.log('[Rebuild] Watchdog not available (skipped)'); });
    postReq.end();
  } catch (err) { console.warn('[Infrastructure] Watchdog check failed:', err); }
}

// Panel configuration with start commands
const PANEL_CONFIGS = [
  { name: 'Platform', port: 3004, path: '/root/projekte/werkingflow/platform', startCmd: 'npm run build:local' },
  { name: 'Dashboard', port: 3333, path: '/root/projekte/werkingflow/dashboard', startCmd: 'python3 -m dashboard.app &' },
  { name: 'Werking-Report', port: 3008, path: '/root/projekte/werking-report', startCmd: 'npm run build:local' },
  { name: 'Werking-Energy', port: 3007, path: '/root/projekte/apps/werking-energy', startCmd: 'npm run build:local' },
  { name: 'Engelmann', port: 3009, path: '/root/projekte/engelmann-ai-hub', startCmd: 'npm run build:local' },
  { name: 'Safety', port: 3006, path: '/root/projekte/werking-safety/frontend', startCmd: 'npm run build:local' },
];

export default function createInfrastructureRouter(deps: InfrastructureDeps): Router {
  const router = Router();
  const { metricsDb, broadcast, WORKSPACE_ROOT } = deps;

  // --- Watchdog Proxy Middleware ---
  // Proxies /watchdog/* to the watchdog panel running on the remote dev server
  router.use('/watchdog', (req: Request, res: Response) => {
    const targetPath = req.url === '/' || req.url === '' ? '/' : req.url;
    const proxyReq = httpRequest({
      hostname: WATCHDOG_HOST,
      port: WATCHDOG_PORT,
      path: targetPath,
      method: req.method,
      headers: { ...req.headers, host: `${WATCHDOG_HOST}:${WATCHDOG_PORT}` },
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxyReq.on('error', () => {
      res.status(502).json({ error: `Dev Server Watchdog not reachable (${WATCHDOG_HOST}:${WATCHDOG_PORT})` });
    });
    req.pipe(proxyReq);
  });

  // --- Rebuild & Restart Endpoints ---

  // POST /api/rebuild — legacy rebuild (redirects to robust cui-rebuild)
  router.post('/api/rebuild', (_req: Request, res: Response) => {
    console.log('[Rebuild] Spawning cui-rebuild (detached)...');
    broadcast({ type: 'cui-rebuilding' });
    res.json({ status: 'rebuilding', message: 'cui-rebuild gestartet (Server startet gleich neu)...' });
    setTimeout(() => {
      const child = spawn('systemd-run', ['--scope', '--', 'cui-rebuild'], { detached: true, stdio: ['ignore', 'ignore', 'ignore'] });
      child.on('error', (err) => console.warn('[Server] cui-rebuild spawn error:', err));
      child.unref();
      console.log('[Rebuild] cui-rebuild spawned via systemd-run, PID', child.pid);
    }, 500);
  });

  // GET /api/panel-health — Check which panel dependencies are running
  router.get('/api/panel-health', async (_req: Request, res: Response) => {
    const checks = await Promise.all(PANEL_CONFIGS.map(async (panel) => {
      try {
        // Use nc (netcat) to check if port is listening
        const checkPort = () => new Promise<boolean>((resolve) => {
          const proc = spawn('nc', ['-z', 'localhost', String(panel.port)], {
            stdio: ['ignore', 'ignore', 'ignore']
          });

          proc.on('close', (code) => {
            resolve(code === 0);
          });

          proc.on('error', () => {
            resolve(false);
          });

          // Timeout after 1s
          setTimeout(() => {
            proc.kill();
            resolve(false);
          }, 1000);
        });

        const isRunning = await checkPort();
        return { ...panel, running: isRunning };
      } catch (err) {
        console.warn(`[Infrastructure] Port check failed for ${panel.name}:`, err);
        return { ...panel, running: false };
      }
    }));

    const running = checks.filter(c => c.running);
    const missing = checks.filter(c => !c.running);

    res.json({
      ok: missing.length === 0,
      total: PANEL_CONFIGS.length,
      running: running.length,
      missing: missing.length,
      panels: checks,
      message: missing.length === 0 ? 'All panels running' : `${missing.length} offline: ${missing.map(p => p.name).join(', ')}`
    });
  });

  // GET /api/health-check-proxy — Proxy for external backend health checks (CORS bypass)
  const ALLOWED_HEALTH_CHECK_HOSTS = ['localhost', '127.0.0.1', '100.121.161.109', '49.12.72.66'];

  router.get('/api/health-check-proxy', async (req: Request, res: Response) => {
    const targetUrl = req.query.url as string;

    if (!targetUrl) {
      return res.status(400).json({ error: 'Missing url parameter' });
    }

    // SSRF protection: validate target hostname against allowlist
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(targetUrl);
    } catch (err) {
      console.warn('[Infrastructure] Invalid health-check-proxy URL:', targetUrl, err);
      return res.status(400).json({ error: 'Invalid URL' });
    }

    if (!ALLOWED_HEALTH_CHECK_HOSTS.includes(parsedUrl.hostname)) {
      console.warn(`[Infrastructure] SSRF blocked: health-check-proxy to disallowed host ${parsedUrl.hostname}`);
      return res.status(403).json({ error: `Host '${parsedUrl.hostname}' is not in the allowed health-check hosts list` });
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);

      const response = await fetch(targetUrl, {
        method: 'GET',
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      res.json({
        ok: response.ok,
        status: response.status,
        url: targetUrl
      });
    } catch (err: any) {
      res.json({
        ok: false,
        error: err.message,
        url: targetUrl
      });
    }
  });

  // POST /api/start-all-panels — Start all missing panel backends
  router.post('/api/start-all-panels', (_req: Request, res: Response) => {
    console.log('[Start-Panels] Launching start script...');
    try {
      const startScript = join(WORKSPACE_ROOT, 'start-all-panels.sh');
      const child = spawn('bash', [startScript], { detached: true, stdio: 'ignore', env: process.env });
      child.on('error', (err) => console.warn('[Server] start-all-panels spawn error:', err));
      child.unref();
      console.log('[Start-Panels] Script launched');
      res.json({ ok: true, message: 'Starting all missing panels', note: 'Check status in 10-30s' });
    } catch (err: any) {
      console.error('[Start-Panels] Failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/rebuild-frontend — called by ProjectTabs Rebuild button
  // Spawns cui-rebuild as detached background process (because it restarts this server)
  router.post('/api/rebuild-frontend', async (_req: Request, res: Response) => {
    console.log('[Rebuild-Frontend] Spawning cui-rebuild (detached)...');
    broadcast({ type: 'cui-rebuilding' });

    // Respond immediately — the server will be killed by cui-rebuild
    res.json({ ok: true, detail: 'cui-rebuild started (server will restart)' });

    // Use systemd-run to escape the cgroup (systemd KillMode=control-group kills all children)
    setTimeout(() => {
      const child = spawn('systemd-run', ['--scope', '--', 'cui-rebuild'], {
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      child.on('error', (err) => console.warn('[Server] rebuild-frontend spawn error:', err));
      child.unref();
      console.log('[Rebuild-Frontend] cui-rebuild spawned via systemd-run, PID', child.pid);
    }, 500);
  });

  // --- Bridge Metrics (Direct DB Access) ---
  // IMPORTANT: Register BEFORE static middleware to prevent SPA fallback from intercepting
  // NEW: Metrics from PostgreSQL (faster, more reliable than Bridge API)
  router.get('/api/bridge-db/metrics/overview', async (req: Request, res: Response) => {
    try {
      const hours = parseInt(req.query.hours as string) || 24;
      const stats = await metricsDb.getRealtimeStats(hours);
      res.json({
        health: 'healthy', // Assume healthy if DB responds
        worker: 'aggregated', // DB aggregates all workers
        uptime_hours: hours,
        total_requests: stats.total_requests || 0,
        avg_response_time: stats.avg_response_time_ms ? stats.avg_response_time_ms / 1000 : 0,
        success_rate: stats.success_rate || 100,
        active_sessions: stats.active_sessions || 0,
        timestamp: stats.timestamp || new Date().toISOString(),
      });
    } catch (err: any) {
      console.error('[Metrics DB] Overview error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/bridge-db/metrics/cost', async (req: Request, res: Response) => {
    try {
      const days = parseInt(req.query.days as string) || 30;
      const breakdown = await metricsDb.getCostBreakdown(days);
      const stats = await metricsDb.getRealtimeStats(days * 24);

      res.json({
        total_requests: stats.total_requests || 0,
        estimated_tokens: stats.total_tokens || 0,
        estimated_cost_usd: parseFloat(stats.total_cost_usd || '0'),
        breakdown: breakdown.reduce((acc: any, row: any) => {
          acc[row.model] = {
            requests: row.requests,
            tokens: row.tokens,
            cost_usd: parseFloat(row.cost_usd || '0'),
          };
          return acc;
        }, {}),
        note: `Statistics from last ${days} days (PostgreSQL)`,
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
      console.error('[Metrics DB] Cost error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/bridge-db/metrics/usage', async (req: Request, res: Response) => {
    try {
      const days = parseInt(req.query.days as string) || 7;
      const endpoints = await metricsDb.getEndpointUsage(days);
      const stats = await metricsDb.getRealtimeStats(days * 24);

      res.json({
        total_requests: stats.total_requests || 0,
        endpoints: endpoints.map((row: any) => ({
          endpoint: row.endpoint,
          requests: row.requests,
          avg_response_time: row.avg_response_time_ms ? row.avg_response_time_ms / 1000 : 0,
        })),
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
      console.error('[Metrics DB] Usage error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/bridge-db/metrics/activity', async (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const requests = await metricsDb.getActivityFeed(limit);

      res.json({
        total_today: requests.length,
        requests: requests.map((row: any) => ({
          timestamp: row.timestamp,
          endpoint: row.endpoint,
          model: row.model,
          tokens: row.total_tokens,
          cost_usd: parseFloat(row.cost_usd || '0'),
          response_time_ms: row.response_time_ms,
          success: row.success,
          error: row.error_type,
          worker: row.worker_instance,
        })),
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
      console.error('[Metrics DB] Activity error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Admin: Trigger daily stats refresh
  router.post('/api/bridge-db/admin/refresh-stats', async (req: Request, res: Response) => {
    try {
      const targetDate = req.body?.date; // Optional: YYYY-MM-DD
      const result = await metricsDb.refreshDailyStats(targetDate);
      res.json(result);
    } catch (err: any) {
      console.error('[Metrics DB] Refresh error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // --- Infrastructure Monitoring (Watchdog Integration) ---
  // Proxy endpoints to the Watchdog API (http://localhost:9090)

  router.get('/api/infrastructure/status', async (_req: Request, res: Response) => {
    try {
      const response = await fetch(`${WATCHDOG_BASE}/api/status`, { signal: AbortSignal.timeout(8000) });
      if (!response.ok) {
        throw new Error(`Watchdog returned ${response.status}`);
      }
      const data = await response.json();
      res.json(data);
    } catch (err: any) {
      console.error('[Infrastructure] Failed to fetch watchdog status:', err.message);
      res.status(503).json({ error: 'Watchdog unavailable', message: err.message });
    }
  });

  router.post('/api/infrastructure/app/:id/restart', async (req: Request, res: Response) => {
    const { id } = req.params;
    try {
      const response = await fetch(`${WATCHDOG_BASE}/api/app/${id}/restart`, {
        method: 'POST',
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        throw new Error(`Watchdog returned ${response.status}`);
      }
      const data = await response.json();
      res.json(data);
    } catch (err: any) {
      console.error(`[Infrastructure] Failed to restart ${id}:`, err.message);
      res.status(500).json({ error: 'Restart failed', message: err.message });
    }
  });

  router.post('/api/infrastructure/app/:id/test/restart', async (req: Request, res: Response) => {
    const { id } = req.params;

    // Check if app has test_port before attempting restart
    try {
      const statusResponse = await fetch(`${WATCHDOG_BASE}/api/status`, { signal: AbortSignal.timeout(8000) });
      if (statusResponse.ok) {
        const statusData = await statusResponse.json();
        const app = statusData.apps?.[id];
        if (app && !app.test_port) {
          return res.status(410).json({
            error: 'App uses single-port architecture',
            message: `${id} no longer has a test port (migrated to single-port mode)`
          });
        }
      }
    } catch (err) {
      console.warn('[Infrastructure] Could not verify test_port existence:', err);
      // Continue anyway - let watchdog handle the error
    }

    try {
      const response = await fetch(`${WATCHDOG_BASE}/api/app/${id}/test/restart`, {
        method: 'POST',
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        throw new Error(`Watchdog returned ${response.status}`);
      }
      const data = await response.json();
      res.json(data);
    } catch (err: any) {
      console.error(`[Infrastructure] Failed to restart test port for ${id}:`, err.message);
      res.status(500).json({ error: 'Test restart failed', message: err.message });
    }
  });

  // =============================================================================
  // Filesystem Panel API
  // =============================================================================

  router.get('/api/filesystem/tree', async (req: Request, res: Response) => {
    try {
      const { path, maxDepth, maxPerLevel } = req.query;

      if (!path || typeof path !== 'string') {
        return res.status(400).json({ error: 'path parameter required' });
      }

      const depth = maxDepth ? parseInt(maxDepth as string, 10) : 2;
      const perLevel = maxPerLevel ? parseInt(maxPerLevel as string, 10) : 20;

      const { buildDirectoryTree } = await import('../lib/filesystem/treeBuilder');
      const tree = await buildDirectoryTree(path, { maxDepth: depth, maxPerLevel: perLevel });

      res.json(tree);
    } catch (err: any) {
      console.error('[Filesystem] Failed to build tree:', err);
      res.status(500).json({ error: 'Failed to build tree', message: err.message });
    }
  });

  return router;
}

export { restartCuiServer, triggerWatchdogCheck, PANEL_CONFIGS, WATCHDOG_HOST, WATCHDOG_PORT, WATCHDOG_BASE };
