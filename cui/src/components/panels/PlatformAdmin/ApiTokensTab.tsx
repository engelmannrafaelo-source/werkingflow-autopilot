import { useEffect, useState } from 'react';
import { platformJson, formatNumber } from './shared';

interface Token {
  id: string;
  userId: string;
  tenantId: string | null;
  name: string;
  last4: string;
  scopes: string[];
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export default function ApiTokensTab() {
  const [items, setItems] = useState<Token[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showRevoked, setShowRevoked] = useState(false);
  const [newSecret, setNewSecret] = useState<{ id: string; secret: string } | null>(null);

  async function load() {
    try {
      const qs = new URLSearchParams();
      if (showRevoked) qs.set('includeRevoked', 'true');
      qs.set('limit', '200');
      const d = await platformJson<{ items: Token[]; count: number }>(`/v1/developer-tokens?${qs}`);
      setItems(d.items); setError(null);
    } catch (e: any) { setError(e?.message ?? String(e)); }
  }
  useEffect(() => { load(); }, [showRevoked]);

  async function revoke(id: string) {
    if (!confirm(`Token ${id.slice(0, 8)}… wirklich revoken?`)) return;
    await platformJson(`/v1/developer-tokens/${id}`, { method: 'DELETE' });
    load();
  }

  async function rotate(id: string) {
    if (!confirm(`Token ${id.slice(0, 8)}… rotieren? Alter Wert wird sofort ungültig.`)) return;
    const res = await platformJson<{ id: string; secret: string }>(`/v1/developer-tokens/${id}/rotate`, { method: 'POST' });
    setNewSecret({ id: res.id, secret: res.secret });
    load();
  }

  if (error && !items) return <div style={S.err}><strong>Bridge unreachable:</strong><pre style={{ fontSize: 11 }}>{error}</pre></div>;
  if (!items) return <div style={S.empty}>Lade Tokens …</div>;

  return (
    <div style={S.root}>
      <div style={S.bar}>
        <label style={S.lbl}><input type="checkbox" checked={showRevoked} onChange={(e) => setShowRevoked(e.target.checked)} /> auch revokte zeigen</label>
        <span style={S.count}>{formatNumber(items.length)} tokens</span>
        <button onClick={load} style={S.btn}>Refresh</button>
      </div>

      {newSecret && (
        <div style={S.banner}>
          <strong>⚠ Neuer Token — kopier ihn JETZT, er wird nicht nochmal angezeigt:</strong>
          <pre style={S.secret}>{newSecret.secret}</pre>
          <button onClick={() => setNewSecret(null)} style={S.btn}>Verstanden, schliessen</button>
        </div>
      )}

      <div style={S.list}>
        {items.length === 0 && <div style={S.empty}>Keine Developer-Tokens.</div>}
        {items.map((t) => (
          <div key={t.id} style={{ ...S.row, opacity: t.revokedAt ? 0.5 : 1 }}>
            <span style={S.name}>{t.name}</span>
            <span style={S.mono}>…{t.last4}</span>
            <span style={S.user}>{t.userId.slice(0, 8)}…</span>
            <span style={S.scopes}>{t.scopes.length > 0 ? t.scopes.join(', ') : '(no scopes)'}</span>
            <span style={S.ts}>{new Date(t.createdAt).toLocaleDateString()}</span>
            <span style={S.lastUsed}>{t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleDateString() : 'never'}</span>
            <div style={S.actions}>
              {!t.revokedAt && <>
                <button onClick={() => rotate(t.id)} style={S.btnInline}>rotate</button>
                <button onClick={() => revoke(t.id)} style={{ ...S.btnInline, color: 'var(--tn-red)' }}>revoke</button>
              </>}
              {t.revokedAt && <span style={S.revoked}>revoked {new Date(t.revokedAt).toLocaleDateString()}</span>}
            </div>
          </div>
        ))}
      </div>
      <div style={S.foot}>Quelle: /v1/developer-tokens. Issue neuer Token via POST /v1/developer-tokens (UI-Form folgt).</div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' },
  err: { padding: 16, background: 'rgba(247,118,142,0.12)', border: '1px solid var(--tn-red)', color: 'var(--tn-red)', margin: 12, borderRadius: 4 },
  empty: { padding: 16, color: 'var(--tn-text-muted)', fontSize: 12 },
  bar: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderBottom: '1px solid var(--tn-border)' },
  lbl: { fontSize: 11, color: 'var(--tn-text-muted)' },
  count: { fontSize: 11, color: 'var(--tn-text-muted)', flex: 1 },
  btn: { padding: '4px 10px', fontSize: 11, background: 'transparent', border: '1px solid var(--tn-border)', color: 'var(--tn-text)', borderRadius: 3, cursor: 'pointer' },
  btnInline: { padding: '2px 8px', fontSize: 10, background: 'transparent', border: '1px solid var(--tn-border)', color: 'var(--tn-text)', borderRadius: 3, cursor: 'pointer' },
  banner: { padding: 12, margin: 12, background: 'rgba(224,175,104,0.1)', border: '1px solid var(--tn-orange)', borderRadius: 4 },
  secret: { background: 'var(--tn-bg-elev)', padding: 8, fontSize: 12, fontFamily: 'monospace', wordBreak: 'break-all', whiteSpace: 'pre-wrap', margin: '6px 0' },
  list: { flex: 1, overflow: 'auto', minHeight: 0 },
  row: { display: 'grid', gridTemplateColumns: '180px 80px 100px 1fr 100px 100px 200px', gap: 10, padding: '6px 12px', alignItems: 'center', fontSize: 11, borderBottom: '1px solid var(--tn-border)' },
  name: { color: 'var(--tn-text)', fontWeight: 500 },
  mono: { fontFamily: 'monospace', color: 'var(--tn-text-muted)' },
  user: { fontFamily: 'monospace', fontSize: 10, color: 'var(--tn-text-muted)' },
  scopes: { color: 'var(--tn-text-muted)', fontSize: 10 },
  ts: { fontSize: 10, color: 'var(--tn-text-muted)' },
  lastUsed: { fontSize: 10, color: 'var(--tn-text-muted)' },
  actions: { display: 'flex', gap: 4, justifyContent: 'flex-end' },
  revoked: { fontSize: 10, color: 'var(--tn-red)' },
  foot: { padding: '6px 12px', fontSize: 10, color: 'var(--tn-text-muted)', borderTop: '1px solid var(--tn-border)' },
};
