#!/usr/bin/env node
/**
 * Quick Smoke Test for Infisical Panel
 * Bridge-Quality Pattern - Fast & Focused
 */

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

async function test(name, fn) {
  try {
    await fn();
    console.log(`${colors.green}✓${colors.reset} ${name}`);
    passed++;
    return true;
  } catch (err) {
    console.log(`${colors.red}✗${colors.reset} ${name}`);
    console.log(`  ${colors.red}${err.message}${colors.reset}`);
    failed++;
    return false;
  }
}

console.log(`${colors.bold}${colors.cyan}════════════════════════════════════════════${colors.reset}`);
console.log(`${colors.bold}  INFISICAL PANEL - QUICK SMOKE TEST${colors.reset}`);
console.log(`${colors.bold}${colors.cyan}════════════════════════════════════════════${colors.reset}\n`);

(async () => {
  // Layer 1: API Endpoints
  console.log(`${colors.cyan}[1/4] Testing API Endpoints...${colors.reset}`);

  await test('GET /api/infisical/status returns 200', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/status`);
    if (res.status !== 200) throw new Error(`Got ${res.status}`);
  });

  await test('GET /api/infisical/projects returns 200', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/projects`);
    if (res.status !== 200) throw new Error(`Got ${res.status}`);
  });

  await test('GET /api/infisical/syncs returns 200', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/syncs`);
    if (res.status !== 200) throw new Error(`Got ${res.status}`);
  });

  await test('GET /api/infisical/server-info returns 200', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/server-info`);
    if (res.status !== 200) throw new Error(`Got ${res.status}`);
  });

  await test('GET /api/infisical/health returns 200', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/health`);
    if (res.status !== 200) throw new Error(`Got ${res.status}`);
  });

  // Layer 2: Data Integrity
  console.log(`\n${colors.cyan}[2/4] Testing Data Integrity...${colors.reset}`);

  await test('Status endpoint has correct structure', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/status`);
    const data = await res.json();
    if (!('server' in data)) throw new Error('Missing server field');
    if (!('docker' in data)) throw new Error('Missing docker field');
    if (!('projects' in data)) throw new Error('Missing projects field');
  });

  await test('Projects endpoint has 7 projects', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/projects`);
    const data = await res.json();
    if (!data.projects || data.projects.length !== 7) {
      throw new Error(`Expected 7 projects, got ${data.projects?.length}`);
    }
  });

  await test('All 7 syncs succeeded', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/syncs`);
    const data = await res.json();
    if (data.succeeded !== 7) throw new Error(`Only ${data.succeeded}/7 succeeded`);
    if (data.failed !== 0) throw new Error(`${data.failed} syncs failed`);
  });

  await test('Server info has correct values', async () => {
    const res = await fetch(`${BASE_URL}/api/infisical/server-info`);
    const data = await res.json();
    if (data.tailscaleIP !== '100.79.71.99') throw new Error('Wrong tailscale IP');
    if (data.webUI !== 'http://100.79.71.99:80') throw new Error('Wrong webUI URL');
  });

  // Layer 3: Performance
  console.log(`\n${colors.cyan}[3/4] Testing Performance...${colors.reset}`);

  await test('All endpoints respond < 50ms', async () => {
    const endpoints = ['/api/infisical/status', '/api/infisical/projects', '/api/infisical/syncs'];
    for (const endpoint of endpoints) {
      const start = Date.now();
      await fetch(`${BASE_URL}${endpoint}`);
      const duration = Date.now() - start;
      if (duration > 50) throw new Error(`${endpoint} took ${duration}ms`);
    }
  });

  // Layer 4: Component Rendering
  console.log(`\n${colors.cyan}[4/4] Testing Component Readiness...${colors.reset}`);

  await test('Component Panel can load data', async () => {
    const res = await fetch(`${BASE_URL}/api/panels/administration`);
    if (res.status !== 200) throw new Error(`Panel API returned ${res.status}`);
  });

  // Final Summary
  console.log(`\n${colors.bold}${colors.cyan}════════════════════════════════════════════${colors.reset}`);
  console.log(`${colors.bold}  TEST RESULTS${colors.reset}`);
  console.log(`${colors.bold}${colors.cyan}════════════════════════════════════════════${colors.reset}\n`);

  console.log(`  Total:  ${passed + failed}`);
  console.log(`  ${colors.green}Passed: ${passed}${colors.reset}`);
  if (failed > 0) {
    console.log(`  ${colors.red}Failed: ${failed}${colors.reset}`);
  }

  if (failed === 0) {
    console.log(`\n${colors.green}${colors.bold}✅ ALL SMOKE TESTS PASSED!${colors.reset}`);
    console.log(`${colors.green}   Infisical Panel is functional.${colors.reset}\n`);
    process.exit(0);
  } else {
    console.log(`\n${colors.red}${colors.bold}❌ SOME TESTS FAILED${colors.reset}\n`);
    process.exit(1);
  }
})();
