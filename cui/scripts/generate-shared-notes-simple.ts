#!/usr/bin/env tsx
/**
 * generate-shared-notes-simple.ts
 * Liest aus per-app test-credentials.json ODER zentralem orchestrator/config/test-credentials.json
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

// Centralized registry format (orchestrator/config/test-credentials.json)
interface CentralUser {
  email: string;
  password: string;
  profile: { first_name: string; last_name: string; company?: string };
  purpose?: string;
}

interface CentralApp {
  app_name: string;
  supabase_port?: number;
  users: CentralUser[];
}

interface CentralRegistry {
  credentials: Record<string, CentralApp>;
}

interface AppConfig {
  appId: string;
  name: string;
  credentialsPath: string;
  users: Record<string, TestUser>;
  localUrl?: string;
  stagedUrl?: string;
}

// URL mapping for known apps (ports from ports.json, staged from Vercel)
const APP_URLS: Record<string, { localPort?: number; stagedUrl?: string }> = {
  'engelmann': { localPort: 3009, stagedUrl: 'https://engelmann.vercel.app' },
  'platform': { localPort: 3004, stagedUrl: 'https://werkingflow.vercel.app' },
  'werking-report': { localPort: 3008, stagedUrl: 'https://werking-report.vercel.app' },
  'werking-energy': { localPort: 3007, stagedUrl: 'https://werking-energy.vercel.app' },
  'werking-safety': { localPort: 3006, stagedUrl: 'https://werking-safety.vercel.app' },
  'werking-noise': { localPort: 3005 },
  'acro-community': { localPort: 3011, stagedUrl: 'https://acro-community.vercel.app' },
};

// Auto-discover apps with test-credentials.json by scanning filesystem
function scanForCredentials(baseDir: string, maxDepth: number = 3, currentDepth: number = 0): string[] {
  const results: string[] = [];

  if (currentDepth > maxDepth || !existsSync(baseDir)) return results;

  try {
    const entries = readdirSync(baseDir);

    for (const entry of entries) {
      const fullPath = join(baseDir, entry);

      // Skip node_modules, .git, dist, build, archive, etc.
      if (['.git', 'node_modules', 'dist', 'build', '.next', '.vercel'].includes(entry)) {
        continue;
      }
      // Skip archive directories
      if (entry.startsWith('_archive')) continue;

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

// Parse centralized registry format into AppConfig[]
function parseCentralRegistry(filePath: string): AppConfig[] {
  const apps: AppConfig[] = [];
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!raw.credentials) return apps;

    console.log(`  📦 Reading centralized registry: ${filePath}`);

    for (const [appId, appData] of Object.entries(raw.credentials) as [string, CentralApp][]) {
      if (!appData.users || appData.users.length === 0) continue;

      // Convert array-based users to Record format
      const users: Record<string, TestUser> = {};
      for (const u of appData.users) {
        const role = u.purpose?.includes('E2E') ? 'test' : u.purpose?.includes('Demo') ? 'demo' : u.email.split('@')[0];
        users[role] = {
          email: u.email,
          password: u.password,
          name: `${u.profile.first_name} ${u.profile.last_name}`.trim(),
        };
      }

      const urls = APP_URLS[appId];
      apps.push({
        appId,
        name: appData.app_name,
        credentialsPath: filePath,
        users,
        localUrl: urls?.localPort ? `http://localhost:${urls.localPort}` : undefined,
        stagedUrl: urls?.stagedUrl,
      });

      console.log(`  ✅ ${appData.app_name}: ${appData.users.length} users (from central registry)`);
    }
  } catch (error) {
    console.error(`  ⚠️  Failed to read central registry ${filePath}:`, error);
  }
  return apps;
}

function discoverApps(): AppConfig[] {
  const apps: AppConfig[] = [];
  const seenAppIds = new Set<string>();

  console.log(`🔍 Scanning ${GH} for test-credentials.json files...`);
  const credentialPaths = scanForCredentials(GH);
  console.log(`   Found ${credentialPaths.length} credential files\n`);

  // 1) Per-app test-credentials.json (preferred — has full app metadata)
  for (const credPath of credentialPaths) {
    try {
      const raw = JSON.parse(readFileSync(credPath, 'utf8'));

      // Skip centralized registry format (has "credentials" wrapper)
      if (raw.credentials) continue;

      const credentials = raw as TestCredentials;

      // Skip if no users defined
      if (!credentials.users || Object.keys(credentials.users).length === 0) {
        continue;
      }

      const appDir = dirname(dirname(credPath));
      const appName = credentials.app?.name || appDir.split('/').pop()!;
      const appId = credentials.app?.id || appName.toLowerCase().replace(/\s+/g, '-');

      seenAppIds.add(appId);
      apps.push({
        appId,
        name: appName,
        credentialsPath: credPath,
        users: credentials.users,
        localUrl: credentials.app?.localUrl,
        stagedUrl: credentials.app?.stagedUrl,
      });

      console.log(`  ✅ ${appName}: ${Object.keys(credentials.users).length} users`);
    } catch (error) {
      console.error(`  ⚠️  Failed to read ${credPath}:`, error);
    }
  }

  // 2) Always merge centralized orchestrator/config/test-credentials.json (adds missing apps)
  console.log('\n  📋 Merging centralized registry (adds apps not found per-app)...');
  const centralPaths = [
    join(GH, 'orchestrator/config/test-credentials.json'),
  ];
  for (const cp of centralPaths) {
    if (existsSync(cp)) {
      const centralApps = parseCentralRegistry(cp);
      for (const ca of centralApps) {
        if (!seenAppIds.has(ca.appId)) {
          seenAppIds.add(ca.appId);
          apps.push(ca);
        }
      }
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
  const users = Object.entries(app.users);

  if (users.length === 0) continue;

  totalApps++;
  totalUsers += users.length;

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
