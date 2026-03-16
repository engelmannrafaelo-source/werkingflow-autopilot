import { useState, useEffect, useCallback } from 'react';
import { bridgeJson, StatCard, Toolbar, ErrorBanner, LoadingSpinner, SectionFlat, formatDuration } from '../shared';

const PRICING: Record<string, { input: number; output: number }> = {
  'claude-haiku-4-5-20251001':   { input: 0.80,  output: 4.00 },
  'claude-haiku-3-5-20241022':   { input: 0.80,  output: 4.00 },
  'claude-sonnet-4-5-20250929':  { input: 3.00,  output: 15.00 },
  'claude-sonnet-4-20250514':    { input: 3.00,  output: 15.00 },
  'claude-sonnet-3-7-20250219':  { input: 3.00,  output: 15.00 },
  'claude-opus-4-20250514':      { input: 15.00, output: 75.00 },
  'claude-opus-4-1-20250805':    { input: 15.00, output: 75.00 },
  'claude-opus-4-6':             { input: 15.00, output: 75.00 },
};

interface EndpointMetrics {
  count: number;
  avg_duration: number;
  min_duration: number;
  max_duration: number;
  slow_count: number;
  very_slow_count: number;
}

interface MetricsResponse {
  metrics: {
    total_requests: number;
    average_duration: number;
    slow_requests: number;
    very_slow_requests: number;
    endpoints: Record<string, EndpointMetrics>;
  };
  thresholds: {
    non_tool: { slow_request: string; very_slow_request: string };
    tool_enabled: { slow_request: string; very_slow_request: string };
  };
}

interface AppStats {
  app_id: string;
  total_requests?: number;
  requests?: number;
  total_tokens?: number;
  tokens?: number;
  total_cost_usd?: number;
  avg_response_time_ms?: number;
  avg_latency_ms?: number;
  success_rate?: number;
  last_seen?: string;
  unique_users?: number;
  unique_sessions?: number;
}

interface PersistentResponse {
  source: string;
  realtime: { total_requests?: number; total_tokens?: number; total_cost_usd?: number; avg_response_time_ms?: number; success_rate?: number };
  daily: Array<{ date: string; total_requests: number; total_tokens: number; total_cost_usd: number }>;
  apps: AppStats[];
  models: Array<{ model: string; total_requests: number; total_tokens: number; total_cost_usd: number }>;
  _error?: string;
}

interface Model {
  id: string;
  description?: string;
  owned_by?: string;
}

