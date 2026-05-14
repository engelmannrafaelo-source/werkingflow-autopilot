import { useEffect, useMemo, useState } from 'react';
import { platformJson, platformFetch, formatNumber } from './shared';
import { usePlatformMode, type PlatformMode } from './ModeContext';

interface Tenant {
  id: string;
  name: string;
  owner_user_id: string | null;
  category: 'prod' | 'staging' | 'local';
  created_at: string;
}

const REFRESH_INTERVAL_MS = 60_000;

const CATEGORY_COLORS: Record<Tenant['category'], string> = {
  prod:    'var(--tn-red, #ef4444)',
  staging: 'var(--tn-yellow, #d97706)',
  local:   'var(--tn-green, #16a34a)',
};

export default function TenantsTab() {
  const [tenants, setTenants] = useState<Tenant[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [updating, setUpdating] = useState<string | null>(null);
  const { mode, withMode } = usePlatformMode();

  async function load() {
    try {
      const data = await platformJson<Tenant[]>(withMode('/v1/tenants?limit=500'));
      setTenants(data);
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setLoading(true);
    load();
    const id = setInterval(load, REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  async function updateCategory(tenantId: string, next: Tenant['category']) {
    setUpdating(tenantId);
    try {
      const res = await platformFetch(`/v1/tenants/${encodeURIComponent(tenantId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: next }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => 'unknown');
        throw new Error(`PATCH failed: HTTP ${res.status} ${body.slice(0, 150)}`);
      }
      const updated: Tenant = await res.json();
      setTenants((prev) =>
        prev ? prev.map((t) => (t.id === tenantId ? { ...t, ...updated } : t)) : prev,
      );
    } catch (e: any) {
      setError(`Category update failed: ${e?.message ?? String(e)}`);
    } finally {
      setUpdating(null);
    }
  }

  const filtered = useMemo(() => {
    if (!tenants) return [];
    const q = filter.trim().toLowerCase();
    if (!q) return tenants;
    return tenants.filter((t) => t.name.toLowerCase().includes(q) || t.id.toLowerCase().includes(q));
  }, [tenants, filter]);

  const counts = useMemo(() => {
    if (!tenants) return { prod: 0, staging: 0, local: 0 };
    return tenants.reduce(
      (acc, t) => {
        acc[t.category] = (acc[t.category] || 0) + 1;
        return acc;
      },
      { prod: 0, staging: 0, local: 0 } as Record<Tenant['category'], number>,
    );
  }, [tenants]);

  if (loading && !tenants) return <div style={style.empty}>Lade Tenants …</div>;
  if (error && !tenants) {
    return (
      <div style={style.errorBox}>
        <strong>Bridge unreachable:</strong>
        <pre style={{ margin: '8px 0 0', fontSize: 11 }}>{error}</pre>
      </div>
    );
  }
  if (!tenants) return null;

  return (
    <div data-ai-id="platform-tenants-tab" style={style.root}>
      <div style={style.toolbar}>
        <input
          data-ai-id="platform-tenants-filter"
          type="text"
          placeholder="Filter name / id …"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={style.filterInput}
        />
        <div style={style.toolbarSpacer} />
        <span style={style.counts}>
          <CategoryBadge cat="prod" count={counts.prod} />
          <CategoryBadge cat="staging" count={counts.staging} />
          <CategoryBadge cat="local" count={counts.local} />
        </span>
        <span style={style.count}>· {formatNumber(filtered.length)} sichtbar</span>
        <button data-ai-id="platform-tenants-refresh" onClick={load} style={style.refreshBtn}>
          ↻
        </button>
      </div>

      {error && (
        <div style={{ ...style.errorBox, marginTop: 0, marginBottom: 0 }} onClick={() => setError(null)}>
          <strong>Fehler:</strong> {error}
        </div>
      )}

      <div style={style.tableWrap}>
        <table style={style.table}>
          <thead>
            <tr style={style.theadRow}>
              <th style={style.th}>Tenant ID</th>
              <th style={style.th}>Name</th>
              <th style={style.th}>Kategorie</th>
              <th style={style.th}>Owner User</th>
              <th style={style.th}>Created</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((t) => (
              <tr key={t.id} data-ai-id={`platform-tenants-row-${t.id}`} style={style.tr}>
                <td style={{ ...style.td, fontFamily: 'monospace', fontSize: 10 }}>{t.id}</td>
                <td style={style.td}>
                  {t.name.startsWith('Auto-tenant for ') ? (
                    <span style={{ color: 'var(--tn-text-muted)', fontStyle: 'italic' }}>{t.name}</span>
                  ) : (
                    <span style={{ fontWeight: 600 }}>{t.name}</span>
                  )}
                </td>
                <td style={style.td}>
                  <select
                    data-ai-id={`platform-tenants-category-${t.id}`}
                    value={t.category}
                    disabled={updating === t.id}
                    onChange={(e) => updateCategory(t.id, e.target.value as Tenant['category'])}
                    style={{
                      ...style.categorySelect,
                      borderColor: CATEGORY_COLORS[t.category],
                      color: CATEGORY_COLORS[t.category],
                    }}
                  >
                    <option value="prod">prod</option>
                    <option value="staging">staging</option>
                    <option value="local">local</option>
                  </select>
                </td>
                <td style={{ ...style.td, fontFamily: 'monospace', fontSize: 10, color: 'var(--tn-text-muted)' }}>
                  {t.owner_user_id ? t.owner_user_id.slice(0, 8) + '…' : '—'}
                </td>
                <td style={{ ...style.td, fontSize: 10, color: 'var(--tn-text-muted)' }}>
                  {new Date(t.created_at).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={style.footnote}>
        Quelle: GET /v1/tenants. Kategorie via PATCH änderbar — wirkt sofort auf den Mode-Filter. Auto-Tenants entstehen jedes Mal wenn POST /v1/users ohne tenant_id aufgerufen wird.
      </div>
    </div>
  );
}

function CategoryBadge({ cat, count }: { cat: PlatformMode; count: number }) {
  if (cat === 'all') return null;
  const color = CATEGORY_COLORS[cat as Tenant['category']];
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
      <span style={{ width: 8, height: 8, borderRadius: 2, background: color, display: 'inline-block' }} />
      <span style={{ color: 'var(--tn-text)' }}>{cat}:</span>
      <span style={{ color: 'var(--tn-text-muted)', fontFamily: 'monospace' }}>{count}</span>
    </span>
  );
}

const style: Record<string, React.CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' },
  empty: { padding: 16, color: 'var(--tn-text-muted)', fontSize: 12 },
  errorBox: { padding: 12, background: 'rgba(247,118,142,0.12)', border: '1px solid var(--tn-red)', borderRadius: 4, margin: 12, color: 'var(--tn-red)', fontSize: 12, cursor: 'pointer' },
  toolbar: { display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px', borderBottom: '1px solid var(--tn-border)', flexShrink: 0 },
  toolbarSpacer: { flex: 1 },
  filterInput: { padding: '4px 8px', fontSize: 11, background: 'var(--tn-bg-elev)', border: '1px solid var(--tn-border)', color: 'var(--tn-text)', borderRadius: 3, width: 220 },
  counts: { display: 'flex', alignItems: 'center', gap: 12 },
  count: { fontSize: 11, color: 'var(--tn-text-muted)' },
  refreshBtn: { padding: '4px 10px', borderRadius: 3, fontSize: 12, border: '1px solid var(--tn-border)', background: 'transparent', color: 'var(--tn-text)', cursor: 'pointer' },
  tableWrap: { flex: 1, overflow: 'auto', minHeight: 0 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 11 },
  theadRow: { position: 'sticky', top: 0, background: 'var(--tn-bg-elev)', zIndex: 1 },
  th: { padding: '8px 10px', borderBottom: '1px solid var(--tn-border)', textAlign: 'left', fontSize: 10, color: 'var(--tn-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' },
  tr: { borderBottom: '1px solid var(--tn-border)' },
  td: { padding: '6px 10px', color: 'var(--tn-text)' },
  categorySelect: {
    padding: '2px 6px', fontSize: 11, fontWeight: 600,
    background: 'var(--tn-bg)', border: '1px solid', borderRadius: 3, cursor: 'pointer',
  },
  footnote: { padding: '6px 12px', fontSize: 10, color: 'var(--tn-text-muted)', borderTop: '1px solid var(--tn-border)', flexShrink: 0 },
};
