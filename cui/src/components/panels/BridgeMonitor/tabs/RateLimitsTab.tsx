import { useState, useEffect, useCallback } from 'react';
import { CircularProgressbar, buildStyles } from 'react-circular-progressbar';
import 'react-circular-progressbar/dist/styles.css';

interface LimitsData {
  providers: {
    provider: string;
    current: number;
    limit: number;
    percent: number;
    resetAt: string;
    status: 'safe' | 'caution' | 'warning' | 'critical';
  }[];
  history: {
    timestamp: string;
    provider: string;
    model: string;
    reason: string;
  }[];
  lastUpdated: string;
}

const STATUS_COLORS: Record<string, string> = {
  safe: 'var(--tn-green)',
  caution: 'var(--tn-blue)',
  warning: 'var(--tn-orange)',
  critical: 'var(--tn-red)',
};

export default function RateLimitsTab() {
  const [data, setData] = useState<LimitsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const fetchData = useCallback(async () => {
    if ((window as any).__cuiServerAlive === false) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/bridge/metrics/limits', { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(await res.text());
      const result = await res.json();
      setData(result);
    } catch (err: any) {
      console.warn('[BridgeLimits] fetch limits data failed:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000); // Refresh every 30s
    return () => clearInterval(interval);
  }, [fetchData]);

  const getTimeToReset = (resetAt: string | undefined | null) => {
    if (!resetAt) return 'Unknown';
    const now = Date.now();
    const reset = new Date(resetAt).getTime();
    if (isNaN(reset)) return 'Invalid date';
    const diff = reset - now;
    if (diff < 0) return 'Reset available';
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(minutes / 60);
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    return `${minutes}m`;
  };

  return (
    <div data-ai-id="bridge-limits-container" style={{ padding: 12 }}>
      {/* Header */}
      <div data-ai-id="bridge-limits-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0, color: 'var(--tn-text)' }}>
          Rate Limit Monitoring
        </h3>
        <button
          data-ai-id="bridge-limits-refresh-btn"
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

      {error && (
        <div
          data-ai-id="bridge-limits-error"
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
        <div data-ai-id="bridge-limits-loading" style={{ padding: 40, textAlign: 'center', color: 'var(--tn-text-muted)', fontSize: 12 }}>
          Loading...
        </div>
      )}

      {data && (
        <>
          {/* Provider Gauges */}
          <div data-ai-id="bridge-limits-providers-section" style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--tn-text)', marginBottom: 12 }}>
              PROVIDER RATE LIMITS
            </div>
            <div data-ai-id="bridge-limits-providers-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16 }}>
              {data.providers.map((provider, idx) => (
                <div
                  key={idx}
                  data-ai-id={`bridge-limits-provider-${provider.provider}`}
                  style={{
                    padding: 16,
                    background: 'var(--tn-bg-dark)',
                    border: `1px solid ${STATUS_COLORS[provider.status]}`,
                    borderRadius: 6,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: 10,
                  }}
                >
                  <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--tn-text)', textTransform: 'uppercase' }}>
                    {provider.provider}
                  </div>
                  <div style={{ width: 100, height: 100 }}>
                    <CircularProgressbar
                      value={provider.percent ?? 0}
                      text={`${(provider.percent ?? 0).toFixed(0)}%`}
                      styles={buildStyles({
                        pathColor: STATUS_COLORS[provider.status] ?? 'var(--tn-border)',
                        textColor: 'var(--tn-text)',
                        trailColor: 'var(--tn-border)',
                        textSize: '20px',
                      })}
                    />
                  </div>
                  <div style={{ textAlign: 'center', fontSize: 9, color: 'var(--tn-text-muted)' }}>
                    <div>{(provider.current ?? 0).toLocaleString()} / {(provider.limit ?? 0).toLocaleString()}</div>
                    <div style={{ marginTop: 4, color: STATUS_COLORS[provider.status], fontWeight: 600 }}>
                      Reset in: {getTimeToReset(provider.resetAt)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Status Legend */}
          <div data-ai-id="bridge-limits-status-legend" style={{ marginBottom: 24, padding: 12, background: 'var(--tn-bg-dark)', borderRadius: 4 }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--tn-text)', marginBottom: 8 }}>
              STATUS LEGEND
            </div>
            <div style={{ display: 'flex', gap: 16, fontSize: 9, color: 'var(--tn-text-muted)' }}>
              <div data-ai-id="bridge-limits-legend-safe" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ width: 12, height: 12, borderRadius: '50%', background: 'var(--tn-green)' }} />
                Safe (&lt;60%)
              </div>
              <div data-ai-id="bridge-limits-legend-caution" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ width: 12, height: 12, borderRadius: '50%', background: 'var(--tn-blue)' }} />
                Caution (60-80%)
              </div>
              <div data-ai-id="bridge-limits-legend-warning" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ width: 12, height: 12, borderRadius: '50%', background: 'var(--tn-orange)' }} />
                Warning (80-95%)
              </div>
              <div data-ai-id="bridge-limits-legend-critical" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ width: 12, height: 12, borderRadius: '50%', background: 'var(--tn-red)' }} />
                Critical (&gt;95%)
              </div>
            </div>
          </div>

          {/* Historical Rate Limit Events */}
          <div data-ai-id="bridge-limits-history-section">
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--tn-text)', marginBottom: 8 }}>
              RATE LIMIT EVENTS (LAST 24H)
            </div>
            {data.history.length > 0 ? (
              <div data-ai-id="bridge-limits-history-table">
                <div
                  data-ai-id="bridge-limits-history-header"
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '140px 1fr 1fr 2fr',
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
                  <div>Provider</div>
                  <div>Model</div>
                  <div>Reason</div>
                </div>
                {data.history.map((event, idx) => (
                  <div
                    key={idx}
                    data-ai-id={`bridge-limits-event-${idx}`}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '140px 1fr 1fr 2fr',
                      gap: 8,
                      padding: '8px 10px',
                      borderBottom: '1px solid var(--tn-border)',
                      fontSize: 10,
                      alignItems: 'center',
                    }}
                  >
                    <div style={{ color: 'var(--tn-text-muted)' }}>
                      {event.timestamp ? new Date(event.timestamp).toLocaleString() : 'N/A'}
                    </div>
                    <div style={{ color: 'var(--tn-text)' }}>{event.provider}</div>
                    <div style={{ color: 'var(--tn-text-muted)' }}>{event.model}</div>
                    <div style={{ color: 'var(--tn-red)' }}>{event.reason}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div
                data-ai-id="bridge-limits-no-events"
                style={{
                  padding: 20,
                  textAlign: 'center',
                  background: 'var(--tn-bg-dark)',
                  borderRadius: 4,
                  color: 'var(--tn-text-muted)',
                  fontSize: 11,
                }}
              >
                ✅ No rate limit events in the last 24 hours
              </div>
            )}
          </div>

          {/* Last Updated */}
          <div data-ai-id="bridge-limits-timestamp" style={{ marginTop: 16, fontSize: 9, color: 'var(--tn-text-muted)', textAlign: 'right' }}>
            Last updated: {data.lastUpdated ? new Date(data.lastUpdated).toLocaleString() : 'N/A'}
          </div>
        </>
      )}
    </div>
  );
}
