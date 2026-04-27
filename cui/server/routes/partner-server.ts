/**
 * Partner-Server Health Dashboard.
 *
 * Renders the CUI as each user with each of their workspaces selected,
 * captures a full screenshot, and returns the result. Admin can verify at a
 * glance whether every partner sees a working setup on login.
 */

import { Router } from 'express';
import { existsSync, readFileSync, mkdirSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { signJwt } from '../auth/jwt.js';
import { getUsers, findUser } from '../auth/users.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { PATHS } from '../config/paths.js';
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

    // Click on the workspace button if not already active
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

    // Allow layout, iframes, panels to settle
    await page.waitForTimeout(8000);

    await page.screenshot({ path: outFile, type: 'png', fullPage: false });

    return { durationMs: Date.now() - t0 };
  } finally {
    await browser.close();
  }
}

export default function createPartnerServerRoutes() {
  const router = Router();

  router.use(requireAuth);

  router.get('/matrix', requireRole('admin'), (_req, res) => {
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

  router.post('/capture', requireRole('admin'), async (req, res) => {
    const { userId, workspace } = req.body as { userId?: string; workspace?: string };
    if (!userId || !workspace) {
      res.status(400).json({ error: 'userId and workspace required' });
      return;
    }
    const user = findUser(userId);
    if (!user) {
      res.status(404).json({ error: `User not found: ${userId}` });
      return;
    }

    const key = cellKey(userId, workspace);
    if (inFlight.has(key)) {
      res.status(409).json({ error: 'Capture already in progress for this cell' });
      return;
    }

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
      res.json({
        ok: true,
        userId, workspace,
        capturedAt: meta.capturedAt,
        durationMs,
        screenshotUrl: `/api/partner-server/screenshot?u=${encodeURIComponent(userId)}&w=${encodeURIComponent(workspace)}&_=${meta.capturedAt}`,
      });
    } catch (err: any) {
      const meta: CaptureMeta = {
        userId, workspace,
        capturedAt: new Date().toISOString(),
        filePath: '', status: 'error',
        error: err?.message || String(err),
      };
      captures.set(key, meta);
      console.error(`[partner-server] capture failed for ${userId}/${workspace}:`, err);
      res.status(500).json({ error: meta.error });
    } finally {
      inFlight.delete(key);
    }
  });

  router.get('/screenshot', requireRole('admin'), (req, res) => {
    const userId = String(req.query.u || '');
    const workspace = String(req.query.w || '');
    if (!userId || !workspace) { res.status(400).send('u and w required'); return; }
    const meta = captures.get(cellKey(userId, workspace));
    if (!meta || !existsSync(meta.filePath)) {
      // Fallback: construct from disk if server restarted
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
