#!/usr/bin/env node
/**
 * Infisical API Tests (Simplified)
 * Tests backend API endpoints directly
 */

const API = 'http://localhost:4005/api/infisical';
const colors = { reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m', cyan: '\x1b[36m' };
function log(color, msg) { console.log(`${colors[color]}${msg}${colors.reset}`); }

const tests = [];
let passed = 0;
let failed = 0;

function test(name, fn) { tests.push({ name, fn }); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function makeRequest(url) {
  const start = Date.now();
  const res = await fetch(url);
  const duration = Date.now() - start;
  const data = await res.json();
  return { status: res.status, data, duration };
}

// === TESTS ===

test('GET /status - returns server information', async () => {
  const { status, data } = await makeRequest(`${API}/status`);
  assert(status === 200, 'Should return 200');
  assert(data.server, 'Should have server info');
  assert(data.projects, 'Should have projects');
  assert(data.projects.length === 7, 'Should have 7 projects');
});

test('GET /health - returns health status', async () => {
  const { status, data } = await makeRequest(`${API}/health`);
  assert(status === 200, 'Should return 200');
  assert(data.status, 'Should have status');
});

test('GET /projects - returns all projects', async () => {
  const { status, data} = await makeRequest(`${API}/projects`);
  assert(status === 200, 'Should return 200');
  assert(data.projects, 'Should have projects array');
  assert(data.projects.length === 7, 'Should have 7 projects');
});

test('GET /syncs - returns sync status', async () => {
  const { status, data } = await makeRequest(`${API}/syncs`);
  assert(status === 200, 'Should return 200');
  assert(data.syncs, 'Should have syncs array');
  assert(data.total !== undefined, 'Should have total count');
});

test('GET /server-info - returns server information', async () => {
  const { status, data } = await makeRequest(`${API}/server-info`);
  assert(status === 200, 'Should return 200');
  assert(data.base_url || data.server, 'Should have server URL');
});

// Performance tests
test('Performance - /status responds within 500ms', async () => {
  const { duration } = await makeRequest(`${API}/status`);
  assert(duration < 500, `Should respond in <500ms (was ${duration}ms)`);
});

test('Performance - /projects responds within 500ms', async () => {
  const { duration } = await makeRequest(`${API}/projects`);
  assert(duration < 500, `Should respond in <500ms (was ${duration}ms)`);
});

// Data consistency tests
test('Data consistency - all projects have required fields', async () => {
  const { data } = await makeRequest(`${API}/projects`);
  const allValid = data.projects.every(p =>
    p.id && p.name && (p.sync_target || p.syncTarget) && p.status && p.environment
  );
  assert(allValid, 'All projects should have required fields');
});

test('Data consistency - sync statuses are valid', async () => {
  const { data } = await makeRequest(`${API}/syncs`);
  const validStatuses = ['succeeded', 'failed', 'pending'];
  const allValid = data.syncs.every(s => validStatuses.includes(s.status));
  assert(allValid, 'All sync statuses should be valid');
});

// === RUN TESTS ===

(async () => {
  log('cyan', '\n=== Infisical API Tests (Simplified) ===\n');

  for (const { name, fn } of tests) {
    try {
      await fn();
      log('green', `✓ ${name}`);
      passed++;
    } catch (err) {
      log('red', `✗ ${name}`);
      log('red', `  Error: ${err.message}`);
      failed++;
    }
  }

  log('cyan', '\n=== Test Summary ===');
  log('green', `Passed: ${passed}`);
  if (failed > 0) log('red', `Failed: ${failed}`);
  log('cyan', `Total: ${tests.length}\n`);

  process.exit(failed > 0 ? 1 : 0);
})();
