import { useState, useEffect, useCallback } from 'react';
import { bridgeJson, Toolbar, ErrorBanner, LoadingSpinner, SectionFlat } from '../shared';

// ─── Types ──────────────────────────────────────────────────────────

interface PoolSummary {
  requests: number;
  errors: number;
  client_errors: number;
  server_errors: number;
  error_rate: number;
  server_error_rate: number;
  p50_ms: number;
  p95_ms: number;
  avg_ms: number;
  rescued: number;
  lost: number;
  retry_count: number;
  present: boolean;
}

interface Incident {
  id: string;
  source: 'dev' | 'prod';
  endpoint: string;
  start_ts: number;
  end_ts: number;
  count: number;
  status_codes: Record<string, number>;
  apps: Record<string, number>;
  sample_user_agents: string[];
  last_msg: string;
  resolved: boolean;
  rescued_via_failover: number;
}

interface FailoverStats {
  dev_rescued: number;
  dev_lost: number;
  prod_rescued: number;
  prod_lost: number;
  total_retries: number;
  total_rescued: number;
  total_lost: number;
  success_rate: number;
}

interface EventsData {
  overall_status: 'healthy' | 'degraded' | 'critical';
  pools: { dev: PoolSummary; prod: PoolSummary };
  failover: FailoverStats;
  incidents: Incident[];
  active_incidents: number;
  window_hours: number;
  sources: Record<string, { present: boolean; mtime: number | null; bytes: number; age_sec: number | null }>;
  generated_at: string;
}

interface WorkerInfo {
  status: 'up' | 'down';
  http_code?: number;
  server?: string;
}

interface LbStatus {
  status: string;
  workers: {
    total: number;
    up: number;
    down: number;
    per_worker: Record<string, WorkerInfo>;
  };
}

interface StabilityWindow {
  uptime_prod_pct: number | null;
  uptime_dev_pct: number | null;
  dev: { requests: number; errors: number; server_errors: number; lost: number; outage_minutes: number };
  prod: { requests: number; errors: number; server_errors: number; lost: number; outage_minutes: number };
  hours_covered: number;
}

interface StabilityData {
  tracking_since: string | null;
  tracking_duration_sec: number;
  last_prod_outage: { hour: string; lost: number } | null;
  time_since_prod_outage_sec: number | null;
  windows: {
    '24h': StabilityWindow;
    '7d':  StabilityWindow;
    '30d': StabilityWindow;
  };
  daily: Array<{ day: string; dev_requests: number; dev_lost: number; prod_requests: number; prod_lost: number; prod_uptime_pct: number | null }>;
  generated_at: string;
}

// ─── Helpers ────────────────────────────────────────────────────────

function timeAgoShort(epochSec: number): string {
  const diff = Math.max(0, Date.now() / 1000 - epochSec);
  if (diff < 60) return `vor ${Math.floor(diff)}s`;
  if (diff < 3600) return `vor ${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `vor ${Math.floor(diff / 3600)}h`;
  return `vor ${Math.floor(diff / 86400)}d`;
}

function timeRange(startTs: number, endTs: number): string {
  const start = new Date(startTs * 1000).toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' });
  const end = new Date(endTs * 1000).toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' });
  return start === end ? start : `${start}–${end}`;
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${Math.floor(sec)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  return hours > 0 ? `${days}T ${hours}h` : `${days}T`;
}

function formatDurationLong(sec: number): string {
  if (sec < 3600) return `${Math.floor(sec / 60)} Minuten`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} Stunden`;
  return `${Math.floor(sec / 86400)} Tagen`;
}

