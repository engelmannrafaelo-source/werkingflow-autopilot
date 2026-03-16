#!/usr/bin/env node
/**
 * Infisical Integration Tests
 * Tests API accessibility from browser context
 */

import { chromium } from 'playwright';

const BASE_URL = 'http://localhost:4005';
const API = '/api/infisical';

const colors = { reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m', cyan: '\x1b[36m' };
function log(color, msg) { console.log(`${colors[color]}${msg}${colors.reset}`); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }

(async () => {
  log('cyan', '\n=== Infisical Integration Tests ===\n');

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-gpu', '--disable-software-rasterizer', '--no-sandbox']
  });

  const page = await browser.newPage();

  try {
    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    // Check root element
    const hasRoot = await page.evaluate(() => {
      return document.querySelector('#root') !== null;
    });
    assert(hasRoot, 'Should have root element');

    // Test API accessibility from browser
    const results = await page.evaluate(async (api) => {
      const [status, projects, syncs, health] = await Promise.all([
        fetch(`${api}/status`).then(r => r.json()),
        fetch(`${api}/projects`).then(r => r.json()),
        fetch(`${api}/syncs`).then(r => r.json()),
        fetch(`${api}/health`).then(r => r.json())
      ]);

      return { status, projects, syncs, health };
    }, API);

    // Validate results
    assert(results.status.server, 'Status should have server');
    assert(results.status.projects, 'Status should have projects');
    assert(results.projects.projects, 'Projects should have projects array');
    assert(results.projects.projects.length === 7, 'Should have 7 projects');
    assert(results.syncs.syncs, 'Syncs should have syncs array');
    assert(results.syncs.total, 'Syncs should have total');
    assert(results.health.status, 'Health should have status');

    log('green', '✓ All Infisical APIs work from browser context');

    await browser.close();

    log('cyan', '\n=== Test Summary ===');
    log('green', 'Passed: 1');
    log('cyan', 'Total: 1\n');

    process.exit(0);
  } catch (err) {
    log('red', `✗ ${err.message}`);
    await browser.close();
    process.exit(1);
  }
})();
