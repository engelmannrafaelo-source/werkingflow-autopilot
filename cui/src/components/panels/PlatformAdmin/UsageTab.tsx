import { useEffect, useState, useMemo } from 'react';
import { platformJson, formatNumber, formatEur, estimateEur, ModelKey } from './shared';

// Legacy per-app endpoint shape (kept — drives the "Apps" view).
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

// New per-user/tenant/model endpoint shape from /v1/metrics/usage.
type GroupKey = 'user' | 'tenant' | 'app' | 'model';

interface MetricsRow {
  key: string | null;
  label: string;
  calls: number;
  errors: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostEur: number;
  byApp: Record<string, number>;
  byModel: Record<string, { calls: number; totalTokens: number; estimatedCostEur: number }>;
}

interface MetricsResponse {
  groupBy: GroupKey;
  since: string;
  until: string;
  rows: MetricsRow[];
  totals: {
    calls: number;
    errors: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    estimatedCostEur: number;
  };
  pricing: {
    modelsKnown: string[];
    modelsUnknown: Record<string, number>;
    usdToEurRate: number;
    rates: Record<string, { in: number; out: number }>;
  };
}

const REFRESH_INTERVAL_MS = 30_000;
const VIEWS: { key: 'apps' | GroupKey; label: string }[] = [
  { key: 'apps',    label: 'Per App'    },
  { key: 'user',    label: 'Per User'   },
  { key: 'tenant',  label: 'Per Tenant' },
  { key: 'model',   label: 'Per Model'  },
];

