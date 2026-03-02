import { Router } from 'express';
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, unlinkSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import { exec } from 'child_process';
import { promisify } from 'util';

import type { AttentionReason, ConvAttentionState, SessionState, PanelVisibility, CuiProxy } from './shared/types.js';
import { logUserInput as sharedLogUserInput, getProxyPort as sharedGetProxyPort } from './shared/utils.js';

const execAsync = promisify(exec);

// --- Constants ---
const CUIFETCH_DEFAULT_TIMEOUT_MS = 8000;
const CONV_CACHE_TTL_MS = 15_000;
const CONV_CACHE_STALE_TTL_MS = 60_000;
const DEFAULT_CONV_LIMIT = 500;
const SEND_TIMEOUT_MS = 60_000;
const MAX_SEND_RETRIES = 2;
const FLUSH_WAIT_MS = 2000;
const MAX_TITLE_LENGTH = 60;
const MAX_TAIL_MESSAGES = 500;
const COMMANDER_CACHE_TTL_MS = 60_000;

// --- Dependencies (injected via init) ---
let CUI_PROXIES: CuiProxy[];
let broadcast: (data: Record<string, unknown>) => void;
let sessionStates: Map<string, SessionState>;
let setSessionState: (key: string, accountId: string, state: ConvAttentionState, reason?: AttentionReason, sessionId?: string) => void;
let getSessionStates: () => Record<string, SessionState>;
let DATA_DIR: string;
let PROJECTS_DIR: string;
let PORT: number;
let monitorStream: (targetBase: string, streamingId: string, cuiId: string, authHeaders: Record<string, string>) => Promise<'ended' | 'error' | 'timeout'>;
let activeStreams: Map<string, string>;
let visibilityRegistry: Map<string, PanelVisibility>;
let getVisibleSessionIds: () => Set<string>;

export interface MissionDeps {
  CUI_PROXIES: CuiProxy[];
  broadcast: (data: Record<string, unknown>) => void;
  sessionStates: Map<string, SessionState>;
  setSessionState: (key: string, accountId: string, state: ConvAttentionState, reason?: AttentionReason, sessionId?: string) => void;
  getSessionStates: () => Record<string, SessionState>;
  DATA_DIR: string;
  PROJECTS_DIR: string;
  PORT: number;
  monitorStream: (targetBase: string, streamingId: string, cuiId: string, authHeaders: Record<string, string>) => Promise<'ended' | 'error' | 'timeout'>;
  activeStreams: Map<string, string>;
  visibilityRegistry: Map<string, PanelVisibility>;
  getVisibleSessionIds: () => Set<string>;
}

export function initMissionRouter(deps: MissionDeps) {
  CUI_PROXIES = deps.CUI_PROXIES;
  broadcast = deps.broadcast;
  sessionStates = deps.sessionStates;
  setSessionState = deps.setSessionState;
  getSessionStates = deps.getSessionStates;
  DATA_DIR = deps.DATA_DIR;
  PROJECTS_DIR = deps.PROJECTS_DIR;
  PORT = deps.PORT;
  monitorStream = deps.monitorStream;
  activeStreams = deps.activeStreams;
  visibilityRegistry = deps.visibilityRegistry;
  getVisibleSessionIds = deps.getVisibleSessionIds;

  // Initialize file paths
  TITLES_FILE = join(DATA_DIR, 'titles.json');
  ASSIGNMENTS_FILE = join(DATA_DIR, 'conv-accounts.json');
  WORKDIRS_FILE = join(DATA_DIR, 'conv-workdirs.json');
  FINISHED_FILE = join(DATA_DIR, 'conv-finished.json');
  LAST_PROMPT_FILE = join(DATA_DIR, 'conv-last-prompt.json');
  INPUT_LOG_FILE = join(DATA_DIR, 'input-log.jsonl');
  buildSessionProjectMap();
}

// --- Session -> Project mapping (built from JSONL directory structure) ---
let _sessionProjectMap: Record<string, { projectName: string; projectPath: string }> = {};
let _sessionMapBuiltAt = 0;

