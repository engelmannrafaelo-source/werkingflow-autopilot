/**
 * QA Dashboard — Backend-Pyramide
 *
 * Einheitliche Pyramid-Ansicht fuer alle Backend-Workflows. Drei Kategorien:
 *
 *   platform   — Partner hostet mehrere konfigurierbare Workflows
 *                (Engelmann: 5 Workflows, jeder mit workflow.manifest.yaml)
 *   standalone — Die App IST der Workflow. Eigenes FE + BE.
 *                (werking-energy, werking-safety)
 *   external   — Standalone-Pipeline ohne Web-App.
 *                (RLB Campus)
 *
 * Discovery-SSoT: pipeline-scanner (PIPELINE_CONFIGS).
 * Ergaenzung: workflow.manifest.yaml fuer platform-Workflows.
 *
 * 5-Layer-Pyramide pro Workflow (category-adaptive L0):
 *   L0 Contracts       — category-adaptive:
 *                         platform   → manifest.yaml validity + pipeline-scanner
 *                         standalone → pipeline-scanner + entrypoint + reqs
 *                         external   → pipeline-scanner
 *   L1 Unit/pytest     — pytest-Dateien im Backend (discovery)
 *   L2 Job-Lifecycle   — Stars 1-4 (strukturell, not_run bis Runner)
 *   L3 Phase-Execution — Stars 5-7
 *   L4 Quality/Persona — Stars 8-10
 *
 * GET /api/qa/backend-pyramid              → Alle Apps, alle Workflows
 * GET /api/qa/backend-pyramid/:appId       → Eine App
 */

import { Router, Request, Response } from 'express';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, basename, dirname } from 'path';
import { load as yamlLoad } from 'js-yaml';
import { PATHS } from '../config/paths.js';
import { scanAllPipelines, type PipelineScanResult } from '../pipeline-scanner.js';

const router = Router();

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

type Category = 'platform' | 'standalone' | 'external';

interface L0Check {
  id: string;
  label: string;
  status: 'PASS' | 'FAIL' | 'WARN';
  detail?: string;
}

interface PyramidLayer {
  id: number;
  name: string;
  description: string;
  totalTests: number;
  passed: number;
  failed: number;
  pending: number;
  avgScore: number;
  status: 'passed' | 'failed' | 'partial' | 'pending' | 'not_run' | 'empty';
  tests: Array<{ id: string; label: string; status: string; detail?: string }>;
}

interface WorkflowEntry {
  id: string;              // pipeline-scanner id, e.g. "engelmann-dokument" or "energy"
  workflowId: string;      // short id shown in UI, e.g. "dokument-erstellen" or "energy"
  name: string;            // display name from manifest or pipeline
  appId: string;           // grouping key for the tab (engelmann, werking-energy, ...)
  category: Category;
  manifestPath: string | null;
  pipelineBasePath: string;
  engine: string | null;
  phaseCount: number;
  validationIssues: number;
  layers: PyramidLayer[];
}

interface AppEntry {
  appId: string;
  displayName: string;
  category: Category;
  workflows: WorkflowEntry[];
  summary: { totalWorkflows: number; l0Passed: number; l0Partial: number; l0Failed: number };
}

// ────────────────────────────────────────────────────────────────────────────
// App-Display-Metadata (keine Discovery — nur Label + Kategorie)
// ────────────────────────────────────────────────────────────────────────────

const APP_META: Record<string, { displayName: string; category: Category }> = {
  'engelmann': { displayName: 'Engelmann', category: 'platform' },
  'werking-energy': { displayName: 'WerkING Energy', category: 'standalone' },
  'werking-safety': { displayName: 'WerkING Safety', category: 'standalone' },
  'rlb-campus': { displayName: 'RLB Campus', category: 'external' },
};

// Map pipeline-scanner id → { appId, workflowId }
function mapPipelineToApp(pipelineId: string): { appId: string; workflowId: string } {
  if (pipelineId.startsWith('engelmann-')) {
    return { appId: 'engelmann', workflowId: pipelineId.replace(/^engelmann-/, '') };
  }
  if (pipelineId === 'energy') return { appId: 'werking-energy', workflowId: 'energy' };
  if (pipelineId === 'safety') return { appId: 'werking-safety', workflowId: 'safety' };
  if (pipelineId === 'rlb') return { appId: 'rlb-campus', workflowId: 'rlb' };
  return { appId: pipelineId, workflowId: pipelineId };
}

