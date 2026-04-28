import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  ComposedChart,
  Line,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
} from 'recharts';
import { SafeChart } from '../../../shared/SafeChart';

/**
 * ForecastTab — Empirical throughput-vs-backpressure view per worker.
 *
 * Wo läuft die Bridge in ihre eigene Concurrency-Bremse rein? Bridge erlaubt
 * pro Worker max 5 concurrent. Wenn ein Worker voll ist, antwortet er mit
 * 503 ("Bridge overloaded — too many concurrent requests"); nginx versucht
 * dann den nächsten Worker. Sind alle voll, sieht der Caller den 503.
 *
 * Drei Datenreihen pro Worker:
 *   - success_rpm        (durchgezogen)  : Calls die durchgegangen sind
 *   - reject_rpm   (503)  (gepunktet)    : Concurrency-Rejects (Backpressure-Signal)
 *   - upstream_err_rpm    (rote Punkte)  : Echte Upstream-Errors (Anthropic 429/5xx)
 *
 * Empfohlener Throttle pro Worker = min(max_clean × 0.9, first_reject × 0.8).
 * Bridge-Total = Summe aller Worker-Empfehlungen.
 */

type MetricKey = 'rpm' | 'in_tpm' | 'out_tpm';

interface Bucket {
  ts: number;
  success_rpm: number;
  upstream_err_rpm: number;
  reject_rpm: number;
  offered_rpm: number;
  in_tpm: number;
  out_tpm: number;
  had_429: boolean;
  had_5xx: boolean;
  // legacy aliases (kept for back-compat reading)
  rpm?: number;
  err_count?: number;
  rejected?: number;
  rejected_per_min?: number;
}

interface ErrorEvent {
  ts: number;
  code: string | null;
  status: string;
  duration_ms: number | null;
}

interface Ceiling {
  samples_total: number;
  samples_clean: number;
  samples_with_rejects: number;
  samples_with_upstream_errors: number;
  first_reject_offered_rpm: number | null;
  first_reject_success_rpm: number | null;
  first_reject_ts: number | null;
  first_upstream_err_offered_rpm: number | null;
  first_upstream_err_ts: number | null;
  max_clean_success_rpm: number | null;
  max_clean_in_tpm: number | null;
  max_clean_out_tpm: number | null;
  recommendation_rpm: number | null;
  recommendation_in_tpm: number | null;
  recommendation_out_tpm: number | null;
  basis: 'no_data' | 'clean' | 'reject' | 'upstream';
}

interface WorkerData {
  buckets: Bucket[];
  errors: ErrorEvent[];
  ceiling: Ceiling;
  current: Bucket | null;
}

interface ApiResponse {
  lookback_hours: number;
  bucket_seconds: number;
  now: number;
  workers: Record<string, WorkerData>;
  totals: {
    calls: number;
    successes: number;
    concurrency_rejects_503: number;
    upstream_errors: number;
    workers_seen: number;
    bridge_recommendation_rpm: number;
  };
  _error?: string;
}

interface TuneEvent {
  ts: number;
  direction: 'shrink' | 'grow' | 'hold';
  reason: string;
  cap_before: number;
  cap_after: number;
  observed_rate_limits: number;
  observed_peak_util_pct: number;
}

interface LimiterSnapshot {
  worker: string;
  cap_tokens: number;
  floor_tokens: number;
  ceiling_tokens: number;
  inflight_tokens: number;
  inflight_count: number;
  utilization_pct: number;
  last_rate_limit_ts: number | null;
  last_shrink_ts: number | null;
  last_tune_ts: number;
  hard_request_ceiling: number;
  recent_events: TuneEvent[];
  config: {
    shrink_factor: number;
    grow_factor: number;
    shrink_trigger_sec: number;
    grow_trigger_sec: number;
    shrink_cooldown_sec: number;
    grow_utilization_pct: number;
    tune_interval_sec: number;
  };
}

interface LimitersResponse {
  now: number;
  limiters: Record<string, LimiterSnapshot>;
  totals: {
    worker_count: number;
    cap_tokens: number;
    inflight_tokens: number;
    inflight_count: number;
    utilization_pct: number;
  };
  fanout?: number;
  hits?: number;
  _error?: string;
}

const WORKER_COLORS = ['#7aa2f7', '#9ece6a', '#e0af68', '#bb9af7', '#f7768e', '#73daca', '#ff9e64', '#c0caf5'];

