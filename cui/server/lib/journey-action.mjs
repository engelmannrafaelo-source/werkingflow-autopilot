#!/usr/bin/env node
// Persistent-state Playwright wrapper for Journey Sub-Sessions.
//
// Sub-Session calls this via Bash:
//   node <this> <journeyDir> <action> [args...]
//
// Each call:
//   - opens a fresh Chromium instance
//   - re-loads cookies/localStorage from <journeyDir>/auth.json (if present)
//   - executes the action
//   - persists the storage state back to auth.json
//   - prints JSON to stdout (single line) on success
//   - prints JSON to stderr + exits non-zero on failure
//
// Actions:
//   login <baseUrl> <email> <password>
//     -> writes 01-login.png, 02-form-filled.png, 03-after-login.png + auth.json
//     -> returns { ok, login_success, url }
//
//   goto <url> [--screenshot=<name>]
//   click <selector> [--screenshot=<name>] [--wait-ms=<ms>]
//   fill <selector> <value...>
//   screenshot <name>
//   text <selector>             -> { ok, text }
//   dump                        -> { ok, url, title, headings[], buttons_links[], visible_text_excerpt }

import { promises as fs, existsSync } from 'fs';
import { join, resolve } from 'path';
import { createRequire } from 'module';
import process from 'process';

const requireFromHere = createRequire(import.meta.url);

async function loadPlaywright() {
  try { return await import('playwright'); } catch { /* fall through */ }
  // partner-server fallback: monorepo install
  for (const p of [
    '/home/david-steiner/projekte/werkingflow-production/node_modules/playwright',
    '/home/herbert-teufel/projekte/werkingflow-production/node_modules/playwright',
    '/root/projekte/werkingflow-production/node_modules/playwright',
  ]) {
    try { return requireFromHere(p); } catch { /* try next */ }
  }
  throw new Error('Could not locate Playwright. Install in CUI or werkingflow-production.');
}

function emitFail(obj, code = 1) {
  process.stderr.write(JSON.stringify(obj) + '\n');
  process.exit(code);
}

function flag(args, prefix) {
  const a = args.find(x => x.startsWith(prefix));
  return a ? a.slice(prefix.length) : null;
}

/**
 * Sequence mode: read actions.json, run every action in ONE browser context.
 * This is the recommended mode — single-action calls reload storage_state
 * from disk each time, which loses Supabase / SSR-cookie sessions because
 * the in-memory token-refresh-loop is gone after the previous browser closed.
 */
