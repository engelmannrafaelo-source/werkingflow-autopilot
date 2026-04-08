/**
 * Peer Awareness — Cross-Session Work Visibility
 *
 * Every 5 minutes: collects active + recent conversations across all accounts,
 * sends content to AI Bridge (Haiku) for summarization, writes result to
 * a shared file that every Claude session can read before starting work.
 *
 * Output: /home/claude-user/.claude/active-work.md (or ~/... in local mode)
 */

import { Router, Request, Response } from 'express';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

import * as claudeCli from './claude-cli.js';
import { findJsonlPath } from './shared/jsonl.js';
import * as convMeta from './shared/conv-metadata.js';
import { IS_LOCAL_MODE } from './state.js';
import { logBackgroundEvent } from './background-ops.js';

// --- Constants ---
const PEER_TICK_MS = 5 * 60 * 1000; // 5 minutes
const TAIL_LINES = 50; // JSONL lines per conversation
const MAX_MSG_CHARS = 300; // truncate per message
const MAX_SESSIONS_TO_SUMMARIZE = 25;
const RECENTLY_FINISHED_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours

// Output file paths (readable by all Claude sessions)
const ACTIVE_WORK_FILE = IS_LOCAL_MODE
  ? join(homedir(), '.claude', 'active-work.md')
  : '/home/claude-user/.claude/active-work.md';

const TEAM_CONTEXT_FILE = IS_LOCAL_MODE
  ? join(homedir(), '.claude', 'team-context.md')
  : '/home/claude-user/.claude/team-context.md';

// Orchestrator paths (platform-dependent)
const ORCH_DIR = IS_LOCAL_MODE
  ? '/Users/rafael/Documents/GitHub/orchestrator'
  : '/root/projekte/orchestrator';

const LEADERS = ['max', 'herbert', 'vera', 'finn', 'felix'] as const;

// --- Dependencies (injected via init) ---
let _getSessionStates: () => Record<string, any>;
let _DATA_DIR: string;
let _timer: ReturnType<typeof setInterval> | null = null;



// --- JSONL Text Extraction ---
/** Extract only user + assistant text from last N lines of a JSONL file */
function extractRecentText(filePath: string, tailCount: number): string[] {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const allLines = content.split('\n').filter(l => l.trim());
    const tail = allLines.slice(-tailCount);

    const texts: string[] = [];
    for (const line of tail) {
      try {
        const obj = JSON.parse(line);
        const role = obj.message?.role;
        if (role !== 'user' && role !== 'assistant') continue;
        // Skip synthetic/error messages
        if (obj.isApiErrorMessage || obj.message?.model === '<synthetic>') continue;

        const raw = obj.message.content;
        let text = '';
        if (typeof raw === 'string') {
          text = raw;
        } else if (Array.isArray(raw)) {
          // Only text blocks — skip tool_use, tool_result
          text = raw
            .filter((b: any) => b.type === 'text' && b.text)
            .map((b: any) => b.text)
            .join(' ');
        }
        if (!text.trim()) continue;

        // Truncate
        const truncated = text.length > MAX_MSG_CHARS
          ? text.slice(0, MAX_MSG_CHARS) + '...'
          : text;
        texts.push(`[${role}] ${truncated}`);
      } catch { /* skip unparseable */ }
    }
    return texts;
  } catch {
    return [];
  }
}



/** Decode JSONL directory name to project path */
function decodeDirName(dirname: string): string {
  return '/' + dirname.replace(/^-/, '').replace(/-/g, '/');
}

/** Find the project dir name for a session */
function findSessionDirName(sessionId: string): string {
  for (const acc of claudeCli.ACCOUNT_CONFIG) {
    const projDir = join(acc.home, '.claude', 'projects');
    try { if (!statSync(projDir).isDirectory()) continue; } catch { continue; }
    for (const dir of readdirSync(projDir)) {
      if (existsSync(join(projDir, dir, `${sessionId}.jsonl`))) return dir;
    }
  }
  return '';
}

