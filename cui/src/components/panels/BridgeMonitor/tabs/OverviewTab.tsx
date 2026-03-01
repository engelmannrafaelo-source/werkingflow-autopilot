import { useState, useEffect, useCallback } from 'react';

// Bridge /metrics/overview response format
interface OverviewData {
  health: string;
  worker: string;
  uptime_hours: number;
  total_requests: number;
  avg_response_time: number;
  success_rate: number;
  active_sessions: number;
  timestamp: string;
}

export default function OverviewTab() {
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/bridge/metrics/overview');
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
    const interval = setInterval(fetchData, 60000); // Refresh every 60s
    return () => clearInterval(interval);
  }, [fetchData]);

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

  const formatNumber = (num: number) => {
    if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
    return num.toString();
  };

  return (
    <div style={{ padding: 12 }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0, color: 'var(--tn-text)' }}>
          AI Bridge Overview
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

      {/* Quick Stats */}
      {data && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10, marginBottom: 20 }}>
            {statCard(
              'Health',
              data.health,
              data.health === 'healthy' ? 'var(--tn-green)' : 'var(--tn-red)',
              data.health === 'healthy' ? '✅' : '⚠️'
            )}
            {statCard(
              'Worker',
              data.worker,
              'var(--tn-blue)',
              '🔧'
            )}
            {statCard(
              'Uptime',
              `${data.uptime_hours}h`,
              'var(--tn-purple, #bb9af7)',
              '⏱️'
            )}
            {statCard(
              'Total Requests',
              formatNumber(data.total_requests),
              'var(--tn-blue)',
              '📊'
            )}
            {statCard(
              'Active Sessions',
              data.active_sessions.toString(),
              'var(--tn-orange)',
              '⚡'
            )}
          </div>

          {/* Performance Stats */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10, marginBottom: 20 }}>
            {statCard(
              'Avg Response Time',
              `${(data.avg_response_time ?? 0).toFixed(2)}s`,
              'var(--tn-text)',
              '⏱️'
            )}
            {statCard(
              'Success Rate',
              `${(data.success_rate ?? 0).toFixed(1)}%`,
              (data.success_rate ?? 0) >= 99 ? 'var(--tn-green)' : (data.success_rate ?? 0) >= 95 ? 'var(--tn-orange)' : 'var(--tn-red)',
              (data.success_rate ?? 0) >= 99 ? '✅' : (data.success_rate ?? 0) >= 95 ? '⚠️' : '❌'
            )}
          </div>

          {/* Timestamp */}
          <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', textAlign: 'right' }}>
            Last updated: {new Date(data.timestamp).toLocaleString()}
          </div>
        </>
      )}
    </div>
  );
}
