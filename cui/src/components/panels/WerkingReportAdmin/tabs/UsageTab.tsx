import { useState, useEffect, useCallback } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, LineChart, Line, CartesianGrid } from 'recharts';

interface TenantUsage {
  tenantId: string;
  tenantName?: string;
  tokens: number;
  cost: number;
  requests: number;
  gutachtenCount: number;
}

interface UsageStats {
  tenants: TenantUsage[];
  totals: { tokens: number; cost: number; requests: number; gutachten: number };
  period: string;
}

interface MonthSummary { month: string; tokens: number; cost: number; requests: number; }
interface TrendData { months: MonthSummary[]; totalTokens: number; totalCost: number; totalRequests: number; }

interface TenantActivity {
  tenantId: string;
  tenantName?: string;
  quotaUsed: number;
  quotaIncluded: number;
  quotaPercentUsed: number;
  requestsThisMonth: number;
  requestsLastMonth: number;
  uploadCount: number;
}
interface ActivityData {
  tenants: TenantActivity[];
  activeTenants: number;
  totalTenants: number;
  month: string;
}

type ViewMode = 'current' | 'trend' | 'activity';

export default function UsageTab({ envMode }: { envMode?: string }) {
  const [data, setData] = useState<UsageStats | null>(null);
  const [trend, setTrend] = useState<TrendData | null>(null);
  const [activity, setActivity] = useState<ActivityData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [view, setView] = useState<ViewMode>('current');

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [statsRes, trendRes, activityRes] = await Promise.all([
        fetch('/api/admin/wr/usage/stats?period=month'),
        fetch('/api/admin/wr/usage/trend'),
        fetch('/api/admin/wr/usage/activity'),
      ]);
      if (!statsRes.ok) throw new Error(await statsRes.text());
      const [statsData, trendData, activityData] = await Promise.all([
        statsRes.json(),
        trendRes.ok ? trendRes.json() : null,
        activityRes.ok ? activityRes.json() : null,
      ]);
      setData(statsData);
      if (trendData) setTrend(trendData);
      if (activityData) setActivity(activityData);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll, envMode]);

  const chartData = data?.tenants
    .filter(t => t.cost > 0)
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 10)
    .map(t => ({
      name: t.tenantName || (t.tenantId.length > 12 ? t.tenantId.slice(0, 12) + '\u2026' : t.tenantId),
      cost: Math.round(t.cost * 100) / 100,
    })) || [];

  const trendChartData = trend?.months.map(m => ({
    month: m.month.slice(5),
    cost: Math.round(m.cost * 100) / 100,
    requests: m.requests,
  })) || [];

  const statCard = (label: string, value: string, color: string) => (
    <div style={{ padding: 10, background: 'var(--tn-bg-dark)', border: '1px solid var(--tn-border)', borderRadius: 6 }}>
      <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, color }}>{value}</div>
    </div>
  );

  const viewLabels: Record<ViewMode, string> = {
    current: 'This Month',
    trend: '6-Month Trend',
    activity: 'Activity',
  };

  return (
    <div data-ai-id="wr-usage-tab" style={{ padding: 12 }}>
      <div data-ai-id="wr-usage-header" style={{ display: 'flex', gap: 6, marginBottom: 12, alignItems: 'center' }}>
        {(['current', 'trend', 'activity'] as ViewMode[]).map(v => (
          <button key={v} data-ai-id={`wr-usage-view-${v}`} data-active={view === v} onClick={() => setView(v)} style={{
            padding: '3px 10px', borderRadius: 3, fontSize: 10, fontWeight: 600, cursor: 'pointer',
            background: view === v ? 'rgba(122,162,247,0.2)' : 'var(--tn-bg)',
            border: `1px solid ${view === v ? 'var(--tn-blue)' : 'var(--tn-border)'}`,
            color: view === v ? 'var(--tn-blue)' : 'var(--tn-text-muted)',
          }}>{viewLabels[v]}</button>
        ))}
        <div style={{ flex: 1 }} />
        <button data-ai-id="wr-usage-refresh-btn" onClick={fetchAll} style={{ padding: '3px 10px', borderRadius: 3, fontSize: 10, cursor: 'pointer', background: 'var(--tn-bg)', border: '1px solid var(--tn-border)', color: 'var(--tn-text-muted)' }}>Refresh</button>
      </div>

      {error && <div data-ai-id="wr-usage-error" style={{ padding: '4px 8px', fontSize: 11, color: 'var(--tn-red)', background: 'rgba(247,118,142,0.1)', borderRadius: 3, marginBottom: 8 }}>{error}</div>}
      {loading && <div data-ai-id="wr-usage-loading" style={{ padding: 20, textAlign: 'center', color: 'var(--tn-text-muted)', fontSize: 12 }}>Loading...</div>}

      {!loading && view === 'current' && data && (
        <>
          <div data-ai-id="wr-usage-current-stats" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 16 }}>
            {statCard('Cost (EUR)', '\u20ac' + data.totals.cost.toFixed(2), 'var(--tn-green)')}
            {statCard('Tokens', (data.totals.tokens / 1000).toFixed(1) + 'K', 'var(--tn-blue)')}
            {statCard('Requests', '' + data.totals.requests, 'var(--tn-orange)')}
            {statCard('Gutachten', '' + data.totals.gutachten, 'var(--tn-purple, #bb9af7)')}
          </div>

          {chartData.length > 0 && (
            <div data-ai-id="wr-usage-current-chart" style={{ marginBottom: 16 }}>
              <div data-ai-id="wr-usage-current-chart-title" style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginBottom: 6, fontWeight: 600 }}>TOP TENANTS BY COST</div>
              <ResponsiveContainer width="100%" height={120}>
                <BarChart data={chartData} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
                  <XAxis dataKey="name" tick={{ fontSize: 9, fill: 'var(--tn-text-muted)' }} />
                  <YAxis tick={{ fontSize: 9, fill: 'var(--tn-text-muted)' }} width={32} />
                  <Tooltip contentStyle={{ background: 'var(--tn-bg-dark)', border: '1px solid var(--tn-border)', fontSize: 10 }} formatter={(v: number | undefined) => ['\u20ac' + (v ?? 0), 'Cost']} />
                  <Bar dataKey="cost" fill="var(--tn-blue)" radius={[2, 2, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          <div data-ai-id="wr-usage-current-tenants-title" style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginBottom: 6, fontWeight: 600 }}>ALL TENANTS</div>
          <div data-ai-id="wr-usage-current-tenants-header" style={{ display: 'grid', gridTemplateColumns: '1fr 70px 70px 60px 50px', gap: 6, padding: '5px 8px', background: 'var(--tn-bg-dark)', borderRadius: 4, fontSize: 9, fontWeight: 600, color: 'var(--tn-text-muted)', marginBottom: 4 }}>
            <div>Tenant</div><div>Cost</div><div>Tokens</div><div>Req</div><div>Docs</div>
          </div>
          {data.tenants.filter(t => t.tokens > 0 || t.requests > 0).sort((a, b) => b.cost - a.cost).map(t => (
            <div key={t.tenantId} data-ai-id={`wr-usage-current-tenant-${t.tenantId}`} style={{ display: 'grid', gridTemplateColumns: '1fr 70px 70px 60px 50px', gap: 6, padding: '6px 8px', borderBottom: '1px solid var(--tn-border)', fontSize: 10, alignItems: 'center' }}>
              <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                <span style={{ color: 'var(--tn-text)' }}>{t.tenantName || '--'}</span>
                <span style={{ color: 'var(--tn-text-muted)', fontSize: 9, marginLeft: 4 }}>{t.tenantId.slice(0, 8)}</span>
              </div>
              <div style={{ color: 'var(--tn-green)' }}>{'\u20ac' + t.cost.toFixed(2)}</div>
              <div style={{ color: 'var(--tn-blue)' }}>{(t.tokens / 1000).toFixed(1)}K</div>
              <div style={{ color: 'var(--tn-text-muted)' }}>{t.requests}</div>
              <div style={{ color: 'var(--tn-text-muted)' }}>{t.gutachtenCount}</div>
            </div>
          ))}
          {data.tenants.filter(t => t.tokens > 0 || t.requests > 0).length === 0 && (
            <div style={{ padding: 20, textAlign: 'center', color: 'var(--tn-text-muted)', fontSize: 11 }}>No usage this month</div>
          )}
        </>
      )}

      {!loading && view === 'trend' && trend && (
        <>
          <div data-ai-id="wr-usage-trend-stats" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 16 }}>
            {statCard('Total Cost (6M)', '\u20ac' + trend.totalCost.toFixed(2), 'var(--tn-green)')}
            {statCard('Total Tokens (6M)', (trend.totalTokens / 1000).toFixed(1) + 'K', 'var(--tn-blue)')}
            {statCard('Total Requests (6M)', '' + trend.totalRequests, 'var(--tn-orange)')}
          </div>
          <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginBottom: 6, fontWeight: 600 }}>COST TREND (EUR/MONTH)</div>
          <ResponsiveContainer width="100%" height={140}>
            <LineChart data={trendChartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--tn-border)" />
              <XAxis dataKey="month" tick={{ fontSize: 9, fill: 'var(--tn-text-muted)' }} />
              <YAxis tick={{ fontSize: 9, fill: 'var(--tn-text-muted)' }} width={36} />
              <Tooltip contentStyle={{ background: 'var(--tn-bg-dark)', border: '1px solid var(--tn-border)', fontSize: 10 }} formatter={(v: number | undefined) => ['\u20ac' + (v ?? 0), 'Cost']} />
              <Line type="monotone" dataKey="cost" stroke="var(--tn-green)" strokeWidth={2} dot={{ r: 3, fill: 'var(--tn-green)' }} />
            </LineChart>
          </ResponsiveContainer>
          <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginTop: 12, marginBottom: 6, fontWeight: 600 }}>REQUESTS / MONTH</div>
          <ResponsiveContainer width="100%" height={100}>
            <BarChart data={trendChartData} margin={{ top: 0, right: 8, bottom: 0, left: 0 }}>
              <XAxis dataKey="month" tick={{ fontSize: 9, fill: 'var(--tn-text-muted)' }} />
              <YAxis tick={{ fontSize: 9, fill: 'var(--tn-text-muted)' }} width={36} />
              <Tooltip contentStyle={{ background: 'var(--tn-bg-dark)', border: '1px solid var(--tn-border)', fontSize: 10 }} />
              <Bar dataKey="requests" fill="var(--tn-blue)" radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </>
      )}

      {!loading && view === 'activity' && activity && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8, marginBottom: 16 }}>
            {statCard('Active Tenants', activity.activeTenants + '/' + activity.totalTenants, 'var(--tn-blue)')}
            {statCard('Month', activity.month, 'var(--tn-text-muted)')}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 140px 70px 70px 60px 80px', gap: 6, padding: '5px 8px', background: 'var(--tn-bg-dark)', borderRadius: 4, fontSize: 9, fontWeight: 600, color: 'var(--tn-text-muted)', marginBottom: 4 }}>
            <div>Tenant</div>
            <div>Quota (Gutachten/Jahr)</div>
            <div>This Mo.</div>
            <div>Last Mo.</div>
            <div>Uploads</div>
            <div>Users</div>
          </div>

          {activity.tenants
            .sort((a, b) => (b.quotaUsed + b.requestsThisMonth) - (a.quotaUsed + a.requestsThisMonth))
            .map(t => {
              const pct = Math.min(100, t.quotaPercentUsed);
              const barColor = pct > 80 ? 'var(--tn-red)' : pct > 50 ? 'var(--tn-orange)' : 'var(--tn-green)';
              return (
                <div key={t.tenantId} style={{ borderBottom: '1px solid var(--tn-border)', padding: '7px 8px', fontSize: 10 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 140px 70px 70px 60px 80px', gap: 6, alignItems: 'center', marginBottom: 4 }}>
                    <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      <span style={{ color: 'var(--tn-text)' }}>{t.tenantName || '--'}</span>
                      <span style={{ color: 'var(--tn-text-muted)', fontSize: 9, marginLeft: 4 }}>{t.tenantId.slice(0, 8)}</span>
                    </div>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2 }}>
                        <span style={{ color: barColor, fontWeight: 600 }}>{t.quotaUsed}</span>
                        <span style={{ color: 'var(--tn-text-muted)' }}>/ {t.quotaIncluded}</span>
                        <span style={{ color: 'var(--tn-text-muted)', fontSize: 9, marginLeft: 2 }}>({pct.toFixed(0)}%)</span>
                      </div>
                      <div style={{ height: 4, background: 'var(--tn-border)', borderRadius: 2, overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: pct + '%', background: barColor, borderRadius: 2 }} />
                      </div>
                    </div>
                    <div style={{ color: 'var(--tn-blue)' }}>{t.requestsThisMonth}</div>
                    <div style={{ color: 'var(--tn-text-muted)' }}>{t.requestsLastMonth}</div>
                    <div style={{ color: t.uploadCount > 0 ? 'var(--tn-orange)' : 'var(--tn-text-muted)' }}>
                      {t.uploadCount > 0 ? t.uploadCount + ' files' : '--'}
                    </div>
                    <div>
                      <button
                        onClick={async () => {
                          const res = await fetch(`/api/admin/wr/usage/activity/users?tenantId=${t.tenantId}`);
                          if (res.ok) {
                            const data = await res.json();
                            alert(`Users (${data.totalUsers}):\n\n` + data.users.map((u: any) =>
                              `${u.userEmail}: ${u.gutachtenCount} Gutachten`
                            ).join('\n'));
                          }
                        }}
                        style={{
                          padding: '3px 8px',
                          fontSize: 9,
                          fontWeight: 600,
                          background: 'var(--tn-bg)',
                          color: 'var(--tn-text-muted)',
                          border: '1px solid var(--tn-border)',
                          borderRadius: 3,
                          cursor: 'pointer',
                        }}
                      >
                        View
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          {activity.tenants.length === 0 && (
            <div style={{ padding: 20, textAlign: 'center', color: 'var(--tn-text-muted)', fontSize: 11 }}>No activity data</div>
          )}
        </>
      )}
    </div>
  );
}
