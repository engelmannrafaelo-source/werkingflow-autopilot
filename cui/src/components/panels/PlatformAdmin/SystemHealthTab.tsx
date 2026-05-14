import { useEffect, useState } from 'react';
import { platformJson, formatNumber } from './shared';

interface AppProbe {
  name: string;
  url: string;
  status: 'healthy' | 'unhealthy' | 'timeout' | 'unreachable';
  httpStatus: number | null;
  latencyMs: number | null;
  error?: string;
}

interface DbSnap {
  status: string;
  pgVersion: string;
  dbSizeBytes: number;
  counts: Record<string, number>;
  migrations: Array<{ filename: string; appliedAt: string }>;
}

interface Overview {
  generatedAt: string;
  summary: 'healthy' | 'degraded';
  bridge: DbSnap;
  apps: AppProbe[];
}

const STATUS_COLOR: Record<string, string> = {
  healthy: 'var(--tn-green)', unhealthy: 'var(--tn-red)',
  timeout: 'var(--tn-orange)', unreachable: 'var(--tn-red)',
  degraded: 'var(--tn-orange)',
};

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export default function SystemHealthTab() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const d = await platformJson<Overview>('/v1/system/health');
      setData(d); setError(null);
    } catch (e: any) { setError(e?.message ?? String(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); const id = setInterval(load, 30_000); return () => clearInterval(id); }, []);

  if (error && !data) return <div style={S.err}><strong>Bridge unreachable:</strong><pre style={{ fontSize: 11 }}>{error}</pre></div>;
  if (!data) return <div style={S.empty}>Lade …</div>;

  return (
    <div style={S.root}>
      <div style={S.bar}>
        <span style={{ ...S.summary, color: STATUS_COLOR[data.summary] }}>
          ● {data.summary.toUpperCase()}
        </span>
        <span style={S.gen}>generated {new Date(data.generatedAt).toLocaleTimeString()}</span>
        <div style={{ flex: 1 }} />
        <button onClick={load} style={S.btn} disabled={loading}>{loading ? '...' : 'Refresh'}</button>
      </div>

      <div style={S.body}>
        <section style={S.section}>
          <h3 style={S.h3}>Bridge / Postgres</h3>
          <div style={S.grid}>
            <Stat label="Postgres" value={data.bridge.pgVersion} color="var(--tn-green)" />
            <Stat label="DB Size" value={fmtBytes(data.bridge.dbSizeBytes)} />
            <Stat label="Migrations" value={String(data.bridge.migrations.length)} />
            <Stat label="Users" value={formatNumber(data.bridge.counts.users)} />
            <Stat label="Tenants" value={formatNumber(data.bridge.counts.tenants)} />
            <Stat label="Subscriptions" value={formatNumber(data.bridge.counts.subscriptions)} />
            <Stat label="Activities" value={formatNumber(data.bridge.counts.activities)} />
            <Stat label="Invoices" value={formatNumber(data.bridge.counts.invoices)} />
            <Stat label="Feedback" value={formatNumber(data.bridge.counts.feedback)} />
          </div>
        </section>

        <section style={S.section}>
          <h3 style={S.h3}>Apps</h3>
          <table style={S.tbl}>
            <thead><tr><th style={S.th}>App</th><th style={S.th}>Status</th><th style={S.thNum}>HTTP</th><th style={S.thNum}>Latency</th><th style={S.th}>URL</th></tr></thead>
            <tbody>
              {data.apps.map((a) => (
                <tr key={a.name}>
                  <td style={S.td}><strong>{a.name}</strong></td>
                  <td style={S.td}>
                    <span style={{ ...S.dot, background: STATUS_COLOR[a.status] }} />
                    <span style={{ color: STATUS_COLOR[a.status] }}>{a.status}</span>
                    {a.error && <div style={{ fontSize: 10, color: 'var(--tn-text-muted)' }}>{a.error}</div>}
                  </td>
                  <td style={S.tdNum}>{a.httpStatus ?? '—'}</td>
                  <td style={S.tdNum}>{a.latencyMs != null ? `${a.latencyMs} ms` : '—'}</td>
                  <td style={{ ...S.td, fontSize: 10, color: 'var(--tn-text-muted)', fontFamily: 'monospace' }}>{a.url}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section style={S.section}>
          <h3 style={S.h3}>Migrations Trail</h3>
          <table style={S.tbl}>
            <thead><tr><th style={S.th}>Filename</th><th style={S.th}>Applied</th></tr></thead>
            <tbody>
              {data.bridge.migrations.map((m) => (
                <tr key={m.filename}>
                  <td style={{ ...S.td, fontFamily: 'monospace' }}>{m.filename}</td>
                  <td style={{ ...S.td, color: 'var(--tn-text-muted)', fontSize: 11 }}>{new Date(m.appliedAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
      <div style={S.foot}>Quelle: GET /v1/system/health · 30s polling · 5 Apps probed parallel.</div>
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={S.stat}>
      <div style={S.statLabel}>{label}</div>
      <div style={{ ...S.statValue, color: color ?? 'var(--tn-text)' }}>{value}</div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' },
  err: { padding: 16, background: 'rgba(247,118,142,0.12)', border: '1px solid var(--tn-red)', color: 'var(--tn-red)', margin: 12, borderRadius: 4 },
  empty: { padding: 16, color: 'var(--tn-text-muted)' },
  bar: { display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px', borderBottom: '1px solid var(--tn-border)' },
  summary: { fontSize: 13, fontWeight: 700, letterSpacing: '0.05em' },
  gen: { fontSize: 11, color: 'var(--tn-text-muted)' },
  btn: { padding: '4px 12px', fontSize: 11, background: 'transparent', border: '1px solid var(--tn-border)', color: 'var(--tn-text)', borderRadius: 3, cursor: 'pointer' },
  body: { flex: 1, overflow: 'auto', padding: 16 },
  section: { marginBottom: 24 },
  h3: { fontSize: 11, color: 'var(--tn-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8, fontWeight: 600 },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 },
  stat: { background: 'var(--tn-bg-elev)', border: '1px solid var(--tn-border)', borderRadius: 4, padding: '8px 10px' },
  statLabel: { fontSize: 9, color: 'var(--tn-text-muted)', textTransform: 'uppercase', marginBottom: 2 },
  statValue: { fontSize: 16, fontWeight: 700, fontFamily: 'monospace' },
  tbl: { width: '100%', borderCollapse: 'collapse', fontSize: 11 },
  th: { padding: '6px 8px', textAlign: 'left', fontSize: 10, color: 'var(--tn-text-muted)', textTransform: 'uppercase', borderBottom: '1px solid var(--tn-border)' },
  thNum: { padding: '6px 8px', textAlign: 'right', fontSize: 10, color: 'var(--tn-text-muted)', textTransform: 'uppercase', borderBottom: '1px solid var(--tn-border)' },
  td: { padding: '6px 8px', borderBottom: '1px solid var(--tn-border)' },
  tdNum: { padding: '6px 8px', textAlign: 'right', fontFamily: 'monospace', borderBottom: '1px solid var(--tn-border)' },
  dot: { display: 'inline-block', width: 8, height: 8, borderRadius: 4, marginRight: 6 },
  foot: { padding: '6px 12px', fontSize: 10, color: 'var(--tn-text-muted)', borderTop: '1px solid var(--tn-border)' },
};
