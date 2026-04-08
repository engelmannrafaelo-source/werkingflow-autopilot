import { useState, useEffect, useCallback } from 'react';
import { bridgeJson, StatCard, Meter, Toolbar, ErrorBanner, LoadingSpinner, SectionFlat } from '../shared';

interface StatsResponse {
  status: string;
  can_accept_requests: boolean;
  request_limiting: {
    active_requests: number;
    max_concurrent: number;
    total_requests: number;
    rejected_requests: number;
    memory_usage_percent: number;
    memory_used_gb: number;
    memory_total_gb: number;
    memory_threshold: number;
  };
}

interface SessionStatsResponse {
  session_stats: {
    active_sessions: number;
    expired_sessions: number;
    total_messages: number;
  };
  cleanup_interval_minutes: number;
  default_ttl_hours: number;
}

interface CliSessionStats {
  total: number;
  running: number;
  completed: number;
  cancelled: number;
  failed: number;
}

interface MetricsResponse {
  metrics: {
    total_requests: number;
    average_duration: number;
    slow_requests: number;
    very_slow_requests: number;
    endpoints: Record<string, {
      count: number;
      avg_duration: number;
      min_duration: number;
      max_duration: number;
      slow_count: number;
      very_slow_count: number;
    }>;
  };
}

export default function AuslastungTab() {
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [sessions, setSessions] = useState<SessionStatsResponse | null>(null);
  const [cliStats, setCliStats] = useState<CliSessionStats | null>(null);
  const [metrics, setMetrics] = useState<MetricsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [statsRes, sessionRes, cliRes, metricsRes] = await Promise.allSettled([
        bridgeJson<StatsResponse>('/stats'),
        bridgeJson<SessionStatsResponse>('/v1/sessions/stats'),
        bridgeJson<{ cli_session_stats: CliSessionStats }>('/v1/cli-sessions/stats'),
        bridgeJson<MetricsResponse>('/v1/metrics'),
      ]);

      if (statsRes.status === 'fulfilled') setStats(statsRes.value);
      else setError('Stats-Endpoint nicht erreichbar');

      if (sessionRes.status === 'fulfilled') setSessions(sessionRes.value);
      if (cliRes.status === 'fulfilled') setCliStats(cliRes.value.cli_session_stats);
      if (metricsRes.status === 'fulfilled') setMetrics(metricsRes.value);

      setLastRefresh(new Date());
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 30000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  const rl = stats?.request_limiting;
  const ss = sessions?.session_stats;
  const m = metrics?.metrics;

  const memColor = !rl ? 'var(--tn-text-muted)'
    : rl.memory_usage_percent > 85 ? 'var(--tn-red)'
    : rl.memory_usage_percent > 60 ? 'var(--tn-orange)'
    : 'var(--tn-green)';

  const reqColor = !rl ? 'var(--tn-blue)'
    : (rl.active_requests / rl.max_concurrent) > 0.8 ? 'var(--tn-red)'
    : 'var(--tn-blue)';

  // Use aggregated metrics for total request count (more reliable than per-worker /stats)
  const totalRequests = m?.total_requests ?? rl?.total_requests ?? 0;

  return (
    <div style={{ padding: 12 }}>
      <Toolbar lastRefresh={lastRefresh} loading={loading} onRefresh={fetchAll} autoRefresh={30} />
      {error && <ErrorBanner message={error} />}

      {!loading && rl && (
        <>
          {/* KPI Cards - combines /stats + /v1/metrics + /v1/cli-sessions/stats */}
          <SectionFlat title="Live-Auslastung">
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
              <StatCard
                label="Aktive Requests"
                value={String(rl.active_requests)}
                sub={`Max: ${rl.max_concurrent} · Abgelehnt: ${rl.rejected_requests}`}
                color={reqColor}
              />
              <StatCard
                label="Requests gesamt"
                value={String(totalRequests)}
                sub={totalRequests === 0 ? 'Worker-Restart → Counter reset' : m?.average_duration ? `Ø ${(m.average_duration ?? 0).toFixed(1)}s` : undefined}
              />
              <StatCard
                label="CLI-Tasks"
                value={cliStats ? String(cliStats.total) : '–'}
                sub={cliStats ? `${cliStats.running} laufend · ${cliStats.failed} fehlgeschlagen` : undefined}
                color={cliStats?.running ? 'var(--tn-blue)' : undefined}
              />
              <StatCard
                label="Akzeptiert"
                value={stats!.can_accept_requests ? 'Ja' : 'Nein'}
                color={stats!.can_accept_requests ? 'var(--tn-green)' : 'var(--tn-red)'}
              />
            </div>

            {/* Request Bar */}
            <div style={{ background: 'var(--tn-bg-dark)', borderRadius: 5, padding: '8px 10px', marginBottom: 8 }}>
              <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginBottom: 4 }}>Request-Auslastung (Worker-Instanz)</div>
              <Meter value={rl.active_requests} max={rl.max_concurrent} color={reqColor} />
            </div>

            {/* Memory Bar */}
            <div style={{ background: 'var(--tn-bg-dark)', borderRadius: 5, padding: '8px 10px' }}>
              <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginBottom: 4 }}>
                Memory ({(rl.memory_used_gb ?? 0).toFixed(1)} GB / {(rl.memory_total_gb ?? 0).toFixed(1)} GB · Threshold: {rl.memory_threshold ?? 0}%)
              </div>
              <Meter value={rl.memory_used_gb} max={rl.memory_total_gb} color={memColor} />
            </div>
          </SectionFlat>

          {/* Slow Requests */}
          {m && (m.slow_requests > 0 || m.very_slow_requests > 0) && (
            <SectionFlat title="Performance-Warnungen">
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <StatCard
                  label="Langsame Requests"
                  value={String(m.slow_requests)}
                  color={m.slow_requests > 0 ? 'var(--tn-orange)' : 'var(--tn-text-muted)'}
                />
                <StatCard
                  label="Sehr langsame Requests"
                  value={String(m.very_slow_requests)}
                  color={m.very_slow_requests > 0 ? 'var(--tn-red)' : 'var(--tn-text-muted)'}
                />
              </div>
            </SectionFlat>
          )}

          {/* Sessions */}
          {ss && (
            <SectionFlat title="Conversation-Sessions">
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <StatCard label="Aktive Sessions" value={String(ss.active_sessions)} color="var(--tn-green)" />
                <StatCard label="Abgelaufen" value={String(ss.expired_sessions)} color="var(--tn-text-muted)" />
                <StatCard label="Nachrichten gesamt" value={String(ss.total_messages)} />
                <StatCard label="TTL" value={`${sessions!.default_ttl_hours}h`} sub={`Cleanup alle ${sessions!.cleanup_interval_minutes}min`} />
              </div>
            </SectionFlat>
          )}
        </>
      )}

      {loading && !stats && <LoadingSpinner text="Lade Auslastungsdaten..." />}
    </div>
  );
}
