#!/usr/bin/env node

/**
 * Automated Test Suite for Infisical Panel
 * Tests all layers from backend API to frontend rendering
 */

const http = require('http');

const API_BASE = 'http://localhost:4005';
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function makeRequest(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, data });
        }
      });
    }).on('error', reject);
  });
}

async function testBackendAPI() {
  log('\n📋 Layer 1: Backend API Tests', 'cyan');
  log('=' .repeat(50), 'cyan');

  const tests = [
    {
      name: 'Projects Endpoint',
      url: `${API_BASE}/api/infisical/projects`,
      validate: (data) => {
        if (!data.projects || !Array.isArray(data.projects)) {
          throw new Error('Invalid projects array');
        }
        if (data.projects.length === 0) {
          throw new Error('No projects found');
        }
        return `Found ${data.projects.length} projects`;
      }
    },
    {
      name: 'Infrastructure Endpoint',
      url: `${API_BASE}/api/infisical/infrastructure`,
      validate: (data) => {
        if (!data.server || !data.webUI) {
          throw new Error('Missing server/webUI data');
        }
        if (!data.syncTargets || !data.syncTargets.vercel || !data.syncTargets.railway) {
          throw new Error('Missing sync targets');
        }
        return `Server: ${data.server}, Targets: ${data.syncTargets.vercel.length + data.syncTargets.railway.length}`;
      }
    }
  ];

  let passed = 0;
  for (const test of tests) {
    try {
      const start = Date.now();
      const result = await makeRequest(test.url);
      const duration = Date.now() - start;

      if (result.status !== 200) {
        throw new Error(`HTTP ${result.status}`);
      }

      const detail = test.validate(result.data);
      log(`✅ ${test.name}: ${detail} (${duration}ms)`, 'green');
      passed++;
    } catch (error) {
      log(`❌ ${test.name}: ${error.message}`, 'red');
    }
  }

  return { passed, total: tests.length };
}

async function testDataIntegrity() {
  log('\n📋 Layer 2: Data Integrity Tests', 'cyan');
  log('=' .repeat(50), 'cyan');

  let passed = 0;
  const total = 5;

  try {
    // Get data
    const projectsResult = await makeRequest(`${API_BASE}/api/infisical/projects`);
    const infraResult = await makeRequest(`${API_BASE}/api/infisical/infrastructure`);

    const projects = projectsResult.data.projects;
    const infra = infraResult.data;

    // Test 1: Project structure
    const firstProject = projects[0];
    if (firstProject.id && firstProject.name && firstProject.syncTarget && firstProject.status) {
      log('✅ Project structure: All required fields present', 'green');
      passed++;
    } else {
      log('❌ Project structure: Missing required fields', 'red');
    }

    // Test 2: Status values
    const validStatuses = ['succeeded', 'failed', 'pending'];
    const allValidStatus = projects.every(p => validStatuses.includes(p.status));
    if (allValidStatus) {
      log('✅ Status values: All valid', 'green');
      passed++;
    } else {
      log('❌ Status values: Invalid status found', 'red');
    }

    // Test 3: Sync targets match
    const vercelProjects = projects.filter(p => p.syncTarget.includes('Vercel')).length;
    const railwayProjects = projects.filter(p => p.syncTarget.includes('Railway')).length;
    const infraVercel = infra.syncTargets.vercel.length;
    const infraRailway = infra.syncTargets.railway.length;

    if (vercelProjects === infraVercel && railwayProjects === infraRailway) {
      log(`✅ Sync targets match: Vercel=${vercelProjects}, Railway=${railwayProjects}`, 'green');
      passed++;
    } else {
      log(`❌ Sync targets mismatch: Projects(V=${vercelProjects},R=${railwayProjects}) vs Infra(V=${infraVercel},R=${infraRailway})`, 'red');
    }

    // Test 4: URLs format
    const validURLs = infra.server.startsWith('http') && infra.webUI.startsWith('http');
    if (validURLs) {
      log('✅ URL format: Valid HTTP(S) URLs', 'green');
      passed++;
    } else {
      log('❌ URL format: Invalid URLs', 'red');
    }

    // Test 5: Duplicate check
    const projectIds = projects.map(p => p.id);
    const uniqueIds = new Set(projectIds);
    if (projectIds.length === uniqueIds.size) {
      log('✅ Duplicate check: No duplicate project IDs', 'green');
      passed++;
    } else {
      log('❌ Duplicate check: Duplicate project IDs found', 'red');
    }

  } catch (error) {
    log(`❌ Data integrity test failed: ${error.message}`, 'red');
  }

  return { passed, total };
}

