import { Router } from 'express';
import { join } from 'path';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { execSync } from 'child_process';

const router = Router();

// ========================================
// QA Dashboard API — Registry-Based (v4)
// ========================================
// Source of Truth: scenario_registry.json + features/scenarios/{app}/layer-X/
// Scenario-Layer Pyramid (Mental Model):
//   Layer 0: Preflight + Contract Scanners (Supabase, API, Frontend)
//   Layer 1: Backend (API-only Mental-Model Tests)
//   Layer 2: Components (UI Hybrid + UX Scoring)
//   Layer 3: Workflows (Persona Journeys)
//   Layer 4: Golden (Complete E2E Happy Path)
// Report Reader: Reads .md reports from report paths

const UNIFIED_TESTER_ROOT = '/root/projekte/werkingflow/tests/unified-tester';
const COVERAGE_DIR = join(UNIFIED_TESTER_ROOT, 'coverage/apps');
const REPORTS_DIR = join(UNIFIED_TESTER_ROOT, 'reports');
const SCENARIOS_DIR = join(UNIFIED_TESTER_ROOT, 'features/scenarios');
const CHECKPOINTS_DIR = '/tmp/test-checkpoints';
const TEST_RUNNER_LOGS = '/tmp';
const SCENARIO_REGISTRY = '/root/projekte/orchestrator/data/scenario_registry.json';

// Contract Scanner directories (Layer 0 data sources)
const TESTS_ROOT = '/root/projekte/werkingflow/tests';
const API_SCANNER_SNAPSHOTS = join(TESTS_ROOT, 'api-contract-scanner/snapshots');
const FRONTEND_SCANNER_RESULTS = join(TESTS_ROOT, 'frontend-contract-scanner/results');

// Arch-test results (persistent JSON from arch-test.py)
const ARCH_TEST_RESULTS_DIR = '/root/projekte/orchestrator/data/arch-test-results';

// Port → App mapping for identifying frontend scanner results
const PORT_TO_APP: Record<number, string> = {
  3004: 'platform',
  3005: 'werking-noise',
  3006: 'werking-safety',
  3007: 'werking-energy',
  3008: 'werking-report',
  3009: 'engelmann',
  3011: 'acro-community',
};

// Scenario registry (test results from test-runner.sh)
// scenario_registry.json tracks PASS/FAIL/PENDING per scenario

// App ID mapping (coverage dir name → display name)
const APP_IDS = ['engelmann', 'werking-report', 'werking-energy', 'werking-safety', 'werking-noise', 'platform', 'cui', 'energy-report', 'acro-community'] as const;

function readJSON(path: string): any | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

// ========================================
// Scenario-Registry-based App Statistics
// ========================================
// Source of Truth: scenario_registry.json + pyramid layer data

function getAppStatsFromScenarios(appId: string) {
  const pyramid = getPyramidData(appId);
  if (!pyramid || pyramid.layers.length === 0) return null;

  // Count all scenarios across all layers
  const allTests = pyramid.layers.flatMap(l => l.tests);
  const totalScenarios = allTests.length;
  const testedScenarios = allTests.filter(t => t.status === 'PASS' || t.status === 'PARTIAL').length;
  const failedScenarios = allTests.filter(t => t.status === 'FAIL' || t.status === 'ERROR').length;

  // Scores from all tests that have been scored
  const scores = allTests.map(t => t.score).filter(s => s != null && s > 0) as number[];
  const avgScore = scores.length > 0 ? scores.reduce((s, v) => s + v, 0) / scores.length : 0;

  // Coverage = tested / total scenarios
  const coveragePercent = totalScenarios > 0 ? (testedScenarios / totalScenarios) * 100 : 0;

  // Last tested date
  let lastTested: string | null = null;
  for (const t of allTests) {
    if (t.lastRun && (!lastTested || t.lastRun > lastTested)) lastTested = t.lastRun;
  }

  let status = 'untested';
  if (testedScenarios > 0) {
    if (avgScore >= 8) status = 'tested';
    else if (avgScore >= 5) status = 'partial';
    else status = 'failing';
  }

  return {
    id: appId,
    totalScenarios,
    testedScenarios,
    coveragePercent,
    avgScore,
    status,
    issues: failedScenarios,
    lastTested,
    layers: pyramid.layers.filter(l => l.id >= 0).map(l => ({
      id: l.id,
      name: l.name,
      passed: l.passed,
      total: l.totalTests,
      avgScore: l.avgScore,
      status: l.status,
    })),
  };
}

// ========================================
// Scenario-Layer Pyramid (Mental Model)
// ========================================
// Per-app pyramid from scenario directories:
//   layer-1 / layer-1-backend   = Backend (API-only, Mental-Model)
//   layer-2 / layer-2-components = Components (Hybrid, UX-Scoring)
//   layer-3 / layer-3-workflows  = Workflows (Persona Journeys)
//   layer-4 / layer-4-golden     = Golden (Full E2E)
// Plus optional:
//   layer-0-contract             = Architecture/Contract checks

// Layer naming patterns per app (different naming conventions)
const LAYER_PATTERNS: Record<number, string[]> = {
  0: ['layer-0', 'layer-0-contract', 'layer-0-contracts'],
  1: ['layer-1', 'layer-1-backend'],
  2: ['layer-2', 'layer-2-components', 'layer-2-frontend'],
  3: ['layer-3', 'layer-3-workflows'],
  4: ['layer-4', 'layer-4-golden', 'layer-4-backend'],
};

const LAYER_META: Record<number, { name: string; description: string }> = {
  0: { name: 'Architecture & Contracts', description: 'Pre-flight: Schema, Zod, data-ai-id' },
  1: { name: 'Backend', description: 'API-only Mental-Model Tests' },
  2: { name: 'Components', description: 'UI Hybrid Tests + UX Scoring' },
  3: { name: 'Workflows', description: 'Persona Journeys (Full)' },
  4: { name: 'Golden', description: 'Complete E2E Happy Path' },
};

// ========================================
// Layer 0: Contract Scanner Results
// ========================================
// Automatically loads results from:
//   - Frontend Scanner: scan_*.json (matched by port → app)
//   - API Scanner: snapshots/*.json (count + last updated)
//   - Supabase Scanner: (runtime only, no persistent results)

