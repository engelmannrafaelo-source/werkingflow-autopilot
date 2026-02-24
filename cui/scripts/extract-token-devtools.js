/**
 * Claude.ai Token Extractor - Run in Browser DevTools
 *
 * Instructions:
 * 1. Open claude.ai in browser
 * 2. Open DevTools: F12 (or Cmd+Opt+I on Mac)
 * 3. Go to "Console" tab
 * 4. Paste this entire script and press Enter
 * 5. Copy the output and paste into terminal
 */

(function extractClaudeToken() {
  console.clear();
  console.log('=== Claude.ai Token Extractor ===\n');

  // Get sessionKey cookie
  const cookies = document.cookie.split(';');
  let sessionKey = null;

  for (const cookie of cookies) {
    const [name, value] = cookie.trim().split('=');
    if (name === 'sessionKey') {
      sessionKey = value;
      break;
    }
  }

  if (!sessionKey) {
    console.error('❌ sessionKey cookie not found!');
    console.error('\nMake sure you are:');
    console.error('1. Logged into claude.ai');
    console.error('2. On the claude.ai domain (not claude.com)');
    console.error('3. Not in incognito/private mode');
    return;
  }

  // Get account email from page
  let accountEmail = 'unknown';
  try {
    // Try to find email in settings or user menu
    const emailElements = document.querySelectorAll('[data-testid*="email"], [type="email"]');
    for (const el of emailElements) {
      const text = el.textContent || el.value;
      if (text && text.includes('@')) {
        accountEmail = text.trim();
        break;
      }
    }
  } catch (e) {
    // Ignore if can't find email
  }

  console.log(`✅ Token extracted successfully!\n`);
  console.log(`Account: ${accountEmail}`);
  console.log(`Token: ${sessionKey.substring(0, 30)}...${sessionKey.slice(-10)}\n`);

  // Determine which env var based on email
  let envVarName = 'CLAUDE_AUTH_TOKEN_RAFAEL';
  if (accountEmail.includes('office')) {
    envVarName = 'CLAUDE_AUTH_TOKEN_OFFICE';
  } else if (accountEmail.includes('engelmann')) {
    envVarName = 'CLAUDE_AUTH_TOKEN_ENGELMANN';
  } else if (accountEmail.includes('rafael')) {
    envVarName = 'CLAUDE_AUTH_TOKEN_RAFAEL';
  }

  console.log('📋 Copy this line to server ~/.zshrc:\n');
  const exportLine = `export ${envVarName}="${sessionKey}"`;
  console.log(exportLine);
  console.log('\n');

  // Copy to clipboard (if supported)
  try {
    navigator.clipboard.writeText(exportLine).then(() => {
      console.log('✅ Copied to clipboard!');
    }).catch(() => {
      console.log('⚠️  Could not copy to clipboard - please copy manually');
    });
  } catch (e) {
    console.log('⚠️  Could not copy to clipboard - please copy manually');
  }

  console.log('\nNext steps:');
  console.log('1. SSH to server');
  console.log('2. nano ~/.zshrc');
  console.log('3. Paste the export line at the end');
  console.log('4. Save (Ctrl+O, Enter, Ctrl+X)');
  console.log('5. source ~/.zshrc');
  console.log('6. cd /root/projekte/werkingflow/autopilot/cui');
  console.log('7. ./scripts/setup-cc-usage.sh');

  return exportLine;
})();
