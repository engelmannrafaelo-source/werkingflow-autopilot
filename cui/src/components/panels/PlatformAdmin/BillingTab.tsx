import { useEffect, useState } from 'react';
import { platformJson, formatEur } from './shared';

interface Subscription {
  id: string;
  userId: string;
  appId: string;
  planId: string;
  status: string;
  seats: number;
  startedAt: string | null;
  cancelledAt: string | null;
  mollieCustomerId: string;
  mollieSubscriptionId: string | null;
}

interface CreditPurchase {
  id: string;
  userId: string;
  amountEur: number;
  paidAt: string;
  mollieCustomerId: string;
  molliePaymentId: string;
}

interface SimpleUser {
  id: string;
  email: string;
  name: string;
}

const REFRESH_INTERVAL_MS = 60_000;

export default function BillingTab() {
  const [users, setUsers] = useState<SimpleUser[]>([]);
  const [selectedUser, setSelectedUser] = useState<string | null>(null);
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [credits, setCredits] = useState<CreditPurchase[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function loadUsers() {
    try {
      const data = await platformJson<SimpleUser[]>('/v1/users?limit=200');
      setUsers(data);
      if (!selectedUser && data.length > 0) setSelectedUser(data[0].id);
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }

  async function loadUserBilling(userId: string) {
    try {
      const [s, c] = await Promise.all([
        platformJson<{ subscriptions: Subscription[] }>(`/v1/billing/${userId}/subscriptions`).catch(() => ({ subscriptions: [] })),
        platformJson<{ creditPurchases: CreditPurchase[] }>(`/v1/billing/${userId}/credit-purchases`).catch(() => ({ creditPurchases: [] })),
      ]);
      setSubs(s.subscriptions ?? []);
      setCredits(c.creditPurchases ?? []);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }

  useEffect(() => {
    loadUsers();
    const id = setInterval(loadUsers, REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (selectedUser) loadUserBilling(selectedUser);
  }, [selectedUser]);

  if (loading) return <div style={style.empty}>Lade …</div>;
  if (error) {
    return (
      <div style={style.errorBox}>
        <strong>Bridge unreachable:</strong>
        <pre style={{ margin: '8px 0 0', fontSize: 11 }}>{error}</pre>
      </div>
    );
  }

  const totalSpent = credits.reduce((sum, c) => sum + c.amountEur, 0);

  return (
    <div data-ai-id="platform-billing-tab" style={style.root}>
      <div style={style.toolbar}>
        <label style={style.lbl}>User:</label>
        <select
          data-ai-id="platform-billing-user"
          value={selectedUser ?? ''}
          onChange={(e) => setSelectedUser(e.target.value)}
          style={style.select}
        >
          {users.map((u) => (
            <option key={u.id} value={u.id}>{u.email} ({u.name})</option>
          ))}
        </select>
        <div style={style.toolbarSpacer} />
        <span style={style.count}>{subs.length} Subs · {credits.length} Top-Ups</span>
      </div>

      <div style={style.body}>
        <div style={style.statRow}>
          <div style={style.stat}>
            <div style={style.statLabel}>Aktive Subscriptions</div>
            <div style={style.statValue}>{subs.filter((s) => s.status === 'active').length}</div>
          </div>
          <div style={style.stat}>
            <div style={style.statLabel}>Cancelled</div>
            <div style={style.statValue}>{subs.filter((s) => s.status === 'cancelled').length}</div>
          </div>
          <div style={style.stat}>
            <div style={style.statLabel}>Top-Up Spent</div>
            <div style={style.statValue}>{formatEur(totalSpent)}</div>
          </div>
        </div>

        <div style={style.section}>
          <div style={style.sectionHeader}>Subscriptions</div>
          {subs.length === 0 && <div style={style.sectionEmpty}>— keine Subs für diesen User —</div>}
          {subs.map((s) => (
            <div key={s.id} style={style.row}>
              <span style={{ ...style.badge, background: s.status === 'active' ? 'rgba(158,206,106,0.2)' : 'rgba(100,100,100,0.2)', color: s.status === 'active' ? 'var(--tn-green)' : 'var(--tn-text-muted)' }}>
                {s.status}
              </span>
              <span style={style.rowMain}>{s.appId} / {s.planId} ({s.seats} sitze)</span>
              <span style={style.rowSub}>{s.startedAt ? new Date(s.startedAt).toLocaleDateString() : '—'}</span>
              <span style={style.rowMono}>{s.mollieSubscriptionId ?? '—'}</span>
            </div>
          ))}
        </div>

        <div style={style.section}>
          <div style={style.sectionHeader}>Credit Purchases (Top-Ups)</div>
          {credits.length === 0 && <div style={style.sectionEmpty}>— keine Top-Ups —</div>}
          {credits.map((c) => (
            <div key={c.id} style={style.row}>
              <span style={style.rowMain}>{formatEur(c.amountEur)}</span>
              <span style={style.rowSub}>{new Date(c.paidAt).toLocaleString()}</span>
              <span style={style.rowMono}>{c.molliePaymentId}</span>
            </div>
          ))}
        </div>
      </div>

      <div style={style.footnote}>
        Quelle: GET /v1/billing/&#123;userId&#125;/subscriptions + /credit-purchases. Mollie-Adapter: <strong>Fake</strong> (BRIDGE_USE_FAKE_MOLLIE=true). Live aktivierbar mit MOLLIE_API_KEY auf Hetzner.
      </div>
    </div>
  );
}

const style: Record<string, React.CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' },
  empty: { padding: 16, color: 'var(--tn-text-muted)', fontSize: 12 },
  errorBox: { padding: 16, background: 'rgba(247,118,142,0.12)', border: '1px solid var(--tn-red)', borderRadius: 4, margin: 12, color: 'var(--tn-red)', fontSize: 12 },
  toolbar: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid var(--tn-border)', flexShrink: 0 },
  toolbarSpacer: { flex: 1 },
  lbl: { fontSize: 10, color: 'var(--tn-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' },
  select: { padding: '3px 6px', fontSize: 11, background: 'var(--tn-bg-elev)', border: '1px solid var(--tn-border)', color: 'var(--tn-text)', borderRadius: 3, minWidth: 280 },
  count: { fontSize: 11, color: 'var(--tn-text-muted)' },
  body: { flex: 1, overflow: 'auto', padding: 12, minHeight: 0 },
  statRow: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 16 },
  stat: { background: 'var(--tn-bg-elev)', border: '1px solid var(--tn-border)', borderRadius: 4, padding: '10px 12px' },
  statLabel: { fontSize: 10, color: 'var(--tn-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 },
  statValue: { fontSize: 22, fontWeight: 700, fontFamily: 'monospace', color: 'var(--tn-text)' },
  section: { marginBottom: 16 },
  sectionHeader: { fontSize: 11, fontWeight: 600, color: 'var(--tn-text)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6, paddingBottom: 4, borderBottom: '1px solid var(--tn-border)' },
  sectionEmpty: { fontSize: 11, color: 'var(--tn-text-muted)', padding: '6px 0', fontStyle: 'italic' },
  row: { display: 'grid', gridTemplateColumns: '80px 1fr 130px 1fr', gap: 12, padding: '6px 0', alignItems: 'center', fontSize: 11, borderBottom: '1px solid var(--tn-border)' },
  badge: { padding: '2px 8px', borderRadius: 3, fontSize: 9, fontWeight: 700, letterSpacing: '0.05em', textAlign: 'center' },
  rowMain: { color: 'var(--tn-text)', fontWeight: 500 },
  rowSub: { color: 'var(--tn-text-muted)', fontSize: 10 },
  rowMono: { color: 'var(--tn-text-muted)', fontFamily: 'monospace', fontSize: 10 },
  footnote: { padding: '6px 12px', fontSize: 10, color: 'var(--tn-text-muted)', borderTop: '1px solid var(--tn-border)', flexShrink: 0 },
};