function formatCost(usd: number): string {
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'gerade eben';
  if (mins < 60) return `vor ${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `vor ${hrs}h`;
  return `vor ${Math.floor(hrs / 24)}d`;
}

function activityColor(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 3600_000) return 'var(--tn-green)';       // <1h = active
  if (diff < 86400_000) return 'var(--tn-orange)';      // <24h = recent
  return 'var(--tn-red)';                                // >24h = stale
}

export default function MetrikenTab() {
  const [metrics, setMetrics] = useState<MetricsResponse | null>(null);
  const [persistent, setPersistent] = useState<PersistentResponse | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [metricsRes, persistentRes, modelsRes] = await Promise.allSettled([
        bridgeJson<MetricsResponse>('/v1/metrics'),
        bridgeJson<PersistentResponse>('/api/bridge/metrics/persistent'),
        bridgeJson<{ data: Model[] }>('/v1/models'),
      ]);

      if (metricsRes.status === 'fulfilled') setMetrics(metricsRes.value);
      if (persistentRes.status === 'fulfilled') setPersistent(persistentRes.value);
      if (modelsRes.status === 'fulfilled') setModels(modelsRes.value.data ?? []);

      if (metricsRes.status === 'rejected' && persistentRes.status === 'rejected') {
        setError('Bridge nicht erreichbar');
      }

      setLastRefresh(new Date());
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const m = metrics?.metrics;
  const p = persistent;
  const rt = p?.realtime;
  const apps = p?.apps ?? [];
  const daily = p?.daily ?? [];
  const endpoints = m?.endpoints ?? {};
  const endpointEntries = Object.entries(endpoints).sort((a, b) => b[1].count - a[1].count);

  return (
    <div style={{ padding: 12 }}>
      <Toolbar lastRefresh={lastRefresh} loading={loading} onRefresh={fetchAll} />
      {error && <ErrorBanner message={error} />}

      {!loading && (
        <>
          {/* Persistent KPIs (letzte 24h) */}
          {rt && (rt.total_requests ?? 0) > 0 && (
            <SectionFlat title="Letzte 24 Stunden (persistent)">
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                <StatCard label="Requests" value={String(rt.total_requests ?? 0)} />
                <StatCard label="Tokens" value={formatTokens(rt.total_tokens ?? 0)} />
                <StatCard label="Kosten" value={formatCost(rt.total_cost_usd ?? 0)} />
                <StatCard label="Ø Latenz" value={rt.avg_response_time_ms ? `${(rt.avg_response_time_ms / 1000).toFixed(1)}s` : '–'} />
                <StatCard label="Erfolgsrate" value={`${(rt.success_rate ?? 100).toFixed(0)}%`} color={(rt.success_rate ?? 100) < 95 ? 'var(--tn-red)' : 'var(--tn-green)'} />
              </div>
            </SectionFlat>
          )}

          {/* Connected Apps */}
          {apps.length > 0 && (
            <SectionFlat title={`Connected Apps (${apps.length})`}>
              <div style={{ background: 'var(--tn-bg-dark)', borderRadius: 5, overflow: 'hidden' }}>
                <div style={{
                  display: 'grid', gridTemplateColumns: '1fr 65px 65px 60px 70px 55px',
                  gap: 4, padding: '5px 10px', fontSize: 9, fontWeight: 700,
                  color: 'var(--tn-text-muted)', borderBottom: '1px solid var(--tn-border)',
                  textTransform: 'uppercase', letterSpacing: '0.05em',
                }}>
                  <div>App</div>
                  <div style={{ textAlign: 'right' }}>Requests</div>
                  <div style={{ textAlign: 'right' }}>Tokens</div>
                  <div style={{ textAlign: 'right' }}>Kosten</div>
                  <div style={{ textAlign: 'right' }}>Ø Latenz</div>
                  <div style={{ textAlign: 'right' }}>Zuletzt</div>
                </div>
                {apps.map((app) => (
                  <div key={app.app_id} style={{
                    display: 'grid', gridTemplateColumns: '1fr 65px 65px 60px 70px 55px',
                    gap: 4, padding: '6px 10px', fontSize: 10,
                    borderBottom: '1px solid var(--tn-border)', alignItems: 'center',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <div style={{
                        width: 6, height: 6, borderRadius: '50%',
                        background: app.last_seen ? activityColor(app.last_seen) : 'var(--tn-text-muted)',
                      }} />
                      <span style={{ fontFamily: 'monospace', color: 'var(--tn-text)', fontSize: 10 }}>
                        {app.app_id}
                      </span>
                    </div>
                    <div style={{ textAlign: 'right', fontFamily: 'monospace', color: 'var(--tn-text)' }}>
                      {app.total_requests ?? app.requests ?? 0}
                    </div>
                    <div style={{ textAlign: 'right', fontFamily: 'monospace', color: 'var(--tn-text-muted)', fontSize: 9 }}>
                      {formatTokens(app.total_tokens ?? app.tokens ?? 0)}
                    </div>
                    <div style={{ textAlign: 'right', fontFamily: 'monospace', color: 'var(--tn-text-muted)', fontSize: 9 }}>
                      {formatCost(app.total_cost_usd ?? 0)}
                    </div>
                    <div style={{ textAlign: 'right', fontFamily: 'monospace', color: 'var(--tn-text-muted)', fontSize: 9 }}>
                      {(app.avg_response_time_ms ?? app.avg_latency_ms ?? 0) > 0
                        ? `${((app.avg_response_time_ms ?? app.avg_latency_ms ?? 0) / 1000).toFixed(1)}s`
                        : '–'}
                    </div>
                    <div style={{ textAlign: 'right', fontSize: 9, color: app.last_seen ? activityColor(app.last_seen) : 'var(--tn-text-muted)' }}>
                      {app.last_seen ? timeAgo(app.last_seen) : '–'}
                    </div>
                  </div>
                ))}
              </div>
            </SectionFlat>
          )}

          {/* Daily Breakdown (last 7 days) */}
          {daily.length > 0 && (
            <SectionFlat title={`Tagesverlauf (${daily.length} Tage)`}>
              <div style={{ background: 'var(--tn-bg-dark)', borderRadius: 5, overflow: 'hidden' }}>
                <div style={{
                  display: 'grid', gridTemplateColumns: '80px 65px 65px 60px',
                  gap: 4, padding: '5px 10px', fontSize: 9, fontWeight: 700,
                  color: 'var(--tn-text-muted)', borderBottom: '1px solid var(--tn-border)',
                  textTransform: 'uppercase',
                }}>
                  <div>Tag</div>
                  <div style={{ textAlign: 'right' }}>Requests</div>
                  <div style={{ textAlign: 'right' }}>Tokens</div>
                  <div style={{ textAlign: 'right' }}>Kosten</div>
                </div>
                {daily.map((d) => (
                  <div key={d.date} style={{
                    display: 'grid', gridTemplateColumns: '80px 65px 65px 60px',
                    gap: 4, padding: '5px 10px', fontSize: 10,
                    borderBottom: '1px solid var(--tn-border)',
                  }}>
                    <div style={{ fontFamily: 'monospace', color: 'var(--tn-text)', fontSize: 9 }}>{d.date}</div>
                    <div style={{ textAlign: 'right', fontFamily: 'monospace', color: 'var(--tn-text)' }}>{d.total_requests}</div>
                    <div style={{ textAlign: 'right', fontFamily: 'monospace', color: 'var(--tn-text-muted)', fontSize: 9 }}>{formatTokens(d.total_tokens)}</div>
                    <div style={{ textAlign: 'right', fontFamily: 'monospace', color: 'var(--tn-text-muted)', fontSize: 9 }}>{formatCost(d.total_cost_usd)}</div>
                  </div>
                ))}
              </div>
            </SectionFlat>
          )}

          {/* In-Memory Performance KPIs (seit Worker-Start) */}
          {m && (
            <SectionFlat title="Performance (seit Worker-Start)">
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                <StatCard label="Requests gesamt" value={String(m.total_requests)} />
                <StatCard label="Ø Dauer" value={m.average_duration > 0 ? formatDuration(m.average_duration) : '–'} />
                <StatCard label="Langsam" value={String(m.slow_requests)}
                  sub={`Threshold: ${metrics!.thresholds.non_tool.slow_request}`}
                  color={m.slow_requests > 0 ? 'var(--tn-orange)' : 'var(--tn-text-muted)'} />
                <StatCard label="Sehr langsam" value={String(m.very_slow_requests)}
                  sub={`Threshold: ${metrics!.thresholds.non_tool.very_slow_request}`}
                  color={m.very_slow_requests > 0 ? 'var(--tn-red)' : 'var(--tn-text-muted)'} />
              </div>
              <div style={{ background: 'var(--tn-bg-dark)', borderRadius: 5, padding: '6px 10px' }}>
                <div style={{ display: 'flex', gap: 16, fontSize: 10, color: 'var(--tn-text-muted)' }}>
                  <span>Tool-Thresholds: langsam {metrics!.thresholds.tool_enabled.slow_request} / sehr langsam {metrics!.thresholds.tool_enabled.very_slow_request}</span>
                </div>
              </div>
            </SectionFlat>
          )}

          {/* Endpoint Breakdown */}
          {endpointEntries.length > 0 && (
            <SectionFlat title={`Endpoint-Breakdown (${endpointEntries.length})`}>
              <div style={{ background: 'var(--tn-bg-dark)', borderRadius: 5, overflow: 'hidden' }}>
                <div style={{
                  display: 'grid', gridTemplateColumns: '1fr 55px 65px 65px 65px 45px',
                  gap: 4, padding: '5px 10px', fontSize: 9, fontWeight: 700,
                  color: 'var(--tn-text-muted)', borderBottom: '1px solid var(--tn-border)',
                  textTransform: 'uppercase', letterSpacing: '0.05em',
                }}>
                  <div>Endpoint</div>
                  <div style={{ textAlign: 'right' }}>Requests</div>
                  <div style={{ textAlign: 'right' }}>Ø Dauer</div>
                  <div style={{ textAlign: 'right' }}>Min</div>
                  <div style={{ textAlign: 'right' }}>Max</div>
                  <div style={{ textAlign: 'right' }}>Slow</div>
                </div>
                {endpointEntries.map(([path, ep]) => (
                  <div key={path} style={{
                    display: 'grid', gridTemplateColumns: '1fr 55px 65px 65px 65px 45px',
                    gap: 4, padding: '6px 10px', fontSize: 10,
                    borderBottom: '1px solid var(--tn-border)', alignItems: 'center',
                  }}>
                    <div style={{ fontFamily: 'monospace', color: 'var(--tn-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 9 }}>
                      {path}
                    </div>
                    <div style={{ textAlign: 'right', fontFamily: 'monospace', color: 'var(--tn-text)' }}>{ep.count}</div>
                    <div style={{ textAlign: 'right', fontFamily: 'monospace', color: 'var(--tn-text-muted)', fontSize: 9 }}>{formatDuration(ep.avg_duration)}</div>
                    <div style={{ textAlign: 'right', fontFamily: 'monospace', color: 'var(--tn-text-muted)', fontSize: 9 }}>{formatDuration(ep.min_duration)}</div>
                    <div style={{ textAlign: 'right', fontFamily: 'monospace', color: 'var(--tn-text-muted)', fontSize: 9 }}>{formatDuration(ep.max_duration)}</div>
                    <div style={{
                      textAlign: 'right', fontFamily: 'monospace', fontSize: 9,
                      color: (ep.slow_count + ep.very_slow_count) > 0 ? 'var(--tn-orange)' : 'var(--tn-text-muted)',
                    }}>
                      {ep.slow_count + ep.very_slow_count}
                    </div>
                  </div>
                ))}
              </div>
            </SectionFlat>
          )}
        </>
      )}

      {/* Verfügbare Modelle */}
      {!loading && models.length > 0 && (
        <SectionFlat title={`Verfügbare Modelle (${models.length})`}>
          <div style={{ background: 'var(--tn-bg-dark)', borderRadius: 5, overflow: 'hidden' }}>
            {models.map((model, i) => {
              const price = PRICING[model.id];
              return (
                <div key={i} style={{
                  display: 'grid', gridTemplateColumns: '1fr auto',
                  gap: 8, padding: '7px 10px',
                  borderBottom: '1px solid var(--tn-border)', alignItems: 'center',
                }}>
                  <div>
                    <div style={{ fontSize: 11, color: 'var(--tn-text)', fontFamily: 'monospace' }}>{model.id}</div>
                    {model.description && (
                      <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', marginTop: 2 }}>{model.description}</div>
                    )}
                  </div>
                  {price && (
                    <div style={{ textAlign: 'right', fontSize: 9, color: 'var(--tn-text-muted)', whiteSpace: 'nowrap' }}>
                      <span style={{ fontFamily: 'monospace' }}>${price.input}/${price.output}</span>
                      <span style={{ marginLeft: 4 }}>pro 1M</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </SectionFlat>
      )}

      {/* Hinweis */}
      <div style={{
        padding: '8px 10px', borderRadius: 5, fontSize: 10,
        background: 'rgba(122,162,247,0.08)', border: '1px solid rgba(122,162,247,0.2)',
        color: 'var(--tn-text-muted)', lineHeight: 1.5,
      }}>
        <strong style={{ color: 'var(--tn-blue)' }}>Datenquellen:</strong>{' '}
        Persistent (PostgreSQL) = überlebt Worker-Restarts. Performance = In-Memory pro Worker-Instanz.
      </div>

      {loading && <LoadingSpinner text="Lade Metrik-Daten..." />}
    </div>
  );
}