function buildSessionProjectMap(): void {
  const map: typeof _sessionProjectMap = {};
  const projectConfigs: Array<{ id: string; name: string; workDir: string; encoded: string }> = [];
  try {
    for (const f of readdirSync(PROJECTS_DIR).filter(f => f.endsWith('.json'))) {
      const p = JSON.parse(readFileSync(join(PROJECTS_DIR, f), 'utf8'));
      if (p.workDir) projectConfigs.push({ id: p.id, name: p.name, workDir: p.workDir, encoded: p.workDir.replace(/\//g, '-') });
    }
  } catch (e: any) { console.warn("[Mission] projectConfigs load error:", e?.message); }
  const extraPaths: Record<string, { name: string; path: string }> = {
    '-root-projekte-orchestrator': { name: 'orchestrator', path: '/root/projekte/orchestrator' },
    '-root-projekte-werkingflow': { name: 'werkingflow', path: '/root/projekte/werkingflow' },
    '-root': { name: 'root', path: '/root' },
    '-tmp': { name: 'tmp', path: '/tmp' },
    '-home-claude-user': { name: 'claude-user', path: '/home/claude-user' },
  };
  const acctDirs = [
    '/home/claude-user/.cui-account1/.claude/projects',
    '/home/claude-user/.cui-account2/.claude/projects',
    '/home/claude-user/.cui-account3/.claude/projects',
  ];
  for (const base of acctDirs) {
    try { if (!statSync(base).isDirectory()) continue; } catch { continue; }
    for (const dirname of readdirSync(base)) {
      const dirpath = join(base, dirname);
      try { if (!statSync(dirpath).isDirectory()) continue; } catch { continue; }
      let projName: string | null = null;
      let projPath: string | null = null;
      for (const pc of projectConfigs) {
        if (dirname === pc.encoded) { projName = pc.name; projPath = pc.workDir; break; }
      }
      if (!projName && extraPaths[dirname]) { projName = extraPaths[dirname].name; projPath = extraPaths[dirname].path; }
      if (!projName) { projName = dirname.replace(/^-/, '').split('-').pop() || dirname; projPath = dirname; }
      try {
        for (const f of readdirSync(dirpath)) {
          if (f.endsWith('.jsonl')) {
            map[f.slice(0, -6)] = { projectName: projName, projectPath: projPath || dirname };
          }
        }
      } catch (e: any) { console.warn("[Mission] projectConfigs load error:", e?.message); }
    }
  }
  _sessionProjectMap = map;
  _sessionMapBuiltAt = Date.now();
  console.log("[Mission] Session-project map: " + Object.keys(map).length + " sessions, " + projectConfigs.length + " project configs loaded");
}

function getSessionProject(sessionId: string): { projectName: string; projectPath: string } | null {
  if (Date.now() - _sessionMapBuiltAt > 60000) buildSessionProjectMap();
  return _sessionProjectMap[sessionId] || null;
}

// --- Local conversation titles (CUI API doesn't support custom_name) ---
let TITLES_FILE: string;
function loadTitles(): Record<string, string> {
  if (!existsSync(TITLES_FILE)) return {};
  try { return JSON.parse(readFileSync(TITLES_FILE, 'utf8')); } catch (err) { console.warn('[Mission] Failed to load TITLES_FILE:', err instanceof Error ? err.message : err); return {}; }
}
function saveTitle(sessionId: string, title: string) {
  const titles = loadTitles();
  titles[sessionId] = title;
  writeFileSync(TITLES_FILE, JSON.stringify(titles, null, 2));
}
function getTitle(sessionId: string): string {
  return loadTitles()[sessionId] || '';
}

// Auto-generate a clean title from summary text (no LLM needed)
function autoTitleFromSummary(summary: string): string {
  if (!summary) return '';
  // Take first line, clean up
  let title = summary.split('\n')[0].replace(/\s+/g, ' ').trim();
  // Skip unhelpful summaries
  if (title.startsWith('API Error') || title.startsWith('{') || title.startsWith('Error:')) return '';
  // Remove common prefixes that aren't useful titles
  title = title.replace(/^(Hey Chat|Hey Claude|Hi Claude|Hallo)[,\s-]*/i, '').trim();
  // Skip if too short or too generic
  if (title.length < 3) return '';
  // Truncate
  if (title.length > MAX_TITLE_LENGTH) title = title.slice(0, MAX_TITLE_LENGTH - 3) + '...';
  return title;
}

// Background: auto-title untitled conversations (runs async, no blocking)
function autoTitleUntitled(results: Array<{ sessionId: string; summary: string; customName: string }>) {
  const untitled = results.filter(r => !r.customName && r.summary);
  if (untitled.length === 0) return;
  const titles = loadTitles();
  let saved = 0;
  for (const r of untitled) {
    if (titles[r.sessionId]) continue; // Already titled
    const title = autoTitleFromSummary(r.summary);
    if (title) {
      titles[r.sessionId] = title;
      saved++;
    }
  }
  if (saved > 0) {
    writeFileSync(TITLES_FILE, JSON.stringify(titles, null, 2));
    console.log(`[AutoTitle] Generated ${saved} titles from summaries`);
  }
}

// --- Conversation Account Assignment ---
// Tracks which account a conversation belongs to (avoids duplicate display)
let ASSIGNMENTS_FILE: string;
function loadAssignments(): Record<string, string> {
  if (!existsSync(ASSIGNMENTS_FILE)) return {};
  try { return JSON.parse(readFileSync(ASSIGNMENTS_FILE, 'utf8')); } catch (err) { console.warn('[Mission] Failed to load ASSIGNMENTS_FILE:', err instanceof Error ? err.message : err); return {}; }
}
function saveAssignment(sessionId: string, accountId: string) {
  const assignments = loadAssignments();
  if (assignments[sessionId] === accountId) return; // No change
  assignments[sessionId] = accountId;
  writeFileSync(ASSIGNMENTS_FILE, JSON.stringify(assignments, null, 2));
}
function getAssignment(sessionId: string): string {
  return loadAssignments()[sessionId] || '';
}

// --- Conversation WorkDir Persistence ---
// Tracks the workDir for each conversation (survives account switches)
let WORKDIRS_FILE: string;
function loadWorkDirs(): Record<string, string> {
  if (!WORKDIRS_FILE || !existsSync(WORKDIRS_FILE)) return {};
  try { return JSON.parse(readFileSync(WORKDIRS_FILE, 'utf8')); } catch (err) { console.warn('[Mission] loadWorkDirs parse error:', err instanceof Error ? err.message : err); return {}; }
}
function saveWorkDir(sessionId: string, workDir: string) {
  if (!workDir || workDir === '/root/projekte') return;
  const workDirs = loadWorkDirs();
  if (workDirs[sessionId] === workDir) return;
  workDirs[sessionId] = workDir;
  writeFileSync(WORKDIRS_FILE, JSON.stringify(workDirs, null, 2));
}
function getWorkDir(sessionId: string): string {
  return loadWorkDirs()[sessionId] || '';
}

// --- Manual Finished Status ---
// Lets users mark conversations as "finished" even if CUI still says "ongoing"
let FINISHED_FILE: string;
function loadFinished(): Record<string, boolean> {
  if (!existsSync(FINISHED_FILE)) return {};
  try { return JSON.parse(readFileSync(FINISHED_FILE, 'utf8')); } catch (err) { console.warn('[Mission] Failed to load FINISHED_FILE:', err instanceof Error ? err.message : err); return {}; }
}
function setFinished(sessionId: string, finished: boolean) {
  const data = loadFinished();
  if (finished) data[sessionId] = true;
  else delete data[sessionId];
  writeFileSync(FINISHED_FILE, JSON.stringify(data, null, 2));
}
function isFinished(sessionId: string): boolean {
  return loadFinished()[sessionId] === true;
}

// Track when user last sent a prompt per conversation
let LAST_PROMPT_FILE: string;
let _lastPromptCache: Record<string, string> | null = null;
function loadLastPrompt(): Record<string, string> {
  if (_lastPromptCache) return _lastPromptCache;
  if (!existsSync(LAST_PROMPT_FILE)) { _lastPromptCache = {}; return _lastPromptCache; }
  try { _lastPromptCache = JSON.parse(readFileSync(LAST_PROMPT_FILE, 'utf8')); return _lastPromptCache!; } catch (err) { console.warn('[Mission] Failed to load LAST_PROMPT_FILE:', err instanceof Error ? err.message : err); _lastPromptCache = {}; return _lastPromptCache; }
}
function setLastPrompt(sessionId: string) {
  const data = loadLastPrompt();
  data[sessionId] = new Date().toISOString();
  _lastPromptCache = data;
  writeFileSync(LAST_PROMPT_FILE, JSON.stringify(data, null, 2));
}

// --- User Input Log ---
// Persistent log of all user inputs (subject + message) from Queue/Commander
let INPUT_LOG_FILE: string;
function logUserInput(entry: { type: string; accountId: string; workDir?: string; subject?: string; message: string; sessionId?: string; result: 'ok' | 'error'; error?: string }) {
  sharedLogUserInput(INPUT_LOG_FILE, entry);
}

// Deduplicate conversations by sessionId (remote accounts share sessions)
function deduplicateConversations(results: any[]): any[] {
  const assignments = loadAssignments();
  const bySessionId = new Map<string, any[]>();

  for (const r of results) {
    const existing = bySessionId.get(r.sessionId) || [];
    existing.push(r);
    bySessionId.set(r.sessionId, existing);
  }

  const deduped: any[] = [];
  for (const [sessionId, entries] of bySessionId) {
    if (entries.length === 1) {
      deduped.push(entries[0]);
      continue;
    }

    // Multiple accounts have this conversation — pick the best one
    const assigned = assignments[sessionId];

    // Priority: 1) streaming, 2) ongoing, 3) assigned account, 4) preferred order (rafael > engelmann > office)
    const streaming = entries.find(e => e.streamingId);
    const ongoing = entries.find(e => e.status === 'ongoing');
    let best: any;

    if (streaming) {
      best = streaming;
      saveAssignment(sessionId, streaming.accountId);
    } else if (ongoing) {
      best = ongoing;
      saveAssignment(sessionId, ongoing.accountId);
    } else if (assigned) {
      best = entries.find(e => e.accountId === assigned) || entries[0];
    } else {
      // No assignment yet — prefer rafael > engelmann > office
      const preferOrder = ['rafael', 'engelmann', 'office', 'local'];
      best = entries[0];
      for (const pref of preferOrder) {
        const match = entries.find(e => e.accountId === pref);
        if (match) { best = match; break; }
      }
    }

    deduped.push(best);
  }

  return deduped;
}

// --- Helper: fetch JSON from a CUI proxy ---
async function cuiFetch(proxyPort: number, path: string, options?: { method?: string; body?: string; timeoutMs?: number }): Promise<{ data: any; ok: boolean; status: number; error?: string }> {
  const url = `http://localhost:${proxyPort}${path}`;
  const controller = new AbortController();
  const ms = options?.timeoutMs ?? CUIFETCH_DEFAULT_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, {
      method: options?.method || 'GET',
      headers: options?.body ? { 'Content-Type': 'application/json' } : {},
      body: options?.body,
      signal: controller.signal,
    });
    const data = await res.json();
    if (!res.ok) {
      const errMsg = data?.error?.message || data?.error?.code || data?.message || data?.error || `HTTP ${res.status}`;
      return { data, ok: false, status: res.status, error: String(errMsg) };
    }
    return { data, ok: true, status: res.status };
  } catch (err: any) {
    const msg = err?.name === 'AbortError' ? `timeout (${ms / 1000}s)` : (err?.cause?.code === 'ECONNREFUSED' ? 'connection refused' : (err?.message || 'network error'));
    return { data: null, ok: false, status: 0, error: msg };
  } finally {
    clearTimeout(timeout);
  }
}

// Helper: resolve projectPath → project name
function resolveProjectName(projectPath: string): string {
  const projects = readdirSync(PROJECTS_DIR).filter(f => f.endsWith('.json'));
  for (const f of projects) {
    try {
      const p = JSON.parse(readFileSync(join(PROJECTS_DIR, f), 'utf8'));
      if (p.workDir && projectPath.includes(p.id)) return p.name;
    } catch (err) { console.warn('[Mission] Failed to parse project file:', f, err instanceof Error ? err.message : err); }
  }
  // Fallback: extract last segment
  return projectPath.split('/').filter(Boolean).pop() || projectPath;
}

// Helper: get proxy port for account
function getProxyPort(accountId: string): number | null {
  return sharedGetProxyPort(CUI_PROXIES, accountId);
}

// --- Conversation List Cache (stale-while-revalidate) ---
let _convCache: { data: any; timestamp: number; refreshing: boolean } = { data: null, timestamp: 0, refreshing: false };

function invalidateConvCache() {
  _convCache.timestamp = 0;
}

// 1. List all conversations across all accounts
async function fetchConvList() {
  const results: any[] = [];

  await Promise.allSettled(CUI_PROXIES.map(async (proxy) => {
    const resp = await cuiFetch(proxy.localPort, `/api/conversations?limit=${DEFAULT_CONV_LIMIT}&sortBy=updated&order=desc`, { timeoutMs: 30000 });
    if (!resp.ok || !resp.data?.conversations) return;
    for (const c of resp.data.conversations) {
      const _sp = getSessionProject(c.sessionId);
      results.push({
        sessionId: c.sessionId,
        accountId: proxy.id,
        accountLabel: ({ rafael: 'Engelmann', engelmann: 'Gmail', office: 'Office', local: 'Lokal' } as Record<string, string>)[proxy.id] || proxy.id,
        accountColor: { rafael: '#7aa2f7', engelmann: '#bb9af7', office: '#9ece6a', local: '#e0af68' }[proxy.id] || '#666',
        proxyPort: proxy.localPort,
        projectPath: _sp?.projectPath || c.projectPath || '',
        projectName: _sp?.projectName || resolveProjectName(c.projectPath || ''),
        summary: c.summary || '',
        customName: getTitle(c.sessionId) || c.sessionInfo?.custom_name || '',
        status: c.status || 'completed',
        streamingId: c.streamingId || null,
        model: c.model || '',
        messageCount: c.messageCount || 0,
        updatedAt: c.updatedAt || c.sessionInfo?.updated_at || '',
        createdAt: c.createdAt || c.sessionInfo?.created_at || '',
      });
    }
  }));

  const promptTimes = loadLastPrompt();
  for (const r of results) {
    r.lastPromptAt = promptTimes[r.sessionId] || '';
  }

  results.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'ongoing' ? -1 : 1;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });

  autoTitleUntitled(results);
  const freshTitles = loadTitles();
  for (const r of results) {
    if (!r.customName && freshTitles[r.sessionId]) {
      r.customName = freshTitles[r.sessionId];
    }
  }

  const deduped = deduplicateConversations(results);

  const states = getSessionStates();
  for (const conv of deduped) {
    const stateInfo = states[conv.accountId];
    if (stateInfo) {
      (conv as any).attentionState = stateInfo.state;
      (conv as any).attentionReason = stateInfo.reason;
    }
  }

  const finished = loadFinished();
  for (const conv of deduped) {
    if (finished[conv.sessionId]) {
      (conv as any).manualFinished = true;
    }
  }

  const visibleIds = getVisibleSessionIds();
  for (const conv of deduped) {
    (conv as any).isVisible = visibleIds.has(conv.sessionId);
  }

  return { conversations: deduped, total: deduped.length };
}

