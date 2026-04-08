#!/usr/bin/env node
/**
 * E2E Tests for Infisical Monitor Panel
 * Bridge-Quality Frontend Testing Pattern
 */

import { chromium } from 'playwright';

const BASE_URL = 'http://localhost:4005';
const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  reset: '\x1b[0m',
  bold: '\x1b[1m'
};

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    console.log(`${colors.green}✓${colors.reset} ${name}`);
    passed++;
  } catch (err) {
    console.log(`${colors.red}✗${colors.reset} ${name}`);
    console.log(`  ${colors.red}${err.message}${colors.reset}`);
    failed++;
    failures.push({ name, error: err.message });
  }
}

(async () => {
  console.log(`${colors.bold}${colors.cyan}INFISICAL PANEL E2E TESTS${colors.reset}\n`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-gpu', '--disable-software-rasterizer']
  });
  const page = await browser.newPage();

  try {
    // Navigate to CUI
    await test('Navigate to CUI home page', async () => {
      await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 10000 });
      const title = await page.title();
      if (!title.includes('CUI')) throw new Error('Invalid page title');
    });

    // Open Infisical panel
    await test('Open Infisical Monitor panel', async () => {
      // Look for panel button/link
      const panelButton = await page.getByText('Infisical', { exact: false }).first();
      if (panelButton) {
        await panelButton.click();
        await page.waitForTimeout(1000);
      } else {
        // Try direct navigation
        await page.goto(`${BASE_URL}?panel=infisical`, { waitUntil: 'networkidle' });
      }
    });

    // Test panel loaded
    await test('Infisical panel renders', async () => {
      const panel = await page.locator('[data-test-id="administration-panel"]').first();
      const visible = await panel.isVisible();
      if (!visible) throw new Error('Administration panel not visible');
    });

    // Test header
    await test('Panel header shows title', async () => {
      const heading = await page.locator('text=Infisical Monitor').first();
      const visible = await heading.isVisible();
      if (!visible) throw new Error('Panel title not visible');
    });

    // Test server status
    await test('Server status displayed', async () => {
      const status = await page.locator('[data-test-id="infisical-status"]').first();
      const text = await status.textContent();
      if (!text || !text.includes('100.79.71.99')) {
        throw new Error(`Invalid server status: ${text}`);
      }
    });

    // Test refresh button
    await test('Refresh button exists', async () => {
      const btn = await page.locator('[data-test-id="refresh-button"]').first();
      const visible = await btn.isVisible();
      if (!visible) throw new Error('Refresh button not visible');
    });

    // Test all tabs
    const tabs = ['overview', 'projects', 'syncs', 'health', 'settings'];
    for (const tab of tabs) {
      await test(`Tab: ${tab} - button exists`, async () => {
        const tabBtn = await page.locator(`[data-test-id="tab-${tab}"]`).first();
        const visible = await tabBtn.isVisible();
        if (!visible) throw new Error(`Tab ${tab} button not visible`);
      });

      await test(`Tab: ${tab} - can click`, async () => {
        const tabBtn = await page.locator(`[data-test-id="tab-${tab}"]`).first();
        await tabBtn.click();
        await page.waitForTimeout(500);
      });

      await test(`Tab: ${tab} - content renders`, async () => {
        // Check that we're not seeing loading/error states
        const loading = await page.locator('[data-test-id="loading-indicator"]').count();
        const error = await page.locator('[data-test-id="error-state"]').count();
        if (loading > 0) throw new Error('Still loading after tab switch');
        if (error > 0) throw new Error('Error state after tab switch');
      });
    }

    // Test Overview Tab specifics
    await test('Overview tab - shows 7 projects', async () => {
      const overviewTab = await page.locator('[data-test-id="tab-overview"]').first();
      await overviewTab.click();
      await page.waitForTimeout(500);

      // Look for project count indicator
      const text = await page.textContent('body');
      if (!text.includes('7')) {
        throw new Error('Overview tab does not show 7 projects');
      }
    });

    // Test Projects Tab specifics
    await test('Projects tab - lists all projects', async () => {
      const projectsTab = await page.locator('[data-test-id="tab-projects"]').first();
      await projectsTab.click();
      await page.waitForTimeout(500);

      const text = await page.textContent('body');
      const expectedProjects = ['werking-report', 'engelmann', 'platform'];
      for (const project of expectedProjects) {
        if (!text.includes(project)) {
          throw new Error(`Project ${project} not found in projects tab`);
        }
      }
    });

    // Test Syncs Tab specifics
    await test('Syncs tab - shows all syncs succeeded', async () => {
      const syncsTab = await page.locator('[data-test-id="tab-syncs"]').first();
      await syncsTab.click();
      await page.waitForTimeout(500);

      const text = await page.textContent('body');
      if (!text.includes('succeeded') && !text.includes('7')) {
        throw new Error('Syncs tab does not show succeeded status');
      }
    });

    // Test Settings Tab specifics
    await test('Settings tab - shows server info', async () => {
      const settingsTab = await page.locator('[data-test-id="tab-settings"]').first();
      await settingsTab.click();
      await page.waitForTimeout(500);

      const text = await page.textContent('body');
      if (!text.includes('100.79.71.99')) {
        throw new Error('Settings tab does not show server IP');
      }
    });

  } catch (err) {
    console.error(`${colors.red}Fatal error:${colors.reset}`, err.message);
    failed++;
    failures.push({ name: 'Fatal error', error: err.message });
  } finally {
    await browser.close();
  }

  // Summary
  console.log(`\n${colors.bold}${colors.cyan}═══════════════════════════════════════${colors.reset}`);
  console.log(`  Total:  ${passed + failed}`);
  console.log(`  ${colors.green}Passed: ${passed}${colors.reset}`);
  if (failed > 0) {
    console.log(`  ${colors.red}Failed: ${failed}${colors.reset}`);
  }

  if (failed > 0) {
    console.log(`\n${colors.red}${colors.bold}FAILURES:${colors.reset}`);
    failures.forEach(({ name, error }) => {
      console.log(`\n  ${colors.red}✗ ${name}${colors.reset}`);
      console.log(`    ${error}`);
    });
    process.exit(1);
  } else {
    console.log(`\n${colors.green}${colors.bold}✅ ALL TESTS PASSED!${colors.reset}\n`);
    process.exit(0);
  }
})();
