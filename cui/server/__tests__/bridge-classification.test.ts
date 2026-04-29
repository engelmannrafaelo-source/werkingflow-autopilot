/**
 * Bridge classification tests — Rafael-Prinzip 2026-04-29:
 * "Wenn jemand auf die Autobahn nicht auffahren kann, ist es ein Ausfall."
 *
 * Run: npx tsx --test server/__tests__/bridge-classification.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCaller, summarizePool, countUpstreamErrors, deriveWorkerStatus, buildWorkerHealth } from '../routes/bridge.js';

function entry(partial: Partial<any>): any {
  return {
    ts_epoch: 1745000000,
    uri: '/v1/messages',
    method: 'POST',
    status: 200,
    bytes: 0,
    req_time: 0.5,
    upstream_addr: 'worker1',
    upstream_status: '200',
    upstream_resp_time: '0.5',
    upstream_conn_time: '0.0',
    pool: 'default',
    priority: 'normal',
    user_agent: '',
    app_id: '',
    user_id: '',
    workflow_id: '',
    job_id: '',
    agent_id: '',
    _source: 'dev',
    ...partial,
  };
}

test('classifyCaller: production_user app_id', () => {
  assert.equal(classifyCaller(entry({ app_id: 'engelmann' })), 'production_user');
  assert.equal(classifyCaller(entry({ app_id: 'werking-energy' })), 'production_user');
  assert.equal(classifyCaller(entry({ app_id: 'WERKING-REPORT' })), 'production_user');
});

test('classifyCaller: workflow caller', () => {
  assert.equal(classifyCaller(entry({ app_id: 'workflow-engine' })), 'workflow');
  assert.equal(classifyCaller(entry({ app_id: 'bridge-research' })), 'workflow');
});

test('classifyCaller: test (unified-tester)', () => {
  assert.equal(classifyCaller(entry({ app_id: 'unified-tester' })), 'test');
  assert.equal(classifyCaller(entry({ user_agent: 'unified-tester/1.0' })), 'test');
});

test('classifyCaller: monitoring only for synthetic probes', () => {
  assert.equal(classifyCaller(entry({ uri: '/health', app_id: '' })), 'monitoring');
  assert.equal(classifyCaller(entry({ uri: '/lb-status', app_id: '' })), 'monitoring');
  assert.equal(classifyCaller(entry({ uri: '/v1/metrics/account-pool-state', app_id: '' })), 'monitoring');
});

test('classifyCaller: empty app_id on real workload is platform, NOT monitoring', () => {
  // Was the bug: anything without app_id got bucketed as 'monitoring' and
  // hidden from the banner. Real calls without headers must still count.
  assert.equal(classifyCaller(entry({ app_id: '', uri: '/v1/messages' })), 'platform');
});

test('classifyCaller: cui platform calls', () => {
  assert.equal(classifyCaller(entry({ app_id: 'cui' })), 'platform');
  assert.equal(classifyCaller(entry({ user_agent: 'cui/web' })), 'platform');
});

test('summarizePool: total lost counts every caller_kind', () => {
  const entries = [
    entry({ status: 500, app_id: 'engelmann' }),
    entry({ status: 502, app_id: 'unified-tester' }),
    entry({ status: 503, app_id: '', uri: '/v1/messages' }),
    entry({ status: 200, app_id: 'engelmann' }),
  ];
  const s = summarizePool(entries);
  // Rafael-Prinzip: alle 5xx zählen
  assert.equal(s.lost, 3, 'total lost = sum of all 5xx, regardless of caller');
  assert.equal(s.lost_by_caller.production_user, 1);
  assert.equal(s.lost_by_caller.test, 1);
  assert.equal(s.lost_by_caller.platform, 1);
  assert.equal(s.lost_by_caller.monitoring, 0);
  // Sum of caller drilldown == total
  const sum = Object.values(s.lost_by_caller).reduce((a, b) => a + b, 0);
  assert.equal(sum, s.lost, 'lost_by_caller must sum to lost');
});

test('summarizePool: rescued via failover does not count as lost', () => {
  const rescued = entry({
    status: 200,
    upstream_addr: 'worker1, worker2',
    upstream_status: '500, 200',
  });
  const s = summarizePool([rescued]);
  assert.equal(s.lost, 0);
  assert.equal(s.rescued, 1);
});

test('summarizePool: legacy lost_user reflects user+workflow+platform', () => {
  const entries = [
    entry({ status: 500, app_id: 'engelmann' }),       // user
    entry({ status: 500, app_id: 'workflow-engine' }), // workflow
    entry({ status: 500, app_id: 'cui' }),             // platform
    entry({ status: 500, app_id: 'unified-tester' }),  // test
    entry({ status: 500, uri: '/health', app_id: '' }), // monitoring
  ];
  const s = summarizePool(entries);
  assert.equal(s.lost, 5);
  assert.equal(s.lost_user, 3, 'legacy lost_user = production+workflow+platform');
  assert.equal(s.lost_monitoring, 2, 'legacy lost_monitoring = test+monitoring');
});

test('summarizePool: empty entries produce zero counters', () => {
  const s = summarizePool([]);
  assert.equal(s.lost, 0);
  assert.equal(s.present, false);
  assert.equal(s.lost_by_caller.production_user, 0);
});

// ── Worker Health Tests ─────────────────────────────────────────────────────

test('countUpstreamErrors: counts 5xx per worker name', () => {
  const now = 1745000000;
  const entries = [
    entry({ ts_epoch: now - 10, upstream_addr: 'worker1', upstream_status: '502' }),
    entry({ ts_epoch: now - 20, upstream_addr: 'worker1', upstream_status: '503' }),
    entry({ ts_epoch: now - 30, upstream_addr: 'worker2', upstream_status: '500' }),
    entry({ ts_epoch: now - 10, upstream_addr: 'worker1', upstream_status: '200' }),  // not 5xx
  ];
  const errs = countUpstreamErrors(entries, 300, now);
  assert.equal(errs['worker1'], 2, 'worker1: 2 × 5xx');
  assert.equal(errs['worker2'], 1, 'worker2: 1 × 5xx');
  assert.equal(errs['worker3'], undefined, 'worker3: no errors');
});

test('countUpstreamErrors: strips port from upstream_addr', () => {
  const now = 1745000000;
  const entries = [
    entry({ ts_epoch: now - 10, upstream_addr: 'worker3:8000', upstream_status: '502' }),
  ];
  const errs = countUpstreamErrors(entries, 300, now);
  assert.equal(errs['worker3'], 1, 'port stripped correctly');
  assert.equal(errs['worker3:8000'], undefined, 'raw addr not present');
});

test('countUpstreamErrors: ignores entries outside window', () => {
  const now = 1745000000;
  const entries = [
    entry({ ts_epoch: now - 400, upstream_addr: 'worker1', upstream_status: '502' }),  // outside 300s window
    entry({ ts_epoch: now - 100, upstream_addr: 'worker1', upstream_status: '502' }),  // inside
  ];
  const errs = countUpstreamErrors(entries, 300, now);
  assert.equal(errs['worker1'], 1, 'only entry inside window counted');
});

test('countUpstreamErrors: handles multi-upstream retry entries', () => {
  const now = 1745000000;
  // nginx retry: first upstream 502, second 200 → only first counts
  const entries = [
    entry({
      ts_epoch: now - 10,
      upstream_addr: 'worker1, worker2',
      upstream_status: '502, 200',
    }),
  ];
  const errs = countUpstreamErrors(entries, 300, now);
  assert.equal(errs['worker1'], 1, 'worker1 502 counted');
  assert.equal(errs['worker2'], undefined, 'worker2 200 not counted');
});

test('deriveWorkerStatus: down when not in fanout', () => {
  assert.equal(deriveWorkerStatus(false, null, 0), 'down');
  assert.equal(deriveWorkerStatus(false, 50, 0), 'down');
});

test('deriveWorkerStatus: degraded when queue > 85%', () => {
  assert.equal(deriveWorkerStatus(true, 86, 0), 'degraded');
  assert.equal(deriveWorkerStatus(true, 100, 0), 'degraded');
});

test('deriveWorkerStatus: degraded when errors_5min > 5', () => {
  assert.equal(deriveWorkerStatus(true, 30, 6), 'degraded');
});

test('deriveWorkerStatus: healthy when responding and queue below threshold', () => {
  assert.equal(deriveWorkerStatus(true, 50, 0), 'healthy');
  assert.equal(deriveWorkerStatus(true, 85, 5), 'healthy');   // edge: 85% and 5 errors = still healthy
  assert.equal(deriveWorkerStatus(true, null, 0), 'healthy'); // no limiter data = healthy (can't prove degraded)
});

test('buildWorkerHealth: marks missing workers as down', () => {
  // Only worker1 and worker3 responded in fanout
  const limiters = {
    worker1: { inflight_tokens: 10000, cap_tokens: 100000, inflight_count: 2 },
    worker3: { inflight_tokens: 5000, cap_tokens: 100000, inflight_count: 1 },
  };
  const { workers, has_any_down } = buildWorkerHealth(limiters, null, []);
  assert.equal(has_any_down, true, 'worker2 and worker4 are down');
  const w2 = workers.find(w => w.name === 'worker2')!;
  assert.equal(w2.status, 'down');
  const w4 = workers.find(w => w.name === 'worker4')!;
  assert.equal(w4.status, 'down');
});

test('buildWorkerHealth: has_any_degraded when queue high', () => {
  const limiters = {
    worker1: { inflight_tokens: 90000, cap_tokens: 100000, inflight_count: 10 },
    worker2: { inflight_tokens: 5000,  cap_tokens: 100000, inflight_count: 1 },
    worker3: { inflight_tokens: 5000,  cap_tokens: 100000, inflight_count: 1 },
    worker4: { inflight_tokens: 5000,  cap_tokens: 100000, inflight_count: 1 },
  };
  const { workers, has_any_degraded, has_any_down } = buildWorkerHealth(limiters, null, []);
  assert.equal(has_any_down, false, 'all workers responded');
  assert.equal(has_any_degraded, true, 'worker1 at 90% is degraded');
  const w1 = workers.find(w => w.name === 'worker1')!;
  assert.equal(w1.status, 'degraded');
  assert.equal(w1.queue_pct, 90, 'queue_pct correct');
});

test('buildWorkerHealth: all healthy returns clean state', () => {
  const limiters = {
    worker1: { inflight_tokens: 10000, cap_tokens: 100000, inflight_count: 1 },
    worker2: { inflight_tokens: 10000, cap_tokens: 100000, inflight_count: 1 },
    worker3: { inflight_tokens: 10000, cap_tokens: 100000, inflight_count: 1 },
    worker4: { inflight_tokens: 10000, cap_tokens: 100000, inflight_count: 1 },
  };
  const { workers, has_any_down, has_any_degraded } = buildWorkerHealth(limiters, null, []);
  assert.equal(has_any_down, false);
  assert.equal(has_any_degraded, false);
  assert.equal(workers.every(w => w.status === 'healthy'), true);
});
