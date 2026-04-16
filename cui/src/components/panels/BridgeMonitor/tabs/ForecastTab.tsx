import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  ResponsiveContainer,
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

/**
 * ForecastTab — Visual validation of usage prognosis vs actual rate-limit events.
 *
 * Plots per-worker:
 *   - usage % time-series (solid line)
 *   - linear projection forward (dashed line)
 *   - error / rate-limit events (red dots) overlaid on the same time axis
 *
 * Goal: see whether the projected 95% crossing actually correlates with the
 * 503 / rate_limit_error events we observe in prompt_calls.*.jsonl.
 */

type MetricKey = 'weeklyAllModels' | 'currentSession' | 'weeklySonnet';

interface SeriesPoint {
  ts: number;
  weekly?: number;
  session?: number;
  sonnet?: number;
  projected?: boolean;
}

interface ErrorEvent {
  ts: number;
  code: string | null;
  status: string;
  duration_ms: number | null;
}

interface WorkerData {
  account: string | null;
  series: SeriesPoint[];
  errors: ErrorEvent[];
  projection: SeriesPoint[];
  projection_summary: {
    rate_per_h: number;
    samples_used: number;
    eta_95_in_min: number | null;
    current_pct: number | null;
    note?: string;
  };
}

interface ApiResponse {
  metric: MetricKey;
  now: number;
  lookback_days: number;
  project_minutes: number;
  workers: Record<string, WorkerData>;
  totals: { snapshot_count: number; errors_total: number };
  _error?: string;
}

const WORKER_META: Record<string, { color: string; label: string }> = {
  worker1: { color: '#7aa2f7', label: 'W1 (engelmann)' },
  worker2: { color: '#9ece6a', label: 'W2 (office)' },
  worker3: { color: '#e0af68', label: 'W3 (gmail)' },
  worker4: { color: '#bb9af7', label: 'W4 (werking)' },
};

const METRIC_OPTIONS: { key: MetricKey; label: string; field: keyof SeriesPoint }[] = [
  { key: 'weeklyAllModels', label: 'Weekly All', field: 'weekly' },
  { key: 'currentSession', label: 'Session',    field: 'session' },
  { key: 'weeklySonnet',   label: 'Sonnet',     field: 'sonnet' },
];

const DAYS_OPTIONS = [
  { label: '1d',  days: 1 },
  { label: '3d',  days: 3 },
  { label: '7d',  days: 7 },
  { label: '14d', days: 14 },
];

