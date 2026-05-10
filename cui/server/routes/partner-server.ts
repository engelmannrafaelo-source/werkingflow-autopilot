/**
 * Partner-Server Health Dashboard.
 *
 * Renders the CUI as each user with each of their workspaces selected,
 * captures a full screenshot, and returns the result. Admin can verify at a
 * glance whether every partner sees a working setup on login.
 *
 * Two operating modes (mutually exclusive):
 *   1. NATIVE  — runs Playwright locally. Used on partner-server.
 *   2. FORWARD — proxies all requests to a remote NATIVE instance via
 *      `CUI_PARTNER_FORWARD_URL` + `CUI_PARTNER_INTERNAL_TOKEN`. Used on
 *      dev-server so the panel works while partner does the actual work.
 *
 * Internal-token auth: when `x-cui-internal-token` matches the env var,
 * a synthetic admin user is attached and JWT auth is bypassed. This is what
 * lets a forwarded request from dev hit partner without needing a per-user JWT.
 */

import { Router } from 'express';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join, basename } from 'path';
import { signJwt } from '../auth/jwt.js';
import { getUsers, findUser } from '../auth/users.js';
import { PATHS } from '../config/paths.js';
import { isForwardMode, adminOrInternal, forwardToPartner } from '../lib/partner-forward.js';
import { prepareJourney } from '../lib/journey-runner.js';
import { findJsonlPathAllAccounts, readConversationMessages } from './shared/jsonl.js';
import type { CuiUser } from '../auth/types.js';

const IS_PARTNER = process.env.PARTNER_MODE === '1' || process.env.PARTNER_CUI === '1';

// Per-user → Anthropic-account mapping. On partner-server only `sahori` and
// `kurt` are valid (other accountIds resolve to "unknown account"). Kurt's
// account is reserved for kurt-engelmann; everyone else routes through sahori.
function journeyAccountFor(userId: string): string {
  if (!IS_PARTNER) return 'engelmann';
  if (userId === 'kurt-engelmann') return 'kurt';
  return 'sahori';
}

const APP_PORTS: Record<string, number> = {
  'werking-energy': 3007,
  'werking-report': 3008,
  'werking-safety': 3006,
  'engelmann': 3009,
};

// Workspace → backend app name (must match APP_PORTS keys + filesystem path
// under apps/<app>/config/test-credentials.json).
const WORKSPACE_APP_MAP: Record<string, string> = {
  'werking-energy': 'werking-energy',
  'werking-report': 'werking-report',
  'werkingsafety': 'werking-safety',
  'engelmann-ai-hub': 'engelmann',
  'engelmann-developer': 'engelmann',
  'engelmann-dashboards': 'engelmann',
};

const HELPER_PATH = join(process.cwd(), 'server/lib/journey-action.mjs');

const SCREENSHOT_DIR = join(PATHS.dataDir, 'partner-checks', 'screenshots');
const STORAGE_BASE = join(PATHS.dataDir, 'partner-checks', 'journeys');
const LAYOUTS_DIR_LOCAL = join(PATHS.dataDir, 'layouts');
mkdirSync(SCREENSHOT_DIR, { recursive: true });
mkdirSync(STORAGE_BASE, { recursive: true });

interface CaptureMeta {
  userId: string;
  workspace: string;
  capturedAt: string;
  filePath: string;
  status: 'success' | 'error';
  error?: string;
  durationMs?: number;
}

const captures = new Map<string, CaptureMeta>();
const inFlight = new Set<string>();

function cellKey(userId: string, workspace: string) {
  return `${userId}__${workspace}`;
}

