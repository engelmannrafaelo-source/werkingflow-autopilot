#!/usr/bin/env npx tsx
/**
 * Extract Claude.ai Auth Tokens from Browser Profiles
 *
 * Searches common browser cookie databases for sessionKey tokens.
 * Supports: Chrome, Firefox, Brave, Edge
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

interface TokenResult {
  account: string;
  token: string | null;
  source: string;
}

// Common browser profile locations on Linux
const BROWSER_PATHS = [
  // Chrome/Chromium
  join(process.env.HOME || '/root', '.config/google-chrome/Default/Cookies'),
  join(process.env.HOME || '/root', '.config/chromium/Default/Cookies'),

  // Firefox (uses SQLite, different format)
  join(process.env.HOME || '/root', '.mozilla/firefox/*.default-release/cookies.sqlite'),

  // Brave
  join(process.env.HOME || '/root', '.config/BraveSoftware/Brave-Browser/Default/Cookies'),

  // Edge
  join(process.env.HOME || '/root', '.config/microsoft-edge/Default/Cookies'),
];

async function extractFromChrome(cookiePath: string): Promise<string[]> {
  if (!existsSync(cookiePath)) return [];

  try {
    // Chrome cookies are encrypted, need to decrypt
    // For now, try reading from plaintext (if decrypted)
    const result = execSync(
      `sqlite3 "${cookiePath}" "SELECT value FROM cookies WHERE host_key LIKE '%claude.ai' AND name = 'sessionKey'" 2>/dev/null || echo ""`,
      { encoding: 'utf-8' }
    );

    return result.trim().split('\n').filter(Boolean);
  } catch (err) {
    return [];
  }
}

async function extractFromFirefox(profilePath: string): Promise<string[]> {
  try {
    const profiles = execSync(
      `find "${profilePath.replace('*.default-release', '')}" -name "*.default-release" -type d 2>/dev/null || echo ""`,
      { encoding: 'utf-8' }
    ).trim().split('\n').filter(Boolean);

    const tokens: string[] = [];
    for (const profile of profiles) {
      const cookieDb = join(profile, 'cookies.sqlite');
      if (!existsSync(cookieDb)) continue;

      try {
        const result = execSync(
          `sqlite3 "${cookieDb}" "SELECT value FROM moz_cookies WHERE host LIKE '%claude.ai' AND name = 'sessionKey'" 2>/dev/null || echo ""`,
          { encoding: 'utf-8' }
        );
        tokens.push(...result.trim().split('\n').filter(Boolean));
      } catch {}
    }
    return tokens;
  } catch {
    return [];
  }
}

async function extractTokensFromBrowsers(): Promise<string[]> {
  console.log('[Extract] Searching browser profiles for sessionKey cookies...\n');

  const allTokens = new Set<string>();

  for (const path of BROWSER_PATHS) {
    if (path.includes('firefox')) {
      const tokens = await extractFromFirefox(path);
      tokens.forEach(t => allTokens.add(t));
    } else {
      const tokens = await extractFromChrome(path);
      tokens.forEach(t => allTokens.add(t));
    }
  }

  return Array.from(allTokens);
}

async function main() {
  console.log('=== Claude.ai Token Extractor ===\n');

  const tokens = await extractTokensFromBrowsers();

  if (tokens.length === 0) {
    console.error('❌ No tokens found in browser profiles.\n');
    console.error('Manual extraction required:');
    console.error('1. Open claude.ai in browser');
    console.error('2. DevTools (F12) → Application → Cookies');
    console.error('3. Find "sessionKey" cookie, copy value');
    console.error('4. Add to ~/.zshrc manually:\n');
    console.error('export CLAUDE_AUTH_TOKEN_RAFAEL="sk-ant-..."');
    console.error('export CLAUDE_AUTH_TOKEN_OFFICE="sk-ant-..."');
    console.error('export CLAUDE_AUTH_TOKEN_ENGELMANN="sk-ant-..."\n');
    process.exit(1);
  }

  console.log(`✓ Found ${tokens.length} token(s):\n`);
  tokens.forEach((token, idx) => {
    console.log(`[${idx + 1}] ${token.substring(0, 30)}...`);
  });

  console.log('\n⚠️  Manual mapping required!');
  console.log('Add these to ~/.zshrc:\n');
  console.log('export CLAUDE_AUTH_TOKEN_RAFAEL="<token-for-rafael@werk-ing.com>"');
  console.log('export CLAUDE_AUTH_TOKEN_OFFICE="<token-for-office@werk-ing.com>"');
  console.log('export CLAUDE_AUTH_TOKEN_ENGELMANN="<token-for-engelmann@werk-ing.com>"\n');
  console.log('Then: source ~/.zshrc');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
