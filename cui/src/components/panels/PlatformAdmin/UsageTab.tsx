import { useEffect, useState, useMemo } from 'react';
import { platformJson, formatNumber, formatEur, estimateEur, ModelKey } from './shared';

// Shape returned by GET /v1/metrics/usage-breakdown on the Hetzner Bridge.
interface AppBreakdown {
  app_id: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  errors: number;
  error_rate: number;
  agents: Record<string, number>;
  users: Record<string, number>;
}

interface UsageBreakdownResponse {
  summary: {
    total_calls: number;
    total_input_tokens: number;
    total_output_tokens: number;
    total_tokens: number;
    total_errors: number;
  };
  apps: AppBreakdown[];
}

const REFRESH_INTERVAL_MS = 30_000;

export default function UsageTab() {
  const [data, setData] = useState<UsageBreakdownResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastFetch, setLastFetch] = useState<number | null>(null);
  const [model, setModel] = useState<ModelKey>('sonnet');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  async function load() {
    try {
      const d = await platformJson<UsageBreakdownResponse>('/v1/metrics/usage-breakdown');
      setData(d);
      setError(null);
      setLastFetch(Date.now());
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const id = setInterval(load, REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  const totalCostEur = useMemo(() => {
    if (!data) return 0;
    return estimateEur(data.summary.total_input_tokens, data.summary.total_output_tokens, model);
  }, [data, model]);

  const sortedApps = useMemo(() => {
    if (!data) return [];
    return [...data.apps].sort((a, b) => b.total_tokens - a.total_tokens);
  }, [data]);

  function toggleApp(appId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(appId)) next.delete(appId); else next.add(appId);
      return next;
    });
  }

  if (loading && !data) {
    return <div data-ai-id="platform-usage-loading" style={style.empty}>Lade Bridge-Daten …</div>;
  }
  if (error && !data) {
    return (
      <div data-ai-id="platform-usage-error" style={style.errorBox}>
        <strong>Bridge unreachable:</strong>
        <pre style={{ margin: '8px 0 0', fontSize: 11 }}>{error}</pre>
      </div>
    );
  }
  if (!data) return null;

  return (
    <div data-ai-id="platform-usage-tab" style={style.root}>
      {/* Header — Cross-App Aggregates */}
      <div style={style.headerGrid}>
        <Stat label="Total Calls" value={formatNumber(data.summary.total_calls)} />
        <Stat label="Input Tokens" value={formatNumber(data.summary.total_input_tokens)} />
        <Stat label="Output Tokens" value={formatNumber(data.summary.total_output_tokens)} />
        <Stat label="Errors" value={String(data.summary.total_errors)} accent={data.summary.total_errors > 0 ? 'red' : 'green'} />
        <Stat label="Estimated Cost" value={formatEur(totalCostEur)} accent="blue" />
      </div>

      {/* Controls */}
      <div style={style.controls}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={style.controlLabel}>Cost-Schätzung mit Model:</span>
          {(['sonnet', 'opus', 'haiku'] as ModelKey[]).map((m) => (
            <button
              key={m}
              data-ai-id={`platform-usage-model-${m}`}
              onClick={() => setModel(m)}
              style={{
                ...style.modelBtn,
                background: model === m ? 'var(--tn-blue)' : 'transparent',
                color: model === m ? '#fff' : 'var(--tn-text-muted)',
              }}
            >
              {m}
            </button>
          ))}
        </div>
        <div style={style.controlLabel}>
          {lastFetch ? `Aktualisiert: ${new Date(lastFetch).toLocaleTimeString()}` : '—'}
          <button data-ai-id="platform-usage-refresh" onClick={load} style={style.refreshBtn}>Aktualisieren</button>
        </div>
      </div>

      {/* Per-App breakdown */}
      <div style={style.tableWrap}>
        <table style={style.table}>
          <thead>
            <tr style={style.theadRow}>
              <th style={{ ...style.th, width: 24 }}></th>
              <th style={style.th}>App</th>
              <th style={style.thNum}>Calls</th>
              <th style={style.thNum}>Input Tokens</th>
              <th style={style.thNum}>Output Tokens</th>
              <th style={style.thNum}>Errors</th>
              <th style={style.thNum}>Error %</th>
              <th style={style.thNum}>Geschätzte Kosten</th>
            </tr>
          </thead>
          <tbody>
            {sortedApps.map((app) => {
              const cost = estimateEur(app.input_tokens, app.output_tokens, model);
              const isOpen = expanded.has(app.app_id);
              return (
                <>
                  <tr
                    key={app.app_id}
                    data-ai-id={`platform-usage-row-${app.app_id}`}
                    onClick={() => toggleApp(app.app_id)}
                    style={{ ...style.tr, cursor: 'pointer' }}
                  >
                    <td style={style.td}>{isOpen ? '▼' : '▶'}</td>
                    <td style={{ ...style.td, fontWeight: 600 }}>{app.app_id}</td>
                    <td style={style.tdNum}>{formatNumber(app.calls)}</td>
                    <td style={style.tdNum}>{formatNumber(app.input_tokens)}</td>
                    <td style={style.tdNum}>{formatNumber(app.output_tokens)}</td>
                    <td style={{ ...style.tdNum, color: app.errors > 0 ? 'var(--tn-red)' : 'var(--tn-text)' }}>{app.errors}</td>
                    <td style={{ ...style.tdNum, color: app.error_rate > 5 ? 'var(--tn-red)' : 'var(--tn-text-muted)' }}>
                      {app.error_rate.toFixed(1)}%
                    </td>
                    <td style={{ ...style.tdNum, color: 'var(--tn-blue)', fontWeight: 600 }}>{formatEur(cost)}</td>
                  </tr>
                  {isOpen && (
                    <tr key={`${app.app_id}-expanded`}>
                      <td colSpan={8} style={style.expanded}>
                        <DrillDown app={app} />
                      </td>
                    </tr>
                  )}
                </>
              );
            })}
          </tbody>
        </table>
      </div>

      <div style={style.footnote}>
        Quelle: Hetzner-Bridge GET /v1/metrics/usage-breakdown. Aktualisiert alle 30 s. Kosten sind eine Schätzung
        auf Basis des oben gewählten Models — der echte Mix wird tracked sobald Apps via PlatformClient deducten.
      </div>
    </div>
  );
}