// Find JSONL file path for a session across all project dirs
function findJsonlPath(sessionId: string): string | null {
  const cuiProjectsDir = join(homedir(), '.claude', 'projects');
  if (!existsSync(cuiProjectsDir)) return null;
  for (const dir of readdirSync(cuiProjectsDir)) {
    const dirPath = join(cuiProjectsDir, dir);
    try { if (!statSync(dirPath).isDirectory()) continue; } catch { continue; }
    const filePath = join(dirPath, `${sessionId}.jsonl`);
    if (existsSync(filePath)) return filePath;
  }
  return null;
}

// Comprehensive JSONL sanitizer — fixes ALL known corruption patterns:
// 1. Remove ALL queue-operation entries (CUI binary bookkeeping, not conversation)
// 2. Remove ALL progress entries (streaming artifacts)
// 3. Remove synthetic error messages (rate limit, billing)
// 4. Fix write-corrupted lines (two JSON objects concatenated on one line)
// 5. Remove consecutive duplicate user messages (orphaned sends)
// 6. Remove trailing truncated assistant if it's the very last entry with no content
// 7. Ensure conversation ends cleanly (last entry = assistant or single user)
function unstickConversation(sessionId: string): number {
  const filePath = findJsonlPath(sessionId);
  if (!filePath) return 0;
  try {
    const rawLines = readFileSync(filePath, 'utf-8').split('\n');
    const cleanLines: string[] = [];
    let totalRemoved = 0;

    // Phase 1: Parse all lines, fix corrupted ones, filter non-conversation entries
    for (const rawLine of rawLines) {
      const line = rawLine.trim();
      if (!line) continue;
      // Try to parse — handle write-corruption (two JSON objects on one line)
      let objects: any[] = [];
      try {
        objects = [JSON.parse(line)];
      } catch {
        // Try splitting concatenated JSON objects: }{"type":...
        const parts = line.split(/(?<=\})\s*(?=\{)/);
        for (const part of parts) {
          try { objects.push(JSON.parse(part)); } catch { /* skip unparseable */ }
        }
        if (objects.length === 0) { totalRemoved++; continue; } // completely broken line
        if (objects.length > 1) {
          console.log(`[Sanitize] ${sessionId.slice(0, 8)}: split corrupted line into ${objects.length} objects`);
        }
      }

      for (const obj of objects) {
        const type = obj.type;
        // Remove non-conversation entries
        if (type === 'queue-operation' || type === 'progress') { totalRemoved++; continue; }
        // Remove synthetic errors
        if (obj.isApiErrorMessage === true) { totalRemoved++; continue; }
        if (obj.message?.model === '<synthetic>') { totalRemoved++; continue; }
        // Keep conversation entries: user, assistant, system, summary, file-history-snapshot
        cleanLines.push(JSON.stringify(obj));
      }
    }

    // Phase 2: Fix conversation structure — remove orphaned/duplicate entries at the tail
    // Walk backwards from the end to find a clean conversation boundary
    let cutIndex = cleanLines.length;
    let trailingUsers = 0;
    for (let i = cleanLines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(cleanLines[i]);
        const role = obj.message?.role;
        if (role === 'assistant') {
          // Check if this assistant message has actual content (not truncated/empty)
          const content = obj.message?.content;
          const hasContent = Array.isArray(content) ? content.length > 0 : !!content;
          if (hasContent) {
            cutIndex = i + 1 + trailingUsers; // Keep one trailing user if present
            break;
          }
          // Empty/truncated assistant — remove it too
          continue;
        }
        if (role === 'user') {
          trailingUsers++;
          if (trailingUsers > 1) {
            // Multiple trailing users — only keep the last one
            cleanLines.splice(i, 1);
            totalRemoved++;
            trailingUsers--;
          }
          continue;
        }
        // Non-user/assistant at the tail (summary, file-history-snapshot) — skip over
      } catch { break; }
    }

    // Phase 3: Remove orphaned tool_result entries (user messages with tool_result
    // that reference tool_use_ids not present in the preceding assistant message)
    const finalClean: string[] = [];
    for (let i = 0; i < cutIndex && i < cleanLines.length; i++) {
      try {
        const obj = JSON.parse(cleanLines[i]);
        const role = obj.message?.role;
        const content = obj.message?.content;
        if (role === 'user' && Array.isArray(content) && content.length > 0 &&
            content.every((c: any) => c.type === 'tool_result')) {
          // Find preceding assistant message
          let prevAssistant: any = null;
          for (let j = finalClean.length - 1; j >= 0; j--) {
            try {
              const prev = JSON.parse(finalClean[j]);
              if (prev.message?.role === 'assistant') { prevAssistant = prev; break; }
            } catch { /* skip */ }
          }
          if (prevAssistant) {
            const prevContent = prevAssistant.message?.content;
            const toolUseIds = new Set<string>();
            if (Array.isArray(prevContent)) {
              for (const block of prevContent) {
                if (block.type === 'tool_use' && block.id) toolUseIds.add(block.id);
              }
            }
            const allMatched = content.every((c: any) => toolUseIds.has(c.tool_use_id));
            if (!allMatched) {
              totalRemoved++;
              console.log(`[Sanitize] ${sessionId.slice(0, 8)}: removed orphaned tool_result (refs: ${content.map((c: any) => c.tool_use_id?.slice(0, 12)).join(', ')})`);
              continue; // skip this line
            }
          } else {
            // tool_result with no preceding assistant at all — remove
            totalRemoved++;
            continue;
          }
        }
        finalClean.push(cleanLines[i]);
      } catch {
        finalClean.push(cleanLines[i]); // keep unparseable lines
      }
    }

    if (totalRemoved > 0) {
      const finalLines = finalClean.join('\n') + '\n';
      writeFileSync(filePath, finalLines);
      console.log(`[Sanitize] ${sessionId.slice(0, 8)}: removed ${totalRemoved} entries (${rawLines.length}→${finalClean.length} lines)`);
    }
    return totalRemoved;
  } catch (err) {
    console.error(`[Sanitize] ${sessionId.slice(0, 8)}: error: ${(err as Error).message}`);
    return 0;
  }
}

