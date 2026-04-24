/**
 * Claude CLI Process Manager — FIFO-based persistent processes.
 *
 * Architecture:
 *   Browser → CUI Workspace Server (4005) → claude CLI (persistent via setsid + FIFO)
 *
 * Local mode (Mac): direct spawn with stdio pipes (original behavior)
 * Remote mode: cui-session-wrapper script with FIFO stdin + file stdout
 *   - Processes survive server restarts (setsid = new session group)
 *   - Server reconnects to existing processes on startup
 */

import { spawn, execSync } from 'child_process';
import type { ChildProcess } from 'child_process';
import { promises as fsp, createReadStream, existsSync, readFileSync, writeSync } from 'fs';
import { createInterface } from 'readline';
import type { ConvAttentionState, AttentionReason, SessionState, ToolExecutionInfo } from './shared/types.js';
import { IS_LOCAL_MODE, getRestoredWorkingSessions } from './state.js';
import { hasIncompleteToolUse, getOriginalCwd } from './shared/jsonl.js';

// --- Account Configuration ---
// Account mapping (ID = label = consistent):
//   engelmann → .cui-account1 → rafael@engelmann.at
//   office    → .cui-account2 → office@data-energyneering.at
//   gmail     → .cui-account3 → engelmann.rafaelo@gmail.com
//   werking   → .cui-account4 → office@werking.tools

export interface AccountConfig {
  id: string;
  home: string;
  label: string;
  color: string;
}

import { PATHS } from '../config/paths.js';

export const ACCOUNT_CONFIG: AccountConfig[] = IS_LOCAL_MODE
  ? [{ id: 'local', home: process.env.HOME || '/Users/rafael', label: 'Local', color: '#7aa2f7' }]
  : [
      { id: 'engelmann',    home: `${PATHS.claudeUserHome}/.cui-account1`, label: 'Engelmann', color: '#bb9af7' },
      { id: 'office', home: `${PATHS.claudeUserHome}/.cui-account2`, label: 'Office',    color: '#9ece6a' },
      { id: 'gmail',    home: `${PATHS.claudeUserHome}/.cui-account3`, label: 'Gmail',     color: '#7aa2f7' },
      { id: 'werking',      home: `${PATHS.claudeUserHome}/.cui-account4`, label: 'Werking',   color: '#f7768e' },
    ];

// --- FIFO Constants ---
const FIFO_DIR = '/run/cui-sessions';

// --- Active Process Tracking ---

interface ClaudeProcessBase {
  sessionId: string;
  accountId: string;
  startedAt: number;
  stdoutBuffer: string;
  /** Currently executing tool info (set on tool_use, cleared on next event) */
  _currentToolInfo?: ToolExecutionInfo;
  /** Timestamp of last stdout event from the Claude process (for stuck detection) */
  lastStdoutAt: number;
}

interface DirectProcess extends ClaudeProcessBase {
  mode: 'direct';
  proc: ChildProcess;
}

interface PersistentProcess extends ClaudeProcessBase {
  mode: 'persistent';
  fifoFd: fsp.FileHandle | null;
  tailProc: ChildProcess;
  claudePid: number;
  wrapperPid: number;
  stdoutFile: string;
}

type ClaudeProcess = DirectProcess | PersistentProcess;

const activeProcesses = new Map<string, ClaudeProcess>();
const MAX_ACTIVE_PROCESSES = 48;

// --- Auto-Continue: retry counter per session (prevents infinite loops) ---
const _autoContinueCount = new Map<string, number>();
const AUTO_CONTINUE_MAX_RETRIES = 3;

// --- Dependencies ---

let _broadcast: (data: Record<string, unknown>) => void;
let _setSessionState: (key: string, accountId: string, state: ConvAttentionState, reason?: AttentionReason, sessionId?: string) => void;
let _sessionStates: Map<string, SessionState>;
let _initialized = false;

let _uid: number | undefined;
let _gid: number | undefined;

export function initClaudeCli(deps: {
  broadcast: (data: Record<string, unknown>) => void;
  setSessionState: (key: string, accountId: string, state: ConvAttentionState, reason?: AttentionReason, sessionId?: string) => void;
  sessionStates: Map<string, SessionState>;
}) {
  _broadcast = deps.broadcast;
  _setSessionState = deps.setSessionState;
  _sessionStates = deps.sessionStates;
  _initialized = true;

  if (!IS_LOCAL_MODE && process.getuid?.() === 0) {
    try {
      const pw = execSync('getent passwd claude-user', { encoding: 'utf8', timeout: 3000 }).trim();
      const parts = pw.split(':');
      _uid = parseInt(parts[2], 10);
      _gid = parseInt(parts[3], 10);
      console.log(`[ClaudeCLI] claude-user uid=${_uid} gid=${_gid}`);
    } catch (err) {
      console.error('[ClaudeCLI] Cannot resolve claude-user:', err instanceof Error ? err.message : err);
    }
  }

  // On remote: reconnect to surviving persistent processes
  // Grace period before orphan cleanup: give all wrappers time to be recognized
  if (!IS_LOCAL_MODE) {
    reconnectExistingSessions()
      .then(() => {
        console.log('[ClaudeCLI] Reconnect done. Sessions re-attached from OS processes.');
        // Reap wrappers that were re-parented to init (PPID=1) after a previous
        // server zombie died. They hold FDs but receive no stdin and never exit
        // on their own — accumulate over days. Safe to kill: anything still
        // alive belongs to the previous (now-dead) server, not this process.
        cleanupOrphanedWrappers().catch(err => {
          console.warn('[ClaudeCLI] Orphan wrapper cleanup failed:', err instanceof Error ? err.message : err);
        });
        // Auto-continue sessions that were working when server went down
        // Delay to allow JSONL files to be accessible after reconnect
        setTimeout(() => checkRestoredSessionsAutoContinue(), 5_000);
      })
      .catch(err => {
        console.error('[ClaudeCLI] reconnect failed:', err instanceof Error ? err.message : err);
      });
  }

  console.log(`[ClaudeCLI] Initialized (${ACCOUNT_CONFIG.length} accounts, local=${IS_LOCAL_MODE})`);

  // Start heartbeat for tool execution tracking
  startToolHeartbeat();

  // Start stale state reconciliation (detects stuck "working" state when process is dead)
  startStaleStateReconciliation();
}

// --- Tool Execution Heartbeat ---

let _heartbeatInterval: ReturnType<typeof setInterval> | null = null;

function startToolHeartbeat() {
  if (_heartbeatInterval) return;
  _heartbeatInterval = setInterval(() => {
    for (const [, entry] of activeProcesses) {
      if (!entry.sessionId || !entry._currentToolInfo) continue;

      // Check process alive
      let alive = false;
      if (entry.mode === 'direct') {
        alive = !!entry.proc && !entry.proc.killed;
      } else {
        try { process.kill(entry.claudePid, 0); alive = true; } catch { alive = false; }
      }
      if (!alive) continue;

      const elapsed = Date.now() - entry._currentToolInfo.startedAt;
      _broadcast({
        type: 'tool-heartbeat',
        sessionId: entry.sessionId,
        accountId: entry.accountId,
        toolName: entry._currentToolInfo.toolName,
        toolDetail: entry._currentToolInfo.toolDetail,
        elapsedMs: elapsed,
        processAlive: true,
      });
    }
  }, 15_000);
}

// --- Account Helpers ---

export function getAccountConfig(accountId: string): AccountConfig | undefined {
  return ACCOUNT_CONFIG.find(a => a.id === accountId);
}

function getAccountHome(accountId: string): string | null {
  return getAccountConfig(accountId)?.home ?? null;
}

// --- Shared stdout line handler (used by both modes) ---