// Partner-Workflow directory for Engelmann — we look for workflow.manifest.yaml one level up from pipeline
function findManifestForPipeline(pipelineBasePath: string): string | null {
  // pipeline-scanner basePath points at .../pipeline — manifest is in parent dir
  const parent = dirname(pipelineBasePath);
  const manifest = join(parent, 'workflow.manifest.yaml');
  return existsSync(manifest) ? manifest : null;
}

// ────────────────────────────────────────────────────────────────────────────
// L0 — Category-adaptive Contract Validation
// ────────────────────────────────────────────────────────────────────────────

function validateManifest(manifestPath: string): L0Check[] {
  const checks: L0Check[] = [];
  let manifest: any = null;
  try {
    manifest = yamlLoad(readFileSync(manifestPath, 'utf-8'));
    checks.push({ id: 'yaml_parse', label: 'manifest YAML parses', status: 'PASS' });
  } catch (err) {
    checks.push({ id: 'yaml_parse', label: 'manifest YAML parses', status: 'FAIL',
      detail: err instanceof Error ? err.message : String(err) });
    return checks;
  }

  const check = (id: string, label: string, pass: boolean, detail?: string) =>
    checks.push({ id, label, status: pass ? 'PASS' : 'FAIL', detail: pass ? undefined : detail });

  check('manifest_id', 'manifest.id present', typeof manifest?.id === 'string' && manifest.id.length > 0);
  check('manifest_name', 'manifest.name present', typeof manifest?.name === 'string' && manifest.name.length > 0);
  check('manifest_version', 'manifest.version present', typeof manifest?.version === 'string' && manifest.version.length > 0);
  check('manifest_engine', 'manifest.engine valid', ['railway', 'vercel'].includes(manifest?.engine),
    `got: ${JSON.stringify(manifest?.engine)}`);

  const deps = manifest?.dependencies?.required;
  check('manifest_deps', 'dependencies.required is array', Array.isArray(deps),
    `got: ${typeof deps}`);

  const inputs = manifest?.inputs;
  check('manifest_inputs', 'inputs non-empty', Array.isArray(inputs) && inputs.length > 0,
    `count: ${Array.isArray(inputs) ? inputs.length : 'n/a'}`);

  const outputs = manifest?.outputs;
  check('manifest_outputs', 'outputs non-empty', Array.isArray(outputs) && outputs.length > 0,
    `count: ${Array.isArray(outputs) ? outputs.length : 'n/a'}`);

  return checks;
}

function validateFromPipelineScan(scan: PipelineScanResult): L0Check[] {
  const checks: L0Check[] = [];

  checks.push({
    id: 'pipeline_basepath',
    label: 'pipeline basePath exists',
    status: existsSync(scan.basePath) ? 'PASS' : 'FAIL',
    detail: existsSync(scan.basePath) ? undefined : scan.basePath,
  });

  checks.push({
    id: 'pipeline_phases',
    label: 'phases present',
    status: scan.phases.length > 0 ? 'PASS' : 'FAIL',
    detail: `count: ${scan.phases.length}`,
  });

  const totalSteps = scan.phases.reduce((s, p) => s + p.steps.length, 0);
  checks.push({
    id: 'pipeline_steps',
    label: 'phase-steps present',
    status: totalSteps > 0 ? 'PASS' : 'FAIL',
    detail: `count: ${totalSteps}`,
  });

  // Validation-issues aus scanner werden als WARN/FAIL propagiert
  const scanErrors = scan.validationIssues.filter(i => i.level === 'error');
  const scanWarnings = scan.validationIssues.filter(i => i.level === 'warning');

  checks.push({
    id: 'pipeline_no_errors',
    label: 'no pipeline-scanner errors',
    status: scanErrors.length === 0 ? 'PASS' : 'FAIL',
    detail: scanErrors.length > 0 ? `${scanErrors.length} errors` : undefined,
  });

  if (scanWarnings.length > 0) {
    const sample = scanWarnings.slice(0, 3).map(w => w.message).join(' | ');
    checks.push({
      id: 'pipeline_warnings',
      label: `${scanWarnings.length} scanner warning${scanWarnings.length > 1 ? 's' : ''}`,
      status: 'WARN',
      detail: scanWarnings.length > 3 ? `${sample} … (+${scanWarnings.length - 3} more)` : sample,
    });
  }

  return checks;
}