export default function UsageTab() {
  const [view, setView] = useState<'apps' | GroupKey>('apps');
  const [appsData, setAppsData] = useState<UsageBreakdownResponse | null>(null);
  const [metricsData, setMetricsData] = useState<MetricsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastFetch, setLastFetch] = useState<number | null>(null);
  const [model, setModel] = useState<ModelKey>('sonnet');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  async function loadAll() {
    try {
      if (view === 'apps') {
        const d = await platformJson<UsageBreakdownResponse>('/v1/metrics/usage-breakdown');
        setAppsData(d);
      } else {
        const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
        const d = await platformJson<MetricsResponse>(
          `/v1/metrics/usage?groupBy=${view}&since=${encodeURIComponent(since)}`,
        );
        setMetricsData(d);
      }
      setError(null);
      setLastFetch(Date.now());
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setLoading(true);
    loadAll();
    const id = setInterval(loadAll, REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  if (loading && !appsData && !metricsData) {
    return <div data-ai-id="platform-usage-loading" style={style.empty}>Lade Bridge-Daten …</div>;
  }
  if (error && !appsData && !metricsData) {
    return (
      <div data-ai-id="platform-usage-error" style={style.errorBox}>
        <strong>Bridge unreachable:</strong>
        <pre style={{ margin: '8px 0 0', fontSize: 11 }}>{error}</pre>
      </div>
    );
  }

  return (
    <div data-ai-id="platform-usage-tab" style={style.root}>
      {/* View selector */}
      <div style={style.viewBar}>
        <span style={style.viewLabel}>Sicht:</span>
        {VIEWS.map((v) => (
          <button
            key={v.key}
            data-ai-id={`platform-usage-view-${v.key}`}
            onClick={() => setView(v.key)}
            style={{
              ...style.viewBtn,
              background: view === v.key ? 'var(--tn-blue)' : 'transparent',
              color: view === v.key ? '#fff' : 'var(--tn-text)',
            }}
          >
            {v.label}
          </button>
        ))}
        <div style={style.viewSpacer} />
        <span style={style.controlLabel}>
          {lastFetch ? `Aktualisiert: ${new Date(lastFetch).toLocaleTimeString()}` : '—'}
        </span>
        <button data-ai-id="platform-usage-refresh" onClick={loadAll} style={style.refreshBtn}>↻</button>
      </div>

      {view === 'apps'
        ? <AppsView data={appsData} model={model} setModel={setModel} expanded={expanded} setExpanded={setExpanded} />
        : <MetricsView data={metricsData} view={view} expanded={expanded} setExpanded={setExpanded} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-App view (legacy /v1/metrics/usage-breakdown)
// ---------------------------------------------------------------------------

function AppsView({
  data, model, setModel, expanded, setExpanded,
}: {
  data: UsageBreakdownResponse | null;
  model: ModelKey;
  setModel: (m: ModelKey) => void;
  expanded: Set<string>;
  setExpanded: React.Dispatch<React.SetStateAction<Set<string>>>;
}) {
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

  if (!data) return <div style={style.empty}>Keine Daten</div>;

  return (
    <>
      <div style={style.headerGrid}>
        <Stat label="Total Calls" value={formatNumber(data.summary.total_calls)} />
        <Stat label="Input Tokens" value={formatNumber(data.summary.total_input_tokens)} />
        <Stat label="Output Tokens" value={formatNumber(data.summary.total_output_tokens)} />
        <Stat label="Errors" value={String(data.summary.total_errors)} accent={data.summary.total_errors > 0 ? 'red' : 'green'} />
        <Stat label="Geschätzte Kosten" value={formatEur(totalCostEur)} accent="blue" />
      </div>

      <div style={style.controls}>
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

      <div style={style.tableWrap}>
        <table style={style.table}>
          <thead>
            <tr style={style.theadRow}>
              <th style={{ ...style.th, width: 24 }}></th>
              <th style={style.th}>App</th>
              <th style={style.thNum}>Calls</th>
              <th style={style.thNum}>Input</th>
              <th style={style.thNum}>Output</th>
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
                  <tr key={app.app_id} data-ai-id={`platform-usage-row-${app.app_id}`} onClick={() => toggleApp(app.app_id)} style={{ ...style.tr, cursor: 'pointer' }}>
                    <td style={style.td}>{isOpen ? '▼' : '▶'}</td>
                    <td style={{ ...style.td, fontWeight: 600 }}>{app.app_id}</td>
                    <td style={style.tdNum}>{formatNumber(app.calls)}</td>
                    <td style={style.tdNum}>{formatNumber(app.input_tokens)}</td>
                    <td style={style.tdNum}>{formatNumber(app.output_tokens)}</td>
                    <td style={{ ...style.tdNum, color: app.errors > 0 ? 'var(--tn-red)' : 'var(--tn-text)' }}>{app.errors}</td>
                    <td style={{ ...style.tdNum, color: app.error_rate > 5 ? 'var(--tn-red)' : 'var(--tn-text-muted)' }}>{app.error_rate.toFixed(1)}%</td>
                    <td style={{ ...style.tdNum, color: 'var(--tn-blue)', fontWeight: 600 }}>{formatEur(cost)}</td>
                  </tr>
                  {isOpen && (
                    <tr key={`${app.app_id}-expanded`}>
                      <td colSpan={8} style={style.expanded}>
                        <AppDrillDown app={app} />
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
        Quelle: GET /v1/metrics/usage-breakdown — Cost-Schätzung mit UI-Model. Für reale EUR-Kosten je Model siehe andere Sichten.
      </div>
    </>
  );
}

function AppDrillDown({ app }: { app: AppBreakdown }) {
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

// ---------------------------------------------------------------------------
// Per-User / Tenant / Model view (new /v1/metrics/usage endpoint)
// ---------------------------------------------------------------------------

function MetricsView({
  data, view, expanded, setExpanded,
}: {
  data: MetricsResponse | null;
  view: GroupKey;
  expanded: Set<string>;
  setExpanded: React.Dispatch<React.SetStateAction<Set<string>>>;
}) {
  if (!data) return <div style={style.empty}>Keine Daten</div>;

  function toggleRow(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  const totals = data.totals;
  const errorPct = totals.calls > 0 ? (totals.errors / totals.calls) * 100 : 0;
  const labelKey = view === 'user' ? 'User' : view === 'tenant' ? 'Tenant' : 'Model';

  return (
    <>
      <div style={style.headerGrid}>
        <Stat label="Total Calls" value={formatNumber(totals.calls)} />
        <Stat label="Input Tokens" value={formatNumber(totals.promptTokens)} />
        <Stat label="Output Tokens" value={formatNumber(totals.completionTokens)} />
        <Stat label="Errors" value={`${totals.errors} (${errorPct.toFixed(1)}%)`} accent={totals.errors > 0 ? 'red' : 'green'} />
        <Stat label="Kosten (real, EUR)" value={formatEur(totals.estimatedCostEur)} accent="blue" />
      </div>

      <div style={style.controls}>
        <span style={style.controlLabel}>Range:</span>
        <span style={style.controlLabel}>{new Date(data.since).toLocaleDateString()} — {new Date(data.until).toLocaleDateString()}</span>
        <div style={{ flex: 1 }} />
        <span style={style.controlLabel}>USD→EUR: {data.pricing.usdToEurRate.toFixed(3)}</span>
        {Object.keys(data.pricing.modelsUnknown).length > 0 && (
          <span style={{ ...style.controlLabel, color: 'var(--tn-yellow, #d97706)' }}>
            ⚠ unbekannte Models: {Object.keys(data.pricing.modelsUnknown).join(', ')}
          </span>
        )}
      </div>

      <div style={style.tableWrap}>
        <table style={style.table}>
          <thead>
            <tr style={style.theadRow}>
              <th style={{ ...style.th, width: 24 }}></th>
              <th style={style.th}>{labelKey}</th>
              <th style={style.thNum}>Calls</th>
              <th style={style.thNum}>Input</th>
              <th style={style.thNum}>Output</th>
              <th style={style.thNum}>Total</th>
              <th style={style.thNum}>Errors</th>
              <th style={style.thNum}>Kosten (EUR)</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => {
              const rowKey = row.key ?? '__unattributed__';
              const isOpen = expanded.has(rowKey);
              return (
                <>
                  <tr
                    key={rowKey}
                    data-ai-id={`platform-usage-row-${view}-${rowKey}`}
                    onClick={() => toggleRow(rowKey)}
                    style={{ ...style.tr, cursor: 'pointer' }}
                  >
                    <td style={style.td}>{isOpen ? '▼' : '▶'}</td>
                    <td style={{ ...style.td, fontWeight: 600 }}>{row.label}</td>
                    <td style={style.tdNum}>{formatNumber(row.calls)}</td>
                    <td style={style.tdNum}>{formatNumber(row.promptTokens)}</td>
                    <td style={style.tdNum}>{formatNumber(row.completionTokens)}</td>
                    <td style={style.tdNum}>{formatNumber(row.totalTokens)}</td>
                    <td style={{ ...style.tdNum, color: row.errors > 0 ? 'var(--tn-red)' : 'var(--tn-text)' }}>{row.errors}</td>
                    <td style={{ ...style.tdNum, color: 'var(--tn-blue)', fontWeight: 600 }}>{formatEur(row.estimatedCostEur)}</td>
                  </tr>
                  {isOpen && (
                    <tr key={`${rowKey}-expanded`}>
                      <td colSpan={8} style={style.expanded}>
                        <MetricsDrillDown row={row} view={view} />
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
        Quelle: GET /v1/metrics/usage?groupBy={view} — EUR-Kosten je Call mit echtem Model-Mix berechnet (USD→EUR {data.pricing.usdToEurRate.toFixed(3)}). Klick auf Zeile für Drill-Down.
      </div>
    </>
  );
}

function MetricsDrillDown({ row, view }: { row: MetricsRow; view: GroupKey }) {
  const byApp = Object.entries(row.byApp).sort((a, b) => b[1] - a[1]);
  const byModel = Object.entries(row.byModel).sort((a, b) => b[1].estimatedCostEur - a[1].estimatedCostEur);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: view === 'app' ? '1fr' : '1fr 1fr', gap: 16, padding: '8px 16px' }}>
      {view !== 'app' && (
        <div>
          <div style={style.drillHeader}>Calls je App</div>
          {byApp.length === 0 && <div style={style.drillEmpty}>—</div>}
          {byApp.map(([appId, calls]) => (
            <div key={appId} style={style.drillRow}>
              <span style={style.drillName}>{appId}</span>
              <span style={style.drillCount}>{formatNumber(calls)}</span>
            </div>
          ))}
        </div>
      )}
      <div>
        <div style={style.drillHeader}>Calls + Kosten je Model</div>
        {byModel.length === 0 && <div style={style.drillEmpty}>—</div>}
        {byModel.map(([modelId, m]) => (
          <div key={modelId} style={style.drillRow}>
            <span style={style.drillName}>{modelId}</span>
            <span style={style.drillCount}>{formatNumber(m.calls)} · {formatEur(m.estimatedCostEur)}</span>
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
  viewBar: { display: 'flex', alignItems: 'center', gap: 6, padding: '8px 12px', borderBottom: '1px solid var(--tn-border)', flexShrink: 0 },
  viewLabel: { fontSize: 11, color: 'var(--tn-text-muted)', marginRight: 4 },
  viewBtn: { padding: '4px 12px', borderRadius: 3, fontSize: 12, border: '1px solid var(--tn-border)', cursor: 'pointer' },
  viewSpacer: { flex: 1 },
  headerGrid: { display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8, padding: 12, borderBottom: '1px solid var(--tn-border)', flexShrink: 0 },
  stat: { background: 'var(--tn-bg-elev)', border: '1px solid var(--tn-border)', borderRadius: 4, padding: '10px 12px' },
  statLabel: { fontSize: 10, color: 'var(--tn-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 },
  statValue: { fontSize: 20, fontWeight: 700, fontFamily: 'monospace' },
  controls: { display: 'flex', justifyContent: 'flex-start', alignItems: 'center', gap: 10, padding: '8px 12px', borderBottom: '1px solid var(--tn-border)', flexShrink: 0 },
  controlLabel: { fontSize: 11, color: 'var(--tn-text-muted)' },
  modelBtn: { padding: '3px 10px', borderRadius: 3, fontSize: 11, border: '1px solid var(--tn-border)', cursor: 'pointer' },
  refreshBtn: { marginLeft: 10, padding: '3px 10px', borderRadius: 3, fontSize: 13, border: '1px solid var(--tn-border)', background: 'transparent', color: 'var(--tn-text)', cursor: 'pointer' },
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
