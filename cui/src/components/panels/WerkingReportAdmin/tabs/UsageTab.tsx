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

type ViewMode = 'current' | 'trend';

export default function UsageTab() {
  const [data, setData] = useState<UsageStats | null>(null);
  const [trend, setTrend] = useState<TrendData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [view, setView] = useState<ViewMode>('current');

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [statsRes, trendRes] = await Promise.all([
        fetch('/api/admin/wr/usage/stats?period=month'),
        fetch('/api/admin/wr/usage/trend'),
      ]);
      if (!statsRes.ok) throw new Error(await statsRes.text());
      const [statsData, trendData] = await Promise.all([statsRes.json(), trendRes.json()]);
      setData(statsData);
      if (trendRes.ok) setTrend(trendData);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const chartData = data?.tenants
    .filter(t => t.cost > 0)
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 10)
    .map(t => ({
      name: t.tenantName || (t.tenantId.length > 12 ? t.tenantId.slice(0, 12) + '…' : t.tenantId),
      cost: Math.round(t.cost * 100) / 100,
    })) || [];

  const trendChartData = trend?.months.map(m => ({
    month: m.month.slice(5), // MM only
    cost: Math.round(m.cost * 100) / 100,
    requests: m.requests,
  })) || [];

  const statCard = (label: string, value: string, color: string) => (
    <div style={{ padding: 10, background: 'var(--tn-bg-dark)', border: '1px solid var(--tn-border)', borderRadius: 6 }}>
      <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, color }}>{value}</div>
    </div>
  );

  return (
    <div style={{ padding: 12 }}>
      {/* Header bar */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, alignItems: 'center' }}>
        {(['current', 'trend'] as ViewMode[]).map(v => (
          <button key={v} onClick={() => setView(v)} style={{
            padding: '3px 10px', borderRadius: 3, fontSize: 10, fontWeight: 600, cursor: 'pointer',
            background: view === v ? 'rgba(122,162,247,0.2)' : 'var(--tn-bg)',
            border: `1px solid ${view === v ? 'var(--tn-blue)' : 'var(--tn-border)'}`,
            color: view === v ? 'var(--tn-blue)' : 'var(--tn-text-muted)',
            textTransform: 'capitalize',
          }}>{v === 'current' ? 'This Month' : '6-Month Trend'}</button>
        ))}
        <div style={{ flex: 1 }} />
        <button onClick={fetchAll} style={{ padding: '3px 10px', borderRadius: 3, fontSize: 10, cursor: 'pointer', background: 'var(--tn-bg)', border: '1px solid var(--tn-border)', color: 'var(--tn-text-muted)' }}>Refresh</button>
      </div>

      {error && <div style={{ padding: '4px 8px', fontSize: 11, color: 'var(--tn-red)', background: 'rgba(247,118,142,0.1)', borderRadius: 3, marginBottom: 8 }}>{error}</div>}
      {loading && <div style={{ padding: 20, textAlign: 'center', color: 'var(--tn-text-muted)', fontSize: 12 }}>Loading...</div>}

      {!loading && view === 'current' && data && (
        <>
          {/* Summary Cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 16 }}>
            {statCard('Cost (EUR)', `€${data.totals.cost.toFixed(2)}`, 'var(--tn-green)')}
            {statCard('Tokens', `${(data.totals.tokens / 1000).toFixed(1)}K`, 'var(--tn-blue)')}
            {statCard('Requests', `${data.totals.requests}`, 'var(--tn-orange)')}
            {statCard('Gutachten', `${data.totals.gutachten}`, 'var(--tn-purple, #bb9af7)')}
          </div>

          {/* Bar Chart */}
          {chartData.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginBottom: 6, fontWeight: 600 }}>TOP TENANTS BY COST</div>
              <ResponsiveContainer width="100%" height={120}>
                <BarChart data={chartData} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
                  <XAxis dataKey="name" tick={{ fontSize: 9, fill: 'var(--tn-text-muted)' }} />
                  <YAxis tick={{ fontSize: 9, fill: 'var(--tn-text-muted)' }} width={32} />
                  <Tooltip contentStyle={{ background: 'var(--tn-bg-dark)', border: '1px solid var(--tn-border)', fontSize: 10 }} formatter={(v: number | undefined) => [`€${v ?? 0}`, 'Cost']} />
                  <Bar dataKey="cost" fill="var(--tn-blue)" radius={[2, 2, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Tenant Table */}
          <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginBottom: 6, fontWeight: 600 }}>ALL TENANTS</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 70px 70px 60px 50px', gap: 6, padding: '5px 8px', background: 'var(--tn-bg-dark)', borderRadius: 4, fontSize: 9, fontWeight: 600, color: 'var(--tn-text-muted)', marginBottom: 4 }}>
            <div>Tenant</div><div>Cost</div><div>Tokens</div><div>Req</div><div>Docs</div>
          </div>
          {data.tenants.filter(t => t.tokens > 0 || t.requests > 0).sort((a, b) => b.cost - a.cost).map(t => (
            <div key={t.tenantId} style={{ display: 'grid', gridTemplateColumns: '1fr 70px 70px 60px 50px', gap: 6, padding: '6px 8px', borderBottom: '1px solid var(--tn-border)', fontSize: 10, alignItems: 'center' }}>
              <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                <span style={{ color: 'var(--tn-text)' }}>{t.tenantName || '–'}</span>
                <span style={{ color: 'var(--tn-text-muted)', fontSize: 9, marginLeft: 4 }}>{t.tenantId.slice(0, 8)}</span>
              </div>
              <div style={{ color: 'var(--tn-green)' }}>€{t.cost.toFixed(2)}</div>
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
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 16 }}>
            {statCard('Total Cost (6M)', `€${trend.totalCost.toFixed(2)}`, 'var(--tn-green)')}
            {statCard('Total Tokens (6M)', `${(trend.totalTokens / 1000).toFixed(1)}K`, 'var(--tn-blue)')}
            {statCard('Total Requests (6M)', `${trend.totalRequests}`, 'var(--tn-orange)')}
          </div>
          <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginBottom: 6, fontWeight: 600 }}>COST TREND (EUR/MONTH)</div>
          <ResponsiveContainer width="100%" height={140}>
            <LineChart data={trendChartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--tn-border)" />
              <XAxis dataKey="month" tick={{ fontSize: 9, fill: 'var(--tn-text-muted)' }} />
              <YAxis tick={{ fontSize: 9, fill: 'var(--tn-text-muted)' }} width={36} />
              <Tooltip contentStyle={{ background: 'var(--tn-bg-dark)', border: '1px solid var(--tn-border)', fontSize: 10 }} formatter={(v: number | undefined) => [`€${v ?? 0}`, 'Cost']} />
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
    </div>
  );
}
