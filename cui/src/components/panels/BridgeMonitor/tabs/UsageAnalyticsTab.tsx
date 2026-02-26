import { useState, useEffect, useCallback } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts';

// Bridge /metrics/usage response format
interface UsageData {
  total_requests: number;
  endpoints: Array<{
    endpoint: string;
    requests: number;
    avg_response_time?: number;
  }>;
  timestamp: string;
}

const ENDPOINT_COLORS = [
  'var(--tn-blue)',
  'var(--tn-purple, #bb9af7)',
  'var(--tn-green)',
  'var(--tn-orange)',
  'var(--tn-red)',
];

export default function UsageAnalyticsTab() {
  const [data, setData] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/bridge/metrics/usage');
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
    const interval = setInterval(fetchData, 60000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const formatNumber = (num: number) => {
    if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
    return num.toString();
  };

  const statCard = (label: string, value: string | number, color: string, icon?: string) => (
    <div
      style={{
        padding: '12px 16px',
        background: 'var(--tn-bg-dark)',
        border: '1px solid var(--tn-border)',
        borderRadius: 6,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      <div
        style={{
          fontSize: 9,
          color: 'var(--tn-text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          fontWeight: 600,
          display: 'flex',
          alignItems: 'center',
          gap: 4,
        }}
      >
        {icon && <span>{icon}</span>}
        {label}
      </div>
      <div style={{ fontSize: 20, fontWeight: 700, color }}>{value}</div>
    </div>
  );

  return (
    <div style={{ padding: 12 }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0, color: 'var(--tn-text)' }}>
          Usage Analytics
        </h3>
        <button
          onClick={fetchData}
          style={{
            padding: '3px 10px',
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

      {/* Error */}
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

      {/* Loading */}
      {loading && !data && (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--tn-text-muted)', fontSize: 12 }}>
          Loading...
        </div>
      )}

      {/* Overview Stats */}
      {data && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10, marginBottom: 20 }}>
            {statCard(
              'Total Requests',
              formatNumber(data.total_requests),
              'var(--tn-blue)',
              '📊'
            )}
            {statCard(
              'Unique Endpoints',
              data.endpoints.length.toString(),
              'var(--tn-purple, #bb9af7)',
              '🔗'
            )}
          </div>

          {/* Endpoint Usage Chart */}
          {data.endpoints.length > 0 ? (
            <>
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--tn-text)', marginBottom: 8 }}>
                  REQUESTS BY ENDPOINT
                </div>
                <ResponsiveContainer width="100%" height={250}>
                  <BarChart data={data.endpoints} margin={{ top: 0, right: 10, left: 0, bottom: 40 }}>
                    <XAxis
                      dataKey="endpoint"
                      tick={{ fontSize: 9, fill: 'var(--tn-text-muted)' }}
                      angle={-45}
                      textAnchor="end"
                      height={60}
                    />
                    <YAxis tick={{ fontSize: 9, fill: 'var(--tn-text-muted)' }} width={40} />
                    <Tooltip
                      contentStyle={{
                        background: 'var(--tn-bg-dark)',
                        border: '1px solid var(--tn-border)',
                        fontSize: 10,
                      }}
                      formatter={(value: number) => [formatNumber(value), 'Requests']}
                    />
                    <Bar dataKey="requests" radius={[4, 4, 0, 0]}>
                      {data.endpoints.map((_, index) => (
                        <Cell
                          key={index}
                          fill={ENDPOINT_COLORS[index % ENDPOINT_COLORS.length]}
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>

              {/* Detailed Table */}
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--tn-text)', marginBottom: 8 }}>
                  DETAILED BREAKDOWN
                </div>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 100px 120px',
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
                  <div>Endpoint</div>
                  <div>Requests</div>
                  <div>Avg Response (s)</div>
                </div>
                {data.endpoints.map((endpoint, idx) => (
                  <div
                    key={idx}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr 100px 120px',
                      gap: 8,
                      padding: '8px 10px',
                      borderBottom: '1px solid var(--tn-border)',
                      fontSize: 10,
                      alignItems: 'center',
                    }}
                  >
                    <div style={{ color: 'var(--tn-text)', fontWeight: 500, fontFamily: 'monospace', fontSize: 9 }}>
                      {endpoint.endpoint}
                    </div>
                    <div style={{ color: 'var(--tn-blue)' }}>
                      {formatNumber(endpoint.requests)}
                    </div>
                    <div style={{ color: 'var(--tn-text-muted)' }}>
                      {endpoint.avg_response_time !== undefined
                        ? endpoint.avg_response_time.toFixed(3)
                        : 'N/A'}
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div
              style={{
                padding: 40,
                textAlign: 'center',
                background: 'var(--tn-bg-dark)',
                borderRadius: 6,
                color: 'var(--tn-text-muted)',
                fontSize: 11,
              }}
            >
              No usage data available yet (no requests tracked)
            </div>
          )}

          {/* Timestamp */}
          <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', textAlign: 'right', marginTop: 20 }}>
            Last updated: {new Date(data.timestamp).toLocaleString()}
          </div>
        </>
      )}
    </div>
  );
}
