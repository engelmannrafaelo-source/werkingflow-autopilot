import { useState, useEffect, useCallback } from 'react';
import { bridgeJson, StatCard, SectionFlat, StatusBadge, Toolbar, ErrorBanner, LoadingSpinner, formatTokens } from '../shared';

// ─── Types ──────────────────────────────────────────────────────────

interface Usage24h {
  total_calls: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_tokens: number;
  total_errors: number;
  cost_usd: number;
  models: number;
  apps: number;
}

interface WorkersStatus {
  up: number;
  total: number;
  status: string;
}

interface GuardSlotInfo {
  label: string;
  active: number;
  max: number;
  available: number;
  requests: Array<{ caller: string; appId: string; duration: number }>;
}

interface GuardData {
  running: boolean;
  slots?: Record<string, GuardSlotInfo>;
  queue?: Array<{ type: string; priority: number; caller: string; waitSeconds: number }>;
  queueLength?: number;
  metrics?: { totalRequests: number; totalCompleted: number; totalPreempted: number };
}

interface OverviewData {
  health: string;
  workers_status?: WorkersStatus | null;
  usage_24h?: Usage24h | null;
  memory_used_gb?: number;
  memory_usage_percent?: number;
  active_requests?: number;
  active_sessions?: number;
  can_accept_requests?: boolean;
  rate_limited?: boolean;
  guard?: GuardData;
  timestamp: string;
}

interface CostBreakdown {
  total_cost_usd: number;
  total_requests: number;
  total_input_tokens: number;
  total_output_tokens: number;
  breakdown: Record<string, { requests: number; input_tokens: number; output_tokens: number; cost_usd: number }>;
}

interface AppInfo {
  app_id?: string;
  requests?: number;
  total_requests?: number;
  tokens?: number;
  total_tokens?: number;
  last_seen?: string;
}

interface AppsResponse {
  apps_realtime?: AppInfo[];
  apps_period?: AppInfo[];
}

// ─── Helpers ────────────────────────────────────────────────────────

const PRICING_LABELS: Record<string, string> = {
  'claude-haiku-4-5-20251001': 'Haiku 4.5',
  'claude-sonnet-4-5-20250929': 'Sonnet 4.5',
  'claude-opus-4-6': 'Opus 4.6',
  'claude-opus-4-20250514': 'Opus 4',
};

function modelLabel(model: string): string {
  return PRICING_LABELS[model] ?? model.replace('claude-', '').slice(0, 15);
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'jetzt';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

function activityColor(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 3600_000) return 'var(--tn-green)';
  if (diff < 86400_000) return 'var(--tn-orange)';
  return 'var(--tn-red)';
}

// ─── Component ──────────────────────────────────────────────────────

