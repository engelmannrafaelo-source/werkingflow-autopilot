import { useState, useEffect, useCallback } from 'react';
import PaginationControls from '@/components/shared/PaginationControls';
import ExportButton from '@/components/shared/ExportButton';
import PlanChangeModal from '../modals/PlanChangeModal';
import TableSearch, { FilterConfig } from '@/components/shared/TableSearch';

interface Tenant {
  id: string;
  name: string;
  slug?: string;
  planId?: string;
  plan?: string; // Legacy support
  status?: string;
  userCount?: number;
  createdAt?: string;
  [key: string]: unknown;
}

type ViewMode = 'list' | 'create';

export default function TenantsTab({ envMode }: { envMode?: string }) {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [view, setView] = useState<ViewMode>('list');
  const [search, setSearch] = useState('');
  const [planFilter, setPlanFilter] = useState('');
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [changePlanTenant, setChangePlanTenant] = useState<{ id: string; name: string; planId: string } | null>(null);

  // Pagination state
  const [offset, setOffset] = useState(0);
  const [limit, setLimit] = useState(50);
  const [total, setTotal] = useState(0);

  // Create form
  const [newName, setNewName] = useState('');
  const [newSlug, setNewSlug] = useState('');
  const [newPlan, setNewPlan] = useState('trial');
  const [creating, setCreating] = useState(false);

  const fetchTenants = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (search) params.set('search', search);
      if (planFilter) params.set('plan', planFilter);
      params.set('offset', offset.toString());
      params.set('limit', limit.toString());
      const res = await fetch(`/api/admin/wr/tenants?${params}`);
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setTenants(data.tenants || data || []);
      setTotal(data.total || 0);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [search, planFilter, offset, limit]);

  useEffect(() => { fetchTenants(); }, [fetchTenants, envMode]);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    setError('');
    try {
      const res = await fetch('/api/admin/wr/tenants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName, slug: newSlug || newName.toLowerCase().replace(/[^a-z0-9]/g, '-'), planId: newPlan }),
      });
      if (!res.ok) throw new Error(await res.text());
      setNewName('');
      setNewSlug('');
      setNewPlan('trial');
      setView('list');
      await fetchTenants();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Delete tenant "${name}"? This cannot be undone.`)) return;
    setProcessingId(id);
    try {
      const res = await fetch(`/api/admin/wr/tenants/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await res.text());
      await fetchTenants();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setProcessingId(null);
    }
  };

  const plans = ['trial', 'starter', 'pro', 'enterprise', 'team', 'expert'];
  const planColor = (plan: string) => {
    const colors: Record<string, string> = {
      trial: 'var(--tn-text-muted)', starter: 'var(--tn-blue)', pro: 'var(--tn-green)',
      enterprise: 'var(--tn-orange)', team: 'var(--tn-purple, #bb9af7)', expert: 'var(--tn-red)',
    };
    return colors[plan] || 'var(--tn-text-muted)';
  };

  const handlePageChange = (newOffset: number) => {
    setOffset(newOffset);
  };

  const handlePageSizeChange = (newLimit: number) => {
    setLimit(newLimit);
    setOffset(0); // Reset to first page when changing page size
  };

  const handleSearchChange = useCallback((query: string, filters: Record<string, string>) => {
    setSearch(query);
    setPlanFilter(filters.plan || '');
  }, []);

  const searchFilters: FilterConfig[] = [
    {
      key: 'plan',
      label: 'Plan',
      options: plans.map(p => ({ label: p.charAt(0).toUpperCase() + p.slice(1), value: p })),
      placeholder: 'All Plans',
    },
  ];

  const inputStyle: React.CSSProperties = {
    padding: '5px 8px', borderRadius: 3, fontSize: 11, background: 'var(--tn-bg)',
    border: '1px solid var(--tn-border)', color: 'var(--tn-text)', outline: 'none', width: '100%',
  };

  return (
    <div data-ai-id="wr-tenants-tab" style={{ padding: 12 }}>
      {changePlanTenant && (
        <PlanChangeModal
          tenantId={changePlanTenant.id}
          tenantName={changePlanTenant.name}
          currentPlanId={changePlanTenant.planId}
          onClose={() => setChangePlanTenant(null)}
          onSuccess={fetchTenants}
        />
      )}

      {/* Search and Filter Toolbar */}
      <div data-ai-id="wr-tenants-toolbar" style={{ display: 'flex', gap: 6, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <TableSearch
          onSearch={handleSearchChange}
          placeholder="Search tenants..."
          filters={searchFilters}
          initialQuery={search}
          initialFilters={{ plan: planFilter }}
        />
        <div style={{ flex: 1 }} />
        <ExportButton
          data={tenants.map(t => ({
            name: t.name,
            slug: t.slug || '',
            plan: t.planId || t.plan || '',
            status: t.status || 'active',
            userCount: t.userCount ?? 0,
            createdAt: t.createdAt || '',
          }))}
          filename="tenants"
        />
        <button data-ai-id="wr-tenants-create-btn" data-active={view === 'create'} onClick={() => setView(view === 'create' ? 'list' : 'create')} style={{
          padding: '4px 12px', borderRadius: 3, fontSize: 10, fontWeight: 600, cursor: 'pointer',
          background: view === 'create' ? 'var(--tn-red)' : 'var(--tn-green)',
          border: 'none', color: '#fff',
        }}>
          {view === 'create' ? 'Cancel' : '+ New Tenant'}
        </button>
        <button data-ai-id="wr-tenants-refresh-btn" onClick={fetchTenants} style={{
          padding: '3px 10px', borderRadius: 3, fontSize: 10, cursor: 'pointer',
          background: 'var(--tn-bg)', border: '1px solid var(--tn-border)', color: 'var(--tn-text-muted)',
        }}>Refresh</button>
      </div>

      {error && <div data-ai-id="wr-tenants-error" style={{ padding: '4px 8px', fontSize: 11, color: 'var(--tn-red)', background: 'rgba(247,118,142,0.1)', borderRadius: 3, marginBottom: 8 }}>{error}</div>}

      {/* Create Form */}
      {view === 'create' && (
        <div data-ai-id="wr-tenants-create-form" style={{
          background: 'var(--tn-bg-dark)', border: '1px solid var(--tn-green)', borderRadius: 6,
          padding: 12, marginBottom: 12,
        }}>
          <div data-ai-id="wr-tenants-create-title" style={{ fontSize: 11, fontWeight: 600, color: 'var(--tn-green)', marginBottom: 8 }}>Create New Tenant</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 100px auto', gap: 8, alignItems: 'end' }}>
            <div>
              <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', marginBottom: 3 }}>Name *</div>
              <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Company Name" style={inputStyle} />
            </div>
            <div>
              <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', marginBottom: 3 }}>Slug</div>
              <input value={newSlug} onChange={e => setNewSlug(e.target.value)} placeholder="auto-generated" style={inputStyle} />
            </div>
            <div>
              <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', marginBottom: 3 }}>Plan</div>
              <select value={newPlan} onChange={e => setNewPlan(e.target.value)} style={inputStyle}>
                {plans.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <button data-ai-id="wr-tenants-create-submit" onClick={handleCreate} disabled={creating || !newName.trim()} style={{
              padding: '5px 14px', borderRadius: 3, fontSize: 10, fontWeight: 600, cursor: creating ? 'not-allowed' : 'pointer',
              background: 'var(--tn-green)', border: 'none', color: '#fff', opacity: creating ? 0.5 : 1,
            }}>
              {creating ? 'Creating...' : 'Create'}
            </button>
          </div>
        </div>
      )}

      {loading && <div data-ai-id="wr-tenants-loading" style={{ padding: 20, textAlign: 'center', color: 'var(--tn-text-muted)', fontSize: 12 }}>Loading...</div>}

      {/* Pagination Controls - Top */}
      {!loading && total > 0 && (
        <PaginationControls
          total={total}
          offset={offset}
          limit={limit}
          onPageChange={handlePageChange}
          onPageSizeChange={handlePageSizeChange}
        />
      )}

      {!loading && tenants.length === 0 && (
        <div data-ai-id="wr-tenants-empty" style={{ padding: 20, textAlign: 'center', color: 'var(--tn-text-muted)', fontSize: 11 }}>No tenants found</div>
      )}

      {!loading && tenants.length > 0 && (
        <>
          <div data-ai-id="wr-tenants-count" style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginBottom: 6, marginTop: 6 }}>
            {tenants.length} tenant(s) shown
            {search && ` matching "${search}"`}
            {planFilter && ` | plan: ${planFilter}`}
          </div>
          <div data-ai-id="wr-tenants-table-header" style={{
            display: 'grid', gridTemplateColumns: '1fr 100px 80px 80px 70px 100px',
            gap: 8, padding: '6px 10px', background: 'var(--tn-bg-dark)', borderRadius: 4,
            fontSize: 10, fontWeight: 600, color: 'var(--tn-text-muted)', marginBottom: 4,
          }}>
            <div>Name</div><div>Slug</div><div>Plan</div><div>Users</div><div>Status</div><div>Actions</div>
          </div>

          {tenants.map(t => {
            const isProcessing = processingId === t.id;
            return (
              <div key={t.id} data-ai-id={`wr-tenants-row-${t.id}`} style={{
                display: 'grid', gridTemplateColumns: '1fr 100px 80px 80px 70px 100px',
                gap: 8, padding: '8px 10px', borderBottom: '1px solid var(--tn-border)',
                fontSize: 11, alignItems: 'center', opacity: isProcessing ? 0.5 : 1,
              }}>
                <div style={{ color: 'var(--tn-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {t.name}
                  <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', fontFamily: 'monospace' }}>{t.id.slice(0, 8)}</div>
                </div>
                <div style={{ color: 'var(--tn-text-muted)', fontSize: 10 }}>{t.slug || '—'}</div>
                <div>
                  <span style={{
                    padding: '2px 6px', borderRadius: 3, fontSize: 9, fontWeight: 600,
                    textTransform: 'uppercase', color: planColor(t.planId || t.plan || ''),
                    background: `${planColor(t.planId || t.plan || '')}20`,
                    cursor: 'pointer',
                  }} onClick={() => setChangePlanTenant({ id: t.id, name: t.name, planId: t.planId || t.plan || 'trial' })}>
                    {t.planId || t.plan || '—'}
                  </span>
                </div>
                <div style={{ color: 'var(--tn-text-muted)' }}>{t.userCount ?? '—'}</div>
                <div>
                  <span style={{
                    padding: '2px 6px', borderRadius: 3, fontSize: 9, fontWeight: 600, textTransform: 'uppercase',
                    background: t.status === 'active' ? 'rgba(158,206,106,0.2)' : 'rgba(224,175,104,0.2)',
                    color: t.status === 'active' ? 'var(--tn-green)' : 'var(--tn-orange)',
                  }}>
                    {t.status || 'active'}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 4 }}>
                  <button onClick={() => setChangePlanTenant({ id: t.id, name: t.name, planId: t.planId || t.plan || 'trial' })} disabled={isProcessing} style={{
                    padding: '3px 6px', borderRadius: 3, fontSize: 9, cursor: isProcessing ? 'not-allowed' : 'pointer',
                    background: 'rgba(125,207,255,0.15)', border: '1px solid rgba(125,207,255,0.3)',
                    color: 'var(--tn-blue)', fontWeight: 600,
                  }}>Change Plan</button>
                  <button onClick={() => handleDelete(t.id, t.name)} disabled={isProcessing} style={{
                    padding: '3px 6px', borderRadius: 3, fontSize: 9, cursor: isProcessing ? 'not-allowed' : 'pointer',
                    background: 'rgba(247,118,142,0.15)', border: '1px solid rgba(247,118,142,0.3)',
                    color: 'var(--tn-red)', fontWeight: 600,
                  }}>Delete</button>
                </div>
              </div>
            );
          })}

          {/* Pagination Controls - Bottom */}
          <PaginationControls
            total={total}
            offset={offset}
            limit={limit}
            onPageChange={handlePageChange}
            onPageSizeChange={handlePageSizeChange}
          />
        </>
      )}
    </div>
  );
}
