import { useEffect, useState } from 'react';
import { platformJson, formatNumber } from './shared';

interface AuditEntry {
  id: string;
  timestamp: string;
  actorUserId: string | null;
  actorLabel: string | null;
  action: string;
  targetKind: string | null;
  targetId: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown>;
}

const REFRESH_INTERVAL_MS = 60_000;

export default function AuditTab() {
  const [items, setItems] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionFilter, setActionFilter] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  async function load() {
    try {
      const qs = new URLSearchParams();
      if (actionFilter) qs.set('action', actionFilter);
      qs.set('limit', '200');
      const d = await platformJson<{ items: AuditEntry[]; count: number }>(`/v1/audit/query?${qs}`);
      setItems(d.items); setError(null);
    } catch (e: any) { setError(e?.message ?? String(e)); }
  }
  useEffect(() => { load(); const id = setInterval(load, REFRESH_INTERVAL_MS); return () => clearInterval(id); }, [actionFilter]);

  if (error && !items) return <div style={S.err}><strong>Bridge unreachable:</strong><pre style={{ fontSize: 11 }}>{error}</pre></div>;
  if (!items) return <div style={S.empty}>Lade Audit …</div>;

  function toggle(id: string) {
    setExpanded((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  return (
    <div style={S.root}>
      <div style={S.bar}>
        <input style={S.inp} placeholder="Filter action (e.g. user.approved)" value={actionFilter} onChange={(e) => setActionFilter(e.target.value)} />
        <span style={S.count}>{formatNumber(items.length)} entries</span>
        <button onClick={load} style={S.btn}>Refresh</button>
      </div>
      <div style={S.list}>
        {items.length === 0 && <div style={S.empty}>Keine Audit-Eintraege.</div>}
        {items.map((a) => {
          const open = expanded.has(a.id);
          return (
            <div key={a.id} style={S.row} onClick={() => toggle(a.id)}>
              <div style={S.header}>
                <span style={S.action}>{a.action}</span>
                <span style={S.target}>{a.targetKind ? `${a.targetKind}:${a.targetId}` : '—'}</span>
                <span style={S.actor}>{a.actorLabel ?? a.actorUserId?.slice(0, 8) ?? '—'}</span>
                <span style={S.ts}>{new Date(a.timestamp).toLocaleString()}</span>
              </div>
              {open && (
                <div style={S.body}>
                  {a.before != null && <Block title="before" v={a.before} />}
                  {a.after != null && <Block title="after" v={a.after} />}
                  {Object.keys(a.metadata || {}).length > 0 && <Block title="metadata" v={a.metadata} />}
                  <div style={S.meta}>{a.ip && <span>ip: {a.ip}</span>} {a.userAgent && <span> · UA: {a.userAgent.slice(0, 60)}</span>}</div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div style={S.foot}>Quelle: GET /v1/audit/query · POST /v1/audit/log fuer Admin-Mutations einbauen sobald App-Aktionen über Bridge laufen.</div>
    </div>
  );
}

function Block({ title, v }: { title: string; v: unknown }) {
  return <div style={{ marginBottom: 6 }}>
    <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', textTransform: 'uppercase' }}>{title}</div>
    <pre style={S.pre}>{typeof v === 'string' ? v : JSON.stringify(v, null, 2)}</pre>
  </div>;
}

const S: Record<string, React.CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' },
  err: { padding: 16, background: 'rgba(247,118,142,0.12)', border: '1px solid var(--tn-red)', color: 'var(--tn-red)', margin: 12, borderRadius: 4 },
  empty: { padding: 16, color: 'var(--tn-text-muted)', fontSize: 12 },
  bar: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderBottom: '1px solid var(--tn-border)' },
  inp: { padding: '4px 8px', fontSize: 11, background: 'var(--tn-bg-elev)', border: '1px solid var(--tn-border)', color: 'var(--tn-text)', borderRadius: 3, width: 280 },
  count: { fontSize: 11, color: 'var(--tn-text-muted)', flex: 1 },
  btn: { padding: '4px 10px', fontSize: 11, background: 'transparent', border: '1px solid var(--tn-border)', color: 'var(--tn-text)', borderRadius: 3, cursor: 'pointer' },
  list: { flex: 1, overflow: 'auto', minHeight: 0 },
  row: { padding: '6px 12px', borderBottom: '1px solid var(--tn-border)', cursor: 'pointer' },
  header: { display: 'grid', gridTemplateColumns: '200px 1fr 120px 130px', gap: 10, alignItems: 'center', fontSize: 11 },
  action: { fontFamily: 'monospace', color: 'var(--tn-orange)', fontWeight: 600 },
  target: { color: 'var(--tn-text)', fontSize: 11 },
  actor: { color: 'var(--tn-text-muted)', fontFamily: 'monospace', fontSize: 10 },
  ts: { color: 'var(--tn-text-muted)', fontSize: 10, textAlign: 'right' },
  body: { padding: '8px 12px', background: 'rgba(0,0,0,0.15)' },
  pre: { background: 'var(--tn-bg-elev)', border: '1px solid var(--tn-border)', padding: 6, fontSize: 10, overflow: 'auto', margin: 0, borderRadius: 3 },
  meta: { fontSize: 10, color: 'var(--tn-text-muted)', marginTop: 6 },
  foot: { padding: '6px 12px', fontSize: 10, color: 'var(--tn-text-muted)', borderTop: '1px solid var(--tn-border)' },
};
