#!/usr/bin/env tsx
/**
 * generate-shared-notes-simple.ts
 *
 * Generates shared-notes markdown from per-app test-credentials.json files.
 * Priority: per-app config/test-credentials.json > central orchestrator registry (fallback only).
 *
 * DEFENSIVE: Fails loud on missing/corrupt credentials. No silent fallbacks.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs';
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

if (!existsSync(GH)) {
  throw new Error(`Base directory not found: ${GH}. Cannot scan for credentials.`);
}

// --- Interfaces ---

interface TestUser {
  email: string;
  password: string;
  name?: string;
  role?: string;
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

interface AppConfig {
  appId: string;
  name: string;
  credentialsPath: string;
  users: Record<string, TestUser>;
  localUrl?: string;
  stagedUrl?: string;
}

// --- Constants ---

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.vercel']);
const MAX_SCAN_DEPTH = 5;

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

// --- Validation ---

function validateUser(user: unknown, role: string, appId: string): TestUser {
  if (!user || typeof user !== 'object') {
    throw new Error(`[${appId}] User "${role}" is not an object`);
  }
  const u = user as Record<string, unknown>;
  if (typeof u.email !== 'string' || !u.email.includes('@')) {
    throw new Error(`[${appId}] User "${role}" has invalid email: ${JSON.stringify(u.email)}`);
  }
  if (typeof u.password !== 'string' || u.password.length === 0) {
    throw new Error(`[${appId}] User "${role}" has empty or missing password`);
  }
  return {
    email: u.email,
    password: u.password,
    name: typeof u.name === 'string' ? u.name : undefined,
    role: typeof u.role === 'string' ? u.role : undefined,
    tenantId: typeof u.tenantId === 'string' ? u.tenantId : undefined,
  };
}

function resolveUrls(appId: string, app?: TestCredentials['app']): { localUrl?: string; stagedUrl?: string } {
  const fallback = APP_URLS[appId];
  return {
    localUrl: app?.localUrl || (fallback?.localPort ? `http://localhost:${fallback.localPort}` : undefined),
    stagedUrl: app?.stagedUrl || fallback?.stagedUrl,
  };
}

// --- Filesystem scan ---

function scanForCredentials(baseDir: string, currentDepth: number = 0): string[] {
  const results: string[] = [];
  if (currentDepth > MAX_SCAN_DEPTH || !existsSync(baseDir)) return results;

  let entries: string[];
  try {
    entries = readdirSync(baseDir);
  } catch {
    console.error(`  ⚠️  Cannot read directory: ${baseDir}`);
    return results;
  }

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry) || entry.startsWith('_archive')) continue;

    const fullPath = join(baseDir, entry);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }

    if (entry === 'test-credentials.json' && stat.isFile()) {
      results.push(fullPath);
    } else if (stat.isDirectory()) {
      results.push(...scanForCredentials(fullPath, currentDepth + 1));
    }
  }

  return results;
}

// --- Parsers ---

function parsePerAppCredentials(credPath: string): AppConfig | null {
  const raw = JSON.parse(readFileSync(credPath, 'utf8'));

  // Skip centralized registry format
  if (raw.credentials) return null;

  const credentials = raw as TestCredentials;
  if (!credentials.users || Object.keys(credentials.users).length === 0) {
    console.warn(`  ⚠️  No users in ${credPath} — skipping`);
    return null;
  }

  const appDir = dirname(dirname(credPath));
  const appName = credentials.app?.name || appDir.split('/').pop()!;
  const appId = credentials.app?.id || appName.toLowerCase().replace(/\s+/g, '-');

  // Validate every user
  const validatedUsers: Record<string, TestUser> = {};
  for (const [role, user] of Object.entries(credentials.users)) {
    validatedUsers[role] = validateUser(user, role, appId);
  }

  const urls = resolveUrls(appId, credentials.app);
  return {
    appId,
    name: appName,
    credentialsPath: credPath,
    users: validatedUsers,
    localUrl: urls.localUrl,
    stagedUrl: urls.stagedUrl,
  };
}

function parseCentralRegistry(filePath: string): AppConfig[] {
  const raw = JSON.parse(readFileSync(filePath, 'utf8'));
  if (!raw.credentials) {
    throw new Error(`Central registry ${filePath} has no "credentials" key`);
  }

  console.log(`  📦 Reading centralized registry: ${filePath}`);
  const apps: AppConfig[] = [];

  for (const [appId, appData] of Object.entries(raw.credentials) as [string, CentralApp][]) {
    if (!appData.users || appData.users.length === 0) continue;

    const users: Record<string, TestUser> = {};
    for (const u of appData.users) {
      if (!u.email || !u.password) {
        throw new Error(`[${appId}] Central registry user missing email/password: ${JSON.stringify(u)}`);
      }
      const role = u.purpose?.includes('E2E') ? 'test' : u.purpose?.includes('Demo') ? 'demo' : u.email.split('@')[0];
      users[role] = {
        email: u.email,
        password: u.password,
        name: `${u.profile.first_name} ${u.profile.last_name}`.trim() || undefined,
      };
    }

    const urls = resolveUrls(appId);
    apps.push({
      appId,
      name: appData.app_name,
      credentialsPath: filePath,
      users,
      localUrl: urls.localUrl,
      stagedUrl: urls.stagedUrl,
    });

    console.log(`  ✅ ${appData.app_name}: ${appData.users.length} users (from central registry)`);
  }

  return apps;
}

// --- Discovery ---

function discoverApps(): AppConfig[] {
  const apps: AppConfig[] = [];
  const seenAppIds = new Set<string>();

  console.log(`🔍 Scanning ${GH} for test-credentials.json files...`);
  const credentialPaths = scanForCredentials(GH);
  console.log(`   Found ${credentialPaths.length} credential files\n`);

  if (credentialPaths.length === 0) {
    throw new Error(`No test-credentials.json files found under ${GH}. Check filesystem structure.`);
  }

  // 1) Per-app test-credentials.json (preferred — has all users per app)
  for (const credPath of credentialPaths) {
    try {
      const app = parsePerAppCredentials(credPath);
      if (!app) continue;

      seenAppIds.add(app.appId);
      apps.push(app);
      console.log(`  ✅ ${app.name}: ${Object.keys(app.users).length} users`);
    } catch (error) {
      // Fail loud — do not silently skip broken credential files
      throw new Error(`Failed to parse ${credPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 2) Central registry as fallback (only adds apps not already found per-app)
  const centralPath = join(GH, 'orchestrator/config/test-credentials.json');
  if (existsSync(centralPath)) {
    console.log('\n  📋 Merging centralized registry (adds apps not found per-app)...');
    const centralApps = parseCentralRegistry(centralPath);
    for (const ca of centralApps) {
      if (!seenAppIds.has(ca.appId)) {
        seenAppIds.add(ca.appId);
        apps.push(ca);
      }
    }
  }

  if (apps.length === 0) {
    throw new Error('Zero apps discovered. Something is fundamentally wrong.');
  }

  return apps;
}

// --- Markdown generation ---

function generateMarkdown(apps: AppConfig[]): string {
  const now = new Date().toISOString().split('T')[0];
  const time = new Date().toTimeString().split(' ')[0].slice(0, 5);

  let md = `# 🔐 Shared Notes - Zugangsdaten

**⚠️ FOR DEVELOPMENT ONLY - NEVER COMMIT PRODUCTION CREDENTIALS**

*Auto-generated: ${now} ${time}*
*Source: config/test-credentials.json (Single Source of Truth per App)*

---

`;

  let totalUsers = 0;
  let totalApps = 0;

  for (const app of apps) {
    const users = Object.entries(app.users);
    if (users.length === 0) continue;

    totalApps++;
    totalUsers += users.length;

    md += `## ${app.name}\n\n`;
    md += `| User | Email | Password | Role | Environment |\n`;
    md += `|------|-------|----------|------|-------------|\n`;

    for (const [role, user] of users) {
      const envs: string[] = [];
      if (app.localUrl) envs.push(`**Local:** ${app.localUrl}`);
      if (app.stagedUrl) envs.push(`**Staged:** ${app.stagedUrl}`);
      const environment = envs.length > 0 ? envs.join('<br>') : '—';

      const displayName = user.name || role.charAt(0).toUpperCase() + role.slice(1);
      md += `| ${displayName} | ${user.email} | \`${user.password}\` | ${role} | ${environment} |\n`;
    }

    md += `\n---\n\n`;
  }

  md += `## 📋 Summary

- **Total Apps:** ${totalApps}
- **Total Users:** ${totalUsers}
- **Last Updated:** ${now} ${time}

---

*Run \`npm run generate:shared-notes\` to update this file*
*Source of Truth: \`config/test-credentials.json\` in each app*
`;

  return md;
}

// --- Main ---

const apps = discoverApps();
console.log('📝 Generating Shared Notes from test-credentials.json files...');

const markdown = generateMarkdown(apps);

// Ensure output directory exists
const outputDir = dirname(OUTPUT_MD);
if (!existsSync(outputDir)) {
  mkdirSync(outputDir, { recursive: true });
}

writeFileSync(OUTPUT_MD, markdown);

const totalUsers = apps.reduce((sum, a) => sum + Object.keys(a.users).length, 0);
console.log(`\n✅ Shared Notes generated: ${OUTPUT_MD}`);
console.log(`   Apps: ${apps.length}`);
console.log(`   Users: ${totalUsers}`);
