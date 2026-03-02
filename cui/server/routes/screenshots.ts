import { Router } from 'express';
import { readFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync, copyFileSync } from 'fs';
import type { WebSocket } from 'ws';

const SCREENSHOT_DIR = '/tmp/cui-screenshots';
if (!existsSync(SCREENSHOT_DIR)) mkdirSync(SCREENSHOT_DIR, { recursive: true });

interface PanelScreenshot {
  panel: string;
  capturedAt: string;
  width: number;
  height: number;
  filePath: string;
}
const panelScreenshots = new Map<string, PanelScreenshot>();

// Error reports from frontend screenshot capture
const screenshotErrors = new Map<string, { error: string; at: string }>();

// Panel listing from frontend DOM introspection
let lastPanelList: { panels: Array<{ nodeId: string; visible: boolean; size: string }>; timestamp: string } | null = null;

// Shared Playwright helper: open CUI, navigate to project + tab, return page & browser
async function openCuiPanel(opts: { project?: string; tab?: string; nodeId?: string; wait?: number }) {
  const playwright = await import('playwright-core');
  const browser = await playwright.chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto('http://localhost:4005', { timeout: 20000 });
  await page.waitForSelector('.flexlayout__layout', { timeout: 10000 });
  await page.waitForTimeout(2000);

  // Navigate to project tab if specified
  if (opts.project) {
    await page.evaluate((proj) => {
      for (const btn of document.querySelectorAll('button')) {
        if ((btn.title || '').toLowerCase().includes(proj.toLowerCase())) { btn.click(); break; }
      }
    }, opts.project);
    await page.waitForTimeout(2000);
  }

  // Click on specific tab if specified
  if (opts.tab) {
    await page.evaluate((tabName) => {
      for (const t of document.querySelectorAll('.flexlayout__tab_button_content')) {
        if (t.textContent === tabName) { (t as HTMLElement).click(); break; }
      }
    }, opts.tab);
    await page.waitForTimeout(opts.wait ?? 3000);
  }

  return { browser, page };
}

