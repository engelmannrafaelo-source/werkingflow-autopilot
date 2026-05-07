import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface Cell {
  userId: string;
  userName: string;
  role: string;
  claudeAccountId: string;
  workspace: string;
  capturedAt: string | null;
  status: 'success' | 'error' | null;
  error: string | null;
  durationMs: number | null;
  inFlight: boolean;
  screenshotUrl: string | null;
}

interface MatrixResponse {
  baseUrl: string;
  users: Array<{ id: string; name: string; role: string }>;
  cells: Cell[];
}

interface HealthResponse {
  mode: 'native' | 'forward';
  baseUrl: string;
  forwardUrl?: string;
  cookieDomain?: string | null;
  captureCount?: number;
  inFlight?: string[];
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface JourneyListItem {
  userId: string;
  workspace: string;
  journeyId: string;
  capturedAt: string;
  screenshotCount: number;
  loginSuccess: boolean | null;
  failureReason: string | null;
}

interface JourneyDetail {
  markdown: string;
  screenshots: Array<{ name: string; url: string }>;
}

const API = '/api/partner-server';
const AUDIT_API = '/api/partner-audit';

// Maps a CUI workspace name to the actual app name expected by the journey API.
// Workspaces not in this map cannot run a journey (no seed-login configured).
const WORKSPACE_TO_APP: Record<string, string> = {
  'werking-energy': 'werking-energy',
  'werking-report': 'werking-report',
  'werkingsafety': 'werking-safety',
  'engelmann-ai-hub': 'engelmann',
  'engelmann-developer': 'engelmann',
  'engelmann-dashboards': 'engelmann',
};

type Tab = 'screenshots' | 'audit' | 'journey';

export default function PartnerServerPanel() {
  const [activeTab, setActiveTab] = useState<Tab>('screenshots');

  // Screenshots tab state
  const [data, setData] = useState<MatrixResponse | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [bulkRunning, setBulkRunning] = useState(false);
  const [zoom, setZoom] = useState<Cell | null>(null);

  // Audit chat tab state
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [auditLoaded, setAuditLoaded] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Journey tab state
  const [journeyBusy, setJourneyBusy] = useState<Set<string>>(new Set());
  const [journeyByUser, setJourneyByUser] = useState<Record<string, JourneyListItem[]>>({});
  const [journeyDetail, setJourneyDetail] = useState<{ userId: string; workspace: string; journeyId: string; data: JourneyDetail } | null>(null);
  const [journeyError, setJourneyError] = useState<string | null>(null);

  const loadJourneyList = useCallback(async (userId: string) => {
    try {
      const r = await fetch(`${API}/journey/list?userId=${encodeURIComponent(userId)}`);
      if (!r.ok) throw new Error(`list ${r.status}`);
      const arr: JourneyListItem[] = await r.json();
      setJourneyByUser(prev => ({ ...prev, [userId]: arr }));
    } catch (e: any) {
      setJourneyError(`list ${userId}: ${e.message}`);
    }
  }, []);

  const runJourney = useCallback(async (userId: string, workspace: string) => {
    const app = WORKSPACE_TO_APP[workspace];
    if (!app) {
      setJourneyError(`Workspace ${workspace} hat kein Journey-Mapping`);
      return;
    }
    const key = `${userId}__${workspace}`;
    setJourneyBusy(prev => new Set(prev).add(key));
    setJourneyError(null);
    try {
      const r = await fetch(`${API}/journey/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, workspace, app }),
      });
      const j = await r.json();
      if (!r.ok || !j.success) throw new Error(j.error || `run ${r.status}`);
      await loadJourneyList(userId);
    } catch (e: any) {
      setJourneyError(`run ${userId}/${workspace}: ${e.message}`);
    } finally {
      setJourneyBusy(prev => { const n = new Set(prev); n.delete(key); return n; });
    }
  }, [loadJourneyList]);

  const openJourneyDetail = useCallback(async (userId: string, workspace: string, journeyId: string) => {
    setJourneyError(null);
    try {
      const r = await fetch(`${API}/journey/${encodeURIComponent(userId)}/${encodeURIComponent(workspace)}/${encodeURIComponent(journeyId)}`);
      if (!r.ok) throw new Error(`detail ${r.status}`);
      const data: JourneyDetail = await r.json();
      setJourneyDetail({ userId, workspace, journeyId, data });
    } catch (e: any) {
      setJourneyError(`detail: ${e.message}`);
    }
  }, []);

  // Auto-load journey lists for all users when entering the tab
  useEffect(() => {
    if (activeTab !== 'journey' || !data) return;
    data.users.forEach(u => {
      if (!journeyByUser[u.id]) loadJourneyList(u.id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, data]);

  // Restore persisted audit chat history on mount
  useEffect(() => {
    fetch(`${AUDIT_API}/session`)
      .then(r => r.ok ? r.json() : { messages: [] })
      .then(d => { setMessages(Array.isArray(d.messages) ? d.messages : []); })
      .catch(() => {})
      .finally(() => setAuditLoaded(true));
  }, []);

  const fetchMatrix = useCallback(async () => {
    try {
      const [m, h] = await Promise.all([
        fetch(`${API}/matrix`).then(r => { if (!r.ok) throw new Error(`matrix ${r.status}`); return r.json(); }),
        fetch(`${API}/health`).then(r => r.ok ? r.json() : null).catch(() => null),
      ]);
      setData(m);
      setHealth(h);
      setError(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchMatrix(); }, [fetchMatrix]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const cellKey = (c: Cell) => `${c.userId}__${c.workspace}`;

  const triggerCapture = useCallback(async (cell: Cell) => {
    const key = cellKey(cell);
    setBusy(s => new Set(s).add(key));
    try {
      const r = await fetch(`${API}/capture`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: cell.userId, workspace: cell.workspace }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `capture ${r.status}`);
      }
      await fetchMatrix();
    } catch (e: any) {
      console.error('[PartnerServer] capture failed:', e);
    } finally {
      setBusy(s => { const n = new Set(s); n.delete(key); return n; });
    }
  }, [fetchMatrix]);

  const runAll = useCallback(async (onlyMissing = false) => {
    if (!data) return;
    setBulkRunning(true);
    try {
      const r = await fetch(`${API}/capture-all`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ onlyMissing }),
      });
      if (!r.ok || !r.body) throw new Error(`capture-all ${r.status}`);
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const ln of lines) {
          if (!ln.trim()) continue;
          await fetchMatrix();
        }
      }
    } catch (e: any) {
      console.error('[PartnerServer] capture-all failed:', e);
    } finally {
      setBulkRunning(false);
      await fetchMatrix();
    }
  }, [data, fetchMatrix]);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;
    const newMessages: ChatMessage[] = [...messages, { role: 'user', content: text }];
    setMessages(newMessages);
    setInput('');
    setSending(true);
    setAuditError(null);
    try {
      const r = await fetch(`${AUDIT_API}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: newMessages }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      const j = await r.json();
      setMessages(prev => [...prev, { role: 'assistant', content: j.response }]);
    } catch (e: any) {
      setAuditError(e.message);
    } finally {
      setSending(false);
    }
  }, [input, messages, sending]);

  const resetAudit = useCallback(async () => {
    if (!confirm('Audit-Chat-Verlauf wirklich löschen?')) return;
    try {
      await fetch(`${AUDIT_API}/reset`, { method: 'POST' });
      setMessages([]);
      setAuditError(null);
    } catch (e: any) {
      setAuditError(e.message);
    }
  }, []);

  const grouped = useMemo(() => {
    if (!data) return new Map<string, Cell[]>();
    const m = new Map<string, Cell[]>();
    for (const c of data.cells) {
      if (!m.has(c.userId)) m.set(c.userId, []);
      m.get(c.userId)!.push(c);
    }
    return m;
  }, [data]);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--tn-bg, #1a1b26)', color: 'var(--tn-text, #c0caf5)' }}>
      {/* Header with tabs */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', borderBottom: '1px solid var(--tn-border, #292e42)', flexShrink: 0 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Partner-Server Health</h2>
        {health?.mode === 'forward' ? (
          <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 3, background: 'var(--tn-yellow, #e0af68)', color: '#1a1b26' }}>
            FORWARD → {health.forwardUrl}
          </span>
        ) : health?.mode === 'native' ? (
          <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 3, background: 'var(--tn-green, #9ece6a)', color: '#1a1b26' }}>
            NATIVE
          </span>
        ) : null}
        <span style={{ flex: 1 }} />
        <div style={{ display: 'flex', gap: 4 }}>
          {(['screenshots', 'audit', 'journey'] as Tab[]).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              style={{
                ...btnStyle,
                background: activeTab === tab ? 'var(--tn-blue, #7aa2f7)' : 'var(--tn-surface, #292e42)',
                color: activeTab === tab ? '#1a1b26' : 'var(--tn-text, #c0caf5)',
              }}
            >
              {tab === 'screenshots' ? 'Screenshots' : tab === 'audit' ? 'Audit-Chat' : 'Journey'}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      {activeTab === 'screenshots' && (
        <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
          {loading ? (
            <div style={{ color: 'var(--tn-text-muted)' }}>Lade Partner-Matrix...</div>
          ) : error ? (
            <div style={{ color: 'var(--tn-red, #f7768e)' }}>
              Fehler: {error}
              <button onClick={fetchMatrix} style={btnStyle}>Retry</button>
            </div>
          ) : data ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <span style={{ fontSize: 11, color: 'var(--tn-text-muted, #a9b1d6)' }}>{data.baseUrl}</span>
                <span style={{ flex: 1 }} />
                <button onClick={fetchMatrix} style={btnStyle} disabled={bulkRunning}>↻ Refresh</button>
                <button onClick={() => runAll(true)} style={btnStyle} disabled={bulkRunning} title="Nur Cells ohne erfolgreichen Screenshot">
                  {bulkRunning ? '...' : '▶ Capture Missing'}
                </button>
                <button onClick={() => runAll(false)} style={{ ...btnStyle, background: 'var(--tn-blue, #7aa2f7)', color: '#1a1b26' }} disabled={bulkRunning}>
                  {bulkRunning ? '... Running' : '▶ Capture All'}
                </button>
              </div>

              <div style={{ fontSize: 11, color: 'var(--tn-text-muted, #a9b1d6)', marginBottom: 12 }}>
                Klick auf eine Zelle = Screenshot generieren. Klick auf den Screenshot = Vollbild.
              </div>

              {Array.from(grouped.entries()).map(([userId, cells]) => (
                <div key={userId} style={{ marginBottom: 24 }}>
                  <div style={{ fontWeight: 600, marginBottom: 8, paddingBottom: 4, borderBottom: '1px solid var(--tn-border, #292e42)' }}>
                    {cells[0].userName} <span style={{ fontSize: 11, color: 'var(--tn-text-muted, #a9b1d6)' }}>· {cells[0].role} · {userId}</span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
                    {cells.map(c => {
                      const key = `${c.userId}__${c.workspace}`;
                      const isBusy = busy.has(key) || c.inFlight;
                      return (
                        <div key={key} style={{
                          border: '1px solid var(--tn-border, #292e42)',
                          borderRadius: 6,
                          background: 'var(--tn-bg-elevated, #1f2335)',
                          overflow: 'hidden',
                          display: 'flex',
                          flexDirection: 'column',
                        }}>
                          <div style={{ padding: '6px 10px', display: 'flex', alignItems: 'center', gap: 8, borderBottom: '1px solid var(--tn-border, #292e42)', fontSize: 12 }}>
                            <span style={{ fontWeight: 500 }}>{c.workspace}</span>
                            {c.status === 'success' && <span style={{ color: 'var(--tn-green, #9ece6a)', fontSize: 10 }}>✓ {c.durationMs ? `${(c.durationMs/1000).toFixed(1)}s` : ''}</span>}
                            {c.status === 'error' && <span style={{ color: 'var(--tn-red, #f7768e)', fontSize: 10 }} title={c.error || ''}>✗ error</span>}
                            <span style={{ flex: 1 }} />
                            <button onClick={() => triggerCapture(c)} style={miniBtnStyle} disabled={isBusy}>
                              {isBusy ? '...' : c.status ? 'Re-Capture' : 'Capture'}
                            </button>
                          </div>
                          <div
                            style={{
                              flex: 1, minHeight: 160, position: 'relative', background: '#0d0e16',
                              cursor: c.screenshotUrl ? 'zoom-in' : 'default',
                            }}
                            onClick={() => c.screenshotUrl && setZoom(c)}
                          >
                            {c.screenshotUrl ? (
                              <img
                                src={c.screenshotUrl}
                                alt={`${c.userId} ${c.workspace}`}
                                style={{ width: '100%', height: 'auto', display: 'block' }}
                              />
                            ) : (
                              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--tn-text-muted, #565f89)', fontSize: 12 }}>
                                {isBusy ? 'Capturing...' : 'No screenshot yet'}
                              </div>
                            )}
                          </div>
                          {c.capturedAt && (
                            <div style={{ padding: '4px 10px', fontSize: 10, color: 'var(--tn-text-muted, #565f89)', borderTop: '1px solid var(--tn-border, #292e42)' }}>
                              {new Date(c.capturedAt).toLocaleString('de-DE')}
                            </div>
                          )}
                          {c.status === 'error' && c.error && (
                            <div style={{ padding: '4px 10px', fontSize: 10, color: 'var(--tn-red, #f7768e)', borderTop: '1px solid var(--tn-border, #292e42)' }}>
                              {c.error.slice(0, 200)}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </>
          ) : null}
        </div>
      )}

      {activeTab === 'audit' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {/* Sub-header: data source + reset */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '6px 16px',
            borderBottom: '1px solid var(--tn-border, #292e42)', flexShrink: 0,
            fontSize: 11, color: 'var(--tn-text-muted, #a9b1d6)',
          }}>
            <span>Quelle:</span>
            {health?.mode === 'forward' ? (
              <span style={{ padding: '2px 6px', borderRadius: 3, background: 'var(--tn-yellow, #e0af68)', color: '#1a1b26', fontWeight: 500 }}>
                {health.forwardUrl?.replace(/^https?:\/\//, '') ?? 'partner'}
              </span>
            ) : (
              <span style={{ padding: '2px 6px', borderRadius: 3, background: 'var(--tn-green, #9ece6a)', color: '#1a1b26', fontWeight: 500 }}>
                local (dev-server)
              </span>
            )}
            <span style={{ flex: 1 }} />
            <span>{messages.length} Nachrichten</span>
            <button onClick={resetAudit} style={miniBtnStyle} disabled={sending || messages.length === 0}>
              Reset
            </button>
          </div>

          {/* Message list */}
          <div style={{ flex: 1, overflow: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
            {!auditLoaded && (
              <div style={{ color: 'var(--tn-text-muted, #a9b1d6)', fontSize: 12 }}>Lade Verlauf…</div>
            )}
            {auditLoaded && messages.length === 0 && (
              <div style={{ color: 'var(--tn-text-muted, #a9b1d6)', fontSize: 13 }}>
                Frag mich zur Partner-Aktivität. Beispiel: "Was haben die Partner heute gemacht?"
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} style={{
                alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                maxWidth: '85%',
                background: m.role === 'user' ? 'var(--tn-blue, #7aa2f7)' : 'var(--tn-bg-elevated, #1f2335)',
                color: m.role === 'user' ? '#1a1b26' : 'var(--tn-text, #c0caf5)',
                borderRadius: 8,
                padding: '8px 12px',
                fontSize: 13,
              }}>
                {m.role === 'assistant' ? (
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {m.content}
                  </ReactMarkdown>
                ) : (
                  m.content
                )}
              </div>
            ))}
            {sending && (
              <div style={{
                alignSelf: 'flex-start',
                background: 'var(--tn-bg-elevated, #1f2335)',
                borderRadius: 8,
                padding: '8px 12px',
                fontSize: 13,
                color: 'var(--tn-text-muted, #a9b1d6)',
              }}>
                ...
              </div>
            )}
            {auditError && (
              <div style={{ color: 'var(--tn-red, #f7768e)', fontSize: 12, padding: '4px 8px' }}>
                Fehler: {auditError}
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Input area */}
          <div style={{ display: 'flex', gap: 8, padding: 12, borderTop: '1px solid var(--tn-border, #292e42)', flexShrink: 0 }}>
            <input
              type="text"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
              placeholder="Frage zur Partner-Aktivität..."
              disabled={sending}
              style={{
                flex: 1,
                background: 'var(--tn-bg-elevated, #1f2335)',
                color: 'var(--tn-text, #c0caf5)',
                border: '1px solid var(--tn-border, #3b4261)',
                borderRadius: 6,
                padding: '6px 10px',
                fontSize: 13,
                outline: 'none',
              }}
            />
            <button
              onClick={sendMessage}
              disabled={sending || !input.trim()}
              style={{ ...btnStyle, background: 'var(--tn-blue, #7aa2f7)', color: '#1a1b26', minWidth: 64 }}
            >
              {sending ? '...' : 'Senden'}
            </button>
          </div>
        </div>
      )}

      {activeTab === 'journey' && (
        <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
          {loading ? (
            <div style={{ color: 'var(--tn-text-muted)' }}>Lade Partner-Matrix...</div>
          ) : !data ? (
            <div style={{ color: 'var(--tn-text-muted)' }}>Keine Daten</div>
          ) : (
            <>
              <div style={{ fontSize: 11, color: 'var(--tn-text-muted, #a9b1d6)', marginBottom: 12 }}>
                Klick auf "▶ Run Journey" startet einen Auto-Login + 4 Screenshots gegen die laufende App.
                Klick auf einen historischen Eintrag zeigt Markdown + Screenshots.
              </div>
              {journeyError && (
                <div style={{ color: 'var(--tn-red, #f7768e)', fontSize: 12, marginBottom: 12, padding: '6px 10px', background: 'rgba(247,118,142,0.1)', borderRadius: 4 }}>
                  Fehler: {journeyError}
                </div>
              )}
              {Array.from(grouped.entries()).map(([userId, cells]) => {
                const list = journeyByUser[userId] || [];
                return (
                  <div key={userId} style={{ marginBottom: 24 }}>
                    <div style={{ fontWeight: 600, marginBottom: 8, paddingBottom: 4, borderBottom: '1px solid var(--tn-border, #292e42)' }}>
                      {cells[0].userName} <span style={{ fontSize: 11, color: 'var(--tn-text-muted, #a9b1d6)' }}>· {cells[0].role} · {userId}</span>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
                      {cells.map(c => {
                        const key = `${c.userId}__${c.workspace}`;
                        const isBusy = journeyBusy.has(key);
                        const supported = !!WORKSPACE_TO_APP[c.workspace];
                        const wsList = list.filter(j => j.workspace === c.workspace);
                        const last = wsList[0];
                        return (
                          <div key={key} style={{
                            border: '1px solid var(--tn-border, #292e42)',
                            borderRadius: 6,
                            background: 'var(--tn-bg-elevated, #1f2335)',
                            display: 'flex',
                            flexDirection: 'column',
                          }}>
                            <div style={{ padding: '6px 10px', display: 'flex', alignItems: 'center', gap: 8, borderBottom: '1px solid var(--tn-border, #292e42)', fontSize: 12 }}>
                              <span style={{ fontWeight: 500 }}>{c.workspace}</span>
                              {!supported && <span style={{ fontSize: 10, color: 'var(--tn-text-muted, #565f89)' }}>(no journey)</span>}
                              {last && last.loginSuccess === true && (
                                <span style={{ fontSize: 10, color: 'var(--tn-green, #9ece6a)' }}>✓ login</span>
                              )}
                              {last && last.loginSuccess === false && (
                                <span style={{ fontSize: 10, color: 'var(--tn-red, #f7768e)' }} title={last.failureReason || 'Login fehlgeschlagen'}>✗ login fail</span>
                              )}
                              {last && last.loginSuccess === null && (
                                <span style={{ fontSize: 10, color: 'var(--tn-text-muted, #565f89)' }} title="Vor failure-detection — Status unbekannt">? unknown</span>
                              )}
                              <span style={{ flex: 1 }} />
                              <button
                                onClick={() => runJourney(c.userId, c.workspace)}
                                style={miniBtnStyle}
                                disabled={isBusy || !supported}
                                title={supported ? 'Run journey' : 'Workspace nicht gemappt'}
                              >
                                {isBusy ? '...' : '▶ Run Journey'}
                              </button>
                            </div>
                            <div style={{ padding: '8px 10px', fontSize: 11, color: 'var(--tn-text-muted, #a9b1d6)' }}>
                              {wsList.length === 0 ? (
                                <span>Noch keine Journey</span>
                              ) : (
                                <>
                                  <div style={{ marginBottom: 4 }}>
                                    Letzte: {new Date(last.capturedAt).toLocaleString('de-DE')} · {last.screenshotCount} Screenshots
                                  </div>
                                  {last.loginSuccess === false && last.failureReason && (
                                    <div style={{ marginBottom: 6, padding: '4px 6px', background: 'rgba(247,118,142,0.1)', color: 'var(--tn-red, #f7768e)', borderRadius: 3, fontSize: 10 }}>
                                      ❌ {last.failureReason}
                                    </div>
                                  )}
                                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                                    {wsList.slice(0, 5).map(j => {
                                      const icon = j.loginSuccess === true ? '✓'
                                        : j.loginSuccess === false ? '✗'
                                        : '?';
                                      const color = j.loginSuccess === true ? 'var(--tn-green, #9ece6a)'
                                        : j.loginSuccess === false ? 'var(--tn-red, #f7768e)'
                                        : 'var(--tn-text-muted, #565f89)';
                                      return (
                                        <button
                                          key={j.journeyId}
                                          onClick={() => openJourneyDetail(j.userId, j.workspace, j.journeyId)}
                                          style={{
                                            ...miniBtnStyle,
                                            textAlign: 'left',
                                            fontSize: 10,
                                            padding: '2px 6px',
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: 6,
                                          }}
                                          title={j.failureReason || ''}
                                        >
                                          <span style={{ color }}>{icon}</span>
                                          <span>{j.journeyId} ({j.screenshotCount} 📸)</span>
                                        </button>
                                      );
                                    })}
                                  </div>
                                </>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </div>
      )}

      {/* Journey detail modal */}
      {journeyDetail && (
        <div
          onClick={() => setJourneyDetail(null)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 9999,
            display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'zoom-out',
            padding: 20,
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: 'var(--tn-bg, #1a1b26)',
              border: '1px solid var(--tn-border, #292e42)',
              borderRadius: 8,
              maxWidth: '90%',
              maxHeight: '90%',
              width: 1100,
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
              cursor: 'default',
            }}
          >
            <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--tn-border, #292e42)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontWeight: 600, color: 'var(--tn-text, #c0caf5)' }}>
                Journey: {journeyDetail.userId} · {journeyDetail.workspace} · {journeyDetail.journeyId}
              </span>
              <span style={{ flex: 1 }} />
              <button onClick={() => setJourneyDetail(null)} style={miniBtnStyle}>Close</button>
            </div>
            <div style={{ flex: 1, overflow: 'auto', padding: 16, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <div style={{ color: 'var(--tn-text, #c0caf5)', fontSize: 12, lineHeight: 1.6 }}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {journeyDetail.data.markdown}
                </ReactMarkdown>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {journeyDetail.data.screenshots.map(s => (
                  <div key={s.name} style={{ border: '1px solid var(--tn-border, #292e42)', borderRadius: 4, overflow: 'hidden' }}>
                    <div style={{ padding: '4px 8px', fontSize: 10, color: 'var(--tn-text-muted, #a9b1d6)', background: 'var(--tn-bg-elevated, #1f2335)' }}>
                      {s.name}
                    </div>
                    <img src={s.url} alt={s.name} style={{ width: '100%', display: 'block' }} />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {zoom && zoom.screenshotUrl && (
        <div
          onClick={() => setZoom(null)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 9999,
            display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'zoom-out',
          }}
        >
          <div style={{ position: 'absolute', top: 16, left: 16, color: '#fff', fontSize: 14 }}>
            {zoom.userName} · {zoom.workspace}
            {zoom.capturedAt && <span style={{ marginLeft: 12, fontSize: 11, opacity: 0.7 }}>{new Date(zoom.capturedAt).toLocaleString('de-DE')}</span>}
          </div>
          <img src={zoom.screenshotUrl} alt="" style={{ maxWidth: '95%', maxHeight: '95%', boxShadow: '0 4px 32px rgba(0,0,0,0.6)' }} />
        </div>
      )}
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  padding: '4px 10px',
  fontSize: 12,
  background: 'var(--tn-surface, #292e42)',
  color: 'var(--tn-text, #c0caf5)',
  border: '1px solid var(--tn-border, #3b4261)',
  borderRadius: 4,
  cursor: 'pointer',
};
const miniBtnStyle: React.CSSProperties = {
  ...btnStyle,
  padding: '2px 8px',
  fontSize: 11,
};
