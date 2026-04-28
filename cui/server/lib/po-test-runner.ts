/**
 * PO Test Runner — orchestrates docker-based test execution for PO scenarios.
 *
 * Boundary: this module is the ONLY place that knows how to spawn the
 * tester-po container. Routes call enqueue() and read run records via the
 * filesystem; they never touch docker directly.
 *
 * Concurrency: max 1 active run, others wait in FIFO queue.
 * Timeouts: 15-min soft (status flips to 'timeout-warning'), 30-min hard SIGKILL.
 * Storage: <poRunsDir>/<user>/<scenarioSlug>/<runId>.json — immutable.
 */
import { spawn } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';

import { PATHS } from '../config/paths.js';

const PO_RUNS_DIR = PATHS.poRunsDir;
const TESTER_IMAGE = process.env.CUI_TESTER_PO_IMAGE || 'tester-po:latest';

const SOFT_TIMEOUT_MS = 15 * 60 * 1000;
const HARD_TIMEOUT_MS = 30 * 60 * 1000;

export type RunStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'timeout'
  | 'infra-error';

export interface PoRunRecord {
  runId: string;
  scenarioId: string;
  app: string;
  user: string;
  targetUrl: string;
  status: RunStatus;
  enqueuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationSeconds?: number;
  verdict?: 'pass' | 'fail' | 'unclear' | 'error';
  summary?: string;
  result?: any;        // contents of /report/result.json
  exitCode?: number;
  stderr?: string;     // last ~4 KB of stderr on failure
  reportFiles?: string[]; // basenames in the run dir (for download)
}

interface QueueItem {
  runId: string;
  scenarioId: string;
  app: string;
  user: string;
  targetUrl: string;
  scenario: any; // full PoScenario including target_url, used to write /scenario/scenario.json
}

let active: QueueItem | null = null;
const queue: QueueItem[] = [];

function generateRunId(): string {
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 13); // YYYYMMDDHHmm
  const rnd = randomBytes(3).toString('hex');
  return `${ts}-${rnd}`;
}

function runDir(user: string, scenarioId: string): string {
  return join(PO_RUNS_DIR, user, scenarioId);
}

function runFile(user: string, scenarioId: string, runId: string): string {
  return join(runDir(user, scenarioId), `${runId}.json`);
}

function persistRecord(rec: PoRunRecord): void {
  const dir = runDir(rec.user, rec.scenarioId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(runFile(rec.user, rec.scenarioId, rec.runId), JSON.stringify(rec, null, 2), 'utf-8');
}

export function readRun(user: string, scenarioId: string, runId: string): PoRunRecord | null {
  const f = runFile(user, scenarioId, runId);
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, 'utf-8'));
  } catch {
    return null;
  }
}

export function listRuns(user: string, scenarioId: string): PoRunRecord[] {
  const dir = runDir(user, scenarioId);
  if (!existsSync(dir)) return [];
  const out: PoRunRecord[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      out.push(JSON.parse(readFileSync(join(dir, f), 'utf-8')));
    } catch { /* skip corrupt */ }
  }
  return out.sort((a, b) => (b.enqueuedAt || '').localeCompare(a.enqueuedAt || ''));
}

export function enqueueRun(args: {
  scenarioId: string;
  app: string;
  user: string;
  targetUrl: string;
  scenario: any;
}): PoRunRecord {
  const runId = generateRunId();
  const now = new Date().toISOString();

  const rec: PoRunRecord = {
    runId,
    scenarioId: args.scenarioId,
    app: args.app,
    user: args.user,
    targetUrl: args.targetUrl,
    status: 'queued',
    enqueuedAt: now,
  };
  persistRecord(rec);

  queue.push({
    runId,
    scenarioId: args.scenarioId,
    app: args.app,
    user: args.user,
    targetUrl: args.targetUrl,
    scenario: args.scenario,
  });

  // Kick the queue without blocking the caller.
  setImmediate(() => { void drainQueue(); });

  return rec;
}

export function getQueueState(): { active: string | null; queued: string[] } {
  return {
    active: active ? active.runId : null,
    queued: queue.map(q => q.runId),
  };
}

async function drainQueue(): Promise<void> {
  if (active) return;
  const next = queue.shift();
  if (!next) return;
  active = next;
  try {
    await runOne(next);
  } finally {
    active = null;
    if (queue.length > 0) {
      setImmediate(() => { void drainQueue(); });
    }
  }
}

function loadRecord(user: string, scenarioId: string, runId: string): PoRunRecord {
  const r = readRun(user, scenarioId, runId);
  if (!r) throw new Error(`Run record not found: ${runId}`);
  return r;
}

function updateRecord(user: string, scenarioId: string, runId: string, patch: Partial<PoRunRecord>): void {
  const r = loadRecord(user, scenarioId, runId);
  Object.assign(r, patch);
  persistRecord(r);
}