interface Layer0Sub {
  id: string;
  status: string; // PASS, FAIL, PENDING
  score: number | null;
  lastRun: string | null;
  reportPath: string | null;
  detail?: string;
}

function getLayer0Data(appId: string): {
  tests: Layer0Sub[];
  passed: number; failed: number; pending: number;
  avgScore: number; status: string; description: string;
} | null {
  const tests: Layer0Sub[] = [];
  let passed = 0, failed = 0, pending = 0;

  // --- Frontend Scanner Results ---
  // Find latest scan_*.json for this app's port
  try {
    if (existsSync(FRONTEND_SCANNER_RESULTS)) {
      const scanFiles = readdirSync(FRONTEND_SCANNER_RESULTS)
        .filter(f => f.startsWith('scan_') && f.endsWith('.json'))
        .sort()
        .reverse(); // newest first

      // Find latest scan matching this app's port
      const appPort = Object.entries(PORT_TO_APP).find(([_, id]) => id === appId)?.[0];
      if (appPort) {
        for (const scanFile of scanFiles) {
          try {
            const data = readJSON(join(FRONTEND_SCANNER_RESULTS, scanFile));
            if (!data?.base_url) continue;
            // Extract port from base_url (e.g. "http://localhost:3008" → "3008")
            const portMatch = data.base_url.match(/:(\d{4,5})$/);
            const scanPort = portMatch?.[1];
            if (scanPort !== appPort) continue;

            // Skip empty scans (server was likely down)
            const total = data.total_routes ?? 0;
            if (total === 0) continue;

            const success = data.success ?? 0;
            const errors = data.errors ?? 0;
            const scanStatus = errors > 0 ? 'FAIL' : success === total ? 'PASS' : 'PARTIAL';
            const score = total > 0 ? (success / total) * 10 : null;

            tests.push({
              id: `${appId}.frontend-routes`,
              status: scanStatus,
              score: score ? Math.round(score * 10) / 10 : null,
              lastRun: data.timestamp?.split('T')[0] ?? null,
              reportPath: null,
              detail: `${success}/${total} routes OK${errors > 0 ? `, ${errors} errors` : ''}`,
            });
            if (scanStatus === 'PASS') passed++;
            else if (scanStatus === 'FAIL') failed++;
            else pending++;
            break; // only latest with data
          } catch { /* */ }
        }
      }
    }
  } catch { /* */ }

  // --- API Scanner Snapshots ---
  try {
    if (existsSync(API_SCANNER_SNAPSHOTS)) {
      const snapshots = readdirSync(API_SCANNER_SNAPSHOTS).filter(f => f.endsWith('.json'));
      const snapshotCount = snapshots.length;
      if (snapshotCount > 0) {
        // Get latest modified date
        let latestMtime = 0;
        for (const f of snapshots.slice(0, 10)) { // sample first 10 for speed
          try {
            const st = statSync(join(API_SCANNER_SNAPSHOTS, f));
            if (st.mtimeMs > latestMtime) latestMtime = st.mtimeMs;
          } catch { /* */ }
        }
        tests.push({
          id: `${appId}.api-contracts`,
          status: 'PASS', // snapshots exist = baseline captured
          score: null,
          lastRun: latestMtime > 0 ? new Date(latestMtime).toISOString().split('T')[0] : null,
          reportPath: null,
          detail: `${snapshotCount} endpoint snapshots`,
        });
        passed++;
      }
    }
  } catch { /* */ }

  // --- Layer 0 Scenario Tests (from layer-0-contract/ dirs) ---
  // These are already picked up by the main layer scanner, so skip here

  // --- Arch-Test Results (all structural checks from arch-test.py) ---
  try {
    const archTestFile = join(ARCH_TEST_RESULTS_DIR, `${appId}.json`);
    if (existsSync(archTestFile)) {
      const archData = readJSON(archTestFile);
      if (archData?.tiers) {
        const testedAt = archData.timestamp?.split('T')[0] ?? null;
        for (const [tierNum, tierData] of Object.entries(archData.tiers) as [string, any][]) {
          if (!tierData?.checks) continue;
          for (const check of tierData.checks) {
            if (!check.name || check.name.startsWith('(skipped')) continue;
            // Skip frontend-routes and api-contracts — already added above from scanner files
            const checkId = `${appId}.arch.t${tierNum}.${check.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
            if (tests.some(t => t.id === checkId)) continue;

            const status = check.status === 'PASS' ? 'PASS'
              : check.status === 'FAIL' || check.status === 'ERROR' ? 'FAIL'
              : check.status === 'WARN' ? 'PASS' // WARN = not blocking
              : 'PENDING';
            const detail = check.metric
              ? `${check.name}: ${check.metric}`
              : `${check.name} (${check.duration_ms ?? 0}ms)`;

            tests.push({
              id: checkId,
              status,
              score: status === 'PASS' ? 10 : status === 'FAIL' ? 0 : 5,
              lastRun: testedAt,
              reportPath: null,
              detail,
            });
            if (status === 'PASS') passed++;
            else if (status === 'FAIL') failed++;
            else pending++;
          }
        }
      }
    }
  } catch { /* */ }

  if (tests.length === 0) return null;

  const scores = tests.map(t => t.score).filter(s => s != null && s > 0) as number[];
  const avgScore = scores.length > 0 ? scores.reduce((s, v) => s + v, 0) / scores.length : 0;
  const status = failed > 0 ? 'failed' : pending > 0 ? 'partial' : 'passed';
  const parts: string[] = [];
  for (const t of tests) if (t.detail) parts.push(t.detail);
  const description = parts.length > 0 ? parts.join(' | ') : 'Contract Scanner Results';

  return { tests, passed, failed, pending, avgScore, status, description };
}

// ========================================
// Pyramid Cache — Single Source of Truth
// ========================================
// Written by pyramid_status.py --write-cache
// Contains threshold-aware effective_status per scenario
// NO FALLBACK — if cache is missing, status is UNKNOWN (fail loud)

const PYRAMID_CACHE_DIR = '/root/projekte/orchestrator/data/pyramid_cache';

interface PyramidCacheScenario {
  effective_status: string;
  raw_status: string;
  score: number | null;
  tested_at: string | null;
  optional: boolean;
  stale: boolean;
  report_path: string | null;
}

interface PyramidCacheLayer {
  total: number;
  pass: number;
  fail: number;
  pending: number;
  stale: number;
  status: string;
  avg_score: number;
  scenarios: Record<string, PyramidCacheScenario>;
}

interface PyramidCache {
  app: string;
  layers: Record<string, PyramidCacheLayer>;
  totals: { total: number; pass: number; fail: number; pending: number; stale: number };
  cache_written_at: string;
}

function loadPyramidCache(appId: string): PyramidCache {
  const cachePath = join(PYRAMID_CACHE_DIR, `${appId}.json`);
  if (!existsSync(cachePath)) {
    throw new Error(`[QA] Pyramid cache missing for ${appId}. Run: python3 pyramid_status.py --app ${appId} --write-cache`);
  }
  const data = JSON.parse(readFileSync(cachePath, 'utf-8'));
  if (!data.cache_written_at || !data.layers) {
    throw new Error(`[QA] Pyramid cache corrupt for ${appId}: missing cache_written_at or layers`);
  }
  return data as PyramidCache;
}

function resolveStatusFromCache(scenarioId: string, cache: PyramidCache): string {
  for (const layerData of Object.values(cache.layers)) {
    const cached = layerData.scenarios?.[scenarioId];
    if (cached) return cached.effective_status;
  }
  // Scenario exists on filesystem but not in cache → PENDING (new scenario, cache not refreshed yet)
  return 'PENDING';
}

// Returns ALL matching layer dirs (multiple patterns may exist, e.g. layer-4-golden + layer-4-backend)
function findLayerDirs(appScenarioDir: string, layerNum: number): string[] {
  const patterns = LAYER_PATTERNS[layerNum] ?? [];
  const dirs: string[] = [];
  for (const p of patterns) {
    const dir = join(appScenarioDir, p);
    if (existsSync(dir)) dirs.push(dir);
  }
  return dirs;
}

function scanLayerScenarios(layerDir: string): Array<{ id: string; file: string; layer: number }> {
  const scenarios: Array<{ id: string; file: string; layer: number }> = [];
  const scanRecursive = (dir: string) => {
    try {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        try {
          if (statSync(full).isDirectory()) { scanRecursive(full); continue; }
        } catch { continue; }
        if (!entry.endsWith('.json')) continue;
        try {
          const data = readJSON(full);
          if (!data) continue;
          scenarios.push({
            id: data.id || data.scenario_id || entry.replace('.json', ''),
            file: full,
            layer: data.layer ?? 0,
          });
        } catch { /* */ }
      }
    } catch { /* */ }
  };
  scanRecursive(layerDir);
  return scenarios;
}

// Extract compact scenario details from scenario JSON + report markdown
function getScenarioSummary(scenarioFile: string, reportPath: string | null): {
  description: string | null;
  stepsPreview: string | null;
  criteriaPreview: string | null;
  reviewExcerpt: string | null;
} {
  let description: string | null = null;
  let stepsPreview: string | null = null;
  let criteriaPreview: string | null = null;
  let reviewExcerpt: string | null = null;

  // Read scenario JSON
  try {
    const data = readJSON(scenarioFile);
    if (data) {
      description = data.description || null;

      // Steps: compact summary
      const steps = data.steps ?? [];
      if (steps.length > 0) {
        const stepTexts = steps
          .filter((s: any) => typeof s === 'string' ? !s.startsWith('Speichere:') : !s?.action?.startsWith('screenshot'))
          .map((s: any) => typeof s === 'string' ? s : (s.description || s.instruction || s.action || ''))
          .filter((s: string) => s.length > 0)
          .slice(0, 5);
        stepsPreview = stepTexts.map((s: string, i: number) => `${i + 1}. ${s.length > 80 ? s.slice(0, 77) + '...' : s}`).join('\n');
        if (steps.length > 5) stepsPreview += `\n... +${steps.length - 5} more`;
      }

      // Criteria
      const criteria = data.success_criteria ?? data.criteria ?? [];
      if (criteria.length > 0) {
        const critTexts = criteria.map((c: any) =>
          typeof c === 'string' ? c : (c.description || c.criterion || JSON.stringify(c))
        ).slice(0, 5);
        criteriaPreview = critTexts.map((c: string) => `• ${c.length > 80 ? c.slice(0, 77) + '...' : c}`).join('\n');
        if (criteria.length > 5) criteriaPreview += `\n... +${criteria.length - 5} more`;
      }
    }
  } catch { /* */ }

  // Read report excerpt (## AI Report section or ## Bewertung)
  if (reportPath) {
    try {
      if (existsSync(reportPath)) {
        const content = readFileSync(reportPath, 'utf-8');
        // Extract rating line
        const ratingMatch = content.match(/## Rating:.*$/m);
        const rating = ratingMatch?.[0] ?? '';

        // Extract Journey + Bewertung section (compact)
        const journeyMatch = content.match(/## Journey\n([\s\S]*?)(?=\n## |$)/);
        const journey = journeyMatch?.[1]?.trim().slice(0, 200) ?? '';

        // Extract problems summary
        const problemMatch = content.match(/## Gefundene Probleme\n([\s\S]*?)(?=\n## |$)/);
        let problems = '';
        if (problemMatch) {
          const lines = problemMatch[1].trim().split('\n').filter(l => l.startsWith('- ') || l.startsWith('**')).slice(0, 4);
          problems = lines.join('\n');
        }

        if (rating || journey) {
          reviewExcerpt = [rating, journey, problems].filter(Boolean).join('\n\n');
          if (reviewExcerpt.length > 500) reviewExcerpt = reviewExcerpt.slice(0, 497) + '...';
        }
      }
    } catch { /* */ }
  }

  return { description, stepsPreview, criteriaPreview, reviewExcerpt };
}

function getPyramidData(appId: string) {
  const appScenarioDir = join(SCENARIOS_DIR, appId);
  if (!existsSync(appScenarioDir)) return null;

  // Load pyramid cache (Single Source of Truth for status logic)
  const pyramidCache = loadPyramidCache(appId);

  // Load scenario registry for metadata (score, tested_at, report_path)
  const scenarioRegistry = readJSON(SCENARIO_REGISTRY);
  const regScenarios = scenarioRegistry?.scenarios ?? {};

  // Also check for flat scenarios (not in layer dirs — e.g. werking-safety, werking-noise)
  const flatScenarios: Array<{ id: string; file: string }> = [];
  try {
    for (const file of readdirSync(appScenarioDir)) {
      if (!file.endsWith('.json')) continue;
      const data = readJSON(join(appScenarioDir, file));
      if (data) flatScenarios.push({ id: data.id || data.scenario_id || file.replace('.json', ''), file: join(appScenarioDir, file) });
    }
  } catch { /* */ }

  // Also check personas/ dir
  const personasDir = join(appScenarioDir, 'personas');
  if (existsSync(personasDir)) {
    const scanRecursive = (dir: string) => {
      try {
        for (const entry of readdirSync(dir)) {
          const full = join(dir, entry);
          if (statSync(full).isDirectory()) { scanRecursive(full); continue; }
          if (!entry.endsWith('.json')) continue;
          const data = readJSON(full);
          if (data) flatScenarios.push({ id: data.id || data.scenario_id || entry.replace('.json', ''), file: full });
        }
      } catch { /* */ }
    };
    scanRecursive(personasDir);
  }

  // Build layers
  const layers: Array<{
    id: number; name: string; description: string;
    totalTests: number; passed: number; failed: number; pending: number;
    avgScore: number; status: string;
    tests: Array<{ id: string; status: string; score: number | null; lastRun: string | null; reportPath: string | null }>;
  }> = [];

  for (let layerNum = 0; layerNum <= 4; layerNum++) {
    if (layerNum === 0) {
      // Layer 0: Combine scenario-based layer-0 tests + contract scanner results
      const layerDirs = findLayerDirs(appScenarioDir, 0);
      const scenarioTests: Array<{ id: string; status: string; score: number | null; lastRun: string | null; reportPath: string | null }> = [];
      let sPassed = 0, sFailed = 0, sPending = 0;
      const sScores: number[] = [];

      for (const layerDir of layerDirs) {
        const scenarios = scanLayerScenarios(layerDir);
        for (const s of scenarios) {
          const reg = regScenarios[s.id];
          const status = resolveStatusFromCache(s.id, pyramidCache);
          const score = reg?.score ?? null;
          if (status === 'PASS') sPassed++;
          else if (status === 'FAIL' || status === 'ERROR') sFailed++;
          else if (status === 'PENDING') sPending++;
          else sFailed++; // PARTIAL without threshold pass = fail
          if (score != null && score > 0) sScores.push(score);
          const summary = getScenarioSummary(s.file, reg?.report_path ?? null);
          scenarioTests.push({ id: s.id, status, score, lastRun: reg?.tested_at ?? null, reportPath: reg?.report_path ?? null, ...summary });
        }
      }

      // Add contract scanner results
      const scannerData = getLayer0Data(appId);
      const allTests = [...scenarioTests];
      let totalPassed = sPassed, totalFailed = sFailed, totalPending = sPending;
      const allScores = [...sScores];

      if (scannerData) {
        allTests.push(...scannerData.tests);
        totalPassed += scannerData.passed;
        totalFailed += scannerData.failed;
        totalPending += scannerData.pending;
        for (const t of scannerData.tests) {
          if (t.score != null && t.score > 0) allScores.push(t.score);
        }
      }

      if (allTests.length > 0) {
        const meta = LAYER_META[0];
        const avgScore = allScores.length > 0 ? allScores.reduce((s, v) => s + v, 0) / allScores.length : 0;
        const layerStatus = totalFailed > 0 ? 'failed'
          : totalPending === allTests.length ? 'pending'
          : totalPassed === allTests.length ? 'passed'
          : 'partial';

        // Build description from scanner data if available
        const desc = scannerData?.description ?? meta.description;

        layers.push({
          id: 0,
          name: meta.name,
          description: desc,
          totalTests: allTests.length,
          passed: totalPassed, failed: totalFailed, pending: totalPending,
          avgScore,
          status: layerStatus,
          tests: allTests,
        });
      }
      continue;
    }

    const layerDirs = findLayerDirs(appScenarioDir, layerNum);
    if (layerDirs.length === 0) continue;

    const scenarios = layerDirs.flatMap(d => scanLayerScenarios(d));
    if (scenarios.length === 0) continue;

    const meta = LAYER_META[layerNum];
    let passed = 0, failed = 0, pending = 0;
    const scores: number[] = [];

    const tests = scenarios.map(s => {
      const reg = regScenarios[s.id];
      const status = resolveStatusFromCache(s.id, pyramidCache);
      const score = reg?.score ?? null;
      const lastRun = reg?.tested_at ?? null;
      const reportPath = reg?.report_path ?? null;
      const summary = getScenarioSummary(s.file, reportPath);

      if (status === 'PASS') passed++;
      else if (status === 'FAIL' || status === 'ERROR') failed++;
      else if (status === 'PENDING') pending++;
      else failed++; // PARTIAL without threshold pass = fail

      if (score != null && score > 0) scores.push(score);

      const outputQualityScore = reg?.output_quality_score ?? null;
      return { id: s.id, status, score, lastRun, reportPath, outputQualityScore, ...summary };
    });

    const avgScore = scores.length > 0 ? scores.reduce((s, v) => s + v, 0) / scores.length : 0;
    const layerStatus = tests.length === 0 ? 'empty'
      : pending === tests.length ? 'pending'
      : failed > 0 ? 'failed'
      : passed === tests.length ? 'passed'
      : 'partial';

    layers.push({
      id: layerNum,
      name: meta.name,
      description: meta.description,
      totalTests: tests.length,
      passed, failed, pending,
      avgScore,
      status: layerStatus,
      tests,
    });
  }

  // Add flat scenarios as "Ungrouped" if no layers found or there are extra flat ones
  const layeredIds = new Set(layers.flatMap(l => l.tests.map(t => t.id)));
  const ungrouped = flatScenarios.filter(s => !layeredIds.has(s.id));

  if (ungrouped.length > 0) {
    let passed = 0, failed = 0, pending = 0;
    const scores: number[] = [];
    const tests = ungrouped.map(s => {
      const reg = regScenarios[s.id];
      const status = resolveStatusFromCache(s.id, pyramidCache);
      const score = reg?.score ?? null;
      if (status === 'PASS') passed++;
      else if (status === 'FAIL' || status === 'ERROR') failed++;
      else if (status === 'PENDING') pending++;
      else failed++;
      if (score != null && score > 0) scores.push(score);
      const summary = getScenarioSummary(s.file, reg?.report_path ?? null);
      return { id: s.id, status, score, lastRun: reg?.tested_at ?? null, reportPath: reg?.report_path ?? null, ...summary };
    });
    const avgScore = scores.length > 0 ? scores.reduce((s, v) => s + v, 0) / scores.length : 0;

    layers.push({
      id: -1,
      name: 'Scenarios',
      description: 'Flat scenarios (not yet layered)',
      totalTests: tests.length,
      passed, failed, pending,
      avgScore,
      status: failed > 0 ? 'failed' : pending === tests.length ? 'pending' : passed === tests.length ? 'passed' : 'partial',
      tests,
    });
  }

  // Load coverage gap data to attach to pyramid response
  const coveragePath = join(COVERAGE_DIR, appId, 'gap-report.json');
  const coverageData = readJSON(coveragePath);
  const coverage = coverageData ? {
    api: { pct: coverageData.api?.pct ?? 0, total: coverageData.api?.total ?? 0, covered: coverageData.api?.covered ?? 0 },
    ui: { pct: coverageData.ui?.pct ?? 0, total: coverageData.ui?.total ?? 0, covered: coverageData.ui?.covered ?? 0 },
    combined: coverageData.api?.status === 'ok' && coverageData.ui?.status === 'ok'
      ? Math.round(((coverageData.api.pct + coverageData.ui.pct) / 2) * 10) / 10
      : Math.round((coverageData.api?.pct ?? coverageData.ui?.pct ?? 0) * 10) / 10,
    timestamp: coverageData.timestamp ?? null,
  } : null;

  return {
    app: appId,
    layers,
    coverage,
    timestamp: new Date().toISOString(),
  };
}

// ========================================
// Running Tests / Checkpoints / Recent Runs
// ========================================

function formatTimestamp(ts: string): string {
  if (!ts || ts.length !== 15) return ts;
  return `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)} ${ts.slice(9, 11)}:${ts.slice(11, 13)}:${ts.slice(13, 15)}`;
}

function getRunningTests() {
  const running: Array<{ pid: number; scenario: string; startedAt: string; logFile: string }> = [];
  try {
    const logFiles = readdirSync(TEST_RUNNER_LOGS).filter(f => f.startsWith('test-') && f.endsWith('.log'));
    for (const logFile of logFiles) {
      const match = logFile.match(/^test-(.+)-(\d{8}_\d{6})\.log$/);
      if (!match) continue;
      const scenario = match[1];
      const timestamp = match[2];
      const pidFile = join(TEST_RUNNER_LOGS, `test-${scenario}.pid`);
      if (!existsSync(pidFile)) continue;
      try {
        const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
        if (isNaN(pid)) continue;
        process.kill(pid, 0); // Check if alive
        running.push({ pid, scenario, startedAt: formatTimestamp(timestamp), logFile: join(TEST_RUNNER_LOGS, logFile) });
      } catch { /* process dead */ }
    }
  } catch { /* */ }
  return running;
}

function getCheckpoints() {
  const checkpoints: Array<{ scenario: string; turnNumber: number; savedAt: string | null }> = [];
  try {
    if (!existsSync(CHECKPOINTS_DIR)) return checkpoints;
    for (const file of readdirSync(CHECKPOINTS_DIR).filter(f => f.endsWith('.json'))) {
      try {
        const data = JSON.parse(readFileSync(join(CHECKPOINTS_DIR, file), 'utf-8'));
        checkpoints.push({
          scenario: data.scenario || data.feature_id || file.replace('.json', ''),
          turnNumber: data.turn || data.turn_number || 0,
          savedAt: data.timestamp || null,
        });
      } catch { /* */ }
    }
  } catch { /* */ }
  return checkpoints;
}

// ========================================
// Recent Runs (from report files)
// ========================================

function getRecentRuns(limit: number = 50): Array<{ file: string; persona: string; app: string; mode: string; timestamp: string | null; path: string }> {
  const runs: Array<{ file: string; persona: string; app: string; mode: string; timestamp: string | null; path: string; mtime: number }> = [];
  const scenarioReportsDir = join(REPORTS_DIR, 'scenarios');

  try {
    if (!existsSync(scenarioReportsDir)) return [];
    const files = readdirSync(scenarioReportsDir).filter(f => f.endsWith('.md'));

    for (const file of files) {
      const fullPath = join(scenarioReportsDir, file);
      try {
        const stat = statSync(fullPath);
        // Parse filename: {app}_{feature}_{timestamp}.md or {persona}_{feature}_{timestamp}_{id}.md
        const parts = file.replace('.md', '').split('_');
        // Extract timestamp from filename (pattern: YYYYMMDD_HHMMSS)
        let timestamp: string | null = null;
        let app = parts[0] || 'unknown';
        let persona = parts[0] || 'unknown';
        let mode = 'scenario';

        // Try to find timestamp pattern in parts
        for (let i = 0; i < parts.length; i++) {
          if (/^\d{8}$/.test(parts[i]) && i + 1 < parts.length && /^\d{6}$/.test(parts[i + 1])) {
            timestamp = `${parts[i].slice(0, 4)}-${parts[i].slice(4, 6)}-${parts[i].slice(6, 8)} ${parts[i + 1].slice(0, 2)}:${parts[i + 1].slice(2, 4)}`;
            break;
          }
        }

        // Detect mode from filename
        if (file.includes('_api.md') || file.includes('_backend')) mode = 'backend';
        else if (file.includes('_visual')) mode = 'visual';
        else if (file.includes('_frontend')) mode = 'frontend';

        runs.push({
          file,
          persona,
          app,
          mode,
          timestamp,
          path: fullPath,
          mtime: stat.mtimeMs,
        });
      } catch { /* skip unreadable files */ }
    }
  } catch { /* */ }

  // Also scan top-level reports dir
  try {
    if (existsSync(REPORTS_DIR)) {
      const topFiles = readdirSync(REPORTS_DIR).filter(f => f.endsWith('.md') && !f.startsWith('FINAL'));
      for (const file of topFiles) {
        const fullPath = join(REPORTS_DIR, file);
        try {
          const stat = statSync(fullPath);
          const parts = file.replace('.md', '').split('_');
          let timestamp: string | null = null;
          let persona = parts.length >= 3 ? parts[1] : parts[0] || 'unknown';
          let mode = 'api';

          if (/^\d{8}$/.test(parts[0]) && parts.length > 1 && /^\d{6}$/.test(parts[1])) {
            timestamp = `${parts[0].slice(0, 4)}-${parts[0].slice(4, 6)}-${parts[0].slice(6, 8)} ${parts[1].slice(0, 2)}:${parts[1].slice(2, 4)}`;
            persona = parts[2] || 'unknown';
          }

          if (file.includes('_api')) mode = 'backend';
          else if (file.includes('_visual')) mode = 'visual';
          else if (file.includes('_frontend')) mode = 'frontend';

          const app = file.includes('engelmann') ? 'engelmann'
            : file.includes('gutachten') || file.includes('werking-report') ? 'werking-report'
            : file.includes('energy') ? 'werking-energy'
            : file.includes('safety') ? 'werking-safety'
            : 'unknown';

          runs.push({ file, persona, app, mode, timestamp, path: fullPath, mtime: stat.mtimeMs });
        } catch { /* */ }
      }
    }
  } catch { /* */ }

  // Sort by modification time (newest first) and limit
  runs.sort((a, b) => b.mtime - a.mtime);
  return runs.slice(0, limit).map(({ mtime, ...r }) => r);
}

// ========================================
// Scenario Discovery (from filesystem)
// ========================================

function discoverScenarios() {
  const scenarios: Array<{ id: string; app: string; name: string; status: string; lastRun: string | null; score: number | null }> = [];

  // Load scenario registry for metadata (tested_at, score)
  const scenarioRegistry = readJSON(SCENARIO_REGISTRY);
  const registryScenarios = scenarioRegistry?.scenarios ?? {};

  // Pyramid caches per app — loaded on demand
  const cachesByApp: Record<string, PyramidCache | undefined> = {};

  if (!existsSync(SCENARIOS_DIR)) return scenarios;

  const scanDir = (dir: string, app: string, prefix: string) => {
    if (!existsSync(dir)) return;
    // Lazy-load cache for this app (may not exist for all apps)
    if (!(app in cachesByApp)) {
      const cachePath = join(PYRAMID_CACHE_DIR, `${app}.json`);
      if (existsSync(cachePath)) {
        try {
          cachesByApp[app] = JSON.parse(readFileSync(cachePath, 'utf-8')) as PyramidCache;
        } catch {
          console.warn(`[QA] Corrupt pyramid cache for ${app}, treating all scenarios as PENDING`);
          cachesByApp[app] = undefined;
        }
      } else {
        cachesByApp[app] = undefined;
      }
    }
    const cache = cachesByApp[app];

    for (const entry of readdirSync(dir)) {
      if (entry.startsWith('_') && entry !== '_demos' && entry !== '_neukunde') continue;
      const fullPath = join(dir, entry);
      try {
        if (statSync(fullPath).isDirectory()) {
          scanDir(fullPath, app, prefix ? `${prefix}/${entry}` : entry);
        } else if (entry.endsWith('.json') && entry !== 'ACCOUNTS.md') {
          const data = readJSON(fullPath);
          if (!data) return;
          const scenarioId = data.id || data.scenario_id || entry.replace('.json', '');
          const regEntry = registryScenarios[scenarioId];

          // Status from cache if available, otherwise PENDING (no silent guessing)
          let status = 'PENDING';
          if (cache) {
            for (const layerData of Object.values(cache.layers)) {
              const cached = layerData.scenarios?.[scenarioId];
              if (cached) { status = cached.effective_status; break; }
            }
          }

          scenarios.push({
            id: scenarioId,
            app,
            name: data.name || data.ziel || scenarioId,
            status,
            lastRun: regEntry?.tested_at ?? null,
            score: regEntry?.score ?? null,
          });
        }
      } catch { /* individual file read error — skip file */ }
    }
  };

  for (const app of readdirSync(SCENARIOS_DIR)) {
    if (app.startsWith('.') || app.startsWith('_')) continue;
    try {
      if (statSync(join(SCENARIOS_DIR, app)).isDirectory()) {
        scanDir(join(SCENARIOS_DIR, app), app, '');
      }
    } catch { /* app dir stat error — skip app */ }
  }

  return scenarios;
}

// ========================================
// Report Reader (Markdown)
// ========================================

function readReportContent(reportPath: string): string | null {
  try {
    if (!reportPath || !existsSync(reportPath)) return null;
    return readFileSync(reportPath, 'utf-8');
  } catch {
    return null;
  }
}

// ========================================
// API Routes
// ========================================

// GET /api/qa/overview — Scenario-registry-based overview
router.get('/api/qa/overview', async (_req, res) => {
  try {
    const appStats = APP_IDS
      .map(appId => getAppStatsFromScenarios(appId))
      .filter(s => s !== null);

    const totals = {
      features: appStats.reduce((sum, a) => sum + a!.totalScenarios, 0),
      tested: appStats.reduce((sum, a) => sum + a!.testedScenarios, 0),
      coverage: appStats.length > 0
        ? appStats.reduce((sum, a) => sum + a!.coveragePercent, 0) / appStats.length
        : 0,
      avgScore: appStats.length > 0
        ? appStats.reduce((sum, a) => sum + a!.avgScore, 0) / appStats.length
        : 0,
      appsWithIssues: appStats.filter(a => a!.issues > 0).length,
    };

    res.json({ apps: appStats, totals, timestamp: new Date().toISOString() });
  } catch (err: any) {
    console.error('[QA] Overview error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/qa/runs — Running tests + checkpoints
router.get('/api/qa/runs', async (_req, res) => {
  try {
    res.json({
      running: getRunningTests(),
      checkpoints: getCheckpoints(),
      recentRuns: getRecentRuns(30),
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error('[QA] Runs error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/qa/app/:appId — Scenario-based detail (per layer)
router.get('/api/qa/app/:appId', async (req, res) => {
  try {
    const { appId } = req.params;
    const pyramid = getPyramidData(appId);
    if (!pyramid || pyramid.layers.length === 0) {
      return res.status(404).json({ error: `No scenario data for ${appId}` });
    }

    // Build scenario list with layer info — replaces old feature list
    const scenarios = pyramid.layers.flatMap(l =>
      l.tests.map(t => ({
        id: t.id,
        name: t.id,
        layer: l.id,
        layerName: l.name,
        status: t.status,
        score: t.score,
        lastRun: t.lastRun,
        reportPath: t.reportPath,
      }))
    );

    const testedCount = scenarios.filter(s => s.status === 'PASS' || s.status === 'PARTIAL').length;
    const scores = scenarios.map(s => s.score).filter(s => s != null && s > 0) as number[];

    res.json({
      appId,
      scenarios,
      statistics: {
        totalScenarios: scenarios.length,
        testedCount,
        avgScore: scores.length > 0 ? scores.reduce((s, v) => s + v, 0) / scores.length : 0,
        untestedScenarios: scenarios.filter(s => s.status === 'PENDING').map(s => s.id),
      },
      layers: pyramid.layers.filter(l => l.id >= 0).map(l => ({
        id: l.id,
        name: l.name,
        passed: l.passed,
        total: l.totalTests,
        avgScore: l.avgScore,
      })),
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error(`[QA] App detail error for ${req.params.appId}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/qa/pyramid/:appId — 4-Layer Testing Pyramid
router.get('/api/qa/pyramid/:appId', async (req, res) => {
  try {
    const { appId } = req.params;
    const data = getPyramidData(appId);
    if (!data) {
      return res.status(404).json({ error: `No data found for ${appId}` });
    }
    res.json(data);
  } catch (err: any) {
    console.error(`[QA] Pyramid error for ${req.params.appId}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/qa/report — Read report content (markdown)
// Query: ?path=/absolute/path/to/report.md
router.get('/api/qa/report', async (req, res) => {
  try {
    const reportPath = req.query.path as string;
    if (!reportPath) {
      return res.status(400).json({ error: 'path query parameter required' });
    }

    // Security: Only allow reading from unified-tester reports
    if (!reportPath.startsWith(UNIFIED_TESTER_ROOT) && !reportPath.startsWith('/root/projekte/werkingflow/tests/')) {
      return res.status(403).json({ error: 'Access denied — reports must be under unified-tester directory' });
    }
    if (reportPath.includes('..')) {
      return res.status(400).json({ error: 'Invalid path' });
    }

    const content = readReportContent(reportPath);
    if (!content) {
      return res.status(404).json({ error: 'Report not found' });
    }

    res.json({ path: reportPath, content, timestamp: new Date().toISOString() });
  } catch (err: any) {
    console.error('[QA] Report error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ========================================
// Coverage Gap Analysis (Post-Test)
// ========================================
// Source: coverage/apps/{appId}/gap-report.json
// Generated by: coverage_gap_analyzer.py via run_autonomous.py
// Contains: API endpoint gaps + UI element gaps

const VALID_APP_IDS = new Set<string>(APP_IDS);

function readCoverageGaps(appId: string): {
  api: { status: string; total: number; covered: number; gaps: number; pct: number; gap_details: any[]; method_gaps?: any[] };
  ui: { status: string; total: number; covered: number; gaps: number; pct: number; gaps_by_route: Record<string, string[]>; failed_elements?: any[] };
  timestamp: string;
} | null {
  const gapFile = join(COVERAGE_DIR, appId, 'gap-report.json');
  if (!existsSync(gapFile)) return null;

  try {
    const raw = readFileSync(gapFile, 'utf-8');
    const data = JSON.parse(raw);

    // Validate expected structure — fail fast on corrupt data
    if (typeof data !== 'object' || !data.app || !data.timestamp) {
      console.warn(`[QA] Invalid gap-report.json for ${appId}: missing app or timestamp`);
      return null;
    }

    return {
      api: data.api ?? { status: 'no_data', total: 0, covered: 0, gaps: 0, pct: 0, gap_details: [] },
      ui: data.ui ?? { status: 'no_data', total: 0, covered: 0, gaps: 0, pct: 0, gaps_by_route: {} },
      timestamp: data.timestamp,
    };
  } catch (err) {
    console.warn(`[QA] Failed to parse gap-report.json for ${appId}:`, err);
    return null;
  }
}

// GET /api/qa/coverage-gaps/:appId — Coverage gap report for specific app
router.get('/api/qa/coverage-gaps/:appId', async (req, res) => {
  try {
    const { appId } = req.params;

    if (!VALID_APP_IDS.has(appId)) {
      return res.status(400).json({ error: `Unknown app: ${appId}. Valid: ${Array.from(VALID_APP_IDS).join(', ')}` });
    }

    const gaps = readCoverageGaps(appId);
    if (!gaps) {
      return res.status(404).json({
        error: `No coverage gap data for ${appId}. Run tests first: python3 run_autonomous.py --app ${appId}`,
        app: appId,
      });
    }

    res.json({
      app: appId,
      ...gaps,
      generated: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error(`[QA] Coverage gaps error for ${req.params.appId}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/qa/coverage-gaps/:appId/refresh — Re-run coverage gap analyzer
router.post('/api/qa/coverage-gaps/:appId/refresh', async (req, res) => {
  const { appId } = req.params;

  if (!VALID_APP_IDS.has(appId)) {
    return res.status(400).json({ error: `Unknown app: ${appId}` });
  }

  try {
    const analyzerPath = join(UNIFIED_TESTER_ROOT, 'tools/coverage_gap_analyzer.py');

    if (!existsSync(analyzerPath)) {
      return res.status(500).json({ error: 'coverage_gap_analyzer.py not found' });
    }

    // Run analyzer twice: save JSON + MD reports (typically 10-30s each)
    execSync(
      `python3 "${analyzerPath}" --app "${appId}" --format json --save`,
      { cwd: UNIFIED_TESTER_ROOT, timeout: 60000, stdio: 'pipe' }
    );
    execSync(
      `python3 "${analyzerPath}" --app "${appId}" --format markdown --save`,
      { cwd: UNIFIED_TESTER_ROOT, timeout: 60000, stdio: 'pipe' }
    );

    // Read freshly generated report
    const gaps = readCoverageGaps(appId);
    if (!gaps) {
      return res.status(500).json({ error: 'Analyzer ran but no report generated' });
    }

    res.json({ app: appId, ...gaps, refreshed: true, generated: new Date().toISOString() });
  } catch (err: any) {
    console.error(`[QA] Coverage refresh error for ${appId}:`, err.message);
    res.status(500).json({ error: `Analyzer failed: ${err.message?.slice(0, 200)}` });
  }
});

// GET /api/qa/scenarios — All scenarios from filesystem + registry
router.get('/api/qa/scenarios', async (_req, res) => {
  try {
    const scenarios = discoverScenarios();
    res.json({ scenarios, total: scenarios.length, timestamp: new Date().toISOString() });
  } catch (err: any) {
    console.error('[QA] Scenarios error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ========================================
// Change Impact / Staleness Detection
// ========================================
// Source: change_impact_analyzer.py → orchestrator/data/staleness/{appId}.json
// Detects which tests are "stale" (code changed since last test run)

const STALENESS_DIR = '/root/projekte/orchestrator/data/staleness';
const CHANGE_IMPACT_ANALYZER = join(UNIFIED_TESTER_ROOT, 'tools/change_impact_analyzer.py');

interface StaleScenario {
  scenario_id: string;
  layer: number | null;
  status: string;
  score: number | null;
  tested_at: string | null;
  latest_change: string | null;
  staleness_reason: string;
  reasons: string[];
  changed_files: string[];
}

function readStalenessData(appId: string): {
  stale_scenarios: StaleScenario[];
  per_layer: Record<number, StaleScenario[]>;
  summary: { total_stale: number; total_scenarios: number; stale_by_layer: Record<number, number> };
  changed_files_count: number;
  head_commit: string | null;
  timestamp: string;
} | null {
  const stalenessFile = join(STALENESS_DIR, `${appId}.json`);
  if (!existsSync(stalenessFile)) return null;

  try {
    const raw = readFileSync(stalenessFile, 'utf-8');
    const data = JSON.parse(raw);
    if (!data || !data.app) return null;
    return data;
  } catch {
    return null;
  }
}

// GET /api/qa/staleness/:appId — Read cached staleness report
router.get('/api/qa/staleness/:appId', async (req, res) => {
  try {
    const { appId } = req.params;

    if (!VALID_APP_IDS.has(appId)) {
      return res.status(400).json({ error: `Unknown app: ${appId}. Valid: ${Array.from(VALID_APP_IDS).join(', ')}` });
    }

    const data = readStalenessData(appId);
    if (!data) {
      return res.status(404).json({
        error: `No staleness data for ${appId}. Run: python3 change_impact_analyzer.py --app ${appId} --save`,
        app: appId,
      });
    }

    res.json({ app: appId, ...data });
  } catch (err: any) {
    console.error(`[QA] Staleness error for ${req.params.appId}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/qa/staleness/:appId/refresh — Re-run change impact analyzer
router.post('/api/qa/staleness/:appId/refresh', async (req, res) => {
  const { appId } = req.params;

  if (!VALID_APP_IDS.has(appId)) {
    return res.status(400).json({ error: `Unknown app: ${appId}` });
  }

  try {
    if (!existsSync(CHANGE_IMPACT_ANALYZER)) {
      return res.status(500).json({ error: 'change_impact_analyzer.py not found' });
    }

    execSync(
      `python3 "${CHANGE_IMPACT_ANALYZER}" --app "${appId}" --save`,
      { cwd: UNIFIED_TESTER_ROOT, timeout: 120000, stdio: 'pipe' }
    );

    const data = readStalenessData(appId);
    if (!data) {
      return res.status(500).json({ error: 'Analyzer ran but no report generated' });
    }

    res.json({ app: appId, ...data, refreshed: true });
  } catch (err: any) {
    console.error(`[QA] Staleness refresh error for ${appId}:`, err.message);
    res.status(500).json({ error: `Analyzer failed: ${err.message?.slice(0, 200)}` });
  }
});

// POST /api/qa/staleness/:appId/retest — Trigger re-test of stale scenarios
router.post('/api/qa/staleness/:appId/retest', async (req, res) => {
  const { appId } = req.params;
  const { scenarioId, layer } = req.body ?? {};

  if (!VALID_APP_IDS.has(appId)) {
    return res.status(400).json({ error: `Unknown app: ${appId}` });
  }

  try {
    const runAutonomous = join(UNIFIED_TESTER_ROOT, 'run_autonomous.py');
    if (!existsSync(runAutonomous)) {
      return res.status(500).json({ error: 'run_autonomous.py not found' });
    }

    let cmd: string;
    let logSuffix: string;

    if (scenarioId) {
      // Re-test single scenario
      cmd = `python3 "${runAutonomous}" --scenario "${scenarioId}"`;
      logSuffix = scenarioId.replace(/\./g, '_');
    } else if (layer !== undefined) {
      // Re-test all stale scenarios in a layer — run the first stale one
      const staleness = readStalenessData(appId);
      const layerStale = staleness?.per_layer?.[layer];
      if (!layerStale || layerStale.length === 0) {
        return res.json({ message: `No stale scenarios in layer ${layer}`, triggered: 0 });
      }
      // Trigger first stale scenario (sequential, to avoid overload)
      const first = layerStale[0];
      cmd = `python3 "${runAutonomous}" --scenario "${first.scenario_id}"`;
      logSuffix = `layer${layer}_${first.scenario_id.replace(/\./g, '_')}`;
    } else {
      return res.status(400).json({ error: 'Provide scenarioId or layer in request body' });
    }

    // Run in background with nohup
    const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
    const logFile = `/tmp/retest-${logSuffix}-${timestamp}.log`;
    const bgCmd = `nohup ${cmd} > "${logFile}" 2>&1 & echo $!`;

    const pidOutput = execSync(bgCmd, {
      cwd: UNIFIED_TESTER_ROOT,
      timeout: 10000,
      shell: '/bin/bash',
    }).toString().trim();

    const pid = parseInt(pidOutput, 10);

    res.json({
      message: `Re-test triggered`,
      pid: isNaN(pid) ? null : pid,
      logFile,
      command: cmd,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error(`[QA] Retest error for ${appId}:`, err.message);
    res.status(500).json({ error: `Retest failed: ${err.message?.slice(0, 200)}` });
  }
});

export default router;
