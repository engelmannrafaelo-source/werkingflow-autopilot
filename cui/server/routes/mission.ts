import { Router } from 'express';
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync, rmSync, realpathSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

import type { AttentionReason, ConvAttentionState, SessionState, PanelVisibility } from './shared/types.js';
import { logUserInput as sharedLogUserInput, atomicWriteFileSync } from './shared/utils.js';
import { findJsonlPath, findJsonlPathAllAccounts, readJsonlMetadata, clearMetaCache, readConversationMessages, getOriginalCwd, extractConversationContext, unstickConversation, deepRepairJsonl, compactJsonlForResume } from './shared/jsonl.js';
import * as convMeta from './shared/conv-metadata.js';
import { updateAutoInjectSession } from './autoinject.js';

/** Validates that a workDir is under an allowed root path */
function isValidWorkDir(d: string): boolean {
  if (!d) return false;
  if (IS_LOCAL_MODE) return d.startsWith("/Users/") || d.startsWith("/tmp/");
  return d.startsWith("/root/projekte") || d.startsWith("/root/orchestrator") || d.startsWith("/home/claude-user");
}
import { findJsonlPath, findJsonlPathAllAccounts, readJsonlMetadata, readConversationMessages, getOriginalCwd, extractConversationContext, unstickConversation, deepRepairJsonl, compactJsonlForResume } from './shared/jsonl.js';
import { IS_LOCAL_MODE } from './state.js';
import * as claudeCli from './claude-cli.js';

const execAsync = promisify(exec);

// --- Constants ---
const CONV_CACHE_TTL_MS = 15_000;
const CONV_CACHE_STALE_TTL_MS = 60_000;
const MAX_TITLE_LENGTH = 60;
const MAX_TAIL_MESSAGES = 500;
const COMMANDER_CACHE_TTL_MS = 60_000;

// --- Dependencies (injected via init) ---
let broadcast: (data: Record<string, unknown>) => void;
let sessionStates: Map<string, SessionState>;
let setSessionState: (key: string, accountId: string, state: ConvAttentionState, reason?: AttentionReason, sessionId?: string) => void;
let getSessionStates: () => Record<string, SessionState>;
let DATA_DIR: string;
let PROJECTS_DIR: string;
let PORT: number;
let visibilityRegistry: Map<string, PanelVisibility>;
let getVisibleSessionIds: () => Set<string>;

export interface MissionDeps {
  broadcast: (data: Record<string, unknown>) => void;
  sessionStates: Map<string, SessionState>;
  setSessionState: (key: string, accountId: string, state: ConvAttentionState, reason?: AttentionReason, sessionId?: string) => void;
  getSessionStates: () => Record<string, SessionState>;
  DATA_DIR: string;
  PROJECTS_DIR: string;
  PORT: number;
  visibilityRegistry: Map<string, PanelVisibility>;
  getVisibleSessionIds: () => Set<string>;
}

