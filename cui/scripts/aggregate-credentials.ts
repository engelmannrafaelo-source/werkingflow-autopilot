#!/usr/bin/env tsx
/**
 * Credentials Aggregator
 *
 * Aggregiert alle User-Credentials aus:
 * 1. Supabase Seed-Dateien (seed.sql, seed_real.sql)
 * 2. Test Scenarios (unified-tester/features/scenarios)
 *
 * Output: data/credentials.json
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { glob } from 'glob';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CUI_ROOT = resolve(__dirname, '..');
const PLATFORM_ROOT = resolve(CUI_ROOT, '../../platform');
const SCENARIOS_ROOT = resolve(CUI_ROOT, '../../tests/unified-tester/features/scenarios');
const OUTPUT_FILE = join(CUI_ROOT, 'data/credentials.json');

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

// Known app display names
const APP_NAMES: Record<string, string> = {
  'platform': 'Werkingflow Platform',
  'engelmann': 'Engelmann AI Hub',
  'werking-report': 'Werking Report Studio',
  'werking-energy': 'Werking Energy',
  'werkingsafety': 'TECC Safety Engineering',
  'bacher': 'Bacher-ZT Hub',
  'gutachten': 'Gutachten App',
  'teufel': 'Teufel Safety AI',
  'eco-diagnostics': 'ECO Diagnostics',
};

/**
 * Parse Supabase seed.sql for credentials
 */
function parseSeedSQL(): Map<string, User> {
  const users = new Map<string, User>();

  const seedPath = join(PLATFORM_ROOT, 'supabase/seed.sql');
  if (!existsSync(seedPath)) {
    console.warn('⚠️  seed.sql not found');
    return users;
  }

  const content = readFileSync(seedPath, 'utf8');

  // Extract auth.users (email + password from crypt())
  const userRegex = /'([^']+@[^']+)',\s*crypt\('([^']+)'/g;
  let match;
  while ((match = userRegex.exec(content)) !== null) {
    const [, email, password] = match;
    users.set(email, {
      name: email.split('@')[0],
      email,
      password,
      environments: {},
      scenarios: [],
      source: 'seed',
    });
  }

  // Extract tenant memberships (role + tenant)
  const tenantRegex = /INSERT INTO tenant_memberships[\s\S]*?VALUES\s*\('([^']+)',\s*'([^']+)',\s*'([^']+)'/g;
  while ((match = tenantRegex.exec(content)) !== null) {
    const [, tenantId, userId, role] = match;

    // Find user by ID (match with auth.users INSERT)
    const userIdRegex = new RegExp(`'${userId}'[\\s\\S]*?'([^']+@[^']+)'`, 'g');
    const userMatch = userIdRegex.exec(content);
    if (userMatch) {
      const email = userMatch[1];
      const user = users.get(email);
      if (user) {
        user.role = role;
        user.tenant = tenantId;
      }
    }
  }

  console.log(`✓ Parsed seed.sql: ${users.size} users`);
  return users;
}

/**
 * Parse seed_real.sql (production seed, auth.users via API)
 */
function parseSeedRealSQL(existing: Map<string, User>): Map<string, User> {
  const seedRealPath = join(PLATFORM_ROOT, 'supabase/seed_real.sql');
  if (!existsSync(seedRealPath)) {
    console.warn('⚠️  seed_real.sql not found');
    return existing;
  }

  const content = readFileSync(seedRealPath, 'utf8');

  // seed_real.sql has comment: "Auth user (test@werkingflow.com) created via API"
  // Extract from public.users INSERT
  const userRegex = /INSERT INTO users[\s\S]*?VALUES\s*\([^)]*?'([^']+@[^']+)',\s*'([^']+)'/g;
  let match;
  while ((match = userRegex.exec(content)) !== null) {
    const [, email, name] = match;

    if (!existing.has(email)) {
      // Hardcoded password from seed.sql (production uses API, but dev uses same)
      const password = email === 'test@werkingflow.com' ? 'TestUser2024!' : undefined;

      existing.set(email, {
        name,
        email,
        password,
        environments: {},
        scenarios: [],
        source: 'seed',
      });
    }
  }

  console.log(`✓ Parsed seed_real.sql: ${existing.size} total users`);
  return existing;
}

/**
 * Parse test scenarios for credentials
 */