function findBackendRoot(pipelineBasePath: string): string {
  // Walk up from pipeline basePath to find the nearest dir with requirements.txt
  // (pipeline-scanner basePath is e.g. apps/werking-energy/backend/pipeline)
  let cur = pipelineBasePath;
  for (let i = 0; i < 4; i++) {
    if (existsSync(join(cur, 'requirements.txt')) || existsSync(join(cur, 'pyproject.toml'))) return cur;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return pipelineBasePath;
}

function findFastAPIEntrypoint(backendRoot: string): string | null {
  // Check root first, then common subdirs (api/, app/, src/)
  const candidates: string[] = ['main.py', 'app.py'];
  for (const c of candidates) {
    if (existsSync(join(backendRoot, c))) return c;
  }
  for (const sub of ['api', 'app', 'src']) {
    for (const c of candidates) {
      const rel = join(sub, c);
      if (existsSync(join(backendRoot, rel))) return rel;
    }
  }
  return null;
}

function validateStandaloneInfra(pipelineBasePath: string): L0Check[] {
  const checks: L0Check[] = [];
  const backendRoot = findBackendRoot(pipelineBasePath);

  const hasReqs = existsSync(join(backendRoot, 'requirements.txt')) || existsSync(join(backendRoot, 'pyproject.toml'));
  checks.push({
    id: 'infra_requirements',
    label: 'requirements.txt or pyproject.toml',
    status: hasReqs ? 'PASS' : 'FAIL',
    detail: hasReqs ? undefined : `not found in ${backendRoot}`,
  });

  const hasRailway = existsSync(join(backendRoot, 'railway.toml'));
  const hasDockerfile = existsSync(join(backendRoot, 'Dockerfile'));
  checks.push({
    id: 'infra_deploy',
    label: 'deploy config (railway.toml or Dockerfile)',
    status: (hasRailway || hasDockerfile) ? 'PASS' : 'WARN',
    detail: hasRailway && hasDockerfile ? 'railway.toml + Dockerfile'
      : hasRailway ? 'railway.toml'
      : hasDockerfile ? 'Dockerfile'
      : 'neither found',
  });

  const entrypoint = findFastAPIEntrypoint(backendRoot);
  checks.push({
    id: 'infra_entrypoint',
    label: 'FastAPI entrypoint',
    status: entrypoint ? 'PASS' : 'FAIL',
    detail: entrypoint ?? 'no main.py/app.py in root, api/, app/, or src/',
  });

  // Health-check path in railway.toml (informational — Energy/Safety both expose /health)
  if (hasRailway) {
    try {
      const railwayToml = readFileSync(join(backendRoot, 'railway.toml'), 'utf-8');
      const healthMatch = railwayToml.match(/healthcheckPath\s*=\s*"([^"]+)"/);
      if (healthMatch) {
        checks.push({
          id: 'infra_healthcheck',
          label: 'healthcheckPath configured',
          status: 'PASS',
          detail: healthMatch[1],
        });
      }
    } catch { /* noop */ }
  }

  return checks;
}

// ────────────────────────────────────────────────────────────────────────────
// L1 — pytest test-file discovery
// ────────────────────────────────────────────────────────────────────────────