// Deep JSONL repair — called when normal sanitize wasn't enough and CLI still rejects the session.
// Aggressively strips trailing entries until we find a clean assistant→user boundary.
// The CLI error "result/error_during_execution" usually means it can't process the tail of the JSONL.
function deepRepairJsonl(sessionId: string): number {
  const filePath = findJsonlPath(sessionId);
  if (!filePath) return 0;
  try {
    const lines = readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim());
    if (lines.length < 2) return 0;

    // Strategy: walk backwards, remove entries until we find a clean boundary:
    // assistant message with actual content, followed by at most one user message
    let removed = 0;
    let cutAt = lines.length;
    let foundCleanAssistant = false;

    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        const role = obj.message?.role;

        if (role === 'assistant') {
          const content = obj.message?.content;
          const hasText = Array.isArray(content)
            ? content.some((c: any) => c.type === 'text' && c.text?.length > 0)
            : typeof content === 'string' && content.length > 0;
          if (hasText) {
            // Found a good assistant message — cut here (keep this + everything before)
            cutAt = i + 1;
            foundCleanAssistant = true;
            break;
          }
          // Assistant with only tool_use or empty — also a valid boundary
          const hasToolUse = Array.isArray(content)
            ? content.some((c: any) => c.type === 'tool_use')
            : false;
          if (hasToolUse) {
            cutAt = i + 1;
            foundCleanAssistant = true;
            break;
          }
        }
        // Keep removing until we find the boundary
      } catch { /* skip unparseable */ }
    }

    if (!foundCleanAssistant) return 0; // Don't repair if we can't find any clean point

    removed = lines.length - cutAt;
    if (removed > 0) {
      writeFileSync(filePath, lines.slice(0, cutAt).join('\n') + '\n');
      console.log(`[DeepRepair] ${sessionId.slice(0, 8)}: stripped ${removed} trailing entries (${lines.length}→${cutAt})`);
    }
    return removed;
  } catch (err) {
    console.error(`[DeepRepair] ${sessionId.slice(0, 8)}: error: ${(err as Error).message}`);
    return 0;
  }
}

// Verify if a send actually produced an assistant response in the JSONL
function verifySendSuccess(sessionId: string): 'success' | 'no_response' | 'rate_limit' | 'no_file' {
  const jsonlPath = findJsonlPath(sessionId);
  if (!jsonlPath) return 'no_file';
  const content = readFileSync(jsonlPath, "utf-8");
  const lines = content.trim().split("\n").filter(Boolean);
  // Walk backwards through last 10 lines
  const start = Math.max(0, lines.length - 10);
  for (let i = lines.length - 1; i >= start; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      // Rate limit = synthetic error
      if (entry.isApiErrorMessage === true || entry.message?.model === '<synthetic>') return 'rate_limit';
      // Assistant response = success
      if (entry.message?.role === 'assistant' && entry.message?.model !== '<synthetic>') return 'success';
      // User message without assistant after it = no response yet
      if (entry.message?.role === 'user') return 'no_response';
    } catch { continue; }
  }
  return 'no_response';
}

// --- Router ---
const router = Router();

