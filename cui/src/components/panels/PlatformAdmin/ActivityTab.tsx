import { useEffect, useMemo, useState } from 'react';
import { platformJson, formatNumber } from './shared';
import { usePlatformMode } from './ModeContext';

interface Activity {
  id: string;
  timestamp: string;
  category: string;
  eventType: string;
  actorUserId: string | null;
  targetUserId: string | null;
  tenantId: string | null;
  appId: string | null;
  ip: string | null;
  userAgent: string | null;
  payload: Record<string, any>;
}

interface ActivityResponse {
  activities: Activity[];
  count: number;
}

const CATEGORIES = ['', 'auth', 'user', 'tenant', 'billing', 'workflow', 'admin', 'storage', 'security', 'system'];
const APPS = ['', 'werking-report', 'werking-energy', 'werking-safety', 'werking-noise', 'engelmann'];
const REFRESH_INTERVAL_MS = 30_000;

const CATEGORY_COLORS: Record<string, string> = {
  auth: 'var(--tn-blue)',
  user: 'var(--tn-cyan)',
  tenant: 'var(--tn-magenta)',
  billing: 'var(--tn-yellow)',
  workflow: 'var(--tn-green)',
  admin: 'var(--tn-orange)',
  storage: 'var(--tn-text-muted)',
  security: 'var(--tn-red)',
  system: 'var(--tn-text-muted)',
};

export default function ActivityTab() {
  const [resp, setResp] = useState<ActivityResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [category, setCategory] = useState('');
  const [appId, setAppId] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const { mode, withMode } = usePlatformMode();

  async function load() {
    try {
      const qs = new URLSearchParams();
      if (category) qs.set('category', category);
      if (appId) qs.set('appId', appId);
      qs.set('limit', '200');
      const data = await platformJson<ActivityResponse>(withMode(`/v1/activity/query?${qs.toString()}`));
      setResp(data);
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
  }, [category, appId, mode]);

  const grouped = useMemo(() => {
    if (!resp) return null;
    const byCategory: Record<string, number> = {};
    for (const a of resp.activities) {
      byCategory[a.category] = (byCategory[a.category] ?? 0) + 1;
    }
    return byCategory;
  }, [resp]);

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  if (loading && !resp) return <div style={style.empty}>Lade Activity …</div>;
  if (error && !resp) {
    return (
      <div style={style.errorBox}>
        <strong>Bridge unreachable:</strong>
        <pre style={{ margin: '8px 0 0', fontSize: 11 }}>{error}</pre>
      </div>
    );
  }
  if (!resp) return null;

  return (
    <div data-ai-id="platform-activity-tab" style={style.root}>
      <div style={style.toolbar}>
        <label style={style.lbl}>Category:</label>
        <select
          data-ai-id="platform-activity-cat"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          style={style.select}
        >
          {CATEGORIES.map((c) => <option key={c} value={c}>{c || '— all —'}</option>)}
        </select>

        <label style={style.lbl}>App:</label>
        <select
          data-ai-id="platform-activity-app"
          value={appId}
          onChange={(e) => setAppId(e.target.value)}
          style={style.select}
        >
          {APPS.map((a) => <option key={a} value={a}>{a || '— all —'}</option>)}
        </select>

        <div style={style.toolbarSpacer} />
        <span style={style.count}>{formatNumber(resp.count)} events</span>
        <button data-ai-id="platform-activity-refresh" onClick={load} style={style.refreshBtn}>Aktualisieren</button>
      </div>

      {grouped && Object.keys(grouped).length > 0 && (
        <div style={style.chips}>
          {Object.entries(grouped)
            .sort(([, a], [, b]) => b - a)
            .map(([cat, n]) => (
              <span key={cat} style={{ ...style.chip, color: CATEGORY_COLORS[cat] ?? 'var(--tn-text)' }}>
                {cat}: {n}
              </span>
            ))}
        </div>
      )}

      <div style={style.listWrap}>
        {resp.activities.length === 0 && (
          <div style={style.empty}>
            Keine Events. Sobald die Apps via PlatformClient.logActivity() melden, erscheinen sie hier in Echtzeit.
          </div>
        )}
        {resp.activities.map((a) => {
          const isOpen = expanded.has(a.id);
          return (
            <div key={a.id} data-ai-id={`platform-activity-row-${a.id}`} style={style.entry}>
              <div style={style.entryHeader} onClick={() => toggle(a.id)}>
                <span style={{ ...style.cat, color: CATEGORY_COLORS[a.category] ?? 'var(--tn-text)' }}>
                  {isOpen ? '▼' : '▶'} {a.category}
                </span>
                <span style={style.event}>{a.eventType}</span>
                <span style={style.app}>{a.appId ?? '—'}</span>
                <span style={style.timestamp}>{new Date(a.timestamp).toLocaleTimeString()}</span>
              </div>
              {isOpen && (
                <div style={style.entryBody}>
                  <div style={style.entryRow}>
                    <span style={style.kLabel}>actor:</span>
                    <span style={style.kVal}>{a.actorUserId ?? '—'}</span>
                  </div>
                  <div style={style.entryRow}>
                    <span style={style.kLabel}>target:</span>
                    <span style={style.kVal}>{a.targetUserId ?? '—'}</span>
                  </div>
                  <div style={style.entryRow}>
                    <span style={style.kLabel}>tenant:</span>
                    <span style={style.kVal}>{a.tenantId ?? '—'}</span>
                  </div>
                  <div style={style.entryRow}>
                    <span style={style.kLabel}>ip:</span>
                    <span style={style.kVal}>{a.ip ?? '—'}</span>
                  </div>
                  {Object.keys(a.payload ?? {}).length > 0 && (
                    <div style={style.entryRow}>
                      <span style={style.kLabel}>payload:</span>
                      <pre style={style.payload}>{JSON.stringify(a.payload, null, 2)}</pre>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div style={style.footnote}>
        Quelle: GET /v1/activity/query via Bridge. Aktualisierung alle 30 s. Apps loggen Auth, Billing, Workflow, Admin via PlatformClient.logActivity().
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
  entryHeader: { display: 'grid', gridTemplateColumns: '110px 1fr 130px 80px', gap: 12, padding: '6px 12px', cursor: 'pointer', alignItems: 'center' },
  cat: { fontSize: 11, fontWeight: 600, fontFamily: 'monospace' },
  event: { fontSize: 11, color: 'var(--tn-text)' },
  app: { fontSize: 10, color: 'var(--tn-text-muted)', fontFamily: 'monospace' },
  timestamp: { fontSize: 10, color: 'var(--tn-text-muted)', textAlign: 'right' },
  entryBody: { padding: '4px 12px 8px 30px', background: 'rgba(0,0,0,0.15)' },
  entryRow: { display: 'flex', gap: 8, padding: '2px 0', fontSize: 11 },
  kLabel: { color: 'var(--tn-text-muted)', minWidth: 64 },
  kVal: { color: 'var(--tn-text)', fontFamily: 'monospace', fontSize: 10 },
  payload: { background: 'var(--tn-bg-elev)', border: '1px solid var(--tn-border)', borderRadius: 3, padding: 6, margin: 0, fontSize: 10, overflow: 'auto' },
  footnote: { padding: '6px 12px', fontSize: 10, color: 'var(--tn-text-muted)', borderTop: '1px solid var(--tn-border)', flexShrink: 0 },
};