function handleStdoutLine(line: string, entry: ClaudeProcess): { sessionId?: string; isResult?: boolean } {
  if (!line.trim()) return {};

  try {
    const obj = JSON.parse(line);
    const result: { sessionId?: string; isResult?: boolean } = {};

    // Track last stdout activity for stuck detection
    entry.lastStdoutAt = Date.now();

    // Clear tool execution info when any new event arrives (tool completed)
    if (entry._currentToolInfo && entry.sessionId) {
      const was = entry._currentToolInfo;
      entry._currentToolInfo = undefined;
      _broadcast({
        type: 'tool-done',
        sessionId: entry.sessionId,
        accountId: entry.accountId,
        toolName: was.toolName,
        durationMs: Date.now() - was.startedAt,
      });
    }

    // Capture session ID
    const sid = obj.session_id || obj.sessionId;
    if (sid && !entry.sessionId) {
      entry.sessionId = sid;
      result.sessionId = sid;
    }

    // Forward assistant messages
    if (obj.type === 'assistant' && obj.message?.role === 'assistant' && entry.sessionId) {
      _broadcast({
        type: 'turn-update',
        sessionId: entry.sessionId,
        accountId: entry.accountId,
        message: {
          role: 'assistant',
          content: obj.message.content,
          timestamp: new Date().toISOString(),
        },
      });
      _broadcast({ type: 'cui-state', cuiId: entry.accountId, sessionId: entry.sessionId, state: 'processing' });
      // Reinforce working state in sessionStates (sidebar source of truth)
      const currentState = _sessionStates.get(entry.sessionId);
      if (!currentState || currentState.state !== 'needs_attention') {
        _setSessionState(entry.sessionId, entry.accountId, 'working', undefined, entry.sessionId);
      }
    }

    // Forward partial (streaming) messages
    if (obj.type === 'assistant' && obj.message_type === 'partial' && entry.sessionId) {
      _broadcast({
        type: 'cli-partial',
        sessionId: entry.sessionId,
        accountId: entry.accountId,
        content: obj.message?.content,
      });
    }

    // Structured attention detection
    if (entry.sessionId && obj.type === 'assistant' && obj.message?.content) {
      const blocks = Array.isArray(obj.message.content) ? obj.message.content : [];
      for (const block of blocks) {
        if (block.type !== 'tool_use') continue;
        if (block.name === 'EnterPlanMode') {
          console.log(`[ClaudeCLI] ${entry.accountId}: attention=plan/enter (session=${entry.sessionId?.slice(0, 8)})`);
          _setSessionState(entry.sessionId, entry.accountId, 'needs_attention', 'plan', entry.sessionId);
          break;
        }
        if (block.name === 'ExitPlanMode') {
          console.log(`[ClaudeCLI] ${entry.accountId}: ExitPlanMode detected (session=${entry.sessionId?.slice(0, 8)})`);
          _setSessionState(entry.sessionId, entry.accountId, 'working', undefined, entry.sessionId);
          break;
        }
        if (block.name === 'AskUserQuestion') {
          console.log(`[ClaudeCLI] ${entry.accountId}: attention=question (session=${entry.sessionId?.slice(0, 8)})`);
          _setSessionState(entry.sessionId, entry.accountId, 'needs_attention', 'question', entry.sessionId);
          break;
        }
        if (block.name === 'EnterWorktree') {
          console.log(`[ClaudeCLI] ${entry.accountId}: attention=permission/worktree (session=${entry.sessionId?.slice(0, 8)})`);
          _setSessionState(entry.sessionId, entry.accountId, 'needs_attention', 'permission', entry.sessionId);
          break;
        }
      }

      // Detect regular tool execution for UI status display
      // Note: stop_reason is null in the assistant event; it only appears in message_delta stream event.
      // So we detect tool_use blocks directly from content.
      {
        const lastToolUse = [...blocks].reverse().find((b: any) => b.type === 'tool_use');
        if (lastToolUse && !['EnterPlanMode', 'ExitPlanMode', 'AskUserQuestion', 'EnterWorktree'].includes(lastToolUse.name)) {
          const toolName: string = lastToolUse.name || 'tool';
          let toolDetail: string | undefined;
          const inp: any = lastToolUse.input || {};
          if (toolName === 'Bash' && inp.description) toolDetail = String(inp.description).slice(0, 80);
          else if (toolName === 'Bash' && inp.command) toolDetail = String(inp.command).slice(0, 80);
          else if (['Read', 'Write', 'Edit'].includes(toolName) && inp.file_path) toolDetail = String(inp.file_path).split('/').slice(-2).join('/');
          else if (['Grep', 'Glob'].includes(toolName) && inp.pattern) toolDetail = String(inp.pattern).slice(0, 60);
          else if (toolName === 'WebSearch' && inp.query) toolDetail = String(inp.query).slice(0, 60);
          else if (toolName === 'Agent' && inp.description) toolDetail = String(inp.description).slice(0, 60);
          else if (toolName === 'TodoWrite') toolDetail = 'Updating tasks';

          entry._currentToolInfo = { toolName, toolDetail, startedAt: Date.now() };
          _broadcast({
            type: 'tool-executing',
            sessionId: entry.sessionId,
            accountId: entry.accountId,
            toolName,
            toolDetail,
            startedAt: Date.now(),
          });
        }
      }
    }

    // SDK Rate Limit Event
    if (obj.type === 'system' && obj.subtype === 'rate_limit') {
      console.log(`[ClaudeCLI] ${entry.accountId}: SDK rate limit (resets=${obj.resetsAt || ''}, util=${obj.utilization || 0})`);
      _broadcast({ type: 'cui-rate-limit', cuiId: entry.accountId, sessionId: entry.sessionId, resetsAt: obj.resetsAt || '', utilization: obj.utilization || 0 });
      _setSessionState(entry.sessionId, entry.accountId, 'idle', 'rate_limit', entry.sessionId);
    }

    // CLI result (cost, duration, turns)
    if (obj.type === 'result' && entry.sessionId) {
      const cliResult: Record<string, unknown> = { type: 'cli-result', sessionId: entry.sessionId, accountId: entry.accountId };
      if (obj.total_cost_usd !== undefined) cliResult.costUsd = obj.total_cost_usd;
      if (obj.duration_ms !== undefined) cliResult.durationMs = obj.duration_ms;
      if (obj.num_turns !== undefined) cliResult.numTurns = obj.num_turns;
      if (obj.is_error !== undefined) cliResult.isError = obj.is_error;
      _broadcast(cliResult);
    }

    // Result with error subtype — context overflow or concurrency
    if (obj.type === 'result' && obj.subtype === 'error') {
      const errStr = JSON.stringify(obj.error || '').slice(0, 300);
      const errLower = errStr.toLowerCase();
      console.log(`[ClaudeCLI] ${entry.accountId}: result error: ${errStr}`);

      // Detect tool use concurrency error (API 400)
      if (errLower.includes('concurrency') || (errLower.includes('tool_use') && errLower.includes('tool_result'))) {
        console.log(`[ClaudeCLI] ${entry.accountId}: TOOL CONCURRENCY ERROR — session needs wait, not restart`);
        _broadcast({ type: 'cui-state', cuiId: entry.accountId, sessionId: entry.sessionId, state: 'error', message: 'Tool-Concurrency: Session wartet auf Tool-Ergebnisse. Bitte warten.' });
        _setSessionState(entry.sessionId, entry.accountId, 'needs_attention', 'tool_concurrency', entry.sessionId);
        return result;
      }

      if (errLower.includes('prompt is too long') || errLower.includes('too many tokens')) {
        console.log(`[ClaudeCLI] ${entry.accountId}: CONTEXT OVERFLOW — killing process`);
        _broadcast({ type: 'cui-state', cuiId: entry.accountId, sessionId: entry.sessionId, state: 'error', message: 'Kontext zu lang — nächste Nachricht startet kompaktierte Session.' });
        _setSessionState(entry.sessionId, entry.accountId, 'needs_attention', 'context_overflow', entry.sessionId);
        setTimeout(() => stopConversation(entry.sessionId), 500);
        return result;
      }

      // Detect overloaded error (529) — treat like rate limit for auto-recovery
      if (errLower.includes('overloaded') || errLower.includes('529')) {
        console.log(`[ClaudeCLI] ${entry.accountId}: OVERLOADED ERROR — marking for auto-recovery`);
        _broadcast({ type: 'cui-state', cuiId: entry.accountId, sessionId: entry.sessionId, state: 'error', message: 'API überlastet (529). Auto-Recovery wird versuchen.' });
        _setSessionState(entry.sessionId, entry.accountId, 'idle', 'overloaded', entry.sessionId);
        return result;
      }
    }

    // Handle permission_request events (plan mode exit, tool approvals)
    // Claude Code sends these on stdout when requiresUserInteraction() is true
    if (obj.type === 'permission_request' && obj.request_id) {
      console.log(`[ClaudeCLI] ${entry.accountId}: permission_request tool=${obj.tool_name} (session=${entry.sessionId?.slice(0, 8)})`);
      const response = JSON.stringify({
        type: 'permission_response',
        request_id: obj.request_id,
        subtype: 'success',
        response: { updated_input: obj.input || {}, permission_updates: [] },
      });
      writeToProcess(entry, response + '\n');
      console.log(`[ClaudeCLI] ${entry.accountId}: permission auto-approved for ${obj.tool_name}`);
      _broadcast({ type: 'cui-state', cuiId: entry.accountId, sessionId: entry.sessionId, state: 'processing' });
      _setSessionState(entry.sessionId, entry.accountId, 'working', undefined, entry.sessionId);
    }

    // Handle result events (resume init done or response complete)
    if (obj.type === 'result') {
      result.isResult = true;
      const denials = Array.isArray(obj.permission_denials) ? obj.permission_denials : [];
      const questionDenied = denials.some((d: any) => d.tool_name === 'AskUserQuestion');
      if (questionDenied) {
        console.log(`[ClaudeCLI] ${entry.accountId}: result with AskUserQuestion denied - staying in question state`);
        _broadcast({ type: 'cui-state', cuiId: entry.accountId, sessionId: entry.sessionId, state: 'done' });
        _broadcast({ type: 'cui-response-ready', cuiId: entry.accountId, sessionId: entry.sessionId });
        _setSessionState(entry.sessionId, entry.accountId, 'needs_attention', 'question', entry.sessionId);
      } else {
        console.log(`[ClaudeCLI] ${entry.accountId}: result received - now idle`);
        _broadcast({ type: 'cui-state', cuiId: entry.accountId, sessionId: entry.sessionId, state: 'done' });
        _broadcast({ type: 'cui-response-ready', cuiId: entry.accountId, sessionId: entry.sessionId });
        _setSessionState(entry.sessionId, entry.accountId, 'idle', 'done', entry.sessionId);

        // --- Auto-Continue: if last assistant message was tool_use without text, resume ---
        if (entry.sessionId) {
          const sid = entry.sessionId;
          const retryCount = _autoContinueCount.get(sid) || 0;
          if (retryCount < AUTO_CONTINUE_MAX_RETRIES) {
            // Defer check to allow JSONL to flush
            setTimeout(() => {
              try {
                if (!hasIncompleteToolUse(sid)) return;
                const newCount = (_autoContinueCount.get(sid) || 0) + 1;
                _autoContinueCount.set(sid, newCount);
                const workDir = getOriginalCwd(sid) || '/root/orchestrator/workspaces/diverse';
                console.log(`[AutoContinue] Session ${sid.slice(0, 8)}: last message was tool_use only, auto-continuing (attempt ${newCount}/${AUTO_CONTINUE_MAX_RETRIES})`);
                _setSessionState(sid, entry.accountId, 'working', undefined, sid);
                _broadcast({ type: 'cui-state', cuiId: entry.accountId, sessionId: sid, state: 'processing' });
                startConversation(entry.accountId, '', workDir, sid).then((res) => {
                  if (!res.ok) {
                    console.error(`[AutoContinue] Session ${sid.slice(0, 8)}: resume failed: ${res.error}`);
                    _setSessionState(sid, entry.accountId, 'idle', 'done', sid);
                    _broadcast({ type: 'cui-state', cuiId: entry.accountId, sessionId: sid, state: 'done' });
                  }
                }).catch((err) => {
                  console.error(`[AutoContinue] Session ${sid.slice(0, 8)}: error: ${err instanceof Error ? err.message : err}`);
                  _setSessionState(sid, entry.accountId, 'idle', 'done', sid);
                });
              } catch (err) {
                console.error(`[AutoContinue] Session ${sid.slice(0, 8)}: check failed: ${err instanceof Error ? err.message : err}`);
              }
            }, 2000);
          } else if (retryCount >= AUTO_CONTINUE_MAX_RETRIES) {
            console.warn(`[AutoContinue] Session ${sid.slice(0, 8)}: max retries (${AUTO_CONTINUE_MAX_RETRIES}) reached, staying idle`);
          }
        }
      }
    }

    return result;
  } catch {
    return {};
  }
}

