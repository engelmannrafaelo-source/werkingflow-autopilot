#!/usr/bin/env node
/**
 * Quick Unit Tests for Infisical API Endpoints
 * Fast Bridge-Quality Testing Pattern
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

async function test(name, fn) {
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
  // Small delay to avoid overwhelming the server
  await new Promise(resolve => setTimeout(resolve, 100));
}

// Run Tests
(async () => {
  console.log(`${colors.bold}${colors.cyan}INFISICAL API QUICK TESTS${colors.reset}\n`);

  // Test 1: Status Endpoint
  await test('GET /api/infisical/status - returns 200', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/status`);
    assert.strictEqual(res.status, 200);
  });

  await test('GET /api/infisical/status - has correct structure', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/status`);
    const data = await res.json();
    assert.ok('server' in data && 'docker' in data && 'projects' in data);
  });

  await test('GET /api/infisical/status - has 7 projects', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/status`);
    const data = await res.json();
    assert.strictEqual(data.projects.length, 7);
  });

  // Test 2: Health Endpoint
  await test('GET /api/infisical/health - returns 200', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/health`);
    assert.strictEqual(res.status, 200);
  });

  await test('GET /api/infisical/health - has status field', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/health`);
    const data = await res.json();
    assert.ok('status' in data);
  });

  // Test 3: Projects Endpoint
  await test('GET /api/infisical/projects - returns 200', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/projects`);
    assert.strictEqual(res.status, 200);
  });

  await test('GET /api/infisical/projects - has 7 projects', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/projects`);
    const data = await res.json();
    assert.strictEqual(data.projects.length, 7);
  });

  await test('GET /api/infisical/projects - all projects have required fields', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/projects`);
    const data = await res.json();
    const required = ['id', 'name', 'sync_target', 'status'];
    data.projects.forEach(project => {
      required.forEach(field => {
        assert.ok(field in project, `Missing field: ${field}`);
      });
    });
  });

  // Test 4: Syncs Endpoint
  await test('GET /api/infisical/syncs - returns 200', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/syncs`);
    assert.strictEqual(res.status, 200);
  });

  await test('GET /api/infisical/syncs - has 7 syncs', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/syncs`);
    const data = await res.json();
    assert.strictEqual(data.syncs.length, 7);
  });

  await test('GET /api/infisical/syncs - all syncs succeeded', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/syncs`);
    const data = await res.json();
    data.syncs.forEach(sync => {
      assert.strictEqual(sync.status, 'succeeded');
    });
  });

  // Test 5: Server Info Endpoint
  await test('GET /api/infisical/server-info - returns 200', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/server-info`);
    assert.strictEqual(res.status, 200);
  });

  await test('GET /api/infisical/server-info - has correct structure', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/server-info`);
    const data = await res.json();
    assert.ok('webUI' in data && 'tailscaleIP' in data && 'publicIP' in data);
  });

  await test('GET /api/infisical/server-info - has correct values', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/server-info`);
    const data = await res.json();
    assert.strictEqual(data.tailscaleIP, '100.79.71.99');
    assert.strictEqual(data.publicIP, '46.225.139.121');
  });

  // Summary
  console.log(`\n${colors.bold}${colors.cyan}═══════════════════════════════════════${colors.reset}`);
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
