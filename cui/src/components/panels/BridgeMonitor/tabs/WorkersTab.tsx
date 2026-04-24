import { useState, useEffect, useCallback } from 'react';
import { bridgeJson, StatCard, SectionFlat, StatusBadge, Toolbar, ErrorBanner, LoadingSpinner } from '../shared';

// ─── Types ──────────────────────────────────────────────────────────

interface ForecastWorker {
  arrivals: number;
  completions: number;
  errors: number;
  rate_limit_hits: number;
  arrivals_per_min: number;
  completions_per_min: number;
  input_tokens_per_min: number;
  output_tokens_per_min: number;
  avg_duration_ms: number;
  in_flight: number;
}

interface ForecastWorkerLimit {
  account: string;
  weekly_percent: number;
  session_percent: number;
  active: boolean;
}

interface ForecastData {
  window_seconds?: number;
  workers?: Record<string, ForecastWorker>;
  worker_limits?: Record<string, ForecastWorkerLimit>;
  saturation?: Record<string, string>;
  forecast?: {
    in_flight_total: number;
    drain_rate_per_s: number;
    arrival_rate_per_s: number;
    backlog_trend: string;
    eta_empty_s: number | null;
    active_workers: number | null;
    rate_limit_risk: string;
  };
}

interface LimitsData {
  current_worker?: string;
  current_worker_rate_limited?: boolean;
  all_rate_limits?: Record<string, {
    rate_limited: boolean;
    retry_after?: number;
    reset_time?: string;
  }>;
}

interface HealthCheck {
  component: string;
  status: 'ok' | 'degraded' | 'down';
  message?: string;
}

// ─── Component ──────────────────────────────────────────────────────

