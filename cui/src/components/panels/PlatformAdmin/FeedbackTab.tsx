import { useEffect, useMemo, useState } from 'react';
import { platformJson, formatNumber } from './shared';

interface Feedback {
  id: string;
  userId: string | null;
  tenantId: string | null;
  appId: string | null;
  rating: number | null;
  category: string | null;
  title: string | null;
  body: string;
  status: 'open' | 'triaged' | 'resolved' | 'wontfix';
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface FeedbackList {
  items: Feedback[];
  count: number;
}

const REFRESH_INTERVAL_MS = 60_000;
const APPS = ['', 'werking-report', 'werking-energy', 'werking-safety', 'werking-noise', 'engelmann'];
const STATUSES = ['', 'open', 'triaged', 'resolved', 'wontfix'];

const STATUS_COLORS: Record<string, string> = {
  open: 'var(--tn-blue)',
  triaged: 'var(--tn-orange)',
  resolved: 'var(--tn-green)',
  wontfix: 'var(--tn-text-muted)',
};

export default function FeedbackTab() {
  const [data, setData] = useState<FeedbackList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [appFilter, setAppFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  async function load() {
    try {
      const qs = new URLSearchParams();
      if (appFilter) qs.set('appId', appFilter);
      if (statusFilter) qs.set('status', statusFilter);
      qs.set('limit', '200');
      const d = await platformJson<FeedbackList>(`/v1/feedback?${qs.toString()}`);
      setData(d);
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
  }, [appFilter, statusFilter]);

  async function changeStatus(id: string, status: string) {
    try {
      await platformJson(`/v1/feedback/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      load();
    } catch (e) {
      console.warn('changeStatus failed:', e);
    }
  }

  const grouped = useMemo(() => {
    if (!data) return { byStatus: {}, avgRating: 0, ratingsCount: 0 };
    const byStatus: Record<string, number> = {};
    let ratingSum = 0;
    let ratingsCount = 0;
    for (const f of data.items) {
      byStatus[f.status] = (byStatus[f.status] ?? 0) + 1;
      if (f.rating) {
        ratingSum += f.rating;
        ratingsCount++;
      }
    }
    return { byStatus, avgRating: ratingsCount > 0 ? ratingSum / ratingsCount : 0, ratingsCount };
  }, [data]);

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  if (loading && !data) return <div style={style.empty}>Lade Feedback …</div>;
  if (error && !data) {
    return (
      <div style={style.errorBox}>
        <strong>Bridge unreachable:</strong>
        <pre style={{ margin: '8px 0 0', fontSize: 11 }}>{error}</pre>
      </div>
    );
  }
  if (!data) return null;

  return (
    <div data-ai-id="platform-feedback-tab" style={style.root}>
      <div style={style.toolbar}>
        <label style={style.lbl}>App:</label>
        <select value={appFilter} onChange={(e) => setAppFilter(e.target.value)} style={style.select}>
          {APPS.map((a) => <option key={a} value={a}>{a || '— all —'}</option>)}
        </select>

        <label style={style.lbl}>Status:</label>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={style.select}>
          {STATUSES.map((s) => <option key={s} value={s}>{s || '— all —'}</option>)}
        </select>

        <div style={style.toolbarSpacer} />
        <span style={style.count}>
          {formatNumber(data.count)} feedback · ⭐ {grouped.avgRating.toFixed(1)} ({grouped.ratingsCount} rated)
        </span>
        <button onClick={load} style={style.refreshBtn}>Aktualisieren</button>
      </div>

      <div style={style.chips}>
        {Object.entries(grouped.byStatus).map(([st, n]) => (
          <span key={st} style={{ ...style.chip, color: STATUS_COLORS[st] ?? 'var(--tn-text)' }}>
            {st}: {n}
          </span>
        ))}
      </div>

      <div style={style.listWrap}>
        {data.items.length === 0 && (
          <div style={style.empty}>
            Keine Feedback. Sobald die Apps via PlatformClient.submitFeedback() melden oder Endpoint POST /v1/feedback genutzt wird, erscheinen sie hier.
          </div>
        )}
        {data.items.map((f) => {
          const isOpen = expanded.has(f.id);
          return (
            <div key={f.id} style={style.entry}>
              <div style={style.entryHeader} onClick={() => toggle(f.id)}>
                <span style={{ ...style.statusBadge, color: STATUS_COLORS[f.status] ?? 'var(--tn-text)', borderColor: STATUS_COLORS[f.status] ?? 'var(--tn-border)' }}>
                  {f.status}
                </span>
                <span style={style.rating}>
                  {f.rating ? '★'.repeat(f.rating) + '☆'.repeat(5 - f.rating) : '—'}
                </span>
                <span style={style.title}>{f.title || f.body.slice(0, 80)}</span>
                <span style={style.app}>{f.appId ?? '—'}</span>
                <span style={style.timestamp}>{new Date(f.createdAt).toLocaleString()}</span>
                <span style={style.toggle}>{isOpen ? '▼' : '▶'}</span>
              </div>
              {isOpen && (
                <div style={style.entryBody}>
                  <div style={style.bodyText}>{f.body}</div>
                  <div style={style.metaRow}>
                    <span><b>id:</b> <code>{f.id}</code></span>
                    <span><b>user:</b> {f.userId ?? '—'}</span>
                    <span><b>tenant:</b> {f.tenantId ?? '—'}</span>
                    <span><b>category:</b> {f.category ?? '—'}</span>
                  </div>
                  <div style={style.actions}>
                    {(['triaged', 'resolved', 'wontfix', 'open'] as const)
                      .filter((s) => s !== f.status)
                      .map((s) => (
                        <button key={s} onClick={() => changeStatus(f.id, s)} style={{ ...style.actionBtn, color: STATUS_COLORS[s] }}>
                          → {s}
                        </button>
                      ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div style={style.footnote}>
        Quelle: GET /v1/feedback via Bridge. PATCH /v1/feedback/&#123;id&#125; um Status zu setzen (Admin-only).
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
  select: { padding: '3px 6px', fontSize: 11, background: 'var(--tn-bg-elev)', border: '1px solid var(--tn-border)', color: 'var(--tn-text)', borderRadius: 3 },
  count: { fontSize: 11, color: 'var(--tn-text-muted)' },
  refreshBtn: { padding: '4px 10px', borderRadius: 3, fontSize: 11, border: '1px solid var(--tn-border)', background: 'transparent', color: 'var(--tn-text)', cursor: 'pointer' },
  chips: { display: 'flex', flexWrap: 'wrap', gap: 6, padding: '6px 12px', borderBottom: '1px solid var(--tn-border)', flexShrink: 0 },
  chip: { fontSize: 10, padding: '2px 8px', borderRadius: 10, background: 'rgba(255,255,255,0.04)' },
  listWrap: { flex: 1, overflow: 'auto', minHeight: 0 },
  entry: { borderBottom: '1px solid var(--tn-border)' },
  entryHeader: { display: 'grid', gridTemplateColumns: '90px 100px 1fr 130px 130px 20px', gap: 10, padding: '8px 12px', cursor: 'pointer', alignItems: 'center' },
  statusBadge: { padding: '2px 8px', borderRadius: 3, fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', textAlign: 'center', border: '1px solid', background: 'transparent' },
  rating: { fontSize: 11, color: 'var(--tn-yellow)', fontFamily: 'monospace' },
  title: { fontSize: 12, color: 'var(--tn-text)' },
  app: { fontSize: 10, color: 'var(--tn-text-muted)', fontFamily: 'monospace' },
  timestamp: { fontSize: 10, color: 'var(--tn-text-muted)', textAlign: 'right' },
  toggle: { fontSize: 10, color: 'var(--tn-text-muted)', textAlign: 'center' },
  entryBody: { padding: '8px 12px 12px 12px', background: 'rgba(0,0,0,0.15)' },
  bodyText: { fontSize: 12, color: 'var(--tn-text)', whiteSpace: 'pre-wrap', marginBottom: 8 },
  metaRow: { display: 'flex', flexWrap: 'wrap', gap: 16, fontSize: 10, color: 'var(--tn-text-muted)', marginBottom: 8 },
  actions: { display: 'flex', gap: 6 },
  actionBtn: { padding: '3px 8px', fontSize: 10, border: '1px solid var(--tn-border)', background: 'transparent', borderRadius: 3, cursor: 'pointer' },
  footnote: { padding: '6px 12px', fontSize: 10, color: 'var(--tn-text-muted)', borderTop: '1px solid var(--tn-border)', flexShrink: 0 },
};
