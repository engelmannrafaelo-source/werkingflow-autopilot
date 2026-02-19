import { useState, useEffect, useCallback } from 'react';

interface Subscription {
  id: string;
  tenantId: string;
  planId: string;
  status: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  createdAt: string;
}

interface ApiBalance {
  balance: number;
}

interface TenantBilling {
  tenantId: string;
  tenantName: string;
  subscription: Subscription | null;
  apiBalance: ApiBalance | null;
}

interface BillingOverview {
  tenants: TenantBilling[];
  summary: {
    totalMRR: number;
    totalCredits: number;
    totalSubscriptions: number;
  };
}

export default function BillingTab() {
  const [data, setData] = useState<BillingOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const fetchBilling = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/admin/wr/billing/overview');
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
    fetchBilling();
  }, [fetchBilling]);

  return (
    <div style={{ padding: 12 }}>
      {/* Refresh Button */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <button
          onClick={fetchBilling}
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
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: 12,
            marginBottom: 20,
          }}>
            <div style={{
              padding: 12,
              background: 'var(--tn-bg-dark)',
              border: '1px solid var(--tn-border)',
              borderRadius: 6,
            }}>
              <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginBottom: 4 }}>Total MRR</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--tn-green)' }}>
                €{data.summary.totalMRR.toFixed(2)}
              </div>
            </div>

            <div style={{
              padding: 12,
              background: 'var(--tn-bg-dark)',
              border: '1px solid var(--tn-border)',
              borderRadius: 6,
            }}>
              <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginBottom: 4 }}>Active Subscriptions</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--tn-blue)' }}>
                {data.summary.totalSubscriptions}
              </div>
            </div>

            <div style={{
              padding: 12,
              background: 'var(--tn-bg-dark)',
              border: '1px solid var(--tn-border)',
              borderRadius: 6,
            }}>
              <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginBottom: 4 }}>Total Credits</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--tn-orange)' }}>
                €{data.summary.totalCredits.toFixed(2)}
              </div>
            </div>
          </div>

          {/* Tenant List */}
          {data.tenants.length === 0 ? (
            <div style={{
              padding: 20,
              textAlign: 'center',
              color: 'var(--tn-text-muted)',
              fontSize: 11,
            }}>
              No tenants found
            </div>
          ) : (
            <div>
              {/* Table Header */}
              <div style={{
                display: 'grid',
                gridTemplateColumns: '150px 100px 100px 100px 1fr',
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
                <div>Plan</div>
                <div>Status</div>
                <div>API Balance</div>
                <div>Period</div>
              </div>

              {/* Table Rows */}
              {data.tenants.map(tenant => (
                <div
                  key={tenant.tenantId}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '150px 100px 100px 100px 1fr',
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
                    {tenant.tenantName}
                  </div>
                  <div style={{ color: 'var(--tn-text-subtle)' }}>
                    {tenant.subscription?.planId || '-'}
                    {tenant.subscription?.cancelAtPeriodEnd && (
                      <span style={{ marginLeft: 4, fontSize: 9, background: 'rgba(247,118,142,0.2)', color: 'var(--tn-red)', padding: '1px 4px', borderRadius: 2, fontWeight: 600 }}>CANCELS</span>
                    )}
                  </div>
                  <div>
                    {tenant.subscription ? (
                      <span style={{
                        display: 'inline-block',
                        padding: '2px 6px',
                        borderRadius: 3,
                        fontSize: 9,
                        fontWeight: 600,
                        textTransform: 'uppercase',
                        background: tenant.subscription.status === 'active'
                          ? 'rgba(158,206,106,0.2)'
                          : tenant.subscription.status === 'canceled'
                          ? 'rgba(247,118,142,0.2)'
                          : 'rgba(224,175,104,0.2)',
                        color: tenant.subscription.status === 'active'
                          ? 'var(--tn-green)'
                          : tenant.subscription.status === 'canceled'
                          ? 'var(--tn-red)'
                          : 'var(--tn-orange)',
                      }}>
                        {tenant.subscription.status}
                      </span>
                    ) : (
                      <span style={{ color: 'var(--tn-text-muted)', fontSize: 10 }}>-</span>
                    )}
                  </div>
                  <div style={{ color: 'var(--tn-text-subtle)' }}>
                    {tenant.apiBalance ? `€${tenant.apiBalance.balance.toFixed(2)}` : '€0.00'}
                  </div>
                  <div style={{ color: 'var(--tn-text-muted)', fontSize: 10 }}>
                    {tenant.subscription
                      ? `${new Date(tenant.subscription.currentPeriodStart).toLocaleDateString('de-DE')} - ${new Date(tenant.subscription.currentPeriodEnd).toLocaleDateString('de-DE')}`
                      : '-'}
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