// --- Auto-Continue on Server Restart ---

/**
 * After server restart, check sessions that were working->idle and auto-continue
 * those that have incomplete tool_use (interrupted mid-execution).
 */
async function checkRestoredSessionsAutoContinue(): Promise<void> {
  const candidates = getRestoredWorkingSessions();
  if (candidates.length === 0) return;

  console.log(`[AutoContinue] Checking ${candidates.length} restored sessions for incomplete tool_use`);

  for (const { sessionId, accountId } of candidates) {
    try {
      if (!hasIncompleteToolUse(sessionId)) {
        console.log(`[AutoContinue] Restored session ${sessionId.slice(0, 8)}: no incomplete tool_use, skipping`);
        continue;
      }

      const retryCount = (_autoContinueCount.get(sessionId) || 0) + 1;
      if (retryCount > AUTO_CONTINUE_MAX_RETRIES) {
        console.warn(`[AutoContinue] Restored session ${sessionId.slice(0, 8)}: max retries would be exceeded, skipping`);
        continue;
      }
      _autoContinueCount.set(sessionId, retryCount);

      const workDir = getOriginalCwd(sessionId) || '/root/orchestrator/workspaces/diverse';
      console.log(`[AutoContinue] Restored session ${sessionId.slice(0, 8)}: incomplete tool_use detected, auto-continuing (attempt ${retryCount}/${AUTO_CONTINUE_MAX_RETRIES})`);

      _setSessionState(sessionId, accountId, 'working', undefined, sessionId);
      _broadcast({ type: 'cui-state', cuiId: accountId, sessionId, state: 'processing' });

      const res = await startConversation(accountId, '', workDir, sessionId);
      if (!res.ok) {
        console.error(`[AutoContinue] Restored session ${sessionId.slice(0, 8)}: resume failed: ${res.error}`);
        _setSessionState(sessionId, accountId, 'idle', 'done', sessionId);
        _broadcast({ type: 'cui-state', cuiId: accountId, sessionId, state: 'done' });
      }
    } catch (err) {
      console.error(`[AutoContinue] Restored session ${sessionId.slice(0, 8)}: error: ${err instanceof Error ? err.message : err}`);
      _setSessionState(sessionId, accountId, 'idle', 'done', sessionId);
    }
  }
}

// --- Write to process stdin (mode-aware) ---

function writeToProcess(entry: ClaudeProcess, data: string): boolean {
  if (entry.mode === 'direct') {
    if (!entry.proc.stdin || entry.proc.stdin.destroyed) return false;
    try { entry.proc.stdin.write(data); return true; } catch { return false; }
  } else {
    if (!entry.fifoFd) return false;
    try {
      // Synchronous write to FIFO fd (fifoFd.fd is the raw file descriptor number)
      writeSync(entry.fifoFd.fd, Buffer.from(data));
      return true;
    } catch (err) {
      console.error(`[ClaudeCLI] FIFO write error for ${entry.sessionId?.slice(0, 8)}:`, err instanceof Error ? err.message : err);
      return false;
    }
  }
}

// --- Process Management ---

export interface StartResult {
  sessionId: string;
  ok: boolean;
  error?: string;
  resumeFailed?: boolean;
}

/**
 * Start a new conversation or resume an existing one.
 * Remote: uses FIFO-based persistent process (survives server restart)
 * Local: uses direct spawn with stdio pipes
 */
