import { useState, useEffect, useCallback, useRef } from 'react';

interface Request {
  id: string;
  timestamp: string;
  user: string;
  app: string;
  model: string;
  provider: string;
  tokens: number;
  cost: number;
  latency: number;
  status: 'success' | 'error' | 'timeout';
}

interface ActivityData {
  requests: Request[];
  total: number;
}

const STATUS_COLORS: Record<string, string> = {
  success: 'var(--tn-green)',
  error: 'var(--tn-red)',
  timeout: 'var(--tn-orange)',
};

export default function ActivityFeedTab() {
  const [data, setData] = useState<ActivityData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [filter, setFilter] = useState({ user: '', app: '', model: '', status: '' });
  const containerRef = useRef<HTMLDivElement>(null);

  const fetchData = useCallback(async () => {
    setError('');
    try {
      const res = await fetch('/api/bridge/metrics/activity?limit=100');
      if (!res.ok) throw new Error(await res.text());
      const result = await res.json();
      setData(result);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    if (!autoRefresh) return;
    const interval = setInterval(fetchData, 5000); // Refresh every 5s
    return () => clearInterval(interval);
  }, [fetchData, autoRefresh]);

  const filteredRequests = data?.requests.filter((req) => {
    if (filter.user && !req.user.toLowerCase().includes(filter.user.toLowerCase())) return false;
    if (filter.app && !req.app.toLowerCase().includes(filter.app.toLowerCase())) return false;
    if (filter.model && !req.model.toLowerCase().includes(filter.model.toLowerCase())) return false;
    if (filter.status && req.status !== filter.status) return false;
    return true;
  });

  const formatLatency = (ms: number) => {
    if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
    return `${ms}ms`;
  };

  return (
    <div style={{ padding: 12, height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          type="text"
          placeholder="Filter user..."
          value={filter.user}
          onChange={(e) => setFilter({ ...filter, user: e.target.value })}
          style={{
            padding: '4px 8px',
            borderRadius: 3,
            fontSize: 10,
            background: 'var(--tn-bg)',
            border: '1px solid var(--tn-border)',
            color: 'var(--tn-text)',
            outline: 'none',
            width: 100,
          }}
        />
        <input
          type="text"
          placeholder="Filter app..."
          value={filter.app}
          onChange={(e) => setFilter({ ...filter, app: e.target.value })}
          style={{
            padding: '4px 8px',
            borderRadius: 3,
            fontSize: 10,
            background: 'var(--tn-bg)',
            border: '1px solid var(--tn-border)',
            color: 'var(--tn-text)',
            outline: 'none',
            width: 100,
          }}
        />
        <input
          type="text"
          placeholder="Filter model..."
          value={filter.model}
          onChange={(e) => setFilter({ ...filter, model: e.target.value })}
          style={{
            padding: '4px 8px',
            borderRadius: 3,
            fontSize: 10,
            background: 'var(--tn-bg)',
            border: '1px solid var(--tn-border)',
            color: 'var(--tn-text)',
            outline: 'none',
            width: 120,
          }}
        />
        <select
          value={filter.status}
          onChange={(e) => setFilter({ ...filter, status: e.target.value })}
          style={{
            padding: '4px 8px',
            borderRadius: 3,
            fontSize: 10,
            background: 'var(--tn-bg)',
            border: '1px solid var(--tn-border)',
            color: 'var(--tn-text)',
            outline: 'none',
          }}
        >
          <option value="">All Status</option>
          <option value="success">Success</option>
          <option value="error">Error</option>
          <option value="timeout">Timeout</option>
        </select>
        <div style={{ flex: 1 }} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: 'var(--tn-text-muted)' }}>
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
          />
          Auto-refresh (5s)
        </label>
        <button
          onClick={fetchData}
          style={{
            padding: '4px 12px',
            borderRadius: 3,
            fontSize: 10,
            cursor: 'pointer',
            background: 'var(--tn-bg)',
            border: '1px solid var(--tn-border)',
            color: 'var(--tn-text-muted)',
          }}
        >
          Refresh
        </button>
      </div>

      {error && (
        <div
          style={{
            padding: '6px 10px',
            fontSize: 11,
            color: 'var(--tn-red)',
            background: 'rgba(247,118,142,0.1)',
            borderRadius: 3,
            marginBottom: 12,
          }}
        >
          {error}
        </div>
      )}

      {loading && !data && (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--tn-text-muted)', fontSize: 12 }}>
          Loading...
        </div>
      )}

      {/* Request Feed */}
      {data && (
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {/* Table Header */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '140px 80px 120px 140px 100px 70px 70px 80px 70px',
              gap: 8,
              padding: '6px 10px',
              background: 'var(--tn-bg-dark)',
              borderRadius: 4,
              fontSize: 9,
              fontWeight: 600,
              color: 'var(--tn-text-muted)',
              marginBottom: 4,
            }}
          >
            <div>Timestamp</div>
            <div>User</div>
            <div>App</div>
            <div>Model</div>
            <div>Provider</div>
            <div>Tokens</div>
            <div>Cost (€)</div>
            <div>Latency</div>
            <div>Status</div>
          </div>

          {/* Scrollable Request List */}
          <div
            ref={containerRef}
            style={{
              flex: 1,
              overflow: 'auto',
              border: '1px solid var(--tn-border)',
              borderRadius: 4,
            }}
          >
            {filteredRequests && filteredRequests.length > 0 ? (
              filteredRequests.map((req, idx) => (
                <div
                  key={req.id}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '140px 80px 120px 140px 100px 70px 70px 80px 70px',
                    gap: 8,
                    padding: '8px 10px',
                    borderBottom: idx < filteredRequests.length - 1 ? '1px solid var(--tn-border)' : 'none',
                    fontSize: 10,
                    alignItems: 'center',
                    background: idx % 2 === 0 ? 'var(--tn-bg)' : 'var(--tn-bg-dark)',
                  }}
                >
                  <div style={{ color: 'var(--tn-text-muted)', fontSize: 9 }}>
                    {new Date(req.timestamp).toLocaleTimeString()}
                  </div>
                  <div style={{ color: 'var(--tn-text)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {req.user}
                  </div>
                  <div style={{ color: 'var(--tn-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {req.app}
                  </div>
                  <div style={{ color: 'var(--tn-blue)', fontSize: 9, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {req.model}
                  </div>
                  <div style={{ color: 'var(--tn-text-muted)' }}>{req.provider}</div>
                  <div style={{ color: 'var(--tn-purple, #bb9af7)', textAlign: 'right' }}>
                    {req.tokens.toLocaleString()}
                  </div>
                  <div style={{ color: 'var(--tn-green)', textAlign: 'right' }}>
                    €{req.cost.toFixed(3)}
                  </div>
                  <div
                    style={{
                      color: req.latency > 3000 ? 'var(--tn-red)' : 'var(--tn-text-muted)',
                      textAlign: 'right',
                    }}
                  >
                    {formatLatency(req.latency)}
                  </div>
                  <div style={{ color: STATUS_COLORS[req.status], fontWeight: 600, textTransform: 'uppercase' }}>
                    {req.status === 'success' ? '✓' : req.status === 'error' ? '✗' : '⏱'}
                  </div>
                </div>
              ))
            ) : (
              <div style={{ padding: 40, textAlign: 'center', color: 'var(--tn-text-muted)', fontSize: 11 }}>
                {filter.user || filter.app || filter.model || filter.status
                  ? 'No requests match current filters'
                  : 'No recent requests'}
              </div>
            )}
          </div>

          {/* Footer Stats */}
          <div
            style={{
              marginTop: 8,
              padding: '8px 12px',
              background: 'var(--tn-bg-dark)',
              borderRadius: 4,
              display: 'flex',
              gap: 16,
              fontSize: 10,
            }}
          >
            <div>
              <span style={{ color: 'var(--tn-text-muted)' }}>Showing:</span>{' '}
              <span style={{ fontWeight: 600, color: 'var(--tn-text)' }}>
                {filteredRequests?.length || 0}
              </span>
            </div>
            <div>
              <span style={{ color: 'var(--tn-text-muted)' }}>Total:</span>{' '}
              <span style={{ fontWeight: 600, color: 'var(--tn-text)' }}>{data.total}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
