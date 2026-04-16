import { Router } from 'express';
import { existsSync, readFileSync, writeFileSync, appendFileSync, readdirSync, statSync, unlinkSync, rmSync, realpathSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

import { PATHS, BRIDGE_URL } from '../config/paths.js';
import { bridgeChat } from '../lib/bridge-fetch.js';
import { isAuthEnabled } from '../auth/users.js';
import type { AttentionReason, ConvAttentionState, SessionState, PanelVisibility } from './shared/types.js';
import { logUserInput as sharedLogUserInput, atomicWriteFileSync } from './shared/utils.js';
import { findJsonlPath, findJsonlPathAllAccounts, ensureJsonlForAccount, readJsonlMetadata, clearMetaCache, readConversationMessages, getOriginalCwd, extractConversationContext, unstickConversation, deepRepairJsonl, compactJsonlForResume, diagnoseSessionHealth } from './shared/jsonl.js';
import * as convMeta from './shared/conv-metadata.js';
import { updateAutoInjectSession, disableAutoInject } from './autoinject.js';

/** Validates that a workDir is under an allowed root path.
 *  Bare /root/projekte is blocked — sessions must use a registered workspace subdirectory. */
function isValidWorkDir(d: string): boolean {
  if (!d) return false;
  if (IS_LOCAL_MODE) return d.startsWith("/Users/") || d.startsWith("/tmp/");
  if (d === '/root/projekte' || d === '/root/projekte/') return false; // Guard: no bare root-projekte
  return d.startsWith("/root/projekte/") || d.startsWith("/root/orchestrator/") || d.startsWith("/home/claude-user") || d.startsWith("/opt/");
}
import { IS_LOCAL_MODE, onSessionStateChange, setSessionState } from './state.js';
import * as claudeCli from './claude-cli.js';

const execAsync = promisify(exec);

// --- Constants ---
const CONV_CACHE_TTL_MS = 5_000;     // Reduced from 15s — stale data was confusing users
const CONV_CACHE_STALE_TTL_MS = 30_000;
const MAX_TITLE_LENGTH = 60;
const MAX_TAIL_MESSAGES = 500;
const COMMANDER_CACHE_TTL_MS = 60_000;

// --- Sub-session tracking (module-level so finish endpoint can access) ---
const _subSessionsAwaitingFinish = new Set<string>();
// Tracks sub-sessions whose injectSubSessionResult() is currently in-flight.
// Prevents duplicate injection runs from the reminder loop during retry windows.
const _subSessionsInjectInProgress = new Set<string>();
// Tracks when the last reminder was sent to each parent session.
// Used to dedupe: only fire a new reminder AFTER the parent has completed at least
// one turn since the previous reminder (prevents stacking reminders in FIFO queue).
const _lastReminderSentAt = new Map<string, number>();

function cleanupSubSession(sessionId: string) {
  _subSessionsAwaitingFinish.delete(sessionId);
  convMeta.setFinished(sessionId, true);
  const parentSessionId = convMeta.getParentSessionId(sessionId);
  convMeta.deleteParentSession(sessionId);
  // Clear pending-reminder state so if parent has other active sub-sessions,
  // reminders can fire again without waiting for a stale dedup entry.
  if (parentSessionId) _lastReminderSentAt.delete(parentSessionId);
  claudeCli.stopConversation(sessionId);
  // Build panelsToClose from visibilityRegistry (same as normal finish)
  const panelsToClose: Array<{ panelId: string; projectId: string }> = [];
  for (const entry of visibilityRegistry.values()) {
    if (entry.sessionId === sessionId) {
      panelsToClose.push({ panelId: entry.panelId, projectId: entry.projectId });
    }
  }
  broadcast({ type: 'control:conversation-finished', sessionId, panelsToClose });
}

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

  // Review completion handler: when a review session reaches done state,
  // inject its result into the original session and mark it finished.
  onSessionStateChange(async (sessionId, state, reason) => {
    const originalSessionId = convMeta.getReviewOriginal(sessionId);
    if (!originalSessionId) return;
    const isDone = (state === 'needs_attention' && reason === 'done') || (state === 'idle' && reason === 'done');
    if (!isDone) return;

    console.log(`[Review] Session ${sessionId.slice(0, 8)} done → injecting feedback into ${originalSessionId.slice(0, 8)}`);
    convMeta.deleteReview(sessionId);

    try {
      // Get last assistant message from review session
      const found = findJsonlPathAllAccounts(sessionId);
      let reviewResult = '';
      if (found) {
        const lines = readFileSync(found.path, 'utf8').trim().split('\n').filter(Boolean).reverse();
        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            if (obj.type === 'assistant' && obj.message?.content) {
              const parts = Array.isArray(obj.message.content) ? obj.message.content : [];
              const text = parts.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim();
              if (text) { reviewResult = text; break; }
            }
          } catch { /* skip */ }
        }
      }

      if (!reviewResult) {
        console.warn(`[Review] No result found for review session ${sessionId.slice(0, 8)}`);
        return;
      }

      // Inject review feedback into original session
      const originalAccountId = convMeta.getAssignment(originalSessionId) || claudeCli.ACCOUNT_CONFIG[0]?.id || 'werking';
      const originalWorkDir = convMeta.getWorkDir(originalSessionId) || '';
      const originalModel = convMeta.getModel(originalSessionId) || '';
      const feedbackMessage = `[Review-Ergebnis]\n\n${reviewResult}`;

      const result = await claudeCli.startConversation(originalAccountId, feedbackMessage, originalWorkDir, originalSessionId, originalModel);
      if (result.ok) {
        broadcast({ type: 'conv-review-complete', sessionId: originalSessionId, reviewSessionId: sessionId, result: reviewResult });
        console.log(`[Review] Feedback injected into ${originalSessionId.slice(0, 8)}`);
      } else {
        console.warn(`[Review] Injection failed: ${result.error}`);
      }

      // Mark review session as finished
      convMeta.setFinished(sessionId, true);
      await claudeCli.stopConversation(sessionId);
      broadcast({ type: 'control:conversation-finished', sessionId, panelsToClose: [] });
    } catch (err) {
      console.warn('[Review] Completion handler error:', (err as Error).message);
    }
  });

  // Sub-session completion handler: when a sub-session reaches done state,
  // inject its result into the parent session. The sub-session is NOT auto-finished —
  // the parent must explicitly finish it via POST /conversation/:id/finish.
  // Includes retry logic (max 5 attempts, 30s delay) if parent is busy.
  const SUB_INJECT_MAX_RETRIES = 5;
  const SUB_INJECT_RETRY_DELAY_MS = 30_000;

  async function injectSubSessionResult(sessionId: string, parentSessionId: string, attempt: number = 1) {
    // Guard: don't re-inject if already completed
    if (_subSessionsAwaitingFinish.has(sessionId)) return;
    // Guard: prevent concurrent injection runs for the same sub-session
    // (first attempt sets the flag; retries are the same run so they don't re-check)
    if (attempt === 1) {
      if (_subSessionsInjectInProgress.has(sessionId)) return;
      _subSessionsInjectInProgress.add(sessionId);
    }

    const subjectTitle = convMeta.getTitle(sessionId) || 'Sub-Session';
    console.log(`[SubSession] ${sessionId.slice(0, 8)} → injecting into parent ${parentSessionId.slice(0, 8)} (attempt ${attempt}/${SUB_INJECT_MAX_RETRIES})`);

    try {
      // Extract last assistant message from sub-session JSONL
      const found = findJsonlPathAllAccounts(sessionId);
      let subResult = '';
      if (found) {
        const lines = readFileSync(found.path, 'utf8').trim().split('\n').filter(Boolean).reverse();
        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            if (obj.type === 'assistant' && obj.message?.content) {
              const parts = Array.isArray(obj.message.content) ? obj.message.content : [];
              const text = parts.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim();
              if (text) { subResult = text; break; }
            }
          } catch { /* skip malformed lines */ }
        }
      }

      if (!subResult) {
        console.warn(`[SubSession] No result found for sub-session ${sessionId.slice(0, 8)} — marking as awaiting finish anyway`);
        _subSessionsAwaitingFinish.add(sessionId);
        _subSessionsInjectInProgress.delete(sessionId);
        claudeCli.stopConversation(sessionId);
        return;
      }

      // Inject sub-session result into parent session
      const parentAccountId = convMeta.getAssignment(parentSessionId) || claudeCli.ACCOUNT_CONFIG[0]?.id || 'werking';
      const parentWorkDir = convMeta.getWorkDir(parentSessionId) || '';
      const parentModel = convMeta.getModel(parentSessionId) || '';
      const finishCmd = `curl -s -X POST http://localhost:4005/api/mission/conversation/${sessionId}/finish -H 'Content-Type: application/json' -d '{"finished":true}'`;
      const injectMessage = `[Sub-Session Ergebnis: ${subjectTitle}]\n\n${subResult}\n\nPruefe ob alles korrekt ist. Wenn erledigt, finishe die Sub-Session mit:\n${finishCmd}`;

      const result = await claudeCli.startConversation(parentAccountId, injectMessage, parentWorkDir, parentSessionId, parentModel);
      if (result.ok) {
        broadcast({ type: 'conv-subsession-complete', sessionId: parentSessionId, subSessionId: sessionId, result: subResult });
        console.log(`[SubSession] Result injected into parent ${parentSessionId.slice(0, 8)} — awaiting explicit finish`);
        _subSessionsAwaitingFinish.add(sessionId);
        _subSessionsInjectInProgress.delete(sessionId);
        // Stop CLI process (work is done) but do NOT mark as finished — parent must do that
        claudeCli.stopConversation(sessionId);
      } else {
        console.warn(`[SubSession] Injection into parent failed: ${result.error}`);
        if (attempt < SUB_INJECT_MAX_RETRIES) {
          console.log(`[SubSession] Retrying in ${SUB_INJECT_RETRY_DELAY_MS / 1000}s...`);
          setTimeout(() => injectSubSessionResult(sessionId, parentSessionId, attempt + 1), SUB_INJECT_RETRY_DELAY_MS);
        } else {
          console.warn(`[SubSession] All ${SUB_INJECT_MAX_RETRIES} retries exhausted for ${sessionId.slice(0, 8)} → marking as awaiting finish`);
          _subSessionsAwaitingFinish.add(sessionId);
          _subSessionsInjectInProgress.delete(sessionId);
          claudeCli.stopConversation(sessionId);
        }
      }
    } catch (err) {
      console.warn(`[SubSession] Completion handler error (attempt ${attempt}): ${(err as Error).message}`);
      if (attempt < SUB_INJECT_MAX_RETRIES) {
        console.log(`[SubSession] Retrying in ${SUB_INJECT_RETRY_DELAY_MS / 1000}s...`);
        setTimeout(() => injectSubSessionResult(sessionId, parentSessionId, attempt + 1), SUB_INJECT_RETRY_DELAY_MS);
      } else {
        console.warn(`[SubSession] All ${SUB_INJECT_MAX_RETRIES} retries exhausted for ${sessionId.slice(0, 8)} — marking as awaiting finish`);
        _subSessionsAwaitingFinish.add(sessionId);
        _subSessionsInjectInProgress.delete(sessionId);
        claudeCli.stopConversation(sessionId);
      }
    }
  }

  onSessionStateChange(async (sessionId, state, reason) => {
    // Only handle sub-sessions with a tracked parent
    const parentSessionId = convMeta.getParentSessionId(sessionId);
    if (!parentSessionId) return;

    const isDone = (state === 'needs_attention' && reason === 'done') || (state === 'idle' && reason === 'done');
    if (!isDone) return;

    await injectSubSessionResult(sessionId, parentSessionId);
  });

  // --- Sub-session progress tracker ---
  // Every 60s, check active sub-sessions and broadcast progress to their parents.
  // This gives parents continuous visibility into what their sub-sessions are doing.
  const _subProgressLastSeen = new Map<string, string>(); // sessionId → last known summary hash
  const SUB_PROGRESS_INTERVAL_MS = 60_000;

  setInterval(() => {
    // Iterate active CLI processes — only sub-sessions with a parent get progress reports
    for (const proc of claudeCli.getActiveProcesses()) {
      const parentSessionId = convMeta.getParentSessionId(proc.sessionId);
      if (!parentSessionId) continue;
      if (_subSessionsAwaitingFinish.has(proc.sessionId)) continue;

      // Extract latest assistant message summary from JSONL
      const found = findJsonlPathAllAccounts(proc.sessionId);
      if (!found) continue;

      let lastSummary = '';
      let lastToolInfo = '';
      try {
        const lines = readFileSync(found.path, 'utf8').trim().split('\n').filter(Boolean).reverse();
        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            if (obj.type === 'assistant' && obj.message?.content) {
              const parts = Array.isArray(obj.message.content) ? obj.message.content : [];
              const text = parts.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim();
              if (text) { lastSummary = text.slice(0, 300); break; }
              // Check for tool use as progress indicator
              const toolUse = parts.find((b: any) => b.type === 'tool_use');
              if (toolUse && !lastToolInfo) { lastToolInfo = `Tool: ${toolUse.name}`; }
            }
          } catch { /* skip */ }
        }
      } catch { continue; }

      const summary = lastSummary || lastToolInfo || '';
      if (!summary) continue;

      // Only broadcast if something changed since last check
      const prevHash = _subProgressLastSeen.get(proc.sessionId);
      const currentHash = summary.slice(0, 50);
      if (prevHash === currentHash) continue;
      _subProgressLastSeen.set(proc.sessionId, currentHash);

      const title = convMeta.getTitle(proc.sessionId) || proc.sessionId.slice(0, 8);
      const state = getSessionStates()[proc.sessionId];
      broadcast({
        type: 'conv-subsession-progress',
        parentSessionId,
        subSessionId: proc.sessionId,
        subSessionTitle: title,
        subSessionState: state?.state || 'working',
        summary: summary.slice(0, 200),
      });
    }
  }, SUB_PROGRESS_INTERVAL_MS);

  // Rate-limit auto-account-switch: when a session hits rate_limit,
  // automatically switch to the least-loaded account and respawn.
  const RATE_LIMIT_SWITCH_DELAY_MS = 5_000; // Wait 5s before switching (debounce)
  const _rateLimitSwitchPending = new Set<string>(); // Prevent double-switch

  onSessionStateChange(async (sessionId, state, reason) => {
    if (reason !== 'rate_limit' && reason !== 'overloaded') return;
    if (_rateLimitSwitchPending.has(sessionId)) return;
    // Don't auto-switch finished or sub-sessions (sub-sessions are managed by parent)
    if (convMeta.isFinished(sessionId) || convMeta.isSubSession(sessionId)) return;

    _rateLimitSwitchPending.add(sessionId);
    console.log(`[AutoSwitch] ${sessionId.slice(0, 8)}: rate-limited, checking for better account in ${RATE_LIMIT_SWITCH_DELAY_MS / 1000}s...`);

    setTimeout(async () => {
      try {
        // Re-check: still rate-limited?
        const currentState = getSessionStates()[sessionId];
        if (currentState?.reason !== 'rate_limit' && currentState?.reason !== 'overloaded') {
          console.log(`[AutoSwitch] ${sessionId.slice(0, 8)}: no longer rate-limited, skipping switch`);
          return;
        }

        const currentAccountId = convMeta.getAssignment(sessionId) || currentState?.accountId || '';

        // Find best available account
        let bestAccount = '';
        try {
          const resp = await fetch(`http://localhost:${process.env.PORT || 4005}/api/claude-code/best-account`, { signal: AbortSignal.timeout(3000) });
          if (resp.ok) {
            const data = await resp.json() as any;
            const accounts = data.accounts || [];
            // Pick best account that is available AND not the current one
            const better = accounts.find((a: any) => a.available && a.accountId !== currentAccountId);
            if (better) bestAccount = better.accountId;
          }
        } catch { /* best-account API failed, skip */ }

        if (!bestAccount) {
          console.log(`[AutoSwitch] ${sessionId.slice(0, 8)}: no better account available (all critical or same), waiting for rate-limit to expire`);
          broadcast({ type: 'conv-rate-limit-no-switch', sessionId, currentAccountId, reason: 'no available account' });
          return;
        }

        console.log(`[AutoSwitch] ${sessionId.slice(0, 8)}: switching ${currentAccountId} → ${bestAccount}`);

        // Stop current process
        await claudeCli.stopConversation(sessionId);

        // Ensure JSONL accessible from new account
        ensureJsonlForAccount(sessionId, bestAccount);

        // Update metadata
        convMeta.saveAssignment(sessionId, bestAccount);

        // Respawn under new account
        const workDir = convMeta.getWorkDir(sessionId) || '';
        const model = convMeta.getModel(sessionId) || '';
        const result = await claudeCli.startConversation(bestAccount, 'continue', workDir, sessionId, model);

        if (result.ok) {
          console.log(`[AutoSwitch] ${sessionId.slice(0, 8)}: switched to ${bestAccount} successfully`);
          broadcast({ type: 'conv-account-switched', sessionId, fromAccount: currentAccountId, toAccount: bestAccount, reason: 'rate_limit' });
          invalidateConvCache();
        } else {
          console.warn(`[AutoSwitch] ${sessionId.slice(0, 8)}: respawn under ${bestAccount} failed: ${result.error}`);
          // Restore original assignment
          convMeta.saveAssignment(sessionId, currentAccountId);
        }
      } catch (err) {
        console.warn(`[AutoSwitch] Error for ${sessionId.slice(0, 8)}:`, (err as Error).message);
      } finally {
        _rateLimitSwitchPending.delete(sessionId);
      }
    }, RATE_LIMIT_SWITCH_DELAY_MS);
  });

  // Sub-session reminder loop: every 5 minutes, remind parent sessions about
  // their active sub-sessions. Keeps reminding until parent explicitly finishes them.
  const SUB_REMINDER_INTERVAL_MS = 5 * 60_000; // 5 minutes

  setInterval(() => {
    const states = getSessionStates();
    const allSubs = convMeta.getAllSubSessions(); // all sessions marked as sub-session

    // Phase 1: Detect "silently exited" sub-sessions and route them through the normal
    // completion workflow instead of auto-finishing. A sub-session whose CLI process is gone
    // but that never fired the onSessionStateChange 'done' hook needs to go through
    // injectSubSessionResult() so the parent gets notified and can explicitly finish.
    // This preserves the core invariant: ONLY the parent marks a sub-session finished.
    // Exception: sub-sessions without a parent — those are truly orphaned, handled in Phase 3.
    for (const sessionId of Object.keys(allSubs)) {
      if (convMeta.isFinished(sessionId)) continue;
      if (_subSessionsAwaitingFinish.has(sessionId)) continue;
      const hasProcess = !!states[sessionId];
      if (hasProcess) continue;
      const parentSessionId = convMeta.getParentSessionId(sessionId);
      if (!parentSessionId) continue; // handled later in Phase 3 (orphans)
      const title = convMeta.getTitle(sessionId) || sessionId.slice(0, 8);
      console.log(`[SubSession] Silently-exited sub-session "${title}" (${sessionId.slice(0, 8)}) — routing through injectSubSessionResult so parent can review/finish`);
      // Fire-and-forget: this will inject result into parent + add to awaitingFinish.
      // Parent will then see "FERTIG, bitte pruefen" on next reminder loop.
      injectSubSessionResult(sessionId, parentSessionId).catch(err => {
        console.warn(`[SubSession] injectSubSessionResult failed for silently-exited ${sessionId.slice(0, 8)}: ${(err as Error).message}`);
      });
    }

    // Phase 2: Collect all active sub-sessions that have a parent and are NOT finished
    const allSubSessions = new Map<string, string>(); // sessionId → parentSessionId
    for (const sessionId of Object.keys(allSubs)) {
      if (convMeta.isFinished(sessionId)) continue;
      const parentSessionId = convMeta.getParentSessionId(sessionId);
      if (parentSessionId) {
        allSubSessions.set(sessionId, parentSessionId);
      }
    }
    // Also check completed sub-sessions awaiting finish (their CLI is stopped, so they won't be in states)
    for (const sessionId of _subSessionsAwaitingFinish) {
      if (convMeta.isFinished(sessionId)) { _subSessionsAwaitingFinish.delete(sessionId); continue; }
      const parentSessionId = convMeta.getParentSessionId(sessionId);
      if (parentSessionId) allSubSessions.set(sessionId, parentSessionId);
    }

    // Phase 3: Orphan sub-sessions (active, but no parent)
    const orphansWithProcess: string[] = [];
    for (const sessionId of Object.keys(allSubs)) {
      if (convMeta.isFinished(sessionId)) continue;
      if (allSubSessions.has(sessionId)) continue; // already has parent
      const hasProcess = !!states[sessionId];
      if (!hasProcess) {
        const title = convMeta.getTitle(sessionId) || sessionId.slice(0, 8);
        console.log(`[SubSession] Auto-finishing orphan sub-session "${title}" (${sessionId.slice(0, 8)}) — no process, no parent`);
        convMeta.setFinished(sessionId, true);
      } else {
        orphansWithProcess.push(sessionId);
      }
    }

    // Phase 4: Report orphan sub-sessions with running processes to the Mission Chat
    // (these are sub-sessions that were spawned before parent-tracking was implemented)
    if (orphansWithProcess.length > 0) {
      // Find a Mission Chat session (orchestrator/administration workspace, idle)
      let missionChat: string | null = null;
      for (const [key, sState] of Object.entries(states)) {
        const sid = sState.sessionId || key;
        if (sState.state !== 'idle') continue;
        const wdir = convMeta.getWorkDir(sid);
        if (wdir && (wdir.includes('orchestrator') || wdir.includes('administration') || wdir.includes('diverse'))) {
          missionChat = sid;
          break;
        }
      }

      if (missionChat) {
        const lines = orphansWithProcess.map(sid => {
          const title = convMeta.getTitle(sid) || sid.slice(0, 8);
          const wdir = convMeta.getWorkDir(sid)?.split('/').pop() || '?';
          return `- "${title}" (${sid.slice(0, 8)}, workspace: ${wdir}) — laeuft aber hat keinen Parent. Bitte pruefen und ggf. finishen: POST /api/mission/conversation/${sid}/finish {"confirm":true}`;
        });
        const orphanMsg = `[Sub-Session Warnung]\n${orphansWithProcess.length} verwaiste Sub-Session(s) ohne Parent:\n${lines.join('\n')}`;
        const mcAccount = convMeta.getAssignment(missionChat) || claudeCli.ACCOUNT_CONFIG[0]?.id || 'werking';
        const mcWorkDir = convMeta.getWorkDir(missionChat) || '';
        const mcModel = convMeta.getModel(missionChat) || '';
        claudeCli.startConversation(mcAccount, orphanMsg, mcWorkDir, missionChat, mcModel).then(res => {
          if (res.ok) console.log(`[SubSession] Orphan warning sent to Mission Chat ${missionChat!.slice(0, 8)} for ${orphansWithProcess.length} session(s)`);
        }).catch(() => {});
      } else {
        console.warn(`[SubSession] ${orphansWithProcess.length} orphan sub-session(s) with process but no Mission Chat found to notify`);
      }
    }

    // Group by parent for batched reminders
    const byParent = new Map<string, Array<{ sessionId: string; isCompleted: boolean }>>();
    for (const [sessionId, parentSessionId] of allSubSessions) {
      if (!byParent.has(parentSessionId)) byParent.set(parentSessionId, []);
      const isCompleted = _subSessionsAwaitingFinish.has(sessionId);
      byParent.get(parentSessionId)!.push({ sessionId, isCompleted });
    }

    for (const [parentSessionId, subs] of byParent) {
      // Only remind if parent is idle (receptive to messages)
      const parentState = states[parentSessionId];
      if (!parentState || parentState.state !== 'idle') continue;

      // Dedupe: only fire a new reminder if the parent has COMPLETED a turn
      // (entered idle state) AFTER our previous reminder. Without this, reminders
      // would stack up in the FIFO queue — Claude Code would drain many stale reminders
      // even after the sub-session was already finished.
      const lastSent = _lastReminderSentAt.get(parentSessionId) || 0;
      if (lastSent > 0 && parentState.since <= lastSent) {
        // Parent hasn't had a new idle-transition since we last reminded.
        // Either still processing our last reminder, or hasn't received it yet.
        continue;
      }

      try {
        const lines: string[] = [];
        const finishCmds: string[] = [];
        for (const { sessionId, isCompleted } of subs) {
          const title = convMeta.getTitle(sessionId) || sessionId.slice(0, 8);
          if (isCompleted) {
            lines.push(`- "${title}" — ist FERTIG. Bitte Ergebnis pruefen und finishen.`);
          } else {
            lines.push(`- "${title}" — arbeitet noch. Wenn fertig: finishen, sonst bleibt die Session offen.`);
          }
          finishCmds.push(`curl -s -X POST http://localhost:4005/api/mission/conversation/${sessionId}/finish -H 'Content-Type: application/json' -d '{"finished":true,"confirm":true}'`);
        }

        const finishBlock = finishCmds.length > 0 ? `\n\nZum Finishen (nachdem du das Ergebnis geprueft hast):\n${finishCmds.join('\n')}` : '';
        const reminderMsg = `[Sub-Session Reminder]\nDu hast aktive Sub-Sessions:\n${lines.join('\n')}${finishBlock}`;

        const parentAccountId = convMeta.getAssignment(parentSessionId) || claudeCli.ACCOUNT_CONFIG[0]?.id || 'werking';
        const parentWorkDir = convMeta.getWorkDir(parentSessionId) || '';
        const parentModel = convMeta.getModel(parentSessionId) || '';

        // Record send-timestamp BEFORE async call to prevent races between ticks.
        _lastReminderSentAt.set(parentSessionId, Date.now());

        claudeCli.startConversation(parentAccountId, reminderMsg, parentWorkDir, parentSessionId, parentModel).then(res => {
          if (res.ok) {
            console.log(`[SubSession] Reminder sent to parent ${parentSessionId.slice(0, 8)} for ${subs.length} sub-session(s)`);
          } else {
            // Send failed — roll back dedupe timestamp so we'll try again next tick.
            _lastReminderSentAt.delete(parentSessionId);
          }
        }).catch(() => {
          _lastReminderSentAt.delete(parentSessionId);
        });
      } catch {
        // Reminder is best-effort, don't crash
        _lastReminderSentAt.delete(parentSessionId);
      }
    }
  }, SUB_REMINDER_INTERVAL_MS);

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

  // Periodic zombie cleanup: DISABLED — was killing resumed sessions.
  // Manual cleanup still available via POST /cleanup-zombies endpoint.
  // TODO: Re-enable with safeguard: skip sessions with lastPrompt < 10min ago
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
    '-root-projekte-orchestrator': { name: 'orchestrator', path: PATHS.orchestratorDir },
    '-root-projekte-werkingflow': { name: 'werkingflow', path: PATHS.werkingflowDir },
    '-root': { name: 'root', path: '/root' },
    '-tmp': { name: 'tmp', path: '/tmp' },
    '-home-claude-user': { name: 'claude-user', path: PATHS.claudeUserHome },
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