// --- Bridge Summarization ---
async function summarizeViaBridge(sessionData: string): Promise<string> {
  const BRIDGE_URL = process.env.AI_BRIDGE_URL || 'http://49.12.72.66:8000';
  const BRIDGE_KEY = process.env.AI_BRIDGE_API_KEY;

  if (!BRIDGE_KEY) {
    console.warn('[PeerAwareness] AI_BRIDGE_API_KEY not set — writing raw data');
    logBackgroundEvent('peer', 'degraded', 'AI_BRIDGE_API_KEY not set — raw data only');
    return sessionData;
  }

  try {
    const resp = await fetch(`${BRIDGE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${BRIDGE_KEY}`,
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        messages: [{
          role: 'user',
          content: `Fasse kompakt zusammen, was jede Claude-Session gerade macht oder zuletzt gemacht hat.

Für jede Session: Projekt, aktuelle Aufgabe, Status (Implementierung/Debugging/Tests/Review/Fertig).
Format: Markdown-Tabelle + je 1 Satz Detail pro Session.
Antworte auf Deutsch.

${sessionData}`,
        }],
        max_tokens: 2048,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!resp.ok) {
      console.warn(`[PeerAwareness] Bridge error: ${resp.status}`);
      logBackgroundEvent('bridge', 'error', `Bridge HTTP ${resp.status}`);
      return sessionData;
    }

    const data = await resp.json();
    return data.choices?.[0]?.message?.content || sessionData;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[PeerAwareness] Bridge unreachable:', msg);
    logBackgroundEvent('bridge', 'error', `Bridge unreachable: ${msg}`);
    return sessionData;
  }
}

