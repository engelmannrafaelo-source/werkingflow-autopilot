#!/usr/bin/env node
/**
 * INFISICAL MONITOR - MASTER TEST SUITE
 * Bridge-Quality Testing Pattern
 *
 * Layers:
 *  1. API Endpoints (HTTP Response Codes, Basic Structure)
 *  2. Schema Validation (Response Format, Required Fields)
 *  3. Data Consistency (Cross-Endpoint, Business Logic)
 *  4. Integration (Frontend Panel, Server Info)
 *
 * Execution: node tests/infisical-master-suite.mjs
 */

import assert from 'assert';

const BASE_URL = 'http://localhost:4005';
const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m'
};

let totalPassed = 0;
let totalFailed = 0;
const allFailures = [];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function testLayer(name, tests) {
  console.log(`\n${colors.bold}${colors.cyan}═══ ${name} ═══${colors.reset}`);

  let layerPassed = 0;
  let layerFailed = 0;
  const failures = [];

  for (const [testName, testFn] of tests) {
    try {
      await testFn();
      console.log(`${colors.green}✓${colors.reset} ${testName}`);
      layerPassed++;
      totalPassed++;
    } catch (err) {
      console.log(`${colors.red}✗${colors.reset} ${testName}`);
      console.log(`  ${colors.dim}${err.message}${colors.reset}`);
      layerFailed++;
      totalFailed++;
      failures.push({ test: testName, error: err.message });
      allFailures.push({ layer: name, test: testName, error: err.message });
    }
    await sleep(200); // Avoid overwhelming server (increased for CUI node server)
  }

  const total = layerPassed + layerFailed;
  const passRate = total > 0 ? ((layerPassed / total) * 100).toFixed(1) : 0;

  console.log(`${colors.dim}─────────────────────────────────────────${colors.reset}`);
  if (layerFailed === 0) {
    console.log(`${colors.green}✓ ${layerPassed}/${total} passed (${passRate}%)${colors.reset}`);
  } else {
    console.log(`${colors.red}✗ ${layerPassed}/${total} passed (${passRate}%)${colors.reset}`);
  }

  return { passed: layerPassed, failed: layerFailed, failures };
}

// ═══════════════════════════════════════════════════════════════
// LAYER 1: API ENDPOINTS (HTTP Response Codes, Basic Structure)
// ═══════════════════════════════════════════════════════════════

const LAYER_1_TESTS = [
  ['GET /api/infisical/status - returns 200', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/status`);
    assert.strictEqual(res.status, 200);
  }],

  ['GET /api/infisical/status - returns JSON', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/status`);
    const contentType = res.headers.get('content-type');
    assert.ok(contentType && contentType.includes('application/json'));
  }],

  ['GET /api/infisical/health - returns 200', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/health`);
    assert.strictEqual(res.status, 200);
  }],

  ['GET /api/infisical/projects - returns 200', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/projects`);
    assert.strictEqual(res.status, 200);
  }],

  ['GET /api/infisical/syncs - returns 200', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/syncs`);
    assert.strictEqual(res.status, 200);
  }],

  ['GET /api/infisical/server-info - returns 200', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/server-info`);
    assert.strictEqual(res.status, 200);
  }],
];

// ═══════════════════════════════════════════════════════════════
// LAYER 2: SCHEMA VALIDATION (Response Format, Required Fields)
// ═══════════════════════════════════════════════════════════════

const LAYER_2_TESTS = [
  ['Status endpoint - has required top-level fields', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/status`);
    const data = await res.json();
    const required = ['server', 'docker', 'projects', 'last_check'];
    required.forEach(field => {
      assert.ok(field in data, `Missing field: ${field}`);
    });
  }],

  ['Status endpoint - server object has required fields', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/status`);
    const data = await res.json();
    const required = ['name', 'tailscale_ip', 'public_ip', 'web_ui'];
    required.forEach(field => {
      assert.ok(field in data.server, `Missing server field: ${field}`);
    });
  }],

  ['Status endpoint - docker object has required fields', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/status`);
    const data = await res.json();
    const required = ['status', 'services'];
    required.forEach(field => {
      assert.ok(field in data.docker, `Missing docker field: ${field}`);
    });
  }],

  ['Status endpoint - projects is array of 7', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/status`);
    const data = await res.json();
    assert.ok(Array.isArray(data.projects));
    assert.strictEqual(data.projects.length, 7);
  }],

  ['Status endpoint - each project has required fields', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/status`);
    const data = await res.json();
    const required = ['id', 'name', 'sync_target', 'status'];
    data.projects.forEach((project, i) => {
      required.forEach(field => {
        assert.ok(field in project, `Project ${i} missing field: ${field}`);
      });
    });
  }],

  ['Projects endpoint - has required structure', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/projects`);
    const data = await res.json();
    assert.ok('projects' in data);
    assert.ok('total' in data);
    assert.ok(Array.isArray(data.projects));
  }],

  ['Projects endpoint - each project has required fields', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/projects`);
    const data = await res.json();
    const required = ['id', 'name', 'sync_target', 'environment'];
    data.projects.forEach((project, i) => {
      required.forEach(field => {
        assert.ok(field in project, `Project ${i} missing field: ${field}`);
      });
    });
  }],

  ['Syncs endpoint - has required structure', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/syncs`);
    const data = await res.json();
    const required = ['syncs', 'total', 'succeeded', 'failed'];
    required.forEach(field => {
      assert.ok(field in data, `Missing field: ${field}`);
    });
  }],

  ['Syncs endpoint - each sync has required fields', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/syncs`);
    const data = await res.json();
    const required = ['project', 'integration', 'status', 'lastSync'];
    data.syncs.forEach((sync, i) => {
      required.forEach(field => {
        assert.ok(field in sync, `Sync ${i} missing field: ${field}`);
      });
    });
  }],

  ['Health endpoint - has required structure', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/health`);
    const data = await res.json();
    const required = ['status', 'timestamp'];
    required.forEach(field => {
      assert.ok(field in data, `Missing field: ${field}`);
    });
  }],

  ['Health endpoint - status is valid enum', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/health`);
    const data = await res.json();
    assert.ok(['healthy', 'unhealthy'].includes(data.status));
  }],

  ['Server-info endpoint - has required structure', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/server-info`);
    const data = await res.json();
    const required = ['server', 'tailscaleIP', 'publicIP', 'webUI', 'timestamp'];
    required.forEach(field => {
      assert.ok(field in data, `Missing field: ${field}`);
    });
  }],
];