export default function DashboardTab() {
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [cost, setCost] = useState<CostBreakdown | null>(null);
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [overviewRes, costRes, appsRes] = await Promise.allSettled([
        fetch('/api/bridge/metrics/overview', { signal: AbortSignal.timeout(15000) }).then(r => r.json()),
        fetch('/api/bridge/metrics/cost', { signal: AbortSignal.timeout(10000) }).then(r => r.json()),
        fetch('/api/bridge/metrics/apps', { signal: AbortSignal.timeout(10000) }).then(r => r.json()),
      ]);

      if (overviewRes.status === 'fulfilled' && !overviewRes.value._error) {
        setOverview(overviewRes.value);
      } else {
        setError('Bridge nicht erreichbar');
      }

      if (costRes.status === 'fulfilled' && !costRes.value.error) {
        setCost(costRes.value);
      }

      if (appsRes.status === 'fulfilled') {
        const d = appsRes.value as AppsResponse;
        setApps(d.apps_realtime ?? d.apps_period ?? []);
      }

      setLastRefresh(new Date());
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 60000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  const u = overview?.usage_24h;
  const ws = overview?.workers_status;
  const g = overview?.guard;

  return (
    <div data-ai-id="bridge-dashboard-tab" style={{ padding: 12 }}>
      <Toolbar lastRefresh={lastRefresh} loading={loading} onRefresh={fetchAll} />
      {error && <ErrorBanner message={error} onRetry={fetchAll} />}
      {loading && !overview && <LoadingSpinner text="Lade Dashboard..." />}

      {overview && (
        <>
          {/* ── System Status Strip ────────────────────────────── */}
          <div data-ai-id="dashboard-status-strip" style={{
            display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px',
            background: 'var(--tn-bg-dark)', borderRadius: 6, marginBottom: 12,
            border: `1px solid ${overview.health === 'healthy' ? 'var(--tn-green)' : 'var(--tn-red)'}`,
            borderLeftWidth: 3,
          }}>
            <StatusBadge
              status={overview.health === 'healthy' ? 'ok' : 'error'}
              label={overview.health.toUpperCase()}
            />
            <span style={{ fontSize: 11, color: 'var(--tn-text-muted)', fontFamily: 'monospace' }}>
              {ws ? `${ws.up}/${ws.total} Workers` : '? Workers'}
            </span>
            {g && (
              <span style={{
                fontSize: 11, color: g.running ? 'var(--tn-green)' : 'var(--tn-red)',
                fontFamily: 'monospace',
              }}>
                Guard: {g.running ? (g.queueLength ? `Q:${g.queueLength}` : 'OK') : 'OFF'}
              </span>
            )}
            {overview.memory_used_gb != null && (
              <span style={{ fontSize: 11, color: 'var(--tn-text-muted)', fontFamily: 'monospace' }}>
                Mem: {overview.memory_used_gb.toFixed(1)}GB ({(overview.memory_usage_percent ?? 0).toFixed(0)}%)
              </span>
            )}
            {overview.active_requests != null && overview.active_requests > 0 && (
              <span style={{ fontSize: 11, color: 'var(--tn-orange)', fontFamily: 'monospace', fontWeight: 600 }}>
                {overview.active_requests} active
              </span>
            )}
            {overview.rate_limited && (
              <StatusBadge status="limited" label="RATE LIMITED" />
            )}
          </div>

          {/* ── 24h Summary ────────────────────────────────────── */}
          {u && (
            <SectionFlat title="Letzte 24 Stunden">
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
                <StatCard label="Calls" value={formatTokens(u.total_calls)} color="var(--tn-blue)" aiId="dash-calls" />
                <StatCard label="Kosten" value={`$${u.cost_usd.toFixed(2)}`} color="var(--tn-orange)" aiId="dash-cost" />
                <StatCard label="Input Tokens" value={formatTokens(u.total_input_tokens)} sub="prompt" aiId="dash-input" />
                <StatCard label="Output Tokens" value={formatTokens(u.total_output_tokens)} sub="completion" aiId="dash-output" />
                <StatCard
                  label="Error Rate"
                  value={u.total_calls > 0 ? `${((u.total_errors / u.total_calls) * 100).toFixed(1)}%` : '0%'}
                  color={u.total_errors > 0 ? 'var(--tn-red)' : 'var(--tn-green)'}
                  sub={`${u.total_errors} errors`}
                  aiId="dash-errors"
                />
              </div>
            </SectionFlat>
          )}

          {/* ── Kosten pro Modell ──────────────────────────────── */}
          {cost && Object.keys(cost.breakdown).length > 0 && (
            <SectionFlat title="Kosten pro Modell (24h)">
              <div style={{ background: 'var(--tn-bg-dark)', borderRadius: 5, overflow: 'hidden' }}>
                {Object.entries(cost.breakdown)
                  .sort(([, a], [, b]) => b.cost_usd - a.cost_usd)
                  .map(([model, data]) => {
                    const pct = cost.total_cost_usd > 0 ? (data.cost_usd / cost.total_cost_usd) * 100 : 0;
                    return (
                      <div key={model} style={{
                        display: 'grid', gridTemplateColumns: '120px 70px 80px 1fr',
                        gap: 8, padding: '7px 10px', fontSize: 11, alignItems: 'center',
                        borderBottom: '1px solid var(--tn-border)',
                      }}>
                        <div style={{ color: 'var(--tn-text)', fontWeight: 500 }}>{modelLabel(model)}</div>
                        <div style={{ textAlign: 'right', color: 'var(--tn-text-muted)', fontSize: 10 }}>{data.requests} req</div>
                        <div style={{ textAlign: 'right', color: 'var(--tn-orange)', fontWeight: 600, fontFamily: 'monospace' }}>
                          ${data.cost_usd.toFixed(2)}
                        </div>
                        <div style={{ height: 6, background: 'var(--tn-border)', borderRadius: 3, overflow: 'hidden' }}>
                          <div style={{ height: '100%', width: `${pct}%`, background: 'var(--tn-orange)', borderRadius: 3 }} />
                        </div>
                      </div>
                    );
                  })}
              </div>
            </SectionFlat>
          )}

          {/* ── Top Apps ───────────────────────────────────────── */}
          {apps.length > 0 && (
            <SectionFlat title={`Apps (${apps.length})`}>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {apps.map(app => {
                  const reqs = app.requests ?? app.total_requests ?? 0;
                  const tokens = app.tokens ?? app.total_tokens ?? 0;
                  const color = app.last_seen ? activityColor(app.last_seen) : 'var(--tn-text-muted)';
                  return (
                    <div key={app.app_id ?? 'unknown'} style={{
                      padding: '8px 12px', background: 'var(--tn-bg-dark)',
                      border: '1px solid var(--tn-border)', borderRadius: 6,
                      borderLeft: `3px solid ${color}`, minWidth: 120,
                    }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--tn-text)', fontFamily: 'monospace', marginBottom: 4 }}>
                        {app.app_id ?? 'unknown'}
                      </div>
                      <div style={{ display: 'flex', gap: 10, fontSize: 9, color: 'var(--tn-text-muted)' }}>
                        <span>{reqs} req</span>
                        {tokens > 0 && <span>{formatTokens(tokens)} tok</span>}
                        {app.last_seen && <span style={{ color }}>{timeAgo(app.last_seen)}</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </SectionFlat>
          )}

          {/* ── AI-Guard ───────────────────────────────────────── */}
          {g && g.running && g.slots && (
            <SectionFlat title={`AI-Guard${g.queueLength ? ` (Queue: ${g.queueLength})` : ''}`}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {Object.entries(g.slots).map(([type, slot]) => (
                  <div key={type} style={{
                    padding: '8px 12px', background: 'var(--tn-bg-dark)',
                    border: '1px solid var(--tn-border)', borderRadius: 6,
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                      <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--tn-text)', fontFamily: 'monospace' }}>{type}</span>
                      <span style={{ fontSize: 9, fontWeight: 700, color: slot.active > 0 ? 'var(--tn-orange)' : 'var(--tn-text-muted)' }}>
                        {slot.active}/{slot.max}
                      </span>
                    </div>
                    <div style={{ display: 'flex', gap: 2, height: 6 }}>
                      {Array.from({ length: slot.max }, (_, i) => (
                        <div key={i} style={{
                          flex: 1, borderRadius: 2,
                          background: i < slot.active ? 'var(--tn-orange)' : 'rgba(158,206,106,0.2)',
                        }} />
                      ))}
                    </div>
                    {slot.requests.length > 0 && (
                      <div style={{ marginTop: 4, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {slot.requests.map((r, i) => (
                          <span key={i} style={{
                            fontSize: 8, padding: '1px 4px', borderRadius: 2,
                            background: 'rgba(122,162,247,0.15)', color: 'var(--tn-blue)', fontFamily: 'monospace',
                          }}>
                            {r.caller} ({r.duration}s)
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
                {g.metrics && (
                  <div style={{ display: 'flex', gap: 12, fontSize: 9, color: 'var(--tn-text-muted)', paddingTop: 4 }}>
                    <span>Total: {g.metrics.totalRequests}</span>
                    <span>Completed: {g.metrics.totalCompleted}</span>
                    {g.metrics.totalPreempted > 0 && (
                      <span style={{ color: 'var(--tn-orange)' }}>Preempted: {g.metrics.totalPreempted}</span>
                    )}
                  </div>
                )}
              </div>
            </SectionFlat>
          )}
          {g && !g.running && (
            <div style={{
              padding: '8px 12px', background: 'rgba(247,118,142,0.1)',
              border: '1px solid rgba(247,118,142,0.2)', borderRadius: 6,
              fontSize: 10, color: 'var(--tn-red)', marginBottom: 12,
            }}>
              AI-Guard offline — Calls gehen direkt an Hetzner ohne Concurrency-Kontrolle
            </div>
          )}
        </>
      )}
    </div>
  );
}
