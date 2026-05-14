import { useEffect, useState } from 'react';
import { platformJson, formatEur, formatNumber } from './shared';

interface Invoice {
  id: string;
  invoiceNumber: string;
  userId: string;
  tenantId: string | null;
  status: 'draft' | 'issued' | 'paid' | 'cancelled' | 'refunded';
  subtotalEur: string;
  taxEur: string;
  totalEur: string;
  currency: string;
  lineItems: Array<{ description: string; quantity: number; unitPriceEur: number; totalEur: number }>;
  billingAddress: Record<string, string> | null;
  issuedAt: string | null;
  paidAt: string | null;
  dueAt: string | null;
  sentAt: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

const STATUSES = ['', 'draft', 'issued', 'paid', 'cancelled', 'refunded'];
const STATUS_COLORS: Record<string, string> = {
  draft:     'var(--tn-text-muted)',
  issued:    'var(--tn-blue)',
  paid:      'var(--tn-green)',
  cancelled: 'var(--tn-red)',
  refunded:  'var(--tn-orange)',
};

export default function InvoicesTab() {
  const [items, setItems] = useState<Invoice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState('');
  const [selected, setSelected] = useState<Invoice | null>(null);

  async function load() {
    try {
      const qs = new URLSearchParams();
      if (statusFilter) qs.set('status', statusFilter);
      qs.set('limit', '200');
      const d = await platformJson<{ items: Invoice[]; count: number }>(`/v1/invoices?${qs}`);
      setItems(d.items); setError(null);
    } catch (e: any) { setError(e?.message ?? String(e)); }
  }
  useEffect(() => { load(); }, [statusFilter]);

  async function patchStatus(id: string, status: string) {
    if (!confirm(`Invoice auf "${status}" setzen?`)) return;
    await platformJson(`/v1/invoices/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    load();
    if (selected?.id === id) {
      const fresh = await platformJson<Invoice>(`/v1/invoices/${id}`);
      setSelected(fresh);
    }
  }

  function openHtml(id: string) {
    // open in new tab — proxy injects service-token server-side
    window.open(`/api/bridge-proxy/v1/invoices/${id}/html`, '_blank');
  }

  async function sendInvoice(id: string) {
    if (!confirm('Rechnung per Email versenden? Empfänger ist die im User-Profil hinterlegte Adresse.')) return;
    try {
      const res = await platformJson<{ recipient: string; resendId: string }>(
        `/v1/invoices/${id}/send`,
        { method: 'POST' },
      );
      alert(`✓ An ${res.recipient} versendet (Resend-ID ${res.resendId})`);
      load();
      if (selected?.id === id) {
        const fresh = await platformJson<Invoice>(`/v1/invoices/${id}`);
        setSelected(fresh);
      }
    } catch (e: any) {
      alert(`✗ Versand fehlgeschlagen: ${e?.message ?? e}`);
    }
  }

  if (error && !items) return <div style={S.err}><strong>Bridge unreachable:</strong><pre style={{ fontSize: 11 }}>{error}</pre></div>;
  if (!items) return <div style={S.empty}>Lade Invoices …</div>;

  const totals = items.reduce(
    (acc, inv) => {
      const total = parseFloat(inv.totalEur);
      acc[inv.status] = (acc[inv.status] ?? 0) + total;
      return acc;
    },
    {} as Record<string, number>,
  );

  return (
    <div style={S.root}>
      <div style={S.bar}>
        <label style={S.lbl}>Status:</label>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={S.sel}>
          {STATUSES.map((s) => <option key={s} value={s}>{s || '— alle —'}</option>)}
        </select>
        <span style={S.count}>{formatNumber(items.length)} invoices</span>
        <span style={S.totalsCount}>
          paid: {formatEur(totals.paid ?? 0)} · issued: {formatEur(totals.issued ?? 0)} · draft: {formatEur(totals.draft ?? 0)}
        </span>
        <button onClick={load} style={S.btn}>Refresh</button>
      </div>

      <div style={S.split}>
        <div style={S.listCol}>
          {items.length === 0 && <div style={S.empty}>Noch keine Invoices.</div>}
          {items.map((inv) => (
            <div
              key={inv.id}
              style={{ ...S.row, background: selected?.id === inv.id ? 'rgba(122,162,247,0.1)' : undefined }}
              onClick={() => setSelected(inv)}
            >
              <span style={S.num}>{inv.invoiceNumber}</span>
              <span style={{ ...S.status, color: STATUS_COLORS[inv.status], borderColor: STATUS_COLORS[inv.status] }}>{inv.status}</span>
              <span style={S.amount}>{formatEur(parseFloat(inv.totalEur))}</span>
              <span style={S.user}>{inv.tenantId ?? inv.userId.slice(0, 8)}</span>
              <span style={S.ts}>{inv.issuedAt ? new Date(inv.issuedAt).toLocaleDateString() : '—'}</span>
            </div>
          ))}
        </div>
        <div style={S.detailCol}>
          {!selected && <div style={S.empty}>Wähle Invoice in der Liste links.</div>}
          {selected && (
            <div>
              <div style={S.detailHead}>
                <h3 style={{ margin: 0 }}>{selected.invoiceNumber}</h3>
                <span style={{ ...S.statusBig, color: STATUS_COLORS[selected.status], borderColor: STATUS_COLORS[selected.status] }}>{selected.status}</span>
              </div>
              <div style={S.detailMeta}>
                Created: {new Date(selected.createdAt).toLocaleString()}<br />
                Issued: {selected.issuedAt ? new Date(selected.issuedAt).toLocaleString() : '—'}<br />
                Paid: {selected.paidAt ? new Date(selected.paidAt).toLocaleString() : '—'}<br />
                Due: {selected.dueAt ? new Date(selected.dueAt).toLocaleDateString() : '—'}
              </div>

              {selected.billingAddress && (
                <div style={S.addr}>
                  {Object.entries(selected.billingAddress).filter(([_, v]) => v).map(([k, v]) => (
                    <div key={k}><span style={{ color: 'var(--tn-text-muted)' }}>{k}:</span> {v}</div>
                  ))}
                </div>
              )}

              <table style={S.table}>
                <thead>
                  <tr><th style={S.th}>Position</th><th style={S.thNum}>Menge</th><th style={S.thNum}>Einzelpreis</th><th style={S.thNum}>Summe</th></tr>
                </thead>
                <tbody>
                  {selected.lineItems.map((li, i) => (
                    <tr key={i}>
                      <td style={S.td}>{li.description}</td>
                      <td style={S.tdNum}>{li.quantity}</td>
                      <td style={S.tdNum}>{li.unitPriceEur.toFixed(2)}</td>
                      <td style={S.tdNum}>{li.totalEur.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div style={S.totals}>
                <div>Subtotal: € {selected.subtotalEur}</div>
                <div>Tax: € {selected.taxEur}</div>
                <div style={S.grand}>Total: € {selected.totalEur}</div>
              </div>

              {selected.notes && <div style={S.notes}>{selected.notes}</div>}

              <div style={S.actions}>
                <button onClick={() => openHtml(selected.id)} style={S.btnPrimary}>📄 HTML / Print</button>
                <button onClick={() => sendInvoice(selected.id)} style={S.btn} disabled={selected.status === 'cancelled'}>
                  ✉ {selected.sentAt ? `Erneut senden` : 'Per Email senden'}
                </button>
                {selected.status === 'draft' && <button onClick={() => patchStatus(selected.id, 'issued')} style={S.btn}>Issue</button>}
                {selected.status === 'issued' && <button onClick={() => patchStatus(selected.id, 'paid')} style={S.btnGreen}>Mark Paid</button>}
                {(selected.status === 'draft' || selected.status === 'issued') && <button onClick={() => patchStatus(selected.id, 'cancelled')} style={S.btnRed}>Cancel</button>}
                {selected.status === 'paid' && <button onClick={() => patchStatus(selected.id, 'refunded')} style={S.btnRed}>Refund</button>}
              </div>
              {selected.sentAt && (
                <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginTop: 6 }}>
                  Zuletzt versendet: {new Date(selected.sentAt).toLocaleString()}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      <div style={S.foot}>Quelle: /v1/invoices · HTML-Preview öffnet im neuen Tab (mit Print-Stylesheet, Browser-PDF). PDF-Generation + Email-Send kommen Phase 2.</div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' },
  err: { padding: 16, background: 'rgba(247,118,142,0.12)', border: '1px solid var(--tn-red)', color: 'var(--tn-red)', margin: 12, borderRadius: 4 },
  empty: { padding: 16, color: 'var(--tn-text-muted)', fontSize: 12 },
  bar: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderBottom: '1px solid var(--tn-border)', flexShrink: 0 },
  lbl: { fontSize: 10, color: 'var(--tn-text-muted)', textTransform: 'uppercase' },
  sel: { padding: '3px 6px', fontSize: 11, background: 'var(--tn-bg-elev)', border: '1px solid var(--tn-border)', color: 'var(--tn-text)', borderRadius: 3 },
  count: { fontSize: 11, color: 'var(--tn-text-muted)' },
  totalsCount: { fontSize: 11, color: 'var(--tn-text-muted)', flex: 1, textAlign: 'right' },
  btn: { padding: '4px 10px', fontSize: 11, background: 'transparent', border: '1px solid var(--tn-border)', color: 'var(--tn-text)', borderRadius: 3, cursor: 'pointer' },
  btnPrimary: { padding: '4px 14px', fontSize: 11, background: 'var(--tn-blue)', color: '#fff', border: 'none', borderRadius: 3, cursor: 'pointer' },
  btnGreen: { padding: '4px 10px', fontSize: 11, background: 'rgba(158,206,106,0.2)', color: 'var(--tn-green)', border: '1px solid var(--tn-green)', borderRadius: 3, cursor: 'pointer' },
  btnRed: { padding: '4px 10px', fontSize: 11, background: 'rgba(247,118,142,0.1)', color: 'var(--tn-red)', border: '1px solid var(--tn-red)', borderRadius: 3, cursor: 'pointer' },
  split: { display: 'grid', gridTemplateColumns: '1fr 1.2fr', gap: 0, flex: 1, minHeight: 0 },
  listCol: { overflow: 'auto', borderRight: '1px solid var(--tn-border)' },
  detailCol: { overflow: 'auto', padding: 16 },
  row: { display: 'grid', gridTemplateColumns: '140px 80px 100px 1fr 100px', gap: 8, padding: '8px 12px', alignItems: 'center', fontSize: 11, borderBottom: '1px solid var(--tn-border)', cursor: 'pointer' },
  num: { fontFamily: 'monospace', color: 'var(--tn-text)' },
  status: { padding: '2px 6px', borderRadius: 3, fontSize: 9, fontWeight: 700, textTransform: 'uppercase', textAlign: 'center', border: '1px solid' },
  statusBig: { padding: '4px 10px', borderRadius: 3, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', border: '1px solid', marginLeft: 12 },
  amount: { textAlign: 'right', fontFamily: 'monospace', color: 'var(--tn-text)' },
  user: { fontSize: 10, color: 'var(--tn-text-muted)', fontFamily: 'monospace' },
  ts: { fontSize: 10, color: 'var(--tn-text-muted)', textAlign: 'right' },
  detailHead: { display: 'flex', alignItems: 'center', marginBottom: 8 },
  detailMeta: { fontSize: 11, color: 'var(--tn-text-muted)', lineHeight: 1.6, marginBottom: 12 },
  addr: { background: 'var(--tn-bg-elev)', padding: 8, borderRadius: 3, fontSize: 11, marginBottom: 12 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 11, marginBottom: 12 },
  th: { padding: '6px 8px', borderBottom: '1px solid var(--tn-border)', textAlign: 'left', fontSize: 10, color: 'var(--tn-text-muted)', textTransform: 'uppercase' },
  thNum: { padding: '6px 8px', borderBottom: '1px solid var(--tn-border)', textAlign: 'right', fontSize: 10, color: 'var(--tn-text-muted)', textTransform: 'uppercase' },
  td: { padding: '4px 8px', borderBottom: '1px solid var(--tn-border)' },
  tdNum: { padding: '4px 8px', borderBottom: '1px solid var(--tn-border)', textAlign: 'right', fontFamily: 'monospace' },
  totals: { textAlign: 'right', fontSize: 12, marginBottom: 12 },
  grand: { fontSize: 16, fontWeight: 700, marginTop: 4, paddingTop: 4, borderTop: '2px solid var(--tn-text)', display: 'inline-block', minWidth: 200 },
  notes: { padding: 8, background: 'var(--tn-bg-elev)', fontSize: 11, color: 'var(--tn-text-muted)', borderRadius: 3, marginBottom: 12 },
  actions: { display: 'flex', gap: 6, flexWrap: 'wrap' },
  foot: { padding: '6px 12px', fontSize: 10, color: 'var(--tn-text-muted)', borderTop: '1px solid var(--tn-border)', flexShrink: 0 },
};
