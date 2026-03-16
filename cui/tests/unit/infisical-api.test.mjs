#!/usr/bin/env node
/**
 * Unit Tests for Infisical API Endpoints
 * Bridge-Quality Testing Pattern
 */

import assert from 'assert';

const BASE_URL = 'http://localhost:4005';
const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  reset: '\x1b[0m',
  bold: '\x1b[1m'
};

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  return async () => {
    try {
      await fn();
      console.log(`${colors.green}✓${colors.reset} ${name}`);
      passed++;
    } catch (err) {
      console.log(`${colors.red}✗${colors.reset} ${name}`);
      console.log(`  ${colors.red}${err.message}${colors.reset}`);
      failed++;
      failures.push({ name, error: err.message });
    }
  };
}

// Test Suite
const tests = [
  test('GET /api/infisical/status returns 200', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/status`);
    assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
  }),

  test('GET /api/infisical/status returns valid JSON', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/status`);
    const data = await res.json();
    assert.ok(data, 'Response should not be null');
  }),

  test('GET /api/infisical/status has correct structure', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/status`);
    const data = await res.json();
    assert.ok('server' in data, 'Response should have server field');
    assert.ok('docker' in data, 'Response should have docker field');
    assert.ok('auth' in data, 'Response should have auth field');
    assert.ok('projects' in data, 'Response should have projects field');
  }),

  test('GET /api/infisical/health returns 200', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/health`);
    assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
  }),

  test('GET /api/infisical/health returns valid JSON', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/health`);
    const data = await res.json();
    assert.ok(data, 'Response should not be null');
  }),

  test('GET /api/infisical/health has status field', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/health`);
    const data = await res.json();
    assert.ok('status' in data, 'Response should have status field');
    assert.strictEqual(typeof data.status, 'string', 'status should be string');
  }),

  test('GET /api/infisical/projects returns 200', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/projects`);
    assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
  }),

  test('GET /api/infisical/projects returns projects array', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/projects`);
    const data = await res.json();
    assert.ok('projects' in data, 'Response should have projects field');
    assert.ok(Array.isArray(data.projects), 'Projects should be an array');
  }),

  test('GET /api/infisical/projects has 7 projects', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/projects`);
    const data = await res.json();
    assert.strictEqual(data.projects.length, 7, `Expected 7 projects, got ${data.projects.length}`);
  }),

  test('GET /api/infisical/projects - each project has required fields', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/projects`);
    const data = await res.json();

    const required = ['id', 'name', 'sync_target', 'status'];
    data.projects.forEach((project, i) => {
      required.forEach(field => {
        assert.ok(field in project, `Project ${i} (${project.name}) missing field: ${field}`);
      });
    });
  }),

  test('GET /api/infisical/syncs returns 200', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/syncs`);
    assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
  }),

  test('GET /api/infisical/syncs returns syncs array', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/syncs`);
    const data = await res.json();
    assert.ok('syncs' in data, 'Response should have syncs field');
    assert.ok(Array.isArray(data.syncs), 'Syncs should be an array');
  }),

  test('GET /api/infisical/syncs has 7 syncs', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/syncs`);
    const data = await res.json();
    assert.strictEqual(data.syncs.length, 7, `Expected 7 syncs, got ${data.syncs.length}`);
  }),

  test('GET /api/infisical/syncs - all syncs succeeded', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/syncs`);
    const data = await res.json();

    data.syncs.forEach((sync, i) => {
      assert.strictEqual(sync.status, 'succeeded', `Sync ${i} (${sync.project}) failed with status: ${sync.status}`);
    });
  }),

  test('GET /api/infisical/server-info returns 200', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/server-info`);
    assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
  }),

  test('GET /api/infisical/server-info returns valid JSON', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/server-info`);
    const data = await res.json();
    assert.ok(data, 'Response should not be null');
  }),

  test('GET /api/infisical/server-info has correct structure', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/server-info`);
    const data = await res.json();
    assert.ok('webUI' in data, 'Response should have webUI field');
    assert.ok('tailscaleIP' in data, 'Response should have tailscaleIP field');
    assert.ok('publicIP' in data, 'Response should have publicIP field');
    assert.ok('server' in data, 'Response should have server field');
  }),

  test('GET /api/infisical/server-info has correct values', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/server-info`);
    const data = await res.json();
    assert.strictEqual(data.webUI, 'http://100.79.71.99:80', `Expected correct webUI, got ${data.webUI}`);
    assert.strictEqual(data.tailscaleIP, '100.79.71.99', `Expected correct tailscaleIP, got ${data.tailscaleIP}`);
    assert.strictEqual(data.publicIP, '46.225.139.121', `Expected correct publicIP, got ${data.publicIP}`);
  }),

  test('API response times < 50ms', async () => {
    const endpoints = [
      '/api/infisical/status',
      '/api/infisical/health',
      '/api/infisical/projects',
      '/api/infisical/syncs',
      '/api/infisical/server-info'
    ];

    for (const endpoint of endpoints) {
      const start = Date.now();
      await fetch(`${BASE_URL}${endpoint}`);
      const duration = Date.now() - start;
      assert.ok(duration < 50, `${endpoint} took ${duration}ms (> 50ms threshold)`);
    }
  }),

  test('All endpoints return correct Content-Type', async () => {
    const endpoints = [
      '/api/infisical/status',
      '/api/infisical/health',
      '/api/infisical/projects',
      '/api/infisical/syncs',
      '/api/infisical/server-info'
    ];

    for (const endpoint of endpoints) {
      const res = await fetch(`${BASE_URL}${endpoint}`);
      const contentType = res.headers.get('content-type');
      assert.ok(contentType.includes('application/json'),
        `${endpoint} has wrong Content-Type: ${contentType}`);
    }
  })
];

// Run Tests
(async () => {
  console.log(`${colors.bold}${colors.cyan}`);
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  INFISICAL API UNIT TESTS (Bridge Quality)');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(colors.reset);

  for (const testFn of tests) {
    await testFn();
  }

  console.log(`\n${colors.bold}${colors.cyan}═══════════════════════════════════════════════════════════${colors.reset}`);
  console.log(`${colors.bold}  TEST RESULTS${colors.reset}`);
  console.log(`${colors.bold}${colors.cyan}═══════════════════════════════════════════════════════════${colors.reset}\n`);

  console.log(`  Total:  ${passed + failed}`);
  console.log(`  ${colors.green}Passed: ${passed}${colors.reset}`);
  if (failed > 0) {
    console.log(`  ${colors.red}Failed: ${failed}${colors.reset}`);
  }

  if (failed > 0) {
    console.log(`\n${colors.red}${colors.bold}FAILURES:${colors.reset}`);
    failures.forEach(({ name, error }) => {
      console.log(`\n  ${colors.red}✗ ${name}${colors.reset}`);
      console.log(`    ${error}`);
    });
    process.exit(1);
  } else {
    console.log(`\n${colors.green}${colors.bold}✅ ALL TESTS PASSED!${colors.reset}\n`);
    process.exit(0);
  }
})();