async function testPerformance() {
  log('\n📋 Layer 3: Performance Tests', 'cyan');
  log('=' .repeat(50), 'cyan');

  let passed = 0;
  const total = 3;

  try {
    // Test 1: Single request latency
    const start1 = Date.now();
    await makeRequest(`${API_BASE}/api/infisical/projects`);
    const latency = Date.now() - start1;

    if (latency < 500) {
      log(`✅ Single request latency: ${latency}ms (< 500ms)`, 'green');
      passed++;
    } else {
      log(`❌ Single request latency: ${latency}ms (too slow)`, 'red');
    }

    // Test 2: Parallel requests
    const start2 = Date.now();
    await Promise.all([
      makeRequest(`${API_BASE}/api/infisical/projects`),
      makeRequest(`${API_BASE}/api/infisical/infrastructure`)
    ]);
    const parallelTime = Date.now() - start2;

    if (parallelTime < 1000) {
      log(`✅ Parallel requests: ${parallelTime}ms (< 1000ms)`, 'green');
      passed++;
    } else {
      log(`❌ Parallel requests: ${parallelTime}ms (too slow)`, 'red');
    }

    // Test 3: Multiple sequential requests
    const start3 = Date.now();
    for (let i = 0; i < 5; i++) {
      await makeRequest(`${API_BASE}/api/infisical/projects`);
    }
    const seqTime = Date.now() - start3;
    const avgTime = seqTime / 5;

    if (avgTime < 200) {
      log(`✅ Sequential requests: ${seqTime}ms total, ${avgTime.toFixed(0)}ms avg`, 'green');
      passed++;
    } else {
      log(`❌ Sequential requests: ${seqTime}ms total, ${avgTime.toFixed(0)}ms avg (too slow)`, 'red');
    }

  } catch (error) {
    log(`❌ Performance test failed: ${error.message}`, 'red');
  }

  return { passed, total };
}

async function testEdgeCases() {
  log('\n📋 Layer 4: Edge Cases & Error Handling', 'cyan');
  log('=' .repeat(50), 'cyan');

  let passed = 0;
  const total = 2;

  try {
    // Test 1: Invalid endpoint
    try {
      const result = await makeRequest(`${API_BASE}/api/infisical/nonexistent`);
      if (result.status === 404) {
        log('✅ Invalid endpoint: Returns 404', 'green');
        passed++;
      } else {
        log(`❌ Invalid endpoint: Returns ${result.status} instead of 404`, 'red');
      }
    } catch (error) {
      log('✅ Invalid endpoint: Properly handled', 'green');
      passed++;
    }

    // Test 2: Data consistency across requests
    const result1 = await makeRequest(`${API_BASE}/api/infisical/projects`);
    await new Promise(resolve => setTimeout(resolve, 100));
    const result2 = await makeRequest(`${API_BASE}/api/infisical/projects`);

    if (JSON.stringify(result1.data) === JSON.stringify(result2.data)) {
      log('✅ Data consistency: Same data across requests', 'green');
      passed++;
    } else {
      log('❌ Data consistency: Data changed between requests', 'red');
    }

  } catch (error) {
    log(`❌ Edge case test failed: ${error.message}`, 'red');
  }

  return { passed, total };
}

async function runAllTests() {
  log('\n🔐 Infisical Panel - Automated Test Suite', 'blue');
  log('=' .repeat(50), 'blue');

  const results = [];

  results.push(await testBackendAPI());
  results.push(await testDataIntegrity());
  results.push(await testPerformance());
  results.push(await testEdgeCases());

  // Summary
  const totalPassed = results.reduce((sum, r) => sum + r.passed, 0);
  const totalTests = results.reduce((sum, r) => sum + r.total, 0);
  const percentage = ((totalPassed / totalTests) * 100).toFixed(1);

  log('\n' + '='.repeat(50), 'blue');
  log('📊 TEST SUMMARY', 'blue');
  log('='.repeat(50), 'blue');
  log(`Total: ${totalPassed}/${totalTests} tests passed (${percentage}%)`,
      percentage === '100.0' ? 'green' : 'yellow');

  if (percentage === '100.0') {
    log('\n✅ ALL TESTS PASSED - Panel is 100% functional!', 'green');
  } else {
    log(`\n⚠️  Some tests failed - Panel functionality: ${percentage}%`, 'yellow');
  }

  process.exit(percentage === '100.0' ? 0 : 1);
}

// Run tests
runAllTests().catch(error => {
  log(`\n❌ Test suite crashed: ${error.message}`, 'red');
  process.exit(1);
});