async function parseScenarios(existingUsers: Map<string, User>): Promise<Map<string, AppCredentials>> {
  const appData = new Map<string, AppCredentials>();

  const scenarioFiles = await glob('**/*.json', {
    cwd: SCENARIOS_ROOT,
    ignore: ['**/_archived/**'],
    absolute: true,
  });

  console.log(`\n📂 Scanning ${scenarioFiles.length} scenario files...`);

  for (const file of scenarioFiles) {
    try {
      const content = readFileSync(file, 'utf8');
      const scenario = JSON.parse(content);

      // Extract app/system
      const app = scenario.app || scenario.system || 'unknown';

      // Extract email from persona or credentials
      let email = scenario.persona?.email;
      let password: string | undefined;

      // If no persona email, try credentials
      if (!email) {
        const testUser = scenario.credentials?.test_user;
        const demoUser = scenario.credentials?.demo_user;
        if (testUser?.email) {
          email = testUser.email;
          password = testUser.password;
        } else if (demoUser?.email) {
          email = demoUser.email;
          password = demoUser.password;
        }
      } else {
        // Has persona email, check for password in credentials
        const credentials = scenario.credentials?.test_user || scenario.credentials?.demo_user;
        password = credentials?.password;
      }

      if (!email) continue;

      // Extract endpoints
      const localUrl = scenario.endpoints?.local_url;
      const stagedUrl = scenario.endpoints?.base_url;
      const prodUrl = stagedUrl?.includes('vercel.app') || stagedUrl?.includes('railway.app')
        ? stagedUrl
        : undefined;

      // Get or create app
      if (!appData.has(app)) {
        appData.set(app, {
          app,
          displayName: APP_NAMES[app] || app,
          users: [],
        });
      }

      const appCreds = appData.get(app)!;

      // Find or create user
      let user = appCreds.users.find(u => u.email === email);
      if (!user) {
        // Check if exists in seed data
        const seedUser = existingUsers.get(email);

        user = {
          name: scenario.persona?.name || seedUser?.name || email.split('@')[0],
          email,
          password: password || seedUser?.password,
          role: seedUser?.role || scenario.persona?.rolle,
          tenant: seedUser?.tenant,
          environments: {
            local: localUrl,
            staged: prodUrl ? undefined : stagedUrl,
            production: prodUrl,
          },
          scenarios: [],
          source: seedUser ? 'both' : 'scenario',
        };
        appCreds.users.push(user);
      } else {
        // Update existing user
        if (password && !user.password) user.password = password;
        if (localUrl) user.environments.local = localUrl;
        if (stagedUrl && !prodUrl) user.environments.staged = stagedUrl;
        if (prodUrl) user.environments.production = prodUrl;
      }

      // Add scenario reference
      const scenarioId = scenario.id || scenario.feature_id || file.split('/').pop()?.replace('.json', '');
      if (scenarioId && !user.scenarios.includes(scenarioId)) {
        user.scenarios.push(scenarioId);
      }

    } catch (err) {
      console.warn(`⚠️  Failed to parse ${file}:`, (err as Error).message);
    }
  }

  console.log(`✓ Parsed scenarios: ${appData.size} apps`);
  return appData;
}

/**
 * Main aggregation
 */
async function main() {
  console.log('🔐 Aggregating credentials...\n');

  // 1. Parse seed files
  let seedUsers = parseSeedSQL();
  seedUsers = parseSeedRealSQL(seedUsers);

  // 2. Parse scenarios
  const appData = await parseScenarios(seedUsers);

  // 3. Add platform users from seed (if not in scenarios)
  if (!appData.has('platform')) {
    appData.set('platform', {
      app: 'platform',
      displayName: APP_NAMES.platform,
      users: [],
    });
  }

  const platformApp = appData.get('platform')!;
  for (const [email, user] of seedUsers.entries()) {
    if (!platformApp.users.find(u => u.email === email)) {
      platformApp.users.push({
        ...user,
        environments: {
          local: 'http://localhost:3004',
          staged: 'http://100.121.161.109:4001',
          production: 'https://werkingflow-platform.vercel.app',
        },
      });
    }
  }

  // 4. Sort apps and users
  const sortedApps = Array.from(appData.values()).sort((a, b) => a.app.localeCompare(b.app));
  for (const app of sortedApps) {
    app.users.sort((a, b) => a.email.localeCompare(b.email));
  }

  // 5. Write output
  const output: AggregatedData = {
    generatedAt: new Date().toISOString(),
    apps: sortedApps,
  };

  writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`\n✅ Credentials aggregated: ${OUTPUT_FILE}`);
  console.log(`   Apps: ${sortedApps.length}`);
  console.log(`   Total users: ${sortedApps.reduce((sum, app) => sum + app.users.length, 0)}`);
}

main().catch(err => {
  console.error('❌ Aggregation failed:', err);
  process.exit(1);
});
