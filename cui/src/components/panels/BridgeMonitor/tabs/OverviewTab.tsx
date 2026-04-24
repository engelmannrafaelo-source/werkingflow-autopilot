import { useState, useEffect, useCallback } from 'react';
import { validateApiResponse } from '../../../../lib/validateApiResponse';

// Validated shape — health and timestamp guaranteed, rest has API-version alternatives
interface GuardSlotInfo {
  label: string;
  active: number;
  max: number;
  available: number;
  requests: Array<{ caller: string; appId: string; duration: number }>;
}

interface GuardData {
  running: boolean;
  slots?: Record<string, GuardSlotInfo>;
  queue?: Array<{ type: string; priority: number; caller: string; waitSeconds: number }>;
  queueLength?: number;
  metrics?: { totalRequests: number; totalCompleted: number; totalPreempted: number };
}

interface Usage24h {
  total_calls: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_tokens: number;
  total_errors: number;
  cost_usd: number;
  models: number;
  apps: number;
}

interface WorkersStatus {
  up: number;
  total: number;
  status: string;
}

interface OverviewData {
  health: string;
  worker?: string;
  uptime_hours?: number;
  total_requests?: number;
  totalRequests?: number;
  avg_response_time?: number;
  avgResponseTime?: number;
  success_rate?: number;
  successRate?: number;
  active_sessions?: number;
  active_requests?: number;
  memory_usage_percent?: number;
  memory_used_gb?: number;
  can_accept_requests?: boolean;
  rate_limited?: boolean;
  usage_24h?: Usage24h | null;
  workers_status?: WorkersStatus | null;
  guard?: GuardData;
  timestamp: string;
  _error?: string;
  _note?: string;
}

interface AppInfo {
  app_id?: string;
  requests?: number;
  total_requests?: number;
  tokens?: number;
  total_tokens?: number;
  avg_latency_ms?: number;
  avg_response_time_ms?: number;
  last_seen?: string;
  success_rate?: number;
}

interface AppsResponse {
  apps_realtime?: AppInfo[];
  apps_period?: AppInfo[];
  _error?: string;
}

interface ForecastWorker {
  arrivals: number;
  completions: number;
  errors: number;
  rate_limit_hits: number;
  arrivals_per_min: number;
  completions_per_min: number;
  input_tokens_per_min: number;
  output_tokens_per_min: number;
  avg_duration_ms: number;
  in_flight: number;
}

interface ForecastWorkerLimit {
  account: string;
  weekly_percent: number;
  session_percent: number;
  active: boolean;
}

interface ForecastResponse {
  window_seconds?: number;
  worker_self?: string;
  workers?: Record<string, ForecastWorker>;
  worker_limits?: Record<string, ForecastWorkerLimit>;
  saturation?: Record<string, string>;
  totals?: {
    arrivals: number;
    completions: number;
    errors: number;
    rate_limit_hits: number;
    in_flight: number;
    arrivals_per_min: number;
    completions_per_min: number;
    input_tokens_per_min: number;
    output_tokens_per_min: number;
  };
  forecast?: {
    in_flight_total: number;
    drain_rate_per_s: number;
    arrival_rate_per_s: number;
    net_per_s: number;
    backlog_trend: string;
    eta_empty_s: number | null;
    active_workers: number | null;
    rate_limit_risk: string;
  };
  _error?: string;
}