export async function startConversation(
  accountId: string,
  prompt: string,
  workDir: string,
  resumeSessionId?: string,
  model?: string,
): Promise<StartResult> {
  if (!_initialized) return { sessionId: '', ok: false, error: 'Not initialized' };

  const config = getAccountConfig(accountId);
  if (!config) return { sessionId: '', ok: false, error: `Unknown account: ${accountId}` };

  if (activeProcesses.size >= MAX_ACTIVE_PROCESSES) {
    return { sessionId: '', ok: false, error: `Max active processes reached (${MAX_ACTIVE_PROCESSES})` };
  }

  // Reset auto-continue and stuck-resume counters on manual conversation start (non-empty prompt)
  if (prompt && resumeSessionId) {
    _autoContinueCount.delete(resumeSessionId);
  }

  // If we already track this session in-memory, reuse the existing wrapper.
  // Only spawn a new one if the tracked process is dead.
  if (resumeSessionId && activeProcesses.has(resumeSessionId)) {
    const existing = activeProcesses.get(resumeSessionId)!;
    let isAlive = false;
    if (existing.mode === 'persistent') {
      try { process.kill(existing.claudePid, 0); isAlive = true; } catch { /* dead */ }
    } else {
      try { process.kill(existing.proc.pid!, 0); isAlive = true; } catch { /* dead */ }
    }
    if (isAlive) {
      // Process is alive — send the prompt via existing FIFO instead of spawning a new wrapper
      if (prompt) {
        console.log(`[ClaudeCLI] Reusing live wrapper for session ${resumeSessionId.slice(0, 8)} (sending prompt via FIFO)`);
        const sent = sendMessage(resumeSessionId, prompt);
        if (sent) {
          return { sessionId: resumeSessionId, ok: true };
        }
        // FIFO write failed — fall through to re-spawn
        console.log(`[ClaudeCLI] FIFO write failed for ${resumeSessionId.slice(0, 8)}, will re-spawn`);
      } else {
        // No prompt, just resume — wrapper is already alive, nothing to do
        console.log(`[ClaudeCLI] Session ${resumeSessionId.slice(0, 8)} already has a live wrapper, no action needed`);
        return { sessionId: resumeSessionId, ok: true };
      }
    }
    // Process is dead — detach and re-spawn below
    console.log(`[ClaudeCLI] Session ${resumeSessionId.slice(0, 8)}: tracked process dead, will re-spawn`);
    await stopConversation(resumeSessionId);
  }

  // Check if there's an OS-level wrapper we're not tracking (e.g. after server restart)
  if (resumeSessionId && !activeProcesses.has(resumeSessionId)) {
    try {
      const psOut = execSync(
        `ps -eo pid,args --no-headers 2>/dev/null | grep "cui-session-wrapper ${resumeSessionId}" | grep -v grep | head -1 || true`,
        { encoding: 'utf8', timeout: 5000 }
      ).trim();
      if (psOut) {
        // There's a live wrapper we don't track — try to re-attach instead of spawning
        const pidMatch = psOut.match(/^(\d+)/);
        if (pidMatch) {
          const wrapperPid = parseInt(pidMatch[1], 10);
          console.log(`[ClaudeCLI] Found untracked live wrapper PID ${wrapperPid} for ${resumeSessionId.slice(0, 8)}, re-attaching...`);
          const reattached = await reattachToWrapper(resumeSessionId, wrapperPid, accountId);
          if (reattached) {
            if (prompt) sendMessage(resumeSessionId, prompt);
            return { sessionId: resumeSessionId, ok: true };
          }
          console.log(`[ClaudeCLI] Re-attach failed for ${resumeSessionId.slice(0, 8)}, will spawn new wrapper`);
        }
      }
    } catch { /* ps failed — proceed with new spawn */ }
  }

  // Build CLI args
  const args: string[] = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--dangerously-skip-permissions',
    // Team mode: isTeammate()=true so ExitPlanMode auto-approves
    '--agent-id', accountId,
    '--agent-name', 'Cockpit',
    '--team-name', 'werkingflow',
  ];
  // Model override (explicit model > settings.json fallback)
  if (model) {
    args.push("--model", model);
  }
  if (resumeSessionId) {
    args.push('--resume', resumeSessionId);
  }

  // Clean environment
  const env: Record<string, string> = {
    HOME: config.home,
    PATH: `/usr/local/bin:/usr/bin:/bin:${PATHS.claudeUserHome}/.local/bin`,
    TERM: 'xterm-256color',
    LANG: process.env.LANG || 'en_US.UTF-8',
    XDG_CONFIG_HOME: `${config.home}/.config`,
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: 'true',
  };
  if (IS_LOCAL_MODE) {
    env.PATH = process.env.PATH || env.PATH;
    if (process.env.SHELL) env.SHELL = process.env.SHELL;
  }

  console.log(`[ClaudeCLI] Spawning for ${accountId} (cwd=${workDir}, resume=${resumeSessionId?.slice(0, 8) || 'new'}, mode=${IS_LOCAL_MODE ? 'direct' : 'persistent'})`);

  if (IS_LOCAL_MODE) {
    return startDirect(accountId, prompt, workDir, args, env, resumeSessionId);
  } else {
    return startPersistent(accountId, prompt, workDir, args, env, resumeSessionId);
  }
}

// --- Direct spawn (local mode, original behavior) ---

function startDirect(
  accountId: string, prompt: string, workDir: string,
  args: string[], env: Record<string, string>, resumeSessionId?: string,
): Promise<StartResult> {
  const spawnOpts: { cwd: string; env: Record<string, string>; stdio: ['pipe', 'pipe', 'pipe'] } = {
    cwd: workDir, env, stdio: ['pipe', 'pipe', 'pipe'],
  };

  return new Promise<StartResult>((resolve) => {
    let resolved = false;
    const proc = spawn('claude', args, spawnOpts);
    const trackingKey = resumeSessionId || `pending-${Date.now()}`;

    const entry: DirectProcess = {
      mode: 'direct', proc, sessionId: resumeSessionId || '', accountId,
      startedAt: Date.now(), lastStdoutAt: Date.now(), stdoutBuffer: '',
    };
    activeProcesses.set(trackingKey, entry);

    const stdinPayload = JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } });
    if (!resumeSessionId) {
      proc.stdin?.write(stdinPayload + '\n');
    } else {
      // Resume with stream-json: Claude emits no init event until first message.
      setTimeout(() => {
        proc.stdin?.write(stdinPayload + '\n');
        console.log(`[ClaudeCLI] ${accountId}: resume message sent after delay (direct mode)`);
      }, 2000);
    }

    const stateKey = resumeSessionId || trackingKey;
    _broadcast({ type: 'cui-state', cuiId: accountId, sessionId: stateKey, state: 'processing' });
    _setSessionState(stateKey, accountId, 'working', undefined, resumeSessionId);

    const timeout = setTimeout(() => {
      if (!resolved) { resolved = true; resolve({ sessionId: entry.sessionId || resumeSessionId || '', ok: !!entry.sessionId || !!resumeSessionId }); }
    }, 30_000);

    proc.on('error', (err) => {
      console.error(`[ClaudeCLI] ${accountId}: spawn error: ${err.message}`);
      activeProcesses.delete(trackingKey);
      if (!resolved) { resolved = true; clearTimeout(timeout); resolve({ sessionId: '', ok: false, error: err.message }); }
    });

    proc.stdout?.on('data', (chunk: Buffer) => {
      entry.stdoutBuffer += chunk.toString();
      const lines = entry.stdoutBuffer.split('\n');
      entry.stdoutBuffer = lines.pop() || '';

      for (const line of lines) {
        const result = handleStdoutLine(line, entry);
        if (result.sessionId && trackingKey !== result.sessionId) {
          activeProcesses.delete(trackingKey);
          activeProcesses.set(result.sessionId, entry);
          _sessionStates.delete(trackingKey);
        }
        if (result.sessionId && !resolved) {
          resolved = true; clearTimeout(timeout);
          resolve({ sessionId: result.sessionId, ok: true });
        }
      }
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (!text) return;
      console.log(`[ClaudeCLI:${accountId}:stderr] ${text.slice(0, 300)}`);
      // Detect tool concurrency error (API 400) — must check before rate limit
      if (text.includes('concurrency') || (text.includes('400') && text.includes('tool'))) {
        console.log(`[ClaudeCLI] ${accountId}: Tool concurrency error detected in stderr`);
        _broadcast({ type: 'cui-concurrency-error', cuiId: accountId, sessionId: entry.sessionId, message: 'Nachricht konnte nicht gesendet werden — Tools laufen noch.' });
        _setSessionState(entry.sessionId, accountId, 'needs_attention', 'tool_concurrency', entry.sessionId);
        return;
      }
      if (text.includes('rate limit') || text.includes('rate_limit') || text.includes('429') || text.includes('overloaded')) {
        _broadcast({ type: 'cui-state', cuiId: accountId, sessionId: entry.sessionId, state: 'error', message: 'Rate Limit: Account hat das Nutzungslimit erreicht.' });
        _broadcast({ type: 'cui-rate-limit-hit', cuiId: accountId, sessionId: entry.sessionId });
        _setSessionState(entry.sessionId, accountId, 'idle', 'rate_limit', entry.sessionId);
      }
    });

    proc.on('close', (code, signal) => {
      const sessionKey = entry.sessionId || trackingKey;
      activeProcesses.delete(sessionKey);
      console.log(`[ClaudeCLI] ${accountId}: EXITED code=${code} signal=${signal} (session=${entry.sessionId?.slice(0, 8) || 'none'})`);

      if (entry.stdoutBuffer.trim()) {
        try { const obj = JSON.parse(entry.stdoutBuffer); if (obj.session_id && !entry.sessionId) entry.sessionId = obj.session_id; } catch { /* */ }
      }

      if (!resolved) { resolved = true; clearTimeout(timeout); resolve(entry.sessionId ? { sessionId: entry.sessionId, ok: true } : { sessionId: '', ok: false, error: `Process exited (code=${code})` }); }

      const current = _sessionStates.get(sessionKey);
      if (current?.reason === 'rate_limit' || current?.state === 'needs_attention') {
        console.log(`[ClaudeCLI] ${accountId}: keeping ${current.state}/${current.reason}`);
      } else {
        _broadcast({ type: 'cui-state', cuiId: accountId, sessionId: entry.sessionId, state: 'done' });
        _broadcast({ type: 'cui-response-ready', cuiId: accountId, sessionId: entry.sessionId });
        _setSessionState(sessionKey, accountId, 'idle', 'done', entry.sessionId);
      }
    });
  });
}

// --- Persistent spawn (remote mode, FIFO-based) ---

