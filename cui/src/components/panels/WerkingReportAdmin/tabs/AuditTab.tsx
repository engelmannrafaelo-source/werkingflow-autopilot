import { useState, useEffect, useCallback } from 'react';

interface AuditEntry {
  id: string;
  timestamp: string;
  action: string;
  actor: {
    id: string;
    email: string;
    ip: string;
  };
  resource: {
    type: string;
    id: string;
  };
  metadata: Record<string, any>;
  userAgent: string;
}

export default function AuditTab({ envMode }: { envMode?: string }) {
  const [logs, setLogs] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionFilter, setActionFilter] = useState('');
  const [limit, setLimit] = useState(50);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (actionFilter) params.set('action', actionFilter);
      params.set('limit', String(limit));
      const res = await fetch(`/api/admin/wr/audit?${params}`);
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setLogs(data.logs || data.entries || data || []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [actionFilter, limit]);

  useEffect(() => { fetchLogs(); }, [fetchLogs, envMode]);

  const uniqueActions = [...new Set(logs.map(l => l.action))].sort();

  const actionColor = (action: string) => {
    if (action.includes('delete') || action.includes('remove')) return 'var(--tn-red)';
    if (action.includes('create') || action.includes('add')) return 'var(--tn-green)';
    if (action.includes('update') || action.includes('edit')) return 'var(--tn-blue)';
    if (action.includes('login') || action.includes('auth')) return 'var(--tn-orange)';
    return 'var(--tn-text-muted)';
  };

  return (
    <div style={{ padding: 12 }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--tn-text)' }}>Audit Logs</span>
        <div style={{ flex: 1 }} />
        {uniqueActions.length > 0 && (
          <select value={actionFilter} onChange={e => setActionFilter(e.target.value)} style={{
            padding: '3px 6px', borderRadius: 3, fontSize: 10, background: 'var(--tn-bg)',
            border: '1px solid var(--tn-border)', color: 'var(--tn-text)', outline: 'none',
          }}>
            <option value="">All Actions</option>
            {uniqueActions.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
        )}
        <select value={String(limit)} onChange={e => setLimit(Number(e.target.value))} style={{
          padding: '3px 6px', borderRadius: 3, fontSize: 10, background: 'var(--tn-bg)',
          border: '1px solid var(--tn-border)', color: 'var(--tn-text)', outline: 'none',
        }}>
          <option value="25">25</option>
          <option value="50">50</option>
          <option value="100">100</option>
        </select>
        <button onClick={fetchLogs} style={{
          padding: '3px 10px', borderRadius: 3, fontSize: 10, cursor: 'pointer',
          background: 'var(--tn-bg)', border: '1px solid var(--tn-border)', color: 'var(--tn-text-muted)',
        }}>Refresh</button>
      </div>

      {error && <div style={{ padding: '4px 8px', fontSize: 11, color: 'var(--tn-red)', background: 'rgba(247,118,142,0.1)', borderRadius: 3, marginBottom: 8 }}>{error}</div>}
      {loading && <div style={{ padding: 20, textAlign: 'center', color: 'var(--tn-text-muted)', fontSize: 12 }}>Loading...</div>}

      {!loading && logs.length === 0 && (
        <div style={{ padding: 20, textAlign: 'center', color: 'var(--tn-text-muted)', fontSize: 11 }}>No audit logs found</div>
      )}

      {!loading && logs.length > 0 && (
        <div>
          <div style={{
            display: 'grid', gridTemplateColumns: '130px 120px 120px 100px 1fr',
            gap: 8, padding: '6px 10px', background: 'var(--tn-bg-dark)', borderRadius: 4,
            fontSize: 10, fontWeight: 600, color: 'var(--tn-text-muted)', marginBottom: 4,
          }}>
            <div>Timestamp</div><div>Action</div><div>User</div><div>Tenant</div><div>Details</div>
          </div>

          {logs.map(log => {
            const isExpanded = expandedId === log.id;
            return (
              <div key={log.id}>
                <div
                  onClick={() => setExpandedId(isExpanded ? null : log.id)}
                  style={{
                    display: 'grid', gridTemplateColumns: '130px 120px 120px 100px 1fr',
                    gap: 8, padding: '7px 10px', borderBottom: '1px solid var(--tn-border)',
                    fontSize: 11, alignItems: 'center', cursor: 'pointer',
                    background: isExpanded ? 'rgba(122,162,247,0.05)' : 'transparent',
                  }}
                >
                  <div style={{ color: 'var(--tn-text-muted)', fontSize: 10 }}>
                    {new Date(log.timestamp).toLocaleString('de-DE', {
                      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
                    })}
                  </div>
                  <div>
                    <span style={{
                      padding: '2px 6px', borderRadius: 3, fontSize: 9, fontWeight: 600,
                      color: actionColor(log.action),
                      background: `${actionColor(log.action)}15`,
                    }}>{log.action}</span>
                  </div>
                  <div style={{ color: 'var(--tn-text-subtle)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {log.userEmail || log.userId?.slice(0, 8) || '—'}
                  </div>
                  <div style={{ color: 'var(--tn-text-muted)', fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {log.tenantName || log.tenantId?.slice(0, 8) || '—'}
                  </div>
                  <div style={{ color: 'var(--tn-text-muted)', fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {typeof log.details === 'string' ? log.details : log.details ? JSON.stringify(log.details).slice(0, 80) : '—'}
                  </div>
                </div>
                {isExpanded && log.details && (
                  <div style={{
                    padding: '8px 10px', background: 'var(--tn-bg-dark)', borderBottom: '1px solid var(--tn-border)',
                  }}>
                    <pre style={{
                      margin: 0, fontSize: 10, color: 'var(--tn-text)', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                    }}>
                      {typeof log.details === 'string' ? log.details : JSON.stringify(log.details, null, 2)}
                    </pre>
                    {log.ipAddress && <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', marginTop: 4 }}>IP: {log.ipAddress}</div>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