export function initMissionRouter(deps: MissionDeps) {
  broadcast = deps.broadcast;
  sessionStates = deps.sessionStates;
  setSessionState = deps.setSessionState;
  getSessionStates = deps.getSessionStates;
  DATA_DIR = deps.DATA_DIR;
  convMeta.init(DATA_DIR);
  PROJECTS_DIR = deps.PROJECTS_DIR;
  PORT = deps.PORT;
  visibilityRegistry = deps.visibilityRegistry;
  getVisibleSessionIds = deps.getVisibleSessionIds;

  // Initialize file paths
  INPUT_LOG_FILE = join(DATA_DIR, 'input-log.jsonl');
  buildSessionProjectMap();

  // Warm up conversation cache on startup (async, non-blocking)
  setTimeout(async () => {
    try {
      console.log('[Mission] Warming up conversation cache...');
      const t0 = Date.now();
      const data = await fetchConvList();
      _convCache = { data, timestamp: Date.now(), refreshing: false };
      console.log(`[Mission] Cache warm: ${data.total} conversations in ${Date.now() - t0}ms`);

      // Auto-finish: mark non-ongoing conversations older than 48h as finished
      const cutoff48h = Date.now() - 48 * 60 * 60 * 1000;
      let autoFinished = 0;
      for (const conv of data.conversations) {
        if (conv.manualFinished) continue;
        if (conv.status === 'ongoing') continue;
        const updatedTime = new Date(conv.updatedAt || 0).getTime();
        if (updatedTime < cutoff48h) {
          convMeta.setFinished(conv.sessionId, true);
          autoFinished++;
        }
      }
      if (autoFinished > 0) {
        console.log(`[Mission] Auto-finished ${autoFinished} stale conversations (>48h, not ongoing)`);

  // Periodic zombie cleanup: kill CLI processes for finished conversations (every 5 min)
  async function cleanupZombies() {
    try {
      const data = await fetchConvList();
      const finished = convMeta.getAllFinished();
      let killed = 0;
      for (const conv of data.conversations) {
        if (finished[conv.sessionId] && conv.status === 'ongoing') {
          const stopped = await claudeCli.stopConversation(conv.sessionId);
          if (stopped) { killed++; console.log(`[Zombie] Killed ${conv.sessionId.slice(0, 8)} (finished but still running)`); }
        }
      }
      if (killed > 0) { invalidateConvCache(); console.log(`[Zombie] Cleaned up ${killed} zombie processes`); }
    } catch (err: any) { console.warn('[Zombie] Cleanup error:', err?.message); }
  }
  // Initial cleanup after 10s, then every 5 minutes
  setTimeout(cleanupZombies, 10000);
  setInterval(cleanupZombies, 5 * 60 * 1000);
        invalidateConvCache();
      }
    } catch (err) { console.warn('[Mission] Cache warmup failed:', err instanceof Error ? err.message : err); }
  }, 1000);
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
      if (p.workDir) projectConfigs.push({ id: p.id, name: p.name, workDir: p.workDir, encoded: p.workDir.replace(/[/_]/g, '-') });
    }
  } catch (e: any) { console.warn("[Mission] projectConfigs load error:", e?.message); }
  const extraPaths: Record<string, { name: string; path: string }> = {
    '-root-projekte-orchestrator': { name: 'orchestrator', path: '/root/projekte/orchestrator' },
    '-root-projekte-werkingflow': { name: 'werkingflow', path: '/root/projekte/werkingflow' },
    '-root': { name: 'root', path: '/root' },
    '-tmp': { name: 'tmp', path: '/tmp' },
    '-home-claude-user': { name: 'claude-user', path: '/home/claude-user' },
  };
  const acctDirs = claudeCli.ACCOUNT_CONFIG.map(a => join(a.home, '.claude', 'projects'));
  for (const base of acctDirs) {
    try { if (!statSync(base).isDirectory()) continue; } catch { continue; } // stat failed — skip non-existent dir
    for (const dirname of readdirSync(base)) {
      const dirpath = join(base, dirname);
      try { if (!statSync(dirpath).isDirectory()) continue; } catch { continue; }
      let projName: string | null = null;
      let projPath: string | null = null;
      for (const pc of projectConfigs) {
        if (dirname === pc.encoded) { projName = pc.name; projPath = pc.workDir; break; }
      }
      if (!projName && extraPaths[dirname]) { projName = extraPaths[dirname].name; projPath = extraPaths[dirname].path; }
      // Suffix-based match: try to match dirname tail against configured project workspace slugs
      if (!projName) {
        for (const pc of projectConfigs) {
          const slug = pc.workDir.split('/').pop() || '';
          if (!slug || slug.length < 4) continue;
          // Exact suffix match (e.g. dirname ends with "-engelmann-ai-hub")
          if (dirname.endsWith('-' + slug)) { projName = pc.name; projPath = pc.workDir; break; }
          // Normalized match (handles werking-safety vs werkingsafety)
          const dirNorm = dirname.replace(/-/g, '').toLowerCase();
          const slugNorm = slug.replace(/-/g, '').toLowerCase();
          if (slugNorm.length >= 6 && dirNorm.endsWith(slugNorm)) { projName = pc.name; projPath = pc.workDir; break; }
          // Partial match: dirname tail matches first segment of slug (e.g. "engelmann" → "engelmann-ai-hub")
          const dirTail = (dirname.match(/-([a-z][a-z0-9]+)$/i) || [])[1] || '';
          if (dirTail.length >= 6 && slug.startsWith(dirTail + '-')) { projName = pc.name; projPath = pc.workDir; break; }
        }
      }
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
  let saved = 0;
  for (const r of untitled) {
    if (convMeta.getTitle(r.sessionId)) continue;
    const title = autoTitleFromSummary(r.summary);
    if (title) {
      convMeta.saveTitle(r.sessionId, title);
      saved++;
    }
  }
  if (saved > 0) console.log(`[AutoTitle] Generated ${saved} titles from summaries`);
}





// Track when user last sent a prompt per conversation

// --- User Input Log ---
// Persistent log of all user inputs (subject + message) from Queue/Commander
let INPUT_LOG_FILE: string;
function logUserInput(entry: { type: string; accountId: string; workDir?: string; subject?: string; message: string; sessionId?: string; result: 'ok' | 'error'; error?: string }) {
  sharedLogUserInput(INPUT_LOG_FILE, entry);
}

// Deduplicate conversations by sessionId (remote accounts share sessions)
function deduplicateConversations(results: any[]): any[] {
  const assignments = convMeta.getAllAssignments();
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
      convMeta.saveAssignment(sessionId, streaming.accountId);
    } else if (ongoing) {
      best = ongoing;
      convMeta.saveAssignment(sessionId, ongoing.accountId);
    } else if (assigned) {
      best = entries.find(e => e.accountId === assigned) || entries[0];
    } else {
      // No assignment yet — prefer rafael > engelmann > office
      const preferOrder = ['rafael', 'engelmann', 'office'];
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

// --- JSONL Direct Reading Helpers ---
// Replaces cuiFetch to CUI binary — reads JSONL conversation files directly from disk.











// --- Conversation List Cache (stale-while-revalidate) ---
let _convCache: { data: any; timestamp: number; refreshing: boolean } = { data: null, timestamp: 0, refreshing: false };

function invalidateConvCache() {
  _convCache.timestamp = 0;
}

// 1. List all conversations across all accounts (reads JSONL files directly)
// OPTIMIZED: realpath-dedup skips symlinked account dirs (3x -> 1x scan)
async function fetchConvList() {
  const t0 = Date.now();
  const results: any[] = [];
  const scannedRealpaths = new Set<string>();

  for (const account of claudeCli.ACCOUNT_CONFIG) {
    const projDir = join(account.home, '.claude', 'projects');
    try { if (!statSync(projDir).isDirectory()) continue; } catch { continue; }

    // Realpath-dedup: skip if this dir was already scanned via another account symlink
    let realProjDir: string;
    try { realProjDir = realpathSync(projDir); } catch { realProjDir = projDir; }
    if (scannedRealpaths.has(realProjDir)) {
      // Still need to check for active processes under this account
      continue;
    }
    scannedRealpaths.add(realProjDir);

    for (const dirname of readdirSync(realProjDir)) {
      const dirpath = join(realProjDir, dirname);
      try { if (!statSync(dirpath).isDirectory()) continue; } catch { continue; }
      for (const file of readdirSync(dirpath)) {
        if (!file.endsWith('.jsonl')) continue;
        const sessionId = file.slice(0, -6);
        const filePath = join(dirpath, file);
        const meta = readJsonlMetadata(filePath);
        if (!meta) continue;
        const _sp = getSessionProject(sessionId);
        const isRunning = claudeCli.isActive(sessionId);
        const decodedPath = '/' + dirname.replace(/^-/, '').replace(/-/g, '/');
        // Determine account from active process, default to first scanned account
        const activeAcctId = claudeCli.getActiveAccountId(sessionId);
        const effectiveAccount = activeAcctId
          ? claudeCli.ACCOUNT_CONFIG.find(a => a.id === activeAcctId) || account
          : account;
        results.push({
          sessionId,
          accountId: effectiveAccount.id,
          accountLabel: effectiveAccount.label,
          accountColor: effectiveAccount.color,
          projectPath: _sp?.projectPath || decodedPath,
          projectName: _sp?.projectName || resolveProjectName(decodedPath),
          summary: meta.summary || '',
          customName: convMeta.getTitle(sessionId) || '',
          status: isRunning ? 'ongoing' : 'completed',
          streamingId: null,
          model: meta.model || '',
          messageCount: meta.messageCount || 0,
          updatedAt: meta.updatedAt || '',
          createdAt: meta.createdAt || '',
        });
      }
    }
  }
  console.log(`[Perf] fetchConvList scan: ${Date.now() - t0}ms, ${results.length} conversations, ${scannedRealpaths.size} unique dirs`);

  const promptTimes = convMeta.getAllLastPrompts();
  for (const r of results) {
    r.lastPromptAt = promptTimes[r.sessionId] || '';
  }

  results.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'ongoing' ? -1 : 1;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });

  autoTitleUntitled(results);
  const freshTitles = convMeta.getAllTitles();
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
      (conv as any).toolInfo = stateInfo.toolInfo;
    }
  }

  const finished = convMeta.getAllFinished();
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








