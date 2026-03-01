import { useState, useEffect, useCallback } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';

// Bridge /metrics/cost response format
interface CostData {
  total_requests: number;
  estimated_tokens: number;
  estimated_cost_usd: number;
  breakdown: Record<string, {
    requests: number;
    tokens: number;
    cost_usd: number;
  }>;
  note: string;
  timestamp: string;
}

const MODEL_COLORS: Record<string, string> = {
  'claude-sonnet-4.5': 'var(--tn-blue)',
  'claude-opus-4.6': 'var(--tn-purple, #bb9af7)',
  'claude-haiku-4.5': 'var(--tn-green)',
  default: 'var(--tn-orange)',
};

export default function CostAnalyticsTab() {
  const [data, setData] = useState<CostData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/bridge/metrics/cost');
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

  const getChartData = () => {
    if (!data || !data.breakdown) return [];
    return Object.entries(data.breakdown).map(([model, stats]) => ({
      model,
      cost: stats.cost_usd,
      tokens: stats.tokens,
      requests: stats.requests,
    }));
  };

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
          Cost Analytics
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
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 20 }}>
            {statCard(
              'Total Cost (USD)',
              `$${(data.estimated_cost_usd ?? 0).toFixed(2)}`,
              'var(--tn-green)',
              '💰'
            )}
            {statCard(
              'Total Tokens',
              formatNumber(data.estimated_tokens),
              'var(--tn-blue)',
              '🔢'
            )}
            {statCard(
              'Total Requests',
              formatNumber(data.total_requests),
              'var(--tn-purple, #bb9af7)',
              '📊'
            )}
          </div>

          {/* Note */}
          {data.note && (
            <div
              style={{
                padding: '8px 12px',
                fontSize: 10,
                color: 'var(--tn-text-muted)',
                background: 'rgba(122,162,247,0.1)',
                border: '1px solid rgba(122,162,247,0.2)',
                borderRadius: 4,
                marginBottom: 20,
              }}
            >
              ℹ️ {data.note}
            </div>
          )}

          {/* Cost Breakdown Chart */}
          {getChartData().length > 0 ? (
            <>
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--tn-text)', marginBottom: 8 }}>
                  COST BY MODEL
                </div>
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={getChartData()} margin={{ top: 0, right: 10, left: 0, bottom: 0 }}>
                    <XAxis dataKey="model" tick={{ fontSize: 9, fill: 'var(--tn-text-muted)' }} />
                    <YAxis tick={{ fontSize: 9, fill: 'var(--tn-text-muted)' }} width={40} />
                    <Tooltip
                      contentStyle={{
                        background: 'var(--tn-bg-dark)',
                        border: '1px solid var(--tn-border)',
                        fontSize: 10,
                      }}
                      formatter={(value: number) => [`$${value.toFixed(4)}`, 'Cost']}
                    />
                    <Bar dataKey="cost" radius={[4, 4, 0, 0]}>
                      {getChartData().map((entry, index) => (
                        <Cell
                          key={index}
                          fill={MODEL_COLORS[entry.model] || MODEL_COLORS.default}
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
                    gridTemplateColumns: '1fr 100px 100px 100px',
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
                  <div>Model</div>
                  <div>Requests</div>
                  <div>Tokens</div>
                  <div>Cost (USD)</div>
                </div>
                {getChartData().map((entry, idx) => (
                  <div
                    key={idx}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr 100px 100px 100px',
                      gap: 8,
                      padding: '8px 10px',
                      borderBottom: '1px solid var(--tn-border)',
                      fontSize: 10,
                      alignItems: 'center',
                    }}
                  >
                    <div style={{ color: 'var(--tn-text)', fontWeight: 500 }}>
                      {entry.model}
                    </div>
                    <div style={{ color: 'var(--tn-text-muted)' }}>
                      {formatNumber(entry.requests)}
                    </div>
                    <div style={{ color: 'var(--tn-text-muted)' }}>
                      {formatNumber(entry.tokens)}
                    </div>
                    <div style={{ color: 'var(--tn-green)' }}>
                      ${(entry.cost ?? 0).toFixed(4)}
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
              No cost data available yet (no requests tracked)
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
