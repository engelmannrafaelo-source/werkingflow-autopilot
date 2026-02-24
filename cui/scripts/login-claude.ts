#!/usr/bin/env npx tsx
/**
 * Interactive Claude.ai Login
 *
 * Runs ONCE to establish session state on the server.
 * Opens browser, waits for manual login, saves session state.
 *
 * Usage:
 *   npx tsx scripts/login-claude.ts rafael
 *   npx tsx scripts/login-claude.ts office
 *   npx tsx scripts/login-claude.ts engelmann
 */

import { chromium, type BrowserContext } from 'playwright';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const STORAGE_DIR = '/root/projekte/local-storage/backends/cui/playwright-sessions';
const TIMEOUT = 300000; // 5 minutes for manual login

interface LoginConfig {
  account: string;
  email: string;
  storageStatePath: string;
}

const ACCOUNTS: Record<string, string> = {
  rafael: 'rafael@werk-ing.com',
  office: 'office@werk-ing.com',
  engelmann: 'engelmann@werk-ing.com',
};

async function interactiveLogin(config: LoginConfig): Promise<void> {
  console.log(`\n=== Interactive Login for ${config.account} ===`);
  console.log(`Email: ${config.email}`);
  console.log(`Storage: ${config.storageStatePath}\n`);

  // Ensure storage directory exists
  if (!existsSync(STORAGE_DIR)) {
    mkdirSync(STORAGE_DIR, { recursive: true });
  }

  const browser = await chromium.launch({
    headless: false, // MUST be visible for manual login
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-gpu',
      '--disable-software-rasterizer',
    ],
  });

  let context: BrowserContext | null = null;

  try {
    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });

    const page = await context.newPage();

    console.log('[Login] Opening claude.ai/login...');
    await page.goto('https://claude.ai/login', { waitUntil: 'networkidle' });

    console.log('\n✋ MANUAL ACTION REQUIRED:');
    console.log('1. Log in with: ' + config.email);
    console.log('2. Complete any 2FA/verification');
    console.log('3. Wait until you see the Claude chat interface');
    console.log('4. Script will auto-detect successful login\n');

    // Wait for successful login (dashboard or chat page)
    await page.waitForURL(/claude\.ai\/(chat|projects|settings)/, {
      timeout: TIMEOUT
    });

    console.log('[Login] ✓ Login detected!');
    console.log('[Login] Verifying session...');

    // Navigate to settings/usage to verify session works
    await page.goto('https://claude.ai/settings/usage', {
      waitUntil: 'networkidle',
      timeout: 30000
    });

    // Check if we got redirected back to login (session invalid)
    if (page.url().includes('/login')) {
      throw new Error('Session invalid - got redirected to login');
    }

    console.log('[Login] ✓ Session verified!');

    // Save session state
    await context.storageState({ path: config.storageStatePath });

    console.log(`[Login] ✓ Session saved to: ${config.storageStatePath}`);
    console.log('\n✅ Login complete! You can now run the scraper with this account.\n');

  } catch (error: any) {
    console.error('\n❌ Login failed:', error.message);
    throw error;
  } finally {
    if (context) await context.close();
    await browser.close();
  }
}

async function main() {
  const accountArg = process.argv[2];

  if (!accountArg || !ACCOUNTS[accountArg]) {
    console.error('\n❌ Usage: npx tsx scripts/login-claude.ts <account>');
    console.error('\nAvailable accounts:');
    Object.entries(ACCOUNTS).forEach(([key, email]) => {
      console.error(`  - ${key}: ${email}`);
    });
    process.exit(1);
  }

  const config: LoginConfig = {
    account: accountArg,
    email: ACCOUNTS[accountArg],
    storageStatePath: join(STORAGE_DIR, `${accountArg}.json`),
  };

  await interactiveLogin(config);
}

main().catch((error) => {
  console.error('\n❌ Fatal error:', error);
  process.exit(1);
});