// Restore captures Map from disk on startup. Without this, every server restart
// makes the matrix endpoint return null screenshotUrls until each cell is captured
// again — even though the PNGs still exist on disk. Frontend then shows
// "No screenshot yet" everywhere.
function restoreCapturesFromDisk(): void {
  if (!existsSync(SCREENSHOT_DIR)) return;
  let restored = 0;
  for (const fileName of readdirSync(SCREENSHOT_DIR)) {
    if (!fileName.endsWith('.png')) continue;
    const base = fileName.slice(0, -4); // strip .png
    const sep = base.indexOf('__');
    if (sep < 0) continue;
    const userId = base.slice(0, sep);
    const workspace = base.slice(sep + 2);
    if (!userId || !workspace) continue;
    const filePath = join(SCREENSHOT_DIR, fileName);
    try {
      const st = statSync(filePath);
      captures.set(cellKey(userId, workspace), {
        userId,
        workspace,
        capturedAt: st.mtime.toISOString(),
        filePath,
        status: 'success',
      });
      restored++;
    } catch { /* skip unreadable file */ }
  }
  if (restored > 0) {
    console.log(`[Partner-Server] Restored ${restored} captures from ${SCREENSHOT_DIR}`);
  }
}
restoreCapturesFromDisk();

function listLayoutWorkspaces(): string[] {
  if (!existsSync(LAYOUTS_DIR_LOCAL)) return [];
  return readdirSync(LAYOUTS_DIR_LOCAL)
    .filter(f => f.endsWith('.json') && !f.includes('_template') && !f.includes('.bak'))
    .map(f => basename(f, '.json'));
}

function expandWorkspaces(user: CuiUser): string[] {
  if (user.allowedWorkspaces === '*') return listLayoutWorkspaces();
  return user.allowedWorkspaces;
}

function getBaseUrl(): string {
  if (process.env.CUI_CAPTURE_BASE_URL) return process.env.CUI_CAPTURE_BASE_URL;
  if (process.env.COOKIE_DOMAIN) {
    const host = process.env.COOKIE_DOMAIN.replace(/^\./, '');
    return `https://${host}`;
  }
  return 'http://localhost:4005';
}

function getCookieDomain(): string | null {
  if (process.env.COOKIE_DOMAIN) return process.env.COOKIE_DOMAIN;
  return null;
}

async function capturePlaywright(
  user: CuiUser,
  workspace: string,
  outFile: string
): Promise<{ durationMs: number }> {
  const t0 = Date.now();
  const playwright = await import('playwright-core');
  const browser = await playwright.chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--ignore-certificate-errors'],
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      ignoreHTTPSErrors: true,
    });

    const token = signJwt({
      sub: user.id,
      name: user.name,
      role: user.role,
      claudeAccountId: user.claudeAccountId,
    });

    const baseUrl = getBaseUrl();
    const url = new URL(baseUrl);
    const cookieDomain = getCookieDomain();

    const cookies: any[] = [{
      name: 'cui-token',
      value: token,
      domain: cookieDomain ?? url.hostname,
      path: '/',
      httpOnly: true,
      sameSite: 'Lax' as const,
      secure: url.protocol === 'https:',
    }];

    await context.addCookies(cookies);
    await context.addInitScript((ws) => {
      try {
        localStorage.setItem('cui-active-project', ws);
        localStorage.removeItem('cui-show-all-workspaces');
      } catch {}
    }, workspace);

    const page = await context.newPage();
    await page.goto(baseUrl + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });

    try {
      await page.waitForSelector('.flexlayout__layout', { timeout: 15000 });
    } catch {
      // Layout never rendered — likely auth or load error. Capture anyway.
    }

    await page.evaluate((ws) => {
      const buttons = Array.from(document.querySelectorAll('button'));
      for (const btn of buttons) {
        const title = (btn.getAttribute('title') || '').trim();
        const m = title.match(/^(.+?)\s*—\s*(\/[^\n]+)/);
        if (m && (m[2].endsWith('/' + ws) || m[1].toLowerCase().replace(/\s+/g, '-') === ws.toLowerCase())) {
          (btn as HTMLElement).click();
          return true;
        }
      }
      return false;
    }, workspace);

    await page.waitForTimeout(8000);

    await page.screenshot({ path: outFile, type: 'png', fullPage: false });

    return { durationMs: Date.now() - t0 };
  } finally {
    await browser.close();
  }
}

/**
 * Spawn a Sub-Session that drives `journey-action.mjs` to log into the app
 * and click around like a real user. Returns immediately with sessionId
 * (or null + error) — the Sub does its work asynchronously.
 */
