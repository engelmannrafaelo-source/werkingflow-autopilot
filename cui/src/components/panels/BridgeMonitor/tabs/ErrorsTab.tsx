import { useState, useEffect, useCallback } from 'react';
import { Toolbar, ErrorBanner, LoadingSpinner, timeAgo } from '../shared';

interface ErrorEntry {
  ts: string;
  ts_epoch: number;
  method: string;
  uri: string;
  status: number;
  req_time: number;
  upstream_addr: string;
  upstream_status: string;
  upstream_resp_time: string;
  pool: string;
  priority: string;
  app_id: string;
  user_id: string;
  workflow_id: string;
  job_id: string;
  agent_id: string;
  _source: 'dev' | 'prod';
}

interface ErrorsResponse {
  entries: ErrorEntry[];
  total_matched: number;
  returned: number;
  summary: {
    byStatus: Record<string, number>;
    byEndpoint: Record<string, number>;
    byApp: Record<string, number>;
    byUpstream: Record<string, number>;
  };
  sources: Record<string, { present: boolean; mtime: number | null; bytes: number }>;
  query: { hours: number; minStatus: number; limit: number; endpoint: string; app: string; bridge: string };
  _error?: string;
}

function statusColor(status: number): string {
  if (status >= 500) return '#ef4444'; // red
  if (status >= 400) return '#f59e0b'; // amber
  return '#10b981'; // green
}

function failoverSummary(upstream: string): { tried: number; chain: string } {
  // nginx logs upstream_addr as comma-separated chain when failover happened
  const parts = String(upstream || '').split(',').map((s) => s.trim()).filter(Boolean);
  return { tried: parts.length, chain: parts.join(' → ') };
}