// --- Team Context Generation ---
/** Reads FRESHNESS_INDEX.json + worklist headlines, writes team-context.md */
function writeTeamContext() {
  try {
    const lines: string[] = [
      '# Team Context (auto-updated)',
      `_Stand: ${new Date().toISOString()}_`,
      '',
    ];

    // 1. Freshness Index
    const freshnessFile = join(ORCH_DIR, 'team', 'FRESHNESS_INDEX.json');
    if (existsSync(freshnessFile)) {
      try {
        const freshness = JSON.parse(readFileSync(freshnessFile, 'utf8'));
        const docs = freshness.documents || {};
        const entries = Object.entries(docs) as Array<[string, { status: string; owner?: string }]>;
        const stale = entries.filter(([, v]) => v.status === 'stale');
        const current = entries.filter(([, v]) => v.status === 'current');
        lines.push(`## Freshness: ${current.length}/${entries.length} aktuell, ${stale.length} stale`);
        if (stale.length > 0) {
          lines.push('### Stale Docs');
          for (const [path, meta] of stale.slice(0, 8)) {
            lines.push(`- ${path} (${meta.owner || '?'})`);
          }
        }
        lines.push('');
      } catch (err) {
        console.warn('[PeerAwareness] Failed to read FRESHNESS_INDEX:', err instanceof Error ? err.message : err);
      }
    }

    // 2. Leader Worklist Headlines (first 5-8 meaningful lines)
    lines.push('## Leader Status');
    for (const leader of LEADERS) {
      const wlFile = join(ORCH_DIR, 'team', 'worklists', `${leader}.md`);
      if (!existsSync(wlFile)) {
        lines.push(`**${leader}**: (keine Worklist)`);
        continue;
      }
      try {
        const content = readFileSync(wlFile, 'utf8');
        const wlLines = content.split('\n');
        // Extract: title line + STATUS line + first priority heading
        const titleLine = wlLines.find(l => l.startsWith('# ')) || '';
        const statusLine = wlLines.find(l => l.startsWith('## STATUS:')) || '';
        const lastUpdate = wlLines.find(l => l.includes('**Letztes Update**')) || '';

        const status = statusLine.replace('## STATUS:', '').trim() || 'unbekannt';
        const updateDate = lastUpdate.match(/\d{4}-\d{2}-\d{2}/)?.[0] || '?';

        lines.push(`**${leader}**: ${status} (Update: ${updateDate})`);
      } catch {
        lines.push(`**${leader}**: (Lesefehler)`);
      }
    }
    lines.push('');

    // Write file
    const dir = dirname(TEAM_CONTEXT_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(TEAM_CONTEXT_FILE, lines.join('\n'));
    console.log('[PeerAwareness] team-context.md updated');
  } catch (err) {
    console.error('[PeerAwareness] writeTeamContext error:', err instanceof Error ? err.message : err);
  }
}

// --- Main Tick ---
async function peerAwarenessTick() {
  try {
    const titles = convMeta.getAllTitles();
    const activeProcs = claudeCli.getActiveProcesses();
    const states = _getSessionStates();

    // 1. Collect active sessions (currently running)
    const activeSessions: Array<{
      accountId: string; sessionId: string; title: string;
      project: string; jsonlPath: string; texts: string[];
    }> = [];

    for (const proc of activeProcs) {
      const jsonlPath = findJsonlPath(proc.sessionId);
      const dirName = findSessionDirName(proc.sessionId);
      const texts = jsonlPath ? extractRecentText(jsonlPath, TAIL_LINES) : [];
      activeSessions.push({
        accountId: proc.accountId,
        sessionId: proc.sessionId,
        title: titles[proc.sessionId] || '',
        project: decodeDirName(dirName).split('/').pop() || dirName,
        jsonlPath: jsonlPath || '',
        texts,
      });
    }

    // 2. Collect recently finished sessions (idle with known sessionId, last 2h)
    const recentSessions: Array<{
      accountId: string; sessionId: string; title: string;
      project: string; jsonlPath: string; texts: string[]; finishedAgo: string;
    }> = [];

    const now = Date.now();
    for (const [accountId, state] of Object.entries(states)) {
      if (state.state === 'working') continue; // Already in active
      if (!state.sessionId) continue;
      const age = now - state.since;
      if (age > RECENTLY_FINISHED_WINDOW_MS) continue;
      // Skip if already in active list
      if (activeSessions.some(a => a.sessionId === state.sessionId)) continue;

      const jsonlPath = findJsonlPath(state.sessionId);
      const dirName = findSessionDirName(state.sessionId);
      const texts = jsonlPath ? extractRecentText(jsonlPath, 20) : []; // fewer lines for finished
      const minutes = Math.round(age / 60000);
      recentSessions.push({
        accountId,
        sessionId: state.sessionId,
        title: titles[state.sessionId] || '',
        project: decodeDirName(dirName).split('/').pop() || dirName,
        jsonlPath: jsonlPath || '',
        texts,
        finishedAgo: minutes < 60 ? `vor ${minutes}min` : `vor ${Math.round(minutes / 60)}h`,
      });
    }

    // 3. Skip if nothing to report
    if (activeSessions.length === 0 && recentSessions.length === 0) {
      const emptyContent = `# Parallele Claude Sessions\n_Zuletzt: ${new Date().toISOString()}_\n\nKeine aktiven Sessions.\n`;
      writeActiveWorkFile(emptyContent);
      updateTickMeta(0, 0);
      writeTeamContext();
      return;
    }

    // 4. Build input for Bridge summarization
    let bridgeInput = '';

    if (activeSessions.length > 0) {
      bridgeInput += '## AKTIV LAUFEND\n\n';
      for (const s of activeSessions.slice(0, MAX_SESSIONS_TO_SUMMARIZE)) {
        bridgeInput += `### ${s.accountId} — ${s.project} — "${s.title || 'Untitled'}"\n`;
        bridgeInput += s.texts.slice(-10).join('\n') + '\n\n'; // last 10 text messages
      }
    }

    if (recentSessions.length > 0) {
      bridgeInput += '## KÜRZLICH BEENDET\n\n';
      for (const s of recentSessions.slice(0, 10)) {
        bridgeInput += `### ${s.accountId} — ${s.project} — "${s.title || 'Untitled'}" (${s.finishedAgo})\n`;
        bridgeInput += s.texts.slice(-5).join('\n') + '\n\n';
      }
    }

    // 5. Summarize via Bridge
    const summary = await summarizeViaBridge(bridgeInput);

    // 6. Build output file
    const lines: string[] = [
      `# Parallele Claude Sessions`,
      `_Zuletzt aktualisiert: ${new Date().toISOString()}_`,
      `_Nächstes Update: ~5 Minuten_`,
      '',
      summary,
      '',
    ];

    // Add JSONL paths for self-service deep-dive
    if (activeSessions.length > 0) {
      lines.push('## JSONL Pfade (zum Nachlesen)');
      lines.push('');
      for (const s of activeSessions) {
        lines.push(`- **${s.accountId}** (${s.project}): \`${s.jsonlPath}\``);
      }
      lines.push('');
    }

    // Instructions for Claude sessions
    lines.push('## Anleitung für Claude Sessions');
    lines.push('');
    lines.push('Falls eine Überschneidung mit deiner geplanten Arbeit besteht:');
    lines.push('1. STOPP — frage Rafael bevor du weitermachst');
    lines.push('2. Für Details einer Session: `tail -100 <JSONL-Pfad>` lesen');
    lines.push('3. Nur die `message.content` Felder mit `role: user/assistant` sind relevant');
    lines.push('');

    writeActiveWorkFile(lines.join('\n'));

    updateTickMeta(activeSessions.length, recentSessions.length);
    const bridgeUsed = !!process.env.AI_BRIDGE_API_KEY;
    logBackgroundEvent('peer', 'tick', `Updated: ${activeSessions.length} active, ${recentSessions.length} recent`, { active: activeSessions.length, recent: recentSessions.length, bridge: bridgeUsed });
    console.log(`[PeerAwareness] Updated: ${activeSessions.length} active, ${recentSessions.length} recent`);

    // Also update team context on same schedule
    writeTeamContext();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[PeerAwareness] Tick error:', msg);
    logBackgroundEvent('peer', 'error', `Tick error: ${msg}`);
  }
}

function writeActiveWorkFile(content: string) {
  const dir = dirname(ACTIVE_WORK_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(ACTIVE_WORK_FILE, content);
}

// --- Public API ---

export function initPeerAwareness(deps: {
  getSessionStates: () => Record<string, any>;
  DATA_DIR: string;
}) {
  _getSessionStates = deps.getSessionStates;
  _DATA_DIR = deps.DATA_DIR;
  console.log(`[PeerAwareness] Initialized (interval=${PEER_TICK_MS / 1000}s, file=${ACTIVE_WORK_FILE})`);
}

export function startPeerAwarenessTimer() {
  if (_timer) clearInterval(_timer);
  // Run first tick after 30s (let server warm up), then every 5min
  setTimeout(() => {
    peerAwarenessTick();
    _timer = setInterval(peerAwarenessTick, PEER_TICK_MS);
  }, 30_000);
  console.log('[PeerAwareness] Timer started (first tick in 30s, then every 5min)');
}

export function stopPeerAwarenessTimer() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

// --- Last tick metadata (for API) ---
let _lastTickAt: number = 0;
let _lastTickActiveSessions = 0;
let _lastTickRecentSessions = 0;

// Update metadata in peerAwarenessTick (called from tick wrapper below)
function updateTickMeta(active: number, recent: number) {
  _lastTickAt = Date.now();
  _lastTickActiveSessions = active;
  _lastTickRecentSessions = recent;
}

// Force immediate update (for API endpoint)
export async function triggerPeerAwarenessUpdate(): Promise<void> {
  await peerAwarenessTick();
}

// --- Express Router (API endpoints) ---
export function createPeerAwarenessRouter(): Router {
  const router = Router();

  // GET /api/peer-awareness — read current active-work.md content
  router.get('/api/peer-awareness', (_req: Request, res: Response) => {
    let content = '';
    if (existsSync(ACTIVE_WORK_FILE)) {
      try { content = readFileSync(ACTIVE_WORK_FILE, 'utf8'); } catch { content = ''; }
    }
    res.json({
      content,
      filePath: ACTIVE_WORK_FILE,
      lastTickAt: _lastTickAt ? new Date(_lastTickAt).toISOString() : null,
      activeSessions: _lastTickActiveSessions,
      recentSessions: _lastTickRecentSessions,
      intervalMs: PEER_TICK_MS,
    });
  });

  // POST /api/peer-awareness/refresh — trigger immediate update
  router.post('/api/peer-awareness/refresh', async (_req: Request, res: Response) => {
    try {
      await peerAwarenessTick();
      const content = existsSync(ACTIVE_WORK_FILE) ? readFileSync(ACTIVE_WORK_FILE, 'utf8') : '';
      res.json({
        ok: true,
        content,
        lastTickAt: _lastTickAt ? new Date(_lastTickAt).toISOString() : null,
        activeSessions: _lastTickActiveSessions,
        recentSessions: _lastTickRecentSessions,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