// ═══════════════════════════════════════════════════════════════
// LAYER 3: DATA CONSISTENCY (Cross-Endpoint, Business Logic)
// ═══════════════════════════════════════════════════════════════

const LAYER_3_TESTS = [
  ['Status projects count matches projects endpoint', async () => {
    const [statusRes, projectsRes] = await Promise.all([
      fetch(`${BASE_URL}/api/infisical/status`),
      fetch(`${BASE_URL}/api/infisical/projects`)
    ]);
    const statusData = await statusRes.json();
    const projectsData = await projectsRes.json();
    assert.strictEqual(statusData.projects.length, projectsData.projects.length);
  }],

  ['Status projects match projects endpoint IDs', async () => {
    const [statusRes, projectsRes] = await Promise.all([
      fetch(`${BASE_URL}/api/infisical/status`),
      fetch(`${BASE_URL}/api/infisical/projects`)
    ]);
    const statusData = await statusRes.json();
    const projectsData = await projectsRes.json();

    const statusIds = statusData.projects.map(p => p.id).sort();
    const projectIds = projectsData.projects.map(p => p.id).sort();
    assert.deepStrictEqual(statusIds, projectIds);
  }],

  ['Syncs count matches projects count (7)', async () => {
    const [syncsRes, projectsRes] = await Promise.all([
      fetch(`${BASE_URL}/api/infisical/syncs`),
      fetch(`${BASE_URL}/api/infisical/projects`)
    ]);
    const syncsData = await syncsRes.json();
    const projectsData = await projectsRes.json();
    assert.strictEqual(syncsData.syncs.length, projectsData.projects.length);
    assert.strictEqual(syncsData.total, 7);
  }],

  ['All syncs have succeeded status', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/syncs`);
    const data = await res.json();
    assert.strictEqual(data.succeeded, 7);
    assert.strictEqual(data.failed, 0);
    data.syncs.forEach(sync => {
      assert.strictEqual(sync.status, 'succeeded');
    });
  }],

  ['5 Vercel + 2 Railway integrations', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/syncs`);
    const data = await res.json();
    const vercelCount = data.syncs.filter(s => s.integration === 'vercel').length;
    const railwayCount = data.syncs.filter(s => s.integration === 'railway').length;
    assert.strictEqual(vercelCount, 5);
    assert.strictEqual(railwayCount, 2);
  }],

  ['Railway projects are correct', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/syncs`);
    const data = await res.json();
    const railwayProjects = data.syncs
      .filter(s => s.integration === 'railway')
      .map(s => s.project)
      .sort();
    assert.deepStrictEqual(railwayProjects, ['werking-energy-be', 'werking-safety-be']);
  }],

  ['Server info matches across endpoints', async () => {
    const [statusRes, serverRes] = await Promise.all([
      fetch(`${BASE_URL}/api/infisical/status`),
      fetch(`${BASE_URL}/api/infisical/server-info`)
    ]);
    const statusData = await statusRes.json();
    const serverData = await serverRes.json();
    assert.strictEqual(statusData.server.tailscale_ip, serverData.tailscaleIP);
    assert.strictEqual(statusData.server.public_ip, serverData.publicIP);
  }],

  ['All expected projects present', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/projects`);
    const data = await res.json();
    const expected = [
      'werking-report',
      'engelmann',
      'werking-safety-fe',
      'werking-safety-be',
      'werking-energy-fe',
      'werking-energy-be',
      'platform'
    ];
    const projectIds = data.projects.map(p => p.id);
    expected.forEach(expectedId => {
      assert.ok(projectIds.includes(expectedId), `Missing project: ${expectedId}`);
    });
  }],

  ['Docker services running', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/status`);
    const data = await res.json();
    assert.strictEqual(data.docker.status, 'running');
    const expectedServices = ['infisical', 'postgres', 'redis'];
    expectedServices.forEach(service => {
      assert.ok(data.docker.services.includes(service), `Missing service: ${service}`);
    });
  }],

  ['Timestamps are recent (< 5 min old)', async () => {
    const endpoints = [
      '/api/infisical/status',
      '/api/infisical/health',
      '/api/infisical/server-info'
    ];
    const now = Date.now();
    const fiveMinAgo = now - (5 * 60 * 1000);

    for (const endpoint of endpoints) {
      const res = await fetch(`${BASE_URL}${endpoint}`);
      const data = await res.json();
      const timestamp = new Date(data.timestamp || data.last_check).getTime();
      assert.ok(timestamp > fiveMinAgo, `${endpoint} timestamp too old`);
      assert.ok(timestamp <= now, `${endpoint} timestamp in future`);
    }
  }],
];

// ═══════════════════════════════════════════════════════════════
// LAYER 4: INTEGRATION (Frontend Panel, Real-world Usage)
// ═══════════════════════════════════════════════════════════════

const LAYER_4_TESTS = [
  ['Server info - correct IPs', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/server-info`);
    const data = await res.json();
    assert.strictEqual(data.tailscaleIP, '100.79.71.99');
    assert.strictEqual(data.publicIP, '46.225.139.121');
  }],

  ['Server info - correct web UI URL', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/server-info`);
    const data = await res.json();
    assert.strictEqual(data.webUI, 'http://100.79.71.99:80');
  }],

  ['Server info - configured flag is true', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/server-info`);
    const data = await res.json();
    assert.strictEqual(data.configured, true);
  }],

  ['Projects have production environment', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/projects`);
    const data = await res.json();
    data.projects.forEach(project => {
      assert.strictEqual(project.environment, 'production');
    });
  }],

  ['Syncs have auto-sync enabled', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/syncs`);
    const data = await res.json();
    data.syncs.forEach(sync => {
      assert.strictEqual(sync.autoSync, true);
    });
  }],

  ['All sync targets are valid', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/syncs`);
    const data = await res.json();
    const validTargets = ['vercel', 'railway'];
    data.syncs.forEach(sync => {
      assert.ok(validTargets.includes(sync.integration));
    });
  }],
];

// ═══════════════════════════════════════════════════════════════
// MAIN EXECUTION
// ═══════════════════════════════════════════════════════════════

(async () => {
  console.log(`${colors.bold}${colors.cyan}`);
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  INFISICAL MONITOR - MASTER TEST SUITE');
  console.log('  Bridge-Quality Testing Pattern');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(colors.reset);

  const startTime = Date.now();

  // Execute all layers
  await testLayer('LAYER 1: API Endpoints', LAYER_1_TESTS);
  await testLayer('LAYER 2: Schema Validation', LAYER_2_TESTS);
  await testLayer('LAYER 3: Data Consistency', LAYER_3_TESTS);
  await testLayer('LAYER 4: Integration', LAYER_4_TESTS);

  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  const totalTests = totalPassed + totalFailed;
  const passRate = totalTests > 0 ? ((totalPassed / totalTests) * 100).toFixed(1) : 0;

  // Final Summary
  console.log(`\n${colors.bold}${colors.cyan}═══════════════════════════════════════════════════════════════${colors.reset}`);
  console.log(`${colors.bold}FINAL RESULTS${colors.reset}`);
  console.log(`${colors.dim}───────────────────────────────────────────────────────────────${colors.reset}`);
  console.log(`  Total Tests:    ${totalTests}`);
  console.log(`  ${colors.green}Passed:         ${totalPassed}${colors.reset}`);
  if (totalFailed > 0) {
    console.log(`  ${colors.red}Failed:         ${totalFailed}${colors.reset}`);
  }
  console.log(`  Pass Rate:      ${passRate}%`);
  console.log(`  Duration:       ${duration}s`);

  if (totalFailed > 0) {
    console.log(`\n${colors.red}${colors.bold}FAILURES (${totalFailed}):${colors.reset}`);
    allFailures.forEach(({ layer, test, error }) => {
      console.log(`\n  ${colors.red}✗ ${layer} → ${test}${colors.reset}`);
      console.log(`    ${colors.dim}${error}${colors.reset}`);
    });
    console.log(`\n${colors.red}${colors.bold}❌ TESTS FAILED${colors.reset}\n`);
    process.exit(1);
  } else {
    console.log(`\n${colors.green}${colors.bold}✅ ALL TESTS PASSED - 100% FUNCTIONAL${colors.reset}\n`);
    process.exit(0);
  }
})();
