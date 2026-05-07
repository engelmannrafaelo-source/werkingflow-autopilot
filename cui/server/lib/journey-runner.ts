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
    if (postLoginUrl.includes('/login')) {
      // Login did not redirect — try root
      await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    }
    await page.waitForTimeout(2000);
    await page.screenshot({ path: join(dirPath, '04-projekte.png'), type: 'png', fullPage: true });
    screenshots.push('04-projekte.png');
    logLines.push(`- URL: ${page.url()}`, '- Screenshot: 04-projekte.png', '');

    const finishedAt = new Date();
    logLines.push('', `Finished: ${finishedAt.toISOString()}`, `Duration: ${finishedAt.getTime() - startedAt.getTime()}ms`);
  } finally {
    await browser.close();
  }

  const log = logLines.join('\n');
  writeFileSync(join(dirPath, 'journey.md'), log, 'utf8');

  return { journeyId: id, dirPath, screenshots, log };
}