// --- Router ---
const router = Router();

// 1. List all conversations — OPTIMIZED: stale-forever + background refresh
// Always responds instantly from cache, refreshes in background when stale.
// First-ever call blocks (cold start only), all subsequent calls are instant.
router.get('/conversations', async (req, res) => {
  try {
  const filterProject = req.query.project as string | undefined;
  const now = Date.now();
  const age = now - _convCache.timestamp;

  let data: any = null;

  if (_convCache.data) {
    // ALWAYS serve cached data immediately (stale-forever strategy)
    data = _convCache.data;

    // Trigger background refresh if stale (>15s)
    if (age > CONV_CACHE_TTL_MS && !_convCache.refreshing) {
      _convCache.refreshing = true;
      (async () => {
        try {
          const fresh = await fetchConvList();
          _convCache = { data: fresh, timestamp: Date.now(), refreshing: false };
          // Notify connected clients that data refreshed
          broadcast({ type: 'conversations-refreshed', total: fresh.total });
        } catch (err) {
          console.warn('[Mission] Background conv cache refresh failed:', err instanceof Error ? err.message : err);
          _convCache.refreshing = false;
        }
      })();
    }
  } else {
    // First-ever call (cold start) — must block
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

// 2. Get conversation detail (last N messages) — reads JSONL directly
router.get('/conversation/:accountId/:sessionId', async (req, res) => {
  try {
  const tail = Math.min(Math.max(parseInt(req.query.tail as string) || 10, 1), MAX_TAIL_MESSAGES);

  // Auto-fix corrupted JSONL before reading — skip for small tail (snippet) requests
  if (tail > 5) unstickConversation(req.params.sessionId);

  // Read conversation directly from JSONL file
  const jsonlInfo = findJsonlPathAllAccounts(req.params.sessionId);
  if (!jsonlInfo) { res.status(404).json({ error: 'conversation not found' }); return; }

  const convData = readConversationMessages(jsonlInfo.path);
  const allMessages: any[] = convData.messages;
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

  // Detect if conversation is idle (last message is assistant text, not waiting for tool_result)
  const lastRaw = rawMessages.length > 0 ? rawMessages[rawMessages.length - 1] : null;
  const lastRole = lastRaw?.message?.role;
  const lastContent = lastRaw?.message?.content;
  let hasPendingToolUse = false;
  if (Array.isArray(lastContent)) {
    hasPendingToolUse = lastContent.some((b: any) => b.type === 'tool_use');
  }
  const isRunning = claudeCli.isActive(req.params.sessionId);
  const isAgentDone = lastRole === 'assistant' && !hasPendingToolUse && !isRunning;

  // Extract session CWD and plan text for ExitPlanMode rendering
  const sessionCwd = getOriginalCwd(req.params.sessionId) || '';
  let planText: string | undefined;
  // Check if any recent message has ExitPlanMode — read plan file from session CWD
  const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
  const lastMsgContent = lastMsg?.content;
  const hasExitPlan = Array.isArray(lastMsgContent) && lastMsgContent.some((b: any) => b.type === 'tool_use' && b.name === 'ExitPlanMode');
  if (hasExitPlan && sessionCwd) {
    const planPath = join(sessionCwd, '.claude', 'plan.md');
    try { planText = readFileSync(planPath, 'utf-8'); } catch { /* plan file not found */ }
  }

  res.json({
    messages,
    summary: convData.summary || '',
    customName: convMeta.getTitle(req.params.sessionId),
    status: isRunning ? 'ongoing' : 'completed',
    projectPath: convData.projectPath || jsonlInfo.dirName || '',
    permissions: [], // CLI manages permissions internally
    totalMessages: rawMessages.length,
    isAgentDone,
    rateLimited,
    rateLimitText: rateLimited ? errorText : undefined,
    apiError: hasApiError || undefined,
    apiErrorText: hasApiError ? errorText : undefined,
    sessionCwd,
    planText,
  });
  } catch (err: any) {
    console.warn('[Server] GET /api/mission/conversation detail error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// 3. Send message to existing conversation (via claude-cli direct spawn)
router.post('/send', async (req, res) => {
  try {
  const { accountId, sessionId, message, workDir } = req.body;
  if (!accountId || !sessionId || !message || (typeof message === 'string' && !message.trim())) {
    res.status(400).json({ error: 'accountId, sessionId, message required' });
    return;
  }
  if (!claudeCli.getAccountConfig(accountId)) {
    res.status(400).json({ error: 'unknown account' }); return;
  }

  // Resolve workDir: validate explicit > persisted > default
  const defaultWorkDir = IS_LOCAL_MODE ? '/Users/rafael/Documents/GitHub' : '/root/projekte';
  const resolvedWorkDir = (isValidWorkDir(workDir) ? workDir : null) || convMeta.getWorkDir(sessionId) || defaultWorkDir;
  if (workDir) convMeta.saveWorkDir(sessionId, workDir);

  // Interactive mode: if process already running for this session, pipe via stdin
  if (claudeCli.isActive(sessionId)) {
    const activeAccount = claudeCli.getActiveAccountId(sessionId);
    if (activeAccount && activeAccount !== accountId) {
      // Account switch: stop old process so we respawn under the new account
      console.log(`[Send] Account switch: ${activeAccount} -> ${accountId} for session ${sessionId.slice(0, 8)}, stopping old process`);
      await claudeCli.stopConversation(sessionId);
      // Fall through to respawn below
    } else {
      const piped = claudeCli.sendMessage(sessionId, message);
      if (piped) {
        console.log(`[Send] Piped to existing process (session=${sessionId.slice(0, 8)})`);
        logUserInput({ type: 'send-piped', accountId, workDir, message, sessionId, result: 'ok' });
        convMeta.setLastPrompt(sessionId);
        convMeta.saveAssignment(sessionId, accountId);
        invalidateConvCache();
        res.json({ ok: true, sessionId, piped: true });
        return;
      }
      console.log(`[Send] stdin pipe failed for session ${sessionId.slice(0, 8)}, falling back to respawn`);
    }
  }

  // Only resume if JSONL file exists (otherwise it's a new session)
  const jsonlExists = findJsonlPathAllAccounts(sessionId) !== null;
  const resumeId = jsonlExists ? sessionId : undefined;

  // Use original CWD from JSONL for resume (fixes CWD mismatch)
  const resumeWorkDir = jsonlExists ? (getOriginalCwd(sessionId) || resolvedWorkDir) : resolvedWorkDir;
  if (jsonlExists && resumeWorkDir !== resolvedWorkDir) {
    console.log(`[Send] CWD override for resume: ${resolvedWorkDir} → ${resumeWorkDir}`);
  }

  // Sanitize JSONL before resuming (only needed when spawning new process)
  if (jsonlExists) {
    const cleaned = unstickConversation(sessionId);
    if (cleaned > 0) console.log(`[Send] Sanitized ${cleaned} entries from ${sessionId}`);
  }

  // Compact large JSONL before resume (prevents context amnesia on cold restart)
  if (jsonlExists) {
    const { compacted, beforeSize, afterSize } = compactJsonlForResume(sessionId);
    if (compacted) {
      console.log(`[Send] Compacted session ${sessionId.slice(0, 8)} for resume: ${(beforeSize/1024).toFixed(0)}KB -> ${(afterSize/1024).toFixed(0)}KB`);
    }
  }

  let finalSessionId = sessionId;
  let resumeFailed = false;
  let result = await claudeCli.startConversation(accountId, message, resumeWorkDir, resumeId);

  // If resume failed, try deep repair then retry with original CWD
  if (!result.ok) {
    console.log(`[Send] Resume failed for ${sessionId}: ${result.error} — attempting deep repair...`);
    const deepCleaned = deepRepairJsonl(sessionId);
    if (deepCleaned > 0) {
      result = await claudeCli.startConversation(accountId, message, resumeWorkDir, sessionId);
    }
    // Still fails — start fresh WITH conversation context (don't lose history)
    if (!result.ok) {
      const context = extractConversationContext(sessionId);
      if (context) {
        console.log(`[Send] Resume failed — starting fresh session WITH conversation context`);
        const contextMessage = `${context}\n\n[Neue Nachricht vom User:]\n${message}`;
        result = await claudeCli.startConversation(accountId, contextMessage, resumeWorkDir);
      } else {
        console.log(`[Send] Resume failed, no context available — starting fresh session`);
        result = await claudeCli.startConversation(accountId, message, resumeWorkDir);
      }
      if (result.ok) resumeFailed = true;
    }
    if (!result.ok) {
      logUserInput({ type: 'send', accountId, workDir, message, sessionId, result: 'error', error: result.error });
      res.status(502).json({ error: result.error || 'CLI spawn failed' });
      return;
    }
  }
  finalSessionId = result.sessionId || sessionId;

  if (resumeFailed) {
    console.log(`[Send] Auto-recovered: old=${sessionId} → new=${finalSessionId}`);
    updateAutoInjectSession(sessionId, finalSessionId);
  }
  logUserInput({ type: 'send', accountId, workDir, message, sessionId: finalSessionId, result: 'ok' });
  convMeta.saveAssignment(finalSessionId, accountId);
  convMeta.saveWorkDir(finalSessionId, resolvedWorkDir);
  convMeta.setLastPrompt(finalSessionId);
  invalidateConvCache();

  // State tracking is handled by claude-cli stdout parsing — just respond
  res.json({ ok: true, sessionId: finalSessionId, resumeFailed });
  } catch (err: any) {
    console.warn('[Server] POST /api/mission/send error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// 4. Permissions — CLI manages permissions internally (no external API needed)
router.post('/permissions/:accountId/:permissionId', async (_req, res) => {
  // Claude CLI handles permissions via --verbose stdout. No external permission API.
  res.json({ ok: true, message: 'Permissions managed by CLI directly' });
});

// 4b. Get all session attention states (for batch UI updates)
router.get('/states', (_req, res) => {
  res.json(getSessionStates());
});

// 5. Set conversation name (Betreff) — saved locally (CUI API ignores custom_name)
router.post('/conversation/:accountId/:sessionId/name', async (req, res) => {
  try {
    const name = req.body.custom_name || '';
    convMeta.saveTitle(req.params.sessionId, name);
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
  convMeta.saveAssignment(sid, accountId);
  // Persist workDir so it survives account switches
  if (workDir) convMeta.saveWorkDir(sid, workDir);
  // Auto-unstick: remove rate-limit messages so the conversation can continue on the new account
  const removed = unstickConversation(sid);
  if (removed > 0) console.log(`[Assign] Unsticked ${sid}: removed ${removed} rate-limit messages`);
  res.json({ ok: true, sessionId: sid, accountId, unsticked: removed, workDir: convMeta.getWorkDir(sid) });
});

// 5c. Get panel visibility (which conversations are open in which panels)
router.get('/visibility', (_req, res) => {
  const panels: PanelVisibility[] = [];
  for (const entry of visibilityRegistry.values()) panels.push(entry);
  res.json({ panels, visibleSessionIds: [...getVisibleSessionIds()] });
});

// 5d. Mark conversation as finished (user override) — also kills the CLI process
router.post('/conversation/:sessionId/finish', async (req, res) => {
  const finished = req.body.finished !== false;
  const sid = req.params.sessionId;
  convMeta.setFinished(sid, finished);
  invalidateConvCache();
  if (finished) {
    // Kill the CLI process — finished means done
    const stopped = await claudeCli.stopConversation(sid);
    if (stopped) console.log(`[Finish] Stopped CLI process for ${sid.slice(0, 8)}`);
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
  convMeta.setFinished(sid, false);
  convMeta.deleteTitle(sid);
  convMeta.deleteLastPrompt(sid);
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

// 6. Start new conversation with subject (via claude-cli direct spawn)

/** Build team context prefix for new conversations (~200-500 tokens) */
function buildSessionContext(workDir: string): string | null {
  const PROJECT_LEADERS: Record<string, string[]> = {
    'engelmann': ['max', 'felix'],
    'werking-report': ['max', 'herbert'],
    'werking-safety': ['max', 'herbert'],
    'werking-energy': ['max'],
    'platform': ['max', 'herbert'],
    'orchestrator': ['max'],
    'werking-noise': ['max'],
  };
  const project = Object.keys(PROJECT_LEADERS).find(p => workDir.includes(p));
  if (!project) return null;

  const teamCtxFile = IS_LOCAL_MODE
    ? join(homedir(), '.claude', 'team-context.md')
    : '/home/claude-user/.claude/team-context.md';
  const teamCtx = existsSync(teamCtxFile) ? readFileSync(teamCtxFile, 'utf8').trim() : '';

  const activeWorkFile = IS_LOCAL_MODE
    ? join(homedir(), '.claude', 'active-work.md')
    : '/home/claude-user/.claude/active-work.md';
  const hasActivePeers = existsSync(activeWorkFile)
    && readFileSync(activeWorkFile, 'utf8').includes('AKTIV');

  const parts = [
    `[KONTEXT: Projekt="${project}", Leader: ${PROJECT_LEADERS[project]?.join(', ')}]`,
    hasActivePeers ? '[PEERS: Andere Sessions aktiv — cat ~/.claude/active-work.md]' : '',
    teamCtx ? `[TEAM]\n${teamCtx}` : '',
  ].filter(Boolean);

  return parts.length > 0 ? parts.join('\n') : null;
}

router.post('/start', async (req, res) => {
  try {
  const { accountId, workDir, subject, message } = req.body;
  if (!accountId || !message) {
    res.status(400).json({ error: 'accountId, message required' });
    return;
  }
  if (!claudeCli.getAccountConfig(accountId)) {
    res.status(400).json({ error: 'unknown account' }); return;
  }

  const defaultWorkDir = IS_LOCAL_MODE ? '/Users/rafael/Documents/GitHub' : '/root/projekte';
  const resolvedWorkDir = (isValidWorkDir(workDir) ? workDir : null) || defaultWorkDir;

  // Enrich first message with team context (only for new conversations)
  const ctx = buildSessionContext(resolvedWorkDir);
  const enrichedMessage = ctx ? `${ctx}\n\n---\n\n${message}` : message;

  const result = await claudeCli.startConversation(accountId, enrichedMessage, resolvedWorkDir);
  if (!result.ok) {
    logUserInput({ type: 'start', accountId, workDir, subject, message, result: 'error', error: result.error });
    res.status(502).json({ error: result.error || 'CLI spawn failed' });
    return;
  }
  const sessionId = result.sessionId;

  logUserInput({ type: 'start', accountId, workDir, subject, message, sessionId, result: 'ok' });
  if (subject) convMeta.saveTitle(sessionId, subject);
  convMeta.saveAssignment(sessionId, accountId);
  convMeta.saveWorkDir(sessionId, resolvedWorkDir);
  convMeta.setLastPrompt(sessionId);
  invalidateConvCache();

  // State tracking is handled by claude-cli stdout parsing
  // Broadcast so LayoutManagers can auto-mount immediately
  broadcast({ type: 'control:conversation-started', sessionId, accountId, workDir: resolvedWorkDir });
  res.json({ ok: true, sessionId });
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

// 7. Stop conversation (via claude-cli process kill)
router.post('/conversation/:accountId/:sessionId/stop', async (req, res) => {
  try {
  const { accountId, sessionId } = req.params;
  if (!claudeCli.getAccountConfig(accountId)) {
    res.status(400).json({ error: 'unknown account' }); return;
  }

  const stopped = await claudeCli.stopConversation(sessionId);
  console.log(`[Stop] ${accountId}/${sessionId.slice(0,8)}: ${stopped ? 'process killed' : 'no active process'}`);

  setSessionState(sessionId, accountId, 'idle', 'done', sessionId);
  broadcast({ type: 'cui-state', cuiId: accountId, sessionId, state: 'done' });
  invalidateConvCache();

  res.json({ stopped });
  } catch (err: any) {
    console.warn('[Server] POST /api/mission/stop error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// 8. Auto-title: set conversation name from first user message (reads JSONL directly)
router.post('/auto-titles', async (_req, res) => {
  try {
  let updated = 0;
  const errors: string[] = [];
  const titles = convMeta.getAllTitles();

  for (const account of claudeCli.ACCOUNT_CONFIG) {
    const projDir = join(account.home, '.claude', 'projects');
    try { if (!statSync(projDir).isDirectory()) continue; } catch { continue; }
    for (const dirname of readdirSync(projDir)) {
      const dirpath = join(projDir, dirname);
      try { if (!statSync(dirpath).isDirectory()) continue; } catch { continue; }
      for (const file of readdirSync(dirpath)) {
        if (!file.endsWith('.jsonl')) continue;
        const sessionId = file.slice(0, -6);
        if (titles[sessionId]) continue; // Already has a title

        try {
          const filePath = join(dirpath, file);
          const content = readFileSync(filePath, 'utf-8');
          const lines = content.split('\n').filter(l => l.trim());

          // Find first user message
          let text = '';
          for (const line of lines) {
            try {
              const obj = JSON.parse(line);
              if (obj.message?.role === 'user') {
                const c = obj.message.content;
                text = typeof c === 'string' ? c : (Array.isArray(c) ? c.filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' ') : '');
                break;
              }
            } catch { /* skip */ }
          }
          if (!text) continue;

          let title = text.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
          if (title.length > MAX_TITLE_LENGTH) title = title.slice(0, MAX_TITLE_LENGTH - 3) + '...';
          if (title.length >= 3) {
            titles[sessionId] = title;
            updated++;
          }
        } catch (err: any) {
          errors.push(`${sessionId}: ${err.message}`);
        }
      }
    }
  }

  if (updated > 0) {
    // titles saved via convMeta
  }
  res.json({ ok: true, updated, errors });
  } catch (err: any) {
    console.warn('[Server] POST /api/mission/auto-titles error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// 9. Commander context: gather cross-project state (reads JSONL directly)
router.get('/context', async (_req, res) => {
  try {
    const conversations: any[] = [];
    for (const account of claudeCli.ACCOUNT_CONFIG) {
      const projDir = join(account.home, '.claude', 'projects');
      try { if (!statSync(projDir).isDirectory()) continue; } catch { continue; }
      for (const dirname of readdirSync(projDir)) {
        const dirpath = join(projDir, dirname);
        try { if (!statSync(dirpath).isDirectory()) continue; } catch { continue; }
        for (const file of readdirSync(dirpath)) {
          if (!file.endsWith('.jsonl')) continue;
          const sessionId = file.slice(0, -6);
          const filePath = join(dirpath, file);
          try {
            const convData = readConversationMessages(filePath);
            const msgs = convData.messages;
            const lastMsgs = msgs.slice(-3).map((m: any) => ({
              role: m.message?.role || 'user',
              content: typeof m.message?.content === 'string' ? m.message.content.slice(0, 300) :
                Array.isArray(m.message?.content) ? m.message.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' ').slice(0, 300) : '',
            }));
            const isRunning = claudeCli.isActive(sessionId);
            const decodedPath = '/' + dirname.replace(/^-/, '').replace(/-/g, '/');
            conversations.push({
              sessionId,
              accountId: account.id,
              projectName: resolveProjectName(decodedPath),
              status: isRunning ? 'ongoing' : 'completed',
              customName: convMeta.getTitle(sessionId) || '',
              summary: (convData.summary || '').slice(0, 200),
              messageCount: msgs.length,
              updatedAt: statSync(filePath).mtime.toISOString(),
              lastMessages: lastMsgs,
            });
          } catch { /* skip unreadable files */ }
        }
      }
    }

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
          execAsync('git status --short 2>/dev/null || echo "(kein Git repo)"', { cwd: p.workDir }),
          execAsync('git log --oneline -5 2>/dev/null || echo "(keine commits)"', { cwd: p.workDir }),
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


// ─── Cleanup zombie processes (finished but still running) ──────────────────
router.post('/cleanup-zombies', async (_req, res) => {
  try {
    const data = await fetchConvList();
    const finished = convMeta.getAllFinished();
    const results: Array<{ sessionId: string; stopped: boolean }> = [];
    for (const conv of data.conversations) {
      if (finished[conv.sessionId] && conv.status === 'ongoing') {
        const stopped = await claudeCli.stopConversation(conv.sessionId);
        results.push({ sessionId: conv.sessionId, stopped });
        if (stopped) console.log(`[Zombie] Manual cleanup: killed ${conv.sessionId.slice(0, 8)}`);
      }
    }
    if (results.length > 0) invalidateConvCache();
    res.json({ ok: true, zombiesFound: results.length, killed: results.filter(r => r.stopped).length, results });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Cleanup failed' });
  }
});

// ─── Force reload all connected browsers ────────────────────────────────────
router.post('/force-reload', (_req, res) => {
  broadcast({ type: 'cui-update-available' });
  res.json({ ok: true, message: 'Reload broadcast sent' });
});

export default router;