export default function ErrorsTab() {
  const [data, setData] = useState<ErrorsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [hours, setHours] = useState(24);
  const [minStatus, setMinStatus] = useState(400);
  const [endpointFilter, setEndpointFilter] = useState('');
  const [appFilter, setAppFilter] = useState('');
  const [bridgeFilter, setBridgeFilter] = useState<'all' | 'dev' | 'prod'>('all');
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({
        hours: String(hours),
        min_status: String(minStatus),
        limit: '500',
      });
      if (endpointFilter) params.set('endpoint', endpointFilter);
      if (appFilter) params.set('app', appFilter);
      if (bridgeFilter !== 'all') params.set('bridge', bridgeFilter);
      const res = await fetch(`/api/bridge/errors?${params}`, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as ErrorsResponse;
      if (json._error) throw new Error(json._error);
      setData(json);
      setLastRefresh(new Date());
    } catch (e: any) {
      setError(e?.message || 'Fehler beim Laden');
    } finally {
      setLoading(false);
    }
  }, [hours, minStatus, endpointFilter, appFilter, bridgeFilter]);

  useEffect(() => {
    fetchData();
    const t = setInterval(fetchData, 30000);
    return () => clearInterval(t);
  }, [fetchData]);

  return (
    <div data-ai-id="bridge-monitor-errors-tab" style={{ padding: 16 }}>
      <Toolbar lastRefresh={lastRefresh} loading={loading} onRefresh={fetchData} />

      {/* Filter-Leiste */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <label style={{ fontSize: 12, color: 'var(--tn-text-muted)' }}>
          Zeitraum:{' '}
          <select
            data-ai-id="errors-hours-filter"
            value={hours}
            onChange={(e) => setHours(Number(e.target.value))}
            style={{ background: 'var(--tn-bg-2)', color: 'var(--tn-text)', border: '1px solid var(--tn-border)', padding: '4px 8px' }}
          >
            <option value={1}>1h</option>
            <option value={6}>6h</option>
            <option value={24}>24h</option>
            <option value={72}>3d</option>
            <option value={168}>7d</option>
          </select>
        </label>

        <label style={{ fontSize: 12, color: 'var(--tn-text-muted)' }}>
          Min-Status:{' '}
          <select
            data-ai-id="errors-min-status-filter"
            value={minStatus}
            onChange={(e) => setMinStatus(Number(e.target.value))}
            style={{ background: 'var(--tn-bg-2)', color: 'var(--tn-text)', border: '1px solid var(--tn-border)', padding: '4px 8px' }}
          >
            <option value={400}>4xx + 5xx</option>
            <option value={500}>nur 5xx</option>
            <option value={200}>alle Requests</option>
          </select>
        </label>

        <label style={{ fontSize: 12, color: 'var(--tn-text-muted)' }}>
          Bridge:{' '}
          <select
            data-ai-id="errors-bridge-filter"
            value={bridgeFilter}
            onChange={(e) => setBridgeFilter(e.target.value as 'all' | 'dev' | 'prod')}
            style={{ background: 'var(--tn-bg-2)', color: 'var(--tn-text)', border: '1px solid var(--tn-border)', padding: '4px 8px' }}
          >
            <option value="all">alle</option>
            <option value="dev">dev (primary)</option>
            <option value="prod">prod (reserve)</option>
          </select>
        </label>

        <input
          data-ai-id="errors-endpoint-filter"
          type="text"
          placeholder="Endpoint enthält…"
          value={endpointFilter}
          onChange={(e) => setEndpointFilter(e.target.value)}
          style={{ background: 'var(--tn-bg-2)', color: 'var(--tn-text)', border: '1px solid var(--tn-border)', padding: '4px 8px', fontSize: 12, minWidth: 180 }}
        />

        <input
          data-ai-id="errors-app-filter"
          type="text"
          placeholder="App-ID (z.B. cui, report)"
          value={appFilter}
          onChange={(e) => setAppFilter(e.target.value)}
          style={{ background: 'var(--tn-bg-2)', color: 'var(--tn-text)', border: '1px solid var(--tn-border)', padding: '4px 8px', fontSize: 12, minWidth: 160 }}
        />
      </div>

      {error && <ErrorBanner message={error} onRetry={fetchData} />}
      {loading && !data && <LoadingSpinner text="Lade Error-Logs…" />}

      {data && (
        <>
          {/* Source-Status */}
          <div
            data-ai-id="errors-source-status"
            style={{ display: 'flex', gap: 16, marginBottom: 12, fontSize: 12, color: 'var(--tn-text-muted)' }}
          >
            {Object.entries(data.sources).map(([label, stat]) => (
              <div key={label}>
                <strong style={{ color: stat.present ? 'var(--tn-text)' : '#ef4444' }}>{label.toUpperCase()}</strong>:{' '}
                {stat.present
                  ? `${(stat.bytes / 1024 / 1024).toFixed(1)} MB · zuletzt gesynct ${stat.mtime ? timeAgo(new Date(stat.mtime).toISOString()) : 'nie'}`
                  : 'nicht vorhanden'}
              </div>
            ))}
          </div>

          {/* Summary */}
          <div
            data-ai-id="errors-summary"
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
              gap: 12,
              marginBottom: 16,
            }}
          >
            <div style={{ background: 'var(--tn-bg-2)', padding: 12, borderRadius: 4 }}>
              <div style={{ fontSize: 11, color: 'var(--tn-text-muted)', marginBottom: 4 }}>NACH STATUS</div>
              {Object.entries(data.summary.byStatus)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 6)
                .map(([s, n]) => (
                  <div key={s} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                    <span style={{ color: statusColor(Number(s)) }}>{s}</span>
                    <span>{n}</span>
                  </div>
                ))}
            </div>

            <div style={{ background: 'var(--tn-bg-2)', padding: 12, borderRadius: 4 }}>
              <div style={{ fontSize: 11, color: 'var(--tn-text-muted)', marginBottom: 4 }}>TOP-ENDPOINTS</div>
              {Object.entries(data.summary.byEndpoint)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 6)
                .map(([ep, n]) => (
                  <div key={ep} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, gap: 8 }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={ep}>
                      {ep}
                    </span>
                    <span>{n}</span>
                  </div>
                ))}
            </div>

            <div style={{ background: 'var(--tn-bg-2)', padding: 12, borderRadius: 4 }}>
              <div style={{ fontSize: 11, color: 'var(--tn-text-muted)', marginBottom: 4 }}>NACH APP</div>
              {Object.entries(data.summary.byApp)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 6)
                .map(([app, n]) => (
                  <div key={app} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                    <span>{app}</span>
                    <span>{n}</span>
                  </div>
                ))}
              {Object.keys(data.summary.byApp).length === 0 && (
                <div style={{ fontSize: 12, color: 'var(--tn-text-muted)' }}>— keine App-IDs erfasst —</div>
              )}
            </div>

            <div style={{ background: 'var(--tn-bg-2)', padding: 12, borderRadius: 4 }}>
              <div style={{ fontSize: 11, color: 'var(--tn-text-muted)', marginBottom: 4 }}>NACH UPSTREAM</div>
              {Object.entries(data.summary.byUpstream)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 6)
                .map(([u, n]) => (
                  <div key={u} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                    <span style={{ fontFamily: 'monospace', fontSize: 11 }}>{u}</span>
                    <span>{n}</span>
                  </div>
                ))}
            </div>
          </div>

          {/* Error-Tabelle */}
          <div style={{ fontSize: 12, color: 'var(--tn-text-muted)', marginBottom: 8 }}>
            {data.total_matched} Einträge · zeige {data.returned}
          </div>
          <div
            data-ai-id="errors-table"
            style={{
              background: 'var(--tn-bg-2)',
              borderRadius: 4,
              overflow: 'hidden',
              fontSize: 12,
            }}
          >
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '110px 60px 60px 1fr 70px 90px 120px 60px',
                gap: 8,
                padding: '8px 12px',
                background: 'var(--tn-bg-3)',
                fontWeight: 600,
                fontSize: 11,
              }}
            >
              <div>ZEIT</div>
              <div>QUELLE</div>
              <div>STATUS</div>
              <div>URI</div>
              <div>METHOD</div>
              <div>DAUER</div>
              <div>UPSTREAM</div>
              <div>APP</div>
            </div>
            {data.entries.length === 0 && (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--tn-text-muted)' }}>
                Keine Errors im gewählten Zeitraum — fehlerfrei!
              </div>
            )}
            {data.entries.map((e, idx) => {
              const isExpanded = expandedIdx === idx;
              const fo = failoverSummary(e.upstream_addr);
              return (
                <div key={idx} style={{ borderTop: '1px solid var(--tn-border)' }}>
                  <div
                    data-ai-id={`errors-row-${idx}`}
                    onClick={() => setExpandedIdx(isExpanded ? null : idx)}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '110px 60px 60px 1fr 70px 90px 120px 60px',
                      gap: 8,
                      padding: '6px 12px',
                      cursor: 'pointer',
                      alignItems: 'center',
                    }}
                  >
                    <div style={{ fontFamily: 'monospace', fontSize: 11 }}>{timeAgo(e.ts)}</div>
                    <div>
                      <span
                        style={{
                          background: e._source === 'prod' ? '#7c3aed' : '#2563eb',
                          color: '#fff',
                          padding: '1px 6px',
                          borderRadius: 3,
                          fontSize: 10,
                          fontWeight: 600,
                        }}
                      >
                        {e._source}
                      </span>
                    </div>
                    <div style={{ color: statusColor(e.status), fontWeight: 600 }}>{e.status}</div>
                    <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={e.uri}>
                      {e.uri}
                    </div>
                    <div style={{ fontFamily: 'monospace', fontSize: 11 }}>{e.method}</div>
                    <div>{Number(e.req_time).toFixed(2)}s</div>
                    <div style={{ fontFamily: 'monospace', fontSize: 11, color: fo.tried > 1 ? '#f59e0b' : undefined }} title={fo.chain}>
                      {fo.tried > 1 ? `${fo.tried}× failover` : e.upstream_addr || '—'}
                    </div>
                    <div>{e.app_id || '—'}</div>
                  </div>
                  {isExpanded && (
                    <div style={{ padding: '12px 16px', background: 'var(--tn-bg-1)', fontSize: 11, fontFamily: 'monospace' }}>
                      <div>ts: {e.ts}</div>
                      <div>upstream_addr: {e.upstream_addr}</div>
                      <div>upstream_status: {e.upstream_status}</div>
                      <div>upstream_resp_time: {e.upstream_resp_time}</div>
                      <div>pool: {e.pool}</div>
                      <div>priority: {e.priority || '(default)'}</div>
                      <div>user_id: {e.user_id || '—'}</div>
                      <div>workflow_id: {e.workflow_id || '—'}</div>
                      <div>job_id: {e.job_id || '—'}</div>
                      <div>agent_id: {e.agent_id || '—'}</div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