async function startPersistent(
  accountId: string, prompt: string, workDir: string,
  args: string[], env: Record<string, string>, resumeSessionId?: string,
): Promise<StartResult> {
  const trackingKey = resumeSessionId || `pending-${Date.now()}`;

  try {
    await fsp.mkdir(FIFO_DIR, { recursive: true });

    // Spawn wrapper with detached:true (setsid — new session group)
    // Combined with KillMode=process in systemd, wrapper survives service restart
    const wrapper = spawn('/usr/local/bin/cui-session-wrapper', [
      trackingKey, accountId, FIFO_DIR,
      ...args,
    ], {
      cwd: workDir,
      env: { ...env, CWD: workDir },
      detached: true,
      stdio: 'ignore',
    });
    wrapper.unref();

    // Wait for PID file with Claude PID (2 lines: wrapper PID, then claude PID)
    const pidFile = `${FIFO_DIR}/${trackingKey}.pid`;
    const claudePid = await waitForClaudePid(pidFile, 20000);
    // Read wrapper PID (first line of PID file)
    let wrapperPid = 0;
    try {
      const pidContent = await fsp.readFile(pidFile, utf8);
      wrapperPid = parseInt(pidContent.trim().split(
)[0], 10) || 0;
    } catch { /* */ }

    // Open FIFO write-end for sending messages
    const fifoPath = `${FIFO_DIR}/${trackingKey}.fifo`;
    const fifoFd = await fsp.open(fifoPath, 'w');

    // Stdout file for tailing
    const stdoutFile = `${FIFO_DIR}/${trackingKey}.stdout`;

    // Start tail -f on stdout file for real-time event parsing
    const tailProc = spawn('tail', ['-f', '-n', '+1', stdoutFile], { stdio: ['ignore', 'pipe', 'ignore'] });

    const entry: PersistentProcess = {
      mode: 'persistent', fifoFd, tailProc, claudePid, wrapperPid, stdoutFile,
      sessionId: resumeSessionId || '', accountId, startedAt: Date.now(), lastStdoutAt: Date.now(), stdoutBuffer: '',
    };
    activeProcesses.set(trackingKey, entry);

    // Set initial state
    _broadcast({ type: 'cui-state', cuiId: accountId, sessionId: trackingKey, state: 'processing' });
    _setSessionState(trackingKey, accountId, 'working', undefined, resumeSessionId);

    // Send first message or queue for resume
    const stdinPayload = JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } });
    if (!resumeSessionId) {
      writeSync(fifoFd.fd, Buffer.from(stdinPayload + '\n'));
      console.log(`[ClaudeCLI] ${accountId}: first message sent via FIFO (${prompt.length} chars)`);
    } else {
      // Resume with stream-json: Claude emits no init event until first message.
      // FIFO buffers up to 64KB, so writing before Claude is ready is safe.
      setTimeout(() => {
        writeToProcess(entry, stdinPayload + '\n');
        console.log(`[ClaudeCLI] ${accountId}: resume message sent after delay (${prompt.length} chars)`);
      }, 2000);
    }

    // Parse stdout via tail
    return new Promise<StartResult>((resolve) => {
      let resolved = false;

      const timeout = setTimeout(() => {
        if (!resolved) { resolved = true; resolve({ sessionId: entry.sessionId || trackingKey, ok: true }); }
      }, 30_000);

      attachStdoutReader(entry, tailProc, (sid) => {
        // Re-key when real sessionId is discovered
        if (sid && trackingKey !== sid) {
          activeProcesses.delete(trackingKey);
          activeProcesses.set(sid, entry);
          _sessionStates.delete(trackingKey);
          // Set state under new key
          _setSessionState(sid, accountId, 'working', undefined, sid);
          _broadcast({ type: 'cui-state', cuiId: accountId, sessionId: sid, state: 'processing' });
          console.log(`[ClaudeCLI] ${accountId}: session=${sid.slice(0, 8)} (re-keyed from ${trackingKey.slice(0, 12)})`);
          // Rename FIFO files to use real sessionId
          renameFifoFiles(trackingKey, sid).catch(() => {});
        }
        if (!resolved && sid) {
          resolved = true; clearTimeout(timeout);
          resolve({ sessionId: sid, ok: true });
        }
      });

      // Handle tail exit (means claude process died)
      tailProc.on('close', () => {
        handlePersistentExit(entry, trackingKey);
        if (!resolved) {
          resolved = true; clearTimeout(timeout);
          resolve(entry.sessionId ? { sessionId: entry.sessionId, ok: true } : { sessionId: '', ok: false, error: 'Process exited before session init' });
        }
      });
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[ClaudeCLI] ${accountId}: persistent spawn failed: ${msg}`);
    return { sessionId: '', ok: false, error: msg };
  }
}

// --- Attach stdout reader (parses NDJSON lines from tail -f) ---

function attachStdoutReader(
  entry: PersistentProcess,
  tailProc: ChildProcess,
  onSessionId: (sid: string) => void,
) {
  const rl = createInterface({ input: tailProc.stdout!, crlfDelay: Infinity });

  rl.on('line', (line) => {
    const result = handleStdoutLine(line, entry);
    if (result.sessionId) onSessionId(result.sessionId);
  });

  rl.on('close', () => {
    // tail died — check if claude process is still alive
    if (entry.claudePid) {
      try { process.kill(entry.claudePid, 0); } catch {
        // Process dead — handle exit
        handlePersistentExit(entry, entry.sessionId);
      }
    }
  });
}

// --- Stale State Reconciliation ---
// Periodically check if "working" sessions are actually still alive/active.
// Fixes stuck "arbeitet" (working) state after server restarts or missed events.

let _staleReconcileInterval: ReturnType<typeof setInterval> | null = null;

// Stuck-timeout DISABLED: was killing sessions during long-running tool calls
// (sleep, build, curl, etc.). Sessions that appear stuck are handled by the
// process-alive check only — if the PID is dead, we mark idle/done.
// No more auto-killing based on stdout silence.

function startStaleStateReconciliation() {
  if (_staleReconcileInterval) return;
  _staleReconcileInterval = setInterval(() => {
    for (const [key, state] of _sessionStates) {
      if (state.state !== 'working') continue;
      // Check if process is actually alive
      const entry = activeProcesses.get(key);
      if (!entry) {
        // Session not in active map but state says "working" — stale
        console.log(`[StaleCheck] ${key.slice(0, 8)}: working but not in activeProcesses -> idle/done`);
        _setSessionState(key, state.accountId, 'idle', 'done', state.sessionId || key);
        _broadcast({ type: 'cui-state', cuiId: state.accountId, sessionId: state.sessionId || key, state: 'done' });
        continue;
      }
      // For persistent processes, verify the actual PID is alive
      if (entry.mode === 'persistent') {
        try {
          process.kill(entry.claudePid, 0);
        } catch {
          // PID is dead while state was 'working' — claude crashed mid-turn.
          // Try to auto-respawn via --resume before giving up (up to AUTO_CONTINUE_MAX_RETRIES).
          // This handles OOM kills, transient API failures, systemd restarts that
          // killed claude but left the session otherwise recoverable.
          const sid = state.sessionId || key;
          const autoCount = _autoContinueCount.get(sid) || 0;
          if (autoCount < AUTO_CONTINUE_MAX_RETRIES) {
            const nextCount = autoCount + 1;
            _autoContinueCount.set(sid, nextCount);
            const workDir = getOriginalCwd(sid) || '/root/orchestrator/workspaces/diverse';
            console.log(`[StaleCheck] ${key.slice(0, 8)}: PID ${entry.claudePid} dead mid-turn -> auto-respawn via --resume (attempt ${nextCount}/${AUTO_CONTINUE_MAX_RETRIES})`);
            activeProcesses.delete(key);
            startConversation(state.accountId, '', workDir, sid).then((res) => {
              if (!res.ok) {
                console.error(`[StaleCheck] ${key.slice(0, 8)}: respawn failed: ${res.error} — marking idle/done`);
                _setSessionState(key, state.accountId, 'idle', 'done', sid);
                _broadcast({ type: 'cui-state', cuiId: state.accountId, sessionId: sid, state: 'done' });
              } else {
                console.log(`[StaleCheck] ${key.slice(0, 8)}: respawn ok`);
              }
            }).catch((err) => {
              console.error(`[StaleCheck] ${key.slice(0, 8)}: respawn error: ${err instanceof Error ? err.message : err}`);
              _setSessionState(key, state.accountId, 'idle', 'done', sid);
              _broadcast({ type: 'cui-state', cuiId: state.accountId, sessionId: sid, state: 'done' });
            });
            continue;
          }
          console.log(`[StaleCheck] ${key.slice(0, 8)}: working but PID ${entry.claudePid} dead -> idle/done (max respawns exceeded: ${autoCount})`);
          _setSessionState(key, state.accountId, 'idle', 'done', state.sessionId || key);
          _broadcast({ type: 'cui-state', cuiId: state.accountId, sessionId: state.sessionId || key, state: 'done' });
          // Cleanup the dead entry
          activeProcesses.delete(key);
          continue;
        }
      }
      // No stdout-silence timeout — process is alive, let it work.
    }
  }, 30000); // Every 30 seconds
}

// Auto-recovery REMOVED: CUI is a view layer, not a session manager.
// Sessions are only started/stopped manually. No automatic killing or restarting.

// killExistingOsProcesses REMOVED: CUI never kills processes automatically.
// killOrphanedClaudeProcesses REMOVED: Only manual kill via UI/API.

// killAndCleanup REMOVED: No automatic killing of processes.

// --- Handle persistent process exit ---

function handlePersistentExit(entry: PersistentProcess, key: string) {
  const sessionKey = entry.sessionId || key;
  // Guard: skip if already handled by stopConversation
  if (!activeProcesses.has(sessionKey)) return;
  activeProcesses.delete(sessionKey);

  // Close FIFO fd
  entry.fifoFd?.close().catch(() => {});
  entry.fifoFd = null;

  console.log(`[ClaudeCLI] ${entry.accountId}: persistent process exited (session=${entry.sessionId?.slice(0, 8) || 'none'})`);

  const current = _sessionStates.get(sessionKey);
  if (current?.reason === 'rate_limit' || current?.state === 'needs_attention') {
    console.log(`[ClaudeCLI] ${entry.accountId}: keeping ${current.state}/${current.reason}`);
  } else {
    _broadcast({ type: 'cui-state', cuiId: entry.accountId, sessionId: entry.sessionId, state: 'done' });
    _broadcast({ type: 'cui-response-ready', cuiId: entry.accountId, sessionId: entry.sessionId });
    _setSessionState(sessionKey, entry.accountId, 'idle', 'done', entry.sessionId);
  }
}

// --- Reconnect to existing sessions on server startup ---

async function reconnectExistingSessions(): Promise<void> {
  try {
    await fsp.access(FIFO_DIR);
  } catch {
    return; // Directory doesn't exist yet — no sessions to reconnect
  }

  const files = await fsp.readdir(FIFO_DIR);
  const pidFiles = files.filter(f => f.endsWith('.pid'));

  if (pidFiles.length === 0) {
    console.log('[ClaudeCLI] No existing sessions to reconnect');
    return;
  }

  console.log(`[ClaudeCLI] Found ${pidFiles.length} PID files, attempting reconnect...`);

  for (const pidFile of pidFiles) {
    const sessionId = pidFile.replace('.pid', '');
    const pidPath = `${FIFO_DIR}/${pidFile}`;
    const metaPath = `${FIFO_DIR}/${sessionId}.meta`;
    const stdoutPath = `${FIFO_DIR}/${sessionId}.stdout`;
    const fifoPath = `${FIFO_DIR}/${sessionId}.fifo`;

    try {
      const pidContent = await fsp.readFile(pidPath, 'utf8');
      const pidLines = pidContent.trim().split('\n');
      const claudePid = parseInt(pidLines[pidLines.length - 1], 10);
      const wrapperPid = pidLines.length > 1 ? parseInt(pidLines[0], 10) : claudePid;

      // Check if process is alive
      try {
        process.kill(claudePid, 0);
      } catch {
        console.log(`[ClaudeCLI] Session ${sessionId.slice(0, 8)}: PID ${claudePid} dead, cleaning up`);
        await cleanupSessionFiles(sessionId);
        continue;
      }

      // Read metadata
      let accountId = 'engelmann';
      try {
        const meta = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
        accountId = meta.accountId || 'engelmann';
      } catch { /* use default */ }

      // Open FIFO write-end
      let fifoFd: fsp.FileHandle | null = null;
      try {
        if (existsSync(fifoPath)) {
          fifoFd = await fsp.open(fifoPath, 'w');
        }
      } catch {
        console.log(`[ClaudeCLI] Session ${sessionId.slice(0, 8)}: FIFO open failed, read-only reconnect`);
      }

      // Start tail on stdout (from current position, not beginning)
      const tailProc = spawn('tail', ['-f', '-n', '0', stdoutPath], { stdio: ['ignore', 'pipe', 'ignore'] });

      const entry: PersistentProcess = {
        mode: 'persistent', fifoFd, tailProc, claudePid, wrapperPid, stdoutFile: stdoutPath,
        sessionId, accountId, startedAt: Date.now(), lastStdoutAt: Date.now(), stdoutBuffer: '',
      };
      activeProcesses.set(sessionId, entry);

      // Attach stdout reader for future events
      attachStdoutReader(entry, tailProc, (sid) => {
        if (sid && sid !== sessionId) {
          activeProcesses.delete(sessionId);
          activeProcesses.set(sid, entry);
        }
      });

      tailProc.on('close', () => handlePersistentExit(entry, sessionId));

      // Determine current state from last stdout lines
      const lastState = await detectLastState(stdoutPath);
      _setSessionState(sessionId, accountId, lastState.state, lastState.reason, sessionId);
      _broadcast({ type: 'cui-state', cuiId: accountId, sessionId, state: lastState.state === 'working' ? 'processing' : 'done' });

      console.log(`[ClaudeCLI] Reconnected: ${sessionId.slice(0, 8)} (account=${accountId}, pid=${claudePid}, state=${lastState.state})`);
    } catch (err) {
      console.error(`[ClaudeCLI] Failed to reconnect ${sessionId.slice(0, 8)}:`, err instanceof Error ? err.message : err);
      await cleanupSessionFiles(sessionId);
    }
  }
}

// --- Reap orphaned wrappers (PPID=1) left behind by previous server zombies ---
// When a tsx server dies abruptly, its child cui-session-wrapper processes get
// re-parented to init (PPID=1). They sit there with open FIFOs/FDs but receive
// no new stdin and never exit on their own. Without this cleanup, they pile up
// over days (we've seen 7+ wrappers, oldest 6 days old).
//
// IMPORTANT: After a normal restart, ALL surviving wrappers also have PPID=1
// (the previous tsx died). Wrappers we successfully re-attached via
// reconnectExistingSessions are tracked in activeProcesses by both wrapperPid
// and claudePid — those must NEVER be killed. Only wrappers we did NOT
// re-attach (no PID file / file pointed at a dead Claude / re-attach failed)
// are true orphans.
async function cleanupOrphanedWrappers(): Promise<void> {
  // Build the set of "alive" wrapper PIDs from activeProcesses (set up during
  // reconnect). These belong to THIS server now — leave them alone.
  const knownWrapperPids = new Set<number>();
  const knownClaudePids = new Set<number>();
  for (const entry of activeProcesses.values()) {
    if (entry.mode === 'persistent') {
      if (entry.wrapperPid) knownWrapperPids.add(entry.wrapperPid);
      if (entry.claudePid) knownClaudePids.add(entry.claudePid);
    }
  }

  let psOut = '';
  try {
    psOut = execSync('ps -eo pid,ppid,args --no-headers 2>/dev/null', { encoding: 'utf8', timeout: 5000 });
  } catch (err) {
    console.warn('[ClaudeCLI] cleanupOrphanedWrappers: ps failed:', err instanceof Error ? err.message : err);
    return;
  }

  const orphans: number[] = [];
  for (const line of psOut.split('\n')) {
    if (!line.includes('cui-session-wrapper')) continue;
    if (line.includes('grep ')) continue;
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+/);
    if (!m) continue;
    const pid = parseInt(m[1], 10);
    const ppid = parseInt(m[2], 10);
    if (ppid !== 1) continue;             // only re-parented (orphaned) wrappers
    if (pid === process.pid) continue;    // never kill ourselves (paranoia)
    if (knownWrapperPids.has(pid)) continue; // re-attached → owned by this server
    if (knownClaudePids.has(pid)) continue;  // shouldn't happen but defensive
    orphans.push(pid);
  }

  if (orphans.length === 0) {
    console.log(`[ClaudeCLI] No orphaned wrappers found (${knownWrapperPids.size} re-attached wrappers preserved)`);
    return;
  }

  console.log(`[ClaudeCLI] Reaping ${orphans.length} orphaned cui-session-wrapper(s) (PPID=1, not re-attached): ${orphans.join(', ')}`);
  for (const pid of orphans) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already dead */ }
  }

  // Grace period, then SIGKILL anything still alive
  await new Promise(r => setTimeout(r, 2000));
  let killed = 0;
  for (const pid of orphans) {
    try { process.kill(pid, 0); /* still alive */ } catch { continue; }
    try { process.kill(pid, 'SIGKILL'); killed++; } catch { /* */ }
  }
  if (killed > 0) console.log(`[ClaudeCLI] SIGKILLed ${killed} stubborn orphan wrapper(s)`);
}

// --- Re-attach to an existing OS-level wrapper (no new spawn) ---

async function reattachToWrapper(sessionId: string, wrapperPid: number, accountId: string): Promise<boolean> {
  const stdoutFile = `${FIFO_DIR}/${sessionId}.stdout`;
  const fifoPath = `${FIFO_DIR}/${sessionId}.fifo`;
  const pidPath = `${FIFO_DIR}/${sessionId}.pid`;

  try {
    // Verify wrapper is alive
    process.kill(wrapperPid, 0);

    // Read Claude PID from PID file
    let claudePid = wrapperPid;
    try {
      const pidContent = await fsp.readFile(pidPath, 'utf8');
      const lines = pidContent.trim().split('\n');
      if (lines.length >= 2) claudePid = parseInt(lines[1], 10) || wrapperPid;
    } catch { /* use wrapperPid */ }

    // Verify Claude is alive
    try { process.kill(claudePid, 0); } catch {
      console.log(`[ClaudeCLI] reattach ${sessionId.slice(0, 8)}: Claude PID ${claudePid} dead`);
      return false;
    }

    // Verify stdout file exists
    if (!existsSync(stdoutFile)) {
      console.log(`[ClaudeCLI] reattach ${sessionId.slice(0, 8)}: stdout file missing`);
      return false;
    }

    // Open FIFO
    let fifoFd: fsp.FileHandle | null = null;
    try {
      if (existsSync(fifoPath)) {
        fifoFd = await fsp.open(fifoPath, 'w');
      }
    } catch {
      console.log(`[ClaudeCLI] reattach ${sessionId.slice(0, 8)}: FIFO open failed`);
      return false;
    }

    // Start tail on stdout
    const tailProc = spawn('tail', ['-f', '-n', '0', stdoutFile], { stdio: ['ignore', 'pipe', 'ignore'] });

    const entry: PersistentProcess = {
      mode: 'persistent', fifoFd, tailProc, claudePid, wrapperPid, stdoutFile,
      sessionId, accountId, startedAt: Date.now(), lastStdoutAt: Date.now(), stdoutBuffer: '',
    };
    activeProcesses.set(sessionId, entry);

    attachStdoutReader(entry, tailProc, (sid) => {
      if (sid && sid !== sessionId) {
        activeProcesses.delete(sessionId);
        activeProcesses.set(sid, entry);
      }
    });
    tailProc.on('close', () => handlePersistentExit(entry, sessionId));

    const lastState = await detectLastState(stdoutFile);
    _setSessionState(sessionId, accountId, lastState.state, lastState.reason, sessionId);

    console.log(`[ClaudeCLI] Re-attached to wrapper PID ${wrapperPid} for session ${sessionId.slice(0, 8)} (claude=${claudePid})`);
    return true;
  } catch (err) {
    console.log(`[ClaudeCLI] reattach ${sessionId.slice(0, 8)} failed: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

// --- Detect last state from stdout file (for reconnect) ---

async function detectLastState(stdoutPath: string): Promise<{ state: ConvAttentionState; reason?: AttentionReason }> {
  try {
    // Read last ~50KB for better state detection (stream_event lines can be verbose)
    const stat = await fsp.stat(stdoutPath);
    const readSize = Math.min(stat.size, 51200);
    const fd = await fsp.open(stdoutPath, 'r');
    const buf = Buffer.alloc(readSize);
    await fd.read(buf, 0, readSize, Math.max(0, stat.size - readSize));
    await fd.close();

    const text = buf.toString('utf8');
    const lines = text.split('\n').filter(l => l.trim());

    // Walk backwards to find last meaningful event (skip streaming noise)
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        // Skip non-meaningful event types
        if (obj.type === 'stream_event' || obj.type === 'rate_limit_event') continue;
        if (obj.type === 'result' && obj.subtype !== 'error') return { state: 'idle', reason: 'done' };
        if (obj.type === 'result' && obj.subtype === 'error') return { state: 'needs_attention', reason: 'context_overflow' };
        if (obj.type === 'system' && obj.subtype === 'rate_limit') return { state: 'idle', reason: 'rate_limit' };
        if (obj.type === 'wrapper-exit') return { state: 'idle', reason: 'done' };
        if (obj.type === 'assistant') return { state: 'working' };
      } catch { /* skip non-JSON */ }
    }
  } catch { /* file read error */ }

  return { state: 'working' }; // Default: assume still working
}