async function spawnJourneySub(opts: {
  userId: string;
  workspace: string;
  app: string;
  port: number;
  email: string;
  password: string;
  journeyDir: string;
  journeyId: string;
  user: { name: string; role: string };
}): Promise<{ subSessionId: string | null; subSessionError: string | null; subSessionAccount: string }> {
  const { userId, workspace, app, port, email, password, journeyDir, user } = opts;
  const accountId = journeyAccountFor(userId);
  const wsForMission = IS_PARTNER
    ? `${PATHS.dataDir}/workspaces/${workspace}`
    : `/root/orchestrator/workspaces/${workspace}`;
  const baseUrl = `http://127.0.0.1:${port}`;
  const message = `Du bist **${user.name}** (${user.role}) und loggst dich gerade frisch in die App **${app}** ein, um sie auszuprobieren wie ein neuer User.

**Identität:** ${userId} (${user.name}, ${user.role})
**App:** ${app} auf ${baseUrl}
**Test-Login:** ${email}  /  ${password}
**Journey-Verzeichnis:** ${journeyDir}

**Browser-Helper** (du hast Bash + Read + Write — sonst nichts):
\`\`\`bash
node ${HELPER_PATH} ${journeyDir} <action> [args...]
\`\`\`

Actions (jede speichert/lädt Cookies in auth.json):
- \`login <baseUrl> <email> <password>\` → schreibt 01-login.png, 02-form-filled.png, 03-after-login.png. Antwort: \`{ ok, login_success, url, failure_reason? }\`
- \`goto <absoluteUrl> [--screenshot=<name.png>]\` → Navigation
- \`click <selector> [--screenshot=<name.png>] [--wait-ms=<n>]\` → CSS-Klick
- \`fill <selector> <value...>\` → Eingabe
- \`screenshot <name.png>\` → Nur Screenshot
- \`text <selector>\` → \`{ ok, text }\` — Element-Text
- \`dump\` → \`{ ok, url, title, headings, buttons_links, visible_text_excerpt }\`

**Deine Aufgabe — wie ein echter neuer User:**

1. **Login**: \`node ${HELPER_PATH} ${journeyDir} login ${baseUrl} ${email} ${password}\`
   Wenn \`login_success: false\` → schreibe Ergebnis in \`${journeyDir}/journey.md\` (Format unten) und HÖRE AUF.
2. **Übersicht**: \`node ${HELPER_PATH} ${journeyDir} dump\` — schau Headings + Buttons an.
3. **Klick durch 3-5 Hauptaktionen** (Sidebar-Items, "Neues Projekt", "Anlegen", erste Detail-Ansicht). Nach jedem Klick Screenshot mit \`--screenshot=04-...png\`, dann 05, 06, ...
4. Wenn ein Klick einen Fehler/Leere/etwas Unerwartetes zeigt → das ist ein Finding.
5. **Schreibe** \`${journeyDir}/journey.md\` im Pflicht-Format:

\`\`\`markdown
# Journey: ${app} / ${userId} / ${workspace}
Started: <ISO-timestamp>
Email: ${email}

## Was ich gemacht habe
- Schritt 1: ...
- Schritt 2: ...

## Was funktioniert
- ...

## Was nicht funktioniert / Findings
- ...

## Bewertung
works_e2e: true|false
rating: 1-5
summary: <1-2 Sätze>

loginSuccess: true|false
\`\`\`

Wenn Login fehlgeschlagen: zusätzlich Zeile \`❌ LOGIN FAILED: <reason>\` direkt nach \`loginSuccess: false\`.

**Limits:** maximal 12 Bash-Calls + 1 Write. Kein Edit auf App-Code. Keine Sub-Sub-Sessions. Knapp + ehrlich.`;

  try {
    const internalJwt = signJwt({
      sub: userId,
      name: `Journey: ${user.name}`,
      role: 'admin',
      claudeAccountId: accountId,
    });
    const startRes = await fetch('http://127.0.0.1:4005/api/mission/start', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${internalJwt}`,
      },
      body: JSON.stringify({
        accountId,
        workDir: wsForMission,
        subject: `Journey: ${user.name} / ${workspace}`,
        model: 'sonnet',
        message,
      }),
    });
    const startJson: any = await startRes.json().catch(() => ({}));
    if (startRes.ok && startJson?.sessionId) {
      return { subSessionId: startJson.sessionId, subSessionError: null, subSessionAccount: accountId };
    }
    return { subSessionId: null, subSessionError: startJson?.error || `HTTP ${startRes.status}`, subSessionAccount: accountId };
  } catch (e: any) {
    return { subSessionId: null, subSessionError: e?.message || String(e), subSessionAccount: accountId };
  }
}

async function runCapture(userId: string, workspace: string): Promise<CaptureMeta> {
  const user = findUser(userId);
  if (!user) throw new Error(`User not found: ${userId}`);

  const key = cellKey(userId, workspace);
  if (inFlight.has(key)) throw new Error('Capture already in progress for this cell');

  inFlight.add(key);
  const filePath = join(SCREENSHOT_DIR, `${userId}__${workspace}.png`);

  try {
    const { durationMs } = await capturePlaywright(user, workspace, filePath);
    const meta: CaptureMeta = {
      userId, workspace,
      capturedAt: new Date().toISOString(),
      filePath, status: 'success', durationMs,
    };
    captures.set(key, meta);
    return meta;
  } catch (err: any) {
    const meta: CaptureMeta = {
      userId, workspace,
      capturedAt: new Date().toISOString(),
      filePath: '', status: 'error',
      error: err?.message || String(err),
    };
    captures.set(key, meta);
    throw err;
  } finally {
    inFlight.delete(key);
  }
}

export default function createPartnerServerRoutes() {
  const router = Router();

  if (isForwardMode()) {
    router.use(adminOrInternal);
    router.get('/health', async (_req, res) => {
      const target = process.env.CUI_PARTNER_FORWARD_URL!.replace(/\/$/, '') + '/api/partner-server/health';
      let upstream: any = null;
      try {
        const r = await fetch(target, { headers: { 'x-cui-internal-token': process.env.CUI_PARTNER_INTERNAL_TOKEN! } });
        upstream = r.ok ? await r.json() : { error: `upstream ${r.status}` };
      } catch (err: any) {
        upstream = { error: err.message };
      }
      res.json({
        mode: 'forward',
        forwardUrl: process.env.CUI_PARTNER_FORWARD_URL,
        upstream,
      });
    });
    router.use(forwardToPartner);
    return router;
  }

  router.use(adminOrInternal);

  router.get('/health', (_req, res) => {
    res.json({
      mode: 'native',
      baseUrl: getBaseUrl(),
      cookieDomain: getCookieDomain(),
      screenshotDir: SCREENSHOT_DIR,
      captureCount: captures.size,
      inFlight: Array.from(inFlight),
    });
  });

  router.get('/matrix', (_req, res) => {
    const users = getUsers();
    const cells: Array<any> = [];
    for (const u of users) {
      const wss = expandWorkspaces(u);
      for (const ws of wss) {
        const key = cellKey(u.id, ws);
        const meta = captures.get(key);
        cells.push({
          userId: u.id,
          userName: u.name,
          role: u.role,
          claudeAccountId: u.claudeAccountId,
          workspace: ws,
          capturedAt: meta?.capturedAt ?? null,
          status: meta?.status ?? null,
          error: meta?.error ?? null,
          durationMs: meta?.durationMs ?? null,
          inFlight: inFlight.has(key),
          screenshotUrl: meta?.status === 'success'
            ? `/api/partner-server/screenshot?u=${encodeURIComponent(u.id)}&w=${encodeURIComponent(ws)}&_=${meta.capturedAt}`
            : null,
        });
      }
    }
    res.json({
      baseUrl: getBaseUrl(),
      users: users.map(u => ({
        id: u.id, name: u.name, role: u.role,
        allowedWorkspaces: u.allowedWorkspaces, devPortRange: u.devPortRange,
      })),
      cells,
    });
  });

  router.post('/capture', async (req, res) => {
    const { userId, workspace } = req.body as { userId?: string; workspace?: string };
    if (!userId || !workspace) {
      res.status(400).json({ error: 'userId and workspace required' });
      return;
    }
    try {
      const meta = await runCapture(userId, workspace);
      res.json({
        ok: true,
        userId: meta.userId, workspace: meta.workspace,
        capturedAt: meta.capturedAt,
        durationMs: meta.durationMs,
        screenshotUrl: `/api/partner-server/screenshot?u=${encodeURIComponent(meta.userId)}&w=${encodeURIComponent(meta.workspace)}&_=${meta.capturedAt}`,
      });
    } catch (err: any) {
      const msg = err?.message || String(err);
      console.error(`[partner-server] capture failed for ${userId}/${workspace}:`, msg);
      const status = msg.includes('already in progress') ? 409
        : msg.includes('not found') ? 404 : 500;
      res.status(status).json({ error: msg });
    }
  });

  router.post('/capture-all', async (req, res) => {
    const { onlyMissing } = (req.body || {}) as { onlyMissing?: boolean };
    const users = getUsers();
    const results: Array<{ userId: string; workspace: string; status: 'success' | 'error'; durationMs?: number; error?: string }> = [];

    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders?.();

    for (const u of users) {
      for (const ws of expandWorkspaces(u)) {
        const key = cellKey(u.id, ws);
        if (onlyMissing && captures.get(key)?.status === 'success') {
          const skip = { userId: u.id, workspace: ws, status: 'success' as const, skipped: true };
          results.push(skip as any);
          res.write(JSON.stringify(skip) + '\n');
          continue;
        }
        try {
          const meta = await runCapture(u.id, ws);
          const r = { userId: u.id, workspace: ws, status: 'success' as const, durationMs: meta.durationMs };
          results.push(r);
          res.write(JSON.stringify(r) + '\n');
        } catch (err: any) {
          const r = { userId: u.id, workspace: ws, status: 'error' as const, error: err?.message || String(err) };
          results.push(r);
          res.write(JSON.stringify(r) + '\n');
        }
      }
    }

    res.write(JSON.stringify({ done: true, total: results.length, success: results.filter(r => r.status === 'success').length }) + '\n');
    res.end();
  });

  router.delete('/capture/:userId/:workspace', (req, res) => {
    const { userId, workspace } = req.params;
    const key = cellKey(userId, workspace);
    const had = captures.delete(key);
    res.json({ ok: true, removed: had });
  });

  router.get('/screenshot', (req, res) => {
    const userId = String(req.query.u || '');
    const workspace = String(req.query.w || '');
    if (!userId || !workspace) { res.status(400).send('u and w required'); return; }
    const meta = captures.get(cellKey(userId, workspace));
    if (!meta || !existsSync(meta.filePath)) {
      const fallbackPath = join(SCREENSHOT_DIR, `${userId}__${workspace}.png`);
      if (existsSync(fallbackPath)) {
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'no-cache');
        res.send(readFileSync(fallbackPath));
        return;
      }
      res.status(404).send('No screenshot');
      return;
    }
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(readFileSync(meta.filePath));
  });

  // ── Journey endpoints ────────────────────────────────────────────────────

  router.post('/journey/run', async (req, res) => {
    const { userId, workspace, app: appOverride } = req.body as { userId?: string; workspace?: string; app?: string };
    if (!userId || !workspace) {
      res.status(400).json({ error: 'userId and workspace required' });
      return;
    }
    const app = appOverride || WORKSPACE_APP_MAP[workspace];
    if (!app) {
      res.status(400).json({ error: `Workspace ${workspace} has no journey mapping` });
      return;
    }
    const port = APP_PORTS[app];
    if (!port) {
      res.status(400).json({ error: `Unknown app: ${app}. Known: ${Object.keys(APP_PORTS).join(', ')}` });
      return;
    }
    const user = findUser(userId);
    if (!user) {
      res.status(404).json({ error: `User not found: ${userId}` });
      return;
    }
    const credPath = `/home/${userId}/projekte/werkingflow-production/apps/${app}/config/test-credentials.json`;
    if (!existsSync(credPath)) {
      res.status(404).json({ error: `test-credentials.json not found: ${credPath}` });
      return;
    }
    let email: string;
    let password: string;
    try {
      const creds = JSON.parse(readFileSync(credPath, 'utf8'));
      const defaultKey: string = creds.default_user;
      const def = creds.users?.[defaultKey];
      if (!def?.email || !def?.password) throw new Error(`No credentials for default_user="${defaultKey}"`);
      email = def.email;
      password = def.password;
    } catch (err: any) {
      res.status(500).json({ error: `Failed to read credentials: ${err.message}` });
      return;
    }
    try {
      const { journeyId, dirPath } = prepareJourney(STORAGE_BASE, userId, workspace);
      const spawn = await spawnJourneySub({
        userId, workspace, app, port, email, password,
        journeyDir: dirPath, journeyId,
        user: { name: user.name, role: user.role },
      });
      try {
        writeFileSync(join(dirPath, 'meta.json'), JSON.stringify({
          journeyId, userId, workspace, app,
          createdAt: new Date().toISOString(),
          subSessionId: spawn.subSessionId,
          subSessionError: spawn.subSessionError,
          subSessionAccount: spawn.subSessionAccount,
        }, null, 2), 'utf8');
      } catch (e: any) {
        console.error('[partner-server] meta.json write failed:', e.message);
      }
      const status = spawn.subSessionId ? 200 : 502;
      res.status(status).json({
        success: !!spawn.subSessionId,
        journeyId,
        dirPath,
        subSessionId: spawn.subSessionId,
        subSessionError: spawn.subSessionError,
        subSessionAccount: spawn.subSessionAccount,
      });
    } catch (err: any) {
      console.error('[partner-server] journey/run failed:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Bulk: spawns one journey-sub per user × mapped workspace. Streams NDJSON
  // so the panel sees progress in real-time. Each sub does its work async —
  // the response returns once all subs are SPAWNED, not when they finish.
  // Optional body { userId }: restrict to a single user.
  router.post('/journey/run-all', async (req, res) => {
    const { userId: filterUserId } = (req.body || {}) as { userId?: string };
    let users = getUsers().filter(u => u.role !== 'admin');
    if (filterUserId) users = users.filter(u => u.id === filterUserId);
    if (filterUserId && users.length === 0) {
      res.status(404).json({ error: `User not found: ${filterUserId}` });
      return;
    }
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders?.();

    const results: Array<{ userId: string; workspace: string; journeyId?: string; subSessionId?: string | null; error?: string }> = [];

    for (const u of users) {
      for (const ws of expandWorkspaces(u)) {
        const app = WORKSPACE_APP_MAP[ws];
        if (!app) continue;
        const port = APP_PORTS[app];
        if (!port) continue;

        const credPath = `/home/${u.id}/projekte/werkingflow-production/apps/${app}/config/test-credentials.json`;
        if (!existsSync(credPath)) {
          const r = { userId: u.id, workspace: ws, error: 'no test-credentials.json' };
          results.push(r); res.write(JSON.stringify(r) + '\n'); continue;
        }
        let email: string, password: string;
        try {
          const creds = JSON.parse(readFileSync(credPath, 'utf8'));
          const def = creds.users?.[creds.default_user];
          if (!def?.email || !def?.password) throw new Error('no default_user creds');
          email = def.email; password = def.password;
        } catch (e: any) {
          const r = { userId: u.id, workspace: ws, error: `creds: ${e.message}` };
          results.push(r); res.write(JSON.stringify(r) + '\n'); continue;
        }

        try {
          const { journeyId, dirPath } = prepareJourney(STORAGE_BASE, u.id, ws);
          const spawn = await spawnJourneySub({
            userId: u.id, workspace: ws, app, port, email, password,
            journeyDir: dirPath, journeyId,
            user: { name: u.name, role: u.role },
          });
          try {
            writeFileSync(join(dirPath, 'meta.json'), JSON.stringify({
              journeyId, userId: u.id, workspace: ws, app,
              createdAt: new Date().toISOString(),
              subSessionId: spawn.subSessionId,
              subSessionError: spawn.subSessionError,
              subSessionAccount: spawn.subSessionAccount,
            }, null, 2), 'utf8');
          } catch { /* ignore */ }
          const r = {
            userId: u.id, workspace: ws, journeyId,
            subSessionId: spawn.subSessionId,
            error: spawn.subSessionError || undefined,
          };
          results.push(r);
          res.write(JSON.stringify(r) + '\n');
        } catch (err: any) {
          const r = { userId: u.id, workspace: ws, error: err?.message || String(err) };
          results.push(r);
          res.write(JSON.stringify(r) + '\n');
        }

        // Throttle: journeyId is second-precision, so back-to-back spawns within
        // the same second collide on the same dirPath. 1.1s between spawns also
        // smooths out load on /api/mission/start.
        await new Promise(r => setTimeout(r, 1100));
      }
    }

    res.write(JSON.stringify({
      done: true,
      total: results.length,
      spawned: results.filter(r => r.subSessionId).length,
    }) + '\n');
    res.end();
  });

  router.get('/journey/list', (req, res) => {
    const userId = String(req.query.userId || '');
    if (!userId) {
      res.status(400).json({ error: 'userId query param required' });
      return;
    }
    const userDir = join(STORAGE_BASE, userId);
    if (!existsSync(userDir)) {
      res.json([]);
      return;
    }
    const items: Array<{
      userId: string;
      workspace: string;
      journeyId: string;
      capturedAt: string;
      screenshotCount: number;
      loginSuccess: boolean | null;
      failureReason: string | null;
      rating: number | null;
      worksE2e: boolean | null;
      summary: string | null;
    }> = [];
    for (const ws of readdirSync(userDir)) {
      const wsDir = join(userDir, ws);
      try {
        if (!statSync(wsDir).isDirectory()) continue;
      } catch { continue; }
      for (const jid of readdirSync(wsDir)) {
        const jDir = join(wsDir, jid);
        try {
          if (!statSync(jDir).isDirectory()) continue;
        } catch { continue; }
        const pngs = readdirSync(jDir).filter(f => f.endsWith('.png'));
        // journeyId format: YYYYMMDD-HHMMSS → parse to ISO
        const m = jid.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/);
        const capturedAt = m
          ? new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`).toISOString()
          : statSync(jDir).mtime.toISOString();
        // Parse journey.md for loginSuccess + failureReason. Older runs predate
        // failure-detection: leave both null so the UI can show "unknown" instead
        // of falsely greenlighting them.
        let loginSuccess: boolean | null = null;
        let failureReason: string | null = null;
        const mdPath = join(jDir, 'journey.md');
        if (existsSync(mdPath)) {
          const md = readFileSync(mdPath, 'utf8');
          const ls = md.match(/^loginSuccess:\s*(true|false)\s*$/m);
          if (ls) loginSuccess = ls[1] === 'true';
          const fr = md.match(/❌ LOGIN FAILED:\s*(.+)/);
          if (fr) failureReason = fr[1].trim();
        }
        // AI evaluation (written by journey-evaluator.ts after the run).
        // Older runs and runs where the Bridge call failed have no file → null.
        let rating: number | null = null;
        let worksE2e: boolean | null = null;
        let summary: string | null = null;
        const evalPath = join(jDir, 'evaluation.json');
        if (existsSync(evalPath)) {
          try {
            const ev = JSON.parse(readFileSync(evalPath, 'utf8'));
            if (typeof ev.rating === 'number') rating = ev.rating;
            if (typeof ev.works_e2e === 'boolean') worksE2e = ev.works_e2e;
            if (typeof ev.summary === 'string') summary = ev.summary;
          } catch { /* corrupt eval — show as null */ }
        }
        items.push({ userId, workspace: ws, journeyId: jid, capturedAt, screenshotCount: pngs.length, loginSuccess, failureReason, rating, worksE2e, summary });
      }
    }
    items.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
    res.json(items);
  });

  router.get('/journey/:userId/:workspace/:journeyId', (req, res) => {
    const { userId, workspace, journeyId } = req.params;
    const jDir = join(STORAGE_BASE, userId, workspace, journeyId);
    if (!existsSync(jDir)) {
      res.status(404).json({ error: 'Journey not found' });
      return;
    }
    let markdown = '';
    const mdPath = join(jDir, 'journey.md');
    if (existsSync(mdPath)) markdown = readFileSync(mdPath, 'utf8');
    let evaluation: any = null;
    const evalPath = join(jDir, 'evaluation.json');
    if (existsSync(evalPath)) {
      try { evaluation = JSON.parse(readFileSync(evalPath, 'utf8')); } catch { evaluation = null; }
    }
    let meta: any = null;
    const metaPath = join(jDir, 'meta.json');
    if (existsSync(metaPath)) {
      try { meta = JSON.parse(readFileSync(metaPath, 'utf8')); } catch { meta = null; }
    }
    const screenshots = readdirSync(jDir)
      .filter(f => f.endsWith('.png'))
      .sort()
      .map(name => ({
        name,
        url: `/api/partner-server/journey/file/${encodeURIComponent(userId)}/${encodeURIComponent(workspace)}/${encodeURIComponent(journeyId)}/${encodeURIComponent(name)}`,
      }));
    res.json({ markdown, screenshots, evaluation, meta });
  });

  // Returns the chat history of the sub-session that walked through this journey.
  // Reads jsonl via findJsonlPathAllAccounts (cross-account search) and parses it.
  router.get('/journey/:userId/:workspace/:journeyId/chat', (req, res) => {
    const { userId, workspace, journeyId } = req.params;
    const jDir = join(STORAGE_BASE, userId, workspace, journeyId);
    const metaPath = join(jDir, 'meta.json');
    if (!existsSync(metaPath)) {
      res.status(404).json({ error: 'No meta.json — journey predates sub-session feature' });
      return;
    }
    let meta: any;
    try { meta = JSON.parse(readFileSync(metaPath, 'utf8')); } catch (e: any) {
      res.status(500).json({ error: `meta.json parse failed: ${e.message}` });
      return;
    }
    if (!meta.subSessionId) {
      res.status(404).json({ error: meta.subSessionError || 'No sub-session for this journey' });
      return;
    }
    const found = findJsonlPathAllAccounts(meta.subSessionId);
    if (!found) {
      res.status(404).json({ error: `jsonl not found for sub-session ${meta.subSessionId}` });
      return;
    }
    try {
      const { messages } = readConversationMessages(found.path);
      res.json({ sessionId: meta.subSessionId, accountDir: found.accountId, messages });
    } catch (e: any) {
      res.status(500).json({ error: `Failed to read jsonl: ${e.message}` });
    }
  });

  // Re-trigger evaluation for an existing journey (without rerunning Playwright).
  // Useful when the evaluator is updated or an old journey has no evaluation.
  router.post('/journey/:userId/:workspace/:journeyId/evaluate', async (req, res) => {
    const { userId, workspace, journeyId } = req.params;
    const jDir = join(STORAGE_BASE, userId, workspace, journeyId);
    if (!existsSync(jDir)) {
      res.status(404).json({ error: 'Journey not found' });
      return;
    }
    try {
      const { evaluateJourney } = await import('../lib/journey-evaluator.js');
      const evaluation = await evaluateJourney(jDir);
      res.json({ ok: true, evaluation });
    } catch (err: any) {
      console.error('[partner-server] evaluate failed:', err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.get('/journey/file/:userId/:workspace/:journeyId/:filename', (req, res) => {
    const { userId, workspace, journeyId, filename } = req.params;
    // Reject path traversal and non-PNG files
    if (!filename.endsWith('.png') || filename.includes('/') || filename.includes('..')) {
      res.status(400).send('Invalid filename');
      return;
    }
    const filePath = join(STORAGE_BASE, userId, workspace, journeyId, filename);
    if (!existsSync(filePath)) {
      res.status(404).send('Not found');
      return;
    }
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(readFileSync(filePath));
  });

  return router;
}
