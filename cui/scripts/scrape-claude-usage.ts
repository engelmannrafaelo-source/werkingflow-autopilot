#!/usr/bin/env tsx
/**
 * Scrape Claude.ai Usage Data
 *
 * Extracts real usage limits from claude.ai/settings/usage page
 * Uses saved session state from login-claude.ts
 */

import { chromium } from 'playwright';
import { writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const STORAGE_DIR = '/root/projekte/local-storage/backends/cui/playwright-sessions';

interface UsageData {
  account: string;
  timestamp: string;
  currentSession: {
    percent: number;
    resetIn: string;
  };
  weeklyAllModels: {
    percent: number;
    resetDate: string;
  };
  weeklySonnet: {
    percent: number;
    resetDate: string;
  };
}

async function scrapeClaudeUsage(accountName: string): Promise<UsageData> {
  const storageStatePath = join(STORAGE_DIR, `${accountName}.json`);

  if (!existsSync(storageStatePath)) {
    throw new Error(
      `No session state found for ${accountName}. Run: npx tsx scripts/login-claude.ts ${accountName}`
    );
  }

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
    ],
  });

  // Load saved session state
  const context = await browser.newContext({
    storageState: storageStatePath,
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
  });

  const page = await context.newPage();

  try {
    console.log(`[Scraper] Navigating to claude.ai/settings/usage for ${accountName}...`);
    await page.goto('https://claude.ai/settings/usage', { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Wait for page to be interactive
    await page.waitForTimeout(3000);

    // Wait for usage data to load
    await page.waitForSelector('text=Plan-Nutzungslimits', { timeout: 10000 });

    // Extract data
    const usageData = await page.evaluate(() => {
      // Helper to find text containing pattern and extract percent
      function findPercent(searchText: string): number {
        const allText = document.body.innerText;
        const lines = allText.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(searchText)) {
            // Look in surrounding lines for percentage
            for (let j = Math.max(0, i - 3); j < Math.min(lines.length, i + 5); j++) {
              const match = lines[j].match(/(\d+)\s*%/);
              if (match) return parseInt(match[1], 10);
            }
          }
        }
        return 0;
      }

      // Helper to find reset time near search text
      function findResetTime(searchText: string): string {
        const allText = document.body.innerText;
        const lines = allText.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(searchText)) {
            // Look in surrounding lines for Zurücksetzung
            for (let j = Math.max(0, i - 2); j < Math.min(lines.length, i + 5); j++) {
              if (lines[j].includes('Zurücksetzung')) {
                // Extract everything after "Zurücksetzung"
                const match = lines[j].match(/Zurücksetzung\s+(.+)/);
                if (match) return match[1].trim();
              }
            }
          }
        }
        return 'Unknown';
      }

      // Extract data by searching body text
      const currentSessionPercent = findPercent('Aktuelle Sitzung');
      const currentSessionReset = findResetTime('Aktuelle Sitzung');

      const weeklyAllPercent = findPercent('Alle Modelle');
      const weeklyAllReset = findResetTime('Alle Modelle');

      const weeklySonnetPercent = findPercent('Nur Sonnet');
      const weeklySonnetReset = findResetTime('Nur Sonnet');

      return {
        currentSessionPercent,
        currentSessionReset,
        weeklyAllPercent,
        weeklyAllReset,
        weeklySonnetPercent,
        weeklySonnetReset,
      };
    });

    const result: UsageData = {
      account: accountName,
      timestamp: new Date().toISOString(),
      currentSession: {
        percent: usageData.currentSessionPercent,
        resetIn: usageData.currentSessionReset,
      },
      weeklyAllModels: {
        percent: usageData.weeklyAllPercent,
        resetDate: usageData.weeklyAllReset,
      },
      weeklySonnet: {
        percent: usageData.weeklySonnetPercent,
        resetDate: usageData.weeklySonnetReset,
      },
    };

    console.log(`[Scraper] ✓ Scraped ${accountName}: ${result.weeklyAllModels.percent}% weekly`);
    return result;
  } catch (err: any) {
    console.error(`[Scraper] ✗ Failed for ${accountName}:`, err.message);

    // Save screenshot on error for debugging
    try {
      const screenshotPath = `/tmp/claude-scraper-error-${accountName}.png`;
      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.log(`[Scraper] Screenshot saved to ${screenshotPath}`);
    } catch (screenshotErr) {
      console.error(`[Scraper] Could not save screenshot:`, screenshotErr);
    }

    throw err;
  } finally {
    await browser.close();
  }
}

async function main() {
  // Account names to scrape (must have session state from login-claude.ts)
  const accounts = ['rafael', 'office', 'engelmann'];

  const results: UsageData[] = [];

  for (const accountName of accounts) {
    const storageStatePath = join(STORAGE_DIR, `${accountName}.json`);

    if (!existsSync(storageStatePath)) {
      console.warn(`[Scraper] ⚠ No session state for ${accountName}, skipping (run: npx tsx scripts/login-claude.ts ${accountName})`);
      continue;
    }

    try {
      const data = await scrapeClaudeUsage(accountName);
      results.push(data);
    } catch (err) {
      console.error(`[Scraper] Failed to scrape ${accountName}:`, err);
    }
  }

  // Save to JSON
  const outputPath = join(process.cwd(), 'claude-usage-scraped.json');
  writeFileSync(outputPath, JSON.stringify(results, null, 2), 'utf-8');
  console.log(`\n[Scraper] ✓ Saved ${results.length} accounts to ${outputPath}`);

  // Print summary
  console.log('\n--- USAGE SUMMARY ---');
  results.forEach(r => {
    console.log(`\n${r.account.toUpperCase()}:`);
    console.log(`  Current Session: ${r.currentSession.percent}% (resets ${r.currentSession.resetIn})`);
    console.log(`  Weekly All: ${r.weeklyAllModels.percent}% (resets ${r.weeklyAllModels.resetDate})`);
    console.log(`  Weekly Sonnet: ${r.weeklySonnet.percent}% (resets ${r.weeklySonnet.resetDate})`);
  });
}

main().catch(err => {
  console.error('[Scraper] Fatal error:', err);
  process.exit(1);
});
