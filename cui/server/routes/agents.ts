import { Router } from 'express';
import { spawn } from 'child_process';
import { promises as fsAgentPromises } from 'fs';
import { existsSync, readFileSync, statSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { join, resolve } from 'path';

const execAsync = promisify(exec);

const router = Router();

// --- Agent Monitoring & Control ---

const AGENTS_DIR = '/root/projekte/werkingflow/team-agents';
const AGENT_REGISTRY: Record<string, { persona_id: string; persona_name: string; schedule: string }> = {
  kai: { persona_id: 'kai-hoffmann', persona_name: 'Kai Hoffmann', schedule: 'Mo 09:00' },
};
const runningAgents = new Set<string>();

async function agentReadJsonlLastN(filePath: string, n: number): Promise<any[]> {
  try {
    const content = await fsAgentPromises.readFile(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    return lines.slice(-n).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

// --- Agent API Proxy to Hetzner ---
// Server runs on dev server — agents are local, no proxy needed.

router.get('/api/agents/status', async (_req, res) => {
  try {
  const agents = await Promise.all(Object.entries(AGENT_REGISTRY).map(async ([id, info]) => {
    const memory = await agentReadJsonlLastN(`${AGENTS_DIR}/memory/${info.persona_id}.jsonl`, 1);
    const last = memory[0] ?? null;
    let inboxCount = 0;
    try { const inbox = await fsAgentPromises.readFile(`${AGENTS_DIR}/inbox/${info.persona_id}.md`, 'utf-8'); inboxCount = inbox.split('---').filter(s => s.trim()).length; } catch { /**/ }
    let approvalsCount = 0;
    try { const raw = await fsAgentPromises.readFile(`${AGENTS_DIR}/approvals/pending.jsonl`, 'utf-8'); approvalsCount = raw.trim().split('\n').filter(Boolean).filter(l => { try { return JSON.parse(l).persona?.toLowerCase().includes(id.toLowerCase()); } catch { return false; } }).length; } catch { /**/ }
    let status: 'idle' | 'working' | 'error' = 'idle';
    if (runningAgents.has(id)) status = 'working';
    else if (last?.response_preview?.startsWith('ERROR:')) status = 'error';
    const now = new Date();
    const daysUntilMonday = now.getDay() === 1 ? 7 : (8 - now.getDay()) % 7 || 7;
    const nextRun = new Date(now); nextRun.setDate(now.getDate() + daysUntilMonday); nextRun.setHours(9, 0, 0, 0);
    return { id, persona_id: info.persona_id, persona_name: info.persona_name, schedule: info.schedule, status, last_run: last?.timestamp ?? null, last_actions: last?.actions ?? 0, last_action_types: last?.action_types ?? [], last_trigger: last?.trigger ?? null, next_run: nextRun.toISOString(), has_pending_approvals: approvalsCount > 0, approvals_count: approvalsCount, inbox_count: inboxCount };
  }));
  res.json({ agents });
  } catch (err: any) {
    console.warn('[Server] GET /api/agents/status error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

router.get('/api/agents/memory/:personaId', async (req, res) => {
  try {
  const safe = req.params.personaId.replace(/[^a-z0-9-]/g, '');
  const n = Math.min(parseInt(String(req.query.n ?? '10'), 10), 50);
  const entries = await agentReadJsonlLastN(`${AGENTS_DIR}/memory/${safe}.jsonl`, n);
  res.json({ persona_id: safe, entries: entries.reverse() });
  } catch (err: any) {
    console.warn('[Server] GET /api/agents/memory error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

router.get('/api/agents/inbox/:personaId', async (req, res) => {
  const safe = req.params.personaId.replace(/[^a-z0-9-]/g, '');
  try {
    const content = await fsAgentPromises.readFile(`${AGENTS_DIR}/inbox/${safe}.md`, 'utf-8');
    const messages = [];

    // Split on "\n---\n" - results in alternating headers/body pairs
    const parts = content.split(/\n---\n/).filter(p => p.trim());

    // Process pairs: parts[0,2,4...] = headers, parts[1,3,5...] = body
    for (let i = 0; i < parts.length - 1; i += 2) {
      let headers = parts[i].replace(/^---\n/, '').trim(); // Remove leading --- if present
      const body = parts[i + 1]?.trim() || '';

      // Parse headers
      const vonMatch = headers.match(/Von:\s*(.+)/i);
      const betreffMatch = headers.match(/Betreff:\s*(.+)/i);
      const datumMatch = headers.match(/Datum:\s*(.+)/i);

      if (vonMatch || betreffMatch) { // Only add if we found at least one header
        messages.push({
          from: vonMatch?.[1]?.trim() ?? 'Unknown',
          subject: betreffMatch?.[1]?.trim() ?? 'No Subject',
          date: datumMatch?.[1]?.trim() ?? '',
          body
        });
      }
    }

    res.json({ persona_id: safe, messages });
  } catch { res.json({ persona_id: safe, messages: [] }); }
});

// GET /api/agents/approvals/:personaId - Agent-specific pending approvals
router.get('/api/agents/approvals/:personaId', async (req, res) => {
  const safe = req.params.personaId.replace(/[^a-z0-9-]/g, '');
  try {
    const approvalDir = `${AGENTS_DIR}/approvals/${safe}`;
    const files = await fsAgentPromises.readdir(approvalDir).catch(() => []);
    const pendingFiles = files.filter(f => f.endsWith('.pending'));

    const approvals = await Promise.all(pendingFiles.map(async (file) => {
      try {
        const content = await fsAgentPromises.readFile(`${approvalDir}/${file}`, 'utf-8');
        const stat = await fsAgentPromises.stat(`${approvalDir}/${file}`);
        return {
          file,
          summary: content.slice(0, 200),
          timestamp: stat.mtime.toISOString()
        };
      } catch {
        return null;
      }
    }));

    res.json({ persona_id: safe, approvals: approvals.filter(Boolean) });
  } catch { res.json({ persona_id: safe, approvals: [] }); }
});

// GET /api/agents/approvals - Global pending approvals (legacy)
router.get('/api/agents/approvals', async (_req, res) => {
  try {
    const raw = await fsAgentPromises.readFile(`${AGENTS_DIR}/approvals/pending.jsonl`, 'utf-8');
    const approvals = raw.trim().split('\n').filter(Boolean).map((l, i) => { try { return { index: i, ...JSON.parse(l) }; } catch { return null; } }).filter(Boolean);
    res.json({ approvals });
  } catch { res.json({ approvals: [] }); }
});

router.post('/api/agents/approve', async (req, res) => {
  const { index, execute } = req.body as { index: number; execute: boolean };
  try {
    const raw = await fsAgentPromises.readFile(`${AGENTS_DIR}/approvals/pending.jsonl`, 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean);
    if (index < 0 || index >= lines.length) return res.status(400).json({ error: 'Invalid index' });
    const entry = JSON.parse(lines[index]);
    lines.splice(index, 1);
    await fsAgentPromises.writeFile(`${AGENTS_DIR}/approvals/pending.jsonl`, lines.join('\n') + (lines.length ? '\n' : ''));
    if (execute && entry.type === 'bash') execAsync(entry.payload, { cwd: AGENTS_DIR, timeout: 30000 }).then(({stdout, stderr}) => console.log('[Approval] OK:', stdout || stderr)).catch(e => console.error('[Approval]', e.message));
    res.json({ ok: true, executed: execute && entry.type === 'bash' });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/api/agents/trigger/:id', (req, res) => {
  const { id } = req.params;
  if (!AGENT_REGISTRY[id]) return res.status(404).json({ error: `Unknown agent: ${id}` });
  if (runningAgents.has(id)) return res.status(409).json({ error: 'Agent already running' });
  runningAgents.add(id);
  console.log(`[AgentTrigger] Starting: ${id}`);
  const proc = spawn('python3', ['scheduler.py', '--once', id], { cwd: AGENTS_DIR, detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.on('error', (err) => { runningAgents.delete(id); console.warn(`[Server] agent trigger spawn error for ${id}:`, err); });
  proc.stdout?.on('data', (d: Buffer) => console.log(`[Agent:${id}]`, d.toString().trim()));
  proc.stderr?.on('data', (d: Buffer) => console.error(`[Agent:${id}]`, d.toString().trim()));
  proc.on('close', (code) => { runningAgents.delete(id); console.log(`[Agent:${id}] done (exit ${code})`); });
  res.json({ ok: true, agent_id: id, started_at: new Date().toISOString() });
});

router.get('/api/agents/briefs', async (_req, res) => {
  try {
    const files = await fsAgentPromises.readdir(`${AGENTS_DIR}/shared/weekly-briefs`);
    res.json({ briefs: files.filter(f => f.endsWith('.md')).sort().reverse().map(f => ({ name: f })) });
  } catch { res.json({ briefs: [] }); }
});

router.get('/api/agents/brief/:name', async (req, res) => {
  const safe = req.params.name.replace(/[^a-zA-Z0-9._-]/g, '');
  if (!safe.endsWith('.md')) return res.status(400).json({ error: 'Only .md files' });
  try {
    res.type('text/plain').send(await fsAgentPromises.readFile(`${AGENTS_DIR}/shared/weekly-briefs/${safe}`, 'utf-8'));
  } catch { res.status(404).json({ error: 'Not found' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Claude Code Agent Runner — 16 Personas, full filesystem access
// ─────────────────────────────────────────────────────────────────────────────
const PROMPTS_DIR = `${AGENTS_DIR}/prompts`;
const CLAUDE_LOGS_DIR = '/root/projekte/local-storage/backends/team-agents/logs';
const runningClaudes = new Map<string, ReturnType<typeof spawn>>();

const CLAUDE_AGENT_REGISTRY: Record<string, { name: string; schedule: string; task_type: string }> = {
  'rafbot':          { name: 'Rafbot',           schedule: 'on-demand',      task_type: 'META' },
  'kai-hoffmann':    { name: 'Kai Hoffmann',    schedule: 'Mo 09:00',       task_type: 'SCAN' },
  'birgit-bauer':    { name: 'Birgit Bauer',    schedule: 'Mo 10:00',       task_type: 'SYNC' },
  'max-weber':       { name: 'Max Weber',        schedule: 'Di 09:00',       task_type: 'DECIDE' },
  'vera-vertrieb':   { name: 'Vera Vertrieb',    schedule: 'Mo 11:00',       task_type: 'SCAN' },
  'herbert-sicher':  { name: 'Herbert Sicher',   schedule: 'tägl. 02:00',    task_type: 'SCAN' },
  'otto-operations': { name: 'Otto Operations',  schedule: 'Mi 09:00',       task_type: 'SYNC' },
  'mira-marketing':  { name: 'Mira Marketing',   schedule: 'Di 10:00',       task_type: 'PRODUCE' },
  'felix-krause':    { name: 'Felix Krause',     schedule: 'Fr 14:00',       task_type: 'REVIEW' },
  'anna-frontend':   { name: 'Anna Frontend',    schedule: 'on-demand',      task_type: 'PRODUCE' },
  'tim-berger':      { name: 'Tim Berger',       schedule: 'on-demand',      task_type: 'PRODUCE' },
  'chris-customer':  { name: 'Chris Customer',   schedule: 'tägl. 08:00',    task_type: 'SCAN' },
  'finn-finanzen':   { name: 'Finn Finanzen',    schedule: '1. des Monats',  task_type: 'REVIEW' },
  'lisa-mueller':    { name: 'Lisa Müller',      schedule: 'Mo 08:00',       task_type: 'REVIEW' },
  'peter-doku':      { name: 'Peter Doku',       schedule: 'Fr 10:00',       task_type: 'PRODUCE' },
  'sarah-koch':      { name: 'Sarah Koch',       schedule: 'on-demand',      task_type: 'REVIEW' },
  'klaus-schmidt':   { name: 'Klaus Schmidt',    schedule: 'Mi 09:00',       task_type: 'REVIEW' },
};

router.get('/api/agents/claude/status', async (_req, res) => {
  try {
  const readSafe = async (p: string, fb = '') => { try { return await fsAgentPromises.readFile(p, 'utf-8'); } catch { return fb; } };
  const agents = await Promise.all(Object.entries(CLAUDE_AGENT_REGISTRY).map(async ([id, info]) => {
    let last_run: string | null = null; let last_outcome = '';
    try {
      const lines = (await fsAgentPromises.readFile(`${AGENTS_DIR}/memory/${id}.jsonl`, 'utf-8')).trim().split('\n').filter(Boolean);
      const last = JSON.parse(lines[lines.length - 1]);
      last_run = last.timestamp ?? null; last_outcome = (last.outcome ?? '').slice(0, 100);
    } catch { /**/ }
    let inbox_count = 0;
    try { inbox_count = ((await fsAgentPromises.readFile(`${AGENTS_DIR}/inbox/${id}.md`, 'utf-8')).match(/^---$/gm) ?? []).length; } catch { /**/ }
    let approvals_count = 0;
    try {
      const appDir = `${AGENTS_DIR}/approvals/${id}`;
      const files = await fsAgentPromises.readdir(appDir).catch(() => [] as string[]);
      approvals_count = files.filter(f => f.endsWith('.pending')).length;
    } catch { /**/ }
    return {
      id,
      persona_id: id,
      persona_name: info.name,
      schedule: info.schedule,
      task_type: info.task_type,
      status: runningClaudes.has(id) ? 'working' as const : 'idle' as const,
      last_run,
      last_outcome,
      last_actions: 0,
      last_action_types: [] as string[],
      last_trigger: null as string | null,
      next_run: '',
      has_pending_approvals: approvals_count > 0,
      approvals_count,
      inbox_count,
    };
  }));
  res.json({ agents });
  } catch (err: any) {
    console.warn('[Server] GET /api/agents/claude/status error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

router.post('/api/agents/claude/run', async (req, res) => {
  try {
  const { persona_id, task, mode, plan_id } = req.body as { persona_id: string; task?: string; mode?: 'plan' | 'execute'; plan_id?: string };
  const runMode = mode ?? 'plan'; // Default: plan first
  if (!CLAUDE_AGENT_REGISTRY[persona_id]) return res.status(404).json({ error: `Unknown persona: ${persona_id}` });
  if (runningClaudes.has(persona_id)) return res.status(409).json({ error: 'Already running' });
  const info = CLAUDE_AGENT_REGISTRY[persona_id];
  const taskId = `${persona_id}-${Date.now()}`;
  const logFile = `${CLAUDE_LOGS_DIR}/${taskId}.log`;
  await fsAgentPromises.mkdir(CLAUDE_LOGS_DIR, { recursive: true });
  const readSafe = async (p: string, fb = '') => { try { return await fsAgentPromises.readFile(p, 'utf-8'); } catch { return fb; } };
  const basePrompt    = await readSafe(`${PROMPTS_DIR}/_base_system.md`);
  const personaPrompt = await readSafe(`${PROMPTS_DIR}/${persona_id}.md`, `Du bist ${info.name} bei Werkingflow.`);
  const memory        = await readSafe(`${AGENTS_DIR}/memory/${persona_id}.summary.md`, 'Erster Durchlauf — kein vorheriges Memory.');
  const inbox         = await readSafe(`${AGENTS_DIR}/inbox/${persona_id}.md`, 'Keine Nachrichten.');
  const now           = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const taskDesc      = task ?? `Führe deinen regulären ${info.task_type}-Zyklus durch.`;

  let fullPrompt = '';
  if (runMode === 'plan') {
    // PLAN MODE: Agent soll nur planen, nicht ausführen
    const planFile = `${AGENTS_DIR}/plans/${persona_id}-${Date.now()}.md`;
    fullPrompt = [
      basePrompt, '---', personaPrompt, '---',
      '## Dein Memory (bisherige Runs)', memory,
      '## Deine Inbox', inbox, '---',
      `## Aktuelle Aufgabe — PLAN MODE\n**Datum:** ${now}  **Task-Typ:** ${info.task_type}\n**Aufgabe:** ${taskDesc}`,
      '',
      '**WICHTIG: Du bist im PLAN-Modus. Führe NICHTS aus!**',
      '',
      'Deine Aufgabe:',
      '1. Analysiere die Aufgabe gründlich',
      '2. Lies relevante Dateien (Read tool) um den aktuellen Stand zu verstehen',
      '3. Erstelle einen detaillierten Umsetzungs-Plan',
      '4. Schreibe den Plan nach: ' + planFile,
      '',
      'Der Plan muss enthalten:',
      '- Was genau gemacht werden soll',
      '- Welche Dateien gelesen/geschrieben werden',
      '- Welche Bash-Commands ausgeführt werden',
      '- Welche Personas benachrichtigt werden',
      '',
      'Am Ende: PLAN_COMPLETE: [Ein-Satz-Zusammenfassung]',
    ].join('\n\n');
  } else {
    // EXECUTE MODE: Agent führt approved Plan aus
    const planContent = plan_id ? await readSafe(`${AGENTS_DIR}/plans/${plan_id}.md`, 'Kein Plan gefunden.') : '';
    fullPrompt = [
      basePrompt, '---', personaPrompt, '---',
      '## Dein Memory (bisherige Runs)', memory,
      '## Deine Inbox', inbox, '---',
      `## Aktuelle Aufgabe — EXECUTE MODE\n**Datum:** ${now}  **Task-Typ:** ${info.task_type}\n**Aufgabe:** ${taskDesc}`,
      '',
      '## Dein genehmigter Plan',
      planContent,
      '',
      '**Führe jetzt den Plan aus. Du hast volle Berechtigung.**',
      '',
      'Arbeite systematisch durch den Plan. Schreibe am Ende deinen Memory-Record und das AGENT_COMPLETE Signal.',
    ].join('\n\n');
  }
  // Remove CLAUDECODE env var so nested claude sessions are allowed
  const spawnEnv = { ...process.env };
  delete (spawnEnv as Record<string, string | undefined>).CLAUDECODE;
  // Always pipe prompt via stdin (avoids ARG_MAX limits for long prompts)
  const isRoot = process.getuid?.() === 0;
  const cmd = isRoot ? 'sudo' : 'claude';
  const args = isRoot
    ? ['-u', 'claude-user', 'claude', '--dangerously-skip-permissions', '--print']
    : ['--dangerously-skip-permissions', '--print'];
  const proc = spawn(cmd, args, { cwd: '/root/projekte/werkingflow', stdio: ['pipe', 'pipe', 'pipe'], env: spawnEnv });
  proc.on('error', (err) => { runningClaudes.delete(persona_id); console.warn(`[Server] claude agent spawn error for ${persona_id}:`, err); });
  if (!proc.stdin) throw new Error(`Failed to open stdin for ${persona_id}`);
  proc.stdin.write(fullPrompt);
  proc.stdin.end();
  const writeLog = (s: string) => fsAgentPromises.appendFile(logFile, s).catch(() => {});
  writeLog(`[${now}] ${info.name} gestartet — ${taskDesc}\n${'─'.repeat(60)}\n\n`);
  proc.stdout?.on('data', (d: Buffer) => writeLog(d.toString()));
  proc.stderr?.on('data', (d: Buffer) => writeLog(`[ERR] ${d.toString()}`));
  proc.on('close', (code) => { runningClaudes.delete(persona_id); writeLog(`\n${'─'.repeat(60)}\n[DONE] Exit: ${code}\n`); console.log(`[ClaudeAgent:${persona_id}] done (${code})`); });
  runningClaudes.set(persona_id, proc);
  console.log(`[ClaudeAgent] Starting ${persona_id} (${runMode}) → ${logFile}`);
  const planFile = runMode === 'plan' ? `${persona_id}-${Date.now()}.md` : (plan_id ?? null);
  res.json({ ok: true, task_id: taskId, persona_id, log_file: logFile, mode: runMode, plan_file: planFile });
  } catch (err: any) {
    console.warn('[Server] POST /api/agents/claude/run error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

router.get('/api/agents/claude/log/:taskId', async (req, res) => {
  const safe = req.params.taskId.replace(/[^a-zA-Z0-9._-]/g, '');
  const logFile = `${CLAUDE_LOGS_DIR}/${safe}.log`;
  res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Connection', 'keep-alive');
  try { res.write(`data: ${JSON.stringify({ text: await fsAgentPromises.readFile(logFile, 'utf-8'), init: true })}\n\n`); } catch { /**/ }
  const tail = spawn('tail', ['-f', '-n', '0', logFile]);
  tail.on('error', (err) => console.warn('[Server] tail spawn error:', err));
  tail.stdout?.on('data', (d: Buffer) => res.write(`data: ${JSON.stringify({ text: d.toString() })}\n\n`));
  req.on('close', () => tail.kill());
});

router.get('/api/agents/claude/memory/:personaId', async (req, res) => {
  const id = req.params.personaId.replace(/[^a-z0-9-]/g, '');
  const summary = await (async () => { try { return await fsAgentPromises.readFile(`${AGENTS_DIR}/memory/${id}.summary.md`, 'utf-8'); } catch { return 'Kein Memory.'; } })();
  const raw = await (async () => { try { return await fsAgentPromises.readFile(`${AGENTS_DIR}/memory/${id}.jsonl`, 'utf-8'); } catch { return ''; } })();
  const runs = raw.trim().split('\n').filter(Boolean).slice(-10).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
  res.json({ summary, runs });
});

// GET /api/agents/claude/plan/:planFile — read a plan file
router.get('/api/agents/claude/plan/:planFile', async (req, res) => {
  const safe = req.params.planFile.replace(/[^a-zA-Z0-9._-]/g, '');
  if (!safe.endsWith('.md')) return res.status(400).json({ error: 'Only .md files' });
  try {
    const content = await fsAgentPromises.readFile(`${AGENTS_DIR}/plans/${safe}`, 'utf-8');
    res.type('text/plain').send(content);
  } catch { res.status(404).json({ error: 'Plan not found' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Business Approval System — .pending files must be approved by Rafael
// ─────────────────────────────────────────────────────────────────────────────
const BUSINESS_DIR = '/root/projekte/werkingflow/business';
const BUSINESS_QUEUE = `${BUSINESS_DIR}/.pending-queue.jsonl`;

// GET /api/agents/business/pending — list all pending business changes
router.get('/api/agents/business/pending', async (_req, res) => {
  try {
    const raw = await fsAgentPromises.readFile(BUSINESS_QUEUE, 'utf-8');
    const pending = raw.trim().split('\n').filter(Boolean).map((l, i) => {
      try {
        const entry = JSON.parse(l);
        return { index: i, ...entry };
      } catch { return null; }
    }).filter(Boolean);
    res.json({ pending });
  } catch { res.json({ pending: [] }); }
});

// POST /api/agents/business/approve — approve a pending change
router.post('/api/agents/business/approve', async (req, res) => {
  const { index, commit_message } = req.body as { index: number; commit_message?: string };
  try {
    const raw = await fsAgentPromises.readFile(BUSINESS_QUEUE, 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean);
    if (index >= lines.length) return res.status(404).json({ error: 'Entry not found' });
    const entry = JSON.parse(lines[index]);
    const pendingPath = entry.file;
    const finalPath = pendingPath.replace(/\.pending$/, '');

    // Move .pending → final
    await fsAgentPromises.rename(pendingPath, finalPath);

    // Remove from queue
    lines.splice(index, 1);
    await fsAgentPromises.writeFile(BUSINESS_QUEUE, lines.join('\n') + (lines.length > 0 ? '\n' : ''));

    // Auto-commit (approved option from questions)
    const message = commit_message ?? `Approved by Rafael: ${finalPath.replace(`${BUSINESS_DIR}/`, '')}`;
    const { execAsync } = await import('child_process');
    const { promisify } = await import('util');
    const exec = promisify(execAsync);
    try {
      await exec(`cd ${BUSINESS_DIR} && git add "${finalPath}" && git commit -m "${message}"`, { timeout: 10000 });
    } catch (gitErr) {
      console.warn('[BusinessApprove] Git commit failed:', gitErr);
      // Non-fatal — file is still moved
    }

    res.json({ ok: true, file: finalPath });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/agents/business/reject — reject a pending change
router.post('/api/agents/business/reject', async (req, res) => {
  const { index } = req.body as { index: number };
  try {
    const raw = await fsAgentPromises.readFile(BUSINESS_QUEUE, 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean);
    if (index >= lines.length) return res.status(404).json({ error: 'Entry not found' });
    const entry = JSON.parse(lines[index]);

    // Delete .pending file
    await fsAgentPromises.unlink(entry.file).catch(() => {});

    // Remove from queue
    lines.splice(index, 1);
    await fsAgentPromises.writeFile(BUSINESS_QUEUE, lines.join('\n') + (lines.length > 0 ? '\n' : ''));

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/agents/business/diff/:file — get diff for a .pending file
router.get(/^\/api\/agents\/business\/diff\/(.+)$/, async (req, res) => {
  const filePath = req.params[0];
  const pendingPath = `${BUSINESS_DIR}/${filePath}`;
  const finalPath = pendingPath.replace(/\.pending$/, '');
  try {
    const pendingContent = await fsAgentPromises.readFile(pendingPath, 'utf-8');
    let finalContent = '';
    try {
      finalContent = await fsAgentPromises.readFile(finalPath, 'utf-8');
    } catch { /* file doesn't exist yet */ }
    res.json({ pending: pendingContent, final: finalContent });
  } catch (err) {
    res.status(404).json({ error: 'File not found' });
  }
});

// --- Persona Tagging Endpoints ---
const PERSONA_TAG_SCRIPT = '/root/projekte/orchestrator/scripts/update-persona-tags.sh';
const ORCHESTRATOR_DATA_DIR = '/root/projekte/orchestrator/data';

// POST /api/persona-tags/update — Start persona tagging update
router.post('/api/persona-tags/update', async (_req, res) => {
  try {
    console.log('[Persona Tags] Starting update...');

    // Spawn script in background (only on server where script exists)
    const child = spawn(PERSONA_TAG_SCRIPT, [], {
      detached: true,
      stdio: 'ignore',
      cwd: '/root/projekte/orchestrator'
    });

    // CRITICAL: handle spawn errors to prevent process crash (ENOENT on local dev)
    child.on('error', (err) => {
      console.error(`[Persona Tags] Spawn error: ${err.message}`);
    });

    child.unref();

    res.json({ status: 'started' });
  } catch (err: any) {
    console.error('[Persona Tags] Update error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/persona-tags/status — Get tagging status for all apps
router.get('/api/persona-tags/status', async (_req, res) => {
  try {
    const apps = ['werking-report', 'engelmann', 'werking-energy', 'werking-safety'];
    const statusData: Record<string, any> = {};

    for (const app of apps) {
      const enrichedPath = `${ORCHESTRATOR_DATA_DIR}/${app}/enriched.json`;
      const tagsPath = `${ORCHESTRATOR_DATA_DIR}/${app}/persona-tags.json`;

      if (existsSync(enrichedPath)) {
        try {
          const enrichedContent = readFileSync(enrichedPath, 'utf-8');
          const enrichedData = JSON.parse(enrichedContent);
          const totalIds = enrichedData.summary?.total_ids || 0;

          statusData[app] = {
            total_ids: totalIds,
            has_tags: existsSync(tagsPath),
            enriched_mtime: statSync(enrichedPath).mtimeMs / 1000,
          };

          if (existsSync(tagsPath)) {
            statusData[app].tags_mtime = statSync(tagsPath).mtimeMs / 1000;
          }
        } catch (err) {
          console.error(`[Persona Tags] Error reading ${app}:`, err);
        }
      }
    }

    res.json(statusData);
  } catch (err: any) {
    console.error('[Persona Tags] Status error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Demo activity events (simulated agent actions)
// Helper: Map persona IDs to display names
function getPersonaDisplayName(personaId: string): string {
  const nameMap: Record<string, string> = {
    'sarah-koch': 'Sarah Koch',
    'klaus-mueller': 'Klaus Schmidt',
    'klaus-schmidt': 'Klaus Schmidt',
    'herbert-sicher': 'Herbert Sicher',
    'lisa-mueller': 'Lisa Müller',
    'lisa-wagner': 'Lisa Wagner',
    'mira-hoffmann': 'Mira Marketing',
    'mira-marketing': 'Mira Marketing',
    'vera-jung': 'Vera Vertrieb',
    'vera-vertrieb': 'Vera Vertrieb',
    'finn-richter': 'Finn Finanzen',
    'finn-finanzen': 'Finn Finanzen',
    'chris-bauer': 'Chris Customer',
    'chris-customer': 'Chris Customer',
    'anna-klein': 'Anna Frontend',
    'anna-frontend': 'Anna Frontend',
    'tim-fischer': 'Tim Berger',
    'tim-berger': 'Tim Berger',
    'peter-zimmermann': 'Peter Doku',
    'peter-doku': 'Peter Doku',
    'birgit-schuster': 'Birgit Bauer',
    'birgit-bauer': 'Birgit Bauer',
    'emma-schmidt': 'Emma Schmidt',
    'otto-bergmann': 'Otto Operations',
    'otto-operations': 'Otto Operations',
    'felix-neumann': 'Felix Krause',
    'felix-krause': 'Felix Krause',
    'max-weber': 'Max Weber',
    'rafbot': 'Rafbot'
  };
  return nameMap[personaId] || personaId;
}

// GET /api/agents/activity-stream — SSE stream of REAL agent activities
router.get('/api/agents/activity-stream', (_req, res) => {
  // ACTIVE_DIR is resolved relative to this module's location
  const ACTIVE_DIR = resolve(import.meta.dirname ?? '.', '..', '..', 'data', 'active');

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send initial connected event
  res.write(`data: ${JSON.stringify({
    timestamp: new Date().toISOString(),
    type: 'connected',
    message: 'Activity stream connected'
  })}\n\n`);

  // Load events.json and stream latest events
  const eventsFile = join(ACTIVE_DIR, 'team', 'events.json');

  let eventIndex = 0;
  const interval = setInterval(() => {
    try {
      // Re-read events.json every cycle (allows live updates)
      const eventsData = JSON.parse(readFileSync(eventsFile, 'utf8'));
      const events = Array.isArray(eventsData) ? eventsData : (eventsData.events || []);

      if (events.length === 0) {
        // No events available - send placeholder
        res.write(`data: ${JSON.stringify({
          timestamp: new Date().toISOString(),
          type: 'info',
          message: 'No recent activities'
        })}\n\n`);
        return;
      }

      // Cycle through events (newest first)
      const event = events[eventIndex % events.length];
      eventIndex++;

      // Map event to ActivityEvent format expected by frontend
      res.write(`data: ${JSON.stringify({
        timestamp: event.timestamp,
        personaId: event.personaId,
        personaName: getPersonaDisplayName(event.personaId),
        action: event.action,
        description: `${event.action} ${event.target || ''}: ${event.details || ''}`.trim()
      })}\n\n`);
    } catch (err) {
      console.error('[SSE] Failed to read events.json:', err);
      // Continue streaming, don't crash
    }
  }, 3000); // Every 3 seconds (faster than polling fallback)

  // Cleanup on client disconnect
  _req.on('close', () => {
    clearInterval(interval);
  });
});

// GET /api/agents/recommendations — smart action recommendations
router.get('/api/agents/recommendations', async (_req, res) => {
  try {
    const urgent: Array<any> = [];
    const recommended: Array<any> = [];

    // 1. Check business approvals for old items (URGENT if >3 days)
    try {
      const raw = await fsAgentPromises.readFile(BUSINESS_QUEUE, 'utf-8');
      const lines = raw.trim().split('\n').filter(Boolean);
      const pending = lines.map(l => JSON.parse(l));

      pending.forEach(entry => {
        const ageMs = Date.now() - new Date(entry.timestamp).getTime();
        const ageDays = Math.floor(ageMs / 86400000);

        if (ageDays > 3) {
          urgent.push({
            title: `Business approval overdue: ${entry.file.split('/').pop().replace('.pending', '')}`,
            description: `Pending for ${ageDays} days - may be blocking ${entry.persona}`,
            ageDays,
            personaId: entry.persona,
            personaName: entry.persona
          });
        } else if (ageDays > 1) {
          recommended.push({
            title: `Review: ${entry.file.split('/').pop().replace('.pending', '')}`,
            description: `Pending for ${ageDays} days from ${entry.persona}`,
            ageDays,
            personaId: entry.persona,
            personaName: entry.persona
          });
        }
      });
    } catch (err) { console.warn('[Server] recommendations business-approvals check error:', err); }

    // 2. Check for agents with scheduled runs that are overdue
    try {
      const agentStatusRes = await fetch('http://localhost:4005/api/agents/claude/status');
      if (agentStatusRes.ok) {
        const { agents } = await agentStatusRes.json();

        agents.forEach((agent: any) => {
          // Check if agent has schedule and last run was >7 days ago
          if (agent.last_run) {
            const daysSinceRun = Math.floor((Date.now() - new Date(agent.last_run).getTime()) / 86400000);

            if (daysSinceRun > 7 && agent.schedule && agent.schedule !== 'on-demand') {
              recommended.push({
                title: `Run ${agent.persona_name}`,
                description: `Last run was ${daysSinceRun} days ago (scheduled: ${agent.schedule})`,
                personaId: agent.persona_id,
                personaName: agent.persona_name
              });
            }
          } else if (agent.schedule && agent.schedule !== 'on-demand') {
            // Never run but has schedule
            recommended.push({
              title: `First run: ${agent.persona_name}`,
              description: `Never run yet (scheduled: ${agent.schedule})`,
              personaId: agent.persona_id,
              personaName: agent.persona_name
            });
          }
        });
      }
    } catch (err) { console.warn('[Server] recommendations overdue-agents check error:', err); }

    // 3. Count idle vs working agents for tips
    let idleCount = 0;
    let workingCount = 0;
    try {
      const agentStatusRes = await fetch('http://localhost:4005/api/agents/claude/status', { signal: AbortSignal.timeout(5000) });
      if (agentStatusRes.ok) {
        const { agents } = await agentStatusRes.json();
        idleCount = agents.filter((a: any) => a.status === 'idle').length;
        workingCount = agents.filter((a: any) => a.status === 'working').length;
      }
    } catch (err) { console.warn('[Server] recommendations agent-count check error:', err); }

    res.json({
      urgent,
      recommended,
      tips: {
        idle_agents: idleCount,
        working_agents: workingCount,
        blocking_count: urgent.length
      }
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/agents/persona/:id — get parsed persona data
router.get('/api/agents/persona/:id', async (req, res) => {
  const { id } = req.params;
  const personaPath = `/root/projekte/orchestrator/team/personas/${id}.md`;

  try {
    const content = await fsAgentPromises.readFile(personaPath, 'utf-8');

    // Simple inline parser (matches personaParser.ts logic)
    const persona: Record<string, any> = {
      id,
      name: '',
      role: '',
      mbti: '',
      strengths: [],
      weaknesses: [],
      responsibilities: [],
      collaboration: [],
      scenarios: []
    };

    // Extract name and role from header
    const headerMatch = content.match(/^#\s+(.+?)\s+-\s+(.+?)$/m);
    if (headerMatch) {
      persona.name = headerMatch[1].trim();
      persona.role = headerMatch[2].trim();
    }

    // Extract MBTI
    const mbtiMatch = content.match(/\*\*MBTI\*\*:\s+(.+?)$/m);
    if (mbtiMatch) persona.mbti = mbtiMatch[1].trim();

    // Extract Specialty
    const specialtyMatch = content.match(/\*\*Spezialgebiet\*\*:\s+(.+?)$/m);
    if (specialtyMatch) persona.specialty = specialtyMatch[1].trim();

    // Extract Reports To
    const reportsToMatch = content.match(/\*\*Berichtet an\*\*:\s+(.+?)$/m);
    if (reportsToMatch) persona.reportsTo = reportsToMatch[1].trim();

    // Extract metadata
    const teamMatch = content.match(/\*\*Team\*\*:\s+(.+?)$/m);
    if (teamMatch) persona.team = teamMatch[1].trim();

    const deptMatch = content.match(/\*\*Department\*\*:\s+(.+?)$/m);
    if (deptMatch) persona.department = deptMatch[1].trim();

    // Extract motto
    const mottoMatch = content.match(/>\s+"(.+?)"/);
    if (mottoMatch) persona.motto = mottoMatch[1].trim();

    // Extract Strengths
    const strengthsSection = content.match(/###\s+Stärken\s*([\s\S]*?)(?=###|##|$)/);
    if (strengthsSection) {
      const items = strengthsSection[1].match(/^-\s+(.+?)$/gm);
      if (items) persona.strengths = items.map((item: string) => item.replace(/^-\s+/, '').trim());
    }

    // Extract Weaknesses
    const weaknessesSection = content.match(/###\s+Schwächen\s*([\s\S]*?)(?=###|##|$)/);
    if (weaknessesSection) {
      const items = weaknessesSection[1].match(/^-\s+(.+?)$/gm);
      if (items) persona.weaknesses = items.map((item: string) => item.replace(/^-\s+/, '').trim());
    }

    // Extract Responsibilities
    const responsSection = content.match(/##\s+Verantwortlichkeiten\s*([\s\S]*?)(?=##|$)/);
    if (responsSection) {
      const items = responsSection[1].match(/^\d+\.\s+\*\*(.+?)\*\*\s+—\s+(.+?)$/gm);
      if (items) {
        persona.responsibilities = items.map((item: string) => {
          const match = item.match(/^\d+\.\s+\*\*(.+?)\*\*\s+—\s+(.+?)$/);
          return match ? `${match[1]}: ${match[2]}` : item;
        });
      }
    }

    // Extract Collaboration
    const collabSection = content.match(/##\s+Zusammenarbeit\s*([\s\S]*?)(?=##|$)/);
    if (collabSection) {
      const rows = collabSection[1].match(/^\|\s+\*\*(.+?)\*\*\s+\|\s+(.+?)\s+\|$/gm);
      if (rows) {
        persona.collaboration = rows.map((row: string) => {
          const match = row.match(/^\|\s+\*\*(.+?)\*\*\s+\|\s+(.+?)\s+\|$/);
          return match ? { person: match[1].trim(), reason: match[2].trim() } : null;
        }).filter(Boolean);
      }
    }

    res.json(persona);
  } catch (err) {
    res.status(404).json({ error: 'Persona not found' });
  }
});

// GET /api/agents/team/structure — get team org chart + RACI matrix
router.get('/api/agents/team/structure', async (_req, res) => {
  try {
    // Try to load pre-built hierarchy from hierarchy.json first
    const hierarchyPath = '/root/projekte/werkingflow/autopilot/cui/data/active/team/hierarchy.json';

    try {
      const hierarchyContent = await fsAgentPromises.readFile(hierarchyPath, 'utf-8');
      const hierarchyData = JSON.parse(hierarchyContent);

      // Load RACI matrix separately
      const raciPath = '/root/projekte/werkingflow/autopilot/cui/data/active/team/raci-matrix.json';
      let raciMatrix: Array<any> = [];

      try {
        const raciContent = await fsAgentPromises.readFile(raciPath, 'utf-8');
        const raciData = JSON.parse(raciContent);
        raciMatrix = (raciData.tasks || []).map((t: any) => ({
          task: t.task,
          owner: t.owner || '',
          responsible: t.responsible || [],
          approver: t.approver || [],
          consulted: t.consulted || []
        }));
      } catch (raciErr) {
        console.warn('Could not load raci-matrix.json:', raciErr);
      }

      // Return hierarchy + RACI
      return res.json({
        orgChart: hierarchyData.orgChart || [],
        raciMatrix,
        personas: [] // Can add persona details if needed
      });
    } catch (hierarchyErr) {
      // Fallback: build from persona files (legacy)
      console.warn('hierarchy.json not found, building from personas:', hierarchyErr);
    }

    // Fallback: build hierarchy from persona markdown files
    const personasDir = '/root/projekte/orchestrator/team/personas';
    const files = await fsAgentPromises.readdir(personasDir);
    const mdFiles = files.filter(f => f.endsWith('.md'));

    const personas: Array<any> = [];

    for (const file of mdFiles) {
      const id = file.replace('.md', '');
      const content = await fsAgentPromises.readFile(`${personasDir}/${file}`, 'utf-8');

      const persona: Record<string, any> = { id, responsibilities: [], collaboration: [] };

      // Extract name, role, reportsTo
      const headerMatch = content.match(/^#\s+(.+?)\s+-\s+(.+?)$/m);
      if (headerMatch) {
        persona.name = headerMatch[1].trim();
        persona.role = headerMatch[2].trim();
      }

      const reportsToMatch = content.match(/\*\*Berichtet an\*\*:\s+(.+?)$/m);
      if (reportsToMatch) persona.reportsTo = reportsToMatch[1].trim();

      const teamMatch = content.match(/\*\*Team\*\*:\s+(.+?)$/m);
      if (teamMatch) persona.team = teamMatch[1].trim();

      const deptMatch = content.match(/\*\*Department\*\*:\s+(.+?)$/m);
      if (deptMatch) persona.department = deptMatch[1].trim();

      // Extract responsibilities
      const responsSection = content.match(/##\s+Verantwortlichkeiten\s*([\s\S]*?)(?=##|$)/);
      if (responsSection) {
        const items = responsSection[1].match(/^\d+\.\s+\*\*(.+?)\*\*\s+—\s+(.+?)$/gm);
        if (items) {
          persona.responsibilities = items.map((item: string) => {
            const match = item.match(/^\d+\.\s+\*\*(.+?)\*\*\s+—\s+(.+?)$/);
            return match ? `${match[1]}: ${match[2]}` : item;
          });
        }
      }

      // Extract collaboration
      const collabSection = content.match(/##\s+Zusammenarbeit\s*([\s\S]*?)(?=##|$)/);
      if (collabSection) {
        const rows = collabSection[1].match(/^\|\s+\*\*(.+?)\*\*\s+\|\s+(.+?)\s+\|$/gm);
        if (rows) {
          persona.collaboration = rows.map((row: string) => {
            const match = row.match(/^\|\s+\*\*(.+?)\*\*\s+\|\s+(.+?)\s+\|$/);
            return match ? { person: match[1].trim(), reason: match[2].trim() } : null;
          }).filter(Boolean);
        }
      }

      personas.push(persona);
    }

    // Build org chart with smart name matching
    const nodeMap = new Map();
    const nameToIdMap = new Map(); // Map display names to IDs

    personas.forEach(p => {
      nodeMap.set(p.id, { id: p.id, name: p.name, role: p.role, children: [] });

      // Build name-to-ID mapping (e.g., "Max" -> "max-weber", "Max (CTO)" -> "max-weber")
      if (p.name) {
        const firstName = p.name.split(' ')[0].toLowerCase();
        nameToIdMap.set(firstName, p.id);
        nameToIdMap.set(p.name.toLowerCase(), p.id);
      }
    });

    // Add special aliases for common references (with parens removed)
    nameToIdMap.set('rafael', 'rafbot');
    nameToIdMap.set('rafael ceo', 'rafbot');  // "Rafael (CEO)" → "rafael ceo"
    nameToIdMap.set('rafael engelmann', 'rafbot');  // Rafbot reports to "Rafael Engelmann (Real)" → treat as self
    nameToIdMap.set('rafael engelmann real', 'rafbot');
    nameToIdMap.set('max', 'max-weber');
    nameToIdMap.set('max cto', 'max-weber');  // "Max (CTO)" → "max cto"
    nameToIdMap.set('vera', 'vera-vertrieb');
    nameToIdMap.set('vera sales', 'vera-vertrieb');  // "Vera (Sales)" → "vera sales"
    nameToIdMap.set('otto', 'otto-operations');
    nameToIdMap.set('otto coo', 'otto-operations');  // "Otto (COO)" → "otto coo"

    const roots: Array<any> = [];
    personas.forEach(p => {
      const node = nodeMap.get(p.id);
      if (p.reportsTo) {
        // Try to find parent by name (e.g., "Max (CTO)" -> "max-weber")
        // Remove parens, take first part before dash/slash, trim
        // Examples: "Rafael (CEO) - direkt" → "rafael ceo", "Vera (Sales) / Rafael (CEO)" → "vera sales"
        const reportsToClean = p.reportsTo.toLowerCase().replace(/[()]/g, '').split(/[-/]/)[0].trim();
        const reportsToFirstWord = reportsToClean.split(/\s+/)[0].trim(); // "max cto" -> "max"

        // Try exact match first, then first word only
        let parentId = nameToIdMap.get(reportsToClean) || nameToIdMap.get(reportsToFirstWord);

        if (parentId) {
          const parent = nodeMap.get(parentId);
          if (parent && parent !== node) {
            parent.children.push(node);
          } else {
            roots.push(node);
          }
        } else {
          // No parent found - make it a root
          roots.push(node);
        }
      } else {
        roots.push(node);
      }
    });

    // Build RACI matrix - load from raci-matrix.json if available, otherwise build from personas
    let raciMatrix: Array<any> = [];

    try {
      const raciPath = '/root/projekte/werkingflow/autopilot/cui/data/active/team/raci-matrix.json';
      const raciContent = await fsAgentPromises.readFile(raciPath, 'utf-8');
      const raciData = JSON.parse(raciContent);

      // Transform from JSON format to API format
      raciMatrix = (raciData.tasks || []).map((t: any) => ({
        task: t.task,
        owner: t.owner || '',
        responsible: t.responsible || [],
        approver: t.approver || [],
        consulted: t.consulted || []
      }));
    } catch (raciErr) {
      // Fallback: build from persona responsibilities
      console.warn('Could not load raci-matrix.json, building from personas:', raciErr);

      const taskMap = new Map();
      personas.forEach(p => {
        p.responsibilities.forEach((resp: string) => {
          const [task] = resp.split(':');
          const taskKey = task.trim().toLowerCase();

          if (!taskMap.has(taskKey)) {
            taskMap.set(taskKey, {
              task: task.trim(),
              owner: p.name,
              responsible: [p.name],
              approver: [],
              consulted: []
            });
          }
        });
      });

      raciMatrix.push(...Array.from(taskMap.values()));
    }

    res.json({ orgChart: roots, raciMatrix, personas });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
