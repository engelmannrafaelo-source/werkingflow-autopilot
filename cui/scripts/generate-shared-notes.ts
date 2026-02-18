#!/usr/bin/env tsx
/**
 * Shared Notes Generator
 *
 * Generiert Markdown-Datei mit allen Credentials aus credentials.json
 * Output: data/notes/shared.md
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CUI_ROOT = resolve(__dirname, '..');
const CREDENTIALS_FILE = join(CUI_ROOT, 'data/credentials.json');
const OUTPUT_FILE = join(CUI_ROOT, 'data/notes/shared.md');

interface User {
  name: string;
  email: string;
  password?: string;
  role?: string;
  tenant?: string;
  environments: {
    local?: string;
    staged?: string;
    production?: string;
  };
  scenarios: string[];
  source: 'seed' | 'scenario' | 'both';
}

interface AppCredentials {
  app: string;
  displayName: string;
  users: User[];
}

interface AggregatedData {
  generatedAt: string;
  apps: AppCredentials[];
}

/**
 * Format password field with fallback
 */
function formatPassword(password?: string): string {
  if (!password) return '`Demo-Mode` (see scenario)';
  return `\`${password}\``;
}

/**
 * Format environments as compact list
 */
function formatEnvironments(envs: User['environments']): string {
  const lines: string[] = [];
  if (envs.local) lines.push(`**Local:** ${envs.local}`);
  if (envs.staged) lines.push(`**Staged:** ${envs.staged}`);
  if (envs.production) lines.push(`**Prod:** ${envs.production}`);
  return lines.length > 0 ? lines.join('<br>') : '—';
}

/**
 * Generate markdown for one app
 */
function generateAppSection(app: AppCredentials): string {
  const lines: string[] = [];

  lines.push(`## ${app.displayName}`);
  lines.push('');
  lines.push('| Name | Email | Password | Role | Tenant | Environments |');
  lines.push('|------|-------|----------|------|--------|--------------|');

  for (const user of app.users) {
    const name = user.name;
    const email = user.email;
    const password = formatPassword(user.password);
    const role = user.role || '—';
    const tenant = user.tenant || '—';
    const envs = formatEnvironments(user.environments);

    lines.push(`| ${name} | ${email} | ${password} | ${role} | ${tenant} | ${envs} |`);
  }

  lines.push('');

  // Scenarios
  const allScenarios = app.users.flatMap(u => u.scenarios).filter((v, i, a) => a.indexOf(v) === i);
  if (allScenarios.length > 0) {
    lines.push('**Scenarios:**');
    for (const scenario of allScenarios.slice(0, 10)) {
      // Limit to 10 for readability
      lines.push(`- \`${scenario}\``);
    }
    if (allScenarios.length > 10) {
      lines.push(`- *...and ${allScenarios.length - 10} more*`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');

  return lines.join('\n');
}

/**
 * Main generator
 */
function main() {
  console.log('📝 Generating shared notes...\n');

  if (!existsSync(CREDENTIALS_FILE)) {
    console.error(`❌ credentials.json not found: ${CREDENTIALS_FILE}`);
    console.error('   Run: npm run aggregate:credentials');
    process.exit(1);
  }

  const data: AggregatedData = JSON.parse(readFileSync(CREDENTIALS_FILE, 'utf8'));

  const lines: string[] = [];

  // Header
  lines.push('# 🔐 Shared Notes - Zugangsdaten');
  lines.push('');
  lines.push('> **⚠️ FOR DEVELOPMENT ONLY**');
  lines.push('> Diese Datei enthält NUR Development- und Test-Credentials.');
  lines.push('> NIEMALS Production-Secrets hier eintragen!');
  lines.push('');
  lines.push(`*Auto-generated: ${new Date(data.generatedAt).toLocaleString('de-AT')}*`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // Apps
  for (const app of data.apps) {
    lines.push(generateAppSection(app));
  }

  // Footer
  lines.push('---');
  lines.push('');
  lines.push('## 🔄 Regeneration');
  lines.push('');
  lines.push('**Manuell:**');
  lines.push('```bash');
  lines.push('cd /root/projekte/werkingflow/autopilot/cui');
  lines.push('npm run generate:shared-notes');
  lines.push('```');
  lines.push('');
  lines.push('**Automatisch:**');
  lines.push('- Git Hook: `post-merge` (nach `git pull`)');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## 📚 Sources');
  lines.push('');
  lines.push('1. **Supabase Seed:**');
  lines.push('   - `/root/projekte/werkingflow/platform/supabase/seed.sql`');
  lines.push('   - `/root/projekte/werkingflow/platform/supabase/seed_real.sql`');
  lines.push('');
  lines.push('2. **Test Scenarios:**');
  lines.push('   - `/root/projekte/werkingflow/tests/unified-tester/features/scenarios/`');
  lines.push('');

  writeFileSync(OUTPUT_FILE, lines.join('\n'));

  console.log(`✅ Shared notes generated: ${OUTPUT_FILE}`);
  console.log(`   Apps: ${data.apps.length}`);
  console.log(`   Total users: ${data.apps.reduce((sum, app) => sum + app.users.length, 0)}`);
  console.log(`   Size: ${(lines.join('\n').length / 1024).toFixed(1)} KB`);
}

main();
