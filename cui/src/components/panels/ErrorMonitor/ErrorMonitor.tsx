import { useState, useEffect, useCallback, useRef } from 'react';

// ─── Types (mirror server/routes/errors.ts) ─────────────────────────────────

type ErrorLevel = 'info' | 'warning' | 'error' | 'fatal';

interface ErrorBreadcrumb {
  timestamp: string;
  category: string;
  message?: string;
  level?: ErrorLevel;
  data?: Record<string, unknown>;
}

interface ErrorEvent {
  id: string;
  fingerprint: string;
  app: string;
  environment: 'development' | 'preview' | 'production';
  level: ErrorLevel;
  message: string;
  type?: string;
  stack?: string;
  filename?: string;
  lineno?: number;
  colno?: number;
  url?: string;
  method?: string;
  userAgent?: string;
  userId?: string;
  userEmail?: string;
  release?: string;
  runtime?: 'browser' | 'node' | 'edge';
  breadcrumbs?: ErrorBreadcrumb[];
  count: number;
  firstSeen: string;
  lastSeen: string;
  sentryIssueId?: string;
  sentryEventId?: string;
  sentryUrl?: string;
  resolved: boolean;
  resolvedAt?: string;
  resolvedBy?: string;
  notes?: string;
}

interface ListResponse {
  total: number;
  unresolved: number;
  entries: ErrorEvent[];
}

// ─── Constants ──────────────────────────────────────────────────────────────

const LEVEL_COLORS: Record<ErrorLevel, string> = {
  info: '#7aa2f7',
  warning: '#e0af68',
  error: '#f7768e',
  fatal: '#bb44aa',
};

const APP_COLORS: Record<string, string> = {
  'werking-report': '#7aa2f7',
  'werking-energy': '#9ece6a',
  'werking-safety': '#e0af68',
  'werking-noise': '#bb9af7',
  'platform': '#f7768e',
  'engelmann': '#ff9e64',
  'acro-community': '#73daca',
};

function getAppColor(app: string): string {
  return APP_COLORS[app] || '#888';
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatRelative(isoDate: string): string {
  const then = new Date(isoDate).getTime();
  const now = Date.now();
  const diff = Math.max(0, now - then);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function LevelBadge({ level }: { level: ErrorLevel }) {
  const color = LEVEL_COLORS[level];
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 3,
      background: `${color}22`, color, border: `1px solid ${color}55`,
      textTransform: 'uppercase', letterSpacing: 0.5,
    }}>{level}</span>
  );
}

function AppBadge({ app }: { app: string }) {
  const color = getAppColor(app);
  return (
    <span style={{
      fontSize: 10, fontWeight: 600, padding: '2px 6px', borderRadius: 3,
      background: `${color}18`, color,
    }}>{app}</span>
  );
}

function CountBadge({ count }: { count: number }) {
  if (count < 2) return null;
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 10,
      background: '#414868', color: '#c0caf5',
    }}>×{count}</span>
  );
}

// ─── Main Panel ─────────────────────────────────────────────────────────────