function fmtTime(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function fmtETA(min: number | null): string {
  if (min === null || min === undefined) return '—';
  if (min < 60) return `${Math.round(min)}m`;
  const h = min / 60;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

export default function ForecastTab() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [days, setDays] = useState(7);
  const [metric, setMetric] = useState<MetricKey>('weeklyAllModels');
  const [enabledWorkers, setEnabledWorkers] = useState<Record<string, boolean>>({
    worker1: true, worker2: true, worker3: true, worker4: true,
  });

  const fetchData = useCallback(async () => {
    if ((window as any).__cuiServerAlive === false) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch(
        `/api/bridge/metrics/usage-projection?days=${days}&metric=${metric}`,
        { signal: AbortSignal.timeout(30000) }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw: ApiResponse = await res.json();
      if (raw._error) setError(raw._error);
      setData(raw);
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  }, [days, metric]);

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, 60000);
    return () => clearInterval(id);
  }, [fetchData]);

  const metricField = useMemo(
    () => METRIC_OPTIONS.find(m => m.key === metric)!.field,
    [metric]
  );

  // Build chart-ready data: one merged dataset where each row = { ts, w1, w2, w3, w4, w1_proj, ..., w1_err }
  const chartData = useMemo(() => {
    if (!data) return [];
    // Collect all timestamps from series + projection of all enabled workers
    const tsSet = new Set<number>();
    Object.entries(data.workers).forEach(([wkey, w]) => {
      if (!enabledWorkers[wkey]) return;
      w.series.forEach(p => tsSet.add(p.ts));
      w.projection.forEach(p => tsSet.add(p.ts));
    });
    const sortedTs = Array.from(tsSet).sort((a, b) => a - b);

    return sortedTs.map(ts => {
      const row: Record<string, any> = { ts };
      Object.entries(data.workers).forEach(([wkey, w]) => {
        if (!enabledWorkers[wkey]) return;
        const sp = w.series.find(p => p.ts === ts);
        if (sp && (sp as any)[metricField] !== undefined) {
          row[`${wkey}_actual`] = (sp as any)[metricField];
        }
        const pp = w.projection.find(p => p.ts === ts);
        if (pp && (pp as any)[metricField] !== undefined) {
          row[`${wkey}_proj`] = (pp as any)[metricField];
        }
      });
      return row;
    });
  }, [data, enabledWorkers, metricField]);

  // Error scatter data — separate per worker; use y=110 to sit above the chart area
  const errorScatter = useMemo(() => {
    if (!data) return {} as Record<string, { ts: number; y: number; code: string | null; status: string }[]>;
    const out: Record<string, { ts: number; y: number; code: string | null; status: string }[]> = {};
    let idx = 0;
    Object.entries(data.workers).forEach(([wkey, w]) => {
      if (!enabledWorkers[wkey]) return;
      // Stack the markers at slightly different y so they don't perfectly overlap
      const yLevel = 105 + idx * 3;
      out[wkey] = w.errors.map(e => ({
        ts: e.ts,
        y: yLevel,
        code: e.code,
        status: e.status,
      }));
      idx++;
    });
    return out;
  }, [data, enabledWorkers]);

  return (
    <div data-ai-id="forecast-tab-content" style={{ padding: 12, height: '100%', overflowY: 'auto' }}>
      {/* Header */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        flexWrap: 'wrap', gap: 8, marginBottom: 12,
      }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--tn-text)' }}>
            Usage Forecast — Projektion vs reale Errors
          </h3>
          <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginTop: 2 }}>
            Lineare Extrapolation aus den letzten 60 min. Rote Punkte = tatsächliche Error/503 Events.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          {/* Metric selector */}
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
          {/* Days selector */}
          {DAYS_OPTIONS.map(d => (
            <button key={d.days} onClick={() => setDays(d.days)} style={{
              padding: '3px 8px', borderRadius: 3, fontSize: 10, cursor: 'pointer',
              background: days === d.days ? 'var(--tn-blue)' : 'var(--tn-bg)',
              border: '1px solid var(--tn-border)',
              color: days === d.days ? '#fff' : 'var(--tn-text-muted)',
              fontWeight: 600,
            }}>{d.label}</button>
          ))}
          <button onClick={fetchData} disabled={loading} style={{
            padding: '3px 10px', borderRadius: 3, fontSize: 10, cursor: 'pointer',
            background: 'var(--tn-bg)', border: '1px solid var(--tn-border)',
            color: 'var(--tn-text-muted)', marginLeft: 8,
            opacity: loading ? 0.5 : 1,
          }}>{loading ? '…' : '↻'}</button>
        </div>
      </div>

      {/* Worker toggles + summary */}
      {data && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
          {Object.entries(data.workers).map(([wkey, w]) => {
            const meta = WORKER_META[wkey] || { color: '#888', label: wkey };
            const on = enabledWorkers[wkey];
            const summ = w.projection_summary;
            return (
              <button
                key={wkey}
                onClick={() => setEnabledWorkers(prev => ({ ...prev, [wkey]: !prev[wkey] }))}
                style={{
                  padding: '6px 10px', borderRadius: 4, cursor: 'pointer',
                  background: on ? `${meta.color}22` : 'var(--tn-bg)',
                  border: `1px solid ${on ? meta.color : 'var(--tn-border)'}`,
                  color: on ? meta.color : 'var(--tn-text-muted)',
                  fontSize: 10, fontWeight: 600,
                  display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2,
                  minWidth: 140,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{
                    display: 'inline-block', width: 8, height: 8, borderRadius: 2,
                    background: meta.color,
                  }} />
                  <span>{meta.label}</span>
                </div>
                <div style={{ fontFamily: 'monospace', fontSize: 9, opacity: 0.85 }}>
                  cur {summ.current_pct ?? '—'}% · {summ.rate_per_h >= 0 ? '+' : ''}{summ.rate_per_h?.toFixed(2)}%/h
                </div>
                <div style={{ fontFamily: 'monospace', fontSize: 9, opacity: 0.85 }}>
                  ETA→95: {fmtETA(summ.eta_95_in_min)} · errors {w.errors.length}
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
          {/* Main chart */}
          <div style={{ height: 460, background: 'var(--tn-bg)', border: '1px solid var(--tn-border)', borderRadius: 4, padding: 8 }}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartData} margin={{ top: 12, right: 24, left: 4, bottom: 24 }}>
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
                  domain={[0, 120]}
                  ticks={[0, 25, 50, 75, 95, 100]}
                  tickFormatter={(v) => `${v}%`}
                  stroke="var(--tn-text-muted)"
                  tick={{ fontSize: 10 }}
                />
                <Tooltip
                  contentStyle={{ background: 'var(--tn-surface)', border: '1px solid var(--tn-border)', fontSize: 11 }}
                  labelFormatter={(ts) => fmtTime(ts as number)}
                  formatter={(value: any, name: any) => {
                    if (typeof value !== 'number') return [value, name];
                    return [`${value.toFixed(1)}%`, name];
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 10 }} />
                <ReferenceLine y={95} stroke="var(--tn-red)" strokeDasharray="4 4" label={{ value: '95% rate-limit', position: 'right', fill: 'var(--tn-red)', fontSize: 10 }} />
                <ReferenceLine x={data.now} stroke="var(--tn-text-muted)" strokeDasharray="2 4" label={{ value: 'now', position: 'top', fill: 'var(--tn-text-muted)', fontSize: 9 }} />

                {/* Actual usage lines */}
                {Object.entries(data.workers).map(([wkey]) => {
                  if (!enabledWorkers[wkey]) return null;
                  const meta = WORKER_META[wkey] || { color: '#888', label: wkey };
                  return (
                    <Line
                      key={`${wkey}_actual`}
                      type="monotone"
                      dataKey={`${wkey}_actual`}
                      name={`${meta.label}`}
                      stroke={meta.color}
                      strokeWidth={2}
                      dot={false}
                      isAnimationActive={false}
                      connectNulls
                    />
                  );
                })}

                {/* Projection lines (dashed) */}
                {Object.entries(data.workers).map(([wkey]) => {
                  if (!enabledWorkers[wkey]) return null;
                  const meta = WORKER_META[wkey] || { color: '#888', label: wkey };
                  return (
                    <Line
                      key={`${wkey}_proj`}
                      type="monotone"
                      dataKey={`${wkey}_proj`}
                      name={`${meta.label.split(' ')[0]} proj`}
                      stroke={meta.color}
                      strokeWidth={1.5}
                      strokeDasharray="5 5"
                      dot={false}
                      isAnimationActive={false}
                      connectNulls
                    />
                  );
                })}

                {/* Error markers */}
                {Object.entries(errorScatter).map(([wkey, points]) => {
                  if (!enabledWorkers[wkey]) return null;
                  const meta = WORKER_META[wkey] || { color: '#888', label: wkey };
                  return (
                    <Scatter
                      key={`${wkey}_err`}
                      name={`${meta.label.split(' ')[0]} errors`}
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
            </ResponsiveContainer>
          </div>

          {/* Footer summary */}
          <div style={{
            marginTop: 8, fontSize: 10, color: 'var(--tn-text-muted)',
            display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8,
          }}>
            <div>
              {data.totals.snapshot_count.toLocaleString()} Snapshots ·{' '}
              {data.totals.errors_total.toLocaleString()} Errors total ·{' '}
              Lookback {data.lookback_days}d · Metric {metric}
            </div>
            <div style={{ fontStyle: 'italic' }}>
              Naive lineare Projektion (60min Slope). Wenn rote Punkte die Projection-Linie kreuzen, war die Prognose korrekt.
            </div>
          </div>
        </>
      )}
    </div>
  );
}