function poolStatus(p: PoolSummary): { color: string; label: string; border: string } {
  if (!p.present) return { color: 'var(--tn-text-muted)', label: 'NO DATA', border: 'var(--tn-border)' };
  if (p.lost > 0) return { color: 'var(--tn-red)', label: 'AUSFALL', border: 'var(--tn-red)' };
  if (p.server_errors > 0) return { color: 'var(--tn-orange)', label: 'SERVER-FEHLER', border: 'var(--tn-orange)' };
  return { color: 'var(--tn-green)', label: 'OPERATIONAL', border: 'var(--tn-green)' };
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtReqPerHour(requests: number, hours: number): string {
  const perHour = requests / Math.max(hours, 1);
  if (perHour >= 1000) return `${(perHour / 1000).toFixed(1)}k`;
  return `${Math.round(perHour)}`;
}

function uptimeColor(pct: number | null): string {
  if (pct === null) return 'var(--tn-text-muted)';
  if (pct >= 99.9) return 'var(--tn-green)';
  if (pct >= 99) return 'var(--tn-orange)';
  return 'var(--tn-red)';
}

// ─── Components ─────────────────────────────────────────────────────

function PoolCard({ label, pool, workers, isReserve, hours }: {
  label: string;
  pool: PoolSummary;
  workers: { total: number; up: number };
  isReserve?: boolean;
  hours: number;
}) {
  const s = poolStatus(pool);
  const isCritical = pool.lost > 0;

  return (
    <div
      data-ai-id={`status-pool-${label.toLowerCase()}`}
      style={{
        flex: 1,
        minWidth: 260,
        background: 'var(--tn-bg-dark)',
        border: `2px solid ${s.border}`,
        borderRadius: 8,
        padding: '14px 16px',
        position: 'relative',
        boxShadow: isCritical ? `0 0 0 3px rgba(247,118,142,0.15)` : 'none',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{
            width: 10, height: 10, borderRadius: '50%', background: s.color, display: 'inline-block',
            animation: isCritical ? 'pulse 2s infinite' : 'none',
          }} />
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--tn-text)', letterSpacing: '0.03em' }}>
            {label}
          </span>
          <span style={{ fontSize: 9, color: 'var(--tn-text-muted)', fontWeight: 600 }}>
            {isReserve ? 'RESERVE' : 'PRIMARY'}
          </span>
        </div>
        <span style={{ fontSize: 10, fontWeight: 700, color: s.color, letterSpacing: '0.05em' }}>
          {s.label}
        </span>
      </div>

      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 24, fontWeight: 700, color: s.color, fontFamily: 'monospace', lineHeight: 1 }}>
          {pool.lost > 0 ? `${pool.lost} verloren` : pool.server_errors > 0 ? `${pool.server_errors} 5xx` : '0 Ausfälle'}
        </div>
        <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginTop: 2 }}>
          {pool.requests.toLocaleString('de-AT')} Requests ({hours}h)
          {pool.client_errors > 0 && (
            <span style={{ marginLeft: 6, color: 'var(--tn-text-muted)' }}>
              · {pool.client_errors} 4xx (Client)
            </span>
          )}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, fontSize: 10 }}>
        <div>
          <div style={{ color: 'var(--tn-text-muted)', marginBottom: 2 }}>Rate</div>
          <div style={{ color: 'var(--tn-text)', fontWeight: 600, fontFamily: 'monospace' }}>
            {fmtReqPerHour(pool.requests, hours)}/h
          </div>
        </div>
        <div>
          <div style={{ color: 'var(--tn-text-muted)', marginBottom: 2 }}>p50 · p95</div>
          <div style={{ color: 'var(--tn-text)', fontWeight: 600, fontFamily: 'monospace' }}>
            {fmtMs(pool.p50_ms)} · {fmtMs(pool.p95_ms)}
          </div>
        </div>
        <div>
          <div style={{ color: 'var(--tn-text-muted)', marginBottom: 2 }}>Workers</div>
          <div style={{
            color: workers.up === workers.total ? 'var(--tn-green)' : 'var(--tn-orange)',
            fontWeight: 600, fontFamily: 'monospace',
          }}>
            {workers.up}/{workers.total} up
          </div>
        </div>
      </div>

      {(pool.rescued > 0 || pool.lost > 0) && (
        <div style={{
          marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--tn-border)',
          display: 'flex', gap: 12, fontSize: 10, fontFamily: 'monospace',
        }}>
          {pool.rescued > 0 && (
            <span style={{ color: 'var(--tn-green)' }}>
              ✓ {pool.rescued} gerettet
            </span>
          )}
          {pool.lost > 0 && (
            <span style={{ color: 'var(--tn-red)' }}>
              ✗ {pool.lost} verloren
            </span>
          )}
          {pool.retry_count > 0 && (
            <span style={{ color: 'var(--tn-text-muted)' }}>
              {pool.retry_count} Retries
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function IncidentRow({ inc }: { inc: Incident }) {
  const isProd = inc.source === 'prod';
  const isActive = !inc.resolved;
  const rescuedPct = inc.count > 0 ? Math.round((inc.rescued_via_failover / inc.count) * 100) : 0;
  const bg = isActive ? 'rgba(247,118,142,0.08)' : 'transparent';
  const borderColor = isProd ? 'var(--tn-red)' : 'var(--tn-orange)';
  const statusCode = Object.keys(inc.status_codes).join('/');
  const apps = Object.entries(inc.apps).slice(0, 2).map(([a, c]) => `${a}(${c})`).join(', ');
  const isClientOnly = Object.keys(inc.status_codes).every(c => parseInt(c, 10) < 500);

  return (
    <div style={{
      padding: '8px 10px',
      background: bg,
      borderLeft: `3px solid ${borderColor}`,
      borderBottom: '1px solid var(--tn-border)',
      fontSize: 11,
      display: 'grid',
      gridTemplateColumns: '60px 50px 1fr auto',
      gap: 10,
      alignItems: 'center',
      opacity: isClientOnly ? 0.65 : 1,
    }}>
      <span style={{
        fontSize: 9, fontWeight: 700,
        color: isProd ? 'var(--tn-red)' : 'var(--tn-orange)',
        fontFamily: 'monospace',
      }}>
        [{inc.source.toUpperCase()}]
      </span>
      <span style={{
        fontSize: 9, fontWeight: 700,
        color: isClientOnly ? 'var(--tn-text-muted)' : 'var(--tn-red)',
        background: isClientOnly ? 'rgba(150,150,150,0.12)' : 'rgba(247,118,142,0.15)',
        padding: '1px 4px', borderRadius: 3,
        fontFamily: 'monospace',
        textAlign: 'center',
      }}>
        {statusCode}
      </span>
      <div style={{ minWidth: 0, overflow: 'hidden' }}>
        <div style={{
          color: 'var(--tn-text)', fontFamily: 'monospace',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {inc.endpoint}
        </div>
        <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', marginTop: 1 }}>
          {inc.count}× · {timeRange(inc.start_ts, inc.end_ts)} · {apps || 'kein app_id'}
          {isClientOnly && <span style={{ marginLeft: 6 }}>· Client-Fehler</span>}
          {inc.rescued_via_failover > 0 && (
            <span style={{ color: 'var(--tn-green)', marginLeft: 6 }}>
              · {rescuedPct}% gerettet
            </span>
          )}
        </div>
      </div>
      <span style={{ fontSize: 9, color: isActive ? 'var(--tn-orange)' : 'var(--tn-text-muted)', fontWeight: 600 }}>
        {isActive ? 'AKTIV' : timeAgoShort(inc.end_ts)}
      </span>
    </div>
  );
}

function FailoverBar({ failover }: { failover: FailoverStats }) {
  return (
    <div style={{
      padding: '12px 14px',
      background: 'var(--tn-bg-dark)',
      border: '1px solid var(--tn-border)',
      borderRadius: 8,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--tn-text)' }}>
          Failover Performance
        </span>
        <span style={{
          fontSize: 11, fontWeight: 700,
          color: failover.success_rate >= 95 ? 'var(--tn-green)' : failover.success_rate >= 75 ? 'var(--tn-orange)' : 'var(--tn-red)',
          fontFamily: 'monospace',
        }}>
          {failover.success_rate.toFixed(0)}% Success
        </span>
      </div>

      <div style={{ display: 'flex', gap: 4, fontSize: 10, fontFamily: 'monospace' }}>
        <div style={{
          flex: failover.total_rescued > 0 ? failover.total_rescued : 0.01,
          background: 'rgba(158,206,106,0.4)',
          padding: '3px 8px', borderRadius: 3,
          color: 'var(--tn-green)',
          fontWeight: 700,
          textAlign: 'center',
          minWidth: 80,
        }}>
          ✓ {failover.total_rescued} gerettet
        </div>
        <div style={{
          flex: failover.total_lost > 0 ? failover.total_lost : 0.01,
          background: failover.total_lost > 0 ? 'rgba(247,118,142,0.4)' : 'rgba(100,100,100,0.2)',
          padding: '3px 8px', borderRadius: 3,
          color: failover.total_lost > 0 ? 'var(--tn-red)' : 'var(--tn-text-muted)',
          fontWeight: 700,
          textAlign: 'center',
          minWidth: 80,
        }}>
          ✗ {failover.total_lost} verloren
        </div>
      </div>

      <div style={{ marginTop: 8, fontSize: 10, color: 'var(--tn-text-muted)', display: 'flex', gap: 12 }}>
        <span>Dev: {failover.dev_rescued}✓ / {failover.dev_lost}✗</span>
        <span>Prod: {failover.prod_rescued}✓ / {failover.prod_lost}✗</span>
        <span>Retries gesamt: {failover.total_retries}</span>
      </div>
    </div>
  );
}

function StabilityCard({ stability }: { stability: StabilityData }) {
  const trackingDays = stability.tracking_duration_sec / 86400;
  const timeSinceOutage = stability.time_since_prod_outage_sec;
  const hasEverHadOutage = stability.last_prod_outage !== null;

  return (
    <div
      data-ai-id="status-stability"
      style={{
        background: 'var(--tn-bg-dark)',
        border: '1px solid var(--tn-border)',
        borderRadius: 8,
        padding: '14px 16px',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--tn-text)', letterSpacing: '0.03em' }}>
          Stabilität · Ziel 100%
        </span>
        <span style={{ fontSize: 9, color: 'var(--tn-text-muted)', fontFamily: 'monospace' }}>
          Tracking seit {trackingDays < 1 ? `${Math.floor(stability.tracking_duration_sec / 3600)}h` : `${Math.floor(trackingDays)}T`}
        </span>
      </div>

      {/* Hero: Time since last outage */}
      <div style={{
        background: hasEverHadOutage ? 'rgba(158,206,106,0.08)' : 'rgba(158,206,106,0.12)',
        border: `1px solid ${hasEverHadOutage ? 'var(--tn-green)' : 'var(--tn-green)'}`,
        borderRadius: 6,
        padding: '10px 12px',
        marginBottom: 12,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
      }}>
        <div>
          <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', fontWeight: 600, marginBottom: 2 }}>
            Ohne Prod-Ausfall
          </div>
          <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--tn-green)', fontFamily: 'monospace', lineHeight: 1 }}>
            {timeSinceOutage === null
              ? (trackingDays >= 1 ? `${Math.floor(trackingDays)} Tage` : formatDuration(stability.tracking_duration_sec))
              : formatDurationLong(timeSinceOutage)}
          </div>
        </div>
        <div style={{ fontSize: 28 }}>✓</div>
      </div>

      {/* Uptime windows */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
        {(['24h', '7d', '30d'] as const).map(key => {
          const w = stability.windows[key];
          const pct = w.uptime_prod_pct;
          const hasData = w.hours_covered > 0;
          return (
            <div key={key} style={{
              background: 'var(--tn-surface)',
              border: '1px solid var(--tn-border)',
              borderRadius: 4,
              padding: '8px 10px',
            }}>
              <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', fontWeight: 600, marginBottom: 2, textTransform: 'uppercase' }}>
                {key === '24h' ? '24 Std' : key === '7d' ? '7 Tage' : '30 Tage'}
              </div>
              <div style={{ fontSize: 15, fontWeight: 700, color: uptimeColor(pct), fontFamily: 'monospace' }}>
                {pct !== null ? `${pct.toFixed(pct >= 99 ? 2 : 1)}%` : '—'}
              </div>
              <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', marginTop: 2 }}>
                {hasData ? `${w.prod.lost} lost · ${w.prod.outage_minutes}m down` : 'noch keine Daten'}
              </div>
            </div>
          );
        })}
      </div>

      {/* Heatmap: 30-day strip */}
      {stability.daily.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', fontWeight: 600, marginBottom: 4 }}>
            Letzte 30 Tage · Prod
          </div>
          <div style={{ display: 'flex', gap: 2, height: 14, alignItems: 'stretch' }}>
            {/* Pad with empty cells to always show 30 slots */}
            {Array.from({ length: 30 }, (_, i) => {
              const dayIndex = stability.daily.length - 30 + i;
              const d = dayIndex >= 0 ? stability.daily[dayIndex] : null;
              if (!d) {
                return (
                  <div key={i} style={{
                    flex: 1, background: 'rgba(150,150,150,0.08)', borderRadius: 2, minWidth: 4,
                  }} title="keine Daten" />
                );
              }
              const pct = d.prod_uptime_pct;
              const color = pct === null
                ? 'rgba(150,150,150,0.2)'
                : pct >= 99.9 ? 'var(--tn-green)'
                : pct >= 99 ? 'var(--tn-orange)'
                : 'var(--tn-red)';
              return (
                <div
                  key={i}
                  style={{ flex: 1, background: color, borderRadius: 2, minWidth: 4, opacity: pct === null ? 0.3 : 1 }}
                  title={`${d.day}: ${pct !== null ? pct.toFixed(2) + '%' : 'keine Daten'} · ${d.prod_lost} lost / ${d.prod_requests} req`}
                />
              );
            })}
          </div>
        </div>
      )}

      {/* Last outage footnote */}
      {stability.last_prod_outage && (
        <div style={{ marginTop: 10, fontSize: 10, color: 'var(--tn-text-muted)', fontFamily: 'monospace' }}>
          Letzter Ausfall: {new Date(stability.last_prod_outage.hour).toLocaleString('de-AT')} · {stability.last_prod_outage.lost} req verloren
        </div>
      )}
    </div>
  );
}

function SourceFreshness({ sources }: { sources: EventsData['sources'] }) {
  return (
    <div style={{ display: 'flex', gap: 8, fontSize: 9, fontFamily: 'monospace' }}>
      {(['dev', 'prod'] as const).map(k => {
        const s = sources[k];
        if (!s || !s.present) {
          return (
            <span key={k} style={{ color: 'var(--tn-red)' }}>
              {k}: FEHLT
            </span>
          );
        }
        const age = s.age_sec ?? 0;
        const color = age < 600 ? 'var(--tn-green)' : age < 1800 ? 'var(--tn-orange)' : 'var(--tn-red)';
        const ageLabel = age < 60 ? `${Math.floor(age)}s` : `${Math.floor(age / 60)}m`;
        return (
          <span key={k} style={{ color }}>
            {k}: {ageLabel}
          </span>
        );
      })}
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────

export default function StatusTab() {
  const [events, setEvents] = useState<EventsData | null>(null);
  const [lb, setLb] = useState<LbStatus | null>(null);
  const [stability, setStability] = useState<StabilityData | null>(null);
  const [hours, setHours] = useState<number>(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [evRes, lbRes, stabRes] = await Promise.allSettled([
        fetch(`/api/bridge/events?hours=${hours}`, { signal: AbortSignal.timeout(15000) }).then(r => r.json()),
        bridgeJson<LbStatus>('/lb-status', { timeout: 5000 }),
        fetch('/api/bridge/stability', { signal: AbortSignal.timeout(15000) }).then(r => r.json()),
      ]);
      if (evRes.status === 'fulfilled' && !evRes.value._error) {
        setEvents(evRes.value);
      } else {
        setError('Events konnten nicht geladen werden');
      }
      if (lbRes.status === 'fulfilled') {
        setLb(lbRes.value);
      }
      if (stabRes.status === 'fulfilled' && !stabRes.value._error) {
        setStability(stabRes.value);
      }
      setLastRefresh(new Date());
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [hours]);

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 15000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  const devWorkers = { total: 4, up: 0 };
  const prodWorkers = { total: 1, up: 0 };
  if (lb?.workers?.per_worker) {
    for (const [name, info] of Object.entries(lb.workers.per_worker)) {
      const isProd = name === 'worker-prod' || info.server === 'production';
      const target = isProd ? prodWorkers : devWorkers;
      if (info.status === 'up') target.up++;
    }
  }

  const prodServerErrors = events?.pools.prod.server_errors ?? 0;
  const prodLost = events?.pools.prod.lost ?? 0;
  const overall = events?.overall_status ?? 'healthy';
  const overallColor =
    overall === 'critical' ? 'var(--tn-red)' :
    overall === 'degraded' ? 'var(--tn-orange)' :
    'var(--tn-green)';
  const overallLabel =
    overall === 'critical' ? 'KRITISCH' :
    overall === 'degraded' ? 'DEGRADIERT' :
    'ALLES OK';
  const overallSubtitle =
    overall === 'critical' ? `${prodLost > 0 ? `${prodLost} Prod-Requests verloren` : 'Prod-Server-Fehler aktiv'}` :
    overall === 'degraded' ? `${prodServerErrors} Prod 5xx-Fehler` :
    'Keine Kundenimpact-Fehler';

  return (
    <div data-ai-id="bridge-status-tab" style={{ padding: 12 }}>
      <style>{`@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }`}</style>

      <Toolbar lastRefresh={lastRefresh} loading={loading} onRefresh={fetchAll} autoRefresh={15} />
      {error && <ErrorBanner message={error} onRetry={fetchAll} />}
      {loading && !events && <LoadingSpinner text="Lade Status..." />}

      {events && (
        <>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 12,
            padding: '10px 14px', marginBottom: 14,
            background: `linear-gradient(90deg, ${overallColor}22, transparent)`,
            border: `1px solid ${overallColor}`,
            borderLeftWidth: 4, borderRadius: 6,
          }}>
            <span style={{
              fontSize: 18, fontWeight: 800, color: overallColor, letterSpacing: '0.05em',
            }}>
              ● {overallLabel}
            </span>
            <span style={{ fontSize: 11, color: 'var(--tn-text-muted)', fontWeight: 500 }}>
              — {overallSubtitle}
            </span>
            {events.active_incidents > 0 && (
              <span style={{ fontSize: 11, color: 'var(--tn-orange)', fontWeight: 600 }}>
                · {events.active_incidents} aktive Incidents
              </span>
            )}
            <div style={{ flex: 1 }} />
            <div style={{ display: 'flex', gap: 4 }}>
              {[1, 6, 24].map(h => (
                <button
                  key={h}
                  onClick={() => setHours(h)}
                  data-ai-id={`status-window-${h}h`}
                  style={{
                    padding: '3px 10px', borderRadius: 3, fontSize: 10, fontWeight: 600,
                    cursor: 'pointer', border: 'none',
                    background: hours === h ? 'var(--tn-blue)' : 'var(--tn-bg-dark)',
                    color: hours === h ? '#fff' : 'var(--tn-text-muted)',
                  }}
                >
                  {h}h
                </button>
              ))}
            </div>
            <SourceFreshness sources={events.sources} />
          </div>

          {stability && (
            <div style={{ marginBottom: 14 }}>
              <StabilityCard stability={stability} />
            </div>
          )}

          <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
            <PoolCard label="DEV" pool={events.pools.dev} workers={devWorkers} hours={hours} />
            <PoolCard label="PROD" pool={events.pools.prod} workers={prodWorkers} isReserve hours={hours} />
          </div>

          <div style={{ marginBottom: 14 }}>
            <FailoverBar failover={events.failover} />
          </div>

          <SectionFlat title={`Aktuelle Incidents (${events.incidents.length})`}>
            {events.incidents.length === 0 ? (
              <div style={{
                padding: '20px 14px', textAlign: 'center',
                background: 'var(--tn-bg-dark)', borderRadius: 6,
                border: '1px solid var(--tn-border)',
                fontSize: 11, color: 'var(--tn-green)', fontWeight: 600,
              }}>
                ✓ Keine Incidents in den letzten {hours}h
              </div>
            ) : (
              <div style={{
                background: 'var(--tn-bg-dark)', borderRadius: 6,
                border: '1px solid var(--tn-border)', overflow: 'hidden',
              }}>
                {events.incidents.slice(0, 15).map(inc => (
                  <IncidentRow key={inc.id} inc={inc} />
                ))}
                {events.incidents.length > 15 && (
                  <div style={{
                    padding: '6px 10px', fontSize: 10, color: 'var(--tn-text-muted)',
                    textAlign: 'center', fontStyle: 'italic',
                  }}>
                    … {events.incidents.length - 15} weitere im Errors-Tab
                  </div>
                )}
              </div>
            )}
          </SectionFlat>
        </>
      )}
    </div>
  );
}
