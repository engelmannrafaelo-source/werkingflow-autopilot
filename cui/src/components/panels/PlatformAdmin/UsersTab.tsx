import { useEffect, useMemo, useState } from 'react';
import { platformJson, formatNumber } from './shared';

interface AppLicense {
  app_id?: string;
  appId?: string;
  plan_id?: string;
  planId?: string;
  start_date?: string;
  end_date?: string | null;
  seats?: number;
}

interface User {
  id: string;
  email: string;
  name: string;
  tenant_id: string;
  app_licenses?: AppLicense[];
  created_at: string;
  updated_at: string;
}

const REFRESH_INTERVAL_MS = 60_000;

export default function UsersTab() {
  const [users, setUsers] = useState<User[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<string | null>(null);

  async function load() {
    try {
      const data = await platformJson<User[]>('/v1/users?limit=200');
      setUsers(data);
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
    if (!users) return [];
    const q = filter.trim().toLowerCase();
    if (!q) return users;
    return users.filter(
      (u) => u.email.toLowerCase().includes(q) || u.name.toLowerCase().includes(q),
    );
  }, [users, filter]);

  if (loading && !users) {
    return <div style={style.empty}>Lade Users …</div>;
  }
  if (error && !users) {
    return (
      <div style={style.errorBox}>
        <strong>Bridge unreachable:</strong>
        <pre style={{ margin: '8px 0 0', fontSize: 11 }}>{error}</pre>
      </div>
    );
  }
  if (!users) return null;

  const selectedUser = selected ? users.find((u) => u.id === selected) : null;

  return (
    <div data-ai-id="platform-users-tab" style={style.root}>
      <div style={style.toolbar}>
        <input
          data-ai-id="platform-users-filter"
          type="text"
          placeholder="Filter email / name …"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={style.filterInput}
        />
        <div style={style.toolbarSpacer} />
        <span style={style.count}>{formatNumber(filtered.length)} / {formatNumber(users.length)}</span>
        <button data-ai-id="platform-users-refresh" onClick={load} style={style.refreshBtn}>Aktualisieren</button>
      </div>

      <div style={style.tableWrap}>
        <table style={style.table}>
          <thead>
            <tr style={style.theadRow}>
              <th style={style.th}>Email</th>
              <th style={style.th}>Name</th>
              <th style={style.th}>Tenant ID</th>
              <th style={style.thNum}>App-Licenses</th>
              <th style={style.th}>Created</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((u) => (
              <tr
                key={u.id}
                data-ai-id={`platform-users-row-${u.id}`}
                onClick={() => setSelected(selected === u.id ? null : u.id)}
                style={{ ...style.tr, background: selected === u.id ? 'rgba(122,162,247,0.08)' : undefined }}
              >
                <td style={style.td}>{u.email}</td>
                <td style={style.td}>{u.name}</td>
                <td style={{ ...style.td, fontFamily: 'monospace', fontSize: 10, color: 'var(--tn-text-muted)' }}>
                  {u.tenant_id.slice(0, 8)}…
                </td>
                <td style={style.tdNum}>{u.app_licenses?.length ?? 0}</td>
                <td style={{ ...style.td, fontSize: 10, color: 'var(--tn-text-muted)' }}>
                  {new Date(u.created_at).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selectedUser && (
        <div style={style.detail}>
          <div style={style.detailHeader}>{selectedUser.name} <span style={style.detailEmail}>{selectedUser.email}</span></div>
          <div style={style.detailRow}><span style={style.detailLabel}>User-ID:</span> <span style={style.detailValue}>{selectedUser.id}</span></div>
          <div style={style.detailRow}><span style={style.detailLabel}>Tenant:</span> <span style={style.detailValue}>{selectedUser.tenant_id}</span></div>
          <div style={style.detailRow}><span style={style.detailLabel}>Created:</span> <span style={style.detailValue}>{new Date(selectedUser.created_at).toLocaleString()}</span></div>
          <div style={style.detailRow}><span style={style.detailLabel}>Updated:</span> <span style={style.detailValue}>{new Date(selectedUser.updated_at).toLocaleString()}</span></div>
          <div style={style.detailRow}><span style={style.detailLabel}>App-Licenses:</span></div>
          {!selectedUser.app_licenses?.length && <div style={{ fontSize: 11, color: 'var(--tn-text-muted)', padding: '4px 0 0 12px' }}>— keine</div>}
          {selectedUser.app_licenses?.map((lic, i) => (
            <div key={i} style={{ ...style.detailRow, paddingLeft: 12 }}>
              <span style={style.detailLabel}>{lic.app_id ?? lic.appId}:</span>
              <span style={style.detailValue}>{lic.plan_id ?? lic.planId} ({lic.seats ?? 1} Sitze)</span>
            </div>
          ))}
        </div>
      )}

      <div style={style.footnote}>
        Quelle: GET /v1/users via Bridge (Production). Aktualisierung alle 60 s. Klick auf Zeile öffnet Detail.
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
  thNum: { padding: '8px 10px', borderBottom: '1px solid var(--tn-border)', textAlign: 'right', fontSize: 10, color: 'var(--tn-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' },
  tr: { borderBottom: '1px solid var(--tn-border)', cursor: 'pointer' },
  td: { padding: '6px 10px', color: 'var(--tn-text)' },
  tdNum: { padding: '6px 10px', textAlign: 'right', color: 'var(--tn-text)' },
  detail: { borderTop: '1px solid var(--tn-border)', padding: 12, background: 'rgba(0,0,0,0.15)', maxHeight: '40%', overflowY: 'auto', flexShrink: 0 },
  detailHeader: { fontSize: 13, fontWeight: 700, color: 'var(--tn-text)', marginBottom: 8 },
  detailEmail: { fontSize: 11, color: 'var(--tn-text-muted)', fontWeight: 400, marginLeft: 6 },
  detailRow: { display: 'flex', gap: 8, padding: '2px 0', fontSize: 11 },
  detailLabel: { color: 'var(--tn-text-muted)', minWidth: 100 },
  detailValue: { color: 'var(--tn-text)', fontFamily: 'monospace' },
  footnote: { padding: '6px 12px', fontSize: 10, color: 'var(--tn-text-muted)', borderTop: '1px solid var(--tn-border)', flexShrink: 0 },
};
