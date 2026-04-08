import { Router, Request, Response } from 'express';
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';

interface AdminDeps {
  broadcast: (data: Record<string, unknown>) => void;
}

// --- WR Environment Configuration ---
const WR_PROD_URL = process.env.WERKING_REPORT_URL ?? 'https://werking-report.vercel.app';
const WR_STAGING_URL = process.env.WERKING_REPORT_STAGING_URL ?? 'https://werking-report-git-develop-rafael-engelmanns-projects.vercel.app';
const WR_LOCAL_URL = process.env.WERKING_REPORT_LOCAL_URL ?? 'http://localhost:3008';
const WR_ADMIN_SECRET = process.env.WERKING_REPORT_ADMIN_SECRET ?? process.env.ADMIN_SECRET ?? '';

// Runtime-switchable env mode (persists across restarts via file)
type WrEnvMode = 'production' | 'staging' | 'local';
const WR_ENV_MODE_FILE = process.env.CUI_DATA_DIR
  ? `${process.env.CUI_DATA_DIR}/cui-wr-env-mode.json`
  : '/root/projekte/werkingflow/autopilot/cui/data/cui-wr-env-mode.json';

/**
 * Auto-detect WR mode based on environment.
 * Priority: 1) Saved file, 2) NODE_ENV, 3) Port detection, 4) Production default
 */
function loadWrEnvMode(): WrEnvMode {
  // 1. Check saved preference
  try {
    if (existsSync(WR_ENV_MODE_FILE)) {
      const data = JSON.parse(readFileSync(WR_ENV_MODE_FILE, 'utf8'));
      if (data.mode === 'staging' || data.mode === 'local' || data.mode === 'production') {
        return data.mode;
      }
    }
  } catch (err) { console.warn('[Server] loadWrEnvMode read error:', err); }

  // 2. Auto-detect based on NODE_ENV
  if (process.env.NODE_ENV === 'development') {
    // In dev mode, default to local if WR is running on port 3008
    try {
      // execSync already imported at top of file (ESM -- require() not available)
      const portCheck = execSync('ss -tlnp 2>/dev/null | grep ":3008" || true', { encoding: 'utf8' });
      if (portCheck.includes('3008')) {
        console.log('[WR Env] Auto-detected local WR server on port 3008');
        return 'local';
      }
    } catch (err) { console.warn('[Server] WR port detection error:', err); }
  }

  // 3. Default: production (Vercel)
  return 'production';
}
function saveWrEnvMode(mode: WrEnvMode) {
  try { writeFileSync(WR_ENV_MODE_FILE, JSON.stringify({ mode })); } catch (err) { console.warn('[Server] saveWrEnvMode write error:', err); }
}
let wrEnvMode: WrEnvMode = loadWrEnvMode();
function wrBase(): string {
  return wrEnvMode === 'staging' ? WR_STAGING_URL
    : wrEnvMode === 'local' ? WR_LOCAL_URL
    : WR_PROD_URL;
}
console.log(`[WR Env] Loaded mode: ${wrEnvMode} -> ${wrBase()}`);

function wrAdminHeaders(): Record<string, string> {
  if (!WR_ADMIN_SECRET) throw new Error('WERKING_REPORT_ADMIN_SECRET not set');
  return { 'x-admin-secret': WR_ADMIN_SECRET, 'Content-Type': 'application/json' };
}

/**
 * Safe proxy helper: forwards request to WR backend, handles HTML errors gracefully.
 * Returns JSON always -- never forwards raw HTML to the client.
 */
async function wrProxy(url: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, { ...init, headers: { ...wrAdminHeaders(), ...init?.headers }, signal: init?.signal ?? AbortSignal.timeout(15000) });
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return { status: response.status, body: await response.json() };
  }
  // Non-JSON response (HTML error page, 404, etc.)
  const text = await response.text();
  const snippet = text.slice(0, 200).replace(/<[^>]*>/g, '').trim();
  return {
    status: response.status >= 400 ? response.status : 502,
    body: { error: `Non-JSON response (HTTP ${response.status}): ${snippet || 'empty response'}` },
  };
}

// --- Vercel Deployment Status ---
const VERCEL_APPS = [
  { name: 'werking-report', projectSlug: 'werking-report' },
  { name: 'werking-energy', projectSlug: 'werking-energy' },
  { name: 'platform', projectSlug: 'platform-werkingflow' },
  { name: 'engelmann', projectSlug: 'engelmann' },
  { name: 'werking-safety', projectSlug: 'werking-safety' },
];

