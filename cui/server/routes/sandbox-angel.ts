// CUI backend proxy route for the agent-sandbox daemon.
//
// Browser → /api/sandbox-angel/:mode/{start,exec,stop,stream}
//         → http://127.0.0.1:4090  (via X-Daemon-Secret)
//
// Adapters (private-daemon.mjs / business-daemon.mjs) are loaded dynamically.
// authenticate() receives the ENV token injected as a fake cookie, so the adapter
// validates without needing real browser credentials.
//
// Required env vars (add to CUI .env if missing):
//   SANDBOX_DAEMON_URL      (default: http://127.0.0.1:4090)
//   SANDBOX_DAEMON_SECRET
//   PRIVATE_ADAPTER_TOKEN
//   BUSINESS_ADAPTER_TOKEN

import { Router, type Request, type Response } from 'express';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { pathToFileURL } from 'node:url';

type Mode = 'private' | 'business';

const ADAPTER_PATHS: Record<Mode, string> = {
  private: '/root/projekte/werkingflow-production/packages/agent-sandbox/adapters/private-daemon.mjs',
  business: '/root/projekte/werkingflow-production/packages/agent-sandbox/adapters/business-daemon.mjs',
};

const COOKIE_NAMES: Record<Mode, string> = {
  private: 'private-token',
  business: 'business-token',
};

// Warn at startup if env vars are missing
if (!process.env.SANDBOX_DAEMON_SECRET)    console.error('[sandbox-angel] MISSING required env: SANDBOX_DAEMON_SECRET');
if (!process.env.PRIVATE_ADAPTER_TOKEN)    console.error('[sandbox-angel] MISSING required env: PRIVATE_ADAPTER_TOKEN');
if (!process.env.BUSINESS_ADAPTER_TOKEN)   console.error('[sandbox-angel] MISSING required env: BUSINESS_ADAPTER_TOKEN');

function requireEnv(): { daemonUrl: string; daemonSecret: string; tokens: Record<Mode, string> } {
  const daemonUrl = process.env.SANDBOX_DAEMON_URL ?? 'http://127.0.0.1:4090';
  const daemonSecret = process.env.SANDBOX_DAEMON_SECRET;
  const privateToken = process.env.PRIVATE_ADAPTER_TOKEN;
  const businessToken = process.env.BUSINESS_ADAPTER_TOKEN;

  if (!daemonSecret) throw new Error('[sandbox-angel] SANDBOX_DAEMON_SECRET not set');
  if (!privateToken) throw new Error('[sandbox-angel] PRIVATE_ADAPTER_TOKEN not set');
  if (!businessToken) throw new Error('[sandbox-angel] BUSINESS_ADAPTER_TOKEN not set');

  return { daemonUrl, daemonSecret, tokens: { private: privateToken, business: businessToken } };
}

const adapterCache = new Map<Mode, unknown>();

async function loadAdapter(mode: Mode): Promise<Record<string, (...args: unknown[]) => unknown>> {
  if (adapterCache.has(mode)) return adapterCache.get(mode) as Record<string, (...args: unknown[]) => unknown>;
  const url = pathToFileURL(ADAPTER_PATHS[mode]).href;
  const mod = await import(url) as { adapter?: unknown; default?: unknown };
  const adapter = (mod.adapter ?? (mod.default as { adapter?: unknown } | undefined)?.adapter ?? mod.default) as Record<string, (...args: unknown[]) => unknown>;
  adapterCache.set(mode, adapter);
  return adapter;
}

async function seedViaDaemon(
  adapter: Record<string, (...args: unknown[]) => unknown>,
  target: unknown,
  sid: string,
  token: string,
  daemonUrl: string,
  daemonSecret: string,
): Promise<void> {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'agent-seed-'));
  try {
    await (adapter.seedWorkdir as (target: unknown, dir: string) => Promise<void>)(target, tmpRoot);

    const payload: Record<string, string> = {};
    async function walk(dir: string, base: string): Promise<void> {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        const abs = join(dir, e.name);
        const rel = posix.join(base, e.name);
        if (e.isDirectory()) { await walk(abs, rel); }
        else if (e.isFile()) {
          const info = await stat(abs);
          if (info.size > 25 * 1024 * 1024) continue;
          payload[rel] = (await readFile(abs)).toString('base64');
        }
      }
    }
    await walk(tmpRoot, '');

    const seedUrl = `${daemonUrl}/sandbox/${encodeURIComponent(sid)}/seed?t=${encodeURIComponent(token)}`;
    const r = await fetch(seedUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Daemon-Secret': daemonSecret },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error(`seed ${r.status}: ${await r.text()}`);
  } finally {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}

const router = Router();

