/**
 * Sub-session wait-state detection + auto-recovery decision logic.
 *
 * Pure functions that take pre-collected inputs (children info, JSONL entries,
 * tester logs) so they can be unit-tested without filesystem or process state.
 *
 * Background (2026-05-09 incident): the reminder system mistakenly told the
 * Master that subs in a legitimate wait-state were "READY TO FINISH". Master
 * then auto-finished them — three Drives died from incorrect classification.
 * detectWaitState gates the 'ready' verdict against three wait-states:
 *   1. sub-children — the sub itself spawned grandchildren that are still working
 *   2. wakeup-pending — sub called ScheduleWakeup; SDK exited but wakeup is in the future
 *   3. bg-test — sub kicked off a unified-tester run that's still writing logs
 *
 * shouldAutoRecover decides whether a session stuck on rate_limit / overloaded
 * may be respawned. Crash / incomplete_tool_use / api_error are NOT auto-recovered
 * — those are either too risky (state corruption) or already handled by silent-exit
 * auto-continue elsewhere in mission.ts.
 */

export type WaitStateReason = 'sub-children' | 'wakeup-pending' | 'bg-test';

export interface ChildInfo {
  sessionId: string;
  finished: boolean;
  cliActive: boolean;
  jsonlMtimeMs: number | null;
}

export interface JsonlEntry {
  type?: string;
  timestamp?: string;
  message?: { content?: unknown; role?: string };
}

export interface TesterLog {
  filename: string;
  mtimeMs: number;
}

export interface WaitStateInputs {
  subChildren: ChildInfo[];
  jsonlEntries: JsonlEntry[]; // chronological — oldest first
  testerLogs: TesterLog[];
  now: number;
}

export interface WaitStateResult {
  reason: WaitStateReason;
  signals: string[];
}

const CHILD_RECENT_ACTIVITY_MS = 5 * 60_000;
const TESTER_LOG_FRESH_MS = 5 * 60_000;
const SCAN_BACK_TURNS = 40;

function extractContentParts(entry: JsonlEntry): unknown[] {
  const c = entry.message?.content;
  return Array.isArray(c) ? c : [];
}

function findScenarioInBashCmd(cmd: string): string | null {
  if (!/run-in-container\.sh|run_autonomous\.py/.test(cmd)) return null;
  // Patterns: `run-in-container.sh {APP} {APP}.{SCENARIO}`
  //           `python3 run_autonomous.py --app {APP} --scenario {APP}.{SCENARIO}`
  const m = cmd.match(/(?:run-in-container\.sh\s+\S+\s+|--scenario(?:[\s=]+))([a-z][a-z0-9-]+\.[a-z][a-z0-9_-]+)/);
  return m ? m[1] : null;
}