function getWorkerMeta(name: string): { color: string; label: string } {
  const num = parseInt(name.replace(/\D/g, ''), 10);
  const colorIdx = isNaN(num) ? name.length : num - 1;
  return {
    color: WORKER_COLORS[colorIdx % WORKER_COLORS.length],
    label: name.replace('worker', 'W').replace('-', ' '),
  };
}

type MetricMeta = {
  key: MetricKey;
  label: string;
  unit: string;
  successKey: keyof Bucket;
  ceilMaxKey: keyof Ceiling;
};

const METRIC_OPTIONS: MetricMeta[] = [
  { key: 'rpm',     label: 'Requests/min',     unit: 'req/min', successKey: 'success_rpm', ceilMaxKey: 'max_clean_success_rpm' },
  { key: 'in_tpm',  label: 'Input tokens/min', unit: 'tok/min', successKey: 'in_tpm',      ceilMaxKey: 'max_clean_in_tpm' },
  { key: 'out_tpm', label: 'Output tokens/min',unit: 'tok/min', successKey: 'out_tpm',     ceilMaxKey: 'max_clean_out_tpm' },
];

const HOURS_OPTIONS = [
  { label: '1h',  hours: 1 },
  { label: '6h',  hours: 6 },
  { label: '24h', hours: 24 },
  { label: '72h', hours: 72 },
];

const BUCKET_OPTIONS = [
  { label: '1m',  sec: 60 },
  { label: '5m',  sec: 300 },
  { label: '15m', sec: 900 },
];