export default function WorkersTab() {
  const [forecast, setForecast] = useState<ForecastData | null>(null);
  const [limits, setLimits] = useState<LimitsData | null>(null);
  const [healthChecks, setHealthChecks] = useState<HealthCheck[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [forecastRes, limitsRes, healthRes, lbRes, privRes, authRes] = await Promise.allSettled([
        fetch('/api/bridge/metrics/queue-forecast?window=120', { signal: AbortSignal.timeout(10000) }).then(r => r.json()),
        fetch('/api/bridge/metrics/limits', { signal: AbortSignal.timeout(8000) }).then(r => r.json()),
        bridgeJson<{ status: string; service?: string }>('/health', { timeout: 5000 }),
        bridgeJson<{ status: string; workers?: { up?: number; total?: number } }>('/lb-status', { timeout: 5000 }),
        bridgeJson<{ privacy: { available: boolean } }>('/v1/privacy/status', { timeout: 5000 }),
        bridgeJson<{ server_info: { version: string } }>('/v1/auth/status', { timeout: 5000 }),
      ]);

      if (forecastRes.status === 'fulfilled' && !forecastRes.value._error) {
        setForecast(forecastRes.value);
      }

      if (limitsRes.status === 'fulfilled') {
        setLimits(limitsRes.value);
      }

      // Build component health checks
      const checks: HealthCheck[] = [];
      checks.push({
        component: 'Bridge Server',
        status: healthRes.status === 'fulfilled' && healthRes.value.status === 'healthy' ? 'ok' : 'down',
        message: healthRes.status === 'fulfilled' ? healthRes.value.service : 'Unreachable',
      });
      checks.push({
        component: 'Load Balancer',
        status: lbRes.status === 'fulfilled' ? 'ok' : 'degraded',
        message: lbRes.status === 'fulfilled'
          ? `${lbRes.value.workers?.up ?? '?'}/${lbRes.value.workers?.total ?? '?'} workers`
          : 'Status check failed',
      });
      checks.push({
        component: 'Privacy Service',
        status: privRes.status === 'fulfilled' && privRes.value.privacy?.available ? 'ok' : 'degraded',
        message: privRes.status === 'fulfilled' ? (privRes.value.privacy?.available ? 'Available' : 'Unavailable') : 'Not reachable',
      });
      checks.push({
        component: 'Auth Service',
        status: authRes.status === 'fulfilled' ? 'ok' : 'degraded',
        message: authRes.status === 'fulfilled' ? `v${authRes.value.server_info?.version || '?'}` : 'Not reachable',
      });
      setHealthChecks(checks);

      setLastRefresh(new Date());
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 15000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  const f = forecast?.forecast;
  const workers = forecast?.workers ?? {};
  const workerLimits = forecast?.worker_limits ?? {};
  const sat = forecast?.saturation ?? {};

  return (
    <div data-ai-id="workers-tab" style={{ padding: 12 }}>
      <Toolbar lastRefresh={lastRefresh} loading={loading} onRefresh={fetchAll} autoRefresh={15} />
      {error && <ErrorBanner message={error} onRetry={fetchAll} />}
      {loading && !forecast && <LoadingSpinner text="Lade Worker-Status..." />}

      {/* ── Fleet Header / Queue Forecast ─────────────────── */}
      {f && (
        <SectionFlat title={`Queue Forecast (${forecast?.window_seconds ?? 120}s window)`}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
            <StatCard label="In-Flight" value={String(f.in_flight_total)}
              color={f.in_flight_total > 5 ? 'var(--tn-orange)' : 'var(--tn-text)'} aiId="workers-inflight" />
            <StatCard label="Drain Rate" value={`${f.drain_rate_per_s.toFixed(2)}/s`} color="var(--tn-blue)" aiId="workers-drain" />
            <StatCard label="Arrival Rate" value={`${f.arrival_rate_per_s.toFixed(2)}/s`} color="var(--tn-blue)" aiId="workers-arrival" />
            <StatCard label="Trend" value={f.backlog_trend}
              color={f.backlog_trend === 'growing' ? 'var(--tn-red)' : f.backlog_trend === 'draining' ? 'var(--tn-green)' : 'var(--tn-text-muted)'}
              aiId="workers-trend" />
            <StatCard label="Rate-Limit Risk"
              value={`${f.rate_limit_risk}${f.active_workers != null ? ` (${f.active_workers})` : ''}`}
              color={f.rate_limit_risk === 'high' ? 'var(--tn-red)' : f.rate_limit_risk === 'medium' ? 'var(--tn-orange)' : 'var(--tn-green)'}
              aiId="workers-risk" />
            {f.eta_empty_s != null && (
              <StatCard label="ETA Empty" value={f.eta_empty_s === 0 ? 'now' : `${f.eta_empty_s.toFixed(0)}s`} aiId="workers-eta" />
            )}
          </div>
        </SectionFlat>
      )}

      {/* ── Worker Grid ───────────────────────────────────── */}
      {/* Use worker_limits as source of truth — covers all 4 workers always.
          queue-forecast.workers only contains `worker_self` (the worker that
          answered the round-robin request), so we fall back to zero/idle for
          the others. */}
      {Object.keys(workerLimits).length > 0 && (() => {
        const allNames = Array.from(new Set([...Object.keys(workerLimits), ...Object.keys(workers)])).sort();
        return (
        <SectionFlat title={`Workers (${allNames.length})`}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{
              display: 'grid', gridTemplateColumns: '80px 1fr 1fr 80px 90px 70px',
              gap: 8, padding: '4px 10px', fontSize: 9, fontWeight: 700,
              color: 'var(--tn-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em',
            }}>
              <div>Worker</div><div>Account</div><div>Rates</div><div>Avg Dur.</div><div>Errors</div><div style={{ textAlign: 'right' }}>Status</div>
            </div>

            {allNames.map((name) => {
              const wd = workers[name];
              const limit = workerLimits[name];
              const wSat = sat[name];
              const rateLimited = limits?.all_rate_limits?.[name]?.rate_limited;
              const retryAfter = limits?.all_rate_limits?.[name]?.retry_after;
              const downByLimit = limit && !limit.active;
              const hasLiveData = !!wd;
              const satColor =
                rateLimited ? 'var(--tn-red)' :
                wSat === 'rate_limited' ? 'var(--tn-red)' :
                wSat === 'saturated' || wSat === 'busy' ? 'var(--tn-orange)' :
                wSat === 'ok' ? 'var(--tn-green)' : 'var(--tn-text-muted)';
              const statusText =
                downByLimit ? 'DOWN' :
                rateLimited ? 'LIMITED' :
                wSat ? wSat.toUpperCase() :
                hasLiveData ? 'OK' : 'IDLE';

              return (
                <div key={name} style={{
                  display: 'grid', gridTemplateColumns: '80px 1fr 1fr 80px 90px 70px',
                  gap: 8, padding: '6px 10px', fontSize: 10, fontFamily: 'monospace', alignItems: 'center',
                  background: downByLimit ? 'rgba(247,118,142,0.05)' : 'var(--tn-bg-dark)',
                  border: `1px solid ${downByLimit ? 'rgba(247,118,142,0.3)' : 'var(--tn-border)'}`,
                  borderLeft: `3px solid ${downByLimit ? 'var(--tn-red)' : satColor}`,
                  borderRadius: 4,
                  opacity: hasLiveData ? 1 : 0.75,
                }}>
                  <span style={{ fontWeight: 600, color: 'var(--tn-text)' }}>{name}</span>
                  <span style={{ color: 'var(--tn-text-muted)', fontSize: 9 }}>
                    {limit ? `${limit.account} W:${limit.weekly_percent}% S:${limit.session_percent}%` : '-'}
                  </span>
                  <span style={{ color: 'var(--tn-text-muted)', fontSize: 9 }}>
                    {wd
                      ? `in:${wd.in_flight} arr:${wd.arrivals_per_min.toFixed(1)}/m done:${wd.completions_per_min.toFixed(1)}/m`
                      : 'no live data (not hit by LB this window)'}
                  </span>
                  <span style={{ color: 'var(--tn-text-muted)' }}>
                    {wd?.avg_duration_ms ? `${(wd.avg_duration_ms / 1000).toFixed(1)}s` : '-'}
                  </span>
                  <span style={{ color: wd && wd.errors > 0 ? 'var(--tn-orange)' : 'var(--tn-text-muted)' }}>
                    {wd ? `err:${wd.errors}${wd.rate_limit_hits > 0 ? ` rl:${wd.rate_limit_hits}` : ''}` : '—'}
                    {rateLimited && retryAfter ? ` (${retryAfter}s)` : ''}
                  </span>
                  <span style={{ color: satColor, fontWeight: 600, textAlign: 'right' }}>
                    {statusText}
                  </span>
                </div>
              );
            })}
          </div>
        </SectionFlat>
        );
      })()}

      {/* ── Rate Limits Summary ───────────────────────────── */}
      {limits?.all_rate_limits && (() => {
        const limited = Object.entries(limits.all_rate_limits).filter(([, v]) => v.rate_limited);
        if (limited.length === 0) return null;
        return (
          <SectionFlat title={`Rate-Limited Workers (${limited.length})`}>
            <div style={{ background: 'var(--tn-bg-dark)', borderRadius: 5, overflow: 'hidden' }}>
              {limited.map(([worker, info]) => (
                <div key={worker} style={{
                  display: 'flex', justifyContent: 'space-between', padding: '6px 10px',
                  borderBottom: '1px solid var(--tn-border)', fontSize: 11,
                }}>
                  <span style={{ color: 'var(--tn-text)', fontFamily: 'monospace' }}>{worker}</span>
                  <span style={{ color: 'var(--tn-orange)' }}>Retry: {info.retry_after ? `${info.retry_after}s` : '?'}</span>
                </div>
              ))}
            </div>
          </SectionFlat>
        );
      })()}

      {/* ── Component Health ──────────────────────────────── */}
      {healthChecks.length > 0 && (
        <SectionFlat title="Component Health">
          <div style={{ background: 'var(--tn-bg-dark)', borderRadius: 5, overflow: 'hidden' }}>
            {healthChecks.map((check, idx) => (
              <div key={check.component} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '6px 10px', fontSize: 11,
                borderBottom: idx < healthChecks.length - 1 ? '1px solid var(--tn-border)' : 'none',
              }}>
                <span style={{ color: 'var(--tn-text)', fontWeight: 500 }}>{check.component}</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {check.message && <span style={{ fontSize: 10, color: 'var(--tn-text-muted)' }}>{check.message}</span>}
                  <StatusBadge status={check.status === 'ok' ? 'ok' : check.status === 'degraded' ? 'warn' : 'error'} label={check.status.toUpperCase()} />
                </div>
              </div>
            ))}
          </div>
        </SectionFlat>
      )}
    </div>
  );
}
