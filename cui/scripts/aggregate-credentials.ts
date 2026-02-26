#!/usr/bin/env tsx
/**
 * aggregate-credentials.ts
 * Scans CLAUDE.md files + seed.sql + scenario JSONs for test credentials.
 * Outputs data/credentials.json for generate-shared-notes.ts.
 *
 * Works on local Mac (primary) with fallback for Hetzner paths.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const OUTPUT = join(__dirname, '../data/credentials.json');

const HOME = homedir();
const GH_MAC = join(HOME, 'Documents/GitHub');
const GH = existsSync(join(GH_MAC, 'werkingflow/platform/CLAUDE.md')) ? GH_MAC : '/root/projekte';

// Try local Mac paths first, then Hetzner
const PLATFORM_ROOT = existsSync(join(GH, 'werkingflow/platform'))
  ? join(GH, 'werkingflow/platform')
  : '/root/projekte/werkingflow/platform';
const TESTS_ROOT = existsSync(join(GH, 'werkingflow/tests'))
  ? join(GH, 'werkingflow/tests')
  : '/root/projekte/werkingflow/tests';

// --- Types ---
interface User {
  name?: string;
  email: string;
  password?: string;
  role?: string;
  tenant?: string;
  userId?: string;
  environments?: { local?: string; staged?: string; production?: string };
  scenarios?: string[];
  notes?: string;
}

interface AppData {
  name: string;
  productionUrl?: string;
  users: User[];
  extras?: string[];
}

type CredentialsData = Record<string, AppData>;

const credentials: CredentialsData = {};

function addUser(appId: string, appName: string, user: User, prodUrl?: string) {
  if (!credentials[appId]) {
    credentials[appId] = { name: appName, productionUrl: prodUrl, users: [], extras: [] };
  }
  if (prodUrl && !credentials[appId].productionUrl) {
    credentials[appId].productionUrl = prodUrl;
  }
  const existing = credentials[appId].users.find(u => u.email === user.email);
  if (existing) {
    if (user.password && !existing.password) existing.password = user.password;
    if (user.role && !existing.role) existing.role = user.role;
    if (user.name && !existing.name) existing.name = user.name;
    if (user.userId && !existing.userId) existing.userId = user.userId;
    if (user.tenant && !existing.tenant) existing.tenant = user.tenant;
    if (user.environments) {
      existing.environments = { ...existing.environments, ...user.environments };
    }
    if (user.scenarios) {
      existing.scenarios = [...new Set([...(existing.scenarios || []), ...user.scenarios])];
    }
  } else {
    credentials[appId].users.push(user);
  }
}

// ═══════════════════════════════════════
// 1. GLOBAL POWER TEST USER (always)
// ═══════════════════════════════════════
console.log('1. Global Test User...');
addUser('_global', 'Global (alle Supabase Apps)', {
  name: 'Power Test User',
  email: 'test@werkingflow.com',
  password: 'TestUser2024!',
  role: 'super_admin',
  userId: 'd44b2bb4-2dd7-4910-b904-dd1ba8869133',
  notes: 'Funktioniert in allen Werkingflow-Apps',
});
credentials['_global'].extras = [
  'Supabase: https://ilnoeveehrnhuljvzyab.supabase.co',
  'Mollie Test-Karte: 4111 1111 1111 1111 (beliebiges Datum)',
];

// ═══════════════════════════════════════
// 2. SCAN CLAUDE.MD FILES
// ═══════════════════════════════════════
console.log('2. Scanning CLAUDE.md files...');

interface SourceDef {
  appId: string;
  name: string;
  claudeMd: string;
  prodUrl: string;
}

const sources: SourceDef[] = [
  { appId: 'werkingflow-platform', name: 'Werkingflow Platform', claudeMd: join(GH, 'werkingflow/platform/CLAUDE.md'), prodUrl: 'https://werkingflow.com' },
  { appId: 'werking-report', name: 'WerkING Report', claudeMd: join(GH, 'werking-report/CLAUDE.md'), prodUrl: 'https://werking-report.vercel.app' },
  { appId: 'engelmann-ai-hub', name: 'Engelmann AI Hub', claudeMd: join(GH, 'engelmann-ai-hub/CLAUDE.md'), prodUrl: 'https://engelmann-ai-hub.vercel.app' },
  { appId: 'werking-safety', name: 'WerkING Safety', claudeMd: join(GH, 'werking-safety/CLAUDE.md'), prodUrl: 'https://werking-safety.vercel.app' },
  { appId: 'werking-energy', name: 'WerkING Energy', claudeMd: join(GH, 'apps/werking-energy/CLAUDE.md'), prodUrl: 'https://werking-energy.vercel.app' },
  { appId: 'eco-diagnostics', name: 'ECO Diagnostics', claudeMd: join(GH, 'apps/eco-diagnostics/CLAUDE.md'), prodUrl: 'https://diagnostics.ecoenergygroup.com' },
];

function extractCredsFromClaude(text: string): User[] {
  const users: User[] = [];
  const seen = new Set<string>();

  // Pattern 1: Table rows with valid email address | password
  // Email must be a real email: word@word.word (max 60 chars to avoid matching CLAUDE.md content)
  const tableRow = /\|\s*(?:\*\*)?([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})(?:\*\*)?\s*\|\s*(?:\*\*)?`?([^|`\n]{2,40}?)`?(?:\*\*)?\s*\|/g;
  let m;
  while ((m = tableRow.exec(text)) !== null) {
    const email = m[1].trim();
    const col2 = m[2].trim();
    if (col2.includes('---') || col2.toLowerCase() === 'password' || col2.toLowerCase() === 'passwort') continue;
    if (seen.has(email)) continue;
    seen.add(email);

    // Find role and userId near this email
    const idx = text.indexOf(email);
    const vicinity = text.slice(Math.max(0, idx - 300), idx + 600);
    const uuidMatch = vicinity.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    const lcVic = vicinity.toLowerCase();
    const role = lcVic.includes('super_admin') ? 'super_admin'
      : lcVic.includes('owner') ? 'owner'
      : lcVic.includes('admin') ? 'admin' : undefined;

    users.push({ email, password: col2, role, userId: uuidMatch?.[0] });
  }

  // Pattern 2: Feld|Wert vertical tables (like global CLAUDE.md)
  const fieldBlock = text.match(/(?:Test.?User|Testbenutzer)[^\n]*\n([\s\S]*?)(?=\n##|\n---|\n\n\n)/i);
  if (fieldBlock) {
    const fields: Record<string, string> = {};
    const fRegex = /\|\s*\*?\*?(\w[\w\s/-]*?)\*?\*?\s*\|\s*`?([^|`\n]+)`?\s*\|/g;
    let fm;
    while ((fm = fRegex.exec(fieldBlock[1])) !== null) {
      fields[fm[1].trim().toLowerCase()] = fm[2].trim();
    }
    if (fields.email && !seen.has(fields.email)) {
      seen.add(fields.email);
      users.push({
        email: fields.email,
        password: fields.password || fields.passwort,
        role: fields.role || fields.rolle,
        userId: fields['user id'],
      });
    }
  }

  // Pattern 3: ENV vars (ADMIN_EMAIL=xxx)
  const envEmail = text.match(/(?:ADMIN_EMAIL|TEST_EMAIL)\s*=\s*(\S+@\S+)/);
  const envPass = text.match(/(?:ADMIN_PASSWORD|TEST_PASSWORD)\s*=\s*(\S+)/);
  if (envEmail && envPass && envPass[1] !== 'xxx' && !seen.has(envEmail[1])) {
    users.push({ email: envEmail[1], password: envPass[1], role: 'admin', notes: '.env config' });
  }

  // Filter false positives (table headers parsed as emails)
  return users.filter(u => u.email.includes('@') && !u.email.startsWith('Password'));
}

for (const src of sources) {
  if (!existsSync(src.claudeMd)) {
    console.log(`  [SKIP] ${src.appId}: not found`);
    // Still register the app with global user reference
    addUser(src.appId, src.name, {
      email: 'test@werkingflow.com',
      password: 'TestUser2024!',
      role: 'super_admin',
      notes: 'Global Test User',
    }, src.prodUrl);
    continue;
  }

  const text = readFileSync(src.claudeMd, 'utf8');
  const found = extractCredsFromClaude(text);
  console.log(`  [OK] ${src.appId}: ${found.length} users found`);

  if (found.length > 0) {
    for (const u of found) addUser(src.appId, src.name, u, src.prodUrl);
  } else {
    addUser(src.appId, src.name, {
      email: 'test@werkingflow.com',
      password: 'TestUser2024!',
      role: 'super_admin',
      notes: 'Global Test User (kein app-spez. User in CLAUDE.md)',
    }, src.prodUrl);
  }
}

// ═══════════════════════════════════════
// 3. SCAN SEED.SQL (if available)
// ═══════════════════════════════════════
const seedPath = join(PLATFORM_ROOT, 'supabase/seed.sql');
if (existsSync(seedPath)) {
  console.log('3. Parsing seed.sql...');
  const sql = readFileSync(seedPath, 'utf8');
  const userPattern = /INSERT INTO auth\.users[\s\S]*?'([^']+@[^']+)'[\s\S]*?crypt\('([^']+)'/g;
  let sm;
  let seedCount = 0;
  while ((sm = userPattern.exec(sql)) !== null) {
    addUser('werkingflow-platform', 'Werkingflow Platform', {
      email: sm[1],
      password: sm[2],
      notes: 'from seed.sql',
    }, 'https://werkingflow.com');
    seedCount++;
  }
  console.log(`  [OK] ${seedCount} users from seed.sql`);
} else {
  console.log('3. seed.sql not found, skipping');
}

// ═══════════════════════════════════════
// 4. SCAN SCENARIO FILES (if available)
// ═══════════════════════════════════════
const scenariosDir = join(TESTS_ROOT, 'unified-tester/features/scenarios');
if (existsSync(scenariosDir)) {
  console.log('4. Scanning scenario files...');
  // Simple recursive glob without external dependency
  const { readdirSync, statSync } = await import('fs');
  function findJsonFiles(dir: string): string[] {
    const files: string[] = [];
    try {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        try {
          if (statSync(full).isDirectory()) {
            if (!entry.startsWith('_') && entry !== 'node_modules') files.push(...findJsonFiles(full));
          } else if (entry.endsWith('.json')) {
            files.push(full);
          }
        } catch {}
      }
    } catch {}
    return files;
  }

  const scenarioFiles = findJsonFiles(scenariosDir);
  let scenarioCount = 0;

  // Normalize scenario app IDs to match CLAUDE.md source IDs
  const appIdMap: Record<string, string> = {
    platform: 'werkingflow-platform',
    engelmann: 'engelmann-ai-hub',
    'werking-report': 'werking-report',
    gutachten: 'werking-report',
    'werking-energy': 'werking-energy',
    'energy-report': 'werking-energy',
    'werking-safety': 'werking-safety',
    teufel: 'werking-safety',
    'eco-diagnostics': 'eco-diagnostics',
  };
  const appNames: Record<string, string> = {
    'werkingflow-platform': 'Werkingflow Platform', 'engelmann-ai-hub': 'Engelmann AI Hub',
    'werking-report': 'WerkING Report', 'werking-energy': 'WerkING Energy',
    'werking-safety': 'WerkING Safety', 'eco-diagnostics': 'ECO Diagnostics',
  };

  for (const file of scenarioFiles) {
    try {
      const scenario = JSON.parse(readFileSync(file, 'utf8'));
      const rawApp = scenario.app || scenario.system || 'unknown';
      const app = appIdMap[rawApp] || rawApp;
      const name = appNames[app] || rawApp;
      const scenarioName = file.split('/scenarios/')[1]?.replace('.json', '') || 'unknown';

      const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

      // Only use actual login credentials, NOT persona character emails
      const creds = scenario.credentials?.test_user;
      if (creds?.email && isEmail(creds.email) && creds.password) {
        addUser(app, name, {
          name: scenario.persona?.name,
          email: creds.email,
          password: creds.password,
          role: scenario.persona?.rolle || scenario.persona?.typ,
          environments: { local: scenario.endpoints?.local_url, staged: scenario.endpoints?.base_url },
          scenarios: [scenarioName],
        });
        scenarioCount++;
      }
    } catch {}
  }
  console.log(`  [OK] ${scenarioFiles.length} files, ${scenarioCount} entries`);
} else {
  console.log('4. Scenarios dir not found, skipping');
}

// ═══════════════════════════════════════
// 5. WRITE OUTPUT
// ═══════════════════════════════════════
// Sort: _global first, then alphabetical
const sorted: CredentialsData = {};
const keys = Object.keys(credentials).sort((a, b) => {
  if (a.startsWith('_')) return -1;
  if (b.startsWith('_')) return 1;
  return a.localeCompare(b);
});
for (const k of keys) {
  sorted[k] = credentials[k];
  sorted[k].users.sort((a, b) => a.email.localeCompare(b.email));
}

mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, JSON.stringify(sorted, null, 2));

const totalUsers = Object.values(sorted).reduce((s, a) => s + a.users.length, 0);
console.log(`\nDone: ${OUTPUT}`);
console.log(`  Apps: ${keys.length}, Users: ${totalUsers}`);
