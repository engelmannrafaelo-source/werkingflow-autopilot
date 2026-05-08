/**
 * Journey Runner — automated browser login + screenshot capture for WerkING apps.
 *
 * Navigates to a local app's login page, fills credentials, logs in, and
 * captures 4 screenshots per run:
 *   01-login.png       — login form, before interaction
 *   02-form-filled.png — credentials entered, before submit
 *   03-after-login.png — immediately after successful login redirect
 *   04-projekte.png    — final dashboard / project list (full-page)
 *
 * Output: baseDir/<userId>/<workspace>/<journeyId>/ with PNGs + journey.md log.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createRequire } from 'module';
import { evaluateJourney, JourneyEvaluation } from './journey-evaluator.js';

export interface JourneyOptions {
  userId: string;
  workspace: string;
  app: string;
  port: number;
  email: string;
  password: string;
  baseDir: string;
}

export interface JourneyResult {
  journeyId: string;
  dirPath: string;
  screenshots: string[];
  log: string;
  loginSuccess: boolean;
  postLoginUrl: string;
  failureReason?: string;
  evaluation?: JourneyEvaluation;
  evaluationError?: string;
}

async function loadPlaywright(): Promise<any> {
  try {
    return await import('playwright');
  } catch {
    // Fallback to werkingflow-production node_modules on partner-server
    const _require = createRequire(import.meta.url);
    return _require('/home/david-steiner/projekte/werkingflow-production/node_modules/playwright');
  }
}

function journeyId(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export async function runJourney({
  userId,
  workspace,
  app,
  port,
  email,
  password,
  baseDir,
}: JourneyOptions): Promise<JourneyResult> {
  const startedAt = new Date();
  const id = journeyId(startedAt);
  const dirPath = join(baseDir, userId, workspace, id);
  mkdirSync(dirPath, { recursive: true });

  const logLines: string[] = [
    `# Journey: ${app} / ${userId} / ${workspace}`,
    `Started: ${startedAt.toISOString()}`,
    `Email: ${email}`,
    '',
  ];
  const screenshots: string[] = [];
  const baseUrl = `http://127.0.0.1:${port}`;

  const pw = await loadPlaywright();
  const browser = await pw.chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });

  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    // 1: Login page
    logLines.push('## Step 1: Login page');
    await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.screenshot({ path: join(dirPath, '01-login.png'), type: 'png' });
    screenshots.push('01-login.png');
    logLines.push(`- URL: ${page.url()}`, '- Screenshot: 01-login.png', '');

    // 2: Fill credentials
    logLines.push('## Step 2: Form filled');
    await page.fill(
      'input[type="email"], input[name="email"], input[placeholder*="mail" i], input[placeholder*="E-Mail" i]',
      email,
    );
    await page.fill('input[type="password"], input[name="password"]', password);
    await page.screenshot({ path: join(dirPath, '02-form-filled.png'), type: 'png' });
    screenshots.push('02-form-filled.png');
    logLines.push(`- Email: ${email}`, '- Screenshot: 02-form-filled.png', '');

    // 3: Submit + wait for redirect
    logLines.push('## Step 3: After login');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
      page.click(
        'button[type="submit"], button:has-text("Login"), button:has-text("Anmelden"), button:has-text("Einloggen")',
      ),
    ]);
    await page.waitForTimeout(3000);
    await page.screenshot({ path: join(dirPath, '03-after-login.png'), type: 'png' });
    screenshots.push('03-after-login.png');
    logLines.push(`- URL: ${page.url()}`, '- Screenshot: 03-after-login.png', '');

    // 4: Dashboard / project list
    logLines.push('## Step 4: Projekte / Dashboard');
    const postLoginUrl = page.url();
    let loginSuccess = !postLoginUrl.includes('/login');
    let failureReason: string | undefined;

    if (!loginSuccess) {
      // Login did NOT redirect — capture page error if visible, then try root as forensic
      const errSelectors = [
        '[role="alert"]', '.error', '[class*="error" i]', '[data-testid*="error" i]',
      ];
      for (const sel of errSelectors) {
        const txt = await page.locator(sel).first().textContent({ timeout: 500 }).catch(() => null);
        if (txt && txt.trim()) { failureReason = txt.trim().slice(0, 300); break; }
      }
      if (!failureReason) failureReason = `URL stayed on ${postLoginUrl} — login likely rejected (no redirect)`;
      logLines.push(`- ❌ LOGIN FAILED: ${failureReason}`);
      await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    }
    await page.waitForTimeout(2000);
    // Viewport-only (not fullPage) — fullPage screenshots blow past the
    // Bridge 1MB request limit on dashboards with long lists. The viewport
    // captures the above-the-fold state, which is what the user sees first
    // and what the evaluator needs to judge "did the post-login screen render".
    await page.screenshot({ path: join(dirPath, '04-projekte.png'), type: 'png' });
    screenshots.push('04-projekte.png');
    logLines.push(`- URL: ${page.url()}`, '- Screenshot: 04-projekte.png', '');

    const finishedAt = new Date();
    logLines.push(
      '',
      `loginSuccess: ${loginSuccess}`,
      `Finished: ${finishedAt.toISOString()}`,
      `Duration: ${finishedAt.getTime() - startedAt.getTime()}ms`,
    );

    const log = logLines.join('\n');
    writeFileSync(join(dirPath, 'journey.md'), log, 'utf8');

    // Browser must close before we kick off the AI evaluation — keeps the
    // process tree clean even if the Bridge call hangs.
    await browser.close();

    // Vision-based evaluation. Failures here must not break the journey itself.
    let evaluation: JourneyEvaluation | undefined;
    let evaluationError: string | undefined;
    try {
      evaluation = await evaluateJourney(dirPath);
    } catch (e: any) {
      evaluationError = e?.message || String(e);
      console.error(`[journey-runner] evaluation failed for ${id}: ${evaluationError}`);
    }

    return { journeyId: id, dirPath, screenshots, log, loginSuccess, postLoginUrl, failureReason, evaluation, evaluationError };
  } finally {
    // Defensive close in case we threw before the explicit close above.
    try { await browser.close(); } catch { /* already closed */ }
  }
}
