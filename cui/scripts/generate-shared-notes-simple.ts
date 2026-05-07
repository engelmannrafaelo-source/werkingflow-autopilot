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

// Golden Test info per app — dynamically discovered from scenario JSONs with tier === 4
interface GoldenTestInfo {
  email: string;
  scenario: string;
}

// Scenarios base path (unified-tester)
const SCENARIOS_PATHS = [
  join(GH, 'werkingflow/tests/unified-tester/features/scenarios'),
  join(GH, 'werkingflow-production/tests/unified-tester/features/scenarios'),
];

/**
 * Recursively collect all .json files from a directory (max depth 4).
 */
function collectJsonFiles(dir: string, depth: number = 0): string[] {
  if (depth > 4 || !existsSync(dir)) return [];
  const results: string[] = [];
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return []; }

  for (const entry of entries) {
    if (entry.startsWith('_') || entry.startsWith('.')) continue;
    const fullPath = join(dir, entry);
    let stat;
    try { stat = statSync(fullPath); } catch { continue; }
    if (stat.isFile() && entry.endsWith('.json')) {
      results.push(fullPath);
    } else if (stat.isDirectory()) {
      results.push(...collectJsonFiles(fullPath, depth + 1));
    }
  }
  return results;
}

/**
 * Scan all scenario JSON files for tier/layer === 4 (Golden Tests).
 * Searches recursively through all subdirectories (layer-4-golden/, layer-4/, etc.).
 * Extracts the test_user email and scenario ID per app.
 * Returns a map: appId → { email, scenario }
 */