function findTestsDir(pipelineBasePath: string): string | null {
  // Walk up from pipelineBasePath looking for tests/ directory
  let cur = pipelineBasePath;
  for (let i = 0; i < 4; i++) {
    const testsDir = join(cur, 'tests');
    if (existsSync(testsDir)) return testsDir;
    const testDirSingular = join(cur, 'test');
    if (existsSync(testDirSingular)) return testDirSingular;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

function discoverPytestFiles(testsDir: string | null): string[] {
  if (!testsDir || !existsSync(testsDir)) return [];
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 3) return;
    try {
      for (const entry of readdirSync(dir)) {
        if (entry === '__pycache__' || entry === 'fixtures' || entry === 'venv' || entry.startsWith('.')) continue;
        const full = join(dir, entry);
        try {
          const st = statSync(full);
          if (st.isDirectory()) { walk(full, depth + 1); continue; }
          if (entry.startsWith('test_') && entry.endsWith('.py')) out.push(full);
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  };
  walk(testsDir, 0);
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// L2-L4 — 10-Stars strukturelle Platzhalter
// ────────────────────────────────────────────────────────────────────────────

const STAR_LAYERS = {
  2: { name: 'Job-Lifecycle', description: 'Stars 1-4: Health → Auth → Job-Create → Job-Status', stars: [
    { id: 'star_01_health', label: '⭐ 1 Health-Check' },
    { id: 'star_02_auth', label: '⭐ 2 Auth' },
    { id: 'star_03_job_create', label: '⭐ 3 Job-Create' },
    { id: 'star_04_job_status', label: '⭐ 4 Job-Status' },
  ]},
  3: { name: 'Phase-Execution', description: 'Stars 5-7: Phase-1 → All-Phases → Outputs', stars: [
    { id: 'star_05_phase_1', label: '⭐ 5 Phase-1' },
    { id: 'star_06_all_phases', label: '⭐ 6 All-Phases' },
    { id: 'star_07_outputs', label: '⭐ 7 Outputs' },
  ]},
  4: { name: 'Quality/Persona', description: 'Stars 8-10: Quality → Persona → Production', stars: [
    { id: 'star_08_quality', label: '⭐ 8 Quality' },
    { id: 'star_09_persona', label: '⭐ 9 Persona' },
    { id: 'star_10_production', label: '⭐ 10 Production' },
  ]},
};

function makeStarLayer(layerId: 2 | 3 | 4): PyramidLayer {
  const meta = STAR_LAYERS[layerId];
  return {
    id: layerId,
    name: meta.name,
    description: meta.description,
    totalTests: meta.stars.length,
    passed: 0, failed: 0, pending: meta.stars.length,
    avgScore: 0,
    status: 'not_run',
    tests: meta.stars.map(s => ({ id: s.id, label: s.label, status: 'NOT_RUN' })),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Workflow-Entry-Builder
// ────────────────────────────────────────────────────────────────────────────

function buildWorkflow(scan: PipelineScanResult): WorkflowEntry {
  const { appId, workflowId } = mapPipelineToApp(scan.id);
  const meta = APP_META[appId];
  const category: Category = meta?.category ?? 'external';

  // Manifest lookup is PLATFORM-only. Standalone apps may have a file called
  // workflow.manifest.yaml too (Energy does), but it uses a DIFFERENT schema
  // and must NOT be validated against the Engelmann partner-workflow contract.
  const manifestPath = category === 'platform'
    ? findManifestForPipeline(scan.basePath)
    : null;

  // Load manifest for display-metadata (name, engine) — platform only
  let manifestData: any = null;
  if (manifestPath) {
    try { manifestData = yamlLoad(readFileSync(manifestPath, 'utf-8')); } catch { /* noop */ }
  }

  // L0 — strictly gated by category
  const l0Checks: L0Check[] = [];
  let l0Description: string;
  if (category === 'platform') {
    // Engelmann partner-workflow contract: manifest + pipeline structure
    if (manifestPath) l0Checks.push(...validateManifest(manifestPath));
    l0Checks.push(...validateFromPipelineScan(scan));
    l0Description = 'Partner-Workflow Contract (manifest.yaml + pipeline structure)';
  } else if (category === 'standalone') {
    // Standalone apps: pipeline + FastAPI infra (no Engelmann manifest check)
    l0Checks.push(...validateFromPipelineScan(scan));
    l0Checks.push(...validateStandaloneInfra(scan.basePath));
    l0Description = 'Standalone-Service Contract (pipeline + FastAPI infra)';
  } else {
    // External: minimal pipeline structure only
    l0Checks.push(...validateFromPipelineScan(scan));
    l0Description = 'External-Pipeline Contract (pipeline structure only)';
  }

  const l0Passed = l0Checks.filter(c => c.status === 'PASS').length;
  const l0Failed = l0Checks.filter(c => c.status === 'FAIL').length;
  const l0Warn = l0Checks.filter(c => c.status === 'WARN').length;
  const l0: PyramidLayer = {
    id: 0,
    name: 'Contracts',
    description: l0Description,
    totalTests: l0Checks.length,
    passed: l0Passed, failed: l0Failed, pending: l0Warn,
    avgScore: l0Checks.length > 0 ? (l0Passed / l0Checks.length) * 10 : 0,
    status: l0Checks.length === 0 ? 'empty'
      : l0Failed > 0 ? 'failed'
      : l0Warn > 0 ? 'partial'
      : 'passed',
    tests: l0Checks.map(c => ({ id: c.id, label: c.label, status: c.status, detail: c.detail })),
  };

  // L1 pytest
  const testsDir = findTestsDir(scan.basePath);
  const pytestFiles = discoverPytestFiles(testsDir);
  const l1Tests = pytestFiles.map(f => ({
    id: `pytest:${basename(f)}`,
    label: basename(f),
    status: 'DISCOVERED',
    detail: f.replace(PATHS.projectsRoot + '/', ''),
  }));
  const l1: PyramidLayer = {
    id: 1,
    name: 'Unit/pytest',
    description: `pytest-Dateien im Backend (discovered, not executed)${testsDir ? ` — ${testsDir.replace(PATHS.projectsRoot + '/', '')}` : ''}`,
    totalTests: l1Tests.length,
    passed: 0, failed: 0, pending: l1Tests.length,
    avgScore: 0,
    status: l1Tests.length === 0 ? 'empty' : 'not_run',
    tests: l1Tests,
  };

  const l2 = makeStarLayer(2);
  const l3 = makeStarLayer(3);
  const l4 = makeStarLayer(4);

  const displayName = manifestData?.name
    ?? scan.name.replace(/^Engelmann:\s*/, '')
    ?? workflowId;

  return {
    id: scan.id,
    workflowId,
    name: displayName,
    appId,
    category,
    manifestPath,
    pipelineBasePath: scan.basePath,
    engine: manifestData?.engine ?? (category === 'standalone' ? 'railway' : null),
    phaseCount: scan.phases.length,
    validationIssues: scan.validationIssues.length,
    layers: [l0, l1, l2, l3, l4],
  };
}

// ────────────────────────────────────────────────────────────────────────────
// App-level aggregation
// ────────────────────────────────────────────────────────────────────────────

function buildAllApps(): AppEntry[] {
  const scans = scanAllPipelines();
  const workflows = scans.map(buildWorkflow);

  // Group by appId
  const byApp = new Map<string, WorkflowEntry[]>();
  for (const wf of workflows) {
    if (!byApp.has(wf.appId)) byApp.set(wf.appId, []);
    byApp.get(wf.appId)!.push(wf);
  }

  // Stable order: platform first (engelmann), then standalones, then external
  const categoryOrder: Category[] = ['platform', 'standalone', 'external'];
  const apps: AppEntry[] = [];
  for (const cat of categoryOrder) {
    for (const [appId, wfs] of byApp.entries()) {
      const meta = APP_META[appId];
      if (meta?.category !== cat) continue;
      const l0Passed = wfs.filter(w => w.layers[0].status === 'passed').length;
      const l0Partial = wfs.filter(w => w.layers[0].status === 'partial').length;
      const l0Failed = wfs.filter(w => w.layers[0].status === 'failed').length;
      apps.push({
        appId,
        displayName: meta.displayName,
        category: meta.category,
        workflows: wfs.sort((a, b) => a.workflowId.localeCompare(b.workflowId)),
        summary: { totalWorkflows: wfs.length, l0Passed, l0Partial, l0Failed },
      });
    }
  }
  return apps;
}

// ────────────────────────────────────────────────────────────────────────────
// Routes
// ────────────────────────────────────────────────────────────────────────────

router.get('/api/qa/backend-pyramid', (_req: Request, res: Response) => {
  const apps = buildAllApps();
  res.json({ apps, timestamp: new Date().toISOString() });
});

router.get('/api/qa/backend-pyramid/:appId', (req: Request, res: Response) => {
  const app = buildAllApps().find(a => a.appId === req.params.appId);
  if (!app) {
    res.status(404).json({ error: `App "${req.params.appId}" not found` });
    return;
  }
  res.json(app);
});

export default router;
