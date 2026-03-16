/**
 * Visual Test for Infisical Panel
 * Captures screenshot and verifies UI rendering
 */

import playwright from 'playwright';
import fs from 'fs';

async function visualTest() {
  console.log('📸 Starting Infisical Panel Visual Test\n');

  const browser = await playwright.chromium.launch({
    headless: true,
    args: [
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--no-sandbox'
    ]
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 }
  });

  const page = await context.newPage();

  try {
    console.log('🌐 Loading CUI...');
    await page.goto('http://localhost:4005');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    console.log('✅ CUI loaded\n');

    // Create workspace with Infisical panel
    console.log('🔧 Creating workspace with Infisical panel...');

    const createResponse = await page.evaluate(async () => {
      try {
        const response = await fetch('/api/workspace/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: 'infisical-visual-test',
            name: 'Infisical Test',
            layout: {
              direction: 'horizontal',
              panels: [
                {
                  component: 'infisical',
                  title: 'Infisical Monitor'
                }
              ]
            }
          })
        });
        return {
          ok: response.ok,
          status: response.status,
          text: await response.text()
        };
      } catch (error) {
        return {
          ok: false,
          error: error.message
        };
      }
    });

    console.log('Workspace creation:', createResponse.ok ? '✅ Success' : '❌ Failed');
    if (!createResponse.ok) {
      console.log('Response:', createResponse);
    }

    // Wait for panel to render
    console.log('\n⏳ Waiting for panel to render...');
    await page.waitForTimeout(5000);

    // Check for panel elements
    console.log('\n🔍 Checking panel elements...');

    const panelCheck = await page.evaluate(() => {
      const body = document.body.innerHTML;
      return {
        hasInfisicalMonitor: body.includes('infisical-monitor') || body.includes('InfisicalMonitor'),
        hasAdministrationPanel: body.includes('administration-panel'),
        hasServerInfo: body.includes('100.79.71.99') || body.includes('Infisical Server'),
        hasProjects: body.includes('werking-report') || body.includes('engelmann'),
        hasTabs: body.includes('Overview') || body.includes('Projects') || body.includes('tab-'),
        hasRefreshButton: body.includes('Refresh') || body.includes('refresh-button'),
        bodyLength: body.length
      };
    });

    console.log('Panel elements:');
    console.log('  - Infisical Monitor:', panelCheck.hasInfisicalMonitor ? '✅' : '❌');
    console.log('  - Administration Panel:', panelCheck.hasAdministrationPanel ? '✅' : '❌');
    console.log('  - Server Info:', panelCheck.hasServerInfo ? '✅' : '❌');
    console.log('  - Projects:', panelCheck.hasProjects ? '✅' : '❌');
    console.log('  - Tabs:', panelCheck.hasTabs ? '✅' : '❌');
    console.log('  - Refresh Button:', panelCheck.hasRefreshButton ? '✅' : '❌');
    console.log('  - HTML Size:', panelCheck.bodyLength, 'bytes');

    // Take screenshot
    const screenshotPath = '/root/orchestrator/workspaces/administration/infisical-panel-test.png';
    await page.screenshot({
      path: screenshotPath,
      fullPage: true
    });

    console.log('\n📸 Screenshot saved:', screenshotPath);

    // Check for specific data-test-id elements
    const testIds = [
      'administration-panel',
      'infisical-status',
      'refresh-button',
      'tab-overview',
      'tab-projects',
      'tab-syncs',
      'tab-health',
      'tab-settings'
    ];

    console.log('\n🎯 Checking data-test-id elements:');
    for (const testId of testIds) {
      const exists = await page.locator(`[data-test-id="${testId}"]`).count() > 0;
      console.log(`  - ${testId}: ${exists ? '✅' : '❌'}`);
    }

    // Get visible text content
    const visibleText = await page.evaluate(() => {
      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
        null
      );
      const texts = [];
      let node;
      while (node = walker.nextNode()) {
        const text = node.textContent?.trim();
        if (text && text.length > 2) {
          texts.push(text);
        }
      }
      return texts.slice(0, 50); // First 50 text nodes
    });

    console.log('\n📝 Visible text (sample):');
    visibleText.slice(0, 10).forEach(text => {
      console.log(`  - "${text.substring(0, 60)}${text.length > 60 ? '...' : ''}"`);
    });

    // Final verdict
    console.log('\n' + '═'.repeat(60));
    const allChecksPass =
      panelCheck.hasInfisicalMonitor &&
      panelCheck.hasProjects &&
      panelCheck.hasTabs &&
      panelCheck.hasRefreshButton;

    if (allChecksPass) {
      console.log('✅ ALL CHECKS PASSED - Panel is rendering correctly!');
    } else {
      console.log('⚠️  SOME CHECKS FAILED - Panel may not be rendering properly');
    }
    console.log('═'.repeat(60));

    console.log('\n✨ Visual test complete!\n');

  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

visualTest().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
