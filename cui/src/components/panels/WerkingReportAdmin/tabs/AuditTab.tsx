import { useState, useEffect, useCallback } from 'react';
import ExportButton from '@/components/shared/ExportButton';

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
  // Alternative field names from backend
  userId?: string;
  userEmail?: string;
  tenantId?: string;
  tenantName?: string;
  ipAddress?: string;
  details?: any;
}

export default function AuditTab({ envMode }: { envMode?: string }) {
  const [logs, setLogs] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Filters
  const [actionFilter, setActionFilter] = useState('');
  const [userFilter, setUserFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  // Pagination (server-side)
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(50);
  const [total, setTotal] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (actionFilter) params.set('action', actionFilter);
      if (userFilter) params.set('user', userFilter);
      if (dateFrom) params.set('from', dateFrom);
      if (dateTo) params.set('to', dateTo);
      params.set('limit', String(limit));
      params.set('offset', String((page - 1) * limit));

      const res = await fetch(`/api/admin/wr/audit?${params}`);
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setLogs(data.logs || data.entries || data || []);
      setTotal(data.total || 0);
    } catch (err: any) {
      setError(err.message);
      setLogs([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [actionFilter, userFilter, dateFrom, dateTo, limit, page]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs, envMode]);

  // Reset to page 1 when filters change
  useEffect(() => {
    if (page !== 1) setPage(1);
  }, [actionFilter, userFilter, dateFrom, dateTo, limit]);

  const uniqueActions = [...new Set(logs.map(l => l.action))].sort();
  const uniqueUsers = [...new Set(logs.map(l => l.actor?.email || l.userEmail).filter(Boolean))].sort();

  const handleClearFilters = () => {
    setActionFilter('');
    setUserFilter('');
    setDateFrom('');
    setDateTo('');
    setPage(1);
  };

  // Prepare export data
  const exportData = logs.map(log => ({
    timestamp: new Date(log.timestamp).toISOString(),
    adminUser: log.actor?.email || log.userEmail || '—',
    action: log.action || '—',
    targetType: log.resource?.type || (log.tenantId ? 'tenant' : log.userId ? 'user' : '—'),
    targetId: log.resource?.id || log.tenantId || log.userId || '—',
    ipAddress: log.actor?.ip || log.ipAddress || '—',
    details: typeof log.details === 'string'
      ? log.details
      : log.details
        ? JSON.stringify(log.details)
        : log.metadata
          ? JSON.stringify(log.metadata)
          : '—',
  }));

  const actionColor = (action: string) => {
    if (action.includes('delete') || action.includes('remove')) return 'var(--tn-red)';
    if (action.includes('create') || action.includes('add')) return 'var(--tn-green)';
    if (action.includes('update') || action.includes('edit')) return 'var(--tn-blue)';
    if (action.includes('login') || action.includes('auth')) return 'var(--tn-orange)';
    return 'var(--tn-text-muted)';
  };

  const totalPages = Math.max(1, Math.ceil(logs.length / limit));
  const hasFilters = actionFilter || userFilter || dateFrom || dateTo;

  return (
    <div style={{ padding: 12 }}>
      {/* Header */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--tn-text)' }}>Audit Logs</span>
        <div style={{ flex: 1 }} />

        {/* Export Button */}
        <ExportButton data={exportData} filename="audit-logs" />

        <button onClick={fetchLogs} style={{
          padding: '4px 10px', borderRadius: 3, fontSize: 10, cursor: 'pointer',
          background: 'var(--tn-bg)', border: '1px solid var(--tn-border)', color: 'var(--tn-text-muted)',
        }}>
          Refresh
        </button>
      </div>

      {/* Filters */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
        gap: 8,
        marginBottom: 12,
        padding: 10,
        background: 'var(--tn-bg-dark)',
        borderRadius: 4,
      }}>
        {/* Action Filter */}
        <div>
          <label style={{ fontSize: 9, fontWeight: 600, color: 'var(--tn-text-muted)', display: 'block', marginBottom: 4 }}>
            Action Type
          </label>
          <select
            value={actionFilter}
            onChange={e => setActionFilter(e.target.value)}
            style={{
              width: '100%',
              padding: '4px 6px',
              borderRadius: 3,
              fontSize: 10,
              background: 'var(--tn-bg)',
              border: '1px solid var(--tn-border)',
              color: 'var(--tn-text)',
              outline: 'none',
            }}
          >
            <option value="">All Actions</option>
            {uniqueActions.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>

        {/* User Filter */}
        <div>
          <label style={{ fontSize: 9, fontWeight: 600, color: 'var(--tn-text-muted)', display: 'block', marginBottom: 4 }}>
            Admin User
          </label>
          <select
            value={userFilter}
            onChange={e => setUserFilter(e.target.value)}
            style={{
              width: '100%',
              padding: '4px 6px',
              borderRadius: 3,
              fontSize: 10,
              background: 'var(--tn-bg)',
              border: '1px solid var(--tn-border)',
              color: 'var(--tn-text)',
              outline: 'none',
            }}
          >
            <option value="">All Users</option>
            {uniqueUsers.map(u => <option key={u} value={u}>{u}</option>)}
          </select>
        </div>

        {/* Date From */}
        <div>
          <label style={{ fontSize: 9, fontWeight: 600, color: 'var(--tn-text-muted)', display: 'block', marginBottom: 4 }}>
            From Date
          </label>
          <input
            type="date"
            value={dateFrom}
            onChange={e => setDateFrom(e.target.value)}
            style={{
              width: '100%',
              padding: '4px 6px',
              borderRadius: 3,
              fontSize: 10,
              background: 'var(--tn-bg)',
              border: '1px solid var(--tn-border)',
              color: 'var(--tn-text)',
              outline: 'none',
            }}
          />
        </div>

        {/* Date To */}
        <div>
          <label style={{ fontSize: 9, fontWeight: 600, color: 'var(--tn-text-muted)', display: 'block', marginBottom: 4 }}>
            To Date
          </label>
          <input
            type="date"
            value={dateTo}
            onChange={e => setDateTo(e.target.value)}
            style={{
              width: '100%',
              padding: '4px 6px',
              borderRadius: 3,
              fontSize: 10,
              background: 'var(--tn-bg)',
              border: '1px solid var(--tn-border)',
              color: 'var(--tn-text)',
              outline: 'none',
            }}
          />
        </div>

        {/* Limit */}
        <div>
          <label style={{ fontSize: 9, fontWeight: 600, color: 'var(--tn-text-muted)', display: 'block', marginBottom: 4 }}>
            Entries per Page
          </label>
          <select
            value={String(limit)}
            onChange={e => setLimit(Number(e.target.value))}
            style={{
              width: '100%',
              padding: '4px 6px',
              borderRadius: 3,
              fontSize: 10,
              background: 'var(--tn-bg)',
              border: '1px solid var(--tn-border)',
              color: 'var(--tn-text)',
              outline: 'none',
            }}
          >
            <option value="25">25</option>
            <option value="50">50</option>
            <option value="100">100</option>
            <option value="200">200</option>
          </select>
        </div>

        {/* Clear Filters */}
        {hasFilters && (
          <div style={{ display: 'flex', alignItems: 'flex-end' }}>
            <button
              onClick={handleClearFilters}
              style={{
                width: '100%',
                padding: '4px 10px',
                borderRadius: 3,
                fontSize: 10,
                cursor: 'pointer',
                background: 'transparent',
                border: '1px solid var(--tn-border)',
                color: 'var(--tn-text-muted)',
              }}
            >
              Clear Filters
            </button>
          </div>
        )}
      </div>

      {error && (
        <div style={{
          padding: '6px 10px',
          fontSize: 11,
          color: 'var(--tn-red)',
          background: 'rgba(247,118,142,0.1)',
          borderRadius: 3,
          marginBottom: 8
        }}>
          {error}
        </div>
      )}

      {loading && (
        <div style={{
          padding: 20,
          textAlign: 'center',
          color: 'var(--tn-text-muted)',
          fontSize: 12
        }}>
          Loading...
        </div>
      )}

      {!loading && logs.length === 0 && (
        <div style={{
          padding: 20,
          textAlign: 'center',
          color: 'var(--tn-text-muted)',
          fontSize: 11
        }}>
          No audit logs found
        </div>
      )}

      {!loading && logs.length > 0 && (
        <div>
          {/* Table Header */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: '130px 120px 150px 90px 100px 1fr',
            gap: 8,
            padding: '6px 10px',
            background: 'var(--tn-bg-dark)',
            borderRadius: 4,
            fontSize: 10,
            fontWeight: 600,
            color: 'var(--tn-text-muted)',
            marginBottom: 4,
          }}>
            <div>Timestamp</div>
            <div>Action</div>
            <div>Admin User</div>
            <div>Target Type</div>
            <div>Target ID</div>
            <div>IP Address</div>
          </div>

          {/* Table Rows */}
          {logs.map(log => {
            const isExpanded = expandedId === log.id;
            const userEmail = log.actor?.email || log.userEmail || '—';
            const targetType = log.resource?.type || (log.tenantId ? 'tenant' : log.userId ? 'user' : '—');
            const targetId = log.resource?.id || log.tenantId || log.userId || '—';
            const ipAddress = log.actor?.ip || log.ipAddress || '—';

            return (
              <div key={log.id}>
                <div
                  onClick={() => setExpandedId(isExpanded ? null : log.id)}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '130px 120px 150px 90px 100px 1fr',
                    gap: 8,
                    padding: '7px 10px',
                    borderBottom: '1px solid var(--tn-border)',
                    fontSize: 11,
                    alignItems: 'center',
                    cursor: 'pointer',
                    background: isExpanded ? 'rgba(122,162,247,0.05)' : 'transparent',
                    transition: 'background 0.15s',
                  }}
                  onMouseEnter={e => {
                    if (!isExpanded) e.currentTarget.style.background = 'rgba(122,162,247,0.03)';
                  }}
                  onMouseLeave={e => {
                    if (!isExpanded) e.currentTarget.style.background = 'transparent';
                  }}
                >
                  {/* Timestamp */}
                  <div style={{ color: 'var(--tn-text-muted)', fontSize: 10 }}>
                    {new Date(log.timestamp).toLocaleString('de-DE', {
                      day: '2-digit',
                      month: '2-digit',
                      year: '2-digit',
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                    })}
                  </div>

                  {/* Action */}
                  <div>
                    <span style={{
                      padding: '2px 6px',
                      borderRadius: 3,
                      fontSize: 9,
                      fontWeight: 600,
                      color: actionColor(log.action),
                      background: `${actionColor(log.action)}15`,
                    }}>
                      {log.action}
                    </span>
                  </div>

                  {/* Admin User */}
                  <div style={{
                    color: 'var(--tn-text)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontFamily: 'monospace',
                    fontSize: 10,
                  }}>
                    {userEmail}
                  </div>

                  {/* Target Type */}
                  <div style={{
                    color: 'var(--tn-text-muted)',
                    fontSize: 10,
                  }}>
                    {targetType}
                  </div>

                  {/* Target ID */}
                  <div style={{
                    color: 'var(--tn-text-muted)',
                    fontSize: 10,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontFamily: 'monospace',
                  }}>
                    {targetId.length > 12 ? targetId.slice(0, 12) + '...' : targetId}
                  </div>

                  {/* IP Address */}
                  <div style={{
                    color: 'var(--tn-text-muted)',
                    fontSize: 10,
                    fontFamily: 'monospace',
                  }}>
                    {ipAddress}
                  </div>
                </div>

                {/* Expanded Details */}
                {isExpanded && (
                  <div style={{
                    padding: '10px 12px',
                    background: 'var(--tn-bg-dark)',
                    borderBottom: '1px solid var(--tn-border)',
                  }}>
                    <div style={{ fontSize: 9, fontWeight: 600, color: 'var(--tn-text-muted)', marginBottom: 6 }}>
                      DETAILS
                    </div>
                    <pre style={{
                      margin: 0,
                      fontSize: 10,
                      color: 'var(--tn-text)',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-all',
                      fontFamily: 'monospace',
                      lineHeight: 1.5,
                    }}>
                      {typeof log.details === 'string'
                        ? log.details
                        : log.details
                          ? JSON.stringify(log.details, null, 2)
                          : log.metadata
                            ? JSON.stringify(log.metadata, null, 2)
                            : 'No additional details'}
                    </pre>
                    {log.userAgent && (
                      <div style={{
                        fontSize: 9,
                        color: 'var(--tn-text-muted)',
                        marginTop: 8,
                        paddingTop: 8,
                        borderTop: '1px solid var(--tn-border)',
                      }}>
                        <strong>User Agent:</strong> {log.userAgent}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {/* Pagination */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginTop: 12,
            padding: '8px 10px',
            background: 'var(--tn-bg-dark)',
            borderRadius: 4,
          }}>
            <div style={{ fontSize: 10, color: 'var(--tn-text-muted)' }}>
              Showing page {page} of {totalPages} ({logs.length} entries)
            </div>

            <div style={{ display: 'flex', gap: 6 }}>
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page <= 1}
                style={{
                  padding: '4px 10px',
                  borderRadius: 3,
                  fontSize: 10,
                  cursor: page <= 1 ? 'not-allowed' : 'pointer',
                  background: 'var(--tn-bg)',
                  border: '1px solid var(--tn-border)',
                  color: page <= 1 ? 'var(--tn-text-muted)' : 'var(--tn-text)',
                  opacity: page <= 1 ? 0.5 : 1,
                }}
              >
                Previous
              </button>

              <button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                style={{
                  padding: '4px 10px',
                  borderRadius: 3,
                  fontSize: 10,
                  cursor: page >= totalPages ? 'not-allowed' : 'pointer',
                  background: 'var(--tn-bg)',
                  border: '1px solid var(--tn-border)',
                  color: page >= totalPages ? 'var(--tn-text-muted)' : 'var(--tn-text)',
                  opacity: page >= totalPages ? 0.5 : 1,
                }}
              >
                Next
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