function DrillDown({ app }: { app: AppBreakdown }) {
  const agents = Object.entries(app.agents).sort((a, b) => b[1] - a[1]).slice(0, 20);
  const users = Object.entries(app.users).sort((a, b) => b[1] - a[1]).slice(0, 20);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, padding: '8px 16px' }}>
      <div>
        <div style={style.drillHeader}>Top Agents</div>
        {agents.length === 0 && <div style={style.drillEmpty}>—</div>}
        {agents.map(([name, calls]) => (
          <div key={name} style={style.drillRow}>
            <span style={style.drillName}>{name}</span>
            <span style={style.drillCount}>{formatNumber(calls)}</span>
          </div>
        ))}
      </div>
      <div>
        <div style={style.drillHeader}>Top Users</div>
        {users.length === 0 && <div style={style.drillEmpty}>—</div>}
        {users.map(([name, calls]) => (
          <div key={name} style={style.drillRow}>
            <span style={style.drillName}>{name}</span>
            <span style={style.drillCount}>{formatNumber(calls)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: 'red' | 'green' | 'blue' }) {
  const color =
    accent === 'red' ? 'var(--tn-red)' :
    accent === 'green' ? 'var(--tn-green)' :
    accent === 'blue' ? 'var(--tn-blue)' :
    'var(--tn-text)';
  return (
    <div style={style.stat}>
      <div style={style.statLabel}>{label}</div>
      <div style={{ ...style.statValue, color }}>{value}</div>
    </div>
  );
}

const style: Record<string, React.CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' },
  empty: { padding: 16, color: 'var(--tn-text-muted)', fontSize: 12 },
  errorBox: { padding: 16, background: 'rgba(247,118,142,0.12)', border: '1px solid var(--tn-red)', borderRadius: 4, margin: 12, color: 'var(--tn-red)', fontSize: 12 },
  headerGrid: { display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8, padding: 12, borderBottom: '1px solid var(--tn-border)', flexShrink: 0 },
  stat: { background: 'var(--tn-bg-elev)', border: '1px solid var(--tn-border)', borderRadius: 4, padding: '10px 12px' },
  statLabel: { fontSize: 10, color: 'var(--tn-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 },
  statValue: { fontSize: 22, fontWeight: 700, fontFamily: 'monospace' },
  controls: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid var(--tn-border)', flexShrink: 0 },
  controlLabel: { fontSize: 11, color: 'var(--tn-text-muted)' },
  modelBtn: { padding: '3px 10px', borderRadius: 3, fontSize: 11, border: '1px solid var(--tn-border)', cursor: 'pointer' },
  refreshBtn: { marginLeft: 10, padding: '3px 10px', borderRadius: 3, fontSize: 10, border: '1px solid var(--tn-border)', background: 'transparent', color: 'var(--tn-text)', cursor: 'pointer' },
  tableWrap: { flex: 1, overflow: 'auto', minHeight: 0 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 11 },
  theadRow: { position: 'sticky', top: 0, background: 'var(--tn-bg-elev)', zIndex: 1 },
  th: { padding: '8px 10px', borderBottom: '1px solid var(--tn-border)', textAlign: 'left', fontSize: 10, color: 'var(--tn-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' },
  thNum: { padding: '8px 10px', borderBottom: '1px solid var(--tn-border)', textAlign: 'right', fontSize: 10, color: 'var(--tn-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' },
  tr: { borderBottom: '1px solid var(--tn-border)' },
  td: { padding: '8px 10px', color: 'var(--tn-text)' },
  tdNum: { padding: '8px 10px', textAlign: 'right', fontFamily: 'monospace', color: 'var(--tn-text)' },
  expanded: { padding: 0, background: 'rgba(0,0,0,0.15)', borderBottom: '1px solid var(--tn-border)' },
  drillHeader: { fontSize: 10, color: 'var(--tn-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 },
  drillEmpty: { fontSize: 11, color: 'var(--tn-text-muted)' },
  drillRow: { display: 'flex', justifyContent: 'space-between', padding: '2px 0', fontSize: 11 },
  drillName: { color: 'var(--tn-text)', fontFamily: 'monospace' },
  drillCount: { color: 'var(--tn-text-muted)', fontFamily: 'monospace' },
  footnote: { padding: '6px 12px', fontSize: 10, color: 'var(--tn-text-muted)', borderTop: '1px solid var(--tn-border)', flexShrink: 0 },
};
