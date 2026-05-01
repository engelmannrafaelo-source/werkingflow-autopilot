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
import { existsSync, readFileSync, mkdirSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { signJwt } from '../auth/jwt.js';
import { getUsers, findUser } from '../auth/users.js';
import { PATHS } from '../config/paths.js';
import { isForwardMode, adminOrInternal, forwardToPartner } from '../lib/partner-forward.js';
import type { CuiUser } from '../auth/types.js';

const SCREENSHOT_DIR = join(PATHS.dataDir, 'partner-checks', 'screenshots');
const LAYOUTS_DIR_LOCAL = join(PATHS.dataDir, 'layouts');
mkdirSync(SCREENSHOT_DIR, { recursive: true });

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

  return router;
}