export default function OverviewTab() {
  const [data, setData] = useState<OverviewData | null>(null);
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [forecast, setForecast] = useState<ForecastResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const fetchData = useCallback(async () => {
    if (window.__cuiServerAlive === false) return;
    setLoading(true);
    setError('');
    try {
      const [overviewRes, appsRes, forecastRes] = await Promise.allSettled([
        fetch('/api/bridge/metrics/overview', { signal: AbortSignal.timeout(20000) }).then(r => r.json()),
        fetch('/api/bridge/metrics/apps', { signal: AbortSignal.timeout(10000) }).then(r => r.json()),
        fetch('/api/bridge/metrics/queue-forecast?window=120', { signal: AbortSignal.timeout(10000) }).then(r => r.json()),
      ]);

      if (overviewRes.status === 'fulfilled') {
        if (overviewRes.value._error) {
          setError(overviewRes.value._error);
        } else {
          const validated = validateApiResponse<OverviewData>(overviewRes.value, '/api/bridge/metrics/overview', {
            health: 'string',
            timestamp: 'string',
          });
          setData(validated);
        }
      } else {
        setError('Bridge nicht erreichbar');
      }

      if (appsRes.status === 'fulfilled') {
        const appsData = appsRes.value as AppsResponse;
        setApps(appsData.apps_realtime ?? appsData.apps_period ?? []);
      }

      if (forecastRes.status === 'fulfilled' && !forecastRes.value._error) {
        setForecast(forecastRes.value as ForecastResponse);
      }
    } catch (err: any) {
      console.warn('[BridgeOverview] fetch failed:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 60000);
    const onReconnect = () => fetchData();
    window.addEventListener('cui-reconnected', onReconnect);
    return () => { clearInterval(interval); window.removeEventListener('cui-reconnected', onReconnect); };
  }, [fetchData]);

  const statCard = (label: string, value: string | number, color: string, icon?: string, aiId?: string) => (
    <div data-ai-id={aiId} style={{
      padding: '12px 16px', background: 'var(--tn-bg-dark)',
      border: '1px solid var(--tn-border)', borderRadius: 6,
      display: 'flex', flexDirection: 'column', gap: 4,
    }}>
      <div style={{
        fontSize: 9, color: 'var(--tn-text-muted)', textTransform: 'uppercase',
        letterSpacing: '0.05em', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4,
      }}>
        {icon && <span>{icon}</span>}{label}
      </div>
      <div data-ai-id={aiId ? `${aiId}-value` : undefined} style={{ fontSize: 20, fontWeight: 700, color }}>{value}</div>
    </div>
  );

  const formatNumber = (num: number | undefined | null) => {
    if (num == null) return '0';
    if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
    return num.toString();
  };

  const activityColor = (iso: string) => {
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 3600_000) return 'var(--tn-green)';
    if (diff < 86400_000) return 'var(--tn-orange)';
    return 'var(--tn-red)';
  };

  const timeAgo = (iso: string) => {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'jetzt';
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h`;
    return `${Math.floor(hrs / 24)}d`;
  };

  return (
    <div data-ai-id="bridge-overview-tab" style={{ padding: 12 }}>
      {/* Header */}
      <div data-ai-id="bridge-overview-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h3 data-ai-id="bridge-overview-title" style={{ fontSize: 14, fontWeight: 600, margin: 0, color: 'var(--tn-text)' }}>
          AI Bridge Overview
        </h3>
        <button data-ai-id="bridge-overview-refresh-button" onClick={fetchData} style={{
          padding: '3px 10px', borderRadius: 3, fontSize: 10, cursor: 'pointer',
          background: 'var(--tn-bg)', border: '1px solid var(--tn-border)', color: 'var(--tn-text-muted)',
        }}>Refresh</button>
      </div>

      {error && (
        <div data-ai-id="bridge-overview-error" style={{
          padding: '6px 10px', fontSize: 11, color: 'var(--tn-red)',
          background: 'rgba(247,118,142,0.1)', borderRadius: 3, marginBottom: 12,
        }}>{error}</div>
      )}

      {loading && !data && (
        <div data-ai-id="bridge-overview-loading" style={{ padding: 40, textAlign: 'center', color: 'var(--tn-text-muted)', fontSize: 12 }}>
          Loading...
        </div>
      )}

      {/* Quick Stats */}
      <div data-ai-id="bridge-overview-stats-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10, marginBottom: 16 }}>
        {data ? (() => {
          const health = data.health;
          const ws = data.workers_status;
          const totalReqs = data.total_requests ?? data.totalRequests ?? 0;
          const sessions = data.active_sessions ?? 0;
          const activeReqs = data.active_requests ?? 0;
          return (<>
            {statCard('Health', health, health === 'healthy' ? 'var(--tn-green)' : 'var(--tn-red)', health === 'healthy' ? '✅' : '⚠️', 'bridge-overview-health-stat')}
            {statCard('Workers', ws ? `${ws.up}/${ws.total}` : '-', ws?.up === ws?.total ? 'var(--tn-green)' : 'var(--tn-orange)', '🔧', 'bridge-overview-worker-stat')}
            {statCard('Requests (24h)', formatNumber(totalReqs), 'var(--tn-blue)', '📊', 'bridge-overview-requests-stat')}
            {statCard('Active', `${activeReqs} req / ${sessions} sess`, activeReqs > 0 ? 'var(--tn-orange)' : 'var(--tn-text-muted)', '⚡', 'bridge-overview-sessions-stat')}
            {statCard('Memory', data.memory_used_gb ? `${data.memory_used_gb.toFixed(1)} GB` : '-', (data.memory_usage_percent ?? 0) > 80 ? 'var(--tn-red)' : 'var(--tn-text-muted)', '💾', 'bridge-overview-memory-stat')}
          </>);
        })() : (
          <div style={{ gridColumn: '1 / -1', padding: 20, textAlign: 'center', color: 'var(--tn-text-dim)', fontSize: 12 }}>
            No overview data available
          </div>
        )}
      </div>

      {/* 24h Usage Summary */}
      {data?.usage_24h && (
        <div data-ai-id="bridge-usage-24h" style={{ marginBottom: 16 }}>
          <h4 style={{ fontSize: 11, fontWeight: 600, margin: '0 0 8px', color: 'var(--tn-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Usage (24h)
          </h4>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8 }}>
            {statCard('Cost', `$${data.usage_24h.cost_usd.toFixed(2)}`, 'var(--tn-orange)', '💰', 'usage-cost')}
            {statCard('Input Tokens', formatNumber(data.usage_24h.total_input_tokens), 'var(--tn-blue)', '📥', 'usage-input')}
            {statCard('Output Tokens', formatNumber(data.usage_24h.total_output_tokens), 'var(--tn-blue)', '📤', 'usage-output')}
            {statCard('Errors', String(data.usage_24h.total_errors), data.usage_24h.total_errors > 0 ? 'var(--tn-red)' : 'var(--tn-green)', data.usage_24h.total_errors > 0 ? '⚠️' : '✅', 'usage-errors')}
            {statCard('Models', String(data.usage_24h.models), 'var(--tn-text-muted)', '🤖', 'usage-models')}
          </div>
        </div>
      )}

      {/* Connected Apps */}
      {apps.length > 0 && (
        <div data-ai-id="bridge-connected-apps" style={{ marginBottom: 16 }}>
          <h4 style={{ fontSize: 11, fontWeight: 600, margin: '0 0 8px', color: 'var(--tn-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Connected Apps ({apps.length})
          </h4>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {apps.map(app => {
              const reqs = app.requests ?? app.total_requests ?? 0;
              const latency = app.avg_latency_ms ?? app.avg_response_time_ms ?? 0;
              const color = app.last_seen ? activityColor(app.last_seen) : 'var(--tn-text-muted)';
              return (
                <div key={app.app_id ?? ''} style={{
                  padding: '8px 12px', background: 'var(--tn-bg-dark)',
                  border: '1px solid var(--tn-border)', borderRadius: 6,
                  borderLeft: `3px solid ${color}`, minWidth: 130,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                    <div style={{ width: 6, height: 6, borderRadius: '50%', background: color }} />
                    <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--tn-text)', fontFamily: 'monospace' }}>
                      {app.app_id ?? 'unknown'}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: 12, fontSize: 9, color: 'var(--tn-text-muted)' }}>
                    <span>{reqs} req</span>
                    {latency > 0 && <span>{(latency / 1000).toFixed(1)}s avg</span>}
                    {app.last_seen && <span style={{ color }}>{timeAgo(app.last_seen)}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Queue Forecast (rolling per-worker rates from Bridge) */}
      {forecast?.forecast && forecast.workers && (
        <div data-ai-id="bridge-queue-forecast" style={{ marginBottom: 16 }}>
          <h4 style={{ fontSize: 11, fontWeight: 600, margin: '0 0 8px', color: 'var(--tn-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Queue Forecast — Bridge Workers (window {forecast.window_seconds ?? 120}s)
          </h4>
          {(() => {
            const f = forecast.forecast!;
            const totals = forecast.totals;
            const riskColor =
              f.rate_limit_risk === 'high' ? 'var(--tn-red)' :
              f.rate_limit_risk === 'medium' ? 'var(--tn-orange)' :
              'var(--tn-green)';
            const trendColor =
              f.backlog_trend === 'growing' ? 'var(--tn-red)' :
              f.backlog_trend === 'draining' ? 'var(--tn-green)' :
              'var(--tn-text-muted)';
            return (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8, marginBottom: 8 }}>
                {statCard('In-Flight', String(f.in_flight_total), f.in_flight_total > 5 ? 'var(--tn-orange)' : 'var(--tn-text)', '🔄', 'forecast-in-flight')}
                {statCard('Drain rate', `${f.drain_rate_per_s.toFixed(2)}/s`, 'var(--tn-blue)', '📉', 'forecast-drain')}
                {statCard('Arrival rate', `${f.arrival_rate_per_s.toFixed(2)}/s`, 'var(--tn-blue)', '📥', 'forecast-arrival')}
                {statCard('Trend', f.backlog_trend, trendColor, '📊', 'forecast-trend')}
                {statCard(
                  'Rate-limit risk',
                  `${f.rate_limit_risk}${f.active_workers != null ? ` (${f.active_workers} active)` : ''}`,
                  riskColor,
                  f.rate_limit_risk === 'high' ? '🚨' : f.rate_limit_risk === 'medium' ? '⚠️' : '✅',
                  'forecast-risk',
                )}
                {f.eta_empty_s != null && (
                  statCard(
                    'ETA queue empty',
                    f.eta_empty_s === 0 ? 'now' : `${f.eta_empty_s.toFixed(0)}s`,
                    'var(--tn-text)',
                    '⏳',
                    'forecast-eta',
                  )
                )}
                {totals && totals.input_tokens_per_min > 0 && (
                  statCard('Input tok/min', formatNumber(totals.input_tokens_per_min), 'var(--tn-text-muted)', '📝', 'forecast-input-tpm')
                )}
                {totals && totals.output_tokens_per_min > 0 && (
                  statCard('Output tok/min', formatNumber(totals.output_tokens_per_min), 'var(--tn-text-muted)', '✏️', 'forecast-output-tpm')
                )}
              </div>
            );
          })()}

          {/* Per-worker rows */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {Object.keys(forecast.workers ?? {}).map((w) => {
              const wd = forecast.workers?.[w];
              const limit = forecast.worker_limits?.[w];
              const sat = forecast.saturation?.[w];
              const satColor =
                sat === 'rate_limited' ? 'var(--tn-red)' :
                sat === 'saturated' ? 'var(--tn-orange)' :
                sat === 'busy' ? 'var(--tn-orange)' :
                sat === 'ok' ? 'var(--tn-green)' :
                'var(--tn-text-muted)';
              const downByLimit = limit && !limit.active;
              return (
                <div key={w} style={{
                  display: 'grid',
                  gridTemplateColumns: '70px 1fr 1fr 1fr 90px 90px',
                  alignItems: 'center', gap: 8,
                  padding: '6px 10px',
                  background: downByLimit ? 'rgba(247,118,142,0.05)' : 'var(--tn-bg-dark)',
                  border: `1px solid ${downByLimit ? 'rgba(247,118,142,0.3)' : 'var(--tn-border)'}`,
                  borderLeft: `3px solid ${downByLimit ? 'var(--tn-red)' : satColor}`,
                  borderRadius: 4,
                  fontSize: 10, fontFamily: 'monospace',
                }}>
                  <span style={{ fontWeight: 600, color: 'var(--tn-text)' }}>{w}</span>
                  <span style={{ color: 'var(--tn-text-muted)' }}>
                    {limit ? `${limit.account} W:${limit.weekly_percent}% S:${limit.session_percent}%` : '-'}
                  </span>
                  <span style={{ color: 'var(--tn-text-muted)' }}>
                    in:{wd?.in_flight ?? 0} · arr:{(wd?.arrivals_per_min ?? 0).toFixed(1)}/m · done:{(wd?.completions_per_min ?? 0).toFixed(1)}/m
                  </span>
                  <span style={{ color: 'var(--tn-text-muted)' }}>
                    {wd?.avg_duration_ms ? `${(wd.avg_duration_ms / 1000).toFixed(1)}s avg` : '-'}
                  </span>
                  <span style={{ color: (wd?.errors ?? 0) > 0 ? 'var(--tn-orange)' : 'var(--tn-text-muted)' }}>
                    err:{wd?.errors ?? 0}{(wd?.rate_limit_hits ?? 0) > 0 ? ` rl:${wd?.rate_limit_hits}` : ''}
                  </span>
                  <span style={{ color: satColor, fontWeight: 600, textAlign: 'right' }}>
                    {downByLimit ? 'DOWN' : (sat ?? 'idle').toUpperCase()}
                  </span>
                </div>
              );
            })}
          </div>
          <div style={{ fontSize: 9, color: 'var(--tn-text-dim)', marginTop: 4, fontStyle: 'italic' }}>
            Note: Rolling-rates only include the worker that served this request. Refresh for cross-worker view.
          </div>
        </div>
      )}

      {/* AI-Guard Status */}
      {data?.guard && (
        <div data-ai-id="bridge-guard-section" style={{ marginBottom: 16 }}>
          <h4 style={{ fontSize: 11, fontWeight: 600, margin: '0 0 8px', color: 'var(--tn-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            AI-Guard {data.guard.running ? '(Active)' : '(Offline)'}
          </h4>
          {data.guard.running && data.guard.slots ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {/* Slot bars */}
              {Object.entries(data.guard.slots).map(([type, slot]) => (
                <div key={type} style={{
                  padding: '8px 12px', background: 'var(--tn-bg-dark)',
                  border: '1px solid var(--tn-border)', borderRadius: 6,
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--tn-text)', fontFamily: 'monospace' }}>
                      {type}
                    </span>
                    <span style={{
                      fontSize: 9, fontWeight: 700, color: slot.active > 0 ? 'var(--tn-orange)' : 'var(--tn-text-muted)',
                    }}>
                      {slot.active}/{slot.max}
                    </span>
                  </div>
                  {/* Visual bar */}
                  <div style={{ display: 'flex', gap: 2, height: 6 }}>
                    {Array.from({ length: slot.max }, (_, i) => (
                      <div key={i} style={{
                        flex: 1, borderRadius: 2,
                        background: i < slot.active ? 'var(--tn-orange)' : 'rgba(158,206,106,0.2)',
                      }} />
                    ))}
                  </div>
                  {/* Active callers */}
                  {slot.requests.length > 0 && (
                    <div style={{ marginTop: 4, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {slot.requests.map((r, i) => (
                        <span key={i} style={{
                          fontSize: 8, padding: '1px 4px', borderRadius: 2,
                          background: 'rgba(122,162,247,0.15)', color: 'var(--tn-blue)',
                          fontFamily: 'monospace',
                        }}>
                          {r.caller} ({r.duration}s)
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              {/* Queue */}
              {(data.guard.queueLength ?? 0) > 0 && data.guard.queue && (
                <div style={{
                  padding: '6px 12px', background: 'rgba(224,175,104,0.1)',
                  border: '1px solid rgba(224,175,104,0.3)', borderRadius: 6,
                  fontSize: 9, color: 'var(--tn-orange)',
                }}>
                  <strong>Queue ({data.guard.queueLength}):</strong>{' '}
                  {data.guard.queue.map((q, i) => (
                    <span key={i} style={{ marginLeft: 4, fontFamily: 'monospace' }}>
                      {q.caller}({q.type}, {q.waitSeconds}s)
                    </span>
                  ))}
                </div>
              )}
              {/* Guard metrics */}
              {data.guard.metrics && (
                <div style={{ display: 'flex', gap: 12, fontSize: 9, color: 'var(--tn-text-muted)', paddingTop: 4 }}>
                  <span>Total: {data.guard.metrics.totalRequests}</span>
                  <span>Completed: {data.guard.metrics.totalCompleted}</span>
                  {data.guard.metrics.totalPreempted > 0 && (
                    <span style={{ color: 'var(--tn-orange)' }}>Preempted: {data.guard.metrics.totalPreempted}</span>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div style={{
              padding: '8px 12px', background: 'rgba(247,118,142,0.1)',
              border: '1px solid rgba(247,118,142,0.2)', borderRadius: 6,
              fontSize: 10, color: 'var(--tn-red)',
            }}>
              AI-Guard is offline — Bridge calls go directly to Hetzner without concurrency control
            </div>
          )}
        </div>
      )}

      {/* Performance Stats */}
      {data && (() => {
        const successRate = data.success_rate ?? data.successRate ?? 0;
        return (<>
          <div data-ai-id="bridge-overview-performance-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 20 }}>
            {statCard('Success Rate', `${successRate.toFixed(1)}%`,
              successRate >= 99 ? 'var(--tn-green)' : successRate >= 95 ? 'var(--tn-orange)' : 'var(--tn-red)',
              successRate >= 99 ? '✅' : successRate >= 95 ? '⚠️' : '❌',
              'bridge-overview-success-rate-stat')}
            {statCard('Rate Limited', data.rate_limited ? 'Yes' : 'No',
              data.rate_limited ? 'var(--tn-red)' : 'var(--tn-green)',
              data.rate_limited ? '🚨' : '✅', 'bridge-overview-rate-limit-stat')}
            {statCard('Can Accept', data.can_accept_requests ? 'Yes' : 'No',
              data.can_accept_requests ? 'var(--tn-green)' : 'var(--tn-red)',
              data.can_accept_requests ? '✅' : '❌', 'bridge-overview-accept-stat')}
          </div>
          <div data-ai-id="bridge-overview-timestamp" style={{ fontSize: 9, color: 'var(--tn-text-muted)', textAlign: 'right' }}>
            Last updated: {new Date(data.timestamp).toLocaleString()}
          </div>
        </>);
      })()}
    </div>
  );
}