// --- Helper: wait for file to appear ---

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await fsp.access(path);
      return;
    } catch {
      await new Promise(r => setTimeout(r, 100));
    }
  }
  throw new Error(`Timeout waiting for ${path} (${timeoutMs}ms)`);
}

// --- Helper: wait for PID file with Claude PID (second line) ---

async function waitForClaudePid(pidPath: string, timeoutMs: number): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const content = await fsp.readFile(pidPath, 'utf8');
      const lines = content.trim().split('\n');
      if (lines.length >= 2) {
        const pid = parseInt(lines[1], 10);
        if (pid > 0) return pid;
      }
    } catch { /* file doesn't exist yet */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Timeout waiting for Claude PID in ${pidPath} (${timeoutMs}ms)`);
}

// --- Helper: rename FIFO files when real sessionId discovered ---

async function renameFifoFiles(oldKey: string, newKey: string): Promise<void> {
  const exts = ['.fifo', '.stdout', '.stderr', '.pid', '.meta'];
  for (const ext of exts) {
    try {
      await fsp.rename(`${FIFO_DIR}/${oldKey}${ext}`, `${FIFO_DIR}/${newKey}${ext}`);
    } catch { /* file may not exist */ }
  }
}

// --- Helper: cleanup session files ---

async function cleanupSessionFiles(sessionId: string): Promise<void> {
  const exts = ['.fifo', '.stdout', '.stderr', '.pid', '.meta'];
  for (const ext of exts) {
    try { await fsp.unlink(`${FIFO_DIR}/${sessionId}${ext}`); } catch { /* */ }
  }
}

// --- Helper: force-kill session by PID file (fallback when not in activeProcesses) ---

async function forceKillByPidFile(sessionId: string): Promise<boolean> {
  const pidPath = `${FIFO_DIR}/${sessionId}.pid`;
  try {
    const pidContent = await fsp.readFile(pidPath, 'utf8');
    const pids = pidContent.trim().split('\n').map(Number).filter(p => p > 0);
    if (pids.length === 0) return false;

    console.log(`[ClaudeCLI] Force-kill via PID file: session ${sessionId.slice(0, 8)}, PIDs: ${pids.join(', ')}`);

    // Kill entire process tree for each PID
    for (const pid of pids) {
      try {
        const tree = execSync(`pstree -p ${pid} 2>/dev/null | grep -oP '\\(\\K[0-9]+(?=\\))' || true`, { encoding: 'utf8', timeout: 3000 }).trim();
        const allPids = tree.split('\n').filter(Boolean).map(Number).filter(p => p > 0);
        if (allPids.length > 0) {
          execSync(`kill -9 ${allPids.join(' ')} 2>/dev/null || true`, { timeout: 3000 });
        }
      } catch { /* process may already be dead */ }
      try { process.kill(pid, 'SIGKILL'); } catch { /* */ }
    }

    await cleanupSessionFiles(sessionId);
    console.log(`[ClaudeCLI] Force-killed session ${sessionId.slice(0, 8)} via PID file fallback`);
    return true;
  } catch {
    return false;
  }
}

// --- Hard-kill: nuclear option that finds ALL processes by session ID ---

export async function hardKillSession(sessionId: string): Promise<{ killed: number; cleaned: boolean }> {
  // Validate UUID format — this value is used in shell commands
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
    throw new Error(`Invalid sessionId format: ${sessionId.slice(0, 20)}`);
  }

  let killed = 0;

  // 1. Remove from activeProcesses map (in-memory tracking)
  const entry = activeProcesses.get(sessionId);
  if (entry) {
    activeProcesses.delete(sessionId);
    try {
      const pid = entry.mode === 'direct' ? entry.proc.pid : entry.claudePid;
      if (pid) { process.kill(pid, 'SIGKILL'); killed++; }
    } catch { /* already dead */ }
    if (entry.mode === 'persistent' && entry.wrapperPid > 0) {
      try { process.kill(entry.wrapperPid, 'SIGKILL'); killed++; } catch { /* */ }
    }
    if (entry.mode === 'persistent') {
      try { entry.tailProc.kill('SIGKILL'); } catch { /* */ }
    }
  }

  // 2. Kill via PID file (catches processes not in memory map)
  try {
    const pidContent = await fsp.readFile(`${FIFO_DIR}/${sessionId}.pid`, 'utf8');
    const pids = pidContent.trim().split('\n').map(Number).filter(p => p > 0);
    for (const pid of pids) {
      try {
        const tree = execSync(`pstree -p ${pid} 2>/dev/null | grep -oP '\\(\\K[0-9]+(?=\\))' || true`, { encoding: 'utf8', timeout: 3000 }).trim();
        const allPids = tree.split('\n').filter(Boolean).map(Number).filter(p => p > 0);
        if (allPids.length > 0) {
          execSync(`kill -9 ${allPids.join(' ')} 2>/dev/null || true`, { timeout: 3000 });
          killed += allPids.length;
        }
      } catch { /* pstree/kill failed — process may be dead */ }
    }
  } catch { /* no PID file */ }

  // 3. Nuclear grep: find ALL processes by session UUID (zombie wrappers, orphan tails)
  // Safe because sessionId is validated as UUID above (no shell injection possible)
  try {
    const grepResult = execSync(
      `ps aux | grep '${sessionId}' | grep -v grep | awk '{print $2}' || true`,
      { encoding: 'utf8', timeout: 5000 }
    ).trim();
    const grepPids = grepResult.split('\n').filter(Boolean).map(Number).filter(p => p > 0);
    if (grepPids.length > 0) {
      execSync(`kill -9 ${grepPids.join(' ')} 2>/dev/null || true`, { timeout: 3000 });
      killed += grepPids.length;
      console.log(`[ClaudeCLI] Hard-kill grep found ${grepPids.length} additional processes for ${sessionId.slice(0, 8)}`);
    }
  } catch { /* grep/kill failed */ }

  // 4. Cleanup session files (.fifo, .pid, .stdout, .stderr, .meta)
  await cleanupSessionFiles(sessionId);

  console.log(`[ClaudeCLI] Hard-kill complete: session ${sessionId.slice(0, 8)}, ${killed} processes killed`);
  return { killed, cleaned: true };
}

// --- Public API ---

export function sendMessage(sessionId: string, message: string): boolean {
  const entry = activeProcesses.get(sessionId);
  if (!entry) {
    console.log(`[ClaudeCLI] sendMessage(${sessionId.slice(0, 8)}): no active process`);
    return false;
  }

  // Block message injection while tools are executing (prevents API 400 concurrency error)
  if (entry._currentToolInfo) {
    const elapsed = Date.now() - entry._currentToolInfo.startedAt;
    console.log(`[ClaudeCLI] sendMessage(${sessionId.slice(0, 8)}): BLOCKED — tool "${entry._currentToolInfo.toolName}" running for ${Math.round(elapsed / 1000)}s`);
    _broadcast({
      type: 'send-blocked',
      sessionId,
      accountId: entry.accountId,
      reason: 'tool_executing',
      toolName: entry._currentToolInfo.toolName,
      toolDetail: entry._currentToolInfo.toolDetail,
      elapsedMs: elapsed,
    });
    return false;
  }

  // Reset auto-continue and stuck-resume counters on manual user message
  _autoContinueCount.delete(sessionId);

  const payload = JSON.stringify({ type: 'user', message: { role: 'user', content: message } });
  const ok = writeToProcess(entry, payload + '\n');

  if (ok) {
    console.log(`[ClaudeCLI] sendMessage(${sessionId.slice(0, 8)}): sent ${message.length} chars (account=${entry.accountId})`);
    _broadcast({ type: 'cui-state', cuiId: entry.accountId, sessionId, state: 'processing' });
    _setSessionState(sessionId, entry.accountId, 'working', undefined, sessionId);
  } else {
    console.error(`[ClaudeCLI] sendMessage(${sessionId.slice(0, 8)}): write failed`);
  }
  return ok;
}

export function hasActiveTools(sessionId: string): boolean {
  const entry = activeProcesses.get(sessionId);
  return !!entry?._currentToolInfo;
}

export function getToolInfo(sessionId: string): ToolExecutionInfo | undefined {
  return activeProcesses.get(sessionId)?._currentToolInfo;
}

export async function stopConversation(sessionId: string): Promise<boolean> {
  const entry = activeProcesses.get(sessionId);
  if (!entry) {
    // Fallback: session not in memory map (e.g. after server restart).
    // Try to kill via PID file directly — this is the hard-kill path.
    return forceKillByPidFile(sessionId);
  }

  console.log(`[ClaudeCLI] Stopping session ${sessionId.slice(0, 8)} (account=${entry.accountId}, mode=${entry.mode})`);
  activeProcesses.delete(sessionId);

  if (entry.mode === 'direct') {
    const pid = entry.proc.pid;
    try {
      entry.proc.kill('SIGTERM');
      if (pid) {
        try {
          const tree = execSync(`pstree -p ${pid} 2>/dev/null | grep -oP '\\(\\K[0-9]+(?=\\))' | grep -v '^${pid}$' || true`, { encoding: 'utf8', timeout: 3000 }).trim();
          const childPids = [...new Set(tree.split('\n').filter(Boolean).map(Number).filter(p => p > 0 && p !== pid))];
          if (childPids.length > 0) execSync(`kill -TERM ${childPids.join(' ')} 2>/dev/null || true`, { timeout: 2000 });
        } catch { /* */ }
      }
      await new Promise<void>((resolve) => {
        const killTimer = setTimeout(() => {
          try { entry.proc.kill('SIGKILL'); if (pid) execSync(`kill -KILL ${pid} 2>/dev/null || true`, { timeout: 2000 }); } catch { /* */ }
          resolve();
        }, 3000);
        entry.proc.on('exit', () => { clearTimeout(killTimer); resolve(); });
      });
    } catch (err) {
      console.error(`[ClaudeCLI] Stop error: ${err instanceof Error ? err.message : err}`);
    }
  } else {
    // Persistent mode: kill by PID, close FIFO, kill tail
    try {
      process.kill(entry.claudePid, 'SIGTERM');
      // Kill child tree
      try {
        const tree = execSync(`pstree -p ${entry.claudePid} 2>/dev/null | grep -oP '\\(\\K[0-9]+(?=\\))' || true`, { encoding: 'utf8', timeout: 3000 }).trim();
        const childPids = tree.split('\n').filter(Boolean).map(Number).filter(p => p > 0);
        if (childPids.length > 0) execSync(`kill -TERM ${childPids.join(' ')} 2>/dev/null || true`, { timeout: 2000 });
      } catch { /* */ }
      // SIGKILL after 3s
      setTimeout(() => {
        try { process.kill(entry.claudePid, 'SIGKILL'); } catch { /* */ }
      }, 3000);
    } catch { /* already dead */ }

    // Kill wrapper process (session group leader)
    if (entry.wrapperPid > 0) {
      try { process.kill(entry.wrapperPid, SIGTERM); } catch { /* already dead */ }
      setTimeout(() => {
        try { process.kill(entry.wrapperPid, SIGKILL); } catch { /* */ }
      }, 3000);
    }

    // Cleanup
    entry.fifoFd?.close().catch(() => {});
    entry.fifoFd = null;
    try { entry.tailProc.kill(); } catch { /* */ }
    await cleanupSessionFiles(sessionId);
  }

  return true;
}

async function stopAccountProcesses(accountId: string): Promise<number> {
  const sessions = getActiveSessionsForAccount(accountId);
  await Promise.allSettled(sessions.map(sid => stopConversation(sid)));
  return sessions.length;
}

export function isActive(sessionId: string): boolean {
  const entry = activeProcesses.get(sessionId);
  if (!entry) return false;
  if (entry.mode === 'direct') return !entry.proc.killed;
  // Persistent: check if PID is alive
  try { process.kill(entry.claudePid, 0); return true; } catch { return false; }
}

export function getActiveAccountId(sessionId: string): string | null {
  const entry = activeProcesses.get(sessionId);
  return entry ? entry.accountId : null;
}

function getActiveSessionsForAccount(accountId: string): string[] {
  return [...activeProcesses.entries()]
    .filter(([_, e]) => e.accountId === accountId)
    .map(([sid]) => sid);
}

export function getActivePid(sessionId: string): number | null {
  const entry = activeProcesses.get(sessionId);
  if (!entry) return null;
  return entry.mode === 'direct' ? entry.proc.pid ?? null : entry.claudePid;
}


// Orphan cleanup REMOVED: CUI is a view layer on Claude sessions.
// JSONL files on disk = source of truth. No automatic process killing.
// Sessions are only stopped manually via UI/API.

export function getOrphanCleanupStatus(): { killed: number; timestamp: number } | null {
  return null; // No-op: cleanup disabled
}

export async function killOrphanProcesses(): Promise<{ found: number; killed: number }> {
  return { found: 0, killed: 0 }; // No-op: cleanup disabled
}

export function getActiveProcesses(): Array<{
  accountId: string;
  sessionId: string;
  pid: number | undefined;
  startedAt: number;
  uptimeMs: number;
  mode: string;
}> {
  return [...activeProcesses.entries()].map(([_key, entry]) => ({
    accountId: entry.accountId,
    sessionId: entry.sessionId,
    pid: entry.mode === 'direct' ? entry.proc.pid : entry.claudePid,
    startedAt: entry.startedAt,
    uptimeMs: Date.now() - entry.startedAt,
    mode: entry.mode,
  }));
}

/**
 * Graceful shutdown: stop direct processes, detach persistent ones (they survive restart).
 */
export async function stopAll(): Promise<void> {
  for (const [sid, entry] of activeProcesses) {
    if (entry.mode === 'direct') {
      await stopConversation(sid);
    } else {
      // Persistent: just close our handles, don't kill the claude process
      entry.fifoFd?.close().catch(() => {});
      entry.fifoFd = null;
      try { entry.tailProc.kill(); } catch { /* */ }
      console.log(`[ClaudeCLI] Detached from persistent session ${sid.slice(0, 8)} (pid=${entry.claudePid})`);
    }
  }
  activeProcesses.clear();
}