async function runOne(item: QueueItem): Promise<void> {
  const { runId, user, scenarioId, app } = item;
  const startedAt = new Date().toISOString();

  // Stage scenario + reports dirs in tmp (mounted into container)
  const stageRoot = join(tmpdir(), `tester-po-${runId}`);
  const scenarioStage = join(stageRoot, 'scenario');
  const reportStage = join(stageRoot, 'report');
  mkdirSync(scenarioStage, { recursive: true });
  mkdirSync(reportStage, { recursive: true });
  writeFileSync(join(scenarioStage, 'scenario.json'), JSON.stringify(item.scenario, null, 2), 'utf-8');

  updateRecord(user, scenarioId, runId, {
    status: 'running',
    startedAt,
  });

  // Bridge env passed through to the container.
  const bridgeUrl = process.env.AI_BRIDGE_URL || '';
  const bridgeKey = process.env.AI_BRIDGE_API_KEY || '';

  const dockerArgs = [
    'run', '--rm',
    '--name', `tester-po-${runId}`,
    '--network', 'bridge',
    '--add-host', 'host.docker.internal:host-gateway',
    '-v', `${scenarioStage}:/scenario:ro`,
    '-v', `${reportStage}:/report:rw`,
    '-e', `AI_BRIDGE_URL=${bridgeUrl}`,
    '-e', `AI_BRIDGE_API_KEY=${bridgeKey}`,
    TESTER_IMAGE,
  ];

  const start = Date.now();
  let stderrBuf = '';
  let stdoutBuf = '';
  let exitCode: number | null = null;
  let killedByTimeout = false;
  let softTimerFired = false;

  const proc = spawn('docker', dockerArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

  proc.stdout?.on('data', (d) => { stdoutBuf += d.toString(); });
  proc.stderr?.on('data', (d) => { stderrBuf += d.toString(); });

  const softTimer = setTimeout(() => {
    softTimerFired = true;
    updateRecord(user, scenarioId, runId, { status: 'running', summary: '⚠️ Test läuft länger als 15 min' });
  }, SOFT_TIMEOUT_MS);

  const hardTimer = setTimeout(() => {
    killedByTimeout = true;
    try {
      // Try graceful first via docker stop (10s grace), then SIGKILL via docker kill.
      spawn('docker', ['kill', `tester-po-${runId}`], { stdio: 'ignore' }).on('exit', () => {});
    } catch { /* */ }
    proc.kill('SIGKILL');
  }, HARD_TIMEOUT_MS);

  await new Promise<void>((resolve) => {
    proc.on('exit', (code) => {
      exitCode = code;
      clearTimeout(softTimer);
      clearTimeout(hardTimer);
      resolve();
    });
    proc.on('error', (err) => {
      stderrBuf += `\n[spawn-error] ${err.message}`;
      exitCode = -1;
      clearTimeout(softTimer);
      clearTimeout(hardTimer);
      resolve();
    });
  });

  const finishedAt = new Date().toISOString();
  const durationSeconds = Math.round((Date.now() - start) / 1000);

  // Read result.json from the stage dir; copy report files into the run dir.
  const finalReportDir = join(runDir(user, scenarioId), runId);
  mkdirSync(finalReportDir, { recursive: true });

  let result: any = null;
  let reportFiles: string[] = [];
  try {
    for (const f of readdirSync(reportStage)) {
      const src = join(reportStage, f);
      const dst = join(finalReportDir, f);
      writeFileSync(dst, readFileSync(src));
      reportFiles.push(f);
    }
    const resultPath = join(finalReportDir, 'result.json');
    if (existsSync(resultPath)) {
      result = JSON.parse(readFileSync(resultPath, 'utf-8'));
    }
  } catch (e) {
    stderrBuf += `\n[copy-report] ${e instanceof Error ? e.message : String(e)}`;
  }

  // Determine final status
  let status: RunStatus;
  let verdict: PoRunRecord['verdict'];
  let summary: string;

  if (killedByTimeout) {
    status = 'timeout';
    verdict = 'error';
    summary = 'Test wurde nach 30 Minuten abgebrochen (hard timeout)';
  } else if (exitCode === 0 && result) {
    status = 'completed';
    verdict = (result.verdict as PoRunRecord['verdict']) || 'unclear';
    summary = result.summary || '(keine Zusammenfassung)';
  } else if (exitCode === 2) {
    status = 'infra-error';
    verdict = 'error';
    summary = result?.summary || 'Infrastruktur-Fehler im Tester';
  } else {
    status = 'failed';
    verdict = 'error';
    summary = `Tester exited with code ${exitCode}` + (softTimerFired ? ' (nach 15-min Soft-Warnung)' : '');
  }

  updateRecord(user, scenarioId, runId, {
    status,
    finishedAt,
    durationSeconds,
    verdict,
    summary,
    result,
    exitCode: exitCode ?? -1,
    stderr: stderrBuf.slice(-4096),
    reportFiles,
  });

  // Cleanup stage dir (the report dir contents have been copied to finalReportDir)
  try { rmSync(stageRoot, { recursive: true, force: true }); } catch { /* */ }
}
