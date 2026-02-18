import { useState, useEffect, useCallback } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';

interface TenantUsage {
  tenantId: string;
  tokens: number;
  cost: number;
  requests: number;
  gutachtenCount: number;
}

interface UsageStats {
  tenants: TenantUsage[];
  totals: {
    tokens: number;
    cost: number;
    requests: number;
    gutachten: number;
  };
  period: string;
}

export default function UsageTab() {
  const [data, setData] = useState<UsageStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const fetchUsage = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/admin/wr/usage/stats?period=month');
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
    fetchUsage();
  }, [fetchUsage]);

  // Prepare chart data (top 10 tenants by cost)
  const chartData = data?.tenants
    .filter(t => t.cost > 0)
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 10)
    .map(t => ({
      name: t.tenantId.length > 15 ? t.tenantId.slice(0, 15) + '...' : t.tenantId,
      cost: Math.round(t.cost * 100) / 100,
    })) || [];

  return (
    <div style={{ padding: 12 }}>
      {/* Refresh Button */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <button
          onClick={fetchUsage}
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
        <div style={{
          padding: '4px 8px',
          fontSize: 11,
          color: 'var(--tn-red)',
          background: 'rgba(247,118,142,0.1)',
          borderRadius: 3,
          marginBottom: 8,
        }}>
          {error}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div style={{
          padding: 20,
          textAlign: 'center',
          color: 'var(--tn-text-muted)',
          fontSize: 12,
        }}>
          Loading...
        </div>
      )}

      {/* Summary Cards */}
      {!loading && data && (
        <>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: 12,
            marginBottom: 20,
          }}>
            <div style={{
              padding: 12,
              background: 'var(--tn-bg-dark)',
              border: '1px solid var(--tn-border)',
              borderRadius: 6,
            }}>
              <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginBottom: 4 }}>Total Cost</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--tn-red)' }}>
                €{data.totals.cost.toFixed(2)}
              </div>
            </div>

            <div style={{
              padding: 12,
              background: 'var(--tn-bg-dark)',
              border: '1px solid var(--tn-border)',
              borderRadius: 6,
            }}>
              <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginBottom: 4 }}>Total Tokens</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--tn-blue)' }}>
                {(data.totals.tokens / 1000000).toFixed(2)}M
              </div>
            </div>

            <div style={{
              padding: 12,
              background: 'var(--tn-bg-dark)',
              border: '1px solid var(--tn-border)',
              borderRadius: 6,
            }}>
              <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginBottom: 4 }}>Total Requests</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--tn-green)' }}>
                {data.totals.requests}
              </div>
            </div>

            <div style={{
              padding: 12,
              background: 'var(--tn-bg-dark)',
              border: '1px solid var(--tn-border)',
              borderRadius: 6,
            }}>
              <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginBottom: 4 }}>Total Gutachten</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--tn-orange)' }}>
                {data.totals.gutachten}
              </div>
            </div>
          </div>

          {/* Chart */}
          {chartData.length > 0 && (
            <div style={{ marginBottom: 20 }}>
              <div style={{
                fontSize: 12,
                fontWeight: 600,
                color: 'var(--tn-text)',
                marginBottom: 12,
              }}>
                Top 10 Tenants by Cost
              </div>
              <div style={{ height: 300 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData}>
                    <XAxis
                      dataKey="name"
                      stroke="var(--tn-text-muted)"
                      fontSize={10}
                      angle={-45}
                      textAnchor="end"
                      height={80}
                    />
                    <YAxis
                      stroke="var(--tn-text-muted)"
                      fontSize={10}
                      tickFormatter={(value) => `€${value}`}
                    />
                    <Tooltip
                      contentStyle={{
                        background: 'var(--tn-surface)',
                        border: '1px solid var(--tn-border)',
                        borderRadius: 4,
                        fontSize: 11,
                        color: 'var(--tn-text)',
                      }}
                      formatter={(value: number) => [`€${value.toFixed(2)}`, 'Cost']}
                    />
                    <Bar dataKey="cost" radius={[4, 4, 0, 0]}>
                      {chartData.map((_, index) => (
                        <Cell key={`cell-${index}`} fill="var(--tn-blue)" />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Tenant List */}
          {data.tenants.length === 0 ? (
            <div style={{
              padding: 20,
              textAlign: 'center',
              color: 'var(--tn-text-muted)',
              fontSize: 11,
            }}>
              No usage data found
            </div>
          ) : (
            <div>
              <div style={{
                fontSize: 12,
                fontWeight: 600,
                color: 'var(--tn-text)',
                marginBottom: 8,
              }}>
                All Tenants
              </div>

              {/* Table Header */}
              <div style={{
                display: 'grid',
                gridTemplateColumns: '150px 100px 100px 100px 100px',
                gap: 8,
                padding: '6px 10px',
                background: 'var(--tn-bg-dark)',
                borderRadius: 4,
                fontSize: 10,
                fontWeight: 600,
                color: 'var(--tn-text-muted)',
                marginBottom: 4,
              }}>
                <div>Tenant</div>
                <div>Cost (EUR)</div>
                <div>Tokens</div>
                <div>Requests</div>
                <div>Gutachten</div>
              </div>

              {/* Table Rows */}
              {data.tenants
                .filter(t => t.cost > 0 || t.tokens > 0 || t.gutachtenCount > 0)
                .map(tenant => (
                  <div
                    key={tenant.tenantId}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '150px 100px 100px 100px 100px',
                      gap: 8,
                      padding: '8px 10px',
                      borderBottom: '1px solid var(--tn-border)',
                      fontSize: 11,
                      alignItems: 'center',
                    }}
                  >
                    <div style={{
                      color: 'var(--tn-text)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}>
                      {tenant.tenantId}
                    </div>
                    <div style={{ color: 'var(--tn-text-subtle)' }}>
                      €{tenant.cost.toFixed(2)}
                    </div>
                    <div style={{ color: 'var(--tn-text-subtle)' }}>
                      {(tenant.tokens / 1000).toFixed(1)}K
                    </div>
                    <div style={{ color: 'var(--tn-text-subtle)' }}>
                      {tenant.requests}
                    </div>
                    <div style={{ color: 'var(--tn-text-subtle)' }}>
                      {tenant.gutachtenCount}
                    </div>
                  </div>
                ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
