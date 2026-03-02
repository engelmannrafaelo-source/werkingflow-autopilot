import { useState, useEffect, useCallback } from 'react';
import { bridgeJson, StatusBadge, Toolbar, ErrorBanner, LoadingSpinner, SectionFlat, timeAgo } from '../shared';

interface LogEntry {
  timestamp: string;
  method: string;
  endpoint: string;
  status: number;
  duration_ms: number;
  model?: string;
  tokens?: number;
  error?: string;
}

interface LogStats {
  total_requests: number;
  success_rate: number;
  avg_duration_ms: number;
  errors_24h: number;
}

export default function LogsTab() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [stats, setStats] = useState<LogStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [statusFilter, setStatusFilter] = useState<'all' | 'success' | 'error'>('all');
  const [searchTerm, setSearchTerm] = useState('');

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      // Simulate log fetching - in reality this would call Bridge API endpoints
      // For now, we'll use session/usage data as proxy until real logs endpoint exists
      const [sessionsRes] = await Promise.allSettled([
        bridgeJson<{ sessions: any[] }>('/v1/sessions', { timeout: 10000 }),
      ]);

      // Mock logs from sessions data
      if (sessionsRes.status === 'fulfilled') {
        const sessions = sessionsRes.value.sessions ?? [];

        // Convert sessions to log-like entries
        const mockLogs: LogEntry[] = sessions.slice(0, 50).map((s: any, idx: number) => ({
          timestamp: s.created_at || new Date().toISOString(),
          method: 'POST',
          endpoint: '/v1/messages',
          status: s.status === 'completed' ? 200 : s.status === 'failed' ? 500 : 202,
          duration_ms: s.duration_seconds ? s.duration_seconds * 1000 : Math.random() * 5000,
          model: s.model || 'unknown',
          tokens: s.total_tokens,
        }));

        setLogs(mockLogs);

        // Calculate stats
        const successCount = mockLogs.filter(l => l.status < 400).length;
        const avgDuration = mockLogs.reduce((sum, l) => sum + l.duration_ms, 0) / mockLogs.length;
        const errorCount = mockLogs.filter(l => l.status >= 400).length;

        setStats({
          total_requests: mockLogs.length,
          success_rate: (successCount / mockLogs.length) * 100,
          avg_duration_ms: avgDuration,
          errors_24h: errorCount,
        });
      } else {
        // Fallback: empty logs
        setLogs([]);
        setStats({
          total_requests: 0,
          success_rate: 0,
          avg_duration_ms: 0,
          errors_24h: 0,
        });
      }

      setLastRefresh(new Date());
    } catch (err: any) {
      setError(err.message || 'Failed to load logs');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 15000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  // Filter logs
  const filteredLogs = logs.filter(log => {
    if (statusFilter === 'success' && log.status >= 400) return false;
    if (statusFilter === 'error' && log.status < 400) return false;
    if (searchTerm && !log.endpoint.toLowerCase().includes(searchTerm.toLowerCase())) return false;
    return true;
  });

  if (loading) return <LoadingSpinner />;
  if (error) return <ErrorBanner message={error} onRetry={fetchAll} />;

  return (
    <div style={{ padding: '16px 12px', overflowY: 'auto', height: '100%' }}>
      <Toolbar onRefresh={fetchAll} lastRefresh={lastRefresh} />

      {/* Stats Cards */}
      {stats && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 16 }}>
          <div style={{ padding: 12, background: 'var(--tn-surface)', borderRadius: 4, border: '1px solid var(--tn-border)' }}>
            <div style={{ fontSize: 11, color: 'var(--tn-text-dim)', marginBottom: 4 }}>Total Requests</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--tn-text)' }}>{stats.total_requests}</div>
          </div>
          <div style={{ padding: 12, background: 'var(--tn-surface)', borderRadius: 4, border: '1px solid var(--tn-border)' }}>
            <div style={{ fontSize: 11, color: 'var(--tn-text-dim)', marginBottom: 4 }}>Success Rate</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: stats.success_rate >= 95 ? 'var(--tn-green)' : 'var(--tn-yellow)' }}>
              {stats.success_rate.toFixed(1)}%
            </div>
          </div>
          <div style={{ padding: 12, background: 'var(--tn-surface)', borderRadius: 4, border: '1px solid var(--tn-border)' }}>
            <div style={{ fontSize: 11, color: 'var(--tn-text-dim)', marginBottom: 4 }}>Avg Duration</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--tn-text)' }}>{stats.avg_duration_ms.toFixed(0)}ms</div>
          </div>
          <div style={{ padding: 12, background: 'var(--tn-surface)', borderRadius: 4, border: '1px solid var(--tn-border)' }}>
            <div style={{ fontSize: 11, color: 'var(--tn-text-dim)', marginBottom: 4 }}>Errors (24h)</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: stats.errors_24h > 0 ? 'var(--tn-red)' : 'var(--tn-green)' }}>
              {stats.errors_24h}
            </div>
          </div>
        </div>
      )}

      {/* Filters */}
      <div style={{ marginBottom: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
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

      {/* Logs Table */}
      <SectionFlat title={`Request Logs (${filteredLogs.length})`}>
        {filteredLogs.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--tn-text-dim)', fontSize: 13 }}>
            No log entries found
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
            <thead>
              <tr style={{ background: 'var(--tn-bg-dark)', textAlign: 'left' }}>
                <th style={{ padding: '8px 12px', fontWeight: 600, color: 'var(--tn-text-dim)' }}>Time</th>
                <th style={{ padding: '8px 12px', fontWeight: 600, color: 'var(--tn-text-dim)' }}>Method</th>
                <th style={{ padding: '8px 12px', fontWeight: 600, color: 'var(--tn-text-dim)' }}>Endpoint</th>
                <th style={{ padding: '8px 12px', fontWeight: 600, color: 'var(--tn-text-dim)' }}>Status</th>
                <th style={{ padding: '8px 12px', fontWeight: 600, color: 'var(--tn-text-dim)' }}>Duration</th>
                <th style={{ padding: '8px 12px', fontWeight: 600, color: 'var(--tn-text-dim)' }}>Model</th>
              </tr>
            </thead>
            <tbody>
              {filteredLogs.map((log, idx) => (
                <tr
                  key={idx}
                  style={{
                    background: idx % 2 === 0 ? 'var(--tn-surface)' : 'var(--tn-bg)',
                    borderBottom: '1px solid var(--tn-border)',
                  }}
                >
                  <td style={{ padding: '8px 12px', color: 'var(--tn-text-dim)', fontFamily: 'monospace' }}>
                    {timeAgo(log.timestamp)}
                  </td>
                  <td style={{ padding: '8px 12px', color: 'var(--tn-text)', fontFamily: 'monospace' }}>
                    {log.method}
                  </td>
                  <td style={{ padding: '8px 12px', color: 'var(--tn-text)', fontFamily: 'monospace' }}>
                    {log.endpoint}
                  </td>
                  <td style={{ padding: '8px 12px' }}>
                    <StatusBadge
                      status={log.status < 400 ? 'ok' : 'error'}
                      label={log.status.toString()}
                    />
                  </td>
                  <td style={{ padding: '8px 12px', color: 'var(--tn-text)', fontFamily: 'monospace' }}>
                    {log.duration_ms.toFixed(0)}ms
                  </td>
                  <td style={{ padding: '8px 12px', color: 'var(--tn-text-dim)', fontSize: 10 }}>
                    {log.model || '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SectionFlat>

      <div style={{ marginTop: 12, padding: 12, background: 'var(--tn-bg-dark)', borderRadius: 4, fontSize: 11, color: 'var(--tn-text-dim)' }}>
        <strong>Note:</strong> Currently showing session data as proxy logs. Full HTTP request logs require Bridge API extension.
      </div>
    </div>
  );
}
