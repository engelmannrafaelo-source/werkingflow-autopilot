import { useState, useEffect, useCallback } from 'react';

interface OverviewData {
  health?: string;
  worker?: string;
  uptime_hours?: number;
  total_requests?: number;
  totalRequests?: number;
  avg_response_time?: number;
  avgResponseTime?: number;
  success_rate?: number;
  successRate?: number;
  active_sessions?: number;
  timestamp?: string;
  _error?: string;
  _note?: string;
}

interface AppInfo {
  app_id: string;
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

export default function OverviewTab() {
  const [data, setData] = useState<OverviewData | null>(null);
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const fetchData = useCallback(async () => {
    if ((window as any).__cuiServerAlive === false) return;
    setLoading(true);
    setError('');
    try {
      const [overviewRes, appsRes] = await Promise.allSettled([
        fetch('/api/bridge/metrics/overview', { signal: AbortSignal.timeout(20000) }).then(r => r.json()),
        fetch('/api/bridge/metrics/apps', { signal: AbortSignal.timeout(10000) }).then(r => r.json()),
      ]);

      if (overviewRes.status === 'fulfilled') {
        if (overviewRes.value._error) setError(overviewRes.value._error);
        else setData(overviewRes.value);
      } else {
        setError('Bridge nicht erreichbar');
      }

      if (appsRes.status === 'fulfilled') {
        const appsData = appsRes.value as AppsResponse;
        setApps(appsData.apps_realtime ?? appsData.apps_period ?? []);
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

  const formatNumber = (num: number) => {
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
          const health = data.health ?? 'unknown';
          const worker = data.worker ?? '-';
          const uptime = data.uptime_hours ?? 0;
          const totalReqs = data.total_requests ?? data.totalRequests ?? 0;
          const sessions = data.active_sessions ?? 0;
          return (<>
            {statCard('Health', health, health === 'healthy' ? 'var(--tn-green)' : 'var(--tn-red)', health === 'healthy' ? '✅' : '⚠️', 'bridge-overview-health-stat')}
            {statCard('Worker', worker, 'var(--tn-blue)', '🔧', 'bridge-overview-worker-stat')}
            {statCard('Uptime', `${uptime}h`, 'var(--tn-purple, #bb9af7)', '⏱️', 'bridge-overview-uptime-stat')}
            {statCard('Total Requests', formatNumber(totalReqs), 'var(--tn-blue)', '📊', 'bridge-overview-requests-stat')}
            {statCard('Active Sessions', String(sessions), 'var(--tn-orange)', '⚡', 'bridge-overview-sessions-stat')}
          </>);
        })() : (
          <div style={{ gridColumn: '1 / -1', padding: 20, textAlign: 'center', color: 'var(--tn-text-dim)', fontSize: 12 }}>
            No overview data available
          </div>
        )}
      </div>

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
                <div key={app.app_id} style={{
                  padding: '8px 12px', background: 'var(--tn-bg-dark)',
                  border: '1px solid var(--tn-border)', borderRadius: 6,
                  borderLeft: `3px solid ${color}`, minWidth: 130,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                    <div style={{ width: 6, height: 6, borderRadius: '50%', background: color }} />
                    <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--tn-text)', fontFamily: 'monospace' }}>
                      {app.app_id}
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

      {/* Performance Stats */}
      {data && (() => {
        const avgResp = data.avg_response_time ?? data.avgResponseTime ?? 0;
        const successRate = data.success_rate ?? data.successRate ?? 0;
        return (<>
          <div data-ai-id="bridge-overview-performance-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10, marginBottom: 20 }}>
            {statCard('Avg Response Time', `${avgResp.toFixed(2)}s`, 'var(--tn-text)', '⏱️', 'bridge-overview-response-time-stat')}
            {statCard('Success Rate', `${successRate.toFixed(1)}%`,
              successRate >= 99 ? 'var(--tn-green)' : successRate >= 95 ? 'var(--tn-orange)' : 'var(--tn-red)',
              successRate >= 99 ? '✅' : successRate >= 95 ? '⚠️' : '❌',
              'bridge-overview-success-rate-stat')}
          </div>
          <div data-ai-id="bridge-overview-timestamp" style={{ fontSize: 9, color: 'var(--tn-text-muted)', textAlign: 'right' }}>
            Last updated: {data.timestamp ? new Date(data.timestamp).toLocaleString() : 'N/A'}
          </div>
        </>);
      })()}
    </div>
  );
}
