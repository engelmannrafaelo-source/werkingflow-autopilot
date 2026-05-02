/**
 * Duration parser tests for /api/qa/duration-stats.
 *
 * Run: npx tsx --test server/__tests__/qa-duration.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReportForDuration, computeDurationStats, computeHistogram } from '../routes/qa.js';

const HEADER_PASS = `# Scenario Test Report: acro-community.api-auth

## Rating: ★★★★★★★★★☆ 9/10

**Status:** ✅ PASS
**Coverage:** 100%
**Duration:** 116.3s
**Steps:** 0/0
**Criteria:** 6/6
**Timestamp:** 2026-04-29T18:37:52.382379

---
`;

const HEADER_FAIL = `# Scenario Test Report: werking-report.gutachten-create

## Rating: ★★★★☆☆☆☆☆☆ 4/10

**Status:** ❌ FAIL
**Duration:** 42.0s
**Timestamp:** 2026-04-30T10:00:00
`;

const HEADER_PARTIAL = `# Scenario Test Report: engelmann.projekt-list

**Status:** ⚠ PARTIAL
**Duration:** 8.5s
**Timestamp:** 2026-04-29T12:00:00
`;

test('parseReportForDuration: extracts app, scenarioId, status, duration from filename + header', () => {
  const r = parseReportForDuration(
    'acro-community_api-auth_20260429_183752_287.md',
    HEADER_PASS,
    Date.now(),
  );
  assert.ok(r);
  assert.equal(r!.app, 'acro-community');
  assert.equal(r!.scenarioId, 'acro-community.api-auth');
  assert.equal(r!.status, 'PASS');
  assert.equal(r!.duration, 116.3);
  assert.equal(r!.timestamp, '2026-04-29T18:37:52.382379');
});

test('parseReportForDuration: handles compound app prefix (werking-report)', () => {
  const r = parseReportForDuration(
    'werking-report_gutachten-create_20260430_100000_000.md',
    HEADER_FAIL,
    Date.now(),
  );
  assert.ok(r);
  assert.equal(r!.app, 'werking-report');
  assert.equal(r!.scenarioId, 'werking-report.gutachten-create');
  assert.equal(r!.status, 'FAIL');
  assert.equal(r!.duration, 42.0);
});

test('parseReportForDuration: handles dotted scenario IDs', () => {
  // foo.bar.baz scenarios are stored with dots → underscores in filename
  const r = parseReportForDuration(
    'engelmann_projekt_list_20260429_120000_000.md',
    HEADER_PARTIAL,
    Date.now(),
  );
  assert.ok(r);
  assert.equal(r!.app, 'engelmann');
  assert.equal(r!.scenarioId, 'engelmann.projekt.list');
  assert.equal(r!.status, 'PARTIAL');
  assert.equal(r!.duration, 8.5);
});

test('parseReportForDuration: returns null for missing duration', () => {
  const noDuration = HEADER_PASS.replace('**Duration:** 116.3s\n', '');
  const r = parseReportForDuration(
    'acro-community_api-auth_20260429_183752_287.md',
    noDuration,
    Date.now(),
  );
  assert.equal(r, null);
});

test('parseReportForDuration: returns null for unknown app prefix', () => {
  const r = parseReportForDuration(
    'unknown-app_test_20260429_183752_287.md',
    HEADER_PASS,
    Date.now(),
  );
  assert.equal(r, null);
});

test('parseReportForDuration: returns null for filenames without timestamp', () => {
  const r = parseReportForDuration(
    'acro-community_no-timestamp.md',
    HEADER_PASS,
    Date.now(),
  );
  assert.equal(r, null);
});

test('computeDurationStats: empty input → zeros', () => {
  const s = computeDurationStats([]);
  assert.deepEqual(s, { count: 0, avg: 0, median: 0, p90: 0, p99: 0, min: 0, max: 0 });
});

test('computeDurationStats: single value', () => {
  const s = computeDurationStats([10]);
  assert.equal(s.count, 1);
  assert.equal(s.avg, 10);
  assert.equal(s.median, 10);
  assert.equal(s.min, 10);
  assert.equal(s.max, 10);
});

test('computeDurationStats: even count median is mean of two mid values', () => {
  const s = computeDurationStats([1, 3, 5, 7]);
  assert.equal(s.median, 4);
  assert.equal(s.avg, 4);
  assert.equal(s.min, 1);
  assert.equal(s.max, 7);
});

test('computeDurationStats: odd count median is middle value', () => {
  const s = computeDurationStats([1, 2, 3, 4, 5]);
  assert.equal(s.median, 3);
  assert.equal(s.avg, 3);
});

test('computeDurationStats: p90/p99 bounded to max index', () => {
  const s = computeDurationStats([10, 20, 30]);
  assert.equal(s.p90, 30);
  assert.equal(s.p99, 30);
  assert.equal(s.max, 30);
});

test('computeHistogram: buckets correctly', () => {
  const h = computeHistogram([5, 45, 90, 200, 400, 1000, 3600]);
  // <30s: 5
  // 30s–1m: 45
  // 1–2m: 90
  // 2–5m: 200
  // 5–10m: 400
  // 10–30m: 1000
  // 30m+: 3600
  const map = Object.fromEntries(h.map(b => [b.bucket, b.count]));
  assert.equal(map['<30s'], 1);
  assert.equal(map['30s–1m'], 1);
  assert.equal(map['1–2m'], 1);
  assert.equal(map['2–5m'], 1);
  assert.equal(map['5–10m'], 1);
  assert.equal(map['10–30m'], 1);
  assert.equal(map['30m+'], 1);
});

test('computeHistogram: empty input → all zero buckets, full label set', () => {
  const h = computeHistogram([]);
  assert.equal(h.length, 7);
  for (const b of h) assert.equal(b.count, 0);
});

// Snapshot-style: lock the response shape we expose to the frontend.
test('snapshot: aggregate response shape stays stable', () => {
  const sampleStats = computeDurationStats([10, 20, 30]);
  const sampleHistogram = computeHistogram([10, 20, 30]);
  // The endpoint serializes objects of these exact shapes.
  assert.deepEqual(Object.keys(sampleStats).sort(), ['avg', 'count', 'max', 'median', 'min', 'p90', 'p99']);
  assert.equal(sampleHistogram.length, 7);
  for (const b of sampleHistogram) {
    assert.deepEqual(Object.keys(b).sort(), ['bucket', 'count']);
  }
});
