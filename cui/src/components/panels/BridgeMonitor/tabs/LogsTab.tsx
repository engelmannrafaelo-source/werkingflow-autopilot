import { useState, useEffect, useCallback } from 'react';
import { bridgeJson, StatusBadge, Toolbar, ErrorBanner, LoadingSpinner, SectionFlat, timeAgo } from '../shared';

interface LogEntry {
  ts: number;
  method: string;
  endpoint: string;
  status: number;
  duration_s: number;
  worker?: string;
  app_id?: string;
  user_id?: string;
  error?: string;
}

interface RequestLogResponse {
  entries: LogEntry[];
  total: number;
  period_hours: number;
}

export default function LogsTab() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [statusFilter, setStatusFilter] = useState<'all' | 'success' | 'error'>('all');
  const [searchTerm, setSearchTerm] = useState('');

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await bridgeJson<RequestLogResponse>(
        '/v1/metrics/request-log?hours=24&limit=200',
        { timeout: 15000 }
      );

      if (!data || !Array.isArray(data.entries)) {
        throw new Error('Invalid response from /v1/metrics/request-log');
      }

      setEntries(data.entries);
      setTotal(data.total ?? data.entries.length);
      setLastRefresh(new Date());
    } catch (err: any) {
      setError(err.message || 'Failed to load request log');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 15000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  const filteredEntries = entries.filter(entry => {
    if (statusFilter === 'success' && entry.status >= 400) return false;
    if (statusFilter === 'error' && entry.status < 400) return false;
    if (searchTerm && !entry.endpoint.toLowerCase().includes(searchTerm.toLowerCase())) return false;
    return true;
  });

  const successCount = entries.filter(e => e.status < 400).length;
  const errorCount = entries.filter(e => e.status >= 400).length;
  const avgDuration = entries.length > 0
    ? entries.reduce((sum, e) => sum + (e.duration_s ?? 0), 0) / entries.length
    : 0;

  return (
    <div data-ai-id="logs-tab-content" style={{ padding: '16px 12px', overflowY: 'auto', height: '100%' }}>
      <Toolbar onRefresh={fetchAll} lastRefresh={lastRefresh} />

      {loading && <LoadingSpinner />}
      {error && <ErrorBanner message={error} onRetry={fetchAll} />}

      {/* Filters */}
      <div data-ai-id="logs-filters" style={{ marginBottom: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          data-ai-id="logs-search-input"
          type="text"
          placeholder="Search endpoint..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          style={{
            flex: 1,
            padding: '6px 12px',
            background: 'var(--tn-surface)',
            border: '1px solid var(--tn-border)',
            borderRadius: 4,
            color: 'var(--tn-text)',
            fontSize: 12,
          }}
        />
        <select
          data-ai-id="logs-status-filter"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as any)}
          style={{
            padding: '6px 12px',
            background: 'var(--tn-surface)',
            border: '1px solid var(--tn-border)',
            borderRadius: 4,
            color: 'var(--tn-text)',
            fontSize: 12,
          }}
        >
          <option value="all">All Status</option>
          <option value="success">Success Only</option>
          <option value="error">Errors Only</option>
        </select>
      </div>

      {/* Stats Cards */}
      {!loading && !error && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 16 }}>
          <div style={{ padding: 12, background: 'var(--tn-surface)', borderRadius: 4, border: '1px solid var(--tn-border)' }}>
            <div style={{ fontSize: 11, color: 'var(--tn-text-dim)', marginBottom: 4 }}>Total (24h)</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--tn-text)' }}>{total}</div>
          </div>
          <div style={{ padding: 12, background: 'var(--tn-surface)', borderRadius: 4, border: '1px solid var(--tn-border)' }}>
            <div style={{ fontSize: 11, color: 'var(--tn-text-dim)', marginBottom: 4 }}>Success Rate</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: entries.length > 0 && (successCount / entries.length) >= 0.95 ? 'var(--tn-green)' : 'var(--tn-yellow)' }}>
              {entries.length > 0 ? ((successCount / entries.length) * 100).toFixed(1) : '0'}%
            </div>
          </div>
          <div style={{ padding: 12, background: 'var(--tn-surface)', borderRadius: 4, border: '1px solid var(--tn-border)' }}>
            <div style={{ fontSize: 11, color: 'var(--tn-text-dim)', marginBottom: 4 }}>Avg Duration</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--tn-text)' }}>{(avgDuration * 1000).toFixed(0)}ms</div>
          </div>
          <div style={{ padding: 12, background: 'var(--tn-surface)', borderRadius: 4, border: '1px solid var(--tn-border)' }}>
            <div style={{ fontSize: 11, color: 'var(--tn-text-dim)', marginBottom: 4 }}>Errors (24h)</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: errorCount > 0 ? 'var(--tn-red)' : 'var(--tn-green)' }}>
              {errorCount}
            </div>
          </div>
        </div>
      )}

      {/* Logs Table */}
      <SectionFlat title={`Request Log (${filteredEntries.length} shown)`}>
        {filteredEntries.length === 0 ? (
          <div data-ai-id="logs-empty-state" style={{ padding: 24, textAlign: 'center', color: 'var(--tn-text-dim)', fontSize: 13 }}>
            No log entries found
          </div>
        ) : (
          <table data-ai-id="logs-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
            <thead>
              <tr style={{ background: 'var(--tn-bg-dark)', textAlign: 'left' }}>
                <th style={{ padding: '8px 12px', fontWeight: 600, color: 'var(--tn-text-dim)' }}>Time</th>
                <th style={{ padding: '8px 12px', fontWeight: 600, color: 'var(--tn-text-dim)' }}>Method</th>
                <th style={{ padding: '8px 12px', fontWeight: 600, color: 'var(--tn-text-dim)' }}>Endpoint</th>
                <th style={{ padding: '8px 12px', fontWeight: 600, color: 'var(--tn-text-dim)' }}>Status</th>
                <th style={{ padding: '8px 12px', fontWeight: 600, color: 'var(--tn-text-dim)' }}>Duration</th>
                <th style={{ padding: '8px 12px', fontWeight: 600, color: 'var(--tn-text-dim)' }}>Worker</th>
              </tr>
            </thead>
            <tbody>
              {filteredEntries.map((entry, idx) => (
                <tr
                  key={idx}
                  style={{
                    background: idx % 2 === 0 ? 'var(--tn-surface)' : 'var(--tn-bg)',
                    borderBottom: '1px solid var(--tn-border)',
                  }}
                >
                  <td style={{ padding: '8px 12px', color: 'var(--tn-text-dim)', fontFamily: 'monospace' }}>
                    {entry.ts ? timeAgo(new Date(entry.ts * 1000).toISOString()) : '-'}
                  </td>
                  <td style={{ padding: '8px 12px', color: 'var(--tn-text)', fontFamily: 'monospace' }}>
                    {entry.method}
                  </td>
                  <td style={{ padding: '8px 12px', color: 'var(--tn-text)', fontFamily: 'monospace' }}>
                    {entry.endpoint}
                  </td>
                  <td style={{ padding: '8px 12px' }}>
                    <StatusBadge
                      status={entry.status < 400 ? 'ok' : 'error'}
                      label={entry.status.toString()}
                    />
                  </td>
                  <td style={{ padding: '8px 12px', color: 'var(--tn-text)', fontFamily: 'monospace' }}>
                    {entry.duration_s != null ? `${(entry.duration_s * 1000).toFixed(0)}ms` : '-'}
                  </td>
                  <td style={{ padding: '8px 12px', color: 'var(--tn-text-dim)', fontSize: 10 }}>
                    {entry.worker || '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SectionFlat>
    </div>
  );
}
