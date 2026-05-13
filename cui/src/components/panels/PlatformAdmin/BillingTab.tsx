import { useEffect, useState } from 'react';
import { platformJson, formatEur, formatNumber } from './shared';

interface BillingOverview {
  source: 'subscriptions' | 'activities';
  totalMrrEur: number;
  activeSubscriptions: number;
  cancelledSubscriptions: number;
  totalTopupRevenueEur: number;
  topupPurchasesCount: number;
  totalUserBalanceEur: number;
  byPlan: Record<string, number>;
  byStatus: Record<string, number>;
  byApp: Record<string, number>;
}

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

type SubTab = 'overview' | 'per-user';

export default function BillingTab() {
  const [subTab, setSubTab] = useState<SubTab>('overview');

  // Overview
  const [overview, setOverview] = useState<BillingOverview | null>(null);

  // Per-user
  const [users, setUsers] = useState<SimpleUser[]>([]);
  const [selectedUser, setSelectedUser] = useState<string | null>(null);
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [credits, setCredits] = useState<CreditPurchase[]>([]);

  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function loadOverview() {
    try {
      const data = await platformJson<BillingOverview>('/v1/billing/overview');
      setOverview(data);
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }

  async function loadUsers() {
    try {
      const data = await platformJson<SimpleUser[]>('/v1/users?limit=200');
      setUsers(data);
      if (!selectedUser && data.length > 0) setSelectedUser(data[0].id);
    } catch (e: any) {
      setError(e?.message ?? String(e));
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
    loadOverview();
    loadUsers();
    const id = setInterval(() => {
      loadOverview();
      loadUsers();
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (selectedUser) loadUserBilling(selectedUser);
  }, [selectedUser]);

  if (loading) return <div style={style.empty}>Lade …</div>;
  if (error && !overview) {
    return (
      <div style={style.errorBox}>
        <strong>Bridge unreachable:</strong>
        <pre style={{ margin: '8px 0 0', fontSize: 11 }}>{error}</pre>
      </div>
    );
  }

  return (
    <div data-ai-id="platform-billing-tab" style={style.root}>
      <nav style={style.subTabs}>
        <button
          data-ai-id="billing-tab-overview"
          onClick={() => setSubTab('overview')}
          style={{
            ...style.subBtn,
            background: subTab === 'overview' ? 'var(--tn-blue)' : 'transparent',
            color: subTab === 'overview' ? '#fff' : 'var(--tn-text-muted)',
          }}
        >
          Overview
        </button>
        <button
          data-ai-id="billing-tab-per-user"
          onClick={() => setSubTab('per-user')}
          style={{
            ...style.subBtn,
            background: subTab === 'per-user' ? 'var(--tn-blue)' : 'transparent',
            color: subTab === 'per-user' ? '#fff' : 'var(--tn-text-muted)',
          }}
        >
          Per User
        </button>
      </nav>

      {subTab === 'overview' && overview && <OverviewView overview={overview} />}
      {subTab === 'per-user' && (
        <PerUserView
          users={users}
          selectedUser={selectedUser}
          setSelectedUser={setSelectedUser}
          subs={subs}
          credits={credits}
        />
      )}
    </div>
  );
}

// ─── Overview ────────────────────────────────────────────────────────────

function OverviewView({ overview }: { overview: BillingOverview }) {
  return (
    <div style={style.body}>
      <div style={style.statRow}>
        <Stat label="Total MRR" value={formatEur(overview.totalMrrEur)} accent="blue" hint="aus Plan-Preisen × Seats" />
        <Stat label="Active Subscriptions" value={String(overview.activeSubscriptions)} accent="green" />
        <Stat label="Cancelled" value={String(overview.cancelledSubscriptions)} accent={overview.cancelledSubscriptions > 0 ? 'red' : 'muted'} />
        <Stat label="Top-Up Revenue" value={formatEur(overview.totalTopupRevenueEur)} accent="blue" hint={`${overview.topupPurchasesCount} purchases`} />
        <Stat label="User Balances" value={formatEur(overview.totalUserBalanceEur)} hint="Σ open prepaid" />
      </div>

      <div style={style.gridSection}>
        <div style={style.col}>
          <div style={style.sectionHeader}>By Plan</div>
          <BreakdownTable data={overview.byPlan} />
        </div>
        <div style={style.col}>
          <div style={style.sectionHeader}>By Status</div>
          <BreakdownTable data={overview.byStatus} />
        </div>
        <div style={style.col}>
          <div style={style.sectionHeader}>By App</div>
          <BreakdownTable data={overview.byApp} />
        </div>
      </div>

      <div style={style.footnote}>
        Quelle: GET /v1/billing/overview · {overview.source === 'activities'
          ? 'Daten aus migrierten Activity-Events (subscriptions table noch leer — Sprint B3.4 macht echte Sub-Migration)'
          : 'Daten aus subscriptions table'}
      </div>
    </div>
  );
}

function BreakdownTable({ data }: { data: Record<string, number> }) {
  const entries = Object.entries(data).sort(([, a], [, b]) => b - a);
  if (entries.length === 0) return <div style={style.empty}>—</div>;
  return (
    <table style={style.miniTable}>
      <tbody>
        {entries.map(([k, v]) => (
          <tr key={k}>
            <td style={style.miniCell}>{k}</td>
            <td style={{ ...style.miniCell, textAlign: 'right', fontFamily: 'monospace' }}>{formatNumber(v)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ─── Per-User (unverändert von vorher) ────────────────────────────────────

function PerUserView({
  users, selectedUser, setSelectedUser, subs, credits,
}: {
  users: SimpleUser[];
  selectedUser: string | null;
  setSelectedUser: (id: string) => void;
  subs: Subscription[];
  credits: CreditPurchase[];
}) {
  const totalSpent = credits.reduce((sum, c) => sum + c.amountEur, 0);

  return (
    <div style={style.body}>
      <div style={{ marginBottom: 12 }}>
        <label style={style.lbl}>User:</label>{' '}
        <select
          value={selectedUser ?? ''}
          onChange={(e) => setSelectedUser(e.target.value)}
          style={style.select}
        >
          {users.map((u) => (
            <option key={u.id} value={u.id}>{u.email} ({u.name})</option>
          ))}
        </select>
      </div>

      <div style={style.statRow}>
        <Stat label="Active Subscriptions" value={String(subs.filter((s) => s.status === 'active').length)} />
        <Stat label="Cancelled" value={String(subs.filter((s) => s.status === 'cancelled').length)} />
        <Stat label="Top-Up Spent" value={formatEur(totalSpent)} />
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
  );
}

function Stat({ label, value, accent, hint }: { label: string; value: string; accent?: 'red' | 'green' | 'blue' | 'muted'; hint?: string }) {
  const color =
    accent === 'red' ? 'var(--tn-red)' :
    accent === 'green' ? 'var(--tn-green)' :
    accent === 'blue' ? 'var(--tn-blue)' :
    accent === 'muted' ? 'var(--tn-text-muted)' :
    'var(--tn-text)';
  return (
    <div style={style.stat}>
      <div style={style.statLabel}>{label}</div>
      <div style={{ ...style.statValue, color }}>{value}</div>
      {hint && <div style={style.statHint}>{hint}</div>}
    </div>
  );
}

const style: Record<string, React.CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' },
  empty: { padding: 16, color: 'var(--tn-text-muted)', fontSize: 12 },
  errorBox: { padding: 16, background: 'rgba(247,118,142,0.12)', border: '1px solid var(--tn-red)', borderRadius: 4, margin: 12, color: 'var(--tn-red)', fontSize: 12 },
  subTabs: { display: 'flex', gap: 4, padding: '6px 12px', borderBottom: '1px solid var(--tn-border)', flexShrink: 0 },
  subBtn: { padding: '4px 10px', borderRadius: 3, fontSize: 11, fontWeight: 600, border: '1px solid var(--tn-border)', cursor: 'pointer' },
  body: { flex: 1, overflow: 'auto', padding: 12, minHeight: 0 },
  statRow: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 16 },
  stat: { background: 'var(--tn-bg-elev)', border: '1px solid var(--tn-border)', borderRadius: 4, padding: '10px 12px' },
  statLabel: { fontSize: 10, color: 'var(--tn-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 },
  statValue: { fontSize: 22, fontWeight: 700, fontFamily: 'monospace' },
  statHint: { fontSize: 10, color: 'var(--tn-text-muted)', marginTop: 4 },
  gridSection: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginTop: 12 },
  col: { background: 'var(--tn-bg-elev)', border: '1px solid var(--tn-border)', borderRadius: 4, padding: 12 },
  miniTable: { width: '100%', borderCollapse: 'collapse', fontSize: 11 },
  miniCell: { padding: '4px 6px', borderBottom: '1px solid var(--tn-border)', color: 'var(--tn-text)' },
  section: { marginBottom: 16 },
  sectionHeader: { fontSize: 11, fontWeight: 600, color: 'var(--tn-text)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8, paddingBottom: 4, borderBottom: '1px solid var(--tn-border)' },
  sectionEmpty: { fontSize: 11, color: 'var(--tn-text-muted)', padding: '6px 0', fontStyle: 'italic' },
  row: { display: 'grid', gridTemplateColumns: '80px 1fr 130px 1fr', gap: 12, padding: '6px 0', alignItems: 'center', fontSize: 11, borderBottom: '1px solid var(--tn-border)' },
  badge: { padding: '2px 8px', borderRadius: 3, fontSize: 9, fontWeight: 700, letterSpacing: '0.05em', textAlign: 'center' },
  rowMain: { color: 'var(--tn-text)', fontWeight: 500 },
  rowSub: { color: 'var(--tn-text-muted)', fontSize: 10 },
  rowMono: { color: 'var(--tn-text-muted)', fontFamily: 'monospace', fontSize: 10 },
  lbl: { fontSize: 10, color: 'var(--tn-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' },
  select: { padding: '3px 6px', fontSize: 11, background: 'var(--tn-bg-elev)', border: '1px solid var(--tn-border)', color: 'var(--tn-text)', borderRadius: 3, minWidth: 280 },
  footnote: { padding: '8px 12px', marginTop: 12, fontSize: 10, color: 'var(--tn-text-muted)', borderTop: '1px solid var(--tn-border)' },
};
