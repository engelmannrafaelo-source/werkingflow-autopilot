/**
 * Bridge classification tests — Rafael-Prinzip 2026-04-29:
 * "Wenn jemand auf die Autobahn nicht auffahren kann, ist es ein Ausfall."
 *
 * Run: npx tsx --test server/__tests__/bridge-classification.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCaller, summarizePool } from '../routes/bridge.js';

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