function discoverGoldenTests(apps: AppConfig[]): Record<string, GoldenTestInfo> {
  // Build a lookup: appId → default user email (from test-credentials.json default_user)
  const defaultUserEmails: Record<string, string> = {};
  for (const app of apps) {
    // Read the original credentials file to get default_user
    try {
      const raw = JSON.parse(readFileSync(app.credentialsPath, 'utf8'));
      if (raw.default_user && raw.users?.[raw.default_user]?.email) {
        defaultUserEmails[app.appId] = raw.users[raw.default_user].email;
      }
    } catch { /* ignore */ }
  }
  const goldenMap: Record<string, GoldenTestInfo> = {};

  for (const scenariosBase of SCENARIOS_PATHS) {
    if (!existsSync(scenariosBase)) continue;

    let appDirs: string[];
    try { appDirs = readdirSync(scenariosBase); } catch { continue; }

    for (const appDir of appDirs) {
      if (appDir.startsWith('_') || appDir.startsWith('.')) continue;
      const appPath = join(scenariosBase, appDir);
      let stat;
      try { stat = statSync(appPath); } catch { continue; }
      if (!stat.isDirectory()) continue;

      // Recursively find ALL json files in this app's scenario directory
      const jsonFiles = collectJsonFiles(appPath);

      for (const filePath of jsonFiles) {
        const file = filePath.split('/').pop()!;
        try {
          const raw = JSON.parse(readFileSync(filePath, 'utf8'));

          // Check for tier/layer 4 (Golden) — field name varies across apps
          const tier = raw.tier ?? raw.layer ?? raw.meta?.tier ?? raw.meta?.layer;
          // Also detect by directory name (layer-4-golden/, layer-4/)
          const inGoldenDir = filePath.includes('layer-4');
          if (tier !== 4 && !inGoldenDir) continue;

          // Extract app system id
          const system: string = raw.system || raw.config?.app || appDir;
          // Extract test user email — various formats across apps:
          // - credentials.test_user.email (werking-energy, acro, safety)
          // - credentials.admin_user.email (acro fallback)
          // - credentials.email (engelmann mental-model format)
          // - test_data.credentials.email (engelmann layer-4)
          // - user (werking-report top-level)
          const email: string | undefined =
            raw.credentials?.test_user?.email ||
            raw.credentials?.admin_user?.email ||
            raw.credentials?.email ||
            raw.test_data?.credentials?.email ||
            raw.user;
          // Extract scenario id
          const scenarioId: string = raw.id || raw.scenario_id || file.replace('.json', '');
          const scenarioName: string = raw.name || raw.tier_name || raw.description || scenarioId;

          // Fallback: use default_user from test-credentials.json if scenario has no email
          const resolvedEmail = email || defaultUserEmails[system];
          if (!resolvedEmail) continue;

          // Prefer scenarios with "golden" in filename/id (most canonical per app)
          const existing = goldenMap[system];
          const hasGolden = file.includes('golden') || scenarioId.includes('golden');
          const existingHasGolden = existing?.scenario.includes('golden');
          const isMoreCanonical = !existing || (hasGolden && !existingHasGolden);

          if (isMoreCanonical) {
            goldenMap[system] = {
              email: resolvedEmail,
              scenario: `${scenarioId} (${scenarioName})`,
            };
          }
        } catch {
          // Skip unparseable scenario files
        }
      }
    }
  }

  return goldenMap;
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

  // Validate every user (skip incomplete entries with warning)
  const validatedUsers: Record<string, TestUser> = {};
  for (const [role, user] of Object.entries(credentials.users)) {
    try {
      validatedUsers[role] = validateUser(user, role, appId);
    } catch (e) {
      console.warn(`  ⚠️  Skipping incomplete user "${role}" in ${appId}: ${e instanceof Error ? e.message : e}`);
    }
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

// --- Partner CUI Login ---

interface PartnerCuiUser {
  name: string;
  username: string;
  password: string;
  workspaces: string[];
}

interface PartnerCuiCredentials {
  _note?: string;
  url: string;
  users: PartnerCuiUser[];
}

function generatePartnerSection(): string | null {
  const ssotPath = join(GH, 'werkingflow-production/config/partner-cui-credentials.json');
  if (!existsSync(ssotPath)) {
    console.warn(`  ⚠️  partner-cui-credentials.json not found at ${ssotPath}`);
    return null;
  }

  try {
    const data = JSON.parse(readFileSync(ssotPath, 'utf8')) as PartnerCuiCredentials;
    if (!data.users?.length) return null;

    let md = `## Partner CUI Login (${data.url})\n\n`;
    md += `| Partner | Username | Password | Workspace |\n`;
    md += `|---------|----------|----------|-----------|\n`;
    for (const u of data.users) {
      const workspace = u.workspaces.join(', ');
      md += `| ${u.name} | \`${u.username}\` | \`${u.password}\` | ${workspace} |\n`;
    }
    md += `\n---\n\n`;
    return md;
  } catch (e) {
    console.warn(`  ⚠️  Could not read partner-cui-credentials.json: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

// --- Markdown generation ---

function generateMarkdown(apps: AppConfig[], goldenTests: Record<string, GoldenTestInfo>): string {
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

    const goldenInfo = goldenTests[app.appId];

    md += `## ${app.name}\n\n`;

    // Show golden test info banner if available
    if (goldenInfo) {
      md += `**GOLDEN TEST:** \`${goldenInfo.scenario}\` → ${goldenInfo.email}\n\n`;
    }

    md += `| User | Email | Password | Role | Environment |\n`;
    md += `|------|-------|----------|------|-------------|\n`;

    for (const [role, user] of users) {
      const envs: string[] = [];
      if (app.localUrl) envs.push(`**Local:** ${app.localUrl}`);
      if (app.stagedUrl) envs.push(`**Staged:** ${app.stagedUrl}`);
      const environment = envs.length > 0 ? envs.join('<br>') : '—';

      const isGolden = goldenInfo && user.email === goldenInfo.email;
      const displayName = user.name || role.charAt(0).toUpperCase() + role.slice(1);
      const goldenMarker = isGolden ? ' **[GOLDEN]**' : '';
      md += `| ${displayName}${goldenMarker} | ${user.email} | \`${user.password}\` | ${role} | ${environment} |\n`;
    }

    md += `\n---\n\n`;
  }

  // --- Partner CUI Login section (from credentials.json partnerCuiLogin) ---
  const partnerSection = generatePartnerSection();
  if (partnerSection) {
    md += partnerSection;
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

console.log('\n🏆 Discovering Golden Tests (tier 4) from scenario files...');
const goldenTests = discoverGoldenTests(apps);
const goldenCount = Object.keys(goldenTests).length;
for (const [appId, info] of Object.entries(goldenTests)) {
  console.log(`  🥇 ${appId}: ${info.email} → ${info.scenario}`);
}
console.log(`   Found ${goldenCount} golden test(s)\n`);

console.log('📝 Generating Shared Notes...');
const markdown = generateMarkdown(apps, goldenTests);

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
