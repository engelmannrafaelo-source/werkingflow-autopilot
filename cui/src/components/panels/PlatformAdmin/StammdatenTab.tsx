import { useEffect, useState } from 'react';
import { platformJson } from './shared';

interface Tenant { id: string; name: string }
interface Stammdaten { tenantId: string; appId: string; data: Record<string, unknown>; updatedAt: string | null; updatedBy: string | null }

const APPS = ['werking-report', 'werking-energy', 'werking-safety', 'werking-noise', 'engelmann'];

export default function StammdatenTab() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [tenantId, setTenantId] = useState<string>('');
  const [appId, setAppId] = useState<string>('werking-report');
  const [doc, setDoc] = useState<Stammdaten | null>(null);
  const [draft, setDraft] = useState<string>('{}');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    platformJson<Tenant[]>('/v1/tenants?limit=300').then((d) => {
      const named = d.filter((t) => !t.id.startsWith('personal_') && !t.name.startsWith('Auto-tenant'));
      setTenants(named);
      if (named.length > 0 && !tenantId) setTenantId(named[0].id);
    }).catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (!tenantId || !appId) return;
    platformJson<Stammdaten>(`/v1/stammdaten/${tenantId}/${appId}`)
      .then((d) => { setDoc(d); setDraft(JSON.stringify(d.data ?? {}, null, 2)); setError(null); })
      .catch((e) => setError(String(e)));
  }, [tenantId, appId]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const data = JSON.parse(draft);
      const updated = await platformJson<Stammdaten>(`/v1/stammdaten/${tenantId}/${appId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data }),
      });
      setDoc(updated);
      setDraft(JSON.stringify(updated.data, null, 2));
    } catch (e: any) {
      setError(e instanceof SyntaxError ? `Ungültiges JSON: ${e.message}` : String(e?.message ?? e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={S.root}>
      <div style={S.bar}>
        <label style={S.lbl}>Tenant:</label>
        <select value={tenantId} onChange={(e) => setTenantId(e.target.value)} style={S.sel}>
          {tenants.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.id})</option>)}
        </select>
        <label style={S.lbl}>App:</label>
        <select value={appId} onChange={(e) => setAppId(e.target.value)} style={S.sel}>
          {APPS.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        <div style={S.spacer} />
        {doc?.updatedAt && <span style={S.meta}>Geändert: {new Date(doc.updatedAt).toLocaleString()}</span>}
      </div>

      <div style={S.body}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          style={S.editor}
          placeholder='{"key": "value"}'
          spellCheck={false}
        />
        {error && <div style={S.err}>{error}</div>}
        <div style={S.actions}>
          <button onClick={save} disabled={saving} style={S.save}>{saving ? 'Speichere …' : 'Speichern'}</button>
          <button onClick={() => setDraft(JSON.stringify(doc?.data ?? {}, null, 2))} style={S.btn}>Reset</button>
        </div>
      </div>
      <div style={S.foot}>Quelle: GET/PUT /v1/stammdaten/&#123;tenantId&#125;/&#123;appId&#125;. JSONB pro Tenant × App.</div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' },
  bar: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderBottom: '1px solid var(--tn-border)' },
  lbl: { fontSize: 10, color: 'var(--tn-text-muted)', textTransform: 'uppercase' },
  sel: { padding: '3px 6px', fontSize: 11, background: 'var(--tn-bg-elev)', border: '1px solid var(--tn-border)', color: 'var(--tn-text)', borderRadius: 3 },
  spacer: { flex: 1 },
  meta: { fontSize: 10, color: 'var(--tn-text-muted)' },
  body: { flex: 1, display: 'flex', flexDirection: 'column', padding: 12, minHeight: 0 },
  editor: { flex: 1, padding: 8, background: 'var(--tn-bg-elev)', border: '1px solid var(--tn-border)', color: 'var(--tn-text)', fontFamily: 'monospace', fontSize: 12, borderRadius: 3, resize: 'none' },
  err: { padding: 8, background: 'rgba(247,118,142,0.12)', border: '1px solid var(--tn-red)', color: 'var(--tn-red)', fontSize: 11, borderRadius: 3, marginTop: 6 },
  actions: { display: 'flex', gap: 6, marginTop: 8 },
  save: { padding: '6px 14px', fontSize: 11, background: 'var(--tn-blue)', color: '#fff', border: 'none', borderRadius: 3, cursor: 'pointer' },
  btn: { padding: '6px 14px', fontSize: 11, background: 'transparent', border: '1px solid var(--tn-border)', color: 'var(--tn-text)', borderRadius: 3, cursor: 'pointer' },
  foot: { padding: '6px 12px', fontSize: 10, color: 'var(--tn-text-muted)', borderTop: '1px solid var(--tn-border)' },
};
