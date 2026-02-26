#!/usr/bin/env tsx
/**
 * generate-shared-notes-simple.ts
 * Liest DIREKT aus test-credentials.json Files (Single Source of Truth)
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const OUTPUT_MD = join(__dirname, '../data/notes/shared.md');

const HOME = homedir();
const GH = existsSync(join(HOME, 'Documents/GitHub/werkingflow')) 
  ? join(HOME, 'Documents/GitHub') 
  : '/root/projekte';

interface TestUser {
  email: string;
  password: string;
  name: string;
  tenantId?: string;
}

interface TestCredentials {
  _comment?: string;
  _updated?: string;
  default_user?: string;
  users: Record<string, TestUser>;
  app?: {
    name?: string;
    id?: string;
    localUrl?: string;
    stagedUrl?: string;
  };
}

interface AppConfig {
  appId: string;
  name: string;
  credentialsPath: string;
  localUrl?: string;
  stagedUrl?: string;
}

// Auto-discover apps with test-credentials.json by scanning filesystem
function scanForCredentials(baseDir: string, maxDepth: number = 3, currentDepth: number = 0): string[] {
  const results: string[] = [];

  if (currentDepth > maxDepth || !existsSync(baseDir)) return results;

  try {
    const entries = readdirSync(baseDir);

    for (const entry of entries) {
      const fullPath = join(baseDir, entry);

      // Skip node_modules, .git, dist, etc
      if (['.git', 'node_modules', 'dist', 'build', '.next', '.vercel'].includes(entry)) {
        continue;
      }

      try {
        const stat = statSync(fullPath);

        // Found test-credentials.json!
        if (entry === 'test-credentials.json') {
          results.push(fullPath);
          continue;
        }

        // Recurse into directories
        if (stat.isDirectory()) {
          results.push(...scanForCredentials(fullPath, maxDepth, currentDepth + 1));
        }
      } catch (err) {
        // Skip inaccessible paths
        continue;
      }
    }
  } catch (err) {
    // Skip inaccessible directories
  }

  return results;
}

function discoverApps(): AppConfig[] {
  const apps: AppConfig[] = [];

  console.log(`🔍 Scanning ${GH} for test-credentials.json files...`);
  const credentialPaths = scanForCredentials(GH);
  console.log(`   Found ${credentialPaths.length} credential files\n`);

  for (const credPath of credentialPaths) {
    try {
      const credentials: TestCredentials = JSON.parse(readFileSync(credPath, 'utf8'));

      // Skip if no users defined
      if (!credentials.users || Object.keys(credentials.users).length === 0) {
        continue;
      }

      // Extract app info from credentials or fallback to directory name
      const appDir = dirname(dirname(credPath)); // Go up from config/test-credentials.json
      const appName = credentials.app?.name || appDir.split('/').pop()!;
      const appId = credentials.app?.id || appName.toLowerCase().replace(/\s+/g, '-');

      apps.push({
        appId,
        name: appName,
        credentialsPath: credPath,
        localUrl: credentials.app?.localUrl,
        stagedUrl: credentials.app?.stagedUrl,
      });
    } catch (error) {
      console.error(`  ⚠️  Failed to read ${credPath}:`, error);
    }
  }

  return apps;
}

const apps = discoverApps();

console.log('📝 Generating Shared Notes from test-credentials.json files...');

const now = new Date().toISOString().split('T')[0];
const time = new Date().toTimeString().split(' ')[0].slice(0, 5);

let markdown = `# 🔐 Shared Notes - Zugangsdaten

**⚠️ FOR DEVELOPMENT ONLY - NEVER COMMIT PRODUCTION CREDENTIALS**

*Auto-generated: ${now} ${time}*
*Source: config/test-credentials.json (Single Source of Truth)*

---

`;

let totalUsers = 0;
let totalApps = 0;

for (const app of apps) {
  if (!existsSync(app.credentialsPath)) {
    console.log(`  ⏭️  ${app.name}: No credentials file found`);
    continue;
  }

  try {
    const credentials: TestCredentials = JSON.parse(readFileSync(app.credentialsPath, 'utf8'));
    const users = Object.entries(credentials.users);

    if (users.length === 0) {
      console.log(`  ⏭️  ${app.name}: No users found`);
      continue;
    }

    totalApps++;
    totalUsers += users.length;

    console.log(`  ✅ ${app.name}: ${users.length} users`);

    markdown += `## ${app.name}\n\n`;
    markdown += `| User | Email | Password | Role | Environment |\n`;
    markdown += `|------|-------|----------|------|-------------|\n`;

    for (const [role, user] of users) {
      const envs: string[] = [];
      if (app.localUrl) envs.push(`**Local:** ${app.localUrl}`);
      if (app.stagedUrl) envs.push(`**Staged:** ${app.stagedUrl}`);
      const environment = envs.length > 0 ? envs.join('<br>') : '—';

      markdown += `| ${user.name} | ${user.email} | \`${user.password}\` | ${role} | ${environment} |\n`;
    }

    markdown += `\n---\n\n`;
  } catch (error) {
    console.error(`  ❌ ${app.name}: Failed to read credentials`, error);
  }
}

markdown += `## 📋 Summary

- **Total Apps:** ${totalApps}
- **Total Users:** ${totalUsers}
- **Last Updated:** ${now} ${time}

---

*Run \`npm run generate:shared-notes\` to update this file*
*Source of Truth: \`config/test-credentials.json\` in each app*
`;

writeFileSync(OUTPUT_MD, markdown);
console.log(`\n✅ Shared Notes generated: ${OUTPUT_MD}`);
console.log(`   Apps: ${totalApps}`);
console.log(`   Users: ${totalUsers}`);
