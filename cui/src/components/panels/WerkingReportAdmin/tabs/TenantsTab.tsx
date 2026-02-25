import { useState, useEffect, useCallback } from 'react';

interface Tenant {
  id: string;
  name: string;
  slug?: string;
  plan?: string;
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

  // Create form
  const [newName, setNewName] = useState('');
  const [newSlug, setNewSlug] = useState('');
  const [newPlan, setNewPlan] = useState('trial');
  const [creating, setCreating] = useState(false);

  // Edit inline
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editPlan, setEditPlan] = useState('');

  const fetchTenants = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (search) params.set('search', search);
      if (planFilter) params.set('plan', planFilter);
      params.set('limit', '100');
      const res = await fetch(`/api/admin/wr/tenants?${params}`);
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setTenants(data.tenants || data || []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [search, planFilter]);

  useEffect(() => { fetchTenants(); }, [fetchTenants, envMode]);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    setError('');
    try {
      const res = await fetch('/api/admin/wr/tenants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName, slug: newSlug || newName.toLowerCase().replace(/[^a-z0-9]/g, '-'), plan: newPlan }),
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

  const handleUpdatePlan = async (id: string) => {
    setProcessingId(id);
    try {
      const res = await fetch(`/api/admin/wr/tenants/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: editPlan }),
      });
      if (!res.ok) throw new Error(await res.text());
      setEditingId(null);
      await fetchTenants();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setProcessingId(null);
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

  const inputStyle: React.CSSProperties = {
    padding: '5px 8px', borderRadius: 3, fontSize: 11, background: 'var(--tn-bg)',
    border: '1px solid var(--tn-border)', color: 'var(--tn-text)', outline: 'none', width: '100%',
  };

  return (
    <div style={{ padding: 12 }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          placeholder="Search tenants..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ ...inputStyle, width: 160 }}
        />
        <select value={planFilter} onChange={e => setPlanFilter(e.target.value)} style={{ ...inputStyle, width: 100 }}>
          <option value="">All Plans</option>
          {plans.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <div style={{ flex: 1 }} />
        <button onClick={() => setView(view === 'create' ? 'list' : 'create')} style={{
          padding: '4px 12px', borderRadius: 3, fontSize: 10, fontWeight: 600, cursor: 'pointer',
          background: view === 'create' ? 'var(--tn-red)' : 'var(--tn-green)',
          border: 'none', color: '#fff',
        }}>
          {view === 'create' ? 'Cancel' : '+ New Tenant'}
        </button>
        <button onClick={fetchTenants} style={{
          padding: '3px 10px', borderRadius: 3, fontSize: 10, cursor: 'pointer',
          background: 'var(--tn-bg)', border: '1px solid var(--tn-border)', color: 'var(--tn-text-muted)',
        }}>Refresh</button>
      </div>

      {error && <div style={{ padding: '4px 8px', fontSize: 11, color: 'var(--tn-red)', background: 'rgba(247,118,142,0.1)', borderRadius: 3, marginBottom: 8 }}>{error}</div>}

      {/* Create Form */}
      {view === 'create' && (
        <div style={{
          background: 'var(--tn-bg-dark)', border: '1px solid var(--tn-green)', borderRadius: 6,
          padding: 12, marginBottom: 12,
        }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--tn-green)', marginBottom: 8 }}>Create New Tenant</div>
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
            <button onClick={handleCreate} disabled={creating || !newName.trim()} style={{
              padding: '5px 14px', borderRadius: 3, fontSize: 10, fontWeight: 600, cursor: creating ? 'not-allowed' : 'pointer',
              background: 'var(--tn-green)', border: 'none', color: '#fff', opacity: creating ? 0.5 : 1,
            }}>
              {creating ? 'Creating...' : 'Create'}
            </button>
          </div>
        </div>
      )}

      {loading && <div style={{ padding: 20, textAlign: 'center', color: 'var(--tn-text-muted)', fontSize: 12 }}>Loading...</div>}

      {!loading && tenants.length === 0 && (
        <div style={{ padding: 20, textAlign: 'center', color: 'var(--tn-text-muted)', fontSize: 11 }}>No tenants found</div>
      )}

      {!loading && tenants.length > 0 && (
        <>
          <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginBottom: 6 }}>{tenants.length} tenant(s)</div>
          <div style={{
            display: 'grid', gridTemplateColumns: '1fr 100px 80px 80px 70px 100px',
            gap: 8, padding: '6px 10px', background: 'var(--tn-bg-dark)', borderRadius: 4,
            fontSize: 10, fontWeight: 600, color: 'var(--tn-text-muted)', marginBottom: 4,
          }}>
            <div>Name</div><div>Slug</div><div>Plan</div><div>Users</div><div>Status</div><div>Actions</div>
          </div>

          {tenants.map(t => {
            const isProcessing = processingId === t.id;
            const isEditing = editingId === t.id;
            return (
              <div key={t.id} style={{
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
                  {isEditing ? (
                    <div style={{ display: 'flex', gap: 2 }}>
                      <select value={editPlan} onChange={e => setEditPlan(e.target.value)} style={{ ...inputStyle, width: 60, padding: '2px 4px', fontSize: 9 }}>
                        {plans.map(p => <option key={p} value={p}>{p}</option>)}
                      </select>
                      <button onClick={() => handleUpdatePlan(t.id)} style={{ padding: '2px 4px', fontSize: 8, background: 'var(--tn-green)', border: 'none', color: '#fff', borderRadius: 2, cursor: 'pointer' }}>OK</button>
                    </div>
                  ) : (
                    <span style={{
                      padding: '2px 6px', borderRadius: 3, fontSize: 9, fontWeight: 600,
                      textTransform: 'uppercase', color: planColor(t.plan || ''),
                      background: `${planColor(t.plan || '')}20`,
                      cursor: 'pointer',
                    }} onClick={() => { setEditingId(t.id); setEditPlan(t.plan || 'trial'); }}>
                      {t.plan || '—'}
                    </span>
                  )}
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
                  <button onClick={() => handleDelete(t.id, t.name)} disabled={isProcessing} style={{
                    padding: '3px 6px', borderRadius: 3, fontSize: 9, cursor: isProcessing ? 'not-allowed' : 'pointer',
                    background: 'rgba(247,118,142,0.15)', border: '1px solid rgba(247,118,142,0.3)',
                    color: 'var(--tn-red)', fontWeight: 600,
                  }}>Delete</button>
                </div>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