function fmtTime(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function fmtNum(n: number | null | undefined, unit: string): string {
  if (n === null || n === undefined) return '—';
  if (n >= 10000) return `${(n / 1000).toFixed(1)}k ${unit}`;
  if (n >= 100) return `${Math.round(n)} ${unit}`;
  return `${n.toFixed(1)} ${unit}`;
}

function fmtTokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

function fmtAgo(ts: number | null | undefined, now: number): string {
  if (!ts) return 'never';
  const dt = Math.max(0, now - ts);
  if (dt < 60) return `${Math.round(dt)}s ago`;
  if (dt < 3600) return `${Math.round(dt / 60)}m ago`;
  if (dt < 86400) return `${Math.round(dt / 3600)}h ago`;
  return `${Math.round(dt / 86400)}d ago`;
}

export default function ForecastTab() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [limiters, setLimiters] = useState<LimitersResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [hours, setHours] = useState(24);
  const [bucketSec, setBucketSec] = useState(60);
  const [metric, setMetric] = useState<MetricKey>('rpm');
  const [showRejects, setShowRejects] = useState(true);
  const [enabledWorkers, setEnabledWorkers] = useState<Record<string, boolean>>({});

  const fetchData = useCallback(async () => {
    if (window.__cuiServerAlive === false) return;
    setLoading(true);
    setError('');
    try {
      const [thrRes, limRes] = await Promise.allSettled([
        fetch(
          `/api/bridge/metrics/throughput?hours=${hours}&bucket_seconds=${bucketSec}`,
          { signal: AbortSignal.timeout(30000) }
        ),
        fetch(
          `/api/bridge/metrics/limiters`,
          { signal: AbortSignal.timeout(15000) }
        ),
      ]);
      if (thrRes.status === 'fulfilled') {
        if (!thrRes.value.ok) throw new Error(`HTTP ${thrRes.value.status}`);
        const raw: ApiResponse = await thrRes.value.json();
        if (raw._error) setError(raw._error);
        setData(raw);
        // Initialize enabledWorkers from actual data (only on first load)
        if (raw.workers) {
          setEnabledWorkers(prev => {
            if (Object.keys(prev).length > 0) return prev;
            const init: Record<string, boolean> = {};
            Object.keys(raw.workers).forEach(k => { init[k] = true; });
            return init;
          });
        }
      }
      if (limRes.status === 'fulfilled' && limRes.value.ok) {
        try {
          const lim: LimitersResponse = await limRes.value.json();
          setLimiters(lim);
        } catch { /* ignore — limiter strip just won't render */ }
      }
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  }, [hours, bucketSec]);

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, 60000);
    return () => clearInterval(id);
  }, [fetchData]);

  const metricMeta = useMemo(
    () => METRIC_OPTIONS.find(m => m.key === metric)!,
    [metric]
  );

  // Merge per-worker buckets into one row per timestamp
  const chartData = useMemo(() => {
    if (!data) return [];
    const tsSet = new Set<number>();
    Object.entries(data.workers).forEach(([wkey, w]) => {
      if (!enabledWorkers[wkey]) return;
      w.buckets.forEach(b => tsSet.add(b.ts));
    });
    const sortedTs = Array.from(tsSet).sort((a, b) => a - b);

    return sortedTs.map(ts => {
      const row: Record<string, any> = { ts };
      Object.entries(data.workers).forEach(([wkey, w]) => {
        if (!enabledWorkers[wkey]) return;
        const b = w.buckets.find(x => x.ts === ts);
        if (b) {
          row[`${wkey}_success`] = b[metricMeta.successKey] as number;
          row[`${wkey}_reject`]  = metric === 'rpm' ? b.reject_rpm : 0;
        }
      });
      return row;
    });
  }, [data, enabledWorkers, metricMeta, metric]);

  // Y-axis ceiling
  const yMax = useMemo(() => {
    if (!data) return 100;
    let max = 0;
    Object.entries(data.workers).forEach(([wkey, w]) => {
      if (!enabledWorkers[wkey]) return;
      w.buckets.forEach(b => {
        const v = b[metricMeta.successKey] as number;
        if (v > max) max = v;
        if (metric === 'rpm' && b.reject_rpm > max) max = b.reject_rpm;
      });
      const mc = w.ceiling[metricMeta.ceilMaxKey] as number | null;
      if (mc && mc > max) max = mc;
      if (metric === 'rpm' && w.ceiling.first_reject_offered_rpm && w.ceiling.first_reject_offered_rpm > max) {
        max = w.ceiling.first_reject_offered_rpm;
      }
    });
    return Math.max(max * 1.2, 1);
  }, [data, enabledWorkers, metricMeta, metric]);

  // Upstream error scatter (NOT 503 rejects — those are a line now)
  const errorScatter = useMemo(() => {
    if (!data) return {} as Record<string, { ts: number; y: number; code: string | null; status: string }[]>;
    const out: Record<string, { ts: number; y: number; code: string | null; status: string }[]> = {};
    let idx = 0;
    Object.entries(data.workers).forEach(([wkey, w]) => {
      if (!enabledWorkers[wkey]) return;
      const yLevel = yMax * (0.95 - idx * 0.04);
      const upstreamOnly = w.errors.filter(e => !((e.code || '').includes('503')));
      out[wkey] = upstreamOnly.map(e => ({
        ts: e.ts, y: yLevel, code: e.code, status: e.status,
      }));
      idx++;
    });
    return out;
  }, [data, enabledWorkers, yMax]);

  return (
    <div data-ai-id="forecast-tab-content" style={{ padding: 12, height: '100%', overflowY: 'auto' }}>
      {/* Header */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        flexWrap: 'wrap', gap: 8, marginBottom: 12,
      }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--tn-text)' }}>
            Throughput vs Backpressure — wo droht die Bridge zu blockieren?
          </h3>
          <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginTop: 2 }}>
            Pro Worker: <b>solid</b> = success-rpm, <b>gepunktet</b> = 503 Concurrency-Rejects (Bridge voll, max 5 parallel/Worker), <b>rote Punkte</b> = echte Upstream-Errors (Anthropic 429/5xx). Throttle-Empfehlung = unter Concurrency-Cap bleiben.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          {METRIC_OPTIONS.map(m => (
            <button key={m.key} onClick={() => setMetric(m.key)} style={{
              padding: '3px 8px', borderRadius: 3, fontSize: 10, cursor: 'pointer',
              background: metric === m.key ? 'var(--tn-blue)' : 'var(--tn-bg)',
              border: '1px solid var(--tn-border)',
              color: metric === m.key ? '#fff' : 'var(--tn-text-muted)',
              fontWeight: 600,
            }}>{m.label}</button>
          ))}
          <span style={{ width: 8 }} />
          {HOURS_OPTIONS.map(d => (
            <button key={d.hours} onClick={() => setHours(d.hours)} style={{
              padding: '3px 8px', borderRadius: 3, fontSize: 10, cursor: 'pointer',
              background: hours === d.hours ? 'var(--tn-blue)' : 'var(--tn-bg)',
              border: '1px solid var(--tn-border)',
              color: hours === d.hours ? '#fff' : 'var(--tn-text-muted)',
              fontWeight: 600,
            }}>{d.label}</button>
          ))}
          <span style={{ width: 8 }} />
          {BUCKET_OPTIONS.map(b => (
            <button key={b.sec} onClick={() => setBucketSec(b.sec)} style={{
              padding: '3px 8px', borderRadius: 3, fontSize: 10, cursor: 'pointer',
              background: bucketSec === b.sec ? 'var(--tn-purple)' : 'var(--tn-bg)',
              border: '1px solid var(--tn-border)',
              color: bucketSec === b.sec ? '#fff' : 'var(--tn-text-muted)',
              fontWeight: 600,
            }}>{b.label}</button>
          ))}
          <button
            onClick={() => setShowRejects(v => !v)}
            disabled={metric !== 'rpm'}
            title="Zeigt 503-Concurrency-Rejects als gepunktete Linie (nur bei req/min sinnvoll)"
            style={{
              padding: '3px 8px', borderRadius: 3, fontSize: 10, cursor: metric === 'rpm' ? 'pointer' : 'not-allowed',
              background: showRejects && metric === 'rpm' ? 'var(--tn-red)' : 'var(--tn-bg)',
              border: '1px solid var(--tn-border)',
              color: showRejects && metric === 'rpm' ? '#fff' : 'var(--tn-text-muted)',
              fontWeight: 600,
              opacity: metric === 'rpm' ? 1 : 0.4,
            }}
          >503</button>
          <button onClick={fetchData} disabled={loading} style={{
            padding: '3px 10px', borderRadius: 3, fontSize: 10, cursor: 'pointer',
            background: 'var(--tn-bg)', border: '1px solid var(--tn-border)',
            color: 'var(--tn-text-muted)', marginLeft: 8,
            opacity: loading ? 0.5 : 1,
          }}>{loading ? '…' : '↻'}</button>
        </div>
      </div>

      {/* Bridge totals strip */}
      {data && data.totals && (
        <div style={{
          display: 'flex', gap: 16, fontSize: 10, color: 'var(--tn-text-muted)',
          padding: '6px 10px', background: 'var(--tn-bg)', border: '1px solid var(--tn-border)',
          borderRadius: 4, marginBottom: 8, flexWrap: 'wrap', alignItems: 'center',
        }}>
          <div><b style={{ color: 'var(--tn-text)' }}>{(data.totals.calls ?? 0).toLocaleString()}</b> calls</div>
          <div style={{ color: 'var(--tn-green)' }}><b>{(data.totals.successes ?? 0).toLocaleString()}</b> success</div>
          <div style={{ color: 'var(--tn-red)' }}><b>{(data.totals.concurrency_rejects_503 ?? 0).toLocaleString()}</b> 503 concurrency-rejects (bridge voll)</div>
          <div style={{ color: 'var(--tn-orange)' }}><b>{(data.totals.upstream_errors ?? 0).toLocaleString()}</b> upstream errors (Anthropic)</div>
          <div style={{ marginLeft: 'auto', color: 'var(--tn-green)', fontWeight: 700 }}>
            → safe bridge throttle: {fmtNum(data.totals.bridge_recommendation_rpm, 'req/min')} total
          </div>
        </div>
      )}

      {/* Adaptive limiter strip — token-budget per worker, auto-tuned from real Anthropic rate-limit events */}
      {limiters && Object.keys(limiters.limiters).length > 0 && (
        <div data-ai-id="adaptive-limiter-strip" style={{
          padding: '8px 10px', background: 'var(--tn-bg)', border: '1px solid var(--tn-purple)',
          borderRadius: 4, marginBottom: 8,
        }}>
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            fontSize: 10, color: 'var(--tn-text-muted)', marginBottom: 6,
          }}>
            <div>
              <b style={{ color: 'var(--tn-purple)' }}>Adaptive Token-Budget</b>
              {' — '}
              auto-tuning per worker · target: -10% on Anthropic rate-limit, +5% nach 30min sauber bei ≥80% Auslastung
            </div>
            <div style={{ fontFamily: 'monospace' }}>
              Σ cap: <b style={{ color: 'var(--tn-text)' }}>{fmtTokens(limiters.totals.cap_tokens)}</b>
              {' · '}
              Σ in-flight: <b style={{ color: 'var(--tn-text)' }}>{fmtTokens(limiters.totals.inflight_tokens)}</b>
              {' ('}<span style={{ color: limiters.totals.utilization_pct >= 80 ? 'var(--tn-red)' : 'var(--tn-green)' }}>
                {limiters.totals.utilization_pct.toFixed(1)}%</span>
              {' · '}{limiters.totals.inflight_count} req in-flight)
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {Object.keys(limiters.limiters).map((wkey, idx) => {
              const lim = limiters.limiters[wkey];
              const meta = getWorkerMeta(wkey);
              if (!lim) {
                return (
                  <div key={wkey} style={{
                    flex: '1 1 220px', minWidth: 220,
                    padding: '6px 8px', borderRadius: 3,
                    background: 'var(--tn-surface)', border: `1px dashed ${meta.color}55`,
                    fontSize: 9, color: 'var(--tn-text-muted)', fontFamily: 'monospace',
                  }}>
                    <span style={{ color: meta.color, fontWeight: 600 }}>{meta.label.split(' ')[0]}</span>
                    {' '}—{' '}<i>no snapshot (worker idle or unreachable)</i>
                  </div>
                );
              }
              const utilColor = lim.utilization_pct >= 80 ? 'var(--tn-red)' : lim.utilization_pct >= 50 ? 'var(--tn-orange)' : 'var(--tn-green)';
              const lastTune = lim.recent_events && lim.recent_events.length > 0 ? lim.recent_events[lim.recent_events.length - 1] : null;
              return (
                <div key={wkey} style={{
                  flex: '1 1 220px', minWidth: 220,
                  padding: '6px 8px', borderRadius: 3,
                  background: 'var(--tn-surface)', border: `1px solid ${meta.color}55`,
                  fontSize: 9, fontFamily: 'monospace',
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3 }}>
                    <span style={{ color: meta.color, fontWeight: 700, fontSize: 10 }}>{meta.label.split(' ')[0]}</span>
                    <span style={{ color: 'var(--tn-text-muted)', fontSize: 8 }}>
                      tune {fmtAgo(lim.last_tune_ts, limiters.now)}
                    </span>
                  </div>
                  {/* Utilization bar */}
                  <div style={{
                    height: 4, background: 'var(--tn-bg)', borderRadius: 2, overflow: 'hidden', marginBottom: 4,
                  }}>
                    <div style={{
                      height: '100%', width: `${Math.min(100, lim.utilization_pct)}%`,
                      background: utilColor, transition: 'width 0.3s',
                    }} />
                  </div>
                  <div style={{ color: 'var(--tn-text-muted)' }}>
                    cap: <b style={{ color: 'var(--tn-text)' }}>{fmtTokens(lim.cap_tokens)}</b> tokens
                    {' '}({fmtTokens(lim.floor_tokens)}…{fmtTokens(lim.ceiling_tokens)})
                  </div>
                  <div style={{ color: 'var(--tn-text-muted)' }}>
                    in-flight: <b style={{ color: utilColor }}>{fmtTokens(lim.inflight_tokens)}</b>
                    {' '}<span style={{ color: utilColor }}>({lim.utilization_pct.toFixed(1)}%)</span>
                    {' · '}{lim.inflight_count} req
                  </div>
                  <div style={{ color: lim.last_rate_limit_ts ? 'var(--tn-red)' : 'var(--tn-text-muted)', fontSize: 8 }}>
                    last 429: {fmtAgo(lim.last_rate_limit_ts, limiters.now)}
                    {lim.last_shrink_ts && (
                      <> · last shrink: {fmtAgo(lim.last_shrink_ts, limiters.now)}</>
                    )}
                  </div>
                  {lastTune && lastTune.direction !== 'hold' && (
                    <div style={{
                      fontSize: 8, marginTop: 3,
                      color: lastTune.direction === 'shrink' ? 'var(--tn-red)' : 'var(--tn-green)',
                    }}>
                      {lastTune.direction === 'shrink' ? '↓' : '↑'} {fmtTokens(lastTune.cap_before)} → {fmtTokens(lastTune.cap_after)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Worker summary cards */}
      {data && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
          {Object.entries(data.workers).map(([wkey, w]) => {
            const meta = getWorkerMeta(wkey);
            const on = enabledWorkers[wkey];
            const c = w.ceiling;
            const cur = w.current ? (w.current[metricMeta.successKey] as number) : null;
            const curReject = w.current ? w.current.reject_rpm : null;
            return (
              <button
                key={wkey}
                onClick={() => setEnabledWorkers(prev => ({ ...prev, [wkey]: !prev[wkey] }))}
                style={{
                  padding: '6px 10px', borderRadius: 4, cursor: 'pointer',
                  background: on ? `${meta.color}22` : 'var(--tn-bg)',
                  border: `1px solid ${on ? meta.color : 'var(--tn-border)'}`,
                  color: on ? meta.color : 'var(--tn-text-muted)',
                  fontSize: 10, fontWeight: 600, textAlign: 'left',
                  display: 'flex', flexDirection: 'column', gap: 2, minWidth: 220,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: meta.color }} />
                  <span>{meta.label}</span>
                  <span style={{ marginLeft: 'auto', opacity: 0.7 }}>
                    {c.samples_clean}/{c.samples_total} clean
                  </span>
                </div>
                <div style={{ fontFamily: 'monospace', fontSize: 9, opacity: 0.85 }}>
                  now: {fmtNum(cur, metricMeta.unit)}
                  {metric === 'rpm' && curReject !== null && curReject > 0 && (
                    <span style={{ color: 'var(--tn-red)', marginLeft: 6 }}>
                      +{fmtNum(curReject, 'rej/min')}
                    </span>
                  )}
                </div>
                <div style={{ fontFamily: 'monospace', fontSize: 9, opacity: 0.85 }}>
                  max-clean: {fmtNum(c[metricMeta.ceilMaxKey] as number | null, metricMeta.unit)}
                </div>
                {metric === 'rpm' && (
                  <div style={{ fontFamily: 'monospace', fontSize: 9, opacity: 0.85, color: c.first_reject_offered_rpm ? 'var(--tn-red)' : undefined }}>
                    first-503@: {fmtNum(c.first_reject_offered_rpm, 'req/min')}
                  </div>
                )}
                {metric === 'rpm' && c.first_upstream_err_offered_rpm !== null && (
                  <div style={{ fontFamily: 'monospace', fontSize: 9, color: 'var(--tn-orange)' }}>
                    first-upstream@: {fmtNum(c.first_upstream_err_offered_rpm, 'req/min')}
                  </div>
                )}
                <div style={{ fontFamily: 'monospace', fontSize: 9, opacity: 1, color: 'var(--tn-green)', fontWeight: 700 }}>
                  → throttle: {fmtNum(
                    metric === 'rpm' ? c.recommendation_rpm
                      : metric === 'in_tpm' ? c.recommendation_in_tpm
                      : c.recommendation_out_tpm,
                    metricMeta.unit
                  )}
                </div>
                <div style={{ fontFamily: 'monospace', fontSize: 8, opacity: 0.6 }}>
                  basis: {c.basis}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {error && (
        <div style={{
          padding: '6px 10px', fontSize: 11, marginBottom: 12,
          color: 'var(--tn-red)', background: 'rgba(247,118,142,0.1)', borderRadius: 3,
        }}>{error}</div>
      )}

      {loading && !data && (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--tn-text-muted)', fontSize: 12 }}>
          Loading…
        </div>
      )}

      {data && (
        <>
          <div style={{ height: 460, background: 'var(--tn-bg)', border: '1px solid var(--tn-border)', borderRadius: 4, padding: 8 }}>
            <SafeChart>
              <ComposedChart data={chartData} margin={{ top: 12, right: 24, left: 8, bottom: 24 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--tn-border)" />
                <XAxis
                  dataKey="ts"
                  type="number"
                  scale="time"
                  domain={['dataMin', 'dataMax']}
                  tickFormatter={fmtTime}
                  stroke="var(--tn-text-muted)"
                  tick={{ fontSize: 9 }}
                />
                <YAxis
                  domain={[0, yMax]}
                  tickFormatter={(v) => `${v}`}
                  stroke="var(--tn-text-muted)"
                  tick={{ fontSize: 10 }}
                  label={{ value: metricMeta.unit, angle: -90, position: 'insideLeft', fill: 'var(--tn-text-muted)', fontSize: 10 }}
                />
                <Tooltip
                  contentStyle={{ background: 'var(--tn-surface)', border: '1px solid var(--tn-border)', fontSize: 11 }}
                  labelFormatter={(ts) => fmtTime(ts as number)}
                  formatter={(value: any, name: any) => {
                    if (typeof value !== 'number') return [value, name];
                    return [fmtNum(value, metricMeta.unit), name];
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 10 }} />
                <ReferenceLine x={data.now} stroke="var(--tn-text-muted)" strokeDasharray="2 4" label={{ value: 'now', position: 'top', fill: 'var(--tn-text-muted)', fontSize: 9 }} />

                {/* Per-worker reference lines */}
                {Object.entries(data.workers).map(([wkey, w]) => {
                  if (!enabledWorkers[wkey]) return null;
                  const meta = getWorkerMeta(wkey);
                  const rec = metric === 'rpm'
                    ? w.ceiling.recommendation_rpm
                    : metric === 'in_tpm'
                      ? w.ceiling.recommendation_in_tpm
                      : w.ceiling.recommendation_out_tpm;
                  const lines = [];
                  if (metric === 'rpm' && w.ceiling.first_reject_offered_rpm !== null) {
                    lines.push(
                      <ReferenceLine
                        key={`${wkey}_fr`}
                        y={w.ceiling.first_reject_offered_rpm}
                        stroke="var(--tn-red)"
                        strokeOpacity={0.5}
                        strokeDasharray="2 6"
                        ifOverflow="extendDomain"
                      />
                    );
                  }
                  if (rec !== null && rec !== undefined) {
                    lines.push(
                      <ReferenceLine
                        key={`${wkey}_rec`}
                        y={rec}
                        stroke={meta.color}
                        strokeOpacity={0.7}
                        strokeDasharray="6 3"
                        ifOverflow="extendDomain"
                        label={{ value: `${meta.label.split(' ')[0]} throttle`, position: 'right', fill: meta.color, fontSize: 9 }}
                      />
                    );
                  }
                  return lines;
                })}

                {/* Success throughput lines per worker (solid) */}
                {Object.entries(data.workers).map(([wkey]) => {
                  if (!enabledWorkers[wkey]) return null;
                  const meta = getWorkerMeta(wkey);
                  return (
                    <Line
                      key={`${wkey}_success`}
                      type="monotone"
                      dataKey={`${wkey}_success`}
                      name={`${meta.label} success`}
                      stroke={meta.color}
                      strokeWidth={2}
                      dot={false}
                      isAnimationActive={false}
                      connectNulls
                    />
                  );
                })}

                {/* 503 reject lines per worker (dotted) — only on rpm metric */}
                {metric === 'rpm' && showRejects && Object.entries(data.workers).map(([wkey]) => {
                  if (!enabledWorkers[wkey]) return null;
                  const meta = getWorkerMeta(wkey);
                  return (
                    <Line
                      key={`${wkey}_reject`}
                      type="monotone"
                      dataKey={`${wkey}_reject`}
                      name={`${meta.label.split(' ')[0]} 503-reject`}
                      stroke={meta.color}
                      strokeWidth={1}
                      strokeDasharray="2 3"
                      strokeOpacity={0.65}
                      dot={false}
                      isAnimationActive={false}
                      connectNulls
                    />
                  );
                })}

                {/* Upstream-error markers (red dots) */}
                {Object.entries(errorScatter).map(([wkey, points]) => {
                  if (!enabledWorkers[wkey] || points.length === 0) return null;
                  const meta = getWorkerMeta(wkey);
                  return (
                    <Scatter
                      key={`${wkey}_err`}
                      name={`${meta.label.split(' ')[0]} upstream-err`}
                      data={points}
                      dataKey="y"
                      fill="var(--tn-red)"
                      stroke={meta.color}
                      strokeWidth={1}
                      shape="circle"
                      isAnimationActive={false}
                    />
                  );
                })}
              </ComposedChart>
            </SafeChart>
          </div>

          <div style={{
            marginTop: 8, fontSize: 10, color: 'var(--tn-text-muted)',
            display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8,
          }}>
            <div>
              Bucket {data.bucket_seconds}s · Lookback {data.lookback_hours}h · {data.totals.workers_seen} Workers
            </div>
            <div style={{ fontStyle: 'italic' }}>
              throttle/Worker = min(max-clean × 0.9, first-503 × 0.8, first-upstream × 0.8). Bridge-Total = Σ Worker.
            </div>
          </div>
        </>
      )}
    </div>
  );
}
