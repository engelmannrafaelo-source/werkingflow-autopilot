import { useState, useEffect, useCallback } from 'react';

interface TopUpModalProps {
  tenant: TenantBilling | null;
  onClose: () => void;
  onSuccess: () => void;
}

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
  balanceEur?: number; // New API (local)
  balance?: number;    // Old API (staging/prod) - backward compat
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

interface UsageStats {
  tenants: Array<{
    tenantId: string;
    tenantName?: string;
    tokens: number;
    cost: number;
    requests: number;
    gutachtenCount: number;
  }>;
  totals: {
    tokens: number;
    cost: number;
    requests: number;
    gutachten: number;
  };
}

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

interface Invoice {
  id: string;
  invoiceNumber: string;
  tenantId: string;
  netAmount: number;
  taxAmount: number;
  grossAmount: number;
  currency: string;
  status: 'draft' | 'sent' | 'paid';
  issueDate: string;
  pdfUrl?: string;
  sentAt?: string;
  recipientName: string;
  recipientEmail: string;
}

export default function BillingTab({ envMode }: { envMode?: string }) {
  const [data, setData] = useState<BillingOverview | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [usageStats, setUsageStats] = useState<UsageStats | null>(null);
  const [activityData, setActivityData] = useState<{ tenants: TenantActivity[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingInvoices, setLoadingInvoices] = useState(false);
  const [loadingUsage, setLoadingUsage] = useState(false);
  const [error, setError] = useState('');
  const [showInvoices, setShowInvoices] = useState(false);
  const [showUsage, setShowUsage] = useState(false);
  const [topUpTenant, setTopUpTenant] = useState<TenantBilling | null>(null);

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

  const fetchInvoices = useCallback(async () => {
    setLoadingInvoices(true);
    try {
      const res = await fetch('/api/admin/wr/billing/invoices');
      if (!res.ok) throw new Error(await res.text());
      const result = await res.json();
      setInvoices(result.invoices || []);
    } catch (err: any) {
      console.error('Failed to fetch invoices:', err);
    } finally {
      setLoadingInvoices(false);
    }
  }, []);

  const fetchUsageStats = useCallback(async () => {
    setLoadingUsage(true);
    try {
      const [statsRes, activityRes] = await Promise.all([
        fetch('/api/admin/wr/usage/stats'),
        fetch('/api/admin/wr/usage/activity'),
      ]);

      if (statsRes.ok) {
        const stats = await statsRes.json();
        setUsageStats(stats);
      }

      if (activityRes.ok) {
        const activity = await activityRes.json();
        setActivityData(activity);
      }
    } catch (err: any) {
      console.error('Failed to fetch usage stats:', err);
    } finally {
      setLoadingUsage(false);
    }
  }, []);

  useEffect(() => {
    fetchBilling();
  }, [fetchBilling, envMode]);

  useEffect(() => {
    if (showInvoices) {
      fetchInvoices();
    }
  }, [showInvoices, fetchInvoices]);

  useEffect(() => {
    if (showUsage) {
      fetchUsageStats();
    }
  }, [showUsage, fetchUsageStats]);

  return (
    <div style={{ padding: 12 }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => { setShowInvoices(false); setShowUsage(false); }}
            style={{
              padding: '4px 12px',
              borderRadius: 3,
              fontSize: 11,
              cursor: 'pointer',
              background: !showInvoices && !showUsage ? 'var(--tn-blue)' : 'var(--tn-bg)',
              border: '1px solid var(--tn-border)',
              color: !showInvoices && !showUsage ? '#fff' : 'var(--tn-text-muted)',
              fontWeight: !showInvoices && !showUsage ? 600 : 400,
            }}
          >
            Overview
          </button>
          <button
            onClick={() => { setShowInvoices(true); setShowUsage(false); }}
            style={{
              padding: '4px 12px',
              borderRadius: 3,
              fontSize: 11,
              cursor: 'pointer',
              background: showInvoices ? 'var(--tn-blue)' : 'var(--tn-bg)',
              border: '1px solid var(--tn-border)',
              color: showInvoices ? '#fff' : 'var(--tn-text-muted)',
              fontWeight: showInvoices ? 600 : 400,
            }}
          >
            Invoices ({invoices.length})
          </button>
          <button
            onClick={() => { setShowUsage(true); setShowInvoices(false); }}
            style={{
              padding: '4px 12px',
              borderRadius: 3,
              fontSize: 11,
              cursor: 'pointer',
              background: showUsage ? 'var(--tn-blue)' : 'var(--tn-bg)',
              border: '1px solid var(--tn-border)',
              color: showUsage ? '#fff' : 'var(--tn-text-muted)',
              fontWeight: showUsage ? 600 : 400,
            }}
          >
            Usage Stats
          </button>
        </div>

        <button
          onClick={() => showInvoices ? fetchInvoices() : showUsage ? fetchUsageStats() : fetchBilling()}
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

      {/* Usage Stats View */}
      {showUsage && (
        <div>
          {loadingUsage ? (
            <div style={{
              padding: 20,
              textAlign: 'center',
              color: 'var(--tn-text-muted)',
              fontSize: 12,
            }}>
              Loading usage stats...
            </div>
          ) : (
            <>
              {/* Usage Summary Cards */}
              {usageStats && (
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
                    <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginBottom: 4 }}>Total Tokens</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--tn-blue)' }}>
                      {(usageStats.totals.tokens / 1000000).toFixed(2)}M
                    </div>
                  </div>

                  <div style={{
                    padding: 12,
                    background: 'var(--tn-bg-dark)',
                    border: '1px solid var(--tn-border)',
                    borderRadius: 6,
                  }}>
                    <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginBottom: 4 }}>Total Cost</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--tn-orange)' }}>
                      €{usageStats.totals.cost.toFixed(2)}
                    </div>
                  </div>

                  <div style={{
                    padding: 12,
                    background: 'var(--tn-bg-dark)',
                    border: '1px solid var(--tn-border)',
                    borderRadius: 6,
                  }}>
                    <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginBottom: 4 }}>API Requests</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--tn-green)' }}>
                      {usageStats.totals.requests.toLocaleString()}
                    </div>
                  </div>

                  <div style={{
                    padding: 12,
                    background: 'var(--tn-bg-dark)',
                    border: '1px solid var(--tn-border)',
                    borderRadius: 6,
                  }}>
                    <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginBottom: 4 }}>Reports Created</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--tn-purple)' }}>
                      {usageStats.totals.gutachten}
                    </div>
                  </div>
                </div>
              )}

              {/* Activity Table */}
              {activityData && activityData.tenants.length > 0 && (
                <div style={{ marginBottom: 20 }}>
                  <div style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: 'var(--tn-text)',
                    marginBottom: 8,
                  }}>
                    Active Tenants ({activityData.tenants.filter(t => t.requestsThisMonth > 0).length})
                  </div>

                  {/* Table Header */}
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: '150px 80px 100px 100px 100px 80px',
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
                    <div>Quota</div>
                    <div>This Month</div>
                    <div>Last Month</div>
                    <div>Uploads</div>
                    <div>Activity</div>
                  </div>

                  {/* Table Rows - Only show active tenants */}
                  {activityData.tenants
                    .filter(t => t.requestsThisMonth > 0 || t.requestsLastMonth > 0)
                    .sort((a, b) => b.requestsThisMonth - a.requestsThisMonth)
                    .map(tenant => {
                      const trend = tenant.requestsLastMonth > 0
                        ? ((tenant.requestsThisMonth - tenant.requestsLastMonth) / tenant.requestsLastMonth * 100)
                        : 0;

                      return (
                        <div
                          key={tenant.tenantId}
                          style={{
                            display: 'grid',
                            gridTemplateColumns: '150px 80px 100px 100px 100px 80px',
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
                            {tenant.tenantName || tenant.tenantId}
                          </div>
                          <div style={{
                            color: tenant.quotaPercentUsed > 80 ? 'var(--tn-red)' : 'var(--tn-text-subtle)',
                            fontWeight: tenant.quotaPercentUsed > 80 ? 600 : 400,
                          }}>
                            {tenant.quotaUsed}/{tenant.quotaIncluded}
                          </div>
                          <div style={{ color: 'var(--tn-text-subtle)', fontFamily: 'monospace', fontSize: 10 }}>
                            {tenant.requestsThisMonth.toLocaleString()}
                          </div>
                          <div style={{ color: 'var(--tn-text-muted)', fontFamily: 'monospace', fontSize: 10 }}>
                            {tenant.requestsLastMonth.toLocaleString()}
                          </div>
                          <div style={{ color: 'var(--tn-text-muted)', fontFamily: 'monospace', fontSize: 10 }}>
                            {tenant.uploadCount}
                          </div>
                          <div>
                            {trend > 0 ? (
                              <span style={{ color: 'var(--tn-green)', fontSize: 10, fontWeight: 600 }}>
                                ↑ {trend.toFixed(0)}%
                              </span>
                            ) : trend < 0 ? (
                              <span style={{ color: 'var(--tn-red)', fontSize: 10, fontWeight: 600 }}>
                                ↓ {Math.abs(trend).toFixed(0)}%
                              </span>
                            ) : (
                              <span style={{ color: 'var(--tn-text-muted)', fontSize: 10 }}>—</span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                </div>
              )}

              {/* Top Usage Table */}
              {usageStats && usageStats.tenants.length > 0 && (
                <div>
                  <div style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: 'var(--tn-text)',
                    marginBottom: 8,
                  }}>
                    Top Usage (This Month)
                  </div>

                  {/* Table Header */}
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: '150px 120px 100px 100px 100px',
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
                    <div>Tokens</div>
                    <div>Cost</div>
                    <div>Requests</div>
                    <div>Reports</div>
                  </div>

                  {/* Table Rows - Top 10 by tokens */}
                  {usageStats.tenants
                    .filter(t => t.tokens > 0)
                    .sort((a, b) => b.tokens - a.tokens)
                    .slice(0, 10)
                    .map(tenant => (
                      <div
                        key={tenant.tenantId}
                        style={{
                          display: 'grid',
                          gridTemplateColumns: '150px 120px 100px 100px 100px',
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
                          {tenant.tenantName || tenant.tenantId}
                        </div>
                        <div style={{ color: 'var(--tn-text-subtle)', fontFamily: 'monospace', fontSize: 10 }}>
                          {(tenant.tokens / 1000).toFixed(1)}K
                        </div>
                        <div style={{ color: 'var(--tn-orange)', fontWeight: 600 }}>
                          €{tenant.cost.toFixed(2)}
                        </div>
                        <div style={{ color: 'var(--tn-text-muted)', fontFamily: 'monospace', fontSize: 10 }}>
                          {tenant.requests}
                        </div>
                        <div style={{ color: 'var(--tn-text-muted)', fontFamily: 'monospace', fontSize: 10 }}>
                          {tenant.gutachtenCount}
                        </div>
                      </div>
                    ))}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Invoices View */}
      {showInvoices && (
        <div>
          {loadingInvoices ? (
            <div style={{
              padding: 20,
              textAlign: 'center',
              color: 'var(--tn-text-muted)',
              fontSize: 12,
            }}>
              Loading invoices...
            </div>
          ) : invoices.length === 0 ? (
            <div style={{
              padding: 20,
              textAlign: 'center',
              color: 'var(--tn-text-muted)',
              fontSize: 11,
            }}>
              No invoices found
            </div>
          ) : (
            <div>
              {/* Invoice Table Header */}
              <div style={{
                display: 'grid',
                gridTemplateColumns: '120px 150px 100px 100px 100px 80px 1fr',
                gap: 8,
                padding: '6px 10px',
                background: 'var(--tn-bg-dark)',
                borderRadius: 4,
                fontSize: 10,
                fontWeight: 600,
                color: 'var(--tn-text-muted)',
                marginBottom: 4,
              }}>
                <div>Invoice #</div>
                <div>Tenant</div>
                <div>Amount</div>
                <div>Issue Date</div>
                <div>Status</div>
                <div>Actions</div>
              </div>

              {/* Invoice Table Rows */}
              {invoices.map(invoice => (
                <div
                  key={invoice.id}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '120px 150px 100px 100px 100px 80px 1fr',
                    gap: 8,
                    padding: '8px 10px',
                    borderBottom: '1px solid var(--tn-border)',
                    fontSize: 11,
                    alignItems: 'center',
                  }}
                >
                  <div style={{
                    color: 'var(--tn-blue)',
                    fontWeight: 600,
                    fontFamily: 'monospace',
                    fontSize: 10,
                  }}>
                    {invoice.invoiceNumber}
                  </div>
                  <div style={{
                    color: 'var(--tn-text)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>
                    {invoice.recipientName}
                  </div>
                  <div style={{ color: 'var(--tn-text-subtle)', fontWeight: 600 }}>
                    €{invoice.grossAmount.toFixed(2)}
                  </div>
                  <div style={{ color: 'var(--tn-text-muted)', fontSize: 10 }}>
                    {new Date(invoice.issueDate).toLocaleDateString('de-DE')}
                  </div>
                  <div>
                    <span style={{
                      display: 'inline-block',
                      padding: '2px 6px',
                      borderRadius: 3,
                      fontSize: 9,
                      fontWeight: 600,
                      textTransform: 'uppercase',
                      background: invoice.status === 'paid'
                        ? 'rgba(158,206,106,0.2)'
                        : invoice.status === 'sent'
                        ? 'rgba(115,203,255,0.2)'
                        : 'rgba(224,175,104,0.2)',
                      color: invoice.status === 'paid'
                        ? 'var(--tn-green)'
                        : invoice.status === 'sent'
                        ? 'var(--tn-blue)'
                        : 'var(--tn-orange)',
                    }}>
                      {invoice.status}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {invoice.pdfUrl && (
                      <a
                        href={invoice.pdfUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          padding: '2px 6px',
                          borderRadius: 3,
                          fontSize: 9,
                          fontWeight: 600,
                          background: 'var(--tn-bg-dark)',
                          border: '1px solid var(--tn-border)',
                          color: 'var(--tn-blue)',
                          textDecoration: 'none',
                          cursor: 'pointer',
                        }}
                      >
                        PDF
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Summary Cards */}
      {!showInvoices && !loading && data && (
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
                gridTemplateColumns: '150px 100px 100px 120px 1fr 80px',
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
                <div>Actions</div>
              </div>

              {/* Table Rows */}
              {data.tenants.map(tenant => (
                <div
                  key={tenant.tenantId}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '150px 100px 100px 120px 1fr 80px',
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
                    {tenant.apiBalance ? `€${(tenant.apiBalance.balanceEur ?? tenant.apiBalance.balance ?? 0).toFixed(2)}` : '€0.00'}
                  </div>
                  <div style={{ color: 'var(--tn-text-muted)', fontSize: 10 }}>
                    {tenant.subscription
                      ? `${new Date(tenant.subscription.currentPeriodStart).toLocaleDateString('de-DE')} - ${new Date(tenant.subscription.currentPeriodEnd).toLocaleDateString('de-DE')}`
                      : '-'}
                  </div>
                  <div>
                    <button
                      onClick={() => setTopUpTenant(tenant)}
                      style={{
                        padding: '3px 8px',
                        fontSize: 9,
                        fontWeight: 600,
                        background: 'var(--tn-blue)',
                        color: '#fff',
                        border: 'none',
                        borderRadius: 3,
                        cursor: 'pointer',
                      }}
                    >
                      Top-Up
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* Top-Up Modal */}
      {topUpTenant && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0,0,0,0.7)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 9999,
        }}>
          <div style={{
            background: 'var(--tn-bg-dark)',
            border: '1px solid var(--tn-border)',
            borderRadius: 8,
            padding: 20,
            width: 400,
            maxWidth: '90%',
          }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--tn-text)', marginBottom: 12 }}>
              API Balance Top-Up
            </div>
            <div style={{ fontSize: 11, color: 'var(--tn-text-muted)', marginBottom: 16 }}>
              Tenant: <span style={{ color: 'var(--tn-text)', fontWeight: 600 }}>{topUpTenant.tenantName}</span>
              <br />
              Current Balance: <span style={{ color: 'var(--tn-blue)', fontWeight: 600 }}>
                {topUpTenant.apiBalance ? `€${(topUpTenant.apiBalance.balanceEur ?? topUpTenant.apiBalance.balance ?? 0).toFixed(2)}` : '€0.00'}
              </span>
            </div>

            {/* Quick Amount Buttons */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
              {[10, 50, 100, 500].map(amt => (
                <button
                  key={amt}
                  onClick={async () => {
                    try {
                      const res = await fetch('/api/admin/wr/billing/top-up', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          tenantId: topUpTenant.tenantId,
                          amount: amt,
                          method: 'manual',
                          note: `Manual top-up €${amt}`,
                        }),
                      });
                      if (!res.ok) throw new Error(await res.text());
                      alert(`✅ €${amt} added successfully!`);
                      setTopUpTenant(null);
                      fetchBilling();
                    } catch (err: any) {
                      alert(`❌ Failed: ${err.message}`);
                    }
                  }}
                  style={{
                    flex: 1,
                    padding: '8px',
                    fontSize: 12,
                    fontWeight: 600,
                    background: 'var(--tn-blue)',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 4,
                    cursor: 'pointer',
                  }}
                >
                  +€{amt}
                </button>
              ))}
            </div>

            {/* Close Button */}
            <button
              onClick={() => setTopUpTenant(null)}
              style={{
                width: '100%',
                padding: '8px',
                fontSize: 11,
                fontWeight: 600,
                background: 'var(--tn-bg)',
                color: 'var(--tn-text-muted)',
                border: '1px solid var(--tn-border)',
                borderRadius: 4,
                cursor: 'pointer',
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
