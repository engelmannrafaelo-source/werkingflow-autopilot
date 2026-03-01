import { useState, useEffect, useCallback } from 'react';

interface PlatformStats {
  totalUsers?: number;
  totalTenants?: number;
  totalProjects?: number;
  activeSessions?: number;
  [key: string]: unknown;
}

interface HealthStatus {
  status?: string;
  services?: Record<string, { status: string; latency?: number; error?: string }>;
  [key: string]: unknown;
}

interface InfraStatus {
  services?: Array<{ name: string; status: string; url?: string; latency?: number; error?: string }>;
  [key: string]: unknown;
}

interface BillingSummary {
  mrr?: number;
  totalRevenue?: number;
  activeSubscriptions?: number;
  planDistribution?: Record<string, number>;
  mrrTrend?: Array<{ month: string; mrr: number }>;
  [key: string]: unknown;
}

export default function DashboardTab({ envMode }: { envMode?: string }) {
  const [stats, setStats] = useState<PlatformStats | null>(null);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [infra, setInfra] = useState<InfraStatus | null>(null);
  const [billing, setBilling] = useState<BillingSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [statsRes, healthRes, infraRes, billingRes] = await Promise.all([
        fetch('/api/admin/wr/stats').catch(() => null),
        fetch('/api/admin/wr/health').catch(() => null),
        fetch('/api/admin/wr/infrastructure').catch(() => null),
        fetch('/api/admin/wr/billing/overview').catch(() => null),
      ]);
      if (statsRes?.ok) setStats(await statsRes.json());
      if (healthRes?.ok) setHealth(await healthRes.json());
      if (infraRes?.ok) setInfra(await infraRes.json());
      if (billingRes?.ok) setBilling(await billingRes.json());
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll, envMode]);

  const kpiCard = (label: string, value: string | number, color: string, subtitle?: string) => (
    <div style={{
      padding: 12,
      background: 'var(--tn-bg-dark)',
      border: '1px solid var(--tn-border)',
      borderRadius: 6,
      minWidth: 0,
    }}>
      <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color }}>{value}</div>
      {subtitle && <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', marginTop: 2 }}>{subtitle}</div>}
    </div>
  );

  const statusDot = (status: string) => {
    const colors: Record<string, string> = {
      healthy: 'var(--tn-green)', ok: 'var(--tn-green)', up: 'var(--tn-green)', active: 'var(--tn-green)', READY: 'var(--tn-green)',
      degraded: 'var(--tn-orange)', warning: 'var(--tn-orange)', slow: 'var(--tn-orange)',
      down: 'var(--tn-red)', error: 'var(--tn-red)', ERROR: 'var(--tn-red)', unhealthy: 'var(--tn-red)',
    };
    const c = colors[status?.toLowerCase()] || 'var(--tn-text-muted)';
    return (
      <span style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: c,
        marginRight: 6,
        boxShadow: `0 0 4px ${c}`,
      }} />
    );
  };

  return (
    <div data-ai-id="wr-dashboard-tab" style={{ padding: 12 }}>
      <div data-ai-id="wr-dashboard-header" style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <button data-ai-id="wr-dashboard-refresh-btn" onClick={fetchAll} style={{
          padding: '3px 10px', borderRadius: 3, fontSize: 10, cursor: 'pointer',
          background: 'var(--tn-bg)', border: '1px solid var(--tn-border)', color: 'var(--tn-text-muted)',
        }}>Refresh</button>
      </div>

      {error && <div data-ai-id="wr-dashboard-error" style={{ padding: '4px 8px', fontSize: 11, color: 'var(--tn-red)', background: 'rgba(247,118,142,0.1)', borderRadius: 3, marginBottom: 8 }}>{error}</div>}
      {loading && <div data-ai-id="wr-dashboard-loading" style={{ padding: 20, textAlign: 'center', color: 'var(--tn-text-muted)', fontSize: 12 }}>Loading dashboard...</div>}

      {!loading && (
        <>
          {/* KPI Cards */}
          <div data-ai-id="wr-dashboard-kpi-cards" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 16 }}>
            {kpiCard('Total Users', stats?.totalUsers ?? '—', 'var(--tn-blue)')}
            {kpiCard('Tenants', stats?.totalTenants ?? '—', 'var(--tn-green)')}
            {kpiCard('MRR', billing?.mrr != null ? `€${billing.mrr.toFixed(2)}` : '—', 'var(--tn-green)')}
            {kpiCard('Subscriptions', billing?.activeSubscriptions ?? '—', 'var(--tn-orange)')}
          </div>

          {/* Plan Distribution */}
          {billing?.planDistribution && Object.keys(billing.planDistribution).length > 0 && (
            <div data-ai-id="wr-dashboard-plan-distribution" style={{ marginBottom: 16 }}>
              <div data-ai-id="wr-dashboard-plan-distribution-title" style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginBottom: 6, fontWeight: 600, textTransform: 'uppercase' }}>Plan Distribution</div>
              <div data-ai-id="wr-dashboard-plan-distribution-items" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {Object.entries(billing.planDistribution).map(([plan, count]) => (
                  <div key={plan} style={{
                    padding: '6px 12px',
                    background: 'var(--tn-bg-dark)',
                    border: '1px solid var(--tn-border)',
                    borderRadius: 4,
                    fontSize: 11,
                  }}>
                    <span style={{ color: 'var(--tn-text-muted)', marginRight: 6, textTransform: 'capitalize' }}>{plan}</span>
                    <span style={{ color: 'var(--tn-blue)', fontWeight: 700 }}>{count as number}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* System Health */}
          <div data-ai-id="wr-dashboard-health-title" style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginBottom: 6, fontWeight: 600, textTransform: 'uppercase' }}>System Health</div>
          <div data-ai-id="wr-dashboard-health-panel" style={{
            background: 'var(--tn-bg-dark)',
            border: '1px solid var(--tn-border)',
            borderRadius: 6,
            padding: 10,
            marginBottom: 16,
          }}>
            {health?.status && (
              <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8, paddingBottom: 8, borderBottom: '1px solid var(--tn-border)' }}>
                {statusDot(health.status)}
                <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--tn-text)', textTransform: 'uppercase' }}>
                  Overall: {health.status}
                </span>
              </div>
            )}
            {health?.services && Object.entries(health.services).map(([name, svc]) => (
              <div key={name} style={{ display: 'flex', alignItems: 'center', padding: '4px 0', fontSize: 11 }}>
                {statusDot(svc.status)}
                <span style={{ color: 'var(--tn-text)', flex: 1 }}>{name}</span>
                {svc.latency != null && <span style={{ color: 'var(--tn-text-muted)', fontSize: 10, marginRight: 8 }}>{svc.latency}ms</span>}
                <span style={{
                  fontSize: 9, fontWeight: 600, textTransform: 'uppercase',
                  color: svc.status === 'healthy' || svc.status === 'ok' ? 'var(--tn-green)' : svc.status === 'degraded' ? 'var(--tn-orange)' : 'var(--tn-red)',
                }}>{svc.status}</span>
              </div>
            ))}
            {!health?.services && !health?.status && (
              <div style={{ color: 'var(--tn-text-muted)', fontSize: 11, textAlign: 'center', padding: 8 }}>Health data unavailable</div>
            )}
          </div>

          {/* Infrastructure Services */}
          {infra?.services && infra.services.length > 0 && (
            <>
              <div data-ai-id="wr-dashboard-infra-title" style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginBottom: 6, fontWeight: 600, textTransform: 'uppercase' }}>Infrastructure</div>
              <div data-ai-id="wr-dashboard-infra-panel" style={{
                background: 'var(--tn-bg-dark)',
                border: '1px solid var(--tn-border)',
                borderRadius: 6,
                padding: 10,
                marginBottom: 16,
              }}>
                {infra.services.map((svc, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', padding: '4px 0', fontSize: 11 }}>
                    {statusDot(svc.status)}
                    <span style={{ color: 'var(--tn-text)', flex: 1 }}>{svc.name}</span>
                    {svc.url && <span style={{ color: 'var(--tn-text-muted)', fontSize: 9, marginRight: 8, fontFamily: 'monospace' }}>{svc.url.replace('https://', '')}</span>}
                    {svc.latency != null && <span style={{ color: 'var(--tn-text-muted)', fontSize: 10, marginRight: 8 }}>{svc.latency}ms</span>}
                    <span style={{
                      fontSize: 9, fontWeight: 600, textTransform: 'uppercase',
                      padding: '2px 6px', borderRadius: 3,
                      background: svc.status === 'healthy' || svc.status === 'ok' ? 'rgba(158,206,106,0.15)' : svc.status === 'degraded' ? 'rgba(224,175,104,0.15)' : 'rgba(247,118,142,0.15)',
                      color: svc.status === 'healthy' || svc.status === 'ok' ? 'var(--tn-green)' : svc.status === 'degraded' ? 'var(--tn-orange)' : 'var(--tn-red)',
                    }}>{svc.status}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* MRR Trend */}
          {billing?.mrrTrend && billing.mrrTrend.length > 0 && (
            <>
              <div data-ai-id="wr-dashboard-mrr-trend-title" style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginBottom: 6, fontWeight: 600, textTransform: 'uppercase' }}>MRR Trend</div>
              <div data-ai-id="wr-dashboard-mrr-trend-chart" style={{ display: 'flex', gap: 6, alignItems: 'flex-end', height: 60, padding: '0 4px', marginBottom: 16 }}>
                {billing.mrrTrend.map((m, i) => {
                  const max = Math.max(...billing.mrrTrend!.map(x => x.mrr), 1);
                  const h = Math.max(4, (m.mrr / max) * 50);
                  return (
                    <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                      <div style={{ fontSize: 8, color: 'var(--tn-text-muted)' }}>€{m.mrr.toFixed(0)}</div>
                      <div style={{ width: '100%', height: h, background: 'var(--tn-green)', borderRadius: 2, minWidth: 8 }} />
                      <div style={{ fontSize: 8, color: 'var(--tn-text-muted)' }}>{m.month.slice(5)}</div>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {/* Raw JSON fallback for unstructured data */}
          {stats && !stats.totalUsers && !stats.totalTenants && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginBottom: 6, fontWeight: 600, textTransform: 'uppercase' }}>Platform Stats (Raw)</div>
              <pre style={{
                background: 'var(--tn-bg-dark)',
                border: '1px solid var(--tn-border)',
                borderRadius: 6,
                padding: 10,
                fontSize: 10,
                color: 'var(--tn-text)',
                overflow: 'auto',
                maxHeight: 200,
                margin: 0,
              }}>{JSON.stringify(stats, null, 2)}</pre>
            </div>
          )}
        </>
      )}
    </div>
  );
}
