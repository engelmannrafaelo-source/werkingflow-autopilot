#!/usr/bin/env node
/**
 * Capture Screenshot of Infisical Panel
 * Final Verification Screenshot
 */

import { chromium } from 'playwright';

const OUTPUT_DIR = '/root/orchestrator/workspaces/administration';

(async () => {
  console.log('📸 Capturing Infisical Panel Screenshot...\n');

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-gpu', '--disable-software-rasterizer']
  });

  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 }
  });

  try {
    // 1. Load CUI
    console.log('1. Loading CUI...');
    await page.goto('http://localhost:4005', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    // 2. Find and click Administration tab
    console.log('2. Looking for Administration tab...');

    // Try multiple selectors
    const adminTab = await page.locator('text=ADMINISTRATION').first();

    if (await adminTab.isVisible()) {
      console.log('   ✓ Found Administration tab');
      await adminTab.click();
      await page.waitForTimeout(3000); // Wait for panel to load
    } else {
      console.log('   ⚠ Administration tab not visible, trying alternative selector...');
      await page.click('[data-tab-id="administration"]').catch(() => {
        console.log('   ⚠ Could not click tab, capturing current state');
      });
      await page.waitForTimeout(2000);
    }

    // 3. Take screenshot
    console.log('3. Capturing screenshot...');
    await page.screenshot({
      path: `${OUTPUT_DIR}/infisical-panel-final.png`,
      fullPage: false
    });
    console.log(`   ✓ Screenshot saved: ${OUTPUT_DIR}/infisical-panel-final.png`);

    // 4. Check if panel loaded
    const pageText = await page.textContent('body');
    const hasInfisical = pageText.includes('Infisical') ||
                         pageText.includes('Server Status') ||
                         pageText.includes('Docker Status');

    console.log('\n📊 Panel Check:');
    console.log(`   Infisical content: ${hasInfisical ? '✅ Found' : '❌ Not found'}`);

    console.log('\n✅ Screenshot capture complete!\n');
  } catch (err) {
    console.error('❌ Error:', err.message);
  } finally {
    await browser.close();
  }
})();