// 1. List all conversations
router.get('/conversations', async (req, res) => {
  try {
  const filterProject = req.query.project as string | undefined;
  const now = Date.now();
  const age = now - _convCache.timestamp;

  let data: any = null;

  // Serve from cache if fresh
  if (_convCache.data && age < CONV_CACHE_TTL_MS) {
    data = _convCache.data;
  }
  // Serve stale cache while refreshing in background
  else if (_convCache.data && age < CONV_CACHE_STALE_TTL_MS && !_convCache.refreshing) {
    _convCache.refreshing = true;
    data = _convCache.data;
    (async () => {
      try {
        const fresh = await fetchConvList();
        _convCache = { data: fresh, timestamp: Date.now(), refreshing: false };
      } catch (err) { console.warn('[Mission] Background conv cache refresh failed:', err instanceof Error ? err.message : err); _convCache.refreshing = false; }
    })();
  }
  // Cache miss or too stale — blocking fetch (always unfiltered for cache)
  else {
    const fresh = await fetchConvList();
    _convCache = { data: fresh, timestamp: Date.now(), refreshing: false };
    data = fresh;
  }

  // Apply project filter AFTER cache
  if (filterProject && data) {
    const filtered = { ...data, conversations: data.conversations.filter((c: any) => (c.projectPath || '').includes(filterProject)), total: 0 };
    filtered.total = filtered.conversations.length;
    return res.json(filtered);
  }
  res.json(data);
  } catch (err: any) {
    // Serve stale cache on error
    if (_convCache.data) return res.json(_convCache.data);
    console.warn('[Server] GET /api/mission/conversations error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// 2. Get conversation detail (last N messages)
router.get('/conversation/:accountId/:sessionId', async (req, res) => {
  try {
  const port = getProxyPort(req.params.accountId);
  if (!port) { res.status(400).json({ error: 'unknown account' }); return; }

  const tail = Math.min(Math.max(parseInt(req.query.tail as string) || 10, 1), MAX_TAIL_MESSAGES);
  let [convResult, permResult] = await Promise.allSettled([
    cuiFetch(port, `/api/conversations/${req.params.sessionId}`),
    cuiFetch(port, `/api/permissions?streamingId=&status=pending`),
  ]);
  let convResp = convResult.status === 'fulfilled' ? convResult.value : { data: null, ok: false, status: 0, error: 'conversation fetch failed' };
  let permResp = permResult.status === 'fulfilled' ? permResult.value : { data: { permissions: [] }, ok: true, status: 200 };

  // Auto-fix corrupted JSONL on load failure (queue-operation as first line, etc.)
  if (!convResp.ok) {
    const cleaned = unstickConversation(req.params.sessionId);
    if (cleaned > 0) {
      console.log(`[Load] Auto-cleaned ${cleaned} entries from ${req.params.sessionId}, retrying...`);
      convResp = await cuiFetch(port, `/api/conversations/${req.params.sessionId}`);
    }
  }
  if (!convResp.ok) { res.status(502).json({ error: convResp.error || 'CUI unreachable' }); return; }

  // Transform CUI message format, detect rate limits, filter noise
  const allMessages: any[] = convResp.data.messages || [];

  // Supplement: CUI binary sometimes misses the last JSONL entry (off-by-one).
  // Read the JSONL tail directly and append any messages the binary missed.
  const jsonlPath = findJsonlPath(req.params.sessionId);
  if (jsonlPath) {
    try {
      const rawTail = readFileSync(jsonlPath, 'utf-8').split('\n');
      const lastLines = rawTail.filter(l => l.trim()).slice(-5);
      const lastBinaryTs = allMessages.length > 0 ? allMessages[allMessages.length - 1].timestamp : '';
      for (const line of lastLines) {
        try {
          const obj = JSON.parse(line);
          if (obj.timestamp && obj.timestamp > lastBinaryTs && obj.message?.role) {
            allMessages.push(obj);
          }
        } catch { /* skip unparseable */ }
      }
    } catch { /* JSONL read failed, binary data is good enough */ }
  }
  // Detect if the LAST message is a synthetic error (rate limit or API error)
  let rateLimited = false;
  let hasApiError = false;
  let errorText = '';
  for (let i = allMessages.length - 1; i >= Math.max(0, allMessages.length - 3); i--) {
    const m = allMessages[i];
    const isSynthetic = m.isApiErrorMessage === true || m.message?.model === '<synthetic>';
    if (isSynthetic) {
      errorText = m.message?.content?.[0]?.text || m.error || '';
      const isRateLimit = /rate.?limit|usage.?limit|too many requests|429/i.test(errorText);
      if (isRateLimit) { rateLimited = true; } else { hasApiError = true; }
      break;
    }
    if (m.message?.role === 'assistant') break;
  }
  // Find index of last real assistant message to distinguish trailing vs old synthetic messages
  let lastAssistantIdx = -1;
  for (let i = allMessages.length - 1; i >= 0; i--) {
    const m = allMessages[i];
    if (m.message?.role === 'assistant' && !m.isApiErrorMessage && m.message?.model !== '<synthetic>') {
      lastAssistantIdx = i;
      break;
    }
  }
  const rawMessages = allMessages.filter((m: any, i: number) => {
    const isSynthetic = m.isApiErrorMessage === true || m.message?.model === '<synthetic>';
    // Keep trailing synthetic messages (after last real assistant) so user sees errors/rate limits
    if ((rateLimited || hasApiError) && isSynthetic && i > lastAssistantIdx) return true;
    // Filter all other synthetic messages
    if (isSynthetic) return false;
    // Filter orphaned "continue" user messages (unstick attempts before/after errors)
    const content = typeof m.message?.content === 'string' ? m.message.content.trim().toLowerCase() : '';
    if (content === 'continue' && m.message?.role === 'user') {
      const next = allMessages[i + 1];
      if (!next) return false; // trailing continue with no response
      if (next.isApiErrorMessage === true || next.message?.model === '<synthetic>') return false;
    }
    return true;
  });

  // Two visibility levels:
  // 1. "countable" = has TEXT the user actually reads (counts toward tail limit)
  // 2. "includable" = rendered in frontend (tool_use blocks show as badges)
  // 3. "excluded" = invisible noise (tool_result user messages, empty entries)
  function hasTextContent(m: any): boolean {
    const content = m.message?.content;
    if (typeof content === 'string') return content.trim().length > 0;
    if (Array.isArray(content)) return content.some((c: any) => c.type === 'text' && c.text?.trim());
    return false;
  }
  function isIncludable(m: any): boolean {
    const role = m.message?.role;
    const content = m.message?.content;
    if (role === 'user') {
      if (Array.isArray(content) && content.length > 0 && content.every((c: any) => c.type === 'tool_result')) return false;
      return true;
    }
    if (role === 'assistant') {
      if (typeof content === 'string') return content.trim().length > 0;
      if (Array.isArray(content)) {
        return content.some((c: any) => c.type === 'text' && c.text?.trim()) || content.some((c: any) => c.type === 'tool_use');
      }
      return false;
    }
    return true;
  }

  // Collect last `tail` TEXT messages, including tool_use messages in between
  let textCount = 0;
  let sliceFrom = rawMessages.length;
  for (let i = rawMessages.length - 1; i >= 0 && textCount < tail; i--) {
    if (hasTextContent(rawMessages[i])) textCount++;
    sliceFrom = i;
  }
  const messages = rawMessages.slice(sliceFrom)
    .filter((m: any) => isIncludable(m))  // Only send includable messages to frontend
    .map((m: any) => {
    // Map synthetic error messages to appropriate role
    const isSynthetic = m.isApiErrorMessage === true || m.message?.model === '<synthetic>';
    if (isSynthetic) {
      const errorText = m.message?.content?.[0]?.text || m.error || '';
      const isRateLimit = /rate.?limit|usage.?limit|too many requests|429/i.test(errorText);
      return {
        role: (isRateLimit ? 'rate_limit' : 'api_error') as any,
        content: errorText || (isRateLimit ? 'Rate limit reached' : 'API Fehler aufgetreten'),
        timestamp: m.timestamp || '',
      };
    }
    return {
      role: m.message?.role || m.type || 'user',
      content: m.message?.content || m.content || '',
      timestamp: m.timestamp || '',
    };
  });

  // Filter permissions to only include ones for THIS conversation's streaming session
  const convStreamingId = convResp.data.streamingId || convResp.data.metadata?.streamingId || '';
  const allPermissions: any[] = permResp.data?.permissions || [];
  const sessionPermissions = convStreamingId
    ? allPermissions.filter((p: any) => p.streamingId === convStreamingId)
    : []; // No streamingId → conversation not streaming → no pending permissions

  // Detect if conversation is idle (last message is assistant text, not waiting for tool_result)
  const lastRaw = rawMessages.length > 0 ? rawMessages[rawMessages.length - 1] : null;
  const lastRole = lastRaw?.message?.role;
  const lastContent = lastRaw?.message?.content;
  let hasPendingToolUse = false;
  if (Array.isArray(lastContent)) {
    hasPendingToolUse = lastContent.some((b: any) => b.type === 'tool_use');
  }
  const isAgentDone = lastRole === 'assistant' && !hasPendingToolUse && sessionPermissions.length === 0;

  res.json({
    messages,
    summary: convResp.data.summary || '',
    status: convResp.data.metadata?.status || 'completed',
    projectPath: convResp.data.projectPath || '',
    permissions: sessionPermissions,
    totalMessages: rawMessages.length,
    isAgentDone,
    rateLimited,
    rateLimitText: rateLimited ? errorText : undefined,
    apiError: hasApiError || undefined,
    apiErrorText: hasApiError ? errorText : undefined,
  });
  } catch (err: any) {
    console.warn('[Server] GET /api/mission/conversation detail error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// 3. Send message to existing conversation
router.post('/send', async (req, res) => {
  try {
  const { accountId, sessionId, message, workDir, useLocal } = req.body;
  if (!accountId || !sessionId || !message || (typeof message === 'string' && !message.trim())) {
    res.status(400).json({ error: 'accountId, sessionId, message required' });
    return;
  }
  // useLocal flag: route through local CUI server instead of remote
  const effectiveAccountId = useLocal ? 'local' : accountId;
  const port = getProxyPort(effectiveAccountId);
  if (!port) { res.status(400).json({ error: 'unknown account' }); return; }

  // Resolve workDir: validate explicit > persisted > default
  const isValidWorkDir = (d: string) => d && (d.startsWith('/root/projekte') || d.startsWith('/home/claude-user'));
  const resolvedWorkDir = (isValidWorkDir(workDir) ? workDir : null) || getWorkDir(sessionId) || '/root/projekte';
  // Persist workDir for future account switches
  if (workDir) saveWorkDir(sessionId, workDir);

  // Sanitize JSONL before resuming — removes queue-ops, progress, corrupted entries
  const cleaned = unstickConversation(sessionId);
  if (cleaned > 0) console.log(`[Send] Sanitized ${cleaned} entries from ${sessionId}`);

  let resp = await cuiFetch(port, '/api/conversations/start', {
    method: 'POST',
    timeoutMs: SEND_TIMEOUT_MS,
    body: JSON.stringify({
      workingDirectory: resolvedWorkDir,
      initialPrompt: message,
      resumedSessionId: sessionId,
    }),
  });

  // If resume failed, try deep repair: run sanitizer again (it's idempotent) then retry once
  let resumeFailed = false;
  if (!resp.ok && resp.error?.includes('system init')) {
    console.log(`[Send] Resume failed for ${sessionId}: ${resp.error} — attempting deep JSONL repair...`);
    // Deep repair: strip trailing entries that might confuse the CLI
    const deepCleaned = deepRepairJsonl(sessionId);
    if (deepCleaned > 0) {
      console.log(`[Send] Deep repair removed ${deepCleaned} more entries — retrying resume...`);
      resp = await cuiFetch(port, '/api/conversations/start', {
        method: 'POST',
        timeoutMs: SEND_TIMEOUT_MS,
        body: JSON.stringify({
          workingDirectory: resolvedWorkDir,
          initialPrompt: message,
          resumedSessionId: sessionId,
        }),
      });
    }
    // If still fails after repair, fall back to fresh session
    if (!resp.ok) {
      console.log(`[Send] Resume still failed after repair — starting fresh session`);
      resp = await cuiFetch(port, '/api/conversations/start', {
        method: 'POST',
        timeoutMs: SEND_TIMEOUT_MS,
        body: JSON.stringify({
          workingDirectory: resolvedWorkDir,
          initialPrompt: message,
        }),
      });
      resumeFailed = true;
    }
  }

  if (!resp.ok || !resp.data?.sessionId) {
    const errMsg = resp.error || 'CUI unreachable';
    logUserInput({ type: 'send', accountId, workDir, message, sessionId, result: 'error', error: errMsg });
    res.status(502).json({ error: errMsg });
    return;
  }
  const sendResult = resp.data;
  if (resumeFailed) {
    console.log(`[Send] Auto-recovered: old=${sessionId} → new=${sendResult.sessionId}`);
  }
  logUserInput({ type: 'send', accountId, workDir, message, sessionId: sendResult.sessionId || sessionId, result: 'ok' });
  saveAssignment(sendResult.sessionId || sessionId, accountId);
  saveWorkDir(sendResult.sessionId || sessionId, resolvedWorkDir);
  setLastPrompt(sendResult.sessionId || sessionId);

  const finalSessionId = sendResult.sessionId || sessionId;

  // Track state + respond immediately
  broadcast({ type: 'cui-state', cuiId: accountId, state: 'processing' });
  setSessionState(accountId, accountId, 'working', undefined, finalSessionId);
  invalidateConvCache();
  res.json({ ok: true, streamingId: sendResult.streamingId, sessionId: finalSessionId, resumeFailed });

  // Fire-and-forget: monitor with retry on silent failure
  let currentStreamingId = sendResult.streamingId;
  (async () => {
    for (let attempt = 0; attempt <= MAX_SEND_RETRIES; attempt++) {
      // 1. Await stream completion
      if (currentStreamingId) {
        await monitorStream(`http://localhost:${port}`, currentStreamingId, accountId, {});
      }
      // 2. Let JSONL flush
      await new Promise(r => setTimeout(r, FLUSH_WAIT_MS));
      // 3. Verify actual response in JSONL
      const result = verifySendSuccess(finalSessionId);
      if (result === 'success') return;
      if (result === 'rate_limit') {
        broadcast({ type: 'cui-state', cuiId: accountId, state: 'error', message: 'Rate Limit: Account hat das Nutzungslimit erreicht.' });
        setSessionState(accountId, accountId, 'idle', 'rate_limit', finalSessionId);
        return;
      }
      // no_response or no_file — retry if attempts remain
      if (attempt >= MAX_SEND_RETRIES) break;
      console.log(`[Send] Attempt ${attempt + 1} got no response for ${finalSessionId.slice(0, 8)} — retrying...`);
      unstickConversation(finalSessionId);
      await new Promise(r => setTimeout(r, 3000 * (attempt + 1)));
      const retryResp = await cuiFetch(port, '/api/conversations/start', {
        method: 'POST', timeoutMs: SEND_TIMEOUT_MS,
        body: JSON.stringify({ workingDirectory: resolvedWorkDir, initialPrompt: message, resumedSessionId: finalSessionId }),
      });
      if (!retryResp.ok || !retryResp.data?.streamingId) {
        console.log(`[Send] Retry ${attempt + 1} cuiFetch failed: ${retryResp.error}`);
        continue;
      }
      currentStreamingId = retryResp.data.streamingId;
      broadcast({ type: 'cui-state', cuiId: accountId, state: 'processing' });
      setSessionState(accountId, accountId, 'working', undefined, finalSessionId);
    }
    // All retries exhausted
    console.error(`[Send] All ${MAX_SEND_RETRIES + 1} attempts failed for ${finalSessionId.slice(0, 8)}`);
    broadcast({ type: 'cui-state', cuiId: accountId, state: 'error', message: 'Nachricht konnte nicht zugestellt werden. Bitte erneut versuchen.' });
    setSessionState(accountId, accountId, 'needs_attention', 'send_failed', finalSessionId);
  })();
  } catch (err: any) {
    console.warn('[Server] POST /api/mission/send error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// 4. Approve/deny permission
router.post('/permissions/:accountId/:permissionId', async (req, res) => {
  try {
    const port = getProxyPort(req.params.accountId);
    if (!port) { res.status(400).json({ error: 'unknown account' }); return; }

    const resp = await cuiFetch(port, `/api/permissions/${req.params.permissionId}/decision`, {
      method: 'POST',
      body: JSON.stringify({ action: req.body.action || 'approve' }),
    });

    if (!resp.ok) { res.status(502).json({ error: resp.error || 'permission decision failed' }); return; }
    res.json(resp.data);
  } catch (err: any) {
    console.warn('[Server] POST /api/mission/permissions error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// 4b. Get all session attention states (for batch UI updates)
router.get('/states', (_req, res) => {
  res.json(getSessionStates());
});

// 5. Set conversation name (Betreff) — saved locally (CUI API ignores custom_name)
router.post('/conversation/:accountId/:sessionId/name', async (req, res) => {
  try {
    const name = req.body.custom_name || '';
    saveTitle(req.params.sessionId, name);
    res.json({ ok: true, sessionId: req.params.sessionId, custom_name: name });
  } catch (err: any) {
    console.warn('[Server] POST /api/mission/conversation/name error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// 5b. Assign conversation to account (called when chat is opened in a CUI panel)
router.post('/conversation/:sessionId/assign', (req, res) => {
  const { accountId, workDir } = req.body;
  if (!accountId) { res.status(400).json({ error: 'accountId required' }); return; }
  const sid = req.params.sessionId;
  saveAssignment(sid, accountId);
  // Persist workDir so it survives account switches
  if (workDir) saveWorkDir(sid, workDir);
  // Auto-unstick: remove rate-limit messages so the conversation can continue on the new account
  const removed = unstickConversation(sid);
  if (removed > 0) console.log(`[Assign] Unsticked ${sid}: removed ${removed} rate-limit messages`);
  res.json({ ok: true, sessionId: sid, accountId, unsticked: removed, workDir: getWorkDir(sid) });
});

// 5c. Get panel visibility (which conversations are open in which panels)
router.get('/visibility', (_req, res) => {
  const panels: PanelVisibility[] = [];
  for (const entry of visibilityRegistry.values()) panels.push(entry);
  res.json({ panels, visibleSessionIds: [...getVisibleSessionIds()] });
});

// 5d. Mark conversation as finished (user override)
router.post('/conversation/:sessionId/finish', (req, res) => {
  const finished = req.body.finished !== false;
  const sid = req.params.sessionId;
  setFinished(sid, finished);
  if (finished) {
    const panelsToClose: Array<{ panelId: string; projectId: string }> = [];
    for (const entry of visibilityRegistry.values()) {
      if (entry.sessionId === sid) {
        panelsToClose.push({ panelId: entry.panelId, projectId: entry.projectId });
      }
    }
    broadcast({ type: 'control:conversation-finished', sessionId: sid, panelsToClose });
  }
  res.json({ ok: true, sessionId: sid, finished });
});

// 5e. Delete conversation permanently (removes .jsonl from disk)
router.delete('/conversation/:sessionId', (req, res) => {
  const sid = req.params.sessionId;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sid)) {
    res.status(400).json({ error: 'Invalid sessionId format' });
    return;
  }
  const cuiProjectsDir = join(homedir(), '.claude', 'projects');
  if (!existsSync(cuiProjectsDir)) {
    res.status(404).json({ error: 'CUI projects directory not found' });
    return;
  }
  const deleted: string[] = [];
  const errors: string[] = [];
  try {
    const projectDirs = readdirSync(cuiProjectsDir);
    for (const dir of projectDirs) {
      const dirPath = join(cuiProjectsDir, dir);
      if (!statSync(dirPath).isDirectory()) continue;
      const jsonlPath = join(dirPath, `${sid}.jsonl`);
      if (existsSync(jsonlPath)) {
        try { unlinkSync(jsonlPath); deleted.push(jsonlPath); } catch (e: any) { errors.push(e.message); }
      }
      const sessionDir = join(dirPath, sid);
      if (existsSync(sessionDir) && statSync(sessionDir).isDirectory()) {
        try { rmSync(sessionDir, { recursive: true }); deleted.push(sessionDir); } catch (e: any) { errors.push(e.message); }
      }
    }
  } catch (e: any) {
    res.status(500).json({ error: `Failed to scan projects: ${e.message}` });
    return;
  }
  if (deleted.length === 0 && errors.length === 0) {
    res.status(404).json({ error: 'Conversation not found on disk' });
    return;
  }
  setFinished(sid, false);
  const titles = loadTitles();
  if (titles[sid]) { delete titles[sid]; writeFileSync(TITLES_FILE, JSON.stringify(titles, null, 2)); }
  const prompts = loadLastPrompt();
  if (prompts[sid]) { delete prompts[sid]; writeFileSync(LAST_PROMPT_FILE, JSON.stringify(prompts, null, 2)); }
  console.log(`[Delete] Conversation ${sid}: ${deleted.length} files deleted`);
  res.json({ ok: true, deleted, errors });
});

// 5f. Remove rate-limit messages from stuck conversations (bulk)
router.post('/unstick', (_req, res) => {
  const cuiProjectsDir = join(homedir(), '.claude', 'projects');
  if (!existsSync(cuiProjectsDir)) {
    res.status(404).json({ error: 'CUI projects directory not found' });
    return;
  }
  const fixed: { session: string; removed: number }[] = [];
  try {
    const projectDirs = readdirSync(cuiProjectsDir);
    for (const dir of projectDirs) {
      const dirPath = join(cuiProjectsDir, dir);
      try { if (!statSync(dirPath).isDirectory()) continue; } catch { continue; }
      const files = readdirSync(dirPath).filter(f => f.endsWith('.jsonl') && /^[0-9a-f]{8}-/.test(f));
      for (const file of files) {
        const sessionId = file.replace('.jsonl', '');
        const removed = unstickConversation(sessionId);
        if (removed > 0) fixed.push({ session: sessionId, removed });
      }
    }
  } catch (e: any) {
    res.status(500).json({ error: `Failed to scan: ${e.message}` });
    return;
  }
  console.log(`[Unstick] Fixed ${fixed.length} conversations`);
  res.json({ ok: true, fixed: fixed.length, details: fixed });
});

// 5g. Activate conversations in panels
router.post('/activate', (req, res) => {
  const { conversations } = req.body;
  if (!Array.isArray(conversations) || conversations.length === 0) {
    res.status(400).json({ error: 'conversations array required' });
    return;
  }
  // Group by projectName and resolve project IDs
  const projectFiles = readdirSync(PROJECTS_DIR).filter(f => f.endsWith('.json'));
  const projectsData = projectFiles.map(f => {
    try { return JSON.parse(readFileSync(join(PROJECTS_DIR, f), 'utf8')); } catch { return null; }
  }).filter(Boolean);
  const plan: Array<{ projectId: string; conversations: Array<{ sessionId: string; accountId: string }> }> = [];
  const byProject = new Map<string, Array<{ sessionId: string; accountId: string }>>();
  for (const c of conversations) {
    const list = byProject.get(c.projectName) || [];
    list.push(c);
    byProject.set(c.projectName, list);
  }
  for (const [projName, convs] of byProject) {
    const proj = projectsData.find((p: any) => p.name === projName);
    plan.push({ projectId: proj?.id || projName, conversations: convs });
  }
  broadcast({ type: 'control:activate-conversations', plan });
  res.json({ ok: true, plan });
});

// 6. Start new conversation with subject
router.post('/start', async (req, res) => {
  try {
  const { accountId, workDir, subject, message, useLocal } = req.body;
  if (!accountId || !message) {
    res.status(400).json({ error: 'accountId, message required' });
    return;
  }
  // useLocal flag: route through local CUI server instead of remote
  const effectiveAccountId = useLocal ? 'local' : accountId;
  const port = getProxyPort(effectiveAccountId);
  if (!port) { res.status(400).json({ error: 'unknown account' }); return; }

  const isValidWorkDir2 = (d: string) => d && (d.startsWith('/root/projekte') || d.startsWith('/home/claude-user'));
  const resolvedWorkDir = (isValidWorkDir2(workDir) ? workDir : null) || '/root/projekte';
  // Start conversation (60s timeout — Claude v1.0.128 spawn takes ~34s)
  const startResp = await cuiFetch(port, '/api/conversations/start', {
    method: 'POST',
    timeoutMs: SEND_TIMEOUT_MS,
    body: JSON.stringify({
      workingDirectory: resolvedWorkDir,
      initialPrompt: message,
    }),
  });

  if (!startResp.ok || !startResp.data?.sessionId) {
    const errMsg = startResp.error || 'CUI unreachable';
    logUserInput({ type: 'start', accountId, workDir, subject, message, result: 'error', error: errMsg });
    res.status(502).json({ error: errMsg });
    return;
  }

  const startData = startResp.data;
  logUserInput({ type: 'start', accountId, workDir, subject, message, sessionId: startData.sessionId, result: 'ok' });

  // Save subject as local title (CUI API doesn't support custom_name)
  if (subject) {
    saveTitle(startData.sessionId, subject);
  }
  // Track account assignment + prompt time + workDir
  saveAssignment(startData.sessionId, accountId);
  saveWorkDir(startData.sessionId, resolvedWorkDir);
  setLastPrompt(startData.sessionId);

  // Track state + respond immediately
  broadcast({ type: 'cui-state', cuiId: accountId, state: 'processing' });
  setSessionState(accountId, accountId, 'working', undefined, startData.sessionId);
  invalidateConvCache();
  res.json({ ok: true, sessionId: startData.sessionId, streamingId: startData.streamingId });

  // Fire-and-forget: monitor with retry on silent failure
  let currentStreamingId = startData.streamingId;
  (async () => {
    for (let attempt = 0; attempt <= MAX_SEND_RETRIES; attempt++) {
      if (currentStreamingId) {
        await monitorStream(`http://localhost:${port}`, currentStreamingId, accountId, {});
      }
      await new Promise(r => setTimeout(r, FLUSH_WAIT_MS));
      const result = verifySendSuccess(startData.sessionId);
      if (result === 'success') return;
      if (result === 'rate_limit') {
        broadcast({ type: 'cui-state', cuiId: accountId, state: 'error', message: 'Rate Limit: Account hat das Nutzungslimit erreicht.' });
        setSessionState(accountId, accountId, 'idle', 'rate_limit', startData.sessionId);
        return;
      }
      if (attempt >= MAX_SEND_RETRIES) break;
      console.log(`[Start] Attempt ${attempt + 1} got no response for ${startData.sessionId.slice(0, 8)} — retrying...`);
      unstickConversation(startData.sessionId);
      await new Promise(r => setTimeout(r, 3000 * (attempt + 1)));
      const retryResp = await cuiFetch(port, '/api/conversations/start', {
        method: 'POST', timeoutMs: SEND_TIMEOUT_MS,
        body: JSON.stringify({ workingDirectory: resolvedWorkDir, initialPrompt: message }),
      });
      if (!retryResp.ok || !retryResp.data?.streamingId) {
        console.log(`[Start] Retry ${attempt + 1} cuiFetch failed: ${retryResp.error}`);
        continue;
      }
      currentStreamingId = retryResp.data.streamingId;
      broadcast({ type: 'cui-state', cuiId: accountId, state: 'processing' });
      setSessionState(accountId, accountId, 'working', undefined, startData.sessionId);
    }
    console.error(`[Start] All ${MAX_SEND_RETRIES + 1} attempts failed for ${startData.sessionId.slice(0, 8)}`);
    broadcast({ type: 'cui-state', cuiId: accountId, state: 'error', message: 'Konversation konnte nicht gestartet werden. Bitte erneut versuchen.' });
    setSessionState(accountId, accountId, 'needs_attention', 'send_failed', startData.sessionId);
  })();
  } catch (err: any) {
    console.warn('[Server] POST /api/mission/start error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// 6b. Input log: retrieve all logged user inputs
router.get('/input-log', (_req, res) => {
  if (!existsSync(INPUT_LOG_FILE)) { res.json({ entries: [] }); return; }
  try {
    const lines = readFileSync(INPUT_LOG_FILE, 'utf8').trim().split('\n').filter(Boolean);
    const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    res.json({ entries, total: entries.length });
  } catch (err) { console.warn('[Mission] Failed to read input log:', err instanceof Error ? err.message : err); res.status(500).json({ error: 'Failed to read input log' }); }
});

// 7. Stop conversation (with nuclear child-process kill)
const ACCOUNT_PM2_MAP: Record<string, string> = { rafael: 'cui-1', engelmann: 'cui-2', office: 'cui-3' };

router.post('/conversation/:accountId/:sessionId/stop', async (req, res) => {
  try {
  const { accountId, sessionId } = req.params;
  const port = getProxyPort(accountId);
  if (!port) { res.status(400).json({ error: 'unknown account' }); return; }

  // 1. Resolve streamingId: cache first, then query binary as fallback
  let streamingId = activeStreams.get(sessionId);
  if (!streamingId) {
    const listResp = await cuiFetch(port, `/api/conversations?limit=${DEFAULT_CONV_LIMIT}`);
    if (listResp.ok && listResp.data?.conversations) {
      const match = listResp.data.conversations.find(
        (c: any) => c.sessionId === sessionId && c.streamingId
      );
      streamingId = match?.streamingId;
    }
  }

  // 2. API stop with correct streamingId (native CUI expects streamingId, NOT sessionId)
  let apiStopOk = false;
  if (streamingId) {
    const resp = await cuiFetch(port, `/api/conversations/${streamingId}/stop`, { method: 'POST' });
    apiStopOk = resp.ok;
    console.log(`[Stop] ${accountId}/${sessionId.slice(0,8)}: API stop (stream=${streamingId.slice(0,8)}) ${resp.ok ? 'OK' : 'FAIL (' + resp.error + ')'}`);
    activeStreams.delete(sessionId);
  } else {
    console.log(`[Stop] ${accountId}/${sessionId.slice(0,8)}: No streamingId found — API stop skipped`);
  }

  // 3. Nuclear kill only if API stop failed (fallback)
  const pmName = ACCOUNT_PM2_MAP[accountId];
  let killed = 0;
  if (!apiStopOk && pmName) {
    try {
      // execSync already imported at top of file (ESM — require() not available)
      const pm2Json = execSync(`su - claude-user -c 'pm2 jlist' 2>/dev/null`, { encoding: 'utf8', timeout: 5000 });
      const pm2Apps = JSON.parse(pm2Json);
      const pmApp = pm2Apps.find((a: any) => a.name === pmName);
      const binaryPid = pmApp?.pid;
      if (binaryPid && binaryPid > 0) {
        const tree = execSync(
          `pstree -p ${binaryPid} 2>/dev/null | grep -oP '\\(\\K[0-9]+(?=\\))' | grep -v '^${binaryPid}$' || true`,
          { encoding: 'utf8', timeout: 5000 }
        ).trim();
        const uniquePids = [...new Set(tree.split('\n').filter(Boolean).map(Number).filter(p => p > 0 && p !== binaryPid))];
        if (uniquePids.length > 0) {
          execSync(`kill -TERM ${uniquePids.join(' ')} 2>/dev/null || true`, { timeout: 3000 });
          killed = uniquePids.length;
          setTimeout(() => {
            try { execSync(`kill -KILL ${uniquePids.join(' ')} 2>/dev/null || true`, { timeout: 3000 }); }
            catch { /* already dead */ }
          }, 1500);
        }
        console.log(`[Stop] ${accountId}: nuclear kill — ${killed} child processes of ${pmName} (PID ${binaryPid})`);
      }
    } catch (err: any) {
      console.error(`[Stop] ${accountId}: child kill error: ${err.message}`);
    }
  }

  // 4. Update state: mark as idle/done
  setSessionState(accountId, accountId, 'idle', 'done', sessionId);
  broadcast({ type: 'cui-state', cuiId: accountId, state: 'done' });

  invalidateConvCache();
  res.json({ stopped: true, apiStopOk, streamingId: streamingId || null, childrenKilled: killed });
  } catch (err: any) {
    console.warn('[Server] POST /api/mission/stop error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// 8. Auto-title: set conversation name from first user message
router.post('/auto-titles', async (_req, res) => {
  try {
  let updated = 0;
  const errors: string[] = [];

  // Get all conversations
  const allConvs: Array<{ sessionId: string; accountId: string; port: number; summary: string; customName: string }> = [];
  await Promise.all(CUI_PROXIES.map(async (proxy) => {
    const resp = await cuiFetch(proxy.localPort, `/api/conversations?limit=${DEFAULT_CONV_LIMIT}&sortBy=updated&order=desc`, { timeoutMs: 30000 });
    if (!resp.ok || !resp.data?.conversations) return;
    for (const c of resp.data.conversations) {
      if (c.sessionInfo?.custom_name || getTitle(c.sessionId)) continue; // Already has a title
      allConvs.push({
        sessionId: c.sessionId,
        accountId: proxy.id,
        port: proxy.localPort,
        summary: c.summary || '',
        customName: c.sessionInfo?.custom_name || '',
      });
    }
  }));

  // For each conversation without a title, fetch first user message
  for (const conv of allConvs) {
    try {
      const detailResp = await cuiFetch(conv.port, `/api/conversations/${conv.sessionId}`);
      if (!detailResp.ok || !detailResp.data?.messages) continue;
      const detail = detailResp.data;

      // Find first user message
      const firstUserMsg = detail.messages.find((m: any) =>
        (m.type === 'user' || m.message?.role === 'user')
      );
      if (!firstUserMsg) continue;

      const content = firstUserMsg.message?.content || firstUserMsg.content || '';
      const text = typeof content === 'string' ? content : (Array.isArray(content) ? content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' ') : '');
      if (!text) continue;

      // Truncate to MAX_TITLE_LENGTH chars, clean up
      let title = text.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
      if (title.length > MAX_TITLE_LENGTH) title = title.slice(0, MAX_TITLE_LENGTH - 3) + '...';

      // Save title locally (CUI API ignores custom_name)
      saveTitle(conv.sessionId, title);
      updated++;
    } catch (err: any) {
      errors.push(`${conv.sessionId}: ${err.message}`);
    }
  }

  res.json({ ok: true, updated, total: allConvs.length, errors });
  } catch (err: any) {
    console.warn('[Server] POST /api/mission/auto-titles error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// 9. Commander context: gather cross-project state
router.get('/context', async (_req, res) => {
  try {
    // Get all conversations with last 3 messages each
    const conversations: any[] = [];
    await Promise.all(CUI_PROXIES.map(async (proxy) => {
      const listResp = await cuiFetch(proxy.localPort, '/api/conversations?limit=500&sortBy=updated&order=desc', { timeoutMs: 30000 });
      if (!listResp.ok || !listResp.data?.conversations) return;
      for (const c of listResp.data.conversations) {
        const detailResp = await cuiFetch(proxy.localPort, `/api/conversations/${c.sessionId}`);
        const rawMsgs = detailResp.data?.messages || [];
        const lastMsgs = rawMsgs.slice(-3).map((m: any) => ({
          role: m.message?.role || m.type || 'user',
          content: typeof m.message?.content === 'string' ? m.message.content.slice(0, 300) :
            Array.isArray(m.message?.content) ? m.message.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' ').slice(0, 300) : '',
        }));

        conversations.push({
          sessionId: c.sessionId,
          accountId: proxy.id,
          projectName: resolveProjectName(c.projectPath || ''),
          status: c.status || 'completed',
          customName: getTitle(c.sessionId) || c.sessionInfo?.custom_name || '',
          summary: (c.summary || '').slice(0, 200),
          messageCount: c.messageCount || 0,
          updatedAt: c.updatedAt || '',
          lastMessages: lastMsgs,
        });
      }
    }));

    // Get git status for each workspace
    const projects = readdirSync(PROJECTS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => { try { return JSON.parse(readFileSync(join(PROJECTS_DIR, f), 'utf8')); } catch { return null; } })
      .filter(Boolean);

    const gitStatus: Record<string, { status: string; log: string }> = {};
    for (const p of projects) {
      if (!p.workDir) continue;
      try {
        const [statusResult, logResult] = await Promise.allSettled([
          execAsync(`cd ${p.workDir} && git status --short 2>/dev/null || echo '(kein Git repo)'`),
          execAsync(`cd ${p.workDir} && git log --oneline -5 2>/dev/null || echo '(keine commits)'`),
        ]);
        gitStatus[p.id] = {
          status: statusResult.status === 'fulfilled' ? statusResult.value.stdout.trim() : '(error)',
          log: logResult.status === 'fulfilled' ? logResult.value.stdout.trim() : '',
        };
      } catch {
        gitStatus[p.id] = { status: '(error)', log: '' };
      }
    }

    res.json({ conversations, gitStatus, projects });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 10. Commander context cache (60s TTL)
let _ctxCache: { data: any; ts: number } | null = null;

async function getCommanderContext(): Promise<any> {
  if (_ctxCache && Date.now() - _ctxCache.ts < COMMANDER_CACHE_TTL_MS) return _ctxCache.data;
  const resp = await fetch(`http://localhost:${PORT}/api/mission/context`, { signal: AbortSignal.timeout(15000) });
  const data = await resp.json();
  _ctxCache = { data, ts: Date.now() };
  return data;
}

// Commander chat: LLM via Bridge (Haiku for speed)
router.post('/commander', async (req, res) => {
  const { messages, context } = req.body;
  if (!messages || !Array.isArray(messages)) {
    res.status(400).json({ error: 'messages array required' });
    return;
  }

  const BRIDGE_URL = process.env.AI_BRIDGE_URL || 'http://49.12.72.66:8000';
  const BRIDGE_KEY = process.env.AI_BRIDGE_API_KEY;
  if (!BRIDGE_KEY) {
    res.status(500).json({ error: 'AI_BRIDGE_API_KEY not set' });
    return;
  }

  // Build system prompt with context
  let systemPrompt = `Du bist der Commander der CUI Mission Control. Du verwaltest mehrere Claude-Code-Instanzen über verschiedene Projekte.
Deine Aufgaben:
- Zusammenfassungen über alle Projekte geben
- Git-Änderungen analysieren
- Management Summaries erstellen
- Tasks an spezifische Workspaces dispatchen

Antworte auf Deutsch, präzise und kompakt.`;

  if (context) {
    try {
      const ctxData = await getCommanderContext();

      systemPrompt += `\n\n## Aktuelle Projekte\n`;
      for (const p of ctxData.projects || []) {
        systemPrompt += `- ${p.name} (${p.id}): ${p.workDir}\n`;
      }

      systemPrompt += `\n## Git Status\n`;
      for (const [pid, git] of Object.entries(ctxData.gitStatus || {})) {
        const g = git as { status: string; log: string };
        systemPrompt += `### ${pid}\nStatus: ${g.status}\nLog: ${g.log}\n\n`;
      }

      systemPrompt += `\n## Aktive Konversationen\n`;
      const active = (ctxData.conversations || []).filter((c: any) => c.status === 'ongoing');
      for (const c of active) {
        systemPrompt += `- [${c.accountId}] ${c.projectName}: ${c.customName || c.summary}\n`;
        for (const m of c.lastMessages || []) {
          systemPrompt += `  ${m.role}: ${m.content.slice(0, 100)}\n`;
        }
      }

      systemPrompt += `\n## Kürzliche Konversationen (letzte 20)\n`;
      for (const c of (ctxData.conversations || []).slice(0, 20)) {
        systemPrompt += `- [${c.status}] ${c.accountId}/${c.projectName}: ${c.customName || c.summary.slice(0, 80)}\n`;
      }
    } catch (err: any) {
      systemPrompt += `\n\n(Context konnte nicht geladen werden: ${err.message})`;
    }
  }

  try {
    const bridgeResp = await fetch(`${BRIDGE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${BRIDGE_KEY}`,
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages,
        ],
        max_tokens: 4096,
      }),
      signal: AbortSignal.timeout(60000),
    });

    if (!bridgeResp.ok) {
      const errBody = await bridgeResp.text();
      res.status(bridgeResp.status).json({ error: `Bridge error: ${errBody}` });
      return;
    }

    const data = await bridgeResp.json();
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: `Bridge unreachable: ${err.message}` });
  }
});

// 11. Commander dispatch: start conversations in workspaces
router.post('/commander/dispatch', async (req, res) => {
  try {
  const { actions } = req.body;
  if (!actions || !Array.isArray(actions)) {
    res.status(400).json({ error: 'actions array required' });
    return;
  }

  const results: any[] = [];
  for (const action of actions) {
    try {
      const startResp = await fetch(`http://localhost:${PORT}/api/mission/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: action.accountId || 'rafael',
          workDir: action.workDir,
          subject: action.subject || '',
          message: action.message,
        }),
        signal: AbortSignal.timeout(65000),
      });
      const result = await startResp.json();
      results.push({ ...action, ok: true, sessionId: result.sessionId });
    } catch (err: any) {
      results.push({ ...action, ok: false, error: err.message });
    }
  }

  res.json({ ok: true, results });
  } catch (err: any) {
    console.warn('[Server] POST /api/mission/commander/dispatch error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

export default router;
