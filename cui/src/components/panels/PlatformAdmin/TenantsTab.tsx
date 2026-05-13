import { useEffect, useMemo, useState } from 'react';
import { platformJson, formatNumber } from './shared';

interface Tenant {
  id: string;
  name: string;
  owner_user_id: string | null;
  created_at: string;
}

const REFRESH_INTERVAL_MS = 60_000;

export default function TenantsTab() {
  const [tenants, setTenants] = useState<Tenant[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');

  async function load() {
    try {
      const data = await platformJson<Tenant[]>('/v1/tenants?limit=200');
      setTenants(data);
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const id = setInterval(load, REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  const filtered = useMemo(() => {
    if (!tenants) return [];
    const q = filter.trim().toLowerCase();
    if (!q) return tenants;
    return tenants.filter((t) => t.name.toLowerCase().includes(q) || t.id.toLowerCase().includes(q));
  }, [tenants, filter]);

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

  const autoCount = filtered.filter((t) => t.name.startsWith('Auto-tenant for ')).length;

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
        <span style={style.count}>
          {formatNumber(filtered.length)} ({formatNumber(autoCount)} auto-tenants)
        </span>
        <button data-ai-id="platform-tenants-refresh" onClick={load} style={style.refreshBtn}>
          Aktualisieren
        </button>
      </div>

      <div style={style.tableWrap}>
        <table style={style.table}>
          <thead>
            <tr style={style.theadRow}>
              <th style={style.th}>Tenant ID</th>
              <th style={style.th}>Name</th>
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
        Quelle: GET /v1/tenants via Bridge. Auto-Tenants entstehen jedes Mal wenn POST /v1/users ohne tenant_id aufgerufen wird.
      </div>
    </div>
  );
}

const style: Record<string, React.CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' },
  empty: { padding: 16, color: 'var(--tn-text-muted)', fontSize: 12 },
  errorBox: { padding: 16, background: 'rgba(247,118,142,0.12)', border: '1px solid var(--tn-red)', borderRadius: 4, margin: 12, color: 'var(--tn-red)', fontSize: 12 },
  toolbar: { display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px', borderBottom: '1px solid var(--tn-border)', flexShrink: 0 },
  toolbarSpacer: { flex: 1 },
  filterInput: { padding: '4px 8px', fontSize: 11, background: 'var(--tn-bg-elev)', border: '1px solid var(--tn-border)', color: 'var(--tn-text)', borderRadius: 3, width: 220 },
  count: { fontSize: 11, color: 'var(--tn-text-muted)' },
  refreshBtn: { padding: '4px 10px', borderRadius: 3, fontSize: 11, border: '1px solid var(--tn-border)', background: 'transparent', color: 'var(--tn-text)', cursor: 'pointer' },
  tableWrap: { flex: 1, overflow: 'auto', minHeight: 0 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 11 },
  theadRow: { position: 'sticky', top: 0, background: 'var(--tn-bg-elev)', zIndex: 1 },
  th: { padding: '8px 10px', borderBottom: '1px solid var(--tn-border)', textAlign: 'left', fontSize: 10, color: 'var(--tn-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' },
  tr: { borderBottom: '1px solid var(--tn-border)' },
  td: { padding: '6px 10px', color: 'var(--tn-text)' },
  footnote: { padding: '6px 12px', fontSize: 10, color: 'var(--tn-text-muted)', borderTop: '1px solid var(--tn-border)', flexShrink: 0 },
};
