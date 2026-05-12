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
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

type Mode = 'private' | 'business' | 'rafael';

const SESSIONS_FILE = '/root/projekte/local-storage/sandbox-angel/sessions.json';

interface SessionEntry {
  sid: string;
  sessionHostPath: string;
}

type SessionsMap = Partial<Record<Mode, SessionEntry>>;

async function loadSessions(): Promise<SessionsMap> {
  try {
    const raw = await readFile(SESSIONS_FILE, 'utf8');
    return JSON.parse(raw) as SessionsMap;
  } catch {
    return {};
  }
}

async function saveSessions(sessions: SessionsMap): Promise<void> {
  await mkdir(dirname(SESSIONS_FILE), { recursive: true });
  await writeFile(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
}

const ADAPTER_PATHS: Record<Mode, string> = {
  private: '/root/projekte/werkingflow-production/packages/agent-sandbox/adapters/private-daemon.mjs',
  business: '/root/projekte/werkingflow-production/packages/agent-sandbox/adapters/business-daemon.mjs',
  rafael: '/root/projekte/werkingflow-production/packages/agent-sandbox/adapters/rafael-daemon.mjs',
};

const COOKIE_NAMES: Record<Mode, string> = {
  private: 'private-token',
  business: 'business-token',
  rafael: 'rafael-token',
};

// Warn at startup if env vars are missing
if (!process.env.SANDBOX_DAEMON_SECRET)    console.error('[sandbox-angel] MISSING required env: SANDBOX_DAEMON_SECRET');
if (!process.env.PRIVATE_ADAPTER_TOKEN)    console.error('[sandbox-angel] MISSING required env: PRIVATE_ADAPTER_TOKEN');
if (!process.env.BUSINESS_ADAPTER_TOKEN)   console.error('[sandbox-angel] MISSING required env: BUSINESS_ADAPTER_TOKEN');
if (!process.env.RAFAEL_ADAPTER_TOKEN)     console.error('[sandbox-angel] MISSING required env: RAFAEL_ADAPTER_TOKEN');

function requireEnv(): { daemonUrl: string; daemonSecret: string; tokens: Record<Mode, string> } {
  const daemonUrl = process.env.SANDBOX_DAEMON_URL ?? 'http://127.0.0.1:4090';
  const daemonSecret = process.env.SANDBOX_DAEMON_SECRET;
  const privateToken = process.env.PRIVATE_ADAPTER_TOKEN;
  const businessToken = process.env.BUSINESS_ADAPTER_TOKEN;
  const rafaelToken = process.env.RAFAEL_ADAPTER_TOKEN;

  if (!daemonSecret) throw new Error('[sandbox-angel] SANDBOX_DAEMON_SECRET not set');
  if (!privateToken) throw new Error('[sandbox-angel] PRIVATE_ADAPTER_TOKEN not set');
  if (!businessToken) throw new Error('[sandbox-angel] BUSINESS_ADAPTER_TOKEN not set');
  if (!rafaelToken) throw new Error('[sandbox-angel] RAFAEL_ADAPTER_TOKEN not set');

  return { daemonUrl, daemonSecret, tokens: { private: privateToken, business: businessToken, rafael: rafaelToken } };
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

// CUI and the sandbox daemon run on the same host as the same user (claude-user),
// so we seed directly into the session work-dir rather than going through the
// daemon's /seed endpoint (which would JSON-encode 41MB+ of workspace files).
async function seedDirect(
  adapter: Record<string, (...args: unknown[]) => unknown>,
  target: unknown,
  sessionHostPath: string,
): Promise<void> {
  const workDir = join(sessionHostPath, 'work');
  await (adapter.seedWorkdir as (target: unknown, dir: string) => Promise<void>)(target, workDir);
}

const router = Router();

// POST /api/sandbox-angel/:mode/start
router.post('/:mode/start', async (req: Request, res: Response) => {
  const mode = req.params.mode as Mode;
  if (mode !== 'private' && mode !== 'business' && mode !== 'rafael') {
    res.status(400).json({ error: 'mode must be private, business or rafael' });
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

  // Load persisted sessions and resolve an existingSid if the session dir still exists.
  const sessions = await loadSessions();
  const storedEntry = sessions[mode];
  const validExistingSid = storedEntry?.sid && existsSync(storedEntry.sessionHostPath)
    ? storedEntry.sid
    : undefined;

  const daemonRes = await fetch(`${env.daemonUrl}/sandbox/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Daemon-Secret': env.daemonSecret },
    body: JSON.stringify({ target, existingSid: validExistingSid }),
  });
  if (!daemonRes.ok) {
    res.status(502).json({ error: `daemon ${daemonRes.status}: ${await daemonRes.text()}` });
    return;
  }

  const { sid, token, expiresAt, proxyEnv, sessionHostPath, resumed } = await daemonRes.json() as {
    sid: string; token: string; expiresAt: string; proxyEnv: string; sessionHostPath: string; resumed: boolean;
  };

  if (resumed) {
    // Work dir already has files from the prior session — skip seed.
    // Update persisted entry only if something changed (shouldn't happen normally).
    if (sid !== storedEntry?.sid || sessionHostPath !== storedEntry?.sessionHostPath) {
      sessions[mode] = { sid, sessionHostPath };
      await saveSessions(sessions);
    }
  } else {
    await seedDirect(adapter, target, sessionHostPath);
    sessions[mode] = { sid, sessionHostPath };
    await saveSessions(sessions);
  }

  res.json({ sid, token, expiresAt, proxyEnv, sandboxEndpoint: `/api/sandbox-angel/${mode}`, resumed });
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

// Generic proxy for daemon GET endpoints that take ?sid=X&t=TOKEN auth.
async function proxyDaemonGet(env: ReturnType<typeof requireEnv>, daemonPath: string, query: Record<string, string | undefined>, res: Response): Promise<void> {
  const qp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v) qp.set(k, v);
  const r = await fetch(`${env.daemonUrl}${daemonPath}?${qp.toString()}`, {
    headers: { 'X-Daemon-Secret': env.daemonSecret },
  });
  const ct = r.headers.get('content-type') ?? 'application/json';
  res.status(r.status).setHeader('content-type', ct).send(await r.text());
}

// Generic proxy for daemon POST endpoints (auth via x-sandbox-token header).
async function proxyDaemonPost(env: ReturnType<typeof requireEnv>, daemonPath: string, body: Record<string, unknown>, sandboxToken: string, res: Response): Promise<void> {
  const r = await fetch(`${env.daemonUrl}${daemonPath}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Daemon-Secret': env.daemonSecret,
      'X-Sandbox-Token': sandboxToken,
    },
    body: JSON.stringify(body),
  });
  const ct = r.headers.get('content-type') ?? 'application/json';
  res.status(r.status).setHeader('content-type', ct).send(await r.text());
}

// GET /api/sandbox-angel/:mode/history
router.get('/:mode/history', async (req: Request, res: Response) => {
  let env: ReturnType<typeof requireEnv>;
  try { env = requireEnv(); }
  catch (e: unknown) { res.status(503).json({ error: (e as Error).message }); return; }
  const { sid, t, conversationId } = req.query as { sid?: string; t?: string; conversationId?: string };
  if (!sid || !t) { res.status(400).json({ error: 'sid + t required' }); return; }
  await proxyDaemonGet(env, '/sandbox/history', { sid, t, conversationId }, res);
});

// GET /api/sandbox-angel/:mode/conversations
router.get('/:mode/conversations', async (req: Request, res: Response) => {
  let env: ReturnType<typeof requireEnv>;
  try { env = requireEnv(); }
  catch (e: unknown) { res.status(503).json({ error: (e as Error).message }); return; }
  const { sid, t, includeArchived } = req.query as { sid?: string; t?: string; includeArchived?: string };
  if (!sid || !t) { res.status(400).json({ error: 'sid + t required' }); return; }
  await proxyDaemonGet(env, '/sandbox/conversations', { sid, t, includeArchived }, res);
});

// POST /api/sandbox-angel/:mode/conversation/:action
// Wraps daemon's /sandbox/conversation/new|switch|archive. Sandbox token comes
// from x-sandbox-token header; sid is in the body so daemon's auth helper
// finds it without us repeating it.
router.post('/:mode/conversation/:action', async (req: Request, res: Response) => {
  let env: ReturnType<typeof requireEnv>;
  try { env = requireEnv(); }
  catch (e: unknown) { res.status(503).json({ error: (e as Error).message }); return; }
  const { action } = req.params;
  if (action !== 'new' && action !== 'switch' && action !== 'archive') {
    res.status(404).json({ error: `unknown action: ${action}` });
    return;
  }
  const tok = (req.headers['x-sandbox-token'] as string) ?? '';
  await proxyDaemonPost(env, `/sandbox/conversation/${action}`, req.body as Record<string, unknown>, tok, res);
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
