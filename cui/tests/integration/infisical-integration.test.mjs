#!/usr/bin/env node
/**
 * Integration Tests for Infisical Monitor (Layer 3: Data Flow)
 * Tests: API → State → UI data consistency
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
  // Delay to avoid overwhelming server
  await new Promise(resolve => setTimeout(resolve, 100));
}

(async () => {
  console.log(`${colors.bold}${colors.cyan}INFISICAL INTEGRATION TESTS (Data Flow)${colors.reset}\n`);

  // Test 1: Status endpoint → Projects array consistency
  await test('Status endpoint - projects array matches count', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/status`);
    const data = await res.json();

    assert.ok(Array.isArray(data.projects), 'Status should have projects array');
    assert.strictEqual(data.projects.length, 7, 'Status should show 7 projects');

    // Check each project has required fields
    data.projects.forEach((project, i) => {
      assert.ok(project.id, `Project ${i} missing id`);
      assert.ok(project.name, `Project ${i} missing name`);
      assert.ok(project.sync_target, `Project ${i} missing sync_target`);
      assert.ok(project.status, `Project ${i} missing status`);
    });
  });

  // Test 2: Projects endpoint → Status endpoint consistency
  await test('Projects endpoint - matches status data', async () => {
    const [statusRes, projectsRes] = await Promise.all([
      fetch(`${BASE_URL}/api/infisical/status`),
      fetch(`${BASE_URL}/api/infisical/projects`)
    ]);

    const statusData = await statusRes.json();
    const projectsData = await projectsRes.json();

    // Both should have 7 projects
    assert.strictEqual(statusData.projects.length, 7);
    assert.strictEqual(projectsData.projects.length, 7);

    // Project IDs should match
    const statusIds = statusData.projects.map(p => p.id).sort();
    const projectIds = projectsData.projects.map(p => p.id).sort();
    assert.deepStrictEqual(statusIds, projectIds, 'Project IDs should match between endpoints');
  });

  // Test 3: Syncs endpoint → Projects endpoint consistency
  await test('Syncs endpoint - matches projects count', async () => {
    const [syncsRes, projectsRes] = await Promise.all([
      fetch(`${BASE_URL}/api/infisical/syncs`),
      fetch(`${BASE_URL}/api/infisical/projects`)
    ]);

    const syncsData = await syncsRes.json();
    const projectsData = await projectsRes.json();

    // Each project should have a corresponding sync
    assert.strictEqual(syncsData.syncs.length, projectsData.projects.length);
    assert.strictEqual(syncsData.total, projectsData.projects.length);

    // Every project should have a sync entry
    const syncProjects = syncsData.syncs.map(s => s.project).sort();
    const projectNames = projectsData.projects.map(p => p.id).sort();
    assert.deepStrictEqual(syncProjects, projectNames, 'Sync projects should match project names');
  });

  // Test 4: All syncs succeeded (business logic)
  await test('All syncs - succeeded status', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/syncs`);
    const data = await res.json();

    assert.strictEqual(data.succeeded, 7, 'Should have 7 succeeded syncs');
    assert.strictEqual(data.failed, 0, 'Should have 0 failed syncs');

    data.syncs.forEach(sync => {
      assert.strictEqual(sync.status, 'succeeded', `Sync ${sync.project} should have succeeded status`);
      assert.ok(sync.lastSync, `Sync ${sync.project} should have lastSync timestamp`);
    });
  });

  // Test 5: Server info → Status consistency
  await test('Server info - matches status server data', async () => {
    const [statusRes, serverRes] = await Promise.all([
      fetch(`${BASE_URL}/api/infisical/status`),
      fetch(`${BASE_URL}/api/infisical/server-info`)
    ]);

    const statusData = await statusRes.json();
    const serverData = await serverRes.json();

    // Server info should match
    assert.strictEqual(statusData.server.tailscale_ip, serverData.tailscaleIP);
    assert.strictEqual(statusData.server.public_ip, serverData.publicIP);
    assert.strictEqual(statusData.server.web_ui, serverData.webUI);
  });

  // Test 6: Health endpoint - returns valid status
  await test('Health endpoint - valid status structure', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/health`);
    const data = await res.json();

    assert.ok('status' in data, 'Health should have status field');
    assert.ok(['healthy', 'unhealthy'].includes(data.status), `Invalid health status: ${data.status}`);
    assert.ok('timestamp' in data, 'Health should have timestamp');
  });

  // Test 7: Expected projects are present
  await test('Projects - all expected projects present', async () => {
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
      assert.ok(projectIds.includes(expectedId), `Missing expected project: ${expectedId}`);
    });
  });

  // Test 8: Vercel vs Railway integrations
  await test('Syncs - correct integration types', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/syncs`);
    const data = await res.json();

    const vercelCount = data.syncs.filter(s => s.integration === 'vercel').length;
    const railwayCount = data.syncs.filter(s => s.integration === 'railway').length;

    assert.strictEqual(vercelCount, 5, 'Should have 5 Vercel integrations');
    assert.strictEqual(railwayCount, 2, 'Should have 2 Railway integrations');

    // Specific projects should use Railway
    const railwayProjects = data.syncs.filter(s => s.integration === 'railway').map(s => s.project);
    assert.ok(railwayProjects.includes('werking-safety-be'), 'werking-safety-be should use Railway');
    assert.ok(railwayProjects.includes('werking-energy-be'), 'werking-energy-be should use Railway');
  });

  // Test 9: Response timestamps are recent
  await test('API responses - timestamps are recent', async () => {
    const endpoints = [
      '/api/infisical/status',
      '/api/infisical/health',
      '/api/infisical/server-info'
    ];

    const now = new Date().getTime();
    const fiveMinutesAgo = now - (5 * 60 * 1000);

    for (const endpoint of endpoints) {
      const res = await fetch(`${BASE_URL}${endpoint}`);
      const data = await res.json();

      const timestamp = new Date(data.timestamp || data.last_check).getTime();
      assert.ok(timestamp > fiveMinutesAgo, `${endpoint} timestamp too old`);
      assert.ok(timestamp <= now, `${endpoint} timestamp in future`);
    }
  });

  // Test 10: Docker status check
  await test('Status - Docker services running', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/status`);
    const data = await res.json();

    assert.ok('docker' in data, 'Status should have docker field');
    assert.strictEqual(data.docker.status, 'running', 'Docker should be running');
    assert.ok(Array.isArray(data.docker.services), 'Docker should have services array');

    const expectedServices = ['infisical', 'postgres', 'redis'];
    expectedServices.forEach(service => {
      assert.ok(data.docker.services.includes(service), `Missing Docker service: ${service}`);
    });
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
