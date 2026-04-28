import { useState, useEffect, useCallback, useMemo } from 'react';
import ContractBanner from '../../../ContractBanner';
import { extractViolations, BridgeContracts } from '../../../../lib/dataContracts';
import type { ContractViolation } from '../../../../lib/dataContracts';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Cell,
  Treemap,
} from 'recharts';
import { formatNumber } from '../shared';
import { SafeChart } from '../../../shared/SafeChart';

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

interface UserBreakdown {
  user_id: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  apps: Record<string, number>;
}

interface ModelBreakdown {
  model: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

interface SankeyLink {
  source: string;
  target: string;
  value: number;
}

interface UsageBreakdown {
  summary: {
    total_calls: number;
    total_input_tokens: number;
    total_output_tokens: number;
    total_tokens: number;
    total_errors: number;
  };
  apps: AppBreakdown[];
  users: UserBreakdown[];
  models: ModelBreakdown[];
  sankey_links: SankeyLink[];
  period_hours: number;
  _error?: string;
}

// Cost estimation (matches Bridge usage_tracker.py pricing)
const PRICING: Record<string, { input: number; output: number }> = {
  sonnet: { input: 3.0, output: 15.0 },
  haiku: { input: 0.80, output: 4.0 },
  opus: { input: 15.0, output: 75.0 },
};

function estimateCostUSD(model: string, inputTokens: number, outputTokens: number): number {
  const key = model.includes('opus') ? 'opus' : model.includes('haiku') ? 'haiku' : 'sonnet';
  const p = PRICING[key];
  return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
}

const APP_COLORS: Record<string, string> = {
  'werking-report': '#7aa2f7',
  'werking-energy': '#9ece6a',
  'werking-safety': '#f7768e',
  'orchestrator': '#bb9af7',
  'bridge': '#e0af68',
  'unknown': '#565f89',
};

function getAppColor(appId: string): string {
  return APP_COLORS[appId] || APP_COLORS['unknown'];
}

const PERIOD_OPTIONS = [
  { label: '1h', hours: 1 },
  { label: '6h', hours: 6 },
  { label: '24h', hours: 24 },
  { label: '7d', hours: 168 },
  { label: 'All', hours: 0 },
];

export default function UsageAnalyticsTab() {
  const [data, setData] = useState<UsageBreakdown | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [hours, setHours] = useState(24);
  const [view, setView] = useState<'apps' | 'users' | 'models' | 'flow'>('apps');

  const fetchData = useCallback(async () => {
    if (window.__cuiServerAlive !== true) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/bridge/metrics/usage-breakdown?hours=${hours}`, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(await res.text());
      const raw = await res.json();
      if (raw._error) setError(raw._error);
      setData(raw);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [hours]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 60000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const fmtTokens = (n: number) => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return n.toString();
  };

  const fmtCost = (usd: number) => `$${usd.toFixed(3)}`;

  // Token usage bar (visual)
  const tokenBar = (input: number, output: number, maxTokens: number) => {
    const totalPct = maxTokens > 0 ? Math.min(((input + output) / maxTokens) * 100, 100) : 0;
    const inputPct = maxTokens > 0 ? (input / maxTokens) * 100 : 0;
    return (
      <div style={{ display: 'flex', gap: 2, height: 8, borderRadius: 4, overflow: 'hidden', background: 'rgba(255,255,255,0.05)', width: '100%' }}>
        <div style={{ width: `${inputPct}%`, background: 'var(--tn-blue)', borderRadius: '4px 0 0 4px', transition: 'width 0.3s' }} />
        <div style={{ width: `${totalPct - inputPct}%`, background: 'var(--tn-purple, #bb9af7)', borderRadius: '0 4px 4px 0', transition: 'width 0.3s' }} />
      </div>
    );
  };

  // Contract violations from server + client-side checks
  const violations = useMemo<ContractViolation[]>(() => {
    if (!data) return [];
    const serverViolations = extractViolations(data);
    // Client-side: check if tokens are zero despite having calls
    const clientViolations: ContractViolation[] = [];
    if (data.summary.total_tokens === 0 && data.summary.total_calls > 0) {
      clientViolations.push({
        code: 'BRIDGE_NO_TOKENS', severity: 'error',
        message: `${data.summary.total_calls} Calls, aber 0 Tokens — Token-Tracking ausgefallen`,
        detail: 'Kosten-Berechnung unmöglich ohne Token-Daten',
      });
    }
    const anonUsers = (data.users || []).filter(u => !u.user_id || u.user_id === 'anonymous');
    if (anonUsers.length > 0) {
      const anonCalls = anonUsers.reduce((s, u) => s + u.calls, 0);
      clientViolations.push({
        code: 'BRIDGE_NO_USER', severity: 'error',
        message: `${anonCalls}/${data.summary.total_calls} Calls ohne User-Attribution`,
        count: anonCalls, total: data.summary.total_calls,
      });
    }
    // Deduplicate by code
    const seen = new Set<string>();
    return [...serverViolations, ...clientViolations].filter(v => {
      if (seen.has(v.code)) return false;
      seen.add(v.code);
      return true;
    });
  }, [data]);

  // dataQuality === null bei: kein Datensatz, 0 Calls, oder Bridge-Outage-Violations
  // (BRIDGE_FALLBACK/OFFLINE/UNAVAILABLE). Verhindert grüne 100% bei kaputter Bridge.
  const dataQuality = useMemo<number | null>(() => {
    if (!data || data.summary.total_calls === 0) return null;
    const serverViolations = extractViolations(data);
    const outageCodes = ['BRIDGE_FALLBACK', 'BRIDGE_OFFLINE', 'BRIDGE_UNAVAILABLE'];
    if (serverViolations.some(v => outageCodes.includes(v.code))) return null;

    let checks = 0, passed = 0;
    // User attribution
    const anonCalls = (data.users || []).filter(u => !u.user_id || u.user_id === 'anonymous').reduce((s, u) => s + u.calls, 0);
    checks += data.summary.total_calls;
    passed += data.summary.total_calls - anonCalls;
    // Token tracking
    if (data.summary.total_tokens > 0) { checks++; passed++; } else if (data.summary.total_calls > 0) { checks++; }
    return checks > 0 ? Math.round((passed / checks) * 100) : null;
  }, [data]);

  return (
    <div data-ai-id="stats-tab-content" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <ContractBanner violations={violations} dataQuality={dataQuality} />
      <div style={{ padding: 12, flex: 1, overflowY: 'auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0, color: 'var(--tn-text)' }}>
          Usage Analytics
        </h3>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          {/* Period selector */}
          {PERIOD_OPTIONS.map(p => (
            <button key={p.hours} onClick={() => setHours(p.hours)} style={{
              padding: '3px 8px', borderRadius: 3, fontSize: 9, cursor: 'pointer',
              background: hours === p.hours ? 'var(--tn-blue)' : 'var(--tn-bg)',
              border: '1px solid var(--tn-border)',
              color: hours === p.hours ? '#fff' : 'var(--tn-text-muted)',
              fontWeight: 600,
            }}>{p.label}</button>
          ))}
          <button onClick={fetchData} style={{
            padding: '3px 10px', borderRadius: 3, fontSize: 10, cursor: 'pointer',
            background: 'var(--tn-bg)', border: '1px solid var(--tn-border)', color: 'var(--tn-text-muted)',
            marginLeft: 8,
          }}>Refresh</button>
        </div>
      </div>

      {error && (
        <div style={{ padding: '6px 10px', fontSize: 11, color: 'var(--tn-red)', background: 'rgba(247,118,142,0.1)', borderRadius: 3, marginBottom: 12 }}>
          {error}
        </div>
      )}

      {loading && !data && (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--tn-text-muted)', fontSize: 12 }}>Loading...</div>
      )}

      {data && (
        <>
          {/* Summary Cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8, marginBottom: 16 }}>
            {[
              { label: 'Total Calls', value: formatNumber(data.summary.total_calls), color: 'var(--tn-blue)', icon: '📊' },
              { label: 'Input Tokens', value: fmtTokens(data.summary.total_input_tokens), color: 'var(--tn-blue)', icon: '📥' },
              { label: 'Output Tokens', value: fmtTokens(data.summary.total_output_tokens), color: 'var(--tn-purple, #bb9af7)', icon: '📤' },
              { label: 'Total Tokens', value: fmtTokens(data.summary.total_tokens), color: 'var(--tn-text)', icon: '🔢' },
              { label: 'Errors', value: data.summary.total_errors.toString(), color: data.summary.total_errors > 0 ? 'var(--tn-red)' : 'var(--tn-green)', icon: data.summary.total_errors > 0 ? '⚠️' : '✅' },
            ].map(s => (
              <div key={s.label} style={{ padding: '10px 12px', background: 'var(--tn-bg-dark)', border: '1px solid var(--tn-border)', borderRadius: 6 }}>
                <div style={{ fontSize: 8, color: 'var(--tn-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600, marginBottom: 4 }}>
                  {s.icon} {s.label}
                </div>
                <div style={{ fontSize: 18, fontWeight: 700, color: s.color }}>{s.value}</div>
              </div>
            ))}
          </div>

          {/* View selector tabs */}
          <div style={{ display: 'flex', gap: 4, marginBottom: 12 }}>
            {(['apps', 'users', 'models', 'flow'] as const).map(v => (
              <button key={v} onClick={() => setView(v)} style={{
                padding: '4px 12px', borderRadius: 4, fontSize: 10, fontWeight: 600, cursor: 'pointer',
                background: view === v ? 'var(--tn-blue)' : 'transparent',
                border: 'none', color: view === v ? '#fff' : 'var(--tn-text-muted)',
              }}>
                {v === 'apps' ? 'Per App' : v === 'users' ? 'Per User' : v === 'models' ? 'Per Model' : 'Flow'}
              </button>
            ))}
          </div>

          {/* Per-App View */}
          {view === 'apps' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {data.apps.length > 0 ? data.apps.map(app => {
                const maxTokens = data.apps[0]?.total_tokens || 1;
                const cost = estimateCostUSD(
                  Object.keys(app.agents).find(a => a.includes('sonnet')) ? 'sonnet' : 'sonnet',
                  app.input_tokens, app.output_tokens
                );
                return (
                  <div key={app.app_id} style={{
                    padding: '10px 14px', background: 'var(--tn-bg-dark)',
                    border: '1px solid var(--tn-border)', borderRadius: 6,
                    borderLeft: `4px solid ${getAppColor(app.app_id)}`,
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--tn-text)', fontFamily: 'monospace' }}>{app.app_id}</span>
                        <span style={{ fontSize: 9, color: 'var(--tn-text-muted)' }}>{app.calls} calls</span>
                        {app.errors > 0 && <span style={{ fontSize: 8, color: 'var(--tn-red)', fontWeight: 600 }}>{app.error_rate}% errors</span>}
                      </div>
                      <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--tn-green)' }}>{fmtCost(cost)}</span>
                    </div>
                    {tokenBar(app.input_tokens, app.output_tokens, maxTokens)}
                    <div style={{ display: 'flex', gap: 16, marginTop: 6, fontSize: 9, color: 'var(--tn-text-muted)' }}>
                      <span>In: {fmtTokens(app.input_tokens)}</span>
                      <span>Out: {fmtTokens(app.output_tokens)}</span>
                      <span>Users: {Object.keys(app.users).length}</span>
                      <span>Agents: {Object.keys(app.agents).length}</span>
                    </div>
                    {/* Agent breakdown */}
                    {Object.keys(app.agents).length > 0 && (
                      <div style={{ marginTop: 6, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        {Object.entries(app.agents).sort((a, b) => b[1] - a[1]).map(([agent, count]) => (
                          <span key={agent} style={{
                            fontSize: 8, padding: '1px 5px', borderRadius: 3,
                            background: 'rgba(122,162,247,0.1)', color: 'var(--tn-blue)',
                            fontFamily: 'monospace',
                          }}>{agent}: {count}</span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              }) : (
                <div style={{ padding: 30, textAlign: 'center', color: 'var(--tn-text-muted)', fontSize: 11 }}>No app data available</div>
              )}
            </div>
          )}

          {/* Per-User View */}
          {view === 'users' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {data.users.length > 0 ? data.users.map(user => {
                const maxTokens = data.users[0]?.total_tokens || 1;
                const cost = estimateCostUSD('sonnet', user.input_tokens, user.output_tokens);
                return (
                  <div key={user.user_id} style={{
                    padding: '10px 14px', background: 'var(--tn-bg-dark)',
                    border: '1px solid var(--tn-border)', borderRadius: 6,
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--tn-text)', fontFamily: 'monospace' }}>
                          {user.user_id.length > 20 ? `${user.user_id.slice(0, 8)}...${user.user_id.slice(-6)}` : user.user_id}
                        </span>
                        <span style={{ fontSize: 9, color: 'var(--tn-text-muted)' }}>{user.calls} calls</span>
                      </div>
                      <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--tn-green)' }}>{fmtCost(cost)}</span>
                    </div>
                    {tokenBar(user.input_tokens, user.output_tokens, maxTokens)}
                    <div style={{ display: 'flex', gap: 16, marginTop: 6, fontSize: 9, color: 'var(--tn-text-muted)' }}>
                      <span>In: {fmtTokens(user.input_tokens)}</span>
                      <span>Out: {fmtTokens(user.output_tokens)}</span>
                      {Object.entries(user.apps).map(([app, count]) => (
                        <span key={app} style={{ color: getAppColor(app) }}>{app}: {count}</span>
                      ))}
                    </div>
                  </div>
                );
              }) : (
                <div style={{ padding: 30, textAlign: 'center', color: 'var(--tn-text-muted)', fontSize: 11 }}>No user data available</div>
              )}
            </div>
          )}

          {/* Per-Model View */}
          {view === 'models' && (
            <div>
              {data.models.length > 0 ? (
                <>
                  <SafeChart height={220}>
                    <BarChart data={data.models} margin={{ top: 0, right: 10, left: 0, bottom: 40 }}>
                      <XAxis dataKey="model" tick={{ fontSize: 8, fill: 'var(--tn-text-muted)' }} angle={-30} textAnchor="end" height={60} />
                      <YAxis tick={{ fontSize: 9, fill: 'var(--tn-text-muted)' }} width={50} tickFormatter={fmtTokens} />
                      <Tooltip
                        contentStyle={{ background: 'var(--tn-bg-dark)', border: '1px solid var(--tn-border)', fontSize: 10 }}
                        formatter={(value: number | undefined) => [fmtTokens(value ?? 0), 'Tokens']}
                      />
                      <Bar dataKey="total_tokens" radius={[4, 4, 0, 0]}>
                        {data.models.map((_, i) => (
                          <Cell key={i} fill={['var(--tn-blue)', 'var(--tn-purple, #bb9af7)', 'var(--tn-green)', 'var(--tn-orange)'][i % 4]} />
                        ))}
                      </Bar>
                    </BarChart>
                  </SafeChart>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
                    {data.models.map(m => (
                      <div key={m.model} style={{
                        display: 'grid', gridTemplateColumns: '1fr 70px 80px 80px 70px',
                        gap: 8, padding: '6px 10px', fontSize: 9, borderBottom: '1px solid var(--tn-border)', alignItems: 'center',
                      }}>
                        <span style={{ fontFamily: 'monospace', color: 'var(--tn-text)', fontWeight: 600, fontSize: 8 }}>{m.model}</span>
                        <span style={{ color: 'var(--tn-text-muted)' }}>{m.calls} calls</span>
                        <span style={{ color: 'var(--tn-blue)' }}>In: {fmtTokens(m.input_tokens)}</span>
                        <span style={{ color: 'var(--tn-purple, #bb9af7)' }}>Out: {fmtTokens(m.output_tokens)}</span>
                        <span style={{ color: 'var(--tn-green)', fontWeight: 600 }}>{fmtCost(estimateCostUSD(m.model, m.input_tokens, m.output_tokens))}</span>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div style={{ padding: 30, textAlign: 'center', color: 'var(--tn-text-muted)', fontSize: 11 }}>No model data available</div>
              )}
            </div>
          )}

          {/* Flow View (Sankey-style) */}
          {view === 'flow' && (
            <div>
              {data.sankey_links.length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginBottom: 8, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    APP → USER TOKEN FLOW
                  </div>
                  {/* Visual flow bars */}
                  {data.sankey_links.slice(0, 30).map((link, i) => {
                    const maxVal = data.sankey_links[0]?.value || 1;
                    const pct = Math.max((link.value / maxVal) * 100, 2);
                    return (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' }}>
                        <span style={{
                          width: 100, fontSize: 8, fontFamily: 'monospace', fontWeight: 600,
                          color: getAppColor(link.source), textAlign: 'right', flexShrink: 0,
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>{link.source}</span>
                        <div style={{ flex: 1, position: 'relative', height: 14 }}>
                          <div style={{
                            width: `${pct}%`, height: '100%', borderRadius: 3,
                            background: `linear-gradient(90deg, ${getAppColor(link.source)}, rgba(122,162,247,0.3))`,
                            transition: 'width 0.3s',
                          }} />
                          <span style={{
                            position: 'absolute', right: 4, top: 1, fontSize: 8,
                            color: 'var(--tn-text-muted)', fontFamily: 'monospace',
                          }}>{fmtTokens(link.value)}</span>
                        </div>
                        <span style={{
                          width: 100, fontSize: 8, fontFamily: 'monospace',
                          color: 'var(--tn-text)', flexShrink: 0,
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>
                          {link.target.length > 14 ? `${link.target.slice(0, 6)}...${link.target.slice(-4)}` : link.target}
                        </span>
                      </div>
                    );
                  })}
                  {data.sankey_links.length > 30 && (
                    <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', textAlign: 'center', marginTop: 4 }}>
                      +{data.sankey_links.length - 30} more flows
                    </div>
                  )}
                </div>
              ) : (
                <div style={{ padding: 30, textAlign: 'center', color: 'var(--tn-text-muted)', fontSize: 11 }}>No flow data available</div>
              )}
            </div>
          )}
        </>
      )}
      </div>
    </div>
  );
}
