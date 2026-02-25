#!/usr/bin/env tsx
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// ESM compatibility
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CREDENTIALS_JSON = join(__dirname, '../data/credentials.json');
const OUTPUT_MD = join(__dirname, '../data/notes/shared.md');

interface User {
  name?: string;
  email: string;
  password?: string;
  role?: string;
  tenant?: string;
  environments?: {
    local?: string;
    staged?: string;
    production?: string;
  };
  scenarios?: string[];
  notes?: string;
}

interface AppData {
  name: string;
  users: User[];
}

interface CredentialsData {
  [appId: string]: AppData;
}

console.log('📝 Generating Shared Notes...');

if (!existsSync(CREDENTIALS_JSON)) {
  console.error('❌ credentials.json not found. Run `npm run aggregate:credentials` first.');
  process.exit(1);
}

const credentials: CredentialsData = JSON.parse(readFileSync(CREDENTIALS_JSON, 'utf8'));

const now = new Date().toISOString().split('T')[0];
const time = new Date().toTimeString().split(' ')[0].slice(0, 5);

let markdown = `# 🔐 Shared Notes - Zugangsdaten

**⚠️ FOR DEVELOPMENT ONLY - NEVER COMMIT PRODUCTION CREDENTIALS**

*Auto-generated: ${now} ${time}*

---

`;

for (const [appId, appData] of Object.entries(credentials)) {
  markdown += `## ${appData.name}\n\n`;

  if (appData.users.length === 0) {
    markdown += `*No users found*\n\n`;
    continue;
  }

  // Table header
  markdown += `| User | Email | Password | Tenant | Role | Environment |\n`;
  markdown += `|------|-------|----------|--------|------|-------------|\n`;

  for (const user of appData.users) {
    const name = user.name || '—';
    const email = user.email;
    const password = user.password || (user.notes ? user.notes : 'See Scenario');
    const tenant = user.tenant || '—';
    const role = user.role || '—';

    // Build environment string
    const envs: string[] = [];
    if (user.environments?.local) envs.push(`**Local:** ${user.environments.local}`);
    if (user.environments?.staged) envs.push(`**Staged:** ${user.environments.staged}`);
    if (user.environments?.production) envs.push(`**Prod:** ${user.environments.production}`);
    const environment = envs.length > 0 ? envs.join('<br>') : '—';

    markdown += `| ${name} | ${email} | \`${password}\` | ${tenant} | ${role} | ${environment} |\n`;
  }

  // Scenarios section
  const allScenarios = appData.users.flatMap(u => u.scenarios || []);
  const uniqueScenarios = [...new Set(allScenarios)].sort();

  if (uniqueScenarios.length > 0) {
    markdown += `\n**Scenarios:**\n`;
    for (const scenario of uniqueScenarios.slice(0, 10)) { // Max 10 scenarios
      markdown += `- \`${scenario}\`\n`;
    }
    if (uniqueScenarios.length > 10) {
      markdown += `- ... and ${uniqueScenarios.length - 10} more\n`;
    }
  }

  markdown += `\n---\n\n`;
}

markdown += `## 📋 Summary

- **Total Apps:** ${Object.keys(credentials).length}
- **Total Users:** ${Object.values(credentials).reduce((sum, app) => sum + app.users.length, 0)}
- **Last Updated:** ${now} ${time}

---

*Run \`npm run generate:shared-notes\` to update this file*
`;

writeFileSync(OUTPUT_MD, markdown);
console.log(`✅ Shared Notes generated: ${OUTPUT_MD}`);
console.log(`   Apps: ${Object.keys(credentials).length}`);
console.log(`   Users: ${Object.values(credentials).reduce((sum, app) => sum + app.users.length, 0)}`);
