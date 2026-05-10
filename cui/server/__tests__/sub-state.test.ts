/**
 * Tests for sub-state wait-state detection + auto-recovery decision.
 *
 * Run: npx tsx --test server/__tests__/sub-state.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectWaitState,
  detectOverdueWakeup,
  shouldAutoRecover,
  OVERLOAD_BACKOFF_MS,
  DEFAULT_MAX_AUTO_RECOVERY_ATTEMPTS,
  WAKEUP_OVERDUE_MAX_PER_DAY,
  WAKEUP_OVERDUE_WINDOW_MS,
  type WaitStateInputs,
  type ChildInfo,
  type JsonlEntry,
  type TesterLog,
} from '../routes/shared/sub-state.js';

const NOW = 1_700_000_000_000; // arbitrary epoch ms

function baseInputs(overrides: Partial<WaitStateInputs> = {}): WaitStateInputs {
  return {
    subChildren: [],
    jsonlEntries: [],
    testerLogs: [],
    now: NOW,
    ...overrides,
  };
}

function child(overrides: Partial<ChildInfo> = {}): ChildInfo {
  return {
    sessionId: '00000000-0000-0000-0000-000000000001',
    finished: false,
    cliActive: false,
    jsonlMtimeMs: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// detectWaitState — sub-children
// ---------------------------------------------------------------------------

test('detectWaitState: returns sub-children when child CLI process is active', () => {
  const result = detectWaitState(baseInputs({
    subChildren: [child({ cliActive: true })],
  }));
  assert.ok(result, 'expected wait-state');
  assert.equal(result.reason, 'sub-children');
  assert.match(result.signals[0], /child 00000000 active/);
});

test('detectWaitState: returns sub-children when child JSONL was written < 5min ago', () => {
  const result = detectWaitState(baseInputs({
    subChildren: [child({ jsonlMtimeMs: NOW - 60_000 })],
  }));
  assert.ok(result);
  assert.equal(result.reason, 'sub-children');
  assert.match(result.signals[0], /mtime/);
});

test('detectWaitState: ignores child whose JSONL is older than 5min', () => {
  const result = detectWaitState(baseInputs({
    subChildren: [child({ jsonlMtimeMs: NOW - 600_000 })],
  }));
  assert.equal(result, null);
});

test('detectWaitState: ignores finished children', () => {
  const result = detectWaitState(baseInputs({
    subChildren: [child({ finished: true, cliActive: true })],
  }));
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// detectWaitState — ScheduleWakeup
// ---------------------------------------------------------------------------

function wakeupTurn(opts: { delaySeconds: number; ageMs: number }): JsonlEntry {
  return {
    type: 'assistant',
    timestamp: new Date(NOW - opts.ageMs).toISOString(),
    message: {
      content: [
        { type: 'text', text: 'Scheduling wakeup' },
        { type: 'tool_use', name: 'ScheduleWakeup', input: { delaySeconds: opts.delaySeconds } },
      ],
    },
  };
}

test('detectWaitState: ScheduleWakeup with future wakeup → wakeup-pending', () => {
  // delaySeconds=600, age 60s → wakeup fires at NOW + 540s
  const result = detectWaitState(baseInputs({
    jsonlEntries: [wakeupTurn({ delaySeconds: 600, ageMs: 60_000 })],
  }));
  assert.ok(result);
  assert.equal(result.reason, 'wakeup-pending');
  assert.match(result.signals[0], /9min remaining|10min remaining/);
});

test('detectWaitState: ScheduleWakeup that already elapsed → not wait-state', () => {
  // delaySeconds=60, age 600s → wakeup_at is in the past
  const result = detectWaitState(baseInputs({
    jsonlEntries: [wakeupTurn({ delaySeconds: 60, ageMs: 600_000 })],
  }));
  assert.equal(result, null);
});

test('detectWaitState: ScheduleWakeup checks only the most recent occurrence', () => {
  // Older wakeup with future fire-time — should NOT match because we stop at the
  // most recent ScheduleWakeup (which has already fired).
  const result = detectWaitState(baseInputs({
    jsonlEntries: [
      wakeupTurn({ delaySeconds: 100_000, ageMs: 1_000 }), // older entry
      wakeupTurn({ delaySeconds: 60, ageMs: 600_000 }),    // most recent — already elapsed
    ],
  }));
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// detectWaitState — BG-Test
// ---------------------------------------------------------------------------

function bashTurn(cmd: string): JsonlEntry {
  return {
    type: 'assistant',
    timestamp: new Date(NOW - 30_000).toISOString(),
    message: {
      content: [{ type: 'tool_use', name: 'Bash', input: { command: cmd } }],
    },
  };
}

test('detectWaitState: tester run-in-container.sh + recent log → bg-test', () => {
  const result = detectWaitState(baseInputs({
    jsonlEntries: [bashTurn('./scripts/run-in-container.sh acro-community acro-community.ui-session-create')],
    testerLogs: [
      { filename: '20260510-080000-acro-community-acro-community.ui-session-create.log', mtimeMs: NOW - 30_000 },
    ],
  }));
  assert.ok(result);
  assert.equal(result.reason, 'bg-test');
  assert.match(result.signals[0], /tester acro-community\.ui-session-create/);
});

test('detectWaitState: tester run_autonomous.py with --scenario flag → bg-test', () => {
  const result = detectWaitState(baseInputs({
    jsonlEntries: [bashTurn('python3 run_autonomous.py --app engelmann --scenario engelmann.auth-api')],
    testerLogs: [
      { filename: '20260510-080000-engelmann-engelmann.auth-api.log', mtimeMs: NOW - 60_000 },
    ],
  }));
  assert.ok(result);
  assert.equal(result.reason, 'bg-test');
  assert.match(result.signals[0], /engelmann\.auth-api/);
});

test('detectWaitState: tester command but log is stale (>5min) → not wait-state', () => {
  const result = detectWaitState(baseInputs({
    jsonlEntries: [bashTurn('./scripts/run-in-container.sh acro-community acro-community.ui-session-create')],
    testerLogs: [
      { filename: '20260510-070000-acro-community-acro-community.ui-session-create.log', mtimeMs: NOW - 600_000 },
    ],
  }));
  assert.equal(result, null);
});

test('detectWaitState: empty inputs → null', () => {
  assert.equal(detectWaitState(baseInputs()), null);
});

test('detectWaitState: child wins over wakeup (priority order)', () => {
  const result = detectWaitState(baseInputs({
    subChildren: [child({ cliActive: true })],
    jsonlEntries: [wakeupTurn({ delaySeconds: 600, ageMs: 60_000 })],
  }));
  assert.equal(result?.reason, 'sub-children');
});

// ---------------------------------------------------------------------------
// shouldAutoRecover
// ---------------------------------------------------------------------------

test('shouldAutoRecover: rate_limit + account available → recover', () => {
  const d = shouldAutoRecover({
    reason: 'rate_limit',
    attempts: 0,
    lastAttemptMs: 0,
    now: NOW,
    accountAvailable: true,
  });
  assert.equal(d.recover, true);
});

test('shouldAutoRecover: rate_limit + account NOT available → skip', () => {
  const d = shouldAutoRecover({
    reason: 'rate_limit',
    attempts: 0,
    lastAttemptMs: 0,
    now: NOW,
    accountAvailable: false,
  });
  assert.equal(d.recover, false);
  assert.match(d.skipReason || '', /rate-limited/);
});

test('shouldAutoRecover: overloaded with no prior attempt → recover', () => {
  const d = shouldAutoRecover({
    reason: 'overloaded',
    attempts: 0,
    lastAttemptMs: 0,
    now: NOW,
  });
  assert.equal(d.recover, true);
});

test('shouldAutoRecover: overloaded inside backoff window → skip', () => {
  const d = shouldAutoRecover({
    reason: 'overloaded',
    attempts: 1,
    lastAttemptMs: NOW - 60_000, // 1min ago, backoff slot 1 = 15min
    now: NOW,
  });
  assert.equal(d.recover, false);
  assert.match(d.skipReason || '', /backoff/);
});

test('shouldAutoRecover: overloaded after backoff expires → recover', () => {
  const d = shouldAutoRecover({
    reason: 'overloaded',
    attempts: 1,
    lastAttemptMs: NOW - (OVERLOAD_BACKOFF_MS[1] + 1000),
    now: NOW,
  });
  assert.equal(d.recover, true);
});

test('shouldAutoRecover: max attempts reached → skip', () => {
  const d = shouldAutoRecover({
    reason: 'rate_limit',
    attempts: DEFAULT_MAX_AUTO_RECOVERY_ATTEMPTS,
    lastAttemptMs: 0,
    now: NOW,
    accountAvailable: true,
  });
  assert.equal(d.recover, false);
  assert.match(d.skipReason || '', /max-attempts/);
});

test('shouldAutoRecover: crash → skip (too risky)', () => {
  const d = shouldAutoRecover({
    reason: 'crash',
    attempts: 0,
    lastAttemptMs: 0,
    now: NOW,
  });
  assert.equal(d.recover, false);
  assert.match(d.skipReason || '', /not-recoverable/);
});

test('shouldAutoRecover: incomplete_tool_use → skip (handled by silent-exit auto-continue)', () => {
  const d = shouldAutoRecover({
    reason: 'incomplete_tool_use',
    attempts: 0,
    lastAttemptMs: 0,
    now: NOW,
  });
  assert.equal(d.recover, false);
});

test('shouldAutoRecover: api_error → skip', () => {
  const d = shouldAutoRecover({
    reason: 'api_error',
    attempts: 0,
    lastAttemptMs: 0,
    now: NOW,
  });
  assert.equal(d.recover, false);
});

test('shouldAutoRecover: completed → skip (nothing to recover)', () => {
  const d = shouldAutoRecover({
    reason: 'completed',
    attempts: 0,
    lastAttemptMs: 0,
    now: NOW,
  });
  assert.equal(d.recover, false);
});

// ---------------------------------------------------------------------------
// detectOverdueWakeup — the 3 mandatory cases (future / overdue+alive / overdue+dead)
// ---------------------------------------------------------------------------

test('detectOverdueWakeup: future wakeup (wakeupAt > now) → null (no recovery)', () => {
  // delaySeconds=600, age 60s → wakeup fires at NOW + 540s
  const result = detectOverdueWakeup({
    jsonlEntries: [wakeupTurn({ delaySeconds: 600, ageMs: 60_000 })],
    processAlive: false,
    now: NOW,
  });
  assert.equal(result, null);
});

test('detectOverdueWakeup: overdue + processAlive=true → null (no-op)', () => {
  // delaySeconds=60, age 600s → wakeup fired 540s ago, but process still alive
  const result = detectOverdueWakeup({
    jsonlEntries: [wakeupTurn({ delaySeconds: 60, ageMs: 600_000 })],
    processAlive: true,
    now: NOW,
  });
  assert.equal(result, null);
});

test('detectOverdueWakeup: overdue + processAlive=false → recover', () => {
  // delaySeconds=300, age 37min → wakeup fired ~32min ago, process dead → overdue
  const result = detectOverdueWakeup({
    jsonlEntries: [wakeupTurn({ delaySeconds: 300, ageMs: 37 * 60_000 })],
    processAlive: false,
    now: NOW,
  });
  assert.ok(result, 'expected overdue result');
  assert.equal(result.overdue, true);
  assert.match(result.signals[0], /overdue.*processDead/);
  // overdueByMs ≈ 37min - 5min = 32min
  assert.ok(result.overdueByMs > 30 * 60_000 && result.overdueByMs < 35 * 60_000);
});

// ---------------------------------------------------------------------------
// shouldAutoRecover — wakeup-overdue branch (3/24h cap)
// ---------------------------------------------------------------------------

test('shouldAutoRecover: wakeup-overdue, attempts=0 → recover', () => {
  const d = shouldAutoRecover({
    reason: 'wakeup-overdue',
    attempts: 0,
    lastAttemptMs: 0,
    now: NOW,
  });
  assert.equal(d.recover, true);
});

test('shouldAutoRecover: wakeup-overdue, 3 attempts within 24h → skip (cap)', () => {
  const d = shouldAutoRecover({
    reason: 'wakeup-overdue',
    attempts: WAKEUP_OVERDUE_MAX_PER_DAY,
    lastAttemptMs: NOW - 60_000, // 1min ago, well within window
    now: NOW,
  });
  assert.equal(d.recover, false);
  assert.match(d.skipReason || '', /wakeup-overdue-cap/);
});

test('shouldAutoRecover: wakeup-overdue, 3 attempts but window expired → recover', () => {
  // Last attempt > 24h ago → window-reset semantic
  const d = shouldAutoRecover({
    reason: 'wakeup-overdue',
    attempts: WAKEUP_OVERDUE_MAX_PER_DAY + 5,
    lastAttemptMs: NOW - (WAKEUP_OVERDUE_WINDOW_MS + 60_000),
    now: NOW,
  });
  assert.equal(d.recover, true);
});