export function detectWaitState(inputs: WaitStateInputs): WaitStateResult | null {
  const { subChildren, jsonlEntries, testerLogs, now } = inputs;

  // 1. Sub-Children: any non-finished child that's still active or recently active
  for (const child of subChildren) {
    if (child.finished) continue;
    if (child.cliActive) {
      return { reason: 'sub-children', signals: [`child ${child.sessionId.slice(0, 8)} active`] };
    }
    if (child.jsonlMtimeMs !== null && now - child.jsonlMtimeMs < CHILD_RECENT_ACTIVITY_MS) {
      const ageS = Math.round((now - child.jsonlMtimeMs) / 1000);
      return { reason: 'sub-children', signals: [`child ${child.sessionId.slice(0, 8)} mtime ${ageS}s`] };
    }
  }

  // 2. ScheduleWakeup pending — most recent ScheduleWakeup tool_use whose
  //    delaySeconds has not yet elapsed.
  const start2 = Math.max(0, jsonlEntries.length - SCAN_BACK_TURNS);
  for (let i = jsonlEntries.length - 1; i >= start2; i--) {
    const obj = jsonlEntries[i];
    if (obj?.type !== 'assistant') continue;
    const parts = extractContentParts(obj);
    let wakeup: { input?: { delaySeconds?: unknown } } | null = null;
    for (const b of parts) {
      const block = b as { type?: string; name?: string; input?: { delaySeconds?: unknown } };
      if (block?.type === 'tool_use' && block?.name === 'ScheduleWakeup') {
        wakeup = block;
        break;
      }
    }
    if (!wakeup) continue;
    const delaySec = Number(wakeup.input?.delaySeconds) || 0;
    const ts = obj.timestamp ? Date.parse(obj.timestamp) : 0;
    if (ts && delaySec) {
      const wakeupAt = ts + delaySec * 1000;
      if (wakeupAt > now) {
        const remainingMin = Math.max(1, Math.round((wakeupAt - now) / 60_000));
        return { reason: 'wakeup-pending', signals: [`ScheduleWakeup ${remainingMin}min remaining`] };
      }
    }
    break; // first ScheduleWakeup found — only check the most recent
  }

  // 3. BG-Test: tester run log recently written for a scenario this sub kicked off.
  let testScenario: string | null = null;
  const start3 = Math.max(0, jsonlEntries.length - SCAN_BACK_TURNS);
  for (let i = jsonlEntries.length - 1; i >= start3; i--) {
    const obj = jsonlEntries[i];
    if (obj?.type !== 'assistant') continue;
    const parts = extractContentParts(obj);
    for (const b of parts) {
      const block = b as { type?: string; name?: string; input?: { command?: unknown } };
      if (block?.type !== 'tool_use' || block?.name !== 'Bash') continue;
      const cmd = String(block.input?.command || '');
      const scenario = findScenarioInBashCmd(cmd);
      if (scenario) { testScenario = scenario; break; }
    }
    if (testScenario) break;
  }
  if (testScenario) {
    for (const log of testerLogs) {
      if (!log.filename.includes(testScenario)) continue;
      if (now - log.mtimeMs < TESTER_LOG_FRESH_MS) {
        const ageS = Math.round((now - log.mtimeMs) / 1000);
        return { reason: 'bg-test', signals: [`tester ${testScenario} (${ageS}s)`] };
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Auto-recovery decision
// ---------------------------------------------------------------------------

export type DiagnosisReason =
  | 'incomplete_tool_use'
  | 'api_error'
  | 'overloaded'
  | 'rate_limit'
  | 'crash'
  | 'completed'
  | 'unknown';

export interface AutoRecoveryInputs {
  reason: DiagnosisReason;
  attempts: number;
  lastAttemptMs: number;
  now: number;
  accountAvailable?: boolean;
  maxAttempts?: number;
}

export interface AutoRecoveryDecision {
  recover: boolean;
  skipReason?: string;
}

export const OVERLOAD_BACKOFF_MS = [
  5 * 60_000,
  15 * 60_000,
  30 * 60_000,
  60 * 60_000,
  120 * 60_000,
];
export const DEFAULT_MAX_AUTO_RECOVERY_ATTEMPTS = 5;

export function shouldAutoRecover(inputs: AutoRecoveryInputs): AutoRecoveryDecision {
  const {
    reason,
    attempts,
    lastAttemptMs,
    now,
    accountAvailable,
    maxAttempts = DEFAULT_MAX_AUTO_RECOVERY_ATTEMPTS,
  } = inputs;

  if (reason === 'crash' || reason === 'incomplete_tool_use' || reason === 'api_error') {
    return { recover: false, skipReason: `not-recoverable: ${reason}` };
  }
  if (reason === 'completed' || reason === 'unknown') {
    return { recover: false, skipReason: `nothing-to-recover: ${reason}` };
  }

  if (attempts >= maxAttempts) {
    return { recover: false, skipReason: 'max-attempts-reached' };
  }

  if (reason === 'overloaded') {
    const idx = Math.min(attempts, OVERLOAD_BACKOFF_MS.length - 1);
    const backoff = OVERLOAD_BACKOFF_MS[idx];
    if (now - lastAttemptMs < backoff) {
      const remainMin = Math.max(1, Math.round((backoff - (now - lastAttemptMs)) / 60_000));
      return { recover: false, skipReason: `overload-backoff: ${remainMin}min remaining` };
    }
  }

  if (reason === 'rate_limit') {
    if (!accountAvailable) {
      return { recover: false, skipReason: 'account-still-rate-limited' };
    }
  }

  return { recover: true };
}
