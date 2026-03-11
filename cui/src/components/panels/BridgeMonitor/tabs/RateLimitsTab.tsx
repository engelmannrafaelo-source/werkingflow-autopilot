import { useState, useEffect, useCallback } from 'react';
import { Toolbar, ErrorBanner, LoadingSpinner } from '../shared';

// ── Types matching Bridge API /rate-limits response ─────────────────────────
// Source of truth: werkingflow-bridge/src/main.py → get_rate_limits()

interface WorkerRateLimit {
  reset_time: string;
  retry_after_seconds: number;
}

interface BridgeRateLimitsResponse {
  current_worker: string;
  current_worker_rate_limited: boolean;
  current_worker_retry_after: number | null;
  all_rate_limits: Record<string, WorkerRateLimit>;
  total_workers_limited: number;
  _error?: string;
}

function validateResponse(data: unknown): BridgeRateLimitsResponse {
  if (data === null || typeof data !== 'object') {
    throw new Error('Bridge /rate-limits returned non-object response');
  }
  const d = data as Record<string, unknown>;
  if (typeof d.current_worker !== 'string') {
    throw new Error(`Bridge /rate-limits missing 'current_worker' (got ${typeof d.current_worker})`);
  }
  if (typeof d.current_worker_rate_limited !== 'boolean') {
    throw new Error(`Bridge /rate-limits missing 'current_worker_rate_limited' (got ${typeof d.current_worker_rate_limited})`);
  }
  if (d.all_rate_limits === null || typeof d.all_rate_limits !== 'object' || Array.isArray(d.all_rate_limits)) {
    throw new Error(`Bridge /rate-limits 'all_rate_limits' must be object (got ${typeof d.all_rate_limits})`);
  }
  return data as BridgeRateLimitsResponse;
}

function formatRetryAfter(seconds: number): string {
  if (seconds <= 0) return 'Expiring';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes < 60) return `${minutes}m ${secs}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export default function RateLimitsTab() {
  const [data, setData] = useState<BridgeRateLimitsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const fetchData = useCallback(async () => {
    if ((window as any).__cuiServerAlive !== true) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/bridge/metrics/limits', { signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`Bridge API HTTP ${res.status}`);
      const raw = await res.json();
      if (raw._error) throw new Error(`Bridge unavailable: ${raw._error}`);
      const validated = validateResponse(raw);
      setData(validated);
      setLastRefresh(new Date());
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const limitedWorkers = data ? Object.entries(data.all_rate_limits) : [];
  const isHealthy = data && !data.current_worker_rate_limited && data.total_workers_limited === 0;

  return (
    <div data-ai-id="bridge-limits-container" style={{ padding: 12 }}>
      <Toolbar lastRefresh={lastRefresh} loading={loading} onRefresh={fetchData} autoRefresh={30} />
      {error && <ErrorBanner message={error} />}
      {loading && !data && <LoadingSpinner text="Lade Rate Limit Status..." />}

      {data && (
        <>
          {/* Current Worker Status */}
          <div data-ai-id="bridge-limits-current-worker" style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--tn-text)', marginBottom: 8 }}>
              CURRENT WORKER
            </div>
            <div style={{
              padding: 16,
              background: 'var(--tn-bg-dark)',
              border: `2px solid ${data.current_worker_rate_limited ? 'var(--tn-red)' : 'var(--tn-green)'}`,
              borderRadius: 6,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, fontFamily: 'monospace', color: 'var(--tn-text)' }}>
                  {data.current_worker}
                </div>
                <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginTop: 4 }}>
                  Handling this request
                </div>
              </div>
              <div style={{
                padding: '4px 12px',
                borderRadius: 4,
                fontSize: 11,
                fontWeight: 700,
                background: data.current_worker_rate_limited ? 'rgba(247,118,142,0.2)' : 'rgba(158,206,106,0.2)',
                color: data.current_worker_rate_limited ? 'var(--tn-red)' : 'var(--tn-green)',
              }}>
                {data.current_worker_rate_limited ? 'RATE LIMITED' : 'OK'}
              </div>
            </div>
            {data.current_worker_rate_limited && data.current_worker_retry_after != null && (
              <div style={{ marginTop: 6, fontSize: 10, color: 'var(--tn-orange)', fontWeight: 600 }}>
                Retry after: {formatRetryAfter(data.current_worker_retry_after)}
              </div>
            )}
          </div>

          {/* Overall Status */}
          <div data-ai-id="bridge-limits-overall" style={{
            marginBottom: 16,
            padding: 12,
            background: isHealthy ? 'rgba(158,206,106,0.1)' : 'rgba(247,118,142,0.1)',
            border: `1px solid ${isHealthy ? 'rgba(158,206,106,0.3)' : 'rgba(247,118,142,0.3)'}`,
            borderRadius: 5,
            textAlign: 'center',
          }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: isHealthy ? 'var(--tn-green)' : 'var(--tn-red)' }}>
              {isHealthy ? 'All Workers Healthy' : `${data.total_workers_limited} Worker${data.total_workers_limited !== 1 ? 's' : ''} Rate Limited`}
            </div>
          </div>

          {/* Rate-Limited Workers Table */}
          <div data-ai-id="bridge-limits-workers-section">
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--tn-text)', marginBottom: 8 }}>
              RATE-LIMITED WORKERS
            </div>
            {limitedWorkers.length > 0 ? (
              <div data-ai-id="bridge-limits-workers-table">
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 160px 100px',
                  gap: 8,
                  padding: '6px 10px',
                  background: 'var(--tn-bg-dark)',
                  borderRadius: 4,
                  fontSize: 9,
                  fontWeight: 600,
                  color: 'var(--tn-text-muted)',
                  marginBottom: 4,
                }}>
                  <div>Worker</div>
                  <div>Reset Time</div>
                  <div>Retry After</div>
                </div>
                {limitedWorkers.map(([workerId, limit]) => (
                  <div
                    key={workerId}
                    data-ai-id={`bridge-limits-worker-${workerId}`}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr 160px 100px',
                      gap: 8,
                      padding: '8px 10px',
                      borderBottom: '1px solid var(--tn-border)',
                      fontSize: 10,
                      alignItems: 'center',
                    }}
                  >
                    <div style={{ color: 'var(--tn-text)', fontFamily: 'monospace', fontWeight: 600 }}>
                      {workerId}
                    </div>
                    <div style={{ color: 'var(--tn-text-muted)' }}>
                      {new Date(limit.reset_time).toLocaleString()}
                    </div>
                    <div style={{ color: 'var(--tn-red)', fontWeight: 600 }}>
                      {formatRetryAfter(limit.retry_after_seconds)}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div
                data-ai-id="bridge-limits-no-workers-limited"
                style={{
                  padding: 20,
                  textAlign: 'center',
                  background: 'var(--tn-bg-dark)',
                  borderRadius: 4,
                  color: 'var(--tn-text-muted)',
                  fontSize: 11,
                }}
              >
                No workers currently rate-limited
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