// POST /api/sandbox-angel/:mode/start
router.post('/:mode/start', async (req: Request, res: Response) => {
  const mode = req.params.mode as Mode;
  if (mode !== 'private' && mode !== 'business') {
    res.status(400).json({ error: 'mode must be private or business' });
    return;
  }

  let env: ReturnType<typeof requireEnv>;
  try { env = requireEnv(); }
  catch (e: unknown) { res.status(503).json({ error: (e as Error).message }); return; }

  let adapter: Record<string, (...args: unknown[]) => unknown>;
  try { adapter = await loadAdapter(mode); }
  catch (e: unknown) { res.status(503).json({ error: `adapter load failed: ${(e as Error).message}` }); return; }

  const auth = await (adapter.authenticate as (req: { cookies: Record<string, string> }) => Promise<{ ok: boolean; status?: number; reason?: string; user?: unknown }>)(
    { cookies: { [COOKIE_NAMES[mode]]: env.tokens[mode] } },
  );
  if (!auth.ok) { res.status(auth.status ?? 401).json({ error: auth.reason }); return; }

  const { resourceId = 'main' } = req.body as { resourceId?: string };
  const profileId = `${mode}.assistant`;
  const target = await (adapter.resolveTarget as (input: { resourceId: string; profileId: string; user: unknown }) => Promise<unknown>)(
    { resourceId, profileId, user: auth.user },
  );

  const daemonRes = await fetch(`${env.daemonUrl}/sandbox/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Daemon-Secret': env.daemonSecret },
    body: JSON.stringify({ target }),
  });
  if (!daemonRes.ok) {
    res.status(502).json({ error: `daemon ${daemonRes.status}: ${await daemonRes.text()}` });
    return;
  }

  const { sid, token, expiresAt, proxyEnv } = await daemonRes.json() as {
    sid: string; token: string; expiresAt: string; proxyEnv: string;
  };

  await seedViaDaemon(adapter, target, sid, token, env.daemonUrl, env.daemonSecret);

  res.json({ sid, token, expiresAt, proxyEnv, sandboxEndpoint: `/api/sandbox-angel/${mode}` });
});

// POST /api/sandbox-angel/:mode/exec
router.post('/:mode/exec', async (req: Request, res: Response) => {
  let env: ReturnType<typeof requireEnv>;
  try { env = requireEnv(); }
  catch (e: unknown) { res.status(503).json({ error: (e as Error).message }); return; }

  const sandboxToken = (req.headers['x-sandbox-token'] as string) ?? '';
  const r = await fetch(`${env.daemonUrl}/sandbox/exec`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Daemon-Secret': env.daemonSecret,
      'X-Sandbox-Token': sandboxToken,
    },
    body: JSON.stringify(req.body),
  });
  const ct = r.headers.get('content-type') ?? 'application/json';
  res.status(r.status).setHeader('content-type', ct).send(await r.text());
});

// POST /api/sandbox-angel/:mode/stop
router.post('/:mode/stop', async (req: Request, res: Response) => {
  let env: ReturnType<typeof requireEnv>;
  try { env = requireEnv(); }
  catch (e: unknown) { res.status(503).json({ error: (e as Error).message }); return; }

  const sandboxToken = (req.headers['x-sandbox-token'] as string) ?? '';
  const r = await fetch(`${env.daemonUrl}/sandbox/stop`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Daemon-Secret': env.daemonSecret,
      'X-Sandbox-Token': sandboxToken,
    },
    body: JSON.stringify(req.body),
  });
  const ct = r.headers.get('content-type') ?? 'application/json';
  res.status(r.status).setHeader('content-type', ct).send(await r.text());
});

// GET /api/sandbox-angel/:mode/stream  (SSE proxy)
router.get('/:mode/stream', async (req: Request, res: Response) => {
  let env: ReturnType<typeof requireEnv>;
  try { env = requireEnv(); }
  catch (e: unknown) { res.status(503).json({ error: (e as Error).message }); return; }

  const { sid, t } = req.query as { sid?: string; t?: string };
  if (!sid || !t) { res.status(400).json({ error: 'sid + t required' }); return; }

  const upstream = await fetch(
    `${env.daemonUrl}/sandbox/stream?sid=${encodeURIComponent(sid)}&t=${encodeURIComponent(t)}`,
    { headers: { 'X-Daemon-Secret': env.daemonSecret } },
  );
  if (!upstream.ok || !upstream.body) {
    res.status(502).json({ error: `daemon ${upstream.status}` });
    return;
  }

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
    'Connection': 'keep-alive',
  });
  res.flushHeaders();

  const reader = upstream.body.getReader();
  req.on('close', () => { reader.cancel().catch(() => {}); });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } catch { /* client disconnected */ }
  res.end();
});

export default router;
