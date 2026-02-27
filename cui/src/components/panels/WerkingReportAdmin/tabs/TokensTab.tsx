import { useState, useEffect, useCallback } from 'react';
import { copyToClipboard } from '../../../../utils/clipboard';

interface DevToken {
  id: string;
  name?: string;
  token?: string;
  prefix?: string;
  scopes?: string[];
  projectId?: string;
  tenantId?: string;
  expiresAt?: string;
  revokedAt?: string;
  createdAt?: string;
  lastUsedAt?: string;
  [key: string]: unknown;
}

interface Tenant {
  id: string;
  name: string;
  status?: string;
}

export default function TokensTab({ envMode }: { envMode?: string }) {
  const [tokens, setTokens] = useState<DevToken[]>([]);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [newToken, setNewToken] = useState<string | null>(null);

  // Create form
  const [newName, setNewName] = useState('');
  const [newScopes, setNewScopes] = useState('read');
  const [newExpiry, setNewExpiry] = useState('30');
  const [selectedTenant, setSelectedTenant] = useState('');
  const [filterTenant, setFilterTenant] = useState(''); // For filtering token list
  const [creating, setCreating] = useState(false);
  const [processingId, setProcessingId] = useState<string | null>(null);

  const fetchTenants = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/wr/tenants?limit=1000');
      if (!res.ok) throw new Error('Failed to fetch tenants');
      const data = await res.json();
      setTenants(data.tenants || []);
    } catch (err: any) {
      console.error('Failed to fetch tenants:', err);
    }
  }, []);

  const fetchTokens = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/admin/wr/developer-tokens');
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setTokens(data.tokens || data || []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTenants();
    fetchTokens();
  }, [fetchTenants, fetchTokens, envMode]);

  const handleCreate = async () => {
    if (!newName.trim()) {
      setError('Token name is required');
      return;
    }
    if (!selectedTenant) {
      setError('Please select a tenant');
      return;
    }
    setCreating(true);
    setError('');
    setNewToken(null);
    try {
      const res = await fetch('/api/admin/wr/developer-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenantId: selectedTenant,
          name: newName,
          scopes: newScopes.split(',').map(s => s.trim()),
          expiresInDays: parseInt(newExpiry) || null,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      if (data.plainToken) setNewToken(data.plainToken);
      setNewName('');
      setSelectedTenant('');
      setShowCreate(false);
      await fetchTokens();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (id: string, name?: string) => {
    if (!confirm(`Revoke token "${name || id}"?`)) return;
    setProcessingId(id);
    try {
      const res = await fetch(`/api/admin/wr/developer-tokens/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await res.text());
      await fetchTokens();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setProcessingId(null);
    }
  };

  const inputStyle: React.CSSProperties = {
    padding: '5px 8px', borderRadius: 3, fontSize: 11, background: 'var(--tn-bg)',
    border: '1px solid var(--tn-border)', color: 'var(--tn-text)', outline: 'none', width: '100%',
  };

  const isExpired = (t: DevToken) => t.expiresAt && new Date(t.expiresAt) < new Date();
  const isRevoked = (t: DevToken) => !!t.revokedAt;

  // Filter tokens by selected tenant
  const filteredTokens = filterTenant
    ? tokens.filter(t => t.tenantId === filterTenant)
    : tokens;

  return (
    <div style={{ padding: 12 }}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, alignItems: 'center' }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--tn-text)', flex: 1 }}>Developer API Tokens</span>
        <button onClick={() => { setShowCreate(!showCreate); setNewToken(null); }} style={{
          padding: '4px 12px', borderRadius: 3, fontSize: 10, fontWeight: 600, cursor: 'pointer',
          background: showCreate ? 'var(--tn-red)' : 'var(--tn-green)', border: 'none', color: '#fff',
        }}>
          {showCreate ? 'Cancel' : '+ New Token'}
        </button>
        <button onClick={fetchTokens} style={{
          padding: '3px 10px', borderRadius: 3, fontSize: 10, cursor: 'pointer',
          background: 'var(--tn-bg)', border: '1px solid var(--tn-border)', color: 'var(--tn-text-muted)',
        }}>Refresh</button>
      </div>

      {/* Tenant filter */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', marginBottom: 3 }}>Filter by Tenant</div>
        <select
          value={filterTenant}
          onChange={(e) => setFilterTenant(e.target.value)}
          style={inputStyle}
        >
          <option value="">All Tenants ({tokens.length})</option>
          {tenants.map(t => {
            const count = tokens.filter(tok => tok.tenantId === t.id).length;
            return (
              <option key={t.id} value={t.id}>
                {t.name} ({t.id}) — {count} token{count !== 1 ? 's' : ''}
              </option>
            );
          })}
        </select>
      </div>

      {error && <div style={{ padding: '4px 8px', fontSize: 11, color: 'var(--tn-red)', background: 'rgba(247,118,142,0.1)', borderRadius: 3, marginBottom: 8 }}>{error}</div>}

      {/* Newly created token display */}
      {newToken && (
        <div style={{
          padding: 10, background: 'rgba(158,206,106,0.1)', border: '1px solid var(--tn-green)',
          borderRadius: 6, marginBottom: 12,
        }}>
          <div style={{ fontSize: 10, color: 'var(--tn-green)', fontWeight: 600, marginBottom: 4 }}>Token created! Copy it now — it won't be shown again.</div>
          <code style={{
            display: 'block', padding: '6px 8px', background: 'var(--tn-bg-dark)', borderRadius: 3,
            fontSize: 10, color: 'var(--tn-text)', wordBreak: 'break-all', cursor: 'pointer',
          }} onClick={() => { copyToClipboard(newToken); }}>
            {newToken}
          </code>
          <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', marginTop: 4 }}>Click to copy</div>
        </div>
      )}

      {/* Create Form */}
      {showCreate && (
        <div style={{
          background: 'var(--tn-bg-dark)', border: '1px solid var(--tn-green)', borderRadius: 6,
          padding: 12, marginBottom: 12,
        }}>
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', marginBottom: 3 }}>Tenant *</div>
            <select
              value={selectedTenant}
              onChange={(e) => setSelectedTenant(e.target.value)}
              style={inputStyle}
            >
              <option value="">Select Tenant...</option>
              {tenants.map(t => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.id})
                </option>
              ))}
            </select>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px 80px auto', gap: 8, alignItems: 'end' }}>
            <div>
              <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', marginBottom: 3 }}>Token Name *</div>
              <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="e.g. CI/CD Pipeline" style={inputStyle} />
            </div>
            <div>
              <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', marginBottom: 3 }}>Scopes</div>
              <input value={newScopes} onChange={e => setNewScopes(e.target.value)} placeholder="read,write" style={inputStyle} />
            </div>
            <div>
              <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', marginBottom: 3 }}>Expiry (days)</div>
              <input value={newExpiry} onChange={e => setNewExpiry(e.target.value)} type="number" style={inputStyle} />
            </div>
            <button onClick={handleCreate} disabled={creating || !newName.trim() || !selectedTenant} style={{
              padding: '5px 14px', borderRadius: 3, fontSize: 10, fontWeight: 600,
              cursor: (creating || !newName.trim() || !selectedTenant) ? 'not-allowed' : 'pointer',
              background: 'var(--tn-green)', border: 'none', color: '#fff', opacity: (creating || !newName.trim() || !selectedTenant) ? 0.5 : 1,
            }}>
              {creating ? 'Creating...' : 'Generate'}
            </button>
          </div>
        </div>
      )}

      {loading && <div style={{ padding: 20, textAlign: 'center', color: 'var(--tn-text-muted)', fontSize: 12 }}>Loading...</div>}

      {!loading && filteredTokens.length === 0 && (
        <div style={{ padding: 20, textAlign: 'center', color: 'var(--tn-text-muted)', fontSize: 11 }}>
          {tokens.length === 0 ? 'No tokens found' : 'No tokens found for selected tenant'}
        </div>
      )}

      {!loading && filteredTokens.length > 0 && (
        <>
          <div style={{
            display: 'grid', gridTemplateColumns: '1fr 90px 80px 90px 80px 70px',
            gap: 8, padding: '6px 10px', background: 'var(--tn-bg-dark)', borderRadius: 4,
            fontSize: 10, fontWeight: 600, color: 'var(--tn-text-muted)', marginBottom: 4,
          }}>
            <div>Name</div><div>Tenant</div><div>Prefix</div><div>Scopes</div><div>Status</div><div>Actions</div>
          </div>

          {filteredTokens.map(t => {
            const expired = isExpired(t);
            const revoked = isRevoked(t);
            const isProcessing = processingId === t.id;
            const tenant = tenants.find(tn => tn.id === t.tenantId);
            return (
              <div key={t.id} style={{
                display: 'grid', gridTemplateColumns: '1fr 90px 80px 90px 80px 70px',
                gap: 8, padding: '8px 10px', borderBottom: '1px solid var(--tn-border)',
                fontSize: 11, alignItems: 'center', opacity: (expired || revoked) ? 0.5 : 1,
              }}>
                <div>
                  <div style={{ color: 'var(--tn-text)' }}>{t.name || 'Unnamed'}</div>
                  {t.lastUsedAt && <div style={{ fontSize: 9, color: 'var(--tn-text-muted)' }}>Last used: {new Date(t.lastUsedAt).toLocaleDateString('de-DE')}</div>}
                </div>
                <div style={{ fontSize: 9, color: 'var(--tn-text-muted)' }} title={t.tenantId}>
                  {tenant ? tenant.name : t.tenantId || '—'}
                </div>
                <div style={{ fontFamily: 'monospace', fontSize: 10, color: 'var(--tn-text-muted)' }}>{t.prefix || t.token?.slice(0, 12) || '—'}...</div>
                <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                  {(t.scopes || []).map((s, i) => (
                    <span key={i} style={{
                      padding: '1px 4px', borderRadius: 2, fontSize: 9, background: 'rgba(122,162,247,0.15)',
                      color: 'var(--tn-blue)',
                    }}>{s}</span>
                  ))}
                </div>
                <div>
                  <span style={{
                    padding: '2px 6px', borderRadius: 3, fontSize: 9, fontWeight: 600, textTransform: 'uppercase',
                    background: revoked ? 'rgba(247,118,142,0.2)' : expired ? 'rgba(224,175,104,0.2)' : 'rgba(158,206,106,0.2)',
                    color: revoked ? 'var(--tn-red)' : expired ? 'var(--tn-orange)' : 'var(--tn-green)',
                  }}>
                    {revoked ? 'Revoked' : expired ? 'Expired' : 'Active'}
                  </span>
                </div>
                <div>
                  {!revoked && (
                    <button onClick={() => handleRevoke(t.id, t.name)} disabled={isProcessing} style={{
                      padding: '3px 6px', borderRadius: 3, fontSize: 9, cursor: isProcessing ? 'not-allowed' : 'pointer',
                      background: 'rgba(247,118,142,0.15)', border: '1px solid rgba(247,118,142,0.3)',
                      color: 'var(--tn-red)', fontWeight: 600,
                    }}>Revoke</button>
                  )}
                </div>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
