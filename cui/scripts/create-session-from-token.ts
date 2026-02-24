#!/usr/bin/env npx tsx
/**
 * Create Playwright Session from Auth Token
 *
 * Converts long-lived Claude.ai auth tokens to Playwright session states.
 * No interactive login required - runs headless!
 *
 * Usage:
 *   npx tsx scripts/create-session-from-token.ts rafael
 *   npx tsx scripts/create-session-from-token.ts office
 *   npx tsx scripts/create-session-from-token.ts engelmann
 */

import { chromium, type BrowserContext } from 'playwright';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const STORAGE_DIR = '/root/projekte/local-storage/backends/cui/playwright-sessions';

interface SessionConfig {
  account: string;
  email: string;
  tokenEnvVar: string;
  storageStatePath: string;
}

const ACCOUNTS: Record<string, { email: string; tokenEnvVar: string }> = {
  rafael: {
    email: 'rafael@werk-ing.com',
    tokenEnvVar: 'CLAUDE_AUTH_TOKEN_RAFAEL',
  },
  office: {
    email: 'office@werk-ing.com',
    tokenEnvVar: 'CLAUDE_AUTH_TOKEN_OFFICE',
  },
  engelmann: {
    email: 'engelmann@werk-ing.com',
    tokenEnvVar: 'CLAUDE_AUTH_TOKEN_ENGELMANN',
  },
};

async function createSessionFromToken(config: SessionConfig, token: string): Promise<void> {
  console.log(`\n=== Creating Session for ${config.account} ===`);
  console.log(`Email: ${config.email}`);
  console.log(`Token: ${token.substring(0, 20)}...`);
  console.log(`Storage: ${config.storageStatePath}\n`);

  // Ensure storage directory exists
  if (!existsSync(STORAGE_DIR)) {
    mkdirSync(STORAGE_DIR, { recursive: true });
  }

  const browser = await chromium.launch({
    headless: true, // No UI needed!
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--no-sandbox',
    ],
  });

  let context: BrowserContext | null = null;

  try {
    // Create context with auth cookie
    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });

    // Set sessionKey cookie (Claude.ai auth token)
    await context.addCookies([
      {
        name: 'sessionKey',
        value: token,
        domain: '.claude.ai',
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      },
    ]);

    const page = await context.newPage();

    console.log('[Session] Verifying token...');

    // Navigate to settings/usage to verify token works
    await page.goto('https://claude.ai/settings/usage', {
      waitUntil: 'networkidle',
      timeout: 30000,
    });

    // Check if we got redirected to login (token invalid)
    if (page.url().includes('/login')) {
      throw new Error('Token invalid - got redirected to login');
    }

    console.log('[Session] ✓ Token verified!');

    // Save session state
    await context.storageState({ path: config.storageStatePath });

    console.log(`[Session] ✓ Session saved to: ${config.storageStatePath}`);
    console.log('\n✅ Session created! You can now run the scraper with this account.\n');

  } catch (error: any) {
    console.error('\n❌ Session creation failed:', error.message);
    throw error;
  } finally {
    if (context) await context.close();
    await browser.close();
  }
}

async function main() {
  const accountArg = process.argv[2];

  if (!accountArg || !ACCOUNTS[accountArg]) {
    console.error('\n❌ Usage: npx tsx scripts/create-session-from-token.ts <account>');
    console.error('\nAvailable accounts:');
    Object.entries(ACCOUNTS).forEach(([key, { email, tokenEnvVar }]) => {
      console.error(`  - ${key}: ${email} (env: ${tokenEnvVar})`);
    });
    process.exit(1);
  }

  const accountConfig = ACCOUNTS[accountArg];
  const token = process.env[accountConfig.tokenEnvVar];

  if (!token) {
    console.error(`\n❌ Token not found: ${accountConfig.tokenEnvVar}`);
    console.error('\nAdd to ~/.zshrc:');
    console.error(`export ${accountConfig.tokenEnvVar}="sk-ant-..."`);
    console.error('\nThen: source ~/.zshrc');
    process.exit(1);
  }

  const config: SessionConfig = {
    account: accountArg,
    email: accountConfig.email,
    tokenEnvVar: accountConfig.tokenEnvVar,
    storageStatePath: join(STORAGE_DIR, `${accountArg}.json`),
  };

  await createSessionFromToken(config, token);
}

main().catch((error) => {
  console.error('\n❌ Fatal error:', error);
  process.exit(1);
});