export default function ErrorMonitor() {
  const [entries, setEntries] = useState<ErrorEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filterApp, setFilterApp] = useState<string>('');
  const [filterLevel, setFilterLevel] = useState<string>('');
  const [showResolved, setShowResolved] = useState(false);
  const [selected, setSelected] = useState<ErrorEvent | null>(null);
  const [spawnPending, setSpawnPending] = useState(false);
  const [stats, setStats] = useState({ total: 0, unresolved: 0 });
  const [connected, setConnected] = useState(false);
  const sseRef = useRef<EventSource | null>(null);

  // ─── Load List ─────────────────────────────────────────────────────────────
  const loadList = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (filterApp) params.set('app', filterApp);
      if (filterLevel) params.set('level', filterLevel);
      if (!showResolved) params.set('resolved', 'false');
      const r = await fetch(`/api/errors?${params.toString()}`);
      if (!r.ok) throw new Error(`${r.status}`);
      const data: ListResponse = await r.json();
      setEntries(data.entries);
      setStats({ total: data.total, unresolved: data.unresolved });
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [filterApp, filterLevel, showResolved]);

  useEffect(() => { loadList(); }, [loadList]);

  // ─── SSE Live Feed ─────────────────────────────────────────────────────────
  useEffect(() => {
    const es = new EventSource('/api/errors/stream');
    sseRef.current = es;

    es.addEventListener('connected', () => setConnected(true));

    es.addEventListener('error.new', (evt) => {
      try {
        const e = JSON.parse((evt as MessageEvent).data) as ErrorEvent;
        setEntries(prev => {
          if (prev.some(x => x.id === e.id)) return prev;
          return [e, ...prev];
        });
        setStats(s => ({ total: s.total + 1, unresolved: s.unresolved + 1 }));
      } catch { /* noop */ }
    });

    es.addEventListener('error.updated', (evt) => {
      try {
        const e = JSON.parse((evt as MessageEvent).data) as ErrorEvent;
        setEntries(prev => prev.map(x => x.id === e.id ? e : x));
        if (selected?.id === e.id) setSelected(e);
      } catch { /* noop */ }
    });

    es.addEventListener('error.resolved', (evt) => {
      try {
        const e = JSON.parse((evt as MessageEvent).data) as ErrorEvent;
        setEntries(prev => prev.map(x => x.id === e.id ? e : x));
        setStats(s => ({ ...s, unresolved: Math.max(0, s.unresolved - 1) }));
      } catch { /* noop */ }
    });

    es.addEventListener('error.deleted', (evt) => {
      try {
        const { id } = JSON.parse((evt as MessageEvent).data) as { id: string };
        setEntries(prev => prev.filter(x => x.id !== id));
        if (selected?.id === id) setSelected(null);
      } catch { /* noop */ }
    });

    es.onerror = () => setConnected(false);

    return () => { es.close(); sseRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Actions ───────────────────────────────────────────────────────────────
  const resolveError = async (entry: ErrorEvent, notes?: string) => {
    try {
      const r = await fetch(`/api/errors/${entry.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolved: true, resolvedBy: 'rafael', ...(notes ? { notes } : {}) }),
      });
      if (!r.ok) throw new Error(`${r.status}`);
      await loadList();
      if (selected?.id === entry.id) setSelected(null);
    } catch (e) {
      alert(`Resolve failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const deleteError = async (entry: ErrorEvent) => {
    if (!confirm(`Delete "${entry.message.slice(0, 60)}…"?`)) return;
    try {
      const r = await fetch(`/api/errors/${entry.id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error(`${r.status}`);
      if (selected?.id === entry.id) setSelected(null);
    } catch (e) {
      alert(`Delete failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const spawnFix = async (entry: ErrorEvent) => {
    setSpawnPending(true);
    try {
      const r = await fetch(`/api/errors/${entry.id}/spawn-fix`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: 'default' }),
      });
      if (!r.ok) throw new Error(await r.text());
      const data = await r.json();
      alert(`Fix-Session gestartet: ${data.mission?.sessionId || 'ok'}`);
    } catch (e) {
      alert(`Spawn failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSpawnPending(false);
    }
  };

  const uniqueApps = Array.from(new Set(entries.map(e => e.app))).sort();

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={{
      height: '100%', display: 'flex', flexDirection: 'column',
      background: '#1a1b26', color: '#c0caf5', fontFamily: 'system-ui, sans-serif',
    }}>
      {/* Header */}
      <div style={{
        padding: '12px 16px', borderBottom: '1px solid #2a2b3a',
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
      }}>
        <div style={{ fontSize: 14, fontWeight: 700 }}>Error Monitor</div>
        <div style={{
          fontSize: 10, padding: '2px 6px', borderRadius: 3,
          background: connected ? '#9ece6a22' : '#f7768e22',
          color: connected ? '#9ece6a' : '#f7768e',
          border: `1px solid ${connected ? '#9ece6a55' : '#f7768e55'}`,
        }}>
          {connected ? '● LIVE' : '○ OFFLINE'}
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ fontSize: 11, color: '#7aa2f7' }}>
          {stats.unresolved} unresolved / {stats.total} total
        </div>
        <button onClick={() => loadList()} style={{
          fontSize: 11, padding: '4px 10px', borderRadius: 4,
          background: '#2a2b3a', color: '#c0caf5', border: '1px solid #414868', cursor: 'pointer',
        }}>Refresh</button>
      </div>

      {/* Filter Bar */}
      <div style={{
        padding: '8px 16px', borderBottom: '1px solid #2a2b3a',
        display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center',
      }}>
        <select value={filterApp} onChange={e => setFilterApp(e.target.value)} style={selectStyle}>
          <option value="">Alle Apps</option>
          {uniqueApps.map(a => <option key={a} value={a}>{a}</option>)}
        </select>
        <select value={filterLevel} onChange={e => setFilterLevel(e.target.value)} style={selectStyle}>
          <option value="">Alle Level</option>
          <option value="info">Info</option>
          <option value="warning">Warning</option>
          <option value="error">Error</option>
          <option value="fatal">Fatal</option>
        </select>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, cursor: 'pointer' }}>
          <input type="checkbox" checked={showResolved} onChange={e => setShowResolved(e.target.checked)} />
          Resolved anzeigen
        </label>
      </div>

      {/* Body: Split view — List | Detail */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* List */}
        <div style={{
          flex: selected ? '0 0 45%' : 1, overflow: 'auto',
          borderRight: selected ? '1px solid #2a2b3a' : 'none',
        }}>
          {loading && <div style={{ padding: 24, textAlign: 'center', color: '#565f89' }}>Loading…</div>}
          {error && <div style={{ padding: 16, color: '#f7768e' }}>Error: {error}</div>}
          {!loading && entries.length === 0 && (
            <div style={{ padding: 24, textAlign: 'center', color: '#565f89' }}>
              {showResolved ? 'Keine Errors.' : '✓ Alles sauber — keine unresolved Errors.'}
            </div>
          )}
          {entries.map(entry => (
            <div
              key={entry.id}
              onClick={() => setSelected(entry)}
              style={{
                padding: '10px 16px', borderBottom: '1px solid #2a2b3a',
                cursor: 'pointer',
                background: selected?.id === entry.id ? '#2a2b3a' : 'transparent',
                opacity: entry.resolved ? 0.55 : 1,
              }}
              onMouseEnter={e => { if (selected?.id !== entry.id) e.currentTarget.style.background = '#1f2030'; }}
              onMouseLeave={e => { if (selected?.id !== entry.id) e.currentTarget.style.background = 'transparent'; }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <LevelBadge level={entry.level} />
                <AppBadge app={entry.app} />
                <CountBadge count={entry.count} />
                {entry.resolved && (
                  <span style={{ fontSize: 10, color: '#9ece6a', fontWeight: 600 }}>✓ RESOLVED</span>
                )}
                <div style={{ flex: 1 }} />
                <span style={{ fontSize: 10, color: '#565f89' }}>{formatRelative(entry.lastSeen)}</span>
              </div>
              <div style={{
                fontSize: 12, fontFamily: 'ui-monospace, monospace',
                lineHeight: 1.4, color: entry.resolved ? '#565f89' : '#c0caf5',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {entry.type && <span style={{ color: '#bb9af7' }}>{entry.type}: </span>}
                {entry.message}
              </div>
              {entry.url && (
                <div style={{ fontSize: 10, color: '#565f89', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {entry.url}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Detail */}
        {selected && (
          <div style={{ flex: 1, overflow: 'auto', padding: '16px 20px' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 12 }}>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                  <LevelBadge level={selected.level} />
                  <AppBadge app={selected.app} />
                  <CountBadge count={selected.count} />
                  <span style={{ fontSize: 10, color: '#565f89' }}>{selected.environment}</span>
                  {selected.runtime && <span style={{ fontSize: 10, color: '#565f89' }}>· {selected.runtime}</span>}
                </div>
                <div style={{ fontSize: 14, fontWeight: 600, fontFamily: 'ui-monospace, monospace', marginBottom: 6 }}>
                  {selected.type && <span style={{ color: '#bb9af7' }}>{selected.type}: </span>}
                  {selected.message}
                </div>
              </div>
              <button onClick={() => setSelected(null)} style={{
                background: 'transparent', border: 'none', color: '#565f89',
                cursor: 'pointer', fontSize: 18, padding: 0,
              }}>×</button>
            </div>

            {/* Actions */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
              {!selected.resolved && (
                <>
                  <button onClick={() => spawnFix(selected)} disabled={spawnPending} style={primaryBtn}>
                    {spawnPending ? '⏳ Spawning…' : '🔧 Fix this (Sub-Session)'}
                  </button>
                  <button onClick={() => resolveError(selected)} style={secondaryBtn}>
                    ✓ Mark Resolved
                  </button>
                </>
              )}
              {selected.resolved && (
                <div style={{ fontSize: 11, color: '#9ece6a' }}>
                  ✓ Resolved {selected.resolvedAt && `at ${new Date(selected.resolvedAt).toLocaleString()}`}
                  {selected.resolvedBy && ` by ${selected.resolvedBy}`}
                </div>
              )}
              {selected.sentryUrl && (
                <a href={selected.sentryUrl} target="_blank" rel="noreferrer" style={{
                  ...secondaryBtn, textDecoration: 'none', display: 'inline-flex', alignItems: 'center',
                }}>View in Sentry ↗</a>
              )}
              <button onClick={() => deleteError(selected)} style={{ ...secondaryBtn, color: '#f7768e', borderColor: '#f7768e44' }}>
                Delete
              </button>
            </div>

            {/* Meta */}
            <DetailSection title="Context">
              <MetaRow label="First seen" value={new Date(selected.firstSeen).toLocaleString()} />
              <MetaRow label="Last seen" value={new Date(selected.lastSeen).toLocaleString()} />
              <MetaRow label="Count" value={String(selected.count)} />
              {selected.release && <MetaRow label="Release" value={selected.release} />}
              {selected.url && <MetaRow label="URL" value={selected.url} />}
              {selected.method && <MetaRow label="Method" value={selected.method} />}
              {selected.userEmail && <MetaRow label="User" value={selected.userEmail} />}
              {selected.userId && <MetaRow label="User ID" value={selected.userId} />}
              {selected.filename && <MetaRow label="File" value={`${selected.filename}:${selected.lineno || 0}:${selected.colno || 0}`} />}
              <MetaRow label="Fingerprint" value={selected.fingerprint} />
            </DetailSection>

            {selected.stack && (
              <DetailSection title="Stack Trace">
                <pre style={{
                  fontSize: 11, fontFamily: 'ui-monospace, monospace',
                  background: '#0f1018', padding: 12, borderRadius: 4,
                  overflow: 'auto', color: '#c0caf5', margin: 0,
                  border: '1px solid #2a2b3a',
                }}>{selected.stack}</pre>
              </DetailSection>
            )}

            {selected.breadcrumbs && selected.breadcrumbs.length > 0 && (
              <DetailSection title={`Breadcrumbs (${selected.breadcrumbs.length})`}>
                <div style={{ fontSize: 11, fontFamily: 'ui-monospace, monospace' }}>
                  {selected.breadcrumbs.map((bc, i) => (
                    <div key={i} style={{
                      padding: '4px 8px', borderLeft: `2px solid ${bc.level ? LEVEL_COLORS[bc.level] : '#414868'}`,
                      marginBottom: 2, background: '#0f1018',
                    }}>
                      <span style={{ color: '#565f89' }}>{formatRelative(bc.timestamp)} </span>
                      <span style={{ color: '#7aa2f7' }}>[{bc.category}]</span>
                      {bc.message && <span> {bc.message}</span>}
                    </div>
                  ))}
                </div>
              </DetailSection>
            )}

            {selected.userAgent && (
              <DetailSection title="Browser">
                <div style={{ fontSize: 11, color: '#9aa5ce' }}>{selected.userAgent}</div>
              </DetailSection>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Styles ─────────────────────────────────────────────────────────────────

const selectStyle: React.CSSProperties = {
  fontSize: 11, padding: '4px 8px', borderRadius: 4,
  background: '#1a1b26', color: '#c0caf5', border: '1px solid #414868',
};

const primaryBtn: React.CSSProperties = {
  fontSize: 11, padding: '6px 12px', borderRadius: 4, cursor: 'pointer',
  background: '#7aa2f7', color: '#1a1b26', border: 'none', fontWeight: 600,
};

const secondaryBtn: React.CSSProperties = {
  fontSize: 11, padding: '6px 12px', borderRadius: 4, cursor: 'pointer',
  background: 'transparent', color: '#c0caf5', border: '1px solid #414868',
};

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{
        fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
        letterSpacing: 0.8, color: '#565f89', marginBottom: 6,
      }}>{title}</div>
      {children}
    </div>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', fontSize: 11, lineHeight: 1.6 }}>
      <div style={{ width: 100, color: '#565f89', flexShrink: 0 }}>{label}</div>
      <div style={{ color: '#c0caf5', fontFamily: 'ui-monospace, monospace', wordBreak: 'break-all' }}>{value}</div>
    </div>
  );
}
