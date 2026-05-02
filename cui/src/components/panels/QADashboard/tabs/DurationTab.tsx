import React, { useState, useEffect } from 'react';
import { validateApiResponse } from '../../../../lib/validateApiResponse';

const APP_NAMES: Record<string, string> = {
  'werking-report': 'WerkING Report',
  'engelmann': 'Engelmann AI Hub',
  'platform': 'Platform',
  'werking-energy': 'WerkING Energy',
  'werking-safety': 'WerkING Safety',
  'werking-noise': 'WerkING Noise',
  'acro-community': 'Acro Community',
};

const STATUS_ORDER = ['PASS', 'PARTIAL', 'FAIL', 'NOT_TESTED', 'PENDING'];

const STATUS_COLORS: Record<string, string> = {
  PASS: 'var(--tn-green)',
  PARTIAL: 'var(--tn-orange)',
  FAIL: 'var(--tn-red)',
  NOT_TESTED: 'var(--tn-text-muted)',
  PENDING: 'var(--tn-text-muted)',
};

interface DurationStats {
  count: number;
  avg: number;
  median: number;
  p90: number;
  p99: number;
  min: number;
  max: number;
}

interface AppStats extends DurationStats {
  app: string;
}

interface HistogramBucket { bucket: string; count: number }

interface GlobalResponse {
  daysBack: number;
  apps: AppStats[];
  statuses: Record<string, DurationStats>;
  global: DurationStats;
  histogram: HistogramBucket[];
  timestamp: string;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '–';
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds - m * 60);
  if (m < 60) return s === 0 ? `${m}m` : `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  const mm = m - h * 60;
  return mm === 0 ? `${h}h` : `${h}h ${mm}m`;
}

export default function DurationTab() {
  const [data, setData] = useState<GlobalResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [daysBack, setDaysBack] = useState(7);

  useEffect(() => {
    setLoading(true);
    setError(null);

    fetch(`/api/qa/duration-stats?days=${daysBack}`, { signal: AbortSignal.timeout(15000) })
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(raw => {
        const d = validateApiResponse<GlobalResponse>(raw, '/api/qa/duration-stats', {
          daysBack: 'number',
          apps: 'array',
          statuses: 'object',
          global: 'object',
          histogram: 'array',
        });
        setData(d);
        setLoading(false);
      })
      .catch(err => {
        setData(null);
        setError(err.message);
        setLoading(false);
      });
  }, [daysBack]);

  return (
    <div data-ai-id="duration-tab" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{
        padding: 12, background: 'var(--tn-bg-dark)',
        borderBottom: '1px solid var(--tn-border)',
        display: 'flex', gap: 6, alignItems: 'center',
      }}>
        <span style={{ fontSize: 11, color: 'var(--tn-text-muted)', marginRight: 4 }}>Window:</span>
        {[1, 7, 30].map(n => (
          <button
            key={n}
            data-ai-id={`duration-tab-window-${n}`}
            onClick={() => setDaysBack(n)}
            style={{
              background: daysBack === n ? 'var(--tn-blue)' : 'transparent',
              border: '1px solid var(--tn-border)', borderRadius: 4,
              padding: '4px 10px', fontSize: 11,
              color: daysBack === n ? '#fff' : 'var(--tn-text-muted)',
              cursor: 'pointer', fontWeight: 600,
            }}
          >
            {n === 1 ? '24h' : `${n}d`}
          </button>
        ))}
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
        {loading ? (
          <div style={{ textAlign: 'center', color: 'var(--tn-text-muted)', padding: 40 }}>Loading…</div>
        ) : error ? (
          <div style={{ textAlign: 'center', color: 'var(--tn-red)', padding: 40 }}>Error: {error}</div>
        ) : !data || data.global.count === 0 ? (
          <div style={{ textAlign: 'center', color: 'var(--tn-text-muted)', padding: 40 }}>
            No test runs in the last {data?.daysBack ?? daysBack} day(s).
          </div>
        ) : (
          <>
            <GlobalSummary data={data} />
            <PerAppTable apps={data.apps} />
            <PerStatusCards statuses={data.statuses} />
            <HistogramView histogram={data.histogram} total={data.global.count} />
          </>
        )}
      </div>
    </div>
  );
}

function GlobalSummary({ data }: { data: GlobalResponse }) {
  return (
    <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
      <Card label="Test Runs" value={data.global.count.toString()} sub={`last ${data.daysBack} day(s)`} />
      <Card label="Avg Duration" value={formatDuration(data.global.avg)} sub={`median ${formatDuration(data.global.median)}`} />
      <Card label="p90 / p99" value={`${formatDuration(data.global.p90)} / ${formatDuration(data.global.p99)}`} sub={`max ${formatDuration(data.global.max)}`} />
    </div>
  );
}

function Card({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div style={{
      flex: 1, background: 'var(--tn-bg-dark)', borderRadius: 8, padding: 14,
      border: '1px solid var(--tn-border)',
    }}>
      <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', textTransform: 'uppercase', fontWeight: 700, letterSpacing: 1 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--tn-text)', marginTop: 4 }}>{value}</div>
      <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginTop: 4 }}>{sub}</div>
    </div>
  );
}

function PerAppTable({ apps }: { apps: AppStats[] }) {
  if (apps.length === 0) return null;
  return (
    <div data-ai-id="duration-tab-app-table" style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--tn-text)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
        Per App
      </div>
      <div style={{
        background: 'var(--tn-bg-dark)', border: '1px solid var(--tn-border)', borderRadius: 8,
        overflow: 'hidden',
      }}>
        <div style={{
          display: 'grid', gridTemplateColumns: '1.6fr 0.6fr repeat(4, 0.8fr)',
          padding: '8px 12px', fontSize: 10, fontWeight: 700,
          color: 'var(--tn-text-muted)', textTransform: 'uppercase', letterSpacing: 1,
          borderBottom: '1px solid var(--tn-border)',
        }}>
          <div>App</div>
          <div style={{ textAlign: 'right' }}>Tests</div>
          <div style={{ textAlign: 'right' }}>Avg</div>
          <div style={{ textAlign: 'right' }}>Median</div>
          <div style={{ textAlign: 'right' }}>p90</div>
          <div style={{ textAlign: 'right' }}>Max</div>
        </div>
        {apps.map(a => (
          <div
            key={a.app}
            data-ai-id={`duration-tab-app-row-${a.app}`}
            style={{
              display: 'grid', gridTemplateColumns: '1.6fr 0.6fr repeat(4, 0.8fr)',
              padding: '8px 12px', fontSize: 12,
              borderTop: '1px solid rgba(255,255,255,0.04)',
              alignItems: 'center',
            }}
          >
            <div style={{ color: 'var(--tn-text)' }}>{APP_NAMES[a.app] ?? a.app}</div>
            <div style={{ textAlign: 'right', color: 'var(--tn-text)', fontFamily: 'monospace' }}>{a.count}</div>
            <div style={{ textAlign: 'right', color: 'var(--tn-text-muted)', fontFamily: 'monospace' }}>{formatDuration(a.avg)}</div>
            <div style={{ textAlign: 'right', color: 'var(--tn-text-muted)', fontFamily: 'monospace' }}>{formatDuration(a.median)}</div>
            <div style={{ textAlign: 'right', color: 'var(--tn-text-muted)', fontFamily: 'monospace' }}>{formatDuration(a.p90)}</div>
            <div style={{ textAlign: 'right', color: 'var(--tn-text-muted)', fontFamily: 'monospace' }}>{formatDuration(a.max)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function PerStatusCards({ statuses }: { statuses: Record<string, DurationStats> }) {
  const entries = STATUS_ORDER
    .filter(s => statuses[s] && statuses[s].count > 0)
    .map(s => [s, statuses[s]] as const);
  if (entries.length === 0) return null;
  return (
    <div data-ai-id="duration-tab-status-cards" style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--tn-text)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
        Per Status
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
        {entries.map(([status, st]) => (
          <div
            key={status}
            data-ai-id={`duration-tab-status-${status}`}
            style={{
              background: 'var(--tn-bg-dark)',
              border: `1px solid ${STATUS_COLORS[status] ?? 'var(--tn-border)'}`,
              borderRadius: 8, padding: 12,
            }}
          >
            <div style={{ fontSize: 10, color: STATUS_COLORS[status] ?? 'var(--tn-text)', textTransform: 'uppercase', fontWeight: 700, letterSpacing: 1 }}>{status}</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--tn-text)', marginTop: 4, fontFamily: 'monospace' }}>
              {formatDuration(st.avg)}
            </div>
            <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginTop: 4 }}>
              {st.count} tests · median {formatDuration(st.median)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function HistogramView({ histogram, total }: { histogram: HistogramBucket[]; total: number }) {
  const max = histogram.reduce((m, b) => Math.max(m, b.count), 0);
  if (max === 0) return null;
  return (
    <div data-ai-id="duration-tab-histogram" style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--tn-text)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
        Distribution
      </div>
      <div style={{
        background: 'var(--tn-bg-dark)', border: '1px solid var(--tn-border)', borderRadius: 8,
        padding: 12,
      }}>
        {histogram.map(b => {
          const pct = total > 0 ? (b.count / total) * 100 : 0;
          const barPct = max > 0 ? (b.count / max) * 100 : 0;
          return (
            <div key={b.bucket} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '3px 0' }}>
              <div style={{ width: 70, fontSize: 11, color: 'var(--tn-text-muted)', fontFamily: 'monospace' }}>{b.bucket}</div>
              <div style={{ flex: 1, height: 12, background: 'rgba(255,255,255,0.04)', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{
                  width: `${barPct}%`, height: '100%',
                  background: 'var(--tn-blue)', borderRadius: 3, transition: 'width 0.3s',
                }} />
              </div>
              <div style={{ width: 80, fontSize: 11, color: 'var(--tn-text)', fontFamily: 'monospace', textAlign: 'right' }}>
                {b.count} ({pct.toFixed(1)}%)
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