// ---------------------------------------------------------------------------
// logRawUserInput — save raw user text to per-workspace user-history.jsonl
// ---------------------------------------------------------------------------
// This captures ONLY what the user actually typed in the chat input.
// No system context, no auto-inject, no enrichment.
// Stored in: {workspaceDir}/user-history.jsonl (one per workspace)
// Format: {"ts": "ISO", "sessionId": "...", "text": "..."}

function getWorkspaceDir(workDir: string): string | null {
  // Map workDir to workspace data directory
  // e.g. /root/orchestrator/workspaces/diverse -> {DATA_DIR}/workspaces/diverse/
  // For workspace-based workDirs, extract the workspace name
  const wsMatch = workDir.match(/workspaces\/([^/]+)/);
  if (wsMatch) return wsMatch[1];
  // For project-based workDirs, use the project name
  const projMatch = workDir.match(/\/([^/]+)$/);
  if (projMatch) return projMatch[1];
  return null;
}

function logRawUserInput(workDir: string, sessionId: string, text: string): void {
  try {
    const wsName = getWorkspaceDir(workDir);
    if (!wsName) return;

    // Store in DATA_DIR/workspaces/{workspace}/user-history.jsonl
    const wsDir = join(DATA_DIR, 'workspaces', wsName);
    mkdirSync(wsDir, { recursive: true });

    const historyFile = join(wsDir, 'user-history.jsonl');
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      sessionId: sessionId.slice(0, 8),
      text: text.trim(),
    });
    appendFileSync(historyFile, entry + '\n');
  } catch (err) {
    console.warn('[Mission] Failed to log raw user input:', err instanceof Error ? err.message : err);
  }
}

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

    // Priority: 1) assigned account, 2) streaming, 3) ongoing, 4) preferred order (rafael > engelmann > office)
    const streaming = entries.find(e => e.streamingId);
    const ongoing = entries.find(e => e.status === 'ongoing');
    let best: any;

    if (assigned) {
      // User-assigned account takes priority — never override
      best = entries.find(e => e.accountId === assigned) || entries[0];
    } else if (streaming) {
      best = streaming;
      convMeta.saveAssignment(sessionId, streaming.accountId);
    } else if (ongoing) {
      best = ongoing;
      convMeta.saveAssignment(sessionId, ongoing.accountId);
    } else {
      // No assignment yet — prefer rafael > engelmann > office
      const preferOrder = ['engelmann', 'office', 'gmail'];
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

// Helper: get all registered workspace workDirs from project configs
function getRegisteredWorkspaces(): string[] {
  try {
    return readdirSync(PROJECTS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => { try { return JSON.parse(readFileSync(join(PROJECTS_DIR, f), 'utf8')).workDir; } catch { return null; } })
      .filter((d): d is string => !!d);
  } catch { return []; }
}

// Helper: check if workDir matches a registered workspace (exact match or subdirectory)
function isRegisteredWorkspace(workDir: string): boolean {
  if (!workDir) return false;
  const registered = getRegisteredWorkspaces();
  return registered.some(ws => workDir === ws || workDir.startsWith(ws + '/'));
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
        const storedAcctId = convMeta.getAssignment(sessionId);
        // Migrate old account IDs from pre-April-2026 rename
        const ACCT_MIGRATION: Record<string, string> = { rafael: "engelmann", engelmann: "gmail" };
        const migratedAcctId = storedAcctId ? (ACCT_MIGRATION[storedAcctId] ?? storedAcctId) : "";
        const resolvedAcctId = activeAcctId || migratedAcctId;
        const effectiveAccount = resolvedAcctId
          ? claudeCli.ACCOUNT_CONFIG.find(a => a.id === resolvedAcctId)
          : undefined;
        if (!effectiveAccount) continue; // skip unassigned — no silent fallback
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
          processAlive: isRunning,
          streamingId: null,
          model: meta.model || '',
          messageCount: meta.messageCount || 0,
          updatedAt: meta.updatedAt || '',
          createdAt: meta.createdAt || '',
          _lastRole: meta.lastRole || '',
        });
      }
    }
  }
  console.log(`[Perf] fetchConvList scan: ${Date.now() - t0}ms, ${results.length} conversations, ${scannedRealpaths.size} unique dirs`);

  const promptTimes = convMeta.getAllLastPrompts();
  const assignedModels = convMeta.getAllModels();
  for (const r of results) {
    r.lastPromptAt = promptTimes[r.sessionId] || '';
    r.assignedModel = assignedModels[r.sessionId] || '';
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
    // Look up by sessionId (primary key for state tracking)
    const stateInfo = states[conv.sessionId] || states[conv.accountId];
    if (stateInfo) {
      (conv as any).attentionState = stateInfo.state;
      (conv as any).attentionReason = stateInfo.reason;
      (conv as any).toolInfo = stateInfo.toolInfo;
    } else if (conv.status !== 'ongoing' && conv._lastRole === 'assistant') {
      // Auto-recover: last message from assistant + no active process = needs attention
      // But only if the session was updated recently (< 5 min) — stale completed sessions
      // shouldn't pollute workspace badges with permanent orange indicators
      const updatedMs = conv.updatedAt ? new Date(conv.updatedAt).getTime() : 0;
      const ageMs = updatedMs > 0 ? (Date.now() - updatedMs) : Infinity;
      if (ageMs < 5 * 60 * 1000) {
        (conv as any).attentionState = 'needs_attention';
        (conv as any).attentionReason = 'waiting';
      }
    }
  }

  // Finished conversations: clear attention (user clicked Finish)
  const finished = convMeta.getAllFinished();
  for (const conv of deduped) {
    if (finished[conv.sessionId]) {
      (conv as any).manualFinished = true;
      (conv as any).attentionState = undefined;
      (conv as any).attentionReason = undefined;
    }
  }

  const paused = convMeta.getAllPaused();
  const subSessions = convMeta.getAllSubSessions();
  for (const conv of deduped) {
    if (paused[conv.sessionId]) {
      (conv as any).manualPaused = true;
    }
    if (subSessions[conv.sessionId]) {
      (conv as any).isSubSession = true;
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
  const forceFresh = req.query.fresh === 'true';
  const now = Date.now();
  const age = now - _convCache.timestamp;

  let data: any = null;

  if (forceFresh || !_convCache.data) {
    // Force fresh fetch: ?fresh=true or cold start
    const fresh = await fetchConvList();
    _convCache = { data: fresh, timestamp: Date.now(), refreshing: false };
    data = fresh;
  } else if (_convCache.data) {
    // Serve cached data immediately
    data = _convCache.data;

    // Trigger background refresh if stale (>5s)
    if (age > CONV_CACHE_TTL_MS && !_convCache.refreshing) {
      _convCache.refreshing = true;
      (async () => {
        try {
          const fresh = await fetchConvList();
          _convCache = { data: fresh, timestamp: Date.now(), refreshing: false };
          broadcast({ type: 'conversations-refreshed', total: fresh.total });
        } catch (err) {
          console.warn('[Mission] Background conv cache refresh failed:', err instanceof Error ? err.message : err);
          _convCache.refreshing = false;
        }
      })();
    }
  }

  // Partner isolation: non-admin users only see their own conversations
  const convUserRole = (req as any).user?.role;
  const convUserId = (req as any).user?.sub || (req as any).user?.id;
  const convIsAdmin = convUserRole === 'admin';
  if (!convIsAdmin && convUserId && data) {
    const allUsers = convMeta.getAllUsers();
    data = {
      ...data,
      conversations: data.conversations.filter((c: any) => {
        const sessionOwner = allUsers[c.sessionId];
        // Show conversations owned by this user, or unowned (legacy/admin sessions are hidden)
        return sessionOwner === convUserId;
      }),
    };
    data.total = data.conversations.length;
  }

  // Apply project filter AFTER cache and user isolation
  if (filterProject && data) {
    const isSubSessionsWorkspace = filterProject.includes('sub-sessions');
    const filtered = { ...data, conversations: data.conversations.filter((c: any) => {
      // Sub-sessions workspace: show all sub-sessions regardless of projectPath
      if (isSubSessionsWorkspace) return !!c.isSubSession;
      // Normal workspace: match by projectPath, exclude sub-sessions
      return (c.projectPath || '').includes(filterProject) && !c.isSubSession;
    }), total: 0 };
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
    // Strip system context from user messages (resume enrichment + session context noise)
    let displayContent = m.message?.content || m.content || '';
    if ((m.message?.role || m.type) === 'user' && typeof displayContent === 'string') {
      displayContent = displayContent
        .replace(/<session-context>[\s\S]*?<\/session-context>\s*/g, '')
        .replace(/\[KONTEXT:[^\]]*\]\s*/g, '')
        .replace(/\[PEERS:[^\]]*\]\s*/g, '')
        .replace(/\[TEAM\]\n?[\s\S]*?(?=\n[^#\[_*\-\s]|$)/g, '')
        .trim();
    } else if ((m.message?.role || m.type) === 'user' && Array.isArray(displayContent)) {
      displayContent = displayContent.map((block: any) => {
        if (block.type === 'text' && typeof block.text === 'string') {
          const cleaned = block.text
            .replace(/<session-context>[\s\S]*?<\/session-context>\s*/g, '')
            .replace(/\[KONTEXT:[^\]]*\]\s*/g, '')
            .replace(/\[PEERS:[^\]]*\]\s*/g, '')
            .replace(/\[TEAM\]\n?[\s\S]*?(?=\n[^#\[_*\-\s]|$)/g, '')
            .trim();
          return cleaned ? { ...block, text: cleaned } : null;
        }
        return block;
      }).filter(Boolean);
    }
    return {
      role: m.message?.role || m.type || 'user',
      content: displayContent,
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
  // Agent is "done" (waiting for user input) when last message is assistant text without pending tool calls.
  // isRunning is NOT a factor — the CLI process stays alive while waiting for input.
  const isAgentDone = lastRole === 'assistant' && !hasPendingToolUse;

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
    assignedModel: convMeta.getModel(req.params.sessionId) || '',
    manualPaused: convMeta.isPaused(req.params.sessionId) || false,
  });
  } catch (err: any) {
    console.warn('[Server] GET /api/mission/conversation detail error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// 3. Send message to existing conversation (via claude-cli direct spawn)
router.post('/send', async (req, res) => {
  try {
  let { accountId, sessionId, message, workDir } = req.body;
  if (!accountId || !sessionId || !message || (typeof message === 'string' && !message.trim())) {
    res.status(400).json({ error: 'accountId, sessionId, message required' });
    return;
  }

  // Resolve 'auto' → use existing assignment or pick best available account
  if (accountId === 'auto') {
    const existing = convMeta.getAssignment(sessionId);
    if (existing && existing !== 'auto' && claudeCli.getAccountConfig(existing)) {
      accountId = existing;
    } else {
      try {
        const bestResp = await fetch(`http://localhost:${process.env.PORT || 4005}/api/claude-code/best-account`, { signal: AbortSignal.timeout(3000) });
        if (bestResp.ok) {
          const bestData = await bestResp.json() as any;
          accountId = bestData.bestAccount || 'werking';
        } else {
          accountId = 'werking';
        }
      } catch {
        accountId = 'werking';
      }
      convMeta.saveAssignment(sessionId, accountId);
    }
  }

  if (!claudeCli.getAccountConfig(accountId)) {
    res.status(400).json({ error: 'unknown account' }); return;
  }

  // Resolve workDir: validate explicit > persisted > default (no fallback to bare /root/projekte)
  const defaultWorkDir = IS_LOCAL_MODE ? '/Users/rafael/Documents/GitHub' : null;
  const resolvedWorkDir = (isValidWorkDir(workDir) ? workDir : null) || convMeta.getWorkDir(sessionId) || defaultWorkDir || '/root/projekte';
  if (workDir) convMeta.saveWorkDir(sessionId, workDir);

  // Block if session has active tool executions (prevents API 400 concurrency error)
  if (claudeCli.isActive(sessionId) && claudeCli.hasActiveTools(sessionId)) {
    const toolInfo = claudeCli.getToolInfo(sessionId);
    const elapsed = toolInfo ? Math.round((Date.now() - toolInfo.startedAt) / 1000) : 0;
    console.log(`[Send] BLOCKED: session ${sessionId.slice(0, 8)} has active tool "${toolInfo?.toolName}" (${elapsed}s)`);
    res.status(409).json({
      error: 'Session hat aktive Tool-Ausfuehrungen. Bitte warten.',
      toolName: toolInfo?.toolName,
      toolDetail: toolInfo?.toolDetail,
      elapsedSeconds: elapsed,
      retryAfterMs: 10000,
    });
    return;
  }

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
        logRawUserInput(resolvedWorkDir, sessionId, message);
        convMeta.setLastPrompt(sessionId);
        convMeta.setFinished(sessionId, false); // Auto-unfinish when message sent
        convMeta.saveAssignment(sessionId, accountId);
        setSessionState(sessionId, accountId, 'working', undefined, sessionId); // Clear idle/done → working
        invalidateConvCache();
        res.json({ ok: true, sessionId, piped: true });
        return;
      }
      console.log(`[Send] stdin pipe failed for session ${sessionId.slice(0, 8)}, falling back to respawn`);
    }
  }

  // Only resume if JSONL file exists (otherwise it's a new session)
  const jsonlInfo = findJsonlPathAllAccounts(sessionId);
  const jsonlExists = jsonlInfo !== null;
  const resumeId = jsonlExists ? sessionId : undefined;

  // Cross-account resume: ensure JSONL is accessible from target account HOME
  if (jsonlExists && jsonlInfo!.accountId !== accountId) {
    const linked = ensureJsonlForAccount(sessionId, accountId);
    if (linked) {
      console.log();
    } else {
      console.warn();
    }
  }

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

  // Read stored model for this session (for resume)
  // Partners (non-admin) are restricted to sonnet — dev-server (no auth) = admin
  const resumeUserRole = (req as any).user?.role;
  const resumeIsAdmin = !isAuthEnabled() || resumeUserRole === 'admin';
  const resumeDefault = resumeIsAdmin ? 'opus' : 'sonnet';
  let storedModel = convMeta.getModel(sessionId) || resumeDefault;
  // Enforce model restriction: partners cannot resume with opus
  if (!resumeIsAdmin && storedModel === 'opus') storedModel = 'sonnet';

  // Enrich message with session context on resume (prevents context amnesia)
  // Inlines full user messages + truncated assistant text — no tool calls
  let resumeMessage = message;
  if (resumeId) {
    const ctx = extractConversationContext(sessionId, 100);
    if (ctx) {
      resumeMessage = `<session-context>\n[SESSION_ID: ${sessionId}]\n${ctx}\n</session-context>\n\n${message}`;
      console.log(`[Send] Enriched resume message with inline context (${ctx.length} chars)`);
    } else {
      // Even without conversation context, inject session ID so the session knows itself
      resumeMessage = `<session-context>\n[SESSION_ID: ${sessionId}]\n</session-context>\n\n${message}`;
    }
  }

  let finalSessionId = sessionId;
  let resumeFailed = false;
  let result = await claudeCli.startConversation(accountId, resumeMessage, resumeWorkDir, resumeId, storedModel);

  // If resume failed, try deep repair then retry with original CWD
  if (!result.ok) {
    console.log(`[Send] Resume failed for ${sessionId}: ${result.error} — attempting deep repair...`);
    const deepCleaned = deepRepairJsonl(sessionId);
    if (deepCleaned > 0) {
      result = await claudeCli.startConversation(accountId, resumeMessage, resumeWorkDir, sessionId, storedModel);
    }
    // Still fails — start fresh WITH conversation context (don't lose history)
    if (!result.ok) {
      const context = extractConversationContext(sessionId);
      if (context) {
        console.log(`[Send] Resume failed — starting fresh session WITH conversation context`);
        const contextMessage = `${context}\n\n[Neue Nachricht vom User:]\n${message}`;
        result = await claudeCli.startConversation(accountId, contextMessage, resumeWorkDir, undefined, storedModel);
      } else {
        console.log(`[Send] Resume failed, no context available — starting fresh session`);
        result = await claudeCli.startConversation(accountId, message, resumeWorkDir, undefined, storedModel);
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
  logRawUserInput(resolvedWorkDir, finalSessionId, message);
  convMeta.saveAssignment(finalSessionId, accountId);
  setSessionState(finalSessionId, accountId, 'working', undefined, finalSessionId); // Clear idle/done → working
  convMeta.saveWorkDir(finalSessionId, resolvedWorkDir);
  convMeta.setLastPrompt(finalSessionId);
  // Ensure userId is set for partner isolation (covers resumed sessions)
  const sendUserId = (req as any).user?.sub || (req as any).user?.id;
  if (sendUserId && !convMeta.getUser(finalSessionId)) convMeta.saveUser(finalSessionId, sendUserId);
  convMeta.setFinished(finalSessionId, false); // Auto-unfinish when message sent
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
// Atomic account-switch: updates all 4 layers (conv-metadata, layouts, visibility, browser)
router.post('/conversation/:sessionId/assign', async (req, res) => {
  let { accountId, workDir } = req.body;
  if (!accountId) { res.status(400).json({ error: 'accountId required' }); return; }
  const sid = req.params.sessionId;

  // Resolve 'auto' → pick best available account (don't persist 'auto' as assignment)
  if (accountId === 'auto') {
    try {
      const bestResp = await fetch(`http://localhost:${process.env.PORT || 4005}/api/claude-code/best-account`, { signal: AbortSignal.timeout(3000) });
      if (bestResp.ok) {
        const bestData = await bestResp.json() as any;
        accountId = bestData.bestAccount || 'werking';
      } else {
        accountId = 'werking';
      }
    } catch {
      accountId = 'werking';
    }
    console.log(`[Assign] Resolved 'auto' → ${accountId} for session ${sid.slice(0, 8)}`);
  }

  // --- Layer 1: Conversation Metadata ---
  convMeta.saveAssignment(sid, accountId);
  if (workDir) convMeta.saveWorkDir(sid, workDir);

  // Auto-unstick: remove rate-limit messages so the conversation can continue on the new account
  const removed = unstickConversation(sid);
  if (removed > 0) console.log(`[Assign] Unsticked ${sid}: removed ${removed} rate-limit messages`);

  // --- Layer 2: Layout Configuration ---
  // Scan all layout files and update any tab whose sessionId matches this conversation
  const layoutsDir = join(DATA_DIR, 'layouts');
  const layoutsUpdated: string[] = [];
  try {
    const layoutFiles = readdirSync(layoutsDir).filter(f => f.endsWith('.json') && !f.includes('_template') && !f.includes('.bak'));
    for (const file of layoutFiles) {
      const layoutPath = join(layoutsDir, file);
      try {
        const layoutData = JSON.parse(readFileSync(layoutPath, 'utf8'));
        let changed = false;

        // Recursively walk the layout tree to find tabs with matching sessionId
        const updateLayoutNode = (node: any): void => {
          if (!node || typeof node !== 'object') return;
          if (node.config && (node.config.sessionId === sid || node.config.initialSessionId === sid)) {
            if (node.config.accountId !== accountId) {
              console.log(`[Assign] Layout ${file}: updating tab "${node.name || node.component}" accountId ${node.config.accountId} → ${accountId}`);
              node.config.accountId = accountId;
              changed = true;
            }
          }
          if (Array.isArray(node.children)) {
            for (const child of node.children) updateLayoutNode(child);
          }
          if (node.layout && typeof node.layout === 'object') updateLayoutNode(node.layout);
        };

        updateLayoutNode(layoutData);
        if (changed) {
          writeFileSync(layoutPath, JSON.stringify(layoutData, null, 2));
          const projectId = file.replace('.json', '');
          layoutsUpdated.push(projectId);
          // Broadcast layout change so browser re-renders the panel with new account
          broadcast({ type: 'control:apply-layout', projectId, layout: layoutData });
        }
      } catch (err: any) {
        console.error(`[Assign] Failed to update layout ${file}: ${err.message}`);
      }
    }
  } catch (err: any) {
    console.error(`[Assign] Failed to read layouts dir: ${err.message}`);
  }

  // --- Layer 3: Visibility Registry ---
  // Update accountId on any panel currently showing this session
  for (const [_key, entry] of visibilityRegistry) {
    if (entry.sessionId === sid && entry.accountId !== accountId) {
      console.log(`[Assign] Visibility: updating panel ${entry.panelId} accountId ${entry.accountId} → ${accountId}`);
      entry.accountId = accountId;
    }
  }

  // --- Layer 4: Browser Notification ---
  // Broadcast account change so all connected browsers update their panels
  const resolvedWorkDir = convMeta.getWorkDir(sid);
  broadcast({ type: 'conv-account-changed', sessionId: sid, accountId, workDir: resolvedWorkDir, layoutsUpdated });

  res.json({ ok: true, sessionId: sid, accountId, unsticked: removed, workDir: resolvedWorkDir, layoutsUpdated });
});

// 5c. Get panel visibility (which conversations are open in which panels)
router.get('/visibility', (_req, res) => {
  const panels: PanelVisibility[] = [];
  for (const entry of visibilityRegistry.values()) panels.push(entry);
  res.json({ panels, visibleSessionIds: [...getVisibleSessionIds()] });
});

// 5c2. Remove panel from visibility registry (HTTP fallback for when WS is already closed)
router.post('/panel-removed', (req, res) => {
  const { panelId, projectId } = req.body || {};
  if (!panelId || !projectId) { res.status(400).json({ error: 'panelId and projectId required' }); return; }
  const key = `${projectId}:${panelId}`;
  if (visibilityRegistry.has(key)) {
    visibilityRegistry.delete(key);
    broadcast({ type: 'visibility-update', visibleSessionIds: [...getVisibleSessionIds()] });
  }
  res.json({ ok: true });
});

// 5d. Mark conversation as finished (user override) — also kills the CLI process
// For sub-sessions: this is the ONLY way to finish them (no auto-finish).
router.post('/conversation/:sessionId/finish', async (req, res) => {
  const body = req.body || {};
  const finished = body.finished !== false;
  const sid = req.params.sessionId;
  const confirm = body.confirm === true;

  // SAFETY GUARD: If session has a live process, require explicit confirm: true
  // This prevents Claude Code (or any caller) from blindly mass-killing sessions.
  // Without confirm, the caller gets session details back and must acknowledge the kill.
  if (finished && !confirm) {
    const isAlive = claudeCli.isActive(sid);
    if (isAlive) {
      // If process is alive but session is idle/done, treat it as finished — no confirm needed.
      // Claude Code stays idle after every response, so "alive" doesn't mean "working".
      const stateInfo = getSessionStates()[sid];
      const state = stateInfo?.state;
      const reason = stateInfo?.reason;
      const isDone = (state === 'needs_attention' && reason === 'done') || (state === 'idle' && reason === 'done');
      if (!isDone) {
        const title = convMeta.getTitle(sid) || sid.slice(0, 8);
        const isSubSession = !!convMeta.getParentSessionId(sid);
        res.status(409).json({
          ok: false,
          error: 'SESSION_ALIVE',
          message: `Session "${title}" hat einen laufenden Prozess. Zum Finishen { "confirm": true } mitsenden.`,
          sessionId: sid,
          name: title,
          isSubSession,
          hint: 'Jede Session einzeln pruefen bevor sie gefinished wird. Nie blind bulk-finishen.',
        });
        return;
      }
    }
  }

  // If this is a sub-session being finished, use cleanupSubSession for proper cleanup
  const isSubSession = !!convMeta.getParentSessionId(sid);
  if (finished && isSubSession) {
    cleanupSubSession(sid);
    invalidateConvCache();
    console.log(`[Finish] Sub-session ${sid.slice(0, 8)} explicitly finished by parent`);
    res.json({ ok: true, sessionId: sid, finished, subSession: true });
    return;
  }

  convMeta.setFinished(sid, finished);
  invalidateConvCache();
  if (finished) {
    // Disable auto-inject — finished sessions must not be respawned
    const wasAutoInjected = disableAutoInject(sid);
    if (wasAutoInjected) console.log(`[Finish] Disabled auto-inject for ${sid.slice(0, 8)}`);
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

// 5e. Start a review session for a conversation
// Extracts user inputs, starts independent review session, auto-injects result when done
router.post('/conversation/:sessionId/review', async (req, res) => {
  const sid = req.params.sessionId;

  // Extract user inputs + last assistant response from original session
  const context = extractConversationContext(sid, 80);
  if (!context) {
    res.status(404).json({ error: 'Cannot read conversation context' });
    return;
  }

  // Also get the last assistant message for "what was implemented"
  let lastAssistantText = '';
  const found = findJsonlPathAllAccounts(sid);
  if (found) {
    const lines = readFileSync(found.path, 'utf8').trim().split('\n').filter(Boolean).reverse();
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'assistant' && obj.message?.content) {
          const parts = Array.isArray(obj.message.content) ? obj.message.content : [];
          const text = parts.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim();
          if (text.length > 50) { lastAssistantText = text.slice(0, 3000); break; }
        }
      } catch { /* skip */ }
    }
  }

  const reviewPrompt = `Du bist ein unabhängiger Code-Reviewer. Analysiere ob die KI-Session die Anforderungen vollständig erfüllt hat.

**GESPRÄCHSVERLAUF (User-Anforderungen & KI-Antworten):**
${context}

${lastAssistantText ? `**LETZTE KI-ANTWORT (Was wurde umgesetzt):**\n${lastAssistantText}\n\n` : ''}Prüfe systematisch:
1. Was hat der User konkret verlangt?
2. Was wurde tatsächlich umgesetzt?
3. Gibt es Lücken, Fehler oder Abweichungen?

Schreibe ein klares Fazit:
- **APPROVED** — Alles korrekt und vollständig umgesetzt
- **NEEDS_REVISION** — Liste der konkreten Punkte die fehlen oder falsch sind

Halte dich präzise. Deine Antwort wird automatisch als Feedback in die Originalkonversation eingefügt.`;

  const accountId = convMeta.getAssignment(sid) || claudeCli.ACCOUNT_CONFIG[0]?.id || 'werking';
  const workDir = convMeta.getWorkDir(sid) || '';
  const model = convMeta.getModel(sid) || '';

  try {
    const result = await claudeCli.startConversation(accountId, reviewPrompt, workDir, undefined, model);
    if (!result.ok) {
      res.status(502).json({ error: result.error || 'Failed to start review session' });
      return;
    }
    const reviewSessionId = result.sessionId;
    convMeta.setReview(reviewSessionId, sid);
    convMeta.saveTitle(reviewSessionId, `Review: ${convMeta.getTitle(sid) || sid.slice(0, 8)}`);
    convMeta.saveAssignment(reviewSessionId, accountId);
    convMeta.saveWorkDir(reviewSessionId, workDir);
    convMeta.saveModel(reviewSessionId, model);
    invalidateConvCache();

    broadcast({ type: 'conv-review-started', sessionId: sid, reviewSessionId });
    console.log(`[Review] Started ${reviewSessionId.slice(0, 8)} for ${sid.slice(0, 8)}`);
    res.json({ ok: true, reviewSessionId });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 5f. Pause conversation (suppresses needs_attention indicator without closing)
router.post('/conversation/:sessionId/pause', (req, res) => {
  const paused = req.body.paused !== false;
  const sid = req.params.sessionId;
  convMeta.setPaused(sid, paused);
  invalidateConvCache();
  broadcast({ type: 'conv-paused', sessionId: sid, paused });
  console.log(`[Pause] ${sid.slice(0, 8)} → ${paused ? 'paused' : 'unpaused'}`);
  res.json({ ok: true, sessionId: sid, paused });
});

// 5f. Model change — takes effect on next resume
router.post('/model/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { model } = req.body;
    const VALID_MODELS = ['opus', 'sonnet', 'haiku'];
    // Partners (non-admin) are restricted to sonnet — opus is reserved for admin/dev-server
    const userRole = (req as any).user?.role;
    const isAdmin = !isAuthEnabled() || userRole === 'admin';
    const allowedModels = isAdmin ? VALID_MODELS : ['sonnet', 'haiku'];
    if (!model || !allowedModels.includes(model)) {
      res.status(400).json({ error: `Invalid model. Valid: ${allowedModels.join(', ')}` });
      return;
    }
    const previousModel = convMeta.getModel(sessionId) || (isAdmin ? 'opus' : 'sonnet');
    convMeta.saveModel(sessionId, model);
    broadcast({ type: 'conv-model-changed', sessionId, model, previousModel });
    console.log(`[Model] ${sessionId.slice(0, 8)}: ${previousModel} -> ${model}`);
    res.json({ ok: true, sessionId, model, previousModel, note: 'Takes effect on next resume' });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[Server] POST /api/mission/model error:', msg);
    res.status(500).json({ error: 'Internal error' });
  }
});

// 5e-hard. Hard-kill: nuclear kill of ALL processes for a session (zombie wrappers, orphans, everything)
router.post('/conversation/:sessionId/hard-kill', async (req, res) => {
  try {
    const sid = req.params.sessionId;
    // Validate UUID format — prevents shell injection via ps aux | grep
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sid)) {
      res.status(400).json({ error: 'Invalid sessionId format' });
      return;
    }
    console.log(`[HardKill] Requested for ${sid.slice(0, 8)}`);

    // 1. Hard-kill all processes
    const result = await claudeCli.hardKillSession(sid);

    // 2. Mark as finished + disable auto-inject
    convMeta.setFinished(sid, true);
    const wasAutoInjected = disableAutoInject(sid);
    if (wasAutoInjected) console.log(`[HardKill] Disabled auto-inject for ${sid.slice(0, 8)}`);

    // 3. Broadcast to UI
    invalidateConvCache();
    broadcast({ type: 'control:conversation-finished', sessionId: sid, panelsToClose: [] });

    console.log(`[HardKill] Done: ${sid.slice(0, 8)} — ${result.killed} processes killed`);
    res.json({ ok: true, sessionId: sid, ...result });
  } catch (err: any) {
    console.error('[HardKill] Error:', err);
    res.status(500).json({ error: 'Hard-kill failed', detail: err?.message });
  }
});

// 5f. Delete conversation permanently (removes .jsonl from disk)
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
    : join(PATHS.claudeUserHome, '.claude', 'team-context.md');
  const teamCtx = existsSync(teamCtxFile) ? readFileSync(teamCtxFile, 'utf8').trim() : '';

  const activeWorkFile = IS_LOCAL_MODE
    ? join(homedir(), '.claude', 'active-work.md')
    : join(PATHS.claudeUserHome, '.claude', 'active-work.md');
  const hasActivePeers = existsSync(activeWorkFile)
    && readFileSync(activeWorkFile, 'utf8').includes('AKTIV');

  const isMissionWorkspace = workDir.includes('administration') || workDir.includes('orchestrator');
  const parts = [
    `[KONTEXT: Projekt="${project}", Leader: ${PROJECT_LEADERS[project]?.join(', ')}]`,
    hasActivePeers ? '[PEERS: Andere Sessions aktiv — cat ~/.claude/active-work.md]' : '',
    teamCtx ? `[TEAM]\n${teamCtx}` : '',
    isMissionWorkspace ? `[MODEL-CONTROL: Du bist Mission Chat (Opus). Andere Sessions laufen default Sonnet.
Zum Modell-Wechsel einer Session: curl -s -X POST http://localhost:4005/api/mission/model/SESSION_ID -H 'Content-Type: application/json' -d '{"model":"opus"}'
Zum Zurueckschalten: curl -s -X POST http://localhost:4005/api/mission/model/SESSION_ID -H 'Content-Type: application/json' -d '{"model":"sonnet"}'
Gueltige Modelle: opus, sonnet. Nur auf Opus eskalieren wenn Sonnet nicht ausreicht (komplexe Architektur, Multi-File-Refactoring, Security-Audit).]` : '',
  ].filter(Boolean);

  return parts.length > 0 ? parts.join('\n') : null;
}

router.post('/start', async (req, res) => {
  try {
  let { accountId, workDir, subject, message, model, parentSessionId } = req.body;
  const VALID_MODELS = ['opus', 'sonnet', 'haiku'];
  // Partners (non-admin) are restricted to sonnet — opus is reserved for admin/dev-server
  // Dev-server has no auth (isAuthEnabled() = false) — treat as admin so opus remains default
  const userRole = (req as any).user?.role;
  const isAdmin = !isAuthEnabled() || userRole === 'admin';
  const partnerModels = ['sonnet', 'haiku'];
  const allowedModels = isAdmin ? VALID_MODELS : partnerModels;
  const defaultModel = isAdmin ? 'opus' : 'sonnet';
  const resolvedModel = (model && allowedModels.includes(model)) ? model : defaultModel;
  if (!message) {
    res.status(400).json({ error: 'message required' });
    return;
  }

  // Auto account selection: pick least-loaded account
  if (!accountId || accountId === 'auto') {
    try {
      const bestResp = await fetch(`http://localhost:${process.env.PORT || 4005}/api/claude-code/best-account`, { signal: AbortSignal.timeout(3000) });
      if (bestResp.ok) {
        const bestData = await bestResp.json() as any;
        const bestAccount = bestData.accounts?.find((a: any) => a.accountId === bestData.bestAccount);
        accountId = bestData.bestAccount || 'werking';
        const weeklyPct = bestAccount?.weeklyPercent ?? '?';
        console.log(`[Start] Auto-selected account: ${accountId} (weekly: ${weeklyPct}%, status: ${bestAccount?.status ?? 'unknown'})`);
        // Warn if all accounts are critical — session may fail with rate limit
        const anyAvailable = bestData.accounts?.some((a: any) => a.available);
        if (!anyAvailable) {
          console.warn(`[Start] WARNING: All accounts are critical/depleted! Best pick: ${accountId} at ${weeklyPct}%. Session may fail.`);
        }
      } else {
        accountId = 'werking'; // fallback
      }
    } catch {
      accountId = 'werking'; // fallback on error
    }
  }

  if (!claudeCli.getAccountConfig(accountId)) {
    res.status(400).json({ error: 'unknown account' }); return;
  }

  // No default to /root/projekte — sessions must declare a registered workspace
  const defaultWorkDir = IS_LOCAL_MODE ? '/Users/rafael/Documents/GitHub' : null;
  const resolvedWorkDir = (isValidWorkDir(workDir) ? workDir : null) || defaultWorkDir;

  // Workspace-gate: require a registered workDir on remote (no fallback to root)
  if (!IS_LOCAL_MODE && (!resolvedWorkDir || !isRegisteredWorkspace(resolvedWorkDir))) {
    const registered = getRegisteredWorkspaces();
    console.warn(`[Start] REJECTED: workDir "${workDir || ''}" is not a registered workspace.`);
    res.status(400).json({
      error: `workDir "${workDir || ''}" is required and must be a registered workspace.`,
      registeredWorkspaces: registered,
    });
    return;
  }

  // Sub-session gate: a sub-session MUST have a valid parentSessionId before it can be spawned.
  // This guarantees the finish-contract: the parent is responsible for reviewing and finishing
  // the sub-session. Spawning a sub-session without a parent breaks the completion flow and
  // leaves the sub-session zombie-forever in reminder loops.
  const SUB_PREFIXES_GATE = ['[Sub]', '[Arch-Fix]', '[Arch-App]', '[Arch-Cross]', '[Fix]', '[Analysis]'];
  const hasExplicitParent_gate = typeof parentSessionId === 'string' && parentSessionId.trim().length > 0;
  const looksLikeSubSession = hasExplicitParent_gate || (subject && SUB_PREFIXES_GATE.some(p => subject.startsWith(p)));
  if (looksLikeSubSession) {
    if (!hasExplicitParent_gate) {
      console.warn(`[SubSession] REJECTED: subject "${subject?.slice(0, 80)}" looks like a sub-session but parentSessionId missing.`);
      res.status(400).json({
        error: 'parentSessionId is required for sub-sessions',
        reason: 'A sub-session must have an explicit parentSessionId so the parent is responsible for reviewing and finishing it. Include "parentSessionId" in the request body.',
        hint: 'The parentSessionId is the UUID of the session that is spawning this sub-session.',
      });
      return;
    }
    // Validate that the parent actually exists (has metadata and is a known session)
    const parentWorkDir = convMeta.getWorkDir(parentSessionId.trim());
    const parentTitle = convMeta.getTitle(parentSessionId.trim());
    if (!parentWorkDir && !parentTitle) {
      console.warn(`[SubSession] REJECTED: parentSessionId ${parentSessionId.slice(0, 8)} does not exist (no metadata).`);
      res.status(400).json({
        error: 'parentSessionId does not refer to a known session',
        parentSessionId,
      });
      return;
    }
    // Parent MUST not already be finished/closed — we cannot inject results into a dead parent
    if (convMeta.isFinished(parentSessionId.trim())) {
      console.warn(`[SubSession] REJECTED: parentSessionId ${parentSessionId.slice(0, 8)} is already finished.`);
      res.status(400).json({
        error: 'parent session is already finished — cannot spawn sub-session under a finished parent',
        parentSessionId,
      });
      return;
    }
  }

  // Enrich first message with team context (only for admin — partners get user identity instead)
  let enrichedMessage = message;
  if (isAdmin) {
    const ctx = buildSessionContext(resolvedWorkDir);
    enrichedMessage = ctx ? `${ctx}\n\n---\n\n${message}` : message;
  } else {
    // Inject partner identity so Claude knows who it's talking to
    const userName = (req as any).user?.name;
    if (userName) {
      enrichedMessage = `[Partner: ${userName}]\n\n${message}`;
    }
  }

  const result = await claudeCli.startConversation(accountId, enrichedMessage, resolvedWorkDir, undefined, resolvedModel);
  if (!result.ok) {
    logUserInput({ type: 'start', accountId, workDir, subject, message, result: 'error', error: result.error });
    res.status(502).json({ error: result.error || 'CLI spawn failed' });
    return;
  }
  const sessionId = result.sessionId;

  logUserInput({ type: 'start', accountId, workDir, subject, message, sessionId, result: 'ok' });
  logRawUserInput(resolvedWorkDir, sessionId, message);
  if (subject) convMeta.saveTitle(sessionId, subject);
  convMeta.saveAssignment(sessionId, accountId);
  convMeta.saveWorkDir(sessionId, resolvedWorkDir);
  convMeta.saveModel(sessionId, resolvedModel);
  // Save userId for partner isolation (non-admin users only see their own conversations)
  const startUserId = (req as any).user?.sub || (req as any).user?.id;
  if (startUserId) convMeta.saveUser(sessionId, startUserId);
  convMeta.setLastPrompt(sessionId);
  // Mark as sub-session if parentSessionId is explicitly provided OR subject starts with known sub-session prefixes
  const SUB_PREFIXES = ['[Sub]', '[Arch-Fix]', '[Arch-App]', '[Fix]', '[Analysis]'];
  const hasExplicitParent = typeof parentSessionId === 'string' && parentSessionId.trim().length > 0;
  const isSubSession = hasExplicitParent || (subject && SUB_PREFIXES.some(p => subject.startsWith(p)));
  if (isSubSession) {
    convMeta.setSubSession(sessionId, true);

    if (hasExplicitParent) {
      // Explicit parent — link directly, skip auto-detect
      convMeta.setParentSession(sessionId, parentSessionId);
      console.log(`[SubSession] ${sessionId.slice(0, 8)} explicitly linked to parent ${parentSessionId.slice(0, 8)}`);
    } else if (!parentSessionId) {
      // No explicit parent provided — require parentSessionId for sub-sessions
      // Do NOT auto-detect: fallback to "any idle session" causes reminders to go to wrong sessions
      console.warn(`[SubSession] ${sessionId.slice(0, 8)} ("${subject?.slice(0, 50)}") spawned WITHOUT parentSessionId — reminders disabled. Caller MUST provide parentSessionId.`);
    }
  }
  invalidateConvCache();

  // State tracking is handled by claude-cli stdout parsing
  // Broadcast so LayoutManagers can auto-mount immediately
  broadcast({ type: 'control:conversation-started', sessionId, accountId, workDir: resolvedWorkDir });
  res.json({ ok: true, sessionId, model: resolvedModel });
  } catch (err: any) {
    console.warn('[Server] POST /api/mission/start error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// 6b-health. Session health diagnostics — checks all active sessions for problems
router.get('/session-health', async (req, res) => {
  try {
    const data = _convCache.data || await fetchConvList();
    const allConvs: any[] = data.conversations || [];
    const active = allConvs.filter((c: any) => !c.manualFinished);

    const results = active.map((c: any) => {
      const processAlive = claudeCli.isActive(c.sessionId);
      const diagnosis = !processAlive ? diagnoseSessionHealth(c.sessionId) : null;

      return {
        sessionId: c.sessionId,
        customName: c.customName || c.summary?.slice(0, 50) || '',
        projectName: c.projectName,
        accountId: c.accountId,
        isSubSession: !!c.isSubSession,
        processAlive,
        attentionState: c.attentionState,
        attentionReason: c.attentionReason,
        diagnosis: diagnosis ? {
          needsRecovery: diagnosis.needsRecovery,
          reason: diagnosis.reason,
          details: diagnosis.details,
          lastRole: diagnosis.lastRole,
        } : null,
        status: processAlive ? 'running' : (diagnosis?.needsRecovery ? 'needs_recovery' : 'stopped'),
      };
    });

    const needsRecovery = results.filter(r => r.status === 'needs_recovery');
    const running = results.filter(r => r.status === 'running');
    const stopped = results.filter(r => r.status === 'stopped');

    res.json({
      total: results.length,
      running: running.length,
      needsRecovery: needsRecovery.length,
      stopped: stopped.length,
      sessions: results,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 6b-sub. Sub-sessions list — compact overview for SubSessionPanel
router.get('/sub-sessions', async (req, res) => {
  try {
    const filterWorkDir = req.query.workDir as string | undefined;
    // Get all conversations from cache
    const now = Date.now();
    let data = _convCache.data;
    if (!data) {
      data = await fetchConvList();
      _convCache = { data, timestamp: now, refreshing: false };
    }

    const subSessions = convMeta.getAllSubSessions();
    const states = getSessionStates();
    const results: any[] = [];

    for (const conv of (data.conversations || [])) {
      if (!subSessions[conv.sessionId]) continue;
      if (conv.manualFinished) continue;

      // Filter by workDir if specified (match parent's workDir or sub-session's own)
      if (filterWorkDir) {
        const convPath = conv.projectPath || '';
        const parentSid = convMeta.getParentSessionId(conv.sessionId);
        const parentWorkDir = parentSid ? convMeta.getWorkDir(parentSid) : '';
        if (!convPath.includes(filterWorkDir) && !parentWorkDir?.includes(filterWorkDir)) continue;
      }

      // Get attention state
      let attentionState = 'idle';
      let attentionReason = '';
      for (const [_key, state] of Object.entries(states)) {
        if (state.sessionId === conv.sessionId) {
          attentionState = state.state;
          attentionReason = state.reason || '';
        }
      }

      // Get last assistant snippet
      let lastSnippet = '';
      try {
        const found = findJsonlPathAllAccounts(conv.sessionId);
        if (found) {
          const lines = readFileSync(found.path, 'utf8').trim().split('\n').filter(Boolean).reverse();
          for (const line of lines.slice(0, 20)) {
            try {
              const obj = JSON.parse(line);
              if (obj.type === 'assistant' && obj.message?.content) {
                const parts = Array.isArray(obj.message.content) ? obj.message.content : [];
                const text = parts.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim();
                if (text) { lastSnippet = text.slice(0, 200); break; }
              }
            } catch { /* skip */ }
          }
        }
      } catch { /* skip */ }

      const parentSessionId = convMeta.getParentSessionId(conv.sessionId);
      const parentSubject = parentSessionId ? convMeta.getTitle(parentSessionId) : undefined;

      results.push({
        sessionId: conv.sessionId,
        subject: conv.subject || convMeta.getTitle(conv.sessionId) || conv.sessionId.slice(0, 8),
        parentSessionId,
        parentSubject,
        accountId: conv.accountId || 'werking',
        workDir: conv.projectPath || '',
        attentionState,
        attentionReason,
        lastSnippet,
        updatedAt: conv.updatedAt || conv.ctime,
      });
    }

    res.json({ sessions: results, total: results.length });
  } catch (err) {
    console.warn('[SubSessions] API error:', (err as Error).message);
    res.status(500).json({ error: 'Failed to fetch sub-sessions' });
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
        'X-Privacy-Mode': 'none',
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
          accountId: action.accountId || 'engelmann',
          workDir: action.workDir,
          subject: action.subject || '',
          message: action.message,
          model: action.model || 'opus',
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

// Force all browsers to reset their layouts from server templates
router.post('/force-layout-reset', (_req, res) => {
  broadcast({ type: 'control:layout-reset' });
  res.json({ ok: true, message: 'Layout reset broadcast sent to all panels' });
});

// Nuclear: clear ALL browser layout caches and force reload
router.post('/nuke-layouts', (_req, res) => {
  broadcast({ type: 'control:nuke-layout-cache' });
  res.json({ ok: true, message: 'Nuke broadcast sent — browsers will clear cache and reload' });
});

export default router;
