import { Router } from 'express';
import { join } from 'path';
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, appendFileSync } from 'fs';
import { execSync, spawn } from 'child_process';
import { requireAuth, optionalAuth } from '../auth/middleware.js';
import { isAuthEnabled, findUser } from '../auth/users.js';

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

import { PATHS } from '../config/paths.js';

const UNIFIED_TESTER_ROOT = PATHS.unifiedTesterRoot;
const COVERAGE_DIR = join(UNIFIED_TESTER_ROOT, 'coverage/apps');
const REPORTS_DIR = join(UNIFIED_TESTER_ROOT, 'reports');
const SCENARIOS_DIR = join(UNIFIED_TESTER_ROOT, 'features/scenarios');
const CHECKPOINTS_DIR = '/tmp/test-checkpoints';
const TEST_RUNNER_LOGS = '/tmp';
const SCENARIO_REGISTRY = PATHS.scenarioRegistry;

// Contract Scanner directories (Layer 0 data sources)
const TESTS_ROOT = PATHS.testsRoot;
const API_SCANNER_SNAPSHOTS = join(TESTS_ROOT, 'api-contract-scanner/snapshots');
const FRONTEND_SCANNER_RESULTS = join(TESTS_ROOT, 'frontend-contract-scanner/results');

// Arch-test results (persistent JSON from arch-test.py)
const ARCH_TEST_RESULTS_DIR = PATHS.archTestResultsDir;

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
  const bridgeFailureScenarios = allTests.filter(t => t.status === 'BRIDGE_FAILURE').length;
  const notTestedScenarios = allTests.filter(t => t.status === 'NOT_TESTED').length;

  // Scores from all tests that have been scored
  const scores = allTests.map(t => t.score).filter(s => s != null && s > 0) as number[];
  const avgScore = scores.length > 0 ? scores.reduce((s, v) => s + v, 0) / scores.length : 0;

  // Coverage = tested / scorable scenarios (exclude bridge failures and not-tested — they are untestable/blocked)
  const scorableScenarios = totalScenarios - bridgeFailureScenarios - notTestedScenarios;
  const coveragePercent = scorableScenarios > 0 ? (testedScenarios / scorableScenarios) * 100 : 0;

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
    bridgeFailure: bridgeFailureScenarios,
    lastTested,
    layers: pyramid.layers.filter(l => l.id >= 0).map(l => ({
      id: l.id,
      name: l.name,
      passed: l.passed,
      total: l.totalTests,
      avgScore: l.avgScore,
      status: l.status,
      bridgeFailure: (l as any).bridgeFailure ?? 0,
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
  1: ['layer-1', 'layer-1-backend', 'layer-1-components'],
  2: ['layer-2', 'layer-2-components', 'layer-2-frontend', 'layer-2-backend'],
  3: ['layer-3', 'layer-3-workflows'],
  4: ['layer-4', 'layer-4-golden', 'layer-4-backend'],
};

const LAYER_META: Record<number, { name: string; description: string }> = {
  0: { name: 'Architecture & Contracts', description: 'Env, Static Analysis, Contracts, Scanners' },
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
  status: string; // PASS, FAIL, PENDING, NOT_RUN
  score: number | null;
  lastRun: string | null;
  reportPath: string | null;
  detail?: string;
  group?: 'core' | 'llm_enhanced'; // core = deterministic (Tier 0-3), llm_enhanced = AI-Bridge (Tier 4)
  tooltip?: string; // LLM test: what it does
  outputs?: string; // LLM test: expected outputs
}

function getLayer0Data(appId: string): {
  tests: Layer0Sub[];
  passed: number; failed: number; pending: number;
  avgScore: number; status: string; description: string;
  coreSummary: { passed: number; failed: number; pending: number; total: number };
  llmSummary: { passed: number; failed: number; pending: number; total: number };
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
              group: 'core',
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
          group: 'core',
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
              : check.status === 'SKIP' ? 'SKIP' // Not applicable for this app
              : 'PENDING';
            const detail = check.metric
              ? `${check.name}: ${check.metric}`
              : `${check.name} (${check.duration_ms ?? 0}ms)`;

            // Tier 4 = LLM-enhanced (AI-Bridge), Tier 0-3 = core (deterministic)
            const group: 'core' | 'llm_enhanced' = parseInt(tierNum) >= 4 ? 'llm_enhanced' : 'core';

            tests.push({
              id: checkId,
              status,
              score: status === 'PASS' ? 10 : status === 'FAIL' ? 0 : 5,
              lastRun: testedAt,
              reportPath: null,
              detail,
              group,
            });
            if (status === 'PASS') passed++;
            else if (status === 'FAIL') failed++;
            else pending++;
          }
        }
      }
    }
  } catch { /* */ }

  // --- Always show the 5 Persona Audit checks (Tier 4), even if arch-test --tier 4 never ran ---
  const LLM_CHECKS = [
    {
      name: 'Persona: Legal',
      desc: 'AI-Bridge: Compliance & Legal Expert',
      tooltip: 'IT-Rechtsanwalt prueft DSGVO Art. 13/14, Impressumspflicht (§5 ECG/TMG), AGB-Klauseln, Haftungsausschluesse und Widersprueche zwischen UI-Versprechen und AGB.',
      outputs: 'Score 0-10, Findings nach Schweregrad (Critical/High/Medium), konkrete Textstellen mit Empfehlungen',
    },
    {
      name: 'Persona: Domain Expert',
      desc: 'AI-Bridge: Ingenieur / Ziviltechniker',
      tooltip: 'Erfahrener Ziviltechniker prueft Fachterminologie, Normen-Referenzen (OENORM, DIN), Glaubwuerdigkeit fuer Ingenieure und ob KI-Versprechen realistisch sind.',
      outputs: 'Score 0-10, Fachliche Findings mit konkreten Textstellen, Glaubwuerdigkeits-Bewertung',
    },
    {
      name: 'Persona: Consistency',
      desc: 'AI-Bridge: QA / Consistency Tester',
      tooltip: 'QA-Spezialist durchsucht alle UI-Texte systematisch nach Inkonsistenzen: Markenname, Begriffspaare, Du/Sie-Mix, Preis-Widersprueche, Firmendaten, Datumsformate.',
      outputs: 'Score 0-10, Inkonsistenz-Katalog nach Kategorie, exakte Textstellen und Routen',
    },
    {
      name: 'Persona: UX Writer',
      desc: 'AI-Bridge: UX Writer / Content Designer',
      tooltip: 'UX Writer prueft Microcopy-Qualitaet: Erster Eindruck, Nutzerfuehrung, Fehlermeldungen, CTAs, Empty States, Tone of Voice fuer B2B-Ingenieur-Zielgruppe.',
      outputs: 'Score 0-10, UX-Findings mit konkreten Verbesserungsvorschlaegen, Tone-of-Voice-Analyse',
    },
    {
      name: 'Persona: Accessibility',
      desc: 'AI-Bridge: WCAG / Accessibility Expert',
      tooltip: 'WCAG-Auditor prueft Barrierefreiheit der Texte: Klare Sprache, Screen-Reader-Tauglichkeit, Fehlermeldungen, Abkuerzungen — auch fuer Baustellennutzung (Handschuhe, kleine Screens).',
      outputs: 'Score 0-10, Accessibility-Findings mit WCAG-Referenzen, Empfehlungen fuer klare Sprache',
    },
  ];
  for (const llmCheck of LLM_CHECKS) {
    const checkId = `${appId}.arch.t4.${llmCheck.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    if (tests.some(t => t.id === checkId)) {
      // Already loaded from arch-test JSON — enrich with tooltip/outputs
      const existing = tests.find(t => t.id === checkId)!;
      existing.tooltip = llmCheck.tooltip;
      existing.outputs = llmCheck.outputs;
      continue;
    }
    tests.push({
      id: checkId,
      status: 'NOT_RUN',
      score: null,
      lastRun: null,
      reportPath: null,
      detail: llmCheck.desc,
      group: 'llm_enhanced',
      tooltip: llmCheck.tooltip,
      outputs: llmCheck.outputs,
    });
    // NOT_RUN does not count as passed/failed/pending for totals
  }

  if (tests.length === 0) return null;

  const scores = tests.map(t => t.score).filter(s => s != null && s > 0) as number[];
  const avgScore = scores.length > 0 ? scores.reduce((s, v) => s + v, 0) / scores.length : 0;
  const status = failed > 0 ? 'failed' : pending > 0 ? 'partial' : 'passed';
  // Short description (not the full detail dump)
  const description = 'Pre-flight: Env, Static Analysis, Contracts, Scanners';

  // Compute core vs llm_enhanced summaries
  const coreTests = tests.filter(t => t.group !== 'llm_enhanced');
  const llmTests = tests.filter(t => t.group === 'llm_enhanced');
  const coreSummary = {
    passed: coreTests.filter(t => t.status === 'PASS').length,
    failed: coreTests.filter(t => t.status === 'FAIL').length,
    pending: coreTests.filter(t => t.status !== 'PASS' && t.status !== 'FAIL').length,
    total: coreTests.length,
  };
  const llmSummary = {
    passed: llmTests.filter(t => t.status === 'PASS').length,
    failed: llmTests.filter(t => t.status === 'FAIL').length,
    pending: llmTests.filter(t => t.status !== 'PASS' && t.status !== 'FAIL').length,
    total: llmTests.length,
  };

  return { tests, passed, failed, pending, avgScore, status, description, coreSummary, llmSummary };
}

// ========================================
// Report Scanner — Direct Source of Truth
// ========================================
// Scans report .md files directly from reports/scenarios/
// No intermediate cache or registry needed — always live data.

const REPORTS_SCENARIOS_DIR = join(UNIFIED_TESTER_ROOT, 'reports/scenarios');

interface ScannedReport {
  scenarioId: string;
  status: string;
  score: number | null;
  timestamp: string | null;
  reportPath: string;
  duration: number | null;
}

/**
 * Scan all report .md files for an app and return the latest report per scenario.
 * Report filename pattern: {app}_{scenario-slug}_{YYYYMMDD}_{HHMMSS}_{seq}.md
 * Parses header for: scenario_id, status, score, timestamp.
 */
function scanReportsForApp(appId: string): Record<string, ScannedReport> {
  const results: Record<string, ScannedReport> = {};
  // Track filename-based sort keys (YYYYMMDD_HHMMSS_seq) per scenarioId — always reliable
  const sortKeys = new Map<string, string>();
  if (!existsSync(REPORTS_SCENARIOS_DIR)) return results;

  // App prefix patterns to match (handle hyphens in app names)
  const appPrefix = appId + '_';

  try {
    for (const file of readdirSync(REPORTS_SCENARIOS_DIR)) {
      if (!file.endsWith('.md')) continue;
      if (!file.startsWith(appPrefix)) continue;

      const fullPath = join(REPORTS_SCENARIOS_DIR, file);
      try {
        // Read only the header (first 800 bytes is enough)
        const content = readFileSync(fullPath, 'utf-8').slice(0, 800);

        // Derive scenario_id from FILENAME (canonical source).
        // Filename format: {id_dots_as_underscores}_{YYYYMMDD}_{HHMMSS}_{mmm}.md
        // Find the timestamp boundary: 8-digit date pattern from the end
        const baseName = file.replace(/\.md$/, '');
        const parts = baseName.split('_');
        let tsStart = -1;
        for (let i = parts.length - 1; i >= 0; i--) {
          if (parts[i].length === 8 && /^\d{8}$/.test(parts[i])) {
            tsStart = i;
            break;
          }
        }
        const idFromFile = tsStart > 0
          ? parts.slice(0, tsStart).join('.')  // underscores back to dots
          : null;

        // Fallback: parse from header "# Scenario Test Report: {id}"
        const idMatch = content.match(/^# Scenario Test Report:\s*(.+)$/m);
        const scenarioId = idFromFile || (idMatch ? idMatch[1].trim() : null);
        if (!scenarioId) continue;

        // Parse status
        let status = 'PENDING';
        if (content.includes('✅ PASS')) status = 'PASS';
        else if (content.includes('⛔ NOT TESTED') || content.includes('NOT_TESTED')) status = 'NOT_TESTED';
        else if (content.includes('❌ FAIL')) status = 'FAIL';
        else if (content.includes('⚠') || content.includes('PARTIAL')) status = 'PARTIAL';

        // Parse score: "Rating: ★★★★★★★★★☆ 9/10" or "Rating: ⏳ Pending"
        let score: number | null = null;
        const scoreMatch = content.match(/(\d+(?:\.\d+)?)\s*\/\s*10/);
        if (scoreMatch) score = parseFloat(scoreMatch[1]);

        // Parse timestamp
        let timestamp: string | null = null;
        const tsMatch = content.match(/\*\*Timestamp:\*\*\s*(\S+)/);
        if (tsMatch) timestamp = tsMatch[1];

        // Parse duration
        let duration: number | null = null;
        const durMatch = content.match(/\*\*Duration:\*\*\s*([\d.]+)s/);
        if (durMatch) duration = parseFloat(durMatch[1]);

        const report: ScannedReport = { scenarioId, status, score, timestamp, reportPath: fullPath, duration };

        // Keep the latest report per scenario using filename sort key (YYYYMMDD_HHMMSS_seq).
        // This is always present and reliable — unlike header timestamps which can be null.
        const fileSortKey = tsStart > 0 ? parts.slice(tsStart).join('_') : file;
        const existingSortKey = sortKeys.get(scenarioId) ?? '';
        if (!results[scenarioId] || fileSortKey > existingSortKey) {
          results[scenarioId] = report;
          sortKeys.set(scenarioId, fileSortKey);
        }
      } catch { /* skip unreadable reports */ }
    }
  } catch { /* directory not readable */ }

  return results;
}

/**
 * Resolve scenario status from scanned reports.
 * Falls back to 'PENDING' if no report exists.
 *
 * SHA-drift aware: when a scenario file is provided and its current
 * generator SHAs (auftrag_sha / product_sha / prompt_template_sha)
 * disagree with what the report tested against, the report is treated
 * as stale and the per-test status is downgraded to 'STALE'. This
 * mirrors the layer-level logic in pyramid_status.py so the dashboard
 * never shows a green PASS for a scenario that has been regenerated
 * since the last test run.
 */
function resolveStatusFromReports(
  scenarioId: string,
  reports: Record<string, ScannedReport>,
  scenarioFile?: string,
  registryEntry?: any,
): string {
  const report = reports[scenarioId];
  if (!report) return 'PENDING';
  const baseStatus = report.status;
  // Only PASS / PARTIAL can be stale — FAIL / NOT_TESTED / BRIDGE_FAILURE
  // are not "verified for any version" and are returned as-is.
  if (baseStatus !== 'PASS' && baseStatus !== 'PARTIAL') return baseStatus;
  if (!scenarioFile) return baseStatus;
  if (isScenarioStale(scenarioFile, registryEntry, report.reportPath)) return 'STALE';
  return baseStatus;
}

/**
 * Check whether the scenario at the given JSON path has been regenerated
 * since its last recorded test run. Reads meta.last_run.tested_against_sha
 * from the scenario file and compares it with generated.auftrag_sha. A
 * mismatch means the report no longer reflects the current scenario.
 *
 * Returns false when there is not enough information to decide (no
 * meta.last_run, no SHA on either side) — the layer-level CLI handles
 * the date-based fallback for those cases.
 */
function isScenarioStale(scenarioFile: string, _registryEntry?: any, reportPath?: string | null): boolean {
  try {
    const data = readJSON(scenarioFile);
    if (!data) return false;
    const generated = data?.generated;
    if (!generated) return false;
    const currentAuftrag = generated.auftrag_sha;
    if (!currentAuftrag) return false;

    // SSoT: meta.last_run.tested_against_sha drives drift detection.
    // The orchestrator registry is no longer consulted.
    const lastRun = data?.meta?.last_run;
    if (!lastRun) return true;
    const testedAuftrag = lastRun.tested_against_sha;
    if (!testedAuftrag) return true;
    if (testedAuftrag !== currentAuftrag) return true;

    // Report file existence. A meta.last_run entry pointing at a missing
    // report file (archived, deleted, runner crashed before writing) is not
    // a verified PASS — surface as stale so the dashboard re-tests.
    const metaReport = lastRun.report_path ?? reportPath;
    if (metaReport) {
      const fsPath = String(metaReport).startsWith('/tester/')
        ? String(metaReport).replace('/tester/', UNIFIED_TESTER_ROOT + '/')
        : String(metaReport);
      if (!existsSync(fsPath)) return true;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Supplement scanned reports with `meta.last_run` from scenario JSON files.
 *
 * Status SSoT — `meta.last_run` inside each scenario file is now the single
 * source of truth for status / score / report_path / tested_at. The
 * orchestrator registry (scenario_registry.json) is no longer consulted for
 * status; it carries lock-state only.
 *
 * Markdown reports under reports/scenarios/ still take priority when they
 * are present and same-day-or-newer than `meta.last_run.tested_at`. When the
 * markdown is missing (archived, never written, runner crashed) we fall back
 * to the meta block so the dashboard sees the most recent run instead of
 * silently dropping the scenario back to PENDING.
 */
function mergeMetaLastRunIntoReports(appId: string, reports: Record<string, ScannedReport>): void {
  const appScenarioDir = join(SCENARIOS_DIR, appId);
  if (!existsSync(appScenarioDir)) return;

  const ingest = (scenarioFile: string) => {
    const data = readJSON(scenarioFile);
    if (!data) return;
    const sid: string = data.id || data.scenario_id;
    if (!sid) return;
    const lastRun = data?.meta?.last_run;
    if (!lastRun || !lastRun.status) return;
    const status: string = String(lastRun.status).toUpperCase();

    const existing = reports[sid];
    if (existing) {
      const metaDate: string | null = lastRun.tested_at ?? null;
      const reportDate: string | null = existing.timestamp ?? null;
      const reportDateOnly = reportDate ? reportDate.substring(0, 10) : null;
      const metaDateOnly = metaDate ? metaDate.substring(0, 10) : null;
      // Keep existing markdown report only if strictly newer (day-level).
      if (!metaDateOnly || (reportDateOnly && reportDateOnly > metaDateOnly)) return;
    }

    reports[sid] = {
      scenarioId: sid,
      status,
      score: typeof lastRun.score === 'number' ? lastRun.score : null,
      timestamp: lastRun.tested_at ?? null,
      reportPath: lastRun.report_path ?? '',
      duration: typeof lastRun.duration_seconds === 'number' ? lastRun.duration_seconds : null,
    };
  };

  const walk = (dir: string) => {
    try {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        try {
          if (statSync(full).isDirectory()) { walk(full); continue; }
        } catch { continue; }
        if (full.endsWith('.json')) ingest(full);
      }
    } catch { /* unreadable dir */ }
  };
  walk(appScenarioDir);
}

// Legacy compatibility: keep pyramid cache dir reference for rescan endpoint
const PYRAMID_CACHE_DIR = PATHS.pyramidCacheDir;

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
  scenarioJson: any | null;
} {
  let description: string | null = null;
  let stepsPreview: string | null = null;
  let criteriaPreview: string | null = null;
  let reviewExcerpt: string | null = null;
  let scenarioJson: any | null = null;

  // Read scenario JSON
  try {
    const data = readJSON(scenarioFile);
    if (data) {
      scenarioJson = data;
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

        // Extract Journey/Erlebnis section (compact) — supports both old ("Journey") and new ("Erlebnis") format
        const journeyMatch = content.match(/## (?:Journey|Erlebnis)\n([\s\S]*?)(?=\n## |$)/);
        const journey = journeyMatch?.[1]?.trim() ?? '';

        // Extract problems/findings summary — supports both old ("Gefundene Probleme") and new ("Findings") format
        const problemMatch = content.match(/## (?:Gefundene Probleme|Findings)\n([\s\S]*?)(?=\n## |$)/);
        let problems = '';
        if (problemMatch) {
          const lines = problemMatch[1].trim().split('\n').filter(l => l.startsWith('- ') || l.startsWith('|') || l.startsWith('**')).slice(0, 4);
          problems = lines.join('\n');
        }

        if (rating || journey) {
          reviewExcerpt = [rating, journey, problems].filter(Boolean).join('\n\n');
          // No truncation — frontend handles scrolling
        }
      }
    } catch { /* */ }
  }

  return { description, stepsPreview, criteriaPreview, reviewExcerpt, scenarioJson };
}

/**
 * Single source of truth for layer-level status.
 *
 * pyramid_status.py owns: status resolution, stale detection (auftrag_sha
 * drift), score verification, real-world layer routing, optional-deprecation
 * warnings. This bridge runs the CLI and returns its JSON output verbatim,
 * so qa.ts never reimplements what pyramid_status already decides.
 *
 * On failure (CLI missing, parse error, timeout) returns null — the caller
 * falls back to local aggregation (legacy path) so the dashboard never
 * goes blank, but the discrepancy is logged for triage.
 */
function getPyramidStatusFromCli(appId: string): {
  layers: Record<string, {
    total: number; pass: number; fail: number; pending: number;
    orange?: number; stale: number; bridge_failures?: number;
    status: string; avg_score?: number;
  }>;
  totals: {
    total: number; pass: number; fail: number; pending: number;
    orange?: number; stale: number; bridge_failures?: number;
  };
} | null {
  try {
    const out = execSync(
      `python3 pyramid_status.py --app ${appId} --json`,
      {
        cwd: UNIFIED_TESTER_ROOT,
        encoding: 'utf-8',
        timeout: 30_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const parsed = JSON.parse(out);
    if (!parsed || typeof parsed !== 'object' || !parsed.layers) return null;
    return parsed;
  } catch (err: any) {
    console.warn(`[QA] pyramid_status.py bridge failed for ${appId}: ${err.message ?? err}`);
    return null;
  }
}

function getPyramidData(appId: string) {
  const appScenarioDir = join(SCENARIOS_DIR, appId);
  if (!existsSync(appScenarioDir)) return null;

  // Single source of truth for layer-level status — pyramid_status.py.
  // Returned per-layer counts (passed/failed/pending/stale) override the
  // local aggregates below so that dashboard and CLI never disagree.
  const ssot = getPyramidStatusFromCli(appId);

  // SSoT: scan markdown reports, then merge `meta.last_run` from scenario JSON.
  // The orchestrator registry is no longer consulted for status.
  const scannedReports = scanReportsForApp(appId);
  mergeMetaLastRunIntoReports(appId, scannedReports);

  // Empty placeholder kept so existing call sites still type-check; isScenarioStale
  // now relies entirely on meta.last_run inside the scenario file.
  const registryByScenarioId: Record<string, any> = {};

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
          const report = scannedReports[s.id];
          const status = resolveStatusFromReports(s.id, scannedReports, s.file, registryByScenarioId[s.id]);
          const score = report?.score ?? null;
          if (status === 'PASS') sPassed++;
          else if (status === 'FAIL' || status === 'ERROR') sFailed++;
          else if (status === 'PENDING' || status === 'BRIDGE_FAILURE' || status === 'NOT_TESTED' || status === 'STALE') sPending++;
          else sFailed++; // PARTIAL without threshold pass = fail
          if (score != null && score > 0) sScores.push(score);
          const summary = getScenarioSummary(s.file, report?.reportPath ?? null);
          scenarioTests.push({ id: s.id, status, score, lastRun: report?.timestamp ?? null, reportPath: report?.reportPath ?? null, ...summary });
        }
      }

      // Add contract scanner results
      const scannerData = getLayer0Data(appId);
      const allTests = [...scenarioTests];

      if (scannerData) {
        allTests.push(...scannerData.tests);
      }

      // Split into core (Layer 0) and LLM (Layer 0.5)
      const coreTests = allTests.filter((t: any) => t.group !== 'llm_enhanced');
      const llmTests = allTests.filter((t: any) => t.group === 'llm_enhanced');

      // --- Layer 0: Core (deterministic) only ---
      if (coreTests.length > 0) {
        const meta = LAYER_META[0];
        const corePassed = coreTests.filter(t => t.status === 'PASS').length;
        const coreFailed = coreTests.filter(t => t.status === 'FAIL' || t.status === 'ERROR').length;
        const coreBridgeFailure = coreTests.filter(t => t.status === 'BRIDGE_FAILURE').length;
        const coreNotTested = coreTests.filter(t => t.status === 'NOT_TESTED').length;
        const corePending = coreTests.filter(t => t.status !== 'PASS' && t.status !== 'FAIL' && t.status !== 'ERROR').length;
        const coreScores = coreTests.map(t => t.score).filter(s => s != null && s > 0) as number[];
        const coreAvg = coreScores.length > 0 ? coreScores.reduce((s, v) => s + v, 0) / coreScores.length : 0;
        const coreScoredTotal = coreTests.length - coreBridgeFailure - coreNotTested;
        const coreStatus = (coreBridgeFailure + coreNotTested) === coreTests.length ? 'not_scored'
          : coreFailed > 0 ? 'failed'
          : corePassed === coreScoredTotal ? 'passed'
          : coreTests.every(t => t.status === 'PENDING' || t.status === 'BRIDGE_FAILURE' || t.status === 'NOT_TESTED') ? 'pending'
          : 'partial';

        const desc = scannerData?.description ?? meta.description;

        layers.push({
          id: 0,
          name: meta.name,
          description: desc,
          totalTests: coreTests.length,
          passed: corePassed, failed: coreFailed, pending: corePending, bridgeFailure: coreBridgeFailure, notTested: coreNotTested,
          avgScore: coreAvg,
          status: coreStatus,
          tests: coreTests,
        } as any);
      }

      // --- Layer 0.5: LLM-Enhanced (AI-Bridge, optional) ---
      if (llmTests.length > 0) {
        const llmPassed = llmTests.filter(t => t.status === 'PASS').length;
        const llmFailed = llmTests.filter(t => t.status === 'FAIL' || t.status === 'ERROR').length;
        const llmBridgeFailure = llmTests.filter(t => t.status === 'BRIDGE_FAILURE').length;
        const llmNotTested = llmTests.filter(t => t.status === 'NOT_TESTED').length;
        const llmPending = llmTests.filter(t => t.status !== 'PASS' && t.status !== 'FAIL' && t.status !== 'ERROR').length;
        const llmScores = llmTests.map(t => t.score).filter(s => s != null && s > 0) as number[];
        const llmAvg = llmScores.length > 0 ? llmScores.reduce((s, v) => s + v, 0) / llmScores.length : 0;
        const llmScoredTotal = llmTests.length - llmBridgeFailure - llmNotTested;
        const allNotRun = llmTests.every(t => t.status === 'NOT_RUN' || t.status === 'PENDING' || t.status === 'BRIDGE_FAILURE' || t.status === 'NOT_TESTED');
        const llmStatus = allNotRun ? 'not_run'
          : llmFailed > 0 ? 'failed'
          : llmPassed === llmScoredTotal ? 'passed'
          : 'partial';

        layers.push({
          id: 0.5,
          name: 'Persona Audits',
          description: '5 Experten-Personas pruefen UI-Texte via AI-Bridge: Legal, Domain, Consistency, UX, Accessibility',
          totalTests: llmTests.length,
          passed: llmPassed, failed: llmFailed, pending: llmPending, bridgeFailure: llmBridgeFailure,
          avgScore: llmAvg,
          status: llmStatus,
          tests: llmTests,
        } as any);
      }
      continue;
    }

    const layerDirs = findLayerDirs(appScenarioDir, layerNum);
    if (layerDirs.length === 0) continue;

    const scenarios = layerDirs.flatMap(d => scanLayerScenarios(d));
    if (scenarios.length === 0) continue;

    const meta = LAYER_META[layerNum];
    let passed = 0, failed = 0, pending = 0, bridgeFailure = 0, notTested = 0;
    const scores: number[] = [];

    const tests = scenarios.map(s => {
      const report = scannedReports[s.id];
      const status = resolveStatusFromReports(s.id, scannedReports, s.file, registryByScenarioId[s.id]);
      const score = report?.score ?? null;
      const lastRun = report?.timestamp ?? null;
      const reportPath = report?.reportPath ?? null;
      const summary = getScenarioSummary(s.file, reportPath);

      if (status === 'PASS') passed++;
      else if (status === 'FAIL' || status === 'ERROR') failed++;
      else if (status === 'NOT_TESTED') { notTested++; pending++; }
      else if (status === 'BRIDGE_FAILURE') { bridgeFailure++; pending++; }
      else if (status === 'PENDING') pending++;
      else if (status === 'STALE') pending++; // SHA-drift: not verified for current version
      else failed++; // PARTIAL without threshold pass = fail

      if (score != null && score > 0) scores.push(score);

      const outputQualityScore = null;
      return { id: s.id, status, score, lastRun, reportPath, outputQualityScore, ...summary };
    });

    const avgScore = scores.length > 0 ? scores.reduce((s, v) => s + v, 0) / scores.length : 0;
    const scoredTotal = tests.length - bridgeFailure - notTested; // exclude unscored from pass/fail logic
    const layerStatus = tests.length === 0 ? 'empty'
      : (bridgeFailure + notTested) === tests.length ? 'not_scored'
      : (pending - bridgeFailure - notTested) === scoredTotal ? 'pending'
      : failed > 0 ? 'failed'
      : passed === scoredTotal ? 'passed'
      : 'partial';

    layers.push({
      id: layerNum,
      name: meta.name,
      description: meta.description,
      totalTests: tests.length,
      passed, failed, pending, bridgeFailure, notTested,
      avgScore,
      status: layerStatus,
      tests,
    });
  }

  // Add flat scenarios as "Ungrouped" if no layers found or there are extra flat ones
  const layeredIds = new Set(layers.flatMap(l => l.tests.map(t => t.id)));
  const ungrouped = flatScenarios.filter(s => !layeredIds.has(s.id));

  if (ungrouped.length > 0) {
    let passed = 0, failed = 0, pending = 0, bridgeFailure = 0, notTested = 0;
    const scores: number[] = [];
    const tests = ungrouped.map(s => {
      const report = scannedReports[s.id];
      const status = resolveStatusFromReports(s.id, scannedReports, s.file, registryByScenarioId[s.id]);
      const score = report?.score ?? null;
      if (status === 'PASS') passed++;
      else if (status === 'FAIL' || status === 'ERROR') failed++;
      else if (status === 'NOT_TESTED') { notTested++; pending++; }
      else if (status === 'BRIDGE_FAILURE') { bridgeFailure++; pending++; }
      else if (status === 'PENDING') pending++;
      else failed++;
      if (score != null && score > 0) scores.push(score);
      const summary = getScenarioSummary(s.file, report?.reportPath ?? null);
      return { id: s.id, status, score, lastRun: report?.timestamp ?? null, reportPath: report?.reportPath ?? null, ...summary };
    });
    const avgScore = scores.length > 0 ? scores.reduce((s, v) => s + v, 0) / scores.length : 0;
    const scoredTotal = tests.length - bridgeFailure - notTested;

    layers.push({
      id: -1,
      name: 'Scenarios',
      description: 'Flat scenarios (not yet layered)',
      totalTests: tests.length,
      passed, failed, pending, bridgeFailure, notTested,
      avgScore,
      status: (bridgeFailure + notTested) === tests.length ? 'not_scored'
        : failed > 0 ? 'failed'
        : (pending - bridgeFailure - notTested) === scoredTotal ? 'pending'
        : passed === scoredTotal ? 'passed'
        : 'partial',
      tests,
    });
  }

  // Overlay layer-level counts and status from pyramid_status.py (SSoT).
  // Local aggregation above is kept for the per-test detail rows the
  // dashboard renders, but layer totals/status come from the CLI so that
  // dashboard and CLI never diverge on stale detection or status logic.
  //
  // STALE handling: pyramid_status.py reports stale as a SUBSET of pass
  // (i.e. a PASS whose recorded SHA no longer matches the current scenario,
  // or whose tested_at is older than the stale cutoff). The dashboard must
  // not show those as "PASS" — they are not verified for the current
  // scenario version. We subtract stale from passed and re-bucket them
  // into pending so that the user sees the real verified-pass count.
  if (ssot && ssot.layers) {
    const STATUS_MAP: Record<string, string> = {
      PASS: 'passed',
      STALE: 'stale',
      PARTIAL: 'partial',
      FAIL: 'failed',
      SKIP: 'pending',
      PART: 'partial',
    };
    for (const layer of layers) {
      const lid = (layer as any).id;
      const ssotKey = String(lid);
      const ssotLayer = ssot.layers[ssotKey];
      if (!ssotLayer) continue;
      // Override aggregates only for the regular numbered layers (0..4).
      // Synthetic layers (e.g. id=-1 for ungrouped) keep their local counts.
      if (typeof lid === 'number' && lid >= 0 && lid <= 4) {
        const ssotPass = ssotLayer.pass ?? layer.passed;
        const ssotStale = ssotLayer.stale ?? 0;
        const ssotPending = ssotLayer.pending ?? layer.pending;
        const ssotFail = ssotLayer.fail ?? layer.failed;
        const total = ssotLayer.total ?? layer.totalTests;
        // stale PASS → not verified for current scenario version → bucket as pending
        const verifiedPass = Math.max(0, ssotPass - ssotStale);
        const reBucketedPending = ssotPending + ssotStale;
        // Recompute layer status from re-bucketed counts. The CLI's PARTIAL
        // bubbles up whenever pending > 0, but after subtracting stale from
        // pass we may now have 0 passed AND 0 failed — that is PENDING (or
        // STALE if everything is unverified due to drift), not PARTIAL.
        let recomputedStatus: string;
        if (total === 0) recomputedStatus = 'pending';
        else if (ssotFail > 0) recomputedStatus = 'failed';
        else if (verifiedPass === 0 && reBucketedPending === total) {
          // Nothing verified for current version. If everything is stale
          // (i.e. there are reports but they all drifted), call it stale;
          // otherwise it is purely pending.
          recomputedStatus = ssotStale === total ? 'stale'
            : ssotStale > 0 ? 'stale'
            : 'pending';
        } else if (verifiedPass === total) recomputedStatus = 'passed';
        else if (verifiedPass > 0 && reBucketedPending > 0) recomputedStatus = 'partial';
        else recomputedStatus = STATUS_MAP[ssotLayer.status] ?? layer.status;

        (layer as any).totalTests = total;
        (layer as any).passed = verifiedPass;
        (layer as any).failed = ssotFail;
        (layer as any).pending = reBucketedPending;
        (layer as any).stale = ssotStale;
        (layer as any).bridgeFailure = ssotLayer.bridge_failures ?? (layer as any).bridgeFailure ?? 0;
        (layer as any).avgScore = ssotLayer.avg_score ?? layer.avgScore;
        (layer as any).status = recomputedStatus;
      }
    }
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
    ssot_source: ssot ? 'pyramid_status.py' : 'local-fallback',
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

  // Scan reports per app — loaded on demand
  const reportsByApp: Record<string, Record<string, ScannedReport>> = {};

  if (!existsSync(SCENARIOS_DIR)) return scenarios;

  const scanDir = (dir: string, app: string, prefix: string) => {
    if (!existsSync(dir)) return;
    // Lazy-load reports for this app
    if (!(app in reportsByApp)) {
      reportsByApp[app] = scanReportsForApp(app);
    }
    const reports = reportsByApp[app];

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
          const report = reports[scenarioId];

          scenarios.push({
            id: scenarioId,
            app,
            name: data.name || data.ziel || scenarioId,
            status: report?.status ?? 'PENDING',
            lastRun: report?.timestamp ?? null,
            score: report?.score ?? null,
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
    const bridgeFailureCount = scenarios.filter(s => s.status === 'BRIDGE_FAILURE').length;
    const notTestedCount = scenarios.filter(s => s.status === 'NOT_TESTED').length;
    const scores = scenarios.map(s => s.score).filter(s => s != null && s > 0) as number[];

    res.json({
      appId,
      scenarios,
      statistics: {
        totalScenarios: scenarios.length,
        testedCount,
        bridgeFailures: bridgeFailureCount,
        notTested: notTestedCount,
        avgScore: scores.length > 0 ? scores.reduce((s, v) => s + v, 0) / scores.length : 0,
        untestedScenarios: scenarios.filter(s => s.status === 'PENDING').map(s => s.id),
      },
      layers: pyramid.layers.filter(l => l.id >= 0).map(l => ({
        id: l.id,
        name: l.name,
        passed: l.passed,
        total: l.totalTests,
        avgScore: l.avgScore,
        bridgeFailures: (l as any).bridgeFailure ?? 0,
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
    if (!reportPath.startsWith(UNIFIED_TESTER_ROOT) && !reportPath.startsWith(TESTS_ROOT + '/')) {
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

// GET /api/qa/scenarios — All scenarios from filesystem + registry (scope-filtered for non-admins)
router.get('/api/qa/scenarios', optionalAuth, async (req, res) => {
  try {
    const scenarios = discoverScenarios();
    const scope = getUserScope(req);
    const filtered = scope.isAdmin ? scenarios : scenarios.filter(s => scope.apps.includes(s.app));
    res.json({ scenarios: filtered, total: filtered.length, timestamp: new Date().toISOString() });
  } catch (err: any) {
    console.error('[QA] Scenarios error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ========================================
// Dependency Graph
// ========================================
// Source: scenario_index.json + individual scenario JSONs
// Builds a graph of test dependencies, file refs, user credentials

const SCENARIO_INDEX_PATH = join(UNIFIED_TESTER_ROOT, 'features', 'scenario_index.json');
const SCENARIOS_BASE = join(UNIFIED_TESTER_ROOT, 'features');
const TEST_DATA_ROOT = join(UNIFIED_TESTER_ROOT, 'test-data');

// Map test-data app dirs to scenario system names
const TEST_DATA_APP_MAP: Record<string, string> = {
  'engelmann': 'engelmann',
  'werking-report': 'werking-report',
  'werking-safety': 'werking-safety',
  'werking-energy': 'werking-energy',
};

// Scan Tier-1 test-data directory for fixture files
function scanTier1Fixtures(appName: string): { name: string; path: string; size: number | null; subdir: string }[] {
  // Find the right test-data dir for this app
  let testDataDir = '';
  for (const [dirName, system] of Object.entries(TEST_DATA_APP_MAP)) {
    if (system === appName) { testDataDir = join(TEST_DATA_ROOT, dirName); break; }
  }
  if (!testDataDir || !existsSync(testDataDir)) return [];

  // If the test-data dir looks like a codebase (has package.json, Dockerfile etc.), skip it
  const CODEBASE_MARKERS = ['package.json', 'Dockerfile', 'requirements.txt', 'Cargo.toml', 'go.mod'];
  for (const marker of CODEBASE_MARKERS) {
    if (existsSync(join(testDataDir, marker))) return [];
  }

  const fixtures: { name: string; path: string; size: number | null; subdir: string }[] = [];
  const SKIP_FILES = new Set(['README.md', 'README', '.gitkeep', '.pending', 'setup.sh', '.DS_Store']);
  const SKIP_EXTS = new Set(['.pending', '.bak']);
  // Fixture-only extensions — skip code/config files
  const FIXTURE_EXTS = new Set([
    '.pdf', '.xlsx', '.xls', '.csv', '.json', '.xml',
    '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tiff', '.webp', '.svg',
    '.doc', '.docx', '.ppt', '.pptx', '.odt', '.ods',
    '.txt', '.md', '.html', '.htm', '.rtf',
    '.wfreport', '.wfpres', '.cfg', '.env', '.ini', '.css',
    '.zip', '.tar', '.gz', '.mp3', '.mp4', '.wav',
  ]);
  const MAX_DEPTH = 3;

  const walk = (dir: string, relPrefix: string, depth: number) => {
    if (depth > MAX_DEPTH) return;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });

      // Skip subdirs that look like codebases
      if (depth > 0) {
        const entryNames = entries.map(e => e.name);
        if (entryNames.includes('package.json') || entryNames.includes('node_modules')) return;
      }

      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (['node_modules', '.git', '__pycache__', 'venv', '.venv', '.vercel', '.pytest_cache', '_archive', '.next', 'dist', 'build'].includes(entry.name)) continue;
          walk(fullPath, relPrefix ? `${relPrefix}/${entry.name}` : entry.name, depth + 1);
        } else if (entry.isFile()) {
          if (SKIP_FILES.has(entry.name)) continue;
          const ext = entry.name.includes('.') ? '.' + entry.name.split('.').pop()!.toLowerCase() : '';
          if (SKIP_EXTS.has(ext)) continue;
          // At root level, only allow known fixture extensions
          if (!relPrefix && !FIXTURE_EXTS.has(ext)) continue;
          // In subdirs, still skip obvious code files
          if (relPrefix && ['.ts', '.tsx', '.js', '.jsx', '.py', '.sh', '.lock', '.toml', '.yaml', '.yml'].includes(ext)) continue;
          let size: number | null = null;
          try { size = statSync(fullPath).size; } catch { /* */ }
          const subdir = relPrefix.split('/')[0] || '.';
          fixtures.push({ name: entry.name, path: fullPath, size, subdir });
        }
      }
    } catch { /* skip unreadable dirs */ }
  };

  walk(testDataDir, '', 0);
  return fixtures;
}

// GET /api/qa/dependency-graph/apps — List all systems from scenario_index
router.get('/api/qa/dependency-graph/apps', async (_req, res) => {
  try {
    const index = readJSON(SCENARIO_INDEX_PATH);
    if (!index) return res.status(404).json({ error: 'scenario_index.json not found' });
    const scenarios = index.scenarios || index;
    const systems = new Set<string>();
    for (const entry of Object.values(scenarios) as any[]) {
      if (entry.system) systems.add(entry.system);
    }
    res.json({ apps: [...systems].sort(), timestamp: new Date().toISOString() });
  } catch (err: any) {
    console.error('[QA] Dependency apps error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/qa/dependency-graph/:appId — Build dependency graph for an app
router.get('/api/qa/dependency-graph/:appId', async (req, res) => {
  try {
    const appName = req.params.appId;
    const index = readJSON(SCENARIO_INDEX_PATH);
    if (!index) return res.status(404).json({ error: 'scenario_index.json not found' });

    const allScenarios = index.scenarios || index;

    // Filter by system
    const appScenarios: Record<string, any> = {};
    for (const [id, entry] of Object.entries(allScenarios) as [string, any][]) {
      if (entry.system === appName) {
        appScenarios[id] = entry;
      }
    }

    if (Object.keys(appScenarios).length === 0) {
      return res.status(404).json({ error: `No scenarios found for: ${appName}` });
    }

    // Load test results for status/score merge
    const resultPath = join(PATHS.orchestratorDir, 'test-results', `${appName}.json`);
    const testResults: Record<string, any> = {};
    const resultData = readJSON(resultPath);
    if (resultData) {
      for (const layer of Object.values(resultData.layers || {}) as any[]) {
        for (const s of (layer.scenarios || [])) {
          testResults[s.id] = s;
        }
      }
    }

    // Scan reports directly for status
    const reportEntries = scanReportsForApp(appName);

    // Scan Tier-1 test fixtures for this app
    const tier1Fixtures = scanTier1Fixtures(appName);

    // Build subdir → scenario label lookup for matching fixtures to scenarios
    // e.g. subdir "foto-analyse" matches scenario "engelmann.foto-analyse"
    const allLabels = Object.keys(appScenarios).map(id => id.replace(/^[^.]+\./, ''));

    // Process each scenario
    const nodes: any[] = [];
    const edges: any[] = [];
    const userMap: Record<string, { email: string; count: number; layers: Set<number> }> = {};
    const fileMap: Record<string, { name: string; path: string; size: number | null; scenarios: string[]; subdir: string }> = {};

    // Pre-populate fileMap from Tier-1 fixtures
    for (const fix of tier1Fixtures) {
      if (!fileMap[fix.path]) {
        fileMap[fix.path] = { name: fix.name, path: fix.path, size: fix.size, scenarios: [], subdir: fix.subdir };
      }
    }

    for (const [scenarioId, entry] of Object.entries(appScenarios) as [string, any][]) {
      const scenarioFile = join(SCENARIOS_BASE, entry.file);
      let scenarioData: any = {};
      try {
        if (existsSync(scenarioFile)) {
          scenarioData = JSON.parse(readFileSync(scenarioFile, 'utf-8'));
        }
      } catch { /* skip unreadable */ }

      const layer = scenarioData.layer ?? null;
      const deps = scenarioData.dependencies || {};

      // Extract credentials
      const creds = scenarioData.credentials || scenarioData.test_data?.credentials || {};
      const email = creds.test_user?.email || creds.email || null;

      // Read input_files from scenario (SSoT — no heuristic matching)
      const files: any[] = [];
      const label = scenarioId.replace(/^[^.]+\./, '');
      const inputFiles: any[] = scenarioData.input_files || [];

      for (const entry of inputFiles) {
        if (!entry?.path) continue;
        const fpath = entry.path;
        let size: number | null = null;
        try { size = statSync(fpath).size; } catch { /* file may not exist */ }
        const name = fpath.split('/').pop() || '';
        const subdir = fpath.replace(/.*\/test-data\/[^/]+\//, '').split('/')[0] || '.';

        files.push({ key: entry.key || subdir, name, path: fpath, size, purpose: entry.purpose || '' });

        // Register in fileMap for the files summary
        if (!fileMap[fpath]) {
          fileMap[fpath] = { name, path: fpath, size, scenarios: [], subdir };
        }
        if (!fileMap[fpath].scenarios.includes(scenarioId)) {
          fileMap[fpath].scenarios.push(scenarioId);
        }
      }

      // Extract dependencies
      const reqScenarios = (deps.requires_scenarios || []).map((r: any) => r.id || r);
      const reqArtifacts = deps.requires_artifacts || [];
      const skipSetup = deps.skip_setup_steps || false;
      const firstStep = deps.first_active_step || null;

      // Build edges
      for (const targetId of reqScenarios) {
        edges.push({ from: scenarioId, to: targetId, type: 'requires_scenario' });
      }
      for (const art of reqArtifacts) {
        edges.push({ from: scenarioId, to: null, type: 'requires_artifact', artifact_type: art.type });
      }

      // Merge test results + scanned reports
      const result = testResults[scenarioId] || {};
      const reportEntry = reportEntries[scenarioId];

      nodes.push({
        id: scenarioId,
        layer,
        label,
        status: result.status || reportEntry?.status || null,
        score: result.score ?? reportEntry?.score ?? null,
        coverage: result.coverage ?? null,
        duration: result.duration ?? null,
        email,
        files,
        requires_scenarios: reqScenarios,
        requires_artifacts: reqArtifacts,
        skip_setup: skipSetup,
        first_active_step: firstStep,
      });

      // Aggregate user map
      if (email) {
        if (!userMap[email]) userMap[email] = { email, count: 0, layers: new Set() };
        userMap[email].count++;
        if (layer !== null) userMap[email].layers.add(layer);
      }
    }

    // Build response
    const users = Object.values(userMap).map(u => ({
      email: u.email, count: u.count, layers: [...u.layers].sort()
    })).sort((a, b) => b.count - a.count);

    // Show ALL Tier-1 fixtures — assigned and unassigned
    const filesArr = Object.values(fileMap)
      .sort((a, b) => b.scenarios.length - a.scenarios.length || a.name.localeCompare(b.name));
    const withDeps = nodes.filter(n => n.requires_scenarios.length > 0 || n.requires_artifacts.length > 0).length;

    res.json({
      app: appName,
      generated_at: new Date().toISOString(),
      nodes,
      edges,
      users,
      files: filesArr,
      summary: {
        total: nodes.length,
        with_deps: withDeps,
        with_files: nodes.filter(n => n.files.length > 0).length,
        skip_setup: nodes.filter(n => n.skip_setup).length,
        unique_users: users.length,
        unique_files: filesArr.length,
      }
    });
  } catch (err: any) {
    console.error(`[QA] Dependency graph error for ${req.params.appId}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ========================================
// Change Impact / Staleness Detection
// ========================================
// Source: change_impact_analyzer.py → orchestrator/data/staleness/{appId}.json
// Detects which tests are "stale" (code changed since last test run)

const STALENESS_DIR = PATHS.stalenessDir;
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

// ========================================
// Product Docs (PRODUCT.md per app)
// ========================================

const PRODUCT_DOCS_DIR = '/root/projekte/werkingflow-production/apps';
const PRODUCT_APPS: Record<string, string> = {
  'werking-report': 'WerkING Report',
  'engelmann': 'Engelmann AI Hub',
  'werking-energy': 'WerkING Energy',
  'werking-safety': 'WerkING Safety',
  'acro-community': 'Acro Community',
};
// Apps outside the monorepo need custom paths
const PRODUCT_APP_DIRS: Record<string, string> = {
  'acro-community': '/root/projekte/support/acro-community',
};
function getProductDocPath(appId: string): string {
  const customDir = PRODUCT_APP_DIRS[appId];
  return customDir ? join(customDir, 'PRODUCT.md') : join(PRODUCT_DOCS_DIR, appId, 'PRODUCT.md');
}

/**
 * GET /api/qa/product-docs
 * List all apps with PRODUCT.md availability
 */
router.get('/api/qa/product-docs', async (_req, res) => {
  const apps = Object.entries(PRODUCT_APPS).map(([appId, displayName]) => {
    const docPath = getProductDocPath(appId);
    const exists = existsSync(docPath);
    let modified: string | null = null;
    let wordCount = 0;
    if (exists) {
      const s = statSync(docPath);
      modified = s.mtime.toISOString();
      const content = readFileSync(docPath, 'utf-8');
      wordCount = content.split(/\s+/).length;
    }
    return { appId, displayName, exists, modified, wordCount };
  });
  res.json({ apps, timestamp: new Date().toISOString() });
});

/**
 * GET /api/qa/product-docs/:appId
 * Get PRODUCT.md content for a specific app
 */
router.get('/api/qa/product-docs/:appId', async (req, res) => {
  const { appId } = req.params;
  const displayName = PRODUCT_APPS[appId];
  if (!displayName) {
    return res.status(404).json({ error: `Unknown app: ${appId}` });
  }

  const docPath = getProductDocPath(appId);
  if (!existsSync(docPath)) {
    return res.status(404).json({
      error: 'PRODUCT.md not found',
      appId,
      hint: `Run: python3 tools/generate_product_docs.py --app ${appId}`,
    });
  }

  const content = readFileSync(docPath, 'utf-8');
  const s = statSync(docPath);
  res.json({
    appId,
    displayName,
    content,
    modified: s.mtime.toISOString(),
    wordCount: content.split(/\s+/).length,
  });
});

/**
 * POST /api/qa/product-docs/:appId/regenerate
 * Full chain: Scanner (refresh enriched.json) → Generator (PRODUCT.md)
 * Runs as background process since AI-Bridge calls can take 60+ seconds.
 */
// Scanner uses different names for some apps
const SCANNER_APP_NAMES: Record<string, string> = {
  'werking-report': 'gutachten',
};
router.post('/api/qa/product-docs/:appId/regenerate', async (req, res) => {
  const { appId } = req.params;
  if (!PRODUCT_APPS[appId]) {
    return res.status(400).json({ error: `Unknown app: ${appId}. Valid: ${Object.keys(PRODUCT_APPS).join(', ')}` });
  }

  const scannerPath = join(UNIFIED_TESTER_ROOT, 'tools', 'data-ai-id-scanner.js');
  const generatorPath = join(UNIFIED_TESTER_ROOT, 'tools', 'generate_product_docs.py');
  if (!existsSync(generatorPath)) {
    return res.status(500).json({ error: 'generate_product_docs.py not found' });
  }

  try {
    const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
    const logFile = `/tmp/product-docs-${appId}-${timestamp}.log`;
    const scannerApp = SCANNER_APP_NAMES[appId] || appId;
    const enrichedOutput = `/root/projekte/orchestrator/data/${appId}/enriched.json`;

    // Full chain: 1) Scanner → enriched.json  2) Generator → PRODUCT.md
    let cmd: string;
    if (existsSync(scannerPath)) {
      cmd = `mkdir -p "$(dirname "${enrichedOutput}")" && ` +
        `node "${scannerPath}" --app "${scannerApp}" --enriched --output "${enrichedOutput}" && ` +
        `python3 "${generatorPath}" --app "${appId}"`;
    } else {
      // Scanner not found — run generator only (it has its own auto-refresh fallback)
      cmd = `python3 "${generatorPath}" --app "${appId}"`;
    }

    const bgCmd = `nohup bash -c '${cmd.replace(/'/g, "'\\''")}' > "${logFile}" 2>&1 & echo $!`;

    const pidOutput = execSync(bgCmd, {
      cwd: UNIFIED_TESTER_ROOT,
      timeout: 10000,
      shell: '/bin/bash',
    }).toString().trim();

    const pid = parseInt(pidOutput, 10);

    res.json({
      message: `Enriched Map + Product Doc Regeneration gestartet fuer ${PRODUCT_APPS[appId]}`,
      appId,
      pid: isNaN(pid) ? null : pid,
      logFile,
      command: cmd,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error(`[QA] Product doc regeneration error for ${appId}:`, err.message);
    res.status(500).json({ error: `Regeneration failed: ${err.message?.slice(0, 200)}` });
  }
});

// ========================================
// File Preview (PDF, MD, HTML, Images, Text)
// ========================================
// Returns file content for inline preview in the QA Dashboard sidebar.
// Text-based files (.md, .html, .txt, .json, .csv, .xml) → { type: 'text', content }
// Images (.png, .jpg, .gif, .webp, .svg, .bmp, .tiff) → { type: 'image', base64, mimeType }
// PDF (.pdf) → { type: 'pdf', base64 }
// Others → { type: 'unsupported' }

const TEXT_EXTENSIONS = new Set(['.md', '.html', '.htm', '.txt', '.json', '.csv', '.xml', '.yaml', '.yml', '.cfg', '.ini', '.env', '.rtf', '.css']);
const IMAGE_EXTENSIONS: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp', '.tiff': 'image/tiff',
};
const MAX_TEXT_SIZE = 2 * 1024 * 1024; // 2MB text limit
const MAX_BINARY_SIZE = 20 * 1024 * 1024; // 20MB binary limit

// Allowed base directories for file preview (security)
const PREVIEW_ALLOWED_ROOTS = [
  PATHS.unifiedTesterRoot,
  PATHS.testsRoot,
  join(PATHS.unifiedTesterRoot, 'test-data'),
  PATHS.projectsRoot,
];

router.get('/api/qa/file-preview', async (req, res) => {
  try {
    const filePath = req.query.path as string;
    if (!filePath) {
      return res.status(400).json({ error: 'path query parameter required' });
    }

    // Security: block path traversal
    if (filePath.includes('..')) {
      return res.status(400).json({ error: 'Invalid path: traversal not allowed' });
    }

    // Security: must be under one of the allowed roots
    const isAllowed = PREVIEW_ALLOWED_ROOTS.some(root => filePath.startsWith(root + '/') || filePath === root);
    if (!isAllowed) {
      return res.status(403).json({ error: 'Access denied — file not in allowed directories' });
    }

    if (!existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    const stat = statSync(filePath);
    if (!stat.isFile()) {
      return res.status(400).json({ error: 'Path is not a file' });
    }

    const fileName = filePath.split('/').pop() || '';
    const ext = fileName.includes('.') ? '.' + fileName.split('.').pop()!.toLowerCase() : '';

    // Text files
    if (TEXT_EXTENSIONS.has(ext)) {
      if (stat.size > MAX_TEXT_SIZE) {
        return res.status(413).json({ error: `File too large for text preview (${fmtBytesServer(stat.size)} > 2MB)` });
      }
      const content = readFileSync(filePath, 'utf-8');
      return res.json({
        type: 'text',
        ext,
        fileName,
        content,
        size: stat.size,
        modified: stat.mtime.toISOString(),
      });
    }

    // Images
    const mimeType = IMAGE_EXTENSIONS[ext];
    if (mimeType) {
      if (stat.size > MAX_BINARY_SIZE) {
        return res.status(413).json({ error: `Image too large (${fmtBytesServer(stat.size)} > 20MB)` });
      }
      const buffer = readFileSync(filePath);
      const base64 = buffer.toString('base64');
      return res.json({
        type: 'image',
        ext,
        fileName,
        mimeType,
        base64,
        size: stat.size,
        modified: stat.mtime.toISOString(),
      });
    }

    // PDF
    if (ext === '.pdf') {
      if (stat.size > MAX_BINARY_SIZE) {
        return res.status(413).json({ error: `PDF too large (${fmtBytesServer(stat.size)} > 20MB)` });
      }
      const buffer = readFileSync(filePath);
      const base64 = buffer.toString('base64');
      return res.json({
        type: 'pdf',
        ext,
        fileName,
        base64,
        size: stat.size,
        modified: stat.mtime.toISOString(),
      });
    }

    // Unsupported
    return res.json({
      type: 'unsupported',
      ext,
      fileName,
      size: stat.size,
      modified: stat.mtime.toISOString(),
      message: `Preview not available for ${ext} files`,
    });

  } catch (err: any) {
    console.error('[QA] File preview error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

function fmtBytesServer(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// GET /api/qa/arch-test/freshness — Age of arch-test-results per app (minutes)
router.get('/api/qa/arch-test/freshness', (_req, res) => {
  const result: Record<string, { age_minutes: number | null; timestamp: string | null; stale: boolean }> = {};
  const STALE_THRESHOLD_MINUTES = 60;

  for (const appId of APP_IDS) {
    const file = join(ARCH_TEST_RESULTS_DIR, `${appId}.json`);
    if (!existsSync(file)) {
      result[appId] = { age_minutes: null, timestamp: null, stale: true };
      continue;
    }
    try {
      const data = readJSON(file);
      const ts = data?.timestamp ? new Date(data.timestamp) : null;
      const age_minutes = ts ? Math.floor((Date.now() - ts.getTime()) / 60000) : null;
      result[appId] = {
        age_minutes,
        timestamp: ts?.toISOString() ?? null,
        stale: age_minutes === null || age_minutes > STALE_THRESHOLD_MINUTES,
      };
    } catch {
      result[appId] = { age_minutes: null, timestamp: null, stale: true };
    }
  }

  res.json({ apps: result, stale_threshold_minutes: STALE_THRESHOLD_MINUTES });
});

// ========================================
// Journey API — Screenshot Timeline for Playwright Tests
// ========================================

const SCREENSHOTS_DIR = join(UNIFIED_TESTER_ROOT, 'screenshots');

interface JourneyStep {
  nr: number;
  action: string;
  command: string;
  url: string | null;
  screenshot: string;
  timestamp: string;
}

interface JourneyFile {
  scenario: string;
  persona: string;
  startedAt: string;
  duration: number;
  totalSteps: number;
  steps: JourneyStep[];
}

// GET /api/qa/journey — List journeys with step data (screenshot paths only, no base64)
router.get('/api/qa/journey', (req, res) => {
  const scenarioFilter = req.query.scenario as string | undefined;
  const latestOnly = req.query.latest === 'true';

  if (!existsSync(SCREENSHOTS_DIR)) {
    return res.json({ journeys: [] });
  }

  try {
    const files = readdirSync(SCREENSHOTS_DIR)
      .filter(f => f.startsWith('journey_') && f.endsWith('.json'))
      .map(f => {
        const fullPath = join(SCREENSHOTS_DIR, f);
        const stat = statSync(fullPath);
        return { name: f, path: fullPath, mtime: stat.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime); // newest first

    let journeys: Array<JourneyFile & { fileName: string }> = [];

    for (const file of files) {
      const data = readJSON(file.path) as JourneyFile | null;
      if (!data || !data.steps || !Array.isArray(data.steps)) continue;

      if (scenarioFilter && data.scenario !== scenarioFilter && data.persona !== scenarioFilter) {
        continue;
      }

      journeys.push({ ...data, fileName: file.name });
    }

    if (latestOnly) {
      // Keep only the latest journey per scenario
      const seen = new Set<string>();
      journeys = journeys.filter(j => {
        const key = j.scenario || j.persona;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    // Limit to 20 journeys max to avoid huge responses
    journeys = journeys.slice(0, 20);

    // Truncate steps to essential fields, verify screenshot exists
    const result = journeys.map(j => ({
      scenario: j.scenario,
      persona: j.persona,
      startedAt: j.startedAt,
      duration: j.duration,
      totalSteps: j.totalSteps,
      fileName: j.fileName,
      steps: j.steps.map(s => ({
        nr: s.nr,
        action: s.action,
        command: (s.command || '').slice(0, 100),
        url: s.url,
        screenshotPath: s.screenshot,
        screenshotExists: existsSync(s.screenshot),
        timestamp: s.timestamp,
        ...(s.note ? { note: (s.note as string).slice(0, 300) } : {}),
      })),
    }));

    res.json({ journeys: result });
  } catch (err) {
    console.error('[QA] journey list error:', err);
    res.status(500).json({ error: 'Failed to read journey files' });
  }
});

// Track in-flight arch-test runs to avoid duplicate spawns
const archTestRunning = new Set<string>();

// POST /api/qa/arch-test/:appId/refresh — Spawn arch-test.py in background
router.post('/api/qa/arch-test/:appId/refresh', (req, res) => {
  const { appId } = req.params;

  if (!VALID_APP_IDS.has(appId)) {
    return res.status(400).json({ error: `Unknown app: ${appId}` });
  }

  if (archTestRunning.has(appId)) {
    return res.json({ queued: false, reason: 'already_running' });
  }

  const archTestScript = join(UNIFIED_TESTER_ROOT, 'arch-test.py');
  if (!existsSync(archTestScript)) {
    return res.status(500).json({ error: 'arch-test.py not found' });
  }

  archTestRunning.add(appId);

  const child = spawn(
    'python3',
    [archTestScript, '--app', appId, '--tier', '2'],
    { cwd: UNIFIED_TESTER_ROOT, detached: true, stdio: 'ignore' }
  );
  child.unref();

  child.on('close', () => archTestRunning.delete(appId));
  child.on('error', () => archTestRunning.delete(appId));

  console.log(`[QA] arch-test spawned for ${appId} (pid ${child.pid})`);
  res.json({ queued: true, app: appId, pid: child.pid });
});

// ========================================
// Knowledge / Wissen — curated test-system docs
// ========================================
// Renders the markdown documentation that ships with the unified-tester so
// product owners and developers can understand the test system without diving
// into the framework code itself.

interface KnowledgeDoc {
  id: string;
  title: string;
  category: 'Einstieg' | 'Layer-Modell' | 'Tests schreiben' | 'Status';
  description: string;
  /** filename inside UNIFIED_TESTER_ROOT */
  file: string;
}

const KNOWLEDGE_DOCS: KnowledgeDoc[] = [
  { id: 'readme', title: 'Überblick', category: 'Einstieg', description: 'Was ist der Unified Tester? Erste Orientierung.', file: 'README.md' },
  { id: 'strategy', title: 'Test-Strategie', category: 'Einstieg', description: 'Welche Tests laufen wann, warum, und wie hängen sie zusammen.', file: 'TEST_STRATEGY.md' },
  { id: 'background', title: 'Hintergrund-Tests', category: 'Einstieg', description: 'Wie laufen Tests im Hintergrund — automatisch, beim Push, geplant.', file: 'BACKGROUND-TESTING.md' },
  { id: 'arch-cascading', title: 'Layer-0 Architektur', category: 'Layer-Modell', description: 'Architektur-Tests (Schema, API, Frontend) als Pre-Flight-Check vor jedem Run.', file: 'ARCH-TEST-CASCADING.md' },
  { id: 'scenarios-overview', title: 'Szenarien-Übersicht', category: 'Layer-Modell', description: 'Welche Szenarien es gibt, was sie testen, wie sie strukturiert sind.', file: 'SCENARIO_OVERVIEW.md' },
  { id: 'scenarios-list', title: 'Szenarien (deutsch)', category: 'Layer-Modell', description: 'Alle Szenarien in deutscher Sprache erklärt.', file: 'SZENARIEN.md' },
  { id: 'schema', title: 'Szenario-Schema', category: 'Tests schreiben', description: 'Felder eines Test-Szenarios: Persona, Auftrag, Ziele, Qualitätsfrage.', file: 'SCENARIO_SCHEMA.md' },
  { id: 'personas', title: 'Test-Personas', category: 'Tests schreiben', description: 'Welche Perspektiven testen — vom Power-User bis zum Erstnutzer.', file: 'PERSONA_OVERVIEW.md' },
  { id: 'kunden-matrix', title: 'Kunden-Test-Matrix', category: 'Tests schreiben', description: 'Welche Test-Daten + Kunden-Szenarien wir verwenden.', file: 'KUNDEN-TEST-MATRIX.md' },
  { id: 'test-status', title: 'Aktueller Test-Status', category: 'Status', description: 'Welche Tests gerade grün sind, welche rot, welche fehlen.', file: 'TEST_STATUS.md' },
];

router.get('/api/qa/knowledge', (_req, res) => {
  // Filter to docs whose file actually exists on this server.
  const available = KNOWLEDGE_DOCS.filter(d => existsSync(join(UNIFIED_TESTER_ROOT, d.file)));
  res.json({
    available: available.length > 0,
    docs: available.map(({ id, title, category, description }) => ({ id, title, category, description })),
  });
});

router.get('/api/qa/knowledge/:id', (req, res) => {
  const doc = KNOWLEDGE_DOCS.find(d => d.id === req.params.id);
  if (!doc) {
    res.status(404).json({ error: 'Unknown doc' });
    return;
  }
  const path = join(UNIFIED_TESTER_ROOT, doc.file);
  if (!existsSync(path)) {
    res.status(404).json({ error: `File not found: ${doc.file}` });
    return;
  }
  const content = readFileSync(path, 'utf-8');
  res.json({ id: doc.id, title: doc.title, category: doc.category, description: doc.description, content });
});

// ========================================
// PO Scenarios — Product Owner Self-Service
// ========================================
// POs manage their own test scenarios without touching the unified-tester framework.
// Storage: <dataDir>/po-scenarios/{username}/{app}/{slug}.json
// Audit:   <dataDir>/po-scenarios/_audit.jsonl

const PO_SCENARIOS_DIR = PATHS.poScenariosDir;
const PO_RUNS_DIR = PATHS.poRunsDir;
const PO_AUDIT_LOG = join(PO_SCENARIOS_DIR, '_audit.jsonl');

/** Determine scope for the current user. isAdmin=true → all apps visible. */
function getUserScope(req: any): { apps: string[]; isAdmin: boolean } {
  if (!isAuthEnabled()) return { apps: [], isAdmin: true };
  const sub = req.user?.sub;
  if (!sub) return { apps: [], isAdmin: false };
  const user = findUser(sub);
  if (!user) return { apps: [], isAdmin: false };
  const po = user.productOwnerOf;
  if (po === '*') return { apps: [], isAdmin: true };
  return { apps: Array.isArray(po) ? po : [], isAdmin: false };
}

/** Append one line to the audit log (best-effort, never throws). */
function auditLog(entry: { user: string; action: string; scenarioId: string; app: string }) {
  try {
    mkdirSync(PO_SCENARIOS_DIR, { recursive: true });
    appendFileSync(PO_AUDIT_LOG, JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n', 'utf-8');
  } catch { /* never block main path */ }
}

/** kebab-case slug from free text title. */
function slugify(title: string): string {
  return title.toLowerCase()
    .replace(/[äÄ]/g, 'ae').replace(/[öÖ]/g, 'oe').replace(/[üÜ]/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'scenario';
}

/** Generate a unique slug (appends -2, -3 … when collision). */
function uniqueSlug(base: string, username: string, app: string): string {
  const dir = join(PO_SCENARIOS_DIR, username, app);
  let slug = base;
  let n = 2;
  while (existsSync(join(dir, `${slug}.json`))) slug = `${base}-${n++}`;
  return slug;
}

interface PoScenario {
  id: string;
  system: string;
  name: string;
  description: string;
  layer: 4;
  test_type: 'mental-model-workflow';
  tester: { perspektive: string; erfahrung: string };
  auftrag: string;
  ziele: string[];
  qualitaetsfrage: string;
  /** Where the tester navigates. Must be reachable from inside the docker network
   * (use `host.docker.internal:<port>` for host apps, or full http(s)://host). */
  target_url: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  archived: boolean;
  last_run_at?: string;
  last_run_id?: string;
}

/** Validate PO scenario body. Returns error string or null. */
function validatePoScenario(body: any, scope: { apps: string[]; isAdmin: boolean }): string | null {
  const required = ['system', 'name', 'description', 'tester', 'auftrag', 'ziele', 'qualitaetsfrage', 'target_url'] as const;
  for (const f of required) {
    if (!body[f]) return `Missing required field: ${f}`;
  }
  if (!Array.isArray(body.ziele) || body.ziele.length < 1) return 'ziele must be a non-empty array';
  if (!body.tester?.perspektive) return 'tester.perspektive is required';
  if (!scope.isAdmin && !scope.apps.includes(body.system)) return `App "${body.system}" is not in your scope`;
  if (typeof body.target_url !== 'string' || !/^https?:\/\//i.test(body.target_url)) {
    return 'target_url must start with http:// or https://';
  }
  return null;
}

/** Load all PO scenarios for a username, optionally filtered by app. */
function loadPoScenarios(username: string, scopeApps: string[], isAdmin: boolean): PoScenario[] {
  const scenarios: PoScenario[] = [];
  const baseDir = join(PO_SCENARIOS_DIR, username);
  if (!existsSync(baseDir)) return scenarios;
  for (const app of readdirSync(baseDir)) {
    if (!isAdmin && !scopeApps.includes(app)) continue;
    const appDir = join(baseDir, app);
    try {
      if (!statSync(appDir).isDirectory()) continue;
      for (const file of readdirSync(appDir)) {
        if (!file.endsWith('.json')) continue;
        const data = readJSON(join(appDir, file));
        if (data) scenarios.push(data as PoScenario);
      }
    } catch { /* skip unreadable dirs */ }
  }
  return scenarios;
}

// GET /api/qa/po-scenarios — list owned + read-only team scenarios
router.get('/api/qa/po-scenarios', requireAuth, (req, res) => {
  const scope = getUserScope(req);
  const username = req.user?.sub ?? 'admin';

  // Own PO scenarios
  const owned = loadPoScenarios(username, scope.apps, scope.isAdmin);

  // Team scenarios (read-only) — from unified-tester, filtered by scope
  let teamReadOnly: Array<{ id: string; app: string; name: string; status: string }> = [];
  try {
    const all = discoverScenarios();
    teamReadOnly = (scope.isAdmin ? all : all.filter(s => scope.apps.includes(s.app)))
      .map(s => ({ id: s.id, app: s.app, name: s.name, status: s.status }));
  } catch { /* */ }

  res.json({ owned, teamReadOnly });
});

// POST /api/qa/po-scenarios — create new PO scenario
router.post('/api/qa/po-scenarios', requireAuth, (req, res) => {
  const scope = getUserScope(req);
  const username = req.user?.sub ?? 'admin';

  const err = validatePoScenario(req.body, scope);
  if (err) return res.status(400).json({ error: err });

  const { system, name, description, tester, auftrag, ziele, qualitaetsfrage, target_url } = req.body;
  const base = slugify(name);
  const slug = uniqueSlug(base, username, system);
  const now = new Date().toISOString();

  const scenario: PoScenario = {
    id: slug,
    system,
    name,
    description,
    layer: 4,
    test_type: 'mental-model-workflow',
    tester: { perspektive: tester.perspektive, erfahrung: tester.erfahrung ?? '' },
    auftrag,
    ziele,
    qualitaetsfrage,
    target_url,
    created_by: username,
    created_at: now,
    updated_at: now,
    archived: false,
  };

  const dir = join(PO_SCENARIOS_DIR, username, system);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${slug}.json`), JSON.stringify(scenario, null, 2), 'utf-8');
  auditLog({ user: username, action: 'created', scenarioId: slug, app: system });

  res.status(201).json(scenario);
});

// PUT /api/qa/po-scenarios/:id — update own scenario
router.put('/api/qa/po-scenarios/:id', requireAuth, (req, res) => {
  const scope = getUserScope(req);
  const username = req.user?.sub ?? 'admin';
  const id = req.params.id;

  const err = validatePoScenario(req.body, scope);
  if (err) return res.status(400).json({ error: err });

  const { system, name, description, tester, auftrag, ziele, qualitaetsfrage, target_url } = req.body;
  const filePath = join(PO_SCENARIOS_DIR, username, system, `${id}.json`);
  if (!existsSync(filePath)) return res.status(404).json({ error: 'Scenario not found or not owned by you' });

  const existing = readJSON(filePath) as PoScenario;
  if (!existing) return res.status(500).json({ error: 'Failed to read existing scenario' });

  const updated: PoScenario = {
    ...existing,
    name,
    description,
    tester: { perspektive: tester.perspektive, erfahrung: tester.erfahrung ?? '' },
    auftrag,
    ziele,
    qualitaetsfrage,
    target_url,
    updated_at: new Date().toISOString(),
  };

  writeFileSync(filePath, JSON.stringify(updated, null, 2), 'utf-8');
  auditLog({ user: username, action: 'updated', scenarioId: id, app: system });

  res.json(updated);
});

// POST /api/qa/po-scenarios/:id/run — enqueue a test run for own scenario
router.post('/api/qa/po-scenarios/:id/run', requireAuth, async (req, res) => {
  const username = req.user?.sub ?? 'admin';
  const id = req.params.id;
  const app = req.body?.system as string;

  if (!app) return res.status(400).json({ error: 'system required in body' });

  const filePath = join(PO_SCENARIOS_DIR, username, app, `${id}.json`);
  if (!existsSync(filePath)) return res.status(404).json({ error: 'Scenario not found or not owned by you' });

  const scenario = readJSON(filePath) as PoScenario;
  if (!scenario) return res.status(500).json({ error: 'Failed to read scenario' });
  if (scenario.archived) return res.status(409).json({ error: 'Cannot run archived scenario' });
  if (!scenario.target_url) return res.status(400).json({ error: 'Scenario has no target_url — edit and add one' });

  const { enqueueRun } = await import('../lib/po-test-runner.js');
  const rec = enqueueRun({
    scenarioId: id,
    app,
    user: username,
    targetUrl: scenario.target_url,
    scenario,
  });

  // Bookkeeping on the scenario itself: track latest run
  const updated: PoScenario = {
    ...scenario,
    last_run_at: rec.enqueuedAt,
    last_run_id: rec.runId,
    updated_at: new Date().toISOString(),
  };
  writeFileSync(filePath, JSON.stringify(updated, null, 2), 'utf-8');
  auditLog({ user: username, action: 'run-enqueued', scenarioId: id, app });

  res.status(202).json(rec);
});

// GET /api/qa/po-scenarios/:id/runs?system=<app> — list runs for own scenario
router.get('/api/qa/po-scenarios/:id/runs', requireAuth, async (req, res) => {
  const username = req.user?.sub ?? 'admin';
  const id = req.params.id;
  const app = String(req.query.system || '');

  if (!app) return res.status(400).json({ error: 'system query param required' });

  const filePath = join(PO_SCENARIOS_DIR, username, app, `${id}.json`);
  if (!existsSync(filePath)) return res.status(404).json({ error: 'Scenario not found or not owned by you' });

  const { listRuns, getQueueState } = await import('../lib/po-test-runner.js');
  const runs = listRuns(username, id);
  res.json({ runs, queue: getQueueState() });
});

// GET /api/qa/po-scenarios/:id/runs/:runId?system=<app> — single run detail
router.get('/api/qa/po-scenarios/:id/runs/:runId', requireAuth, async (req, res) => {
  const username = req.user?.sub ?? 'admin';
  const id = req.params.id;
  const runId = req.params.runId;
  const app = String(req.query.system || '');

  if (!app) return res.status(400).json({ error: 'system query param required' });

  const filePath = join(PO_SCENARIOS_DIR, username, app, `${id}.json`);
  if (!existsSync(filePath)) return res.status(404).json({ error: 'Scenario not found or not owned by you' });

  const { readRun } = await import('../lib/po-test-runner.js');
  const rec = readRun(username, id, runId);
  if (!rec) return res.status(404).json({ error: 'Run not found' });
  res.json(rec);
});

// GET /api/qa/po-scenarios/:id/runs/:runId/report/:filename?system=<app>
// Streams a report artifact (screenshot, page-text, result.json, etc.). Owned by the user.
router.get('/api/qa/po-scenarios/:id/runs/:runId/report/:filename', requireAuth, (req, res) => {
  const username = req.user?.sub ?? 'admin';
  const id = req.params.id;
  const runId = req.params.runId;
  const filename = req.params.filename;
  const app = String(req.query.system || '');

  if (!app) return res.status(400).json({ error: 'system query param required' });
  // Defensive: filename must be a plain basename, never traverse paths.
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    return res.status(400).json({ error: 'invalid filename' });
  }

  const scenarioFile = join(PO_SCENARIOS_DIR, username, app, `${id}.json`);
  if (!existsSync(scenarioFile)) return res.status(404).json({ error: 'Scenario not found or not owned by you' });

  const reportPath = join(PO_RUNS_DIR, username, id, runId, filename);
  if (!existsSync(reportPath)) return res.status(404).json({ error: 'Report file not found' });

  const ext = filename.split('.').pop()?.toLowerCase();
  const mime: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    json: 'application/json',
    txt: 'text/plain; charset=utf-8',
    log: 'text/plain; charset=utf-8',
    html: 'text/html; charset=utf-8',
  };
  res.setHeader('Content-Type', mime[ext ?? ''] ?? 'application/octet-stream');
  res.sendFile(reportPath);
});

// POST /api/qa/po-scenarios/:id/archive — soft-delete (no DELETE)
router.post('/api/qa/po-scenarios/:id/archive', requireAuth, (req, res) => {
  const username = req.user?.sub ?? 'admin';
  const id = req.params.id;
  const app = req.body?.system as string;

  if (!app) return res.status(400).json({ error: 'system required in body' });

  const filePath = join(PO_SCENARIOS_DIR, username, app, `${id}.json`);
  if (!existsSync(filePath)) return res.status(404).json({ error: 'Scenario not found or not owned by you' });

  const existing = readJSON(filePath) as PoScenario;
  if (!existing) return res.status(500).json({ error: 'Failed to read scenario' });

  const archived = { ...existing, archived: true, updated_at: new Date().toISOString() };
  writeFileSync(filePath, JSON.stringify(archived, null, 2), 'utf-8');
  auditLog({ user: username, action: 'archived', scenarioId: id, app });

  res.json(archived);
});

export default router;
