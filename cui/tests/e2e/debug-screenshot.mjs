#!/usr/bin/env node
/**
 * Debug: Take screenshot of CUI to see actual UI
 */

import { chromium } from 'playwright';

const BASE_URL = 'http://localhost:4005';

(async () => {
  console.log('Loading CUI and taking screenshot...');

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-gpu', '--disable-software-rasterizer', '--no-sandbox']
  });

  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 }
  });

  await page.goto(BASE_URL);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(5000);

  // Take screenshot
  await page.screenshot({
    path: '/root/orchestrator/workspaces/administration/cui-homepage.png',
    fullPage: true
  });

  console.log('✓ Screenshot saved to: /root/orchestrator/workspaces/administration/cui-homepage.png');

  // Get page content
  const content = await page.evaluate(() => {
    return {
      title: document.title,
      bodyText: document.body.innerText.slice(0, 500),
      hasAdmin: document.body.innerText.toLowerCase().includes('administration'),
      buttons: Array.from(document.querySelectorAll('button')).map(b => b.textContent?.trim()).filter(t => t).slice(0, 10),
      links: Array.from(document.querySelectorAll('a')).map(a => a.textContent?.trim()).filter(t => t).slice(0, 10)
    };
  });

  console.log('\nPage Info:');
  console.log('Title:', content.title);
  console.log('Has "administration":', content.hasAdmin);
  console.log('Buttons found:', content.buttons);
  console.log('Links found:', content.links);
  console.log('\nBody preview:', content.bodyText);

  await browser.close();
})();