export default function createScreenshotRoutes(deps: { broadcast: Function, clients: Set<WebSocket> }) {
  const { broadcast } = deps;
  const router = Router();

  // POST /api/screenshot/:panel — frontend posts PNG as base64
  router.post('/screenshot/:panel', (req, res) => {
    const { panel } = req.params;
    const { dataUrl, width, height } = req.body as { dataUrl?: string; width?: number; height?: number };
    if (!dataUrl?.startsWith('data:image/png;base64,')) {
      res.status(400).json({ error: 'dataUrl (PNG base64) required' });
      return;
    }
    const base64 = dataUrl.replace('data:image/png;base64,', '');
    const filePath = `${SCREENSHOT_DIR}/${panel}-${Date.now()}.png`;
    // Keep only latest per panel — delete old one
    const prev = panelScreenshots.get(panel);
    if (prev?.filePath && existsSync(prev.filePath)) {
      try { unlinkSync(prev.filePath); } catch (err) { console.warn('[Server] screenshot cleanup error:', err); }
    }
    writeFileSync(filePath, Buffer.from(base64, 'base64'));
    const meta: PanelScreenshot = { panel, capturedAt: new Date().toISOString(), width: width ?? 0, height: height ?? 0, filePath };
    panelScreenshots.set(panel, meta);
    broadcast({ type: 'screenshot-stored', panel, capturedAt: meta.capturedAt });
    console.log(`[Screenshot] Stored: ${panel} (${width}x${height}) → ${filePath}`);
    res.json({ ok: true, panel, capturedAt: meta.capturedAt, url: `/api/screenshot/${panel}.png` });
  });

  // GET /api/screenshot/:panel.png — serve PNG image directly
  router.get('/screenshot/:panel.png', (req, res) => {
    const panel = req.params.panel;
    const meta = panelScreenshots.get(panel);
    if (!meta || !existsSync(meta.filePath)) {
      res.status(404).send('No screenshot for panel: ' + panel);
      return;
    }
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', `inline; filename="${panel}-${meta.capturedAt.slice(0,10)}.png"`);
    res.send(readFileSync(meta.filePath));
  });

  // GET /api/screenshot/:panel — metadata only
  router.get('/screenshot/:panel', (req, res) => {
    const { panel } = req.params;
    const meta = panelScreenshots.get(panel);
    if (!meta) { res.status(404).json({ error: 'No screenshot for panel: ' + panel }); return; }
    res.json({ panel: meta.panel, capturedAt: meta.capturedAt, width: meta.width, height: meta.height, url: `/api/screenshot/${panel}.png` });
  });

  // GET /api/screenshot — list all screenshots
  router.get('/screenshot', (_req, res) => {
    const list = Array.from(panelScreenshots.values()).map(m => ({
      panel: m.panel, capturedAt: m.capturedAt, width: m.width, height: m.height,
      url: `/api/screenshot/${m.panel}.png`,
    }));
    res.json({ screenshots: list });
  });

  // POST /api/screenshot/:panel/error — frontend reports screenshot failure
  router.post('/screenshot/:panel/error', (req, res) => {
    const { panel } = req.params;
    const { error } = req.body as { error?: string };
    console.error(`[Screenshot] Frontend error for "${panel}": ${error}`);
    screenshotErrors.set(panel, { error: error || 'unknown', at: new Date().toISOString() });
    res.json({ ok: true });
  });

  // POST /api/screenshot/panels — frontend reports available panels
  router.post('/screenshot/panels', (req, res) => {
    lastPanelList = req.body as typeof lastPanelList;
    console.log(`[Panels] DOM reports ${lastPanelList?.panels?.length ?? 0} panels`);
    res.json({ ok: true });
  });

  // GET /api/panels — trigger frontend to list all panel node IDs in the DOM
  router.get('/panels', async (_req, res) => {
    lastPanelList = null;
    broadcast({ type: 'control:list-panels' });
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 200));
      if (lastPanelList) {
        res.json(lastPanelList);
        return;
      }
    }
    res.status(408).json({ error: 'No panel list received from frontend (is a browser connected?)' });
  });

  // POST /api/control/screenshot/request — trigger frontend to capture a panel screenshot
  // panel: component name (e.g. "admin-wr") OR nodeId (full or 6-char short)
  // wait: optional ms to wait (default 12000 — allows auto-add + render)
  // contentWait: optional ms the frontend waits after panel is visible before capturing (default 2000)
  // saveTo: optional absolute file path to save the PNG to
  router.post('/control/screenshot/request', async (req, res) => {
    const { panel, wait, contentWait, saveTo } = req.body as { panel?: string; wait?: number; contentWait?: number; saveTo?: string };
    if (!panel) { res.status(400).json({ error: 'panel required' }); return; }
    const waitMs = Math.min(wait ?? 12000, 30000);
    screenshotErrors.delete(panel);
    // Step 1: Ensure panel exists and is visible (LayoutManager adds/activates it)
    broadcast({ type: 'control:ensure-panel', component: panel });
    broadcast({ type: 'control:select-tab', target: panel });
    // Step 2: Wait for panel to render, then request screenshot
    await new Promise(r => setTimeout(r, 1500));
    broadcast({ type: 'control:screenshot-request', panel, contentWait: contentWait ?? 2000 });
    // Wait for screenshot OR error to arrive
    const before = panelScreenshots.get(panel)?.capturedAt;
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 200));
      const err = screenshotErrors.get(panel);
      if (err) {
        res.status(422).json({ error: err.error, panel });
        return;
      }
      const current = panelScreenshots.get(panel);
      if (current && current.capturedAt !== before) {
        // Optionally copy to saveTo path
        if (saveTo && current.filePath) {
          try { copyFileSync(current.filePath, saveTo); } catch (e: any) {
            console.error(`[Screenshot] Failed to copy to ${saveTo}:`, e.message);
          }
        }
        res.json({ ok: true, panel, capturedAt: current.capturedAt, url: `/api/screenshot/${panel}.png`, ...(saveTo ? { savedTo: saveTo } : {}) });
        return;
      }
    }
    res.status(408).json({ error: `Screenshot timeout after ${waitMs}ms — panel may not be visible or no browser connected` });
  });

  // GET /api/capture — Server-side screenshot using Playwright (no WebSocket needed)
  // Query params:
  //   target=full | target=<nodeId> | project=Team&tab=Virtual Office
  //   wait=3000 (ms to wait for content to load)
  //   mode=png (default) | mode=json (returns metadata + base64)
  router.get('/capture', async (req, res) => {
    const target = req.query.target as string || 'full';
    const project = req.query.project as string;
    const tab = req.query.tab as string;
    const wait = Math.min(parseInt(req.query.wait as string) || 3000, 15000);

    try {
      const { browser, page } = await openCuiPanel({ project, tab, wait });

      let screenshot: Buffer;
      let desc: string;

      if (target === 'full') {
        screenshot = await page.screenshot({ type: 'png', fullPage: false }) as Buffer;
        desc = project ? `${project}/${tab || 'default'}` : 'full';
      } else {
        // Find element by nodeId (full or partial)
        const selector = await page.evaluate((id) => {
          // Exact match
          let el = document.querySelector(`[data-node-id="${id}"]`);
          if (el) return `[data-node-id="${id}"]`;
          // Partial match
          for (const e of document.querySelectorAll('[data-node-id]')) {
            const nid = e.getAttribute('data-node-id') || '';
            if (nid.startsWith(id)) return `[data-node-id="${nid}"]`;
          }
          return null;
        }, target);

        if (!selector) {
          const available = await page.evaluate(() =>
            Array.from(document.querySelectorAll('[data-node-id]')).map(e => e.getAttribute('data-node-id'))
          );
          await browser.close();
          res.status(404).json({ error: `Panel "${target}" not found`, available });
          return;
        }

        const el = page.locator(selector);
        screenshot = await el.screenshot({ type: 'png' }) as Buffer;
        desc = `node-${target}`;
      }

      await browser.close();

      // Save to file
      const filePath = `${SCREENSHOT_DIR}/${desc.replace(/[^a-zA-Z0-9-]/g, '_')}-live-${Date.now()}.png`;
      writeFileSync(filePath, screenshot);

      // Store in panelScreenshots map so it's retrievable via /api/screenshot/:panel.png
      const meta: PanelScreenshot = { panel: target, capturedAt: new Date().toISOString(), width: 0, height: 0, filePath };
      panelScreenshots.set(target, meta);

      console.log(`[Screenshot] Playwright: ${desc} (${screenshot.length} bytes) → ${filePath}`);

      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'no-cache');
      res.send(screenshot);
    } catch (error: any) {
      console.error('[Screenshot] Playwright error:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // Backward-compatible alias
  router.get('/dev/screenshot-live', (req, res) => {
    const nodeId = req.query.nodeId as string;
    const panel = req.query.panel as string;
    const target = nodeId || panel || 'full';
    res.redirect(`/api/capture?target=${encodeURIComponent(target)}&wait=${req.query.wait || '3000'}`);
  });

  // GET /api/capture/panels — List all panels via Playwright
  router.get('/capture/panels', async (req, res) => {
    const project = req.query.project as string;
    try {
      const { browser, page } = await openCuiPanel({ project });

      // Get all projects
      const projects = await page.evaluate(() => {
        const results: string[] = [];
        for (const btn of document.querySelectorAll('button')) {
          const title = btn.title || '';
          const m = title.match(/^(.+?)\s*—/);
          if (m) results.push(m[1].trim());
        }
        return results;
      });

      // Get panels for current project
      const panels = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-node-id]')).map(el => {
          const rect = el.getBoundingClientRect();
          return {
            nodeId: el.getAttribute('data-node-id'),
            visible: rect.width > 0 && rect.height > 0,
            size: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
          };
        })
      );

      // Get tab names
      const tabs = await page.evaluate(() => {
        const seen = new Set<string>();
        return Array.from(document.querySelectorAll('.flexlayout__tab_button_content'))
          .filter(el => { const r = el.getBoundingClientRect(); return r.top > 25 && r.top < 100; })
          .map(el => el.textContent?.trim() || '')
          .filter(t => { if (seen.has(t) || !t) return false; seen.add(t); return true; });
      });

      await browser.close();

      res.json({ projects, currentProject: project || projects[0], tabs, panels });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/control/panel/add', (req, res) => {
    const { component, config, name } = req.body;
    if (!component) { res.status(400).json({ error: 'component required' }); return; }
    broadcast({ type: 'control:panel-add', component, config: config ?? {}, name: name ?? component });
    res.json({ ok: true, component, name: name ?? component });
  });

  router.post('/control/panel/remove', (req, res) => {
    const { nodeId } = req.body;
    if (!nodeId) { res.status(400).json({ error: 'nodeId required' }); return; }
    broadcast({ type: 'control:panel-remove', nodeId });
    res.json({ ok: true, nodeId });
  });

  router.post('/control/layout/reset', (_req, res) => {
    broadcast({ type: 'control:layout-reset' });
    res.json({ ok: true });
  });

  return router;
}