async function runSequence(journeyDir, seqFile) {
  const authPath = join(journeyDir, 'auth.json');
  const actions = JSON.parse(await fs.readFile(seqFile, 'utf8'));
  if (!Array.isArray(actions)) throw new Error('seq file must be a JSON array of actions');

  const pw = await loadPlaywright();
  const browser = await pw.chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });
  const ctxOpts = { viewport: { width: 1440, height: 900 } };
  if (existsSync(authPath)) ctxOpts.storageState = authPath;
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();

  const results = [];
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    const step = { idx: i, do: a.do, ok: true };
    try {
      if (a.do === 'login') {
        await page.goto(`${a.baseUrl}/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.screenshot({ path: join(journeyDir, '01-login.png'), type: 'png' });
        await page.fill('input[type="email"], input[name="email"], input[placeholder*="mail" i]', a.email);
        await page.fill('input[type="password"], input[name="password"]', a.password);
        await page.screenshot({ path: join(journeyDir, '02-form-filled.png'), type: 'png' });
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {}),
          page.click('button[type="submit"], button:has-text("Login"), button:has-text("Anmelden"), button:has-text("Einloggen")').catch(() => {}),
        ]);
        await page.waitForTimeout(2500);
        await page.screenshot({ path: join(journeyDir, '03-after-login.png'), type: 'png' });
        step.url = page.url();
        step.login_success = !step.url.includes('/login');
        if (!step.login_success) {
          for (const sel of ['[role="alert"]', '.error', '[class*="error" i]']) {
            const t = await page.locator(sel).first().textContent({ timeout: 500 }).catch(() => null);
            if (t && t.trim()) { step.failure_reason = t.trim().slice(0, 300); break; }
          }
        }
      } else if (a.do === 'goto') {
        await page.goto(a.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(a.waitMs || 1500);
        if (a.screenshot) await page.screenshot({ path: join(journeyDir, a.screenshot), type: 'png' });
        step.url = page.url();
      } else if (a.do === 'click') {
        await page.click(a.selector, { timeout: 10000 });
        await page.waitForTimeout(a.waitMs || 1500);
        if (a.screenshot) await page.screenshot({ path: join(journeyDir, a.screenshot), type: 'png' });
        step.url = page.url();
      } else if (a.do === 'fill') {
        await page.fill(a.selector, a.value);
      } else if (a.do === 'screenshot') {
        await page.screenshot({ path: join(journeyDir, a.name), type: 'png' });
      } else if (a.do === 'text') {
        const t = await page.locator(a.selector).first().textContent({ timeout: 5000 }).catch(() => null);
        step.text = (t || '').slice(0, 1500);
      } else if (a.do === 'dump') {
        const title = await page.title().catch(() => '');
        const headings = [];
        for (const sel of ['h1', 'h2']) {
          const locs = page.locator(sel);
          const n = Math.min(await locs.count(), 8);
          for (let j = 0; j < n; j++) {
            const t = ((await locs.nth(j).textContent({ timeout: 500 }).catch(() => '')) || '').trim();
            if (t) headings.push(`${sel}: ${t.slice(0, 100)}`);
          }
        }
        const buttons = [];
        for (const sel of ['button', 'a[href]', '[role="button"]']) {
          const locs = page.locator(sel);
          const n = Math.min(await locs.count(), 25);
          for (let j = 0; j < n; j++) {
            const t = ((await locs.nth(j).textContent({ timeout: 500 }).catch(() => '')) || '').trim();
            if (t && t.length < 80) buttons.push(`${sel}: ${t}`);
          }
        }
        const body = ((await page.locator('body').textContent({ timeout: 2000 }).catch(() => '')) || '').replace(/\s+/g, ' ').trim();
        step.url = page.url();
        step.title = title;
        step.headings = headings;
        step.buttons_links = buttons.slice(0, 40);
        step.visible_text_excerpt = body.slice(0, 1500);
      } else if (a.do === 'wait') {
        await page.waitForTimeout(a.ms || 1000);
      } else {
        step.ok = false;
        step.error = `Unknown action: ${a.do}`;
      }
    } catch (e) {
      step.ok = false;
      step.error = String(e?.message || e);
      try { step.url = page.url(); } catch { /* ignore */ }
    }
    results.push(step);
    if (!step.ok && a.stopOnError !== false) break;
  }

  try { await ctx.storageState({ path: authPath }); } catch { /* ignore */ }
  try { await browser.close(); } catch { /* already closed */ }
  await fs.writeFile(join(journeyDir, 'seq-result.json'), JSON.stringify({ ok: true, steps: results }, null, 2));
  process.stdout.write(JSON.stringify({ ok: true, steps: results.length, dir: journeyDir }) + '\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const [journeyDirRaw, action, ...rest] = argv;
  if (!journeyDirRaw || !action) {
    emitFail({ ok: false, error: 'Usage: journey-action.mjs <journeyDir> <action> [args...]' }, 2);
  }
  const journeyDir = resolve(journeyDirRaw);
  await fs.mkdir(journeyDir, { recursive: true });
  const authPath = join(journeyDir, 'auth.json');

  // Sequence mode — preferred: one browser per Sub-Session, no session loss.
  if (action === 'seq') {
    const seqFile = rest[0];
    if (!seqFile) emitFail({ ok: false, error: 'seq needs <actions.json>' }, 2);
    try {
      await runSequence(journeyDir, seqFile);
      return;
    } catch (e) {
      emitFail({ ok: false, error: String(e?.message || e) });
    }
  }

  const pw = await loadPlaywright();
  const browser = await pw.chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });

  const ctxOpts = { viewport: { width: 1440, height: 900 } };
  if (action !== 'login' && existsSync(authPath)) {
    ctxOpts.storageState = authPath;
  }
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();

  const out = { ok: true };
  try {
    if (action === 'login') {
      const [baseUrl, email, password] = rest;
      if (!baseUrl || !email || !password) {
        throw new Error('login needs <baseUrl> <email> <password>');
      }
      await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.screenshot({ path: join(journeyDir, '01-login.png'), type: 'png' });
      await page.fill('input[type="email"], input[name="email"], input[placeholder*="mail" i]', email);
      await page.fill('input[type="password"], input[name="password"]', password);
      await page.screenshot({ path: join(journeyDir, '02-form-filled.png'), type: 'png' });
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {}),
        page.click('button[type="submit"], button:has-text("Login"), button:has-text("Anmelden"), button:has-text("Einloggen")').catch(() => {}),
      ]);
      await page.waitForTimeout(2500);
      await page.screenshot({ path: join(journeyDir, '03-after-login.png'), type: 'png' });
      out.url = page.url();
      out.login_success = !out.url.includes('/login');
      if (!out.login_success) {
        for (const sel of ['[role="alert"]', '.error', '[class*="error" i]', '[data-testid*="error" i]']) {
          const t = await page.locator(sel).first().textContent({ timeout: 500 }).catch(() => null);
          if (t && t.trim()) { out.failure_reason = t.trim().slice(0, 300); break; }
        }
        if (!out.failure_reason) out.failure_reason = `URL stayed on ${out.url} — login likely rejected.`;
      }
    }
    else if (action === 'goto') {
      const [url] = rest;
      if (!url) throw new Error('goto needs <url>');
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(1500);
      const shot = flag(rest, '--screenshot=');
      if (shot) await page.screenshot({ path: join(journeyDir, shot), type: 'png' });
      out.url = page.url();
    }
    else if (action === 'click') {
      const selector = rest[0];
      if (!selector) throw new Error('click needs <selector>');
      const waitMs = parseInt(flag(rest, '--wait-ms=') || '1500', 10);
      await page.click(selector, { timeout: 10000 });
      await page.waitForTimeout(waitMs);
      const shot = flag(rest, '--screenshot=');
      if (shot) await page.screenshot({ path: join(journeyDir, shot), type: 'png' });
      out.url = page.url();
    }
    else if (action === 'fill') {
      const [selector, ...rest2] = rest;
      const value = rest2.filter(x => !x.startsWith('--')).join(' ');
      if (!selector || !value) throw new Error('fill needs <selector> <value>');
      await page.fill(selector, value);
    }
    else if (action === 'screenshot') {
      const name = rest[0];
      if (!name) throw new Error('screenshot needs <name>');
      await page.screenshot({ path: join(journeyDir, name), type: 'png' });
    }
    else if (action === 'text') {
      const selector = rest[0];
      if (!selector) throw new Error('text needs <selector>');
      const t = await page.locator(selector).first().textContent({ timeout: 5000 }).catch(() => null);
      out.text = (t || '').slice(0, 1500);
    }
    else if (action === 'dump') {
      const title = await page.title().catch(() => '');
      const headings = [];
      for (const sel of ['h1', 'h2']) {
        const locs = page.locator(sel);
        const n = Math.min(await locs.count(), 8);
        for (let i = 0; i < n; i++) {
          const t = ((await locs.nth(i).textContent({ timeout: 500 }).catch(() => '')) || '').trim();
          if (t) headings.push(`${sel}: ${t.slice(0, 100)}`);
        }
      }
      const buttons = [];
      for (const sel of ['button', 'a[href]', '[role="button"]']) {
        const locs = page.locator(sel);
        const n = Math.min(await locs.count(), 25);
        for (let i = 0; i < n; i++) {
          const t = ((await locs.nth(i).textContent({ timeout: 500 }).catch(() => '')) || '').trim();
          if (t && t.length < 80) buttons.push(`${sel}: ${t}`);
        }
      }
      const body = ((await page.locator('body').textContent({ timeout: 2000 }).catch(() => '')) || '').replace(/\s+/g, ' ').trim();
      out.url = page.url();
      out.title = title;
      out.headings = headings;
      out.buttons_links = buttons.slice(0, 40);
      out.visible_text_excerpt = body.slice(0, 1500);
    }
    else {
      throw new Error(`Unknown action: ${action}`);
    }

    await ctx.storageState({ path: authPath });
    process.stdout.write(JSON.stringify(out) + '\n');
  } catch (e) {
    let curUrl;
    try { curUrl = page.url(); } catch { /* ignore */ }
    emitFail({ ok: false, error: String(e?.message || e), url: curUrl || null });
  } finally {
    try { await browser.close(); } catch { /* already closed */ }
  }
}

main().catch(e => emitFail({ ok: false, error: String(e?.message || e) }));