export default function createAdminRouter(deps: AdminDeps): Router {
  const router = Router();
  const { broadcast } = deps;

  // ============================================================
  // ADMIN APIS - Werking Report Proxy
  // ============================================================

  // GET /api/admin/wr/env -- current env mode
  router.get('/admin/wr/env', (_req: Request, res: Response) => {
    res.json({ mode: wrEnvMode, urls: { production: WR_PROD_URL, staging: WR_STAGING_URL, local: WR_LOCAL_URL } });
  });

  // POST /api/admin/wr/env -- switch env mode
  router.post('/admin/wr/env', (req: Request, res: Response) => {
    const { mode } = req.body as { mode?: string };
    if (mode !== 'production' && mode !== 'staging' && mode !== 'local') {
      res.status(400).json({ error: 'mode must be "production", "staging", or "local"' });
      return;
    }
    wrEnvMode = mode as WrEnvMode;
    saveWrEnvMode(wrEnvMode); // persist across restarts
    console.log(`[Admin Proxy] WR env switched to: ${wrEnvMode} -> ${wrBase()}`);
    broadcast({ type: 'wr-env-changed', mode: wrEnvMode });
    res.json({ ok: true, mode: wrEnvMode, url: wrBase() });
  });

  router.get('/admin/wr/users', async (_req: Request, res: Response) => {
    try { const r = await wrProxy(`${wrBase()}/api/admin/users`); res.status(r.status).json(r.body); }
    catch (err: any) { console.warn('[Admin] Proxy error:', err.message); res.status(500).json({ error: err.message }); }
  });

  router.post('/admin/wr/users/:id/approve', async (req: Request, res: Response) => {
    try { const r = await wrProxy(`${wrBase()}/api/admin/users/${req.params.id}/approve`, { method: 'POST' }); res.status(r.status).json(r.body); }
    catch (err: any) { console.warn('[Admin] Proxy error:', err.message); res.status(500).json({ error: err.message }); }
  });

  router.post('/admin/wr/users/:id/verify', async (req: Request, res: Response) => {
    try { const r = await wrProxy(`${wrBase()}/api/admin/users/${req.params.id}/verify`, { method: 'POST' }); res.status(r.status).json(r.body); }
    catch (err: any) { console.warn('[Admin] Proxy error:', err.message); res.status(500).json({ error: err.message }); }
  });

  router.get('/admin/wr/billing/overview', async (_req: Request, res: Response) => {
    try { const r = await wrProxy(`${wrBase()}/api/admin/billing/overview`); res.status(r.status).json(r.body); }
    catch (err: any) { console.warn('[Admin] Proxy error:', err.message); res.status(500).json({ error: err.message }); }
  });

  // Top-Up
  router.post('/admin/wr/billing/top-up', async (req: Request, res: Response) => {
    try {
      const r = await wrProxy(`${wrBase()}/api/admin/billing/top-up`, {
        method: 'POST',
        body: JSON.stringify(req.body),
      });
      res.status(r.status).json(r.body);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Billing Events
  router.get('/admin/wr/billing/events/:tenantId', async (req: Request, res: Response) => {
    try {
      const r = await wrProxy(`${wrBase()}/api/admin/billing/events/${req.params.tenantId}`);
      res.status(r.status).json(r.body);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Invoices
  router.get('/admin/wr/billing/invoices', async (req: Request, res: Response) => {
    try {
      const tenantId = req.query.tenantId;
      const url = tenantId
        ? `${wrBase()}/api/admin/billing/invoices?tenantId=${encodeURIComponent(tenantId as string)}`
        : `${wrBase()}/api/admin/billing/invoices`;
      const r = await wrProxy(url);
      res.status(r.status).json(r.body);
    }
    catch (err: any) { console.warn('[Admin] Proxy error:', err.message); res.status(500).json({ error: err.message }); }
  });

  router.get('/admin/wr/billing/invoices/:id', async (req: Request, res: Response) => {
    try {
      const tenantId = req.query.tenantId;
      if (!tenantId) return res.status(400).json({ error: 'tenantId required' });
      const r = await wrProxy(`${wrBase()}/api/admin/billing/invoices/${encodeURIComponent(req.params.id)}?tenantId=${encodeURIComponent(tenantId as string)}`);
      res.status(r.status).json(r.body);
    }
    catch (err: any) { console.warn('[Admin] Proxy error:', err.message); res.status(500).json({ error: err.message }); }
  });

  router.post('/admin/wr/billing/invoices/:id/send', async (req: Request, res: Response) => {
    try {
      const tenantId = req.query.tenantId;
      if (!tenantId) return res.status(400).json({ error: 'tenantId required' });
      const r = await wrProxy(`${wrBase()}/api/admin/billing/invoices/${encodeURIComponent(req.params.id)}/send?tenantId=${encodeURIComponent(tenantId as string)}`, { method: 'POST' });
      res.status(r.status).json(r.body);
    }
    catch (err: any) { console.warn('[Admin] Proxy error:', err.message); res.status(500).json({ error: err.message }); }
  });

  router.get('/admin/wr/billing/invoices/:id/pdf', async (req: Request, res: Response) => {
    try {
      const tenantId = req.query.tenantId;
      if (!tenantId) return res.status(400).json({ error: 'tenantId required' });
      const response = await fetch(
        `${wrBase()}/api/admin/billing/invoices/${encodeURIComponent(req.params.id)}/pdf?tenantId=${encodeURIComponent(tenantId as string)}`,
        { headers: wrAdminHeaders(), signal: AbortSignal.timeout(30000) }
      );
      if (!response.ok) {
        const text = await response.text();
        return res.status(response.status).json({ error: text || 'Failed to generate PDF' });
      }
      // Forward HTML response with correct content-type
      const html = await response.text();
      res.setHeader('Content-Type', 'text/html');
      res.setHeader('Content-Disposition', `inline; filename="invoice-${req.params.id}.html"`);
      res.send(html);
    }
    catch (err: any) { console.warn('[Admin] Proxy error:', err.message); res.status(500).json({ error: err.message }); }
  });

  router.get('/admin/wr/usage/stats', async (req: Request, res: Response) => {
    try { const r = await wrProxy(`${wrBase()}/api/admin/usage/stats?period=${encodeURIComponent((req.query.period as string) || 'month')}`); res.status(r.status).json(r.body); }
    catch (err: any) { console.warn('[Admin] Proxy error:', err.message); res.status(500).json({ error: err.message }); }
  });

  router.get('/admin/wr/usage/activity', async (_req: Request, res: Response) => {
    try { const r = await wrProxy(`${wrBase()}/api/admin/usage/activity`); res.status(r.status).json(r.body); }
    catch (err: any) { console.warn('[Admin] Proxy error:', err.message); res.status(500).json({ error: err.message }); }
  });

  router.get('/admin/wr/usage/activity/users', async (req: Request, res: Response) => {
    try {
      const tenantId = req.query.tenantId;
      const r = await wrProxy(`${wrBase()}/api/admin/usage/activity/users?tenantId=${encodeURIComponent(tenantId as string)}`);
      res.status(r.status).json(r.body);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/admin/wr/feedback', async (_req: Request, res: Response) => {
    try { const r = await wrProxy(`${wrBase()}/api/admin/feedback`); res.status(r.status).json(r.body); }
    catch (err: any) { console.warn('[Admin] Proxy error:', err.message); res.status(500).json({ error: err.message }); }
  });

  router.get('/admin/wr/system-health', async (_req: Request, res: Response) => {
    try { const r = await wrProxy(`${wrBase()}/api/admin/system-health`); res.status(r.status).json(r.body); }
    catch (err: any) { console.warn('[Admin] Proxy error:', err.message); res.status(500).json({ error: err.message }); }
  });

  router.get('/admin/wr/usage/trend', async (_req: Request, res: Response) => {
    try { const r = await wrProxy(`${wrBase()}/api/admin/usage/trend`); res.status(r.status).json(r.body); }
    catch (err: any) { console.warn('[Admin] Proxy error:', err.message); res.status(500).json({ error: err.message }); }
  });

  // ============================================================
  // Extended Platform Admin Proxy Routes
  // ============================================================

  // Dashboard / Stats
  router.get('/admin/wr/stats', async (_req: Request, res: Response) => {
    try { const r = await wrProxy(`${wrBase()}/api/admin/stats`); res.status(r.status).json(r.body); }
    catch (err: any) { console.warn('[Admin] Proxy error:', err.message); res.status(500).json({ error: err.message }); }
  });
  router.get('/admin/wr/health', async (_req: Request, res: Response) => {
    try { const r = await wrProxy(`${wrBase()}/api/admin/health`); res.status(r.status).json(r.body); }
    catch (err: any) { console.warn('[Admin] Proxy error:', err.message); res.status(500).json({ error: err.message }); }
  });
  router.get('/admin/wr/infrastructure', async (_req: Request, res: Response) => {
    try { const r = await wrProxy(`${wrBase()}/api/admin/infrastructure`); res.status(r.status).json(r.body); }
    catch (err: any) { console.warn('[Admin] Proxy error:', err.message); res.status(500).json({ error: err.message }); }
  });
  router.get('/admin/wr/supabase-health', async (_req: Request, res: Response) => {
    try { const r = await wrProxy(`${wrBase()}/api/admin/supabase-health`); res.status(r.status).json(r.body); }
    catch (err: any) { console.warn('[Admin] Proxy error:', err.message); res.status(500).json({ error: err.message }); }
  });

  // Tenant CRUD
  router.get('/admin/wr/tenants', async (req: Request, res: Response) => {
    try { const qs = new URLSearchParams(req.query as Record<string, string>).toString(); const r = await wrProxy(`${wrBase()}/api/admin/tenants${qs ? '?' + qs : ''}`); res.status(r.status).json(r.body); }
    catch (err: any) { console.warn('[Admin] Proxy error:', err.message); res.status(500).json({ error: err.message }); }
  });
  router.post('/admin/wr/tenants', async (req: Request, res: Response) => {
    try { const r = await wrProxy(`${wrBase()}/api/admin/tenants`, { method: 'POST', body: JSON.stringify(req.body) }); res.status(r.status).json(r.body); }
    catch (err: any) { console.warn('[Admin] Proxy error:', err.message); res.status(500).json({ error: err.message }); }
  });
  router.put('/admin/wr/tenants/:id', async (req: Request, res: Response) => {
    try { const r = await wrProxy(`${wrBase()}/api/admin/tenants/${req.params.id}`, { method: 'PUT', body: JSON.stringify(req.body) }); res.status(r.status).json(r.body); }
    catch (err: any) { console.warn('[Admin] Proxy error:', err.message); res.status(500).json({ error: err.message }); }
  });
  router.delete('/admin/wr/tenants/:id', async (req: Request, res: Response) => {
    try { const r = await wrProxy(`${wrBase()}/api/admin/tenants/${req.params.id}`, { method: 'DELETE' }); res.status(r.status).json(r.body); }
    catch (err: any) { console.warn('[Admin] Proxy error:', err.message); res.status(500).json({ error: err.message }); }
  });

  // Developer Tokens
  router.get('/admin/wr/developer-tokens', async (_req: Request, res: Response) => {
    try { const r = await wrProxy(`${wrBase()}/api/admin/developer-tokens`); res.status(r.status).json(r.body); }
    catch (err: any) { console.warn('[Admin] Proxy error:', err.message); res.status(500).json({ error: err.message }); }
  });
  router.post('/admin/wr/developer-tokens', async (req: Request, res: Response) => {
    try { const r = await wrProxy(`${wrBase()}/api/admin/developer-tokens`, { method: 'POST', body: JSON.stringify(req.body) }); res.status(r.status).json(r.body); }
    catch (err: any) { console.warn('[Admin] Proxy error:', err.message); res.status(500).json({ error: err.message }); }
  });
  router.delete('/admin/wr/developer-tokens/:id', async (req: Request, res: Response) => {
    try { const r = await wrProxy(`${wrBase()}/api/admin/developer-tokens/${req.params.id}`, { method: 'DELETE' }); res.status(r.status).json(r.body); }
    catch (err: any) { console.warn('[Admin] Proxy error:', err.message); res.status(500).json({ error: err.message }); }
  });

  // Audit Logs
  router.get('/admin/wr/audit', async (req: Request, res: Response) => {
    try { const qs = new URLSearchParams(req.query as Record<string, string>).toString(); const r = await wrProxy(`${wrBase()}/api/admin/audit${qs ? '?' + qs : ''}`); res.status(r.status).json(r.body); }
    catch (err: any) { console.warn('[Admin] Proxy error:', err.message); res.status(500).json({ error: err.message }); }
  });

  // Platform Config
  router.get('/admin/wr/config', async (_req: Request, res: Response) => {
    try { const r = await wrProxy(`${wrBase()}/api/admin/config`); res.status(r.status).json(r.body); }
    catch (err: any) { console.warn('[Admin] Proxy error:', err.message); res.status(500).json({ error: err.message }); }
  });
  router.post('/admin/wr/config', async (req: Request, res: Response) => {
    try { const r = await wrProxy(`${wrBase()}/api/admin/config`, { method: 'POST', body: JSON.stringify(req.body) }); res.status(r.status).json(r.body); }
    catch (err: any) { console.warn('[Admin] Proxy error:', err.message); res.status(500).json({ error: err.message }); }
  });

  // Environments Config (for Pipeline URLs)
  router.get('/admin/wr/environments', async (_req: Request, res: Response) => {
    try { const r = await wrProxy(`${wrBase()}/api/admin/environments`); res.status(r.status).json(r.body); }
    catch (err: any) { console.warn('[Admin] Proxy error:', err.message); res.status(500).json({ error: err.message }); }
  });
  router.post('/admin/wr/environments', async (req: Request, res: Response) => {
    try { const r = await wrProxy(`${wrBase()}/api/admin/environments`, { method: 'POST', body: JSON.stringify(req.body) }); res.status(r.status).json(r.body); }
    catch (err: any) { console.warn('[Admin] Proxy error:', err.message); res.status(500).json({ error: err.message }); }
  });

  // Pipeline Health Check - server-side proxy to avoid CORS issues
  // The browser can't directly fetch /api/version from Vercel domains (CORS)
  // and localhost isn't reachable from the browser when WR isn't running locally.
  // This endpoint checks all environments server-side and returns the results.
  router.get('/admin/wr/pipeline-health', async (_req: Request, res: Response) => {
    const environments = [
      { name: 'Local', url: WR_LOCAL_URL, branch: 'develop' },
      { name: 'Staging', url: WR_STAGING_URL, branch: 'develop' },
      { name: 'Production', url: WR_PROD_URL, branch: 'main' },
    ];

    const results = await Promise.all(environments.map(async (env) => {
      try {
        const response = await fetch(`${env.url}/api/version`, {
          signal: AbortSignal.timeout(5000),
          headers: { 'Accept': 'application/json' },
        });
        if (!response.ok) {
          return { name: env.name, url: env.url, status: 'down' as const, branch: env.branch };
        }
        const data = await response.json();
        return {
          name: env.name,
          url: env.url,
          status: 'healthy' as const,
          branch: env.branch || data.branch,
          lastDeploy: data.buildTime,
          version: data.version,
        };
      } catch {
        return { name: env.name, url: env.url, status: 'down' as const, branch: env.branch };
      }
    }));

    res.json({ environments: results, checkedAt: new Date().toISOString() });
  });

  // AI Usage
  router.get('/admin/wr/ai-usage', async (_req: Request, res: Response) => {
    try { const r = await wrProxy(`${wrBase()}/api/admin/ai-usage`); res.status(r.status).json(r.body); }
    catch (err: any) { console.warn('[Admin] Proxy error:', err.message); res.status(500).json({ error: err.message }); }
  });

  // Billing (extended)
  router.get('/admin/wr/billing', async (_req: Request, res: Response) => {
    try { const r = await wrProxy(`${wrBase()}/api/admin/billing`); res.status(r.status).json(r.body); }
    catch (err: any) { console.warn('[Admin] Proxy error:', err.message); res.status(500).json({ error: err.message }); }
  });

  // Vercel Deploy Trigger
  router.post('/admin/wr/deploy', async (req: Request, res: Response) => {
    try { const r = await wrProxy(`${wrBase()}/api/admin/services/vercel/deploy`, { method: 'POST', body: JSON.stringify(req.body) }); res.status(r.status).json(r.body); }
    catch (err: any) { console.warn('[Admin] Proxy error:', err.message); res.status(500).json({ error: err.message }); }
  });

  // Hetzner Restart
  router.post('/admin/wr/hetzner/restart', async (req: Request, res: Response) => {
    try { const r = await wrProxy(`${wrBase()}/api/admin/services/hetzner/restart`, { method: 'POST', body: JSON.stringify(req.body) }); res.status(r.status).json(r.body); }
    catch (err: any) { console.warn('[Admin] Proxy error:', err.message); res.status(500).json({ error: err.message }); }
  });

  // User creation (via Supabase admin API directly from CUI server)
  router.post('/admin/wr/users/create', async (req: Request, res: Response) => {
    const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
    const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      res.status(500).json({ error: 'Supabase credentials not configured' });
      return;
    }
    try {
      const { email, password, name, role } = req.body;
      if (!email || !password) {
        res.status(400).json({ error: 'email and password required' });
        return;
      }
      const response = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
        method: 'POST',
        headers: {
          'apikey': SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email,
          password,
          email_confirm: true,
          user_metadata: { name: name || '', role: role || 'user' },
        }),
        signal: AbortSignal.timeout(15000),
      });
      const data = await response.json();
      res.status(response.status).json(data);
    } catch (err: any) {
      console.error('[Admin] POST /api/admin/wr/users/create error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // User deletion
  router.delete('/admin/wr/users/:id', async (req: Request, res: Response) => {
    const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
    const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      res.status(500).json({ error: 'Supabase credentials not configured' });
      return;
    }
    try {
      const response = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${req.params.id}`, {
        method: 'DELETE',
        headers: {
          'apikey': SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
        },
        signal: AbortSignal.timeout(15000),
      });
      if (response.status === 204) {
        res.json({ ok: true });
        return;
      }
      const data = await response.json();
      res.status(response.status).json(data);
    } catch (err: any) {
      console.error('[Admin] DELETE /api/admin/wr/users/:id error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Impersonation routes
  router.get('/admin/wr/impersonation', async (_req: Request, res: Response) => {
    try { const r = await wrProxy(`${wrBase()}/api/admin/impersonation`); res.status(r.status).json(r.body); }
    catch (err: any) { console.warn('[Admin] Proxy error:', err.message); res.status(500).json({ error: err.message }); }
  });

  router.post('/admin/wr/users/:id/impersonate', async (req: Request, res: Response) => {
    try { const r = await wrProxy(`${wrBase()}/api/admin/users/${req.params.id}/impersonate`, { method: 'POST' }); res.status(r.status).json(r.body); }
    catch (err: any) { console.warn('[Admin] Proxy error:', err.message); res.status(500).json({ error: err.message }); }
  });

  router.delete('/admin/wr/impersonation/:id/end', async (req: Request, res: Response) => {
    try { const r = await wrProxy(`${wrBase()}/api/admin/impersonation/${req.params.id}/end`, { method: 'DELETE' }); res.status(r.status).json(r.body); }
    catch (err: any) { console.warn('[Admin] Proxy error:', err.message); res.status(500).json({ error: err.message }); }
  });

  // ============================================================
  // Ops - Vercel Deployment Status
  // ============================================================

  // GET /api/ops/deployments -- Vercel deployment status for all tracked apps
  router.get('/ops/deployments', async (_req: Request, res: Response) => {
    const VERCEL_TOKEN = process.env.VERCEL_TOKEN ?? '';
    if (!VERCEL_TOKEN) {
      res.status(500).json({ error: 'VERCEL_TOKEN not set' });
      return;
    }
    try {
      const results = await Promise.all(VERCEL_APPS.map(async (app) => {
        try {
          const url = `https://api.vercel.com/v6/deployments?projectId=${app.projectSlug}&limit=1&target=production`;
          const response = await fetch(url, {
            headers: { Authorization: `Bearer ${VERCEL_TOKEN}` },
            signal: AbortSignal.timeout(10000),
          });
          if (!response.ok) {
            return { name: app.name, state: 'ERROR', error: `HTTP ${response.status}` };
          }
          const data: any = await response.json();
          const dep = data.deployments?.[0];
          if (!dep) return { name: app.name, state: 'UNKNOWN' };
          return {
            name: app.name,
            state: dep.state ?? 'UNKNOWN',
            url: dep.url ? `https://${dep.url}` : undefined,
            commitSha: dep.meta?.githubCommitSha?.slice(0, 7),
            commitMessage: dep.meta?.githubCommitMessage,
            ageMin: dep.createdAt ? Math.round((Date.now() - dep.createdAt) / 60000) : undefined,
          };
        } catch (err: any) {
          return { name: app.name, state: 'ERROR', error: err.message };
        }
      }));
      res.json({ deployments: results, checkedAt: new Date().toISOString() });
    } catch (err: any) {
      console.error('[Ops] GET /api/ops/deployments error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
