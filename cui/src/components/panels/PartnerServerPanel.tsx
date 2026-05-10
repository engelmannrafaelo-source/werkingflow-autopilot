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
  rating: number | null;
  worksE2e: boolean | null;
  summary: string | null;
}

interface JourneyEvaluation {
  rating: number;
  works_e2e: boolean;
  summary: string;
  findings: string[];
  blockers: string[];
  model: string;
  evaluated_at: string;
}

interface JourneyDetail {
  markdown: string;
  screenshots: Array<{ name: string; url: string }>;
  evaluation: JourneyEvaluation | null;
  meta?: {
    subSessionId?: string | null;
    subSessionError?: string | null;
    subSessionAccount?: string;
  } | null;
}

interface JourneyChatMessage {
  role: 'user' | 'assistant' | 'system';
  text?: string;
  timestamp?: string | null;
}

function renderStars(rating: number | null): string {
  if (rating === null) return '';
  const full = Math.max(0, Math.min(5, Math.round(rating)));
  return '★'.repeat(full) + '☆'.repeat(5 - full);
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
  const [journeyBulkRunning, setJourneyBulkRunning] = useState(false);
  const [journeyBulkProgress, setJourneyBulkProgress] = useState<{ spawned: number; total: number; current?: string } | null>(null);
  // Detail-modal sub-tab + chat state (chat tab loads jsonl from sub-session)
  const [detailTab, setDetailTab] = useState<'screenshots' | 'chat'>('screenshots');
  const [chatMessages, setChatMessages] = useState<JourneyChatMessage[] | null>(null);
  const [chatError, setChatError] = useState<string | null>(null);
  const [chatLoading, setChatLoading] = useState(false);

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
    setDetailTab('screenshots');
    setChatMessages(null);
    setChatError(null);
    try {
      const r = await fetch(`${API}/journey/${encodeURIComponent(userId)}/${encodeURIComponent(workspace)}/${encodeURIComponent(journeyId)}`);
      if (!r.ok) throw new Error(`detail ${r.status}`);
      const data: JourneyDetail = await r.json();
      setJourneyDetail({ userId, workspace, journeyId, data });
    } catch (e: any) {
      setJourneyError(`detail: ${e.message}`);
    }
  }, []);

  const loadJourneyChat = useCallback(async (userId: string, workspace: string, journeyId: string) => {
    setChatLoading(true);
    setChatError(null);
    setChatMessages(null);
    try {
      const r = await fetch(`${API}/journey/${encodeURIComponent(userId)}/${encodeURIComponent(workspace)}/${encodeURIComponent(journeyId)}/chat`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `chat ${r.status}`);
      // jsonl-Schema von readConversationMessages: {message: {role, content}, timestamp}
      // Tolerant gegen flat-shape (m.role direkt) und nested (m.message.role).
      const raw = Array.isArray(j.messages) ? j.messages : [];
      const norm: JourneyChatMessage[] = raw.map((m: any) => {
        const inner = m.message && typeof m.message === 'object' ? m.message : m;
        const role: 'user' | 'assistant' | 'system' =
          inner.role === 'assistant' ? 'assistant' : inner.role === 'user' ? 'user' : 'system';
        let text = '';
        const content = inner.content;
        if (typeof content === 'string') text = content;
        else if (Array.isArray(content)) {
          text = content
            .map((b: any) =>
              typeof b === 'string' ? b
              : b?.type === 'text' ? (b.text || '')
              : b?.type === 'tool_use' ? `🛠 ${b.name}(${JSON.stringify(b.input || {}).slice(0, 200)})`
              : b?.type === 'tool_result' ? `↩ ${typeof b.content === 'string' ? b.content.slice(0, 400) : '[tool result]'}`
              : ''
            ).filter(Boolean).join('\n');
        }
        return { role, text, timestamp: m.timestamp || null };
      }).filter((m: JourneyChatMessage) => m.text && m.text.trim().length > 0);
      setChatMessages(norm);
    } catch (e: any) {
      setChatError(e.message);
    } finally {
      setChatLoading(false);
    }
  }, []);

  // Auto-load chat when switching to chat tab
  useEffect(() => {
    if (detailTab === 'chat' && journeyDetail && chatMessages === null && !chatLoading) {
      loadJourneyChat(journeyDetail.userId, journeyDetail.workspace, journeyDetail.journeyId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailTab, journeyDetail]);

  const runAllJourneys = useCallback(async (userId?: string) => {
    if (journeyBulkRunning) return;
    setJourneyBulkRunning(true);
    setJourneyError(null);
    setJourneyBulkProgress({ spawned: 0, total: 0 });
    try {
      const r = await fetch(`${API}/journey/run-all`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(userId ? { userId } : {}),
      });
      if (!r.ok || !r.body) throw new Error(`run-all ${r.status}`);
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let spawned = 0, total = 0;
      const reloadedFor = new Set<string>();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const ln of lines) {
          if (!ln.trim()) continue;
          try {
            const j = JSON.parse(ln);
            if (j.done) {
              spawned = j.spawned ?? spawned;
              total = j.total ?? total;
            } else {
              total += 1;
              if (j.subSessionId) spawned += 1;
              setJourneyBulkProgress({ spawned, total, current: `${j.userId}/${j.workspace}` });
              if (!reloadedFor.has(j.userId)) {
                reloadedFor.add(j.userId);
                loadJourneyList(j.userId);
              }
            }
          } catch { /* ignore malformed line */ }
        }
      }
      // Final refresh of all touched users
      reloadedFor.forEach(uid => loadJourneyList(uid));
    } catch (e: any) {
      setJourneyError(`run-all: ${e.message}`);
    } finally {
      setJourneyBulkRunning(false);
    }
  }, [journeyBulkRunning, loadJourneyList]);

  const triggerEvaluate = useCallback(async (userId: string, workspace: string, journeyId: string) => {
    setJourneyError(null);
    try {
      const r = await fetch(`${API}/journey/${encodeURIComponent(userId)}/${encodeURIComponent(workspace)}/${encodeURIComponent(journeyId)}/evaluate`, { method: 'POST' });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || `evaluate ${r.status}`);
      // Reload modal data + list to pick up new evaluation
      await openJourneyDetail(userId, workspace, journeyId);
      await loadJourneyList(userId);
    } catch (e: any) {
      setJourneyError(`evaluate: ${e.message}`);
    }
  }, [loadJourneyList, openJourneyDetail]);

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
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
                <button
                  onClick={() => runAllJourneys()}
                  disabled={journeyBulkRunning}
                  style={{
                    ...btnStyle,
                    background: journeyBulkRunning ? 'var(--tn-bg-elevated, #1f2335)' : 'var(--tn-blue, #7aa2f7)',
                    color: journeyBulkRunning ? 'var(--tn-text-muted, #a9b1d6)' : '#1a1b26',
                    fontWeight: 600,
                  }}
                  title="Spawnt eine Sub-Session pro User × gemapptem Workspace, die selbstständig die App durchtestet"
                >
                  {journeyBulkRunning ? '⏳ Spawnt...' : '▶ Alle Journeys neu spawnen'}
                </button>
                {journeyBulkProgress && (
                  <span style={{ fontSize: 11, color: 'var(--tn-text-muted, #a9b1d6)' }}>
                    {journeyBulkProgress.spawned}/{journeyBulkProgress.total} spawned
                    {journeyBulkProgress.current && ` · zuletzt: ${journeyBulkProgress.current}`}
                  </span>
                )}
              </div>
              {(() => {
                let works = 0, broken = 0, loginOk = 0, fail = 0, none = 0;
                for (const [, cells] of grouped.entries()) {
                  for (const c of cells) {
                    if (!WORKSPACE_TO_APP[c.workspace]) continue;
                    const last = (journeyByUser[c.userId] || []).filter(j => j.workspace === c.workspace)[0];
                    if (!last) { none++; continue; }
                    if (last.loginSuccess === false) { fail++; continue; }
                    if (last.worksE2e === true) { works++; continue; }
                    if (last.worksE2e === false) { broken++; continue; }
                    if (last.loginSuccess === true) { loginOk++; continue; }
                    none++;
                  }
                }
                const total = works + broken + loginOk + fail + none;
                return total > 0 ? (
                  <div style={{ display: 'flex', gap: 8, marginBottom: 12, fontSize: 11, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ color: 'var(--tn-text-muted)' }}>Gesamt-Status:</span>
                    {works > 0 && <span style={{ padding: '2px 8px', borderRadius: 4, background: 'var(--tn-green, #9ece6a)', color: '#1a1b26', fontWeight: 600 }}>🟢 {works} works</span>}
                    {broken > 0 && <span style={{ padding: '2px 8px', borderRadius: 4, background: 'var(--tn-red, #f7768e)', color: '#fff', fontWeight: 600 }}>🔴 {broken} broken</span>}
                    {loginOk > 0 && <span style={{ padding: '2px 8px', borderRadius: 4, background: 'var(--tn-yellow, #e0af68)', color: '#1a1b26', fontWeight: 600 }}>🟡 {loginOk} login-only</span>}
                    {fail > 0 && <span style={{ padding: '2px 8px', borderRadius: 4, background: 'var(--tn-red, #f7768e)', color: '#fff', fontWeight: 600 }}>🔴 {fail} login fail</span>}
                    {none > 0 && <span style={{ padding: '2px 8px', borderRadius: 4, background: 'var(--tn-bg-elevated, #1f2335)', color: 'var(--tn-text-muted, #a9b1d6)', border: '1px solid var(--tn-border, #292e42)' }}>— {none} no run</span>}
                    <span style={{ color: 'var(--tn-text-muted)', marginLeft: 4 }}>· {total} cells gesamt</span>
                  </div>
                ) : null;
              })()}
              <div style={{ fontSize: 11, color: 'var(--tn-text-muted, #a9b1d6)', marginBottom: 12 }}>
                "▶ Run Journey" pro Zelle spawnt eine Sub-Session, die wie ein neuer User die App durchklickt
                (Login → Sidebar → 3-5 Hauptaktionen). Rechts im Detail-Modal siehst du den Chat-Verlauf.
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
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, paddingBottom: 4, borderBottom: '1px solid var(--tn-border, #292e42)' }}>
                      <span style={{ fontWeight: 600 }}>
                        {cells[0].userName} <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--tn-text-muted, #a9b1d6)' }}>· {cells[0].role} · {userId}</span>
                      </span>
                      <span style={{ flex: 1 }} />
                      <button
                        onClick={() => runAllJourneys(userId)}
                        disabled={journeyBulkRunning}
                        style={{ ...miniBtnStyle, fontSize: 10 }}
                        title={`Spawnt eine Sub-Session pro Workspace von ${cells[0].userName}`}
                      >
                        ▶ Alle Journeys von {cells[0].userName.split(' ')[0]} spawnen
                      </button>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
                      {cells.map(c => {
                        const key = `${c.userId}__${c.workspace}`;
                        const isBusy = journeyBusy.has(key);
                        const supported = !!WORKSPACE_TO_APP[c.workspace];
                        const wsList = list.filter(j => j.workspace === c.workspace);
                        const last = wsList[0];
                        // Verdict logic: works_e2e=true → green WORKS;
                        //                works_e2e=false → red BROKEN;
                        //                login=true but no works verdict yet → yellow LOGIN;
                        //                login=false → red LOGIN FAIL;
                        //                no run yet → grey —
                        const verdict = !last
                            ? { label: '—', color: 'var(--tn-text-muted, #565f89)', bg: 'transparent', tooltip: 'Noch kein Run' }
                            : last.loginSuccess === false
                            ? { label: '🔴 LOGIN FAIL', color: '#fff', bg: 'var(--tn-red, #f7768e)', tooltip: last.failureReason || 'Login fehlgeschlagen' }
                            : last.worksE2e === true
                            ? { label: '🟢 WORKS', color: '#1a1b26', bg: 'var(--tn-green, #9ece6a)', tooltip: last.summary || 'Sub urteilt: works_e2e=true' }
                            : last.worksE2e === false
                            ? { label: '🔴 BROKEN', color: '#fff', bg: 'var(--tn-red, #f7768e)', tooltip: last.summary || 'Sub urteilt: works_e2e=false' }
                            : last.loginSuccess === true
                            ? { label: '🟡 LOGIN', color: '#1a1b26', bg: 'var(--tn-yellow, #e0af68)', tooltip: 'Login ok, Sub-Verdict steht aus' }
                            : { label: '? unknown', color: 'var(--tn-text-muted)', bg: 'transparent', tooltip: 'Status unbekannt (älterer Run)' };
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
                              <span
                                style={{
                                  fontSize: 10,
                                  padding: '2px 8px',
                                  borderRadius: 4,
                                  background: verdict.bg,
                                  color: verdict.color,
                                  fontWeight: 600,
                                  whiteSpace: 'nowrap',
                                }}
                                title={verdict.tooltip}
                              >
                                {verdict.label}
                              </span>
                              {last && last.rating !== null && (
                                <span
                                  style={{
                                    fontSize: 10,
                                    color: 'var(--tn-text-muted, #a9b1d6)',
                                    letterSpacing: 1,
                                  }}
                                  title={last.summary || ''}
                                >
                                  {renderStars(last.rating)}
                                </span>
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
                                          title={j.summary || j.failureReason || ''}
                                        >
                                          <span style={{ color }}>{icon}</span>
                                          <span>{j.journeyId} ({j.screenshotCount} 📸)</span>
                                          {j.rating !== null && (
                                            <span style={{ marginLeft: 'auto', color: j.worksE2e ? 'var(--tn-yellow, #e0af68)' : 'var(--tn-orange, #ff9e64)' }}>
                                              {renderStars(j.rating)}
                                            </span>
                                          )}
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
              <button
                onClick={() => setDetailTab('screenshots')}
                style={{
                  ...miniBtnStyle,
                  background: detailTab === 'screenshots' ? 'var(--tn-bg-elevated, #1f2335)' : 'transparent',
                  fontWeight: detailTab === 'screenshots' ? 600 : 400,
                }}
              >
                Screenshots
              </button>
              <button
                onClick={() => setDetailTab('chat')}
                style={{
                  ...miniBtnStyle,
                  background: detailTab === 'chat' ? 'var(--tn-bg-elevated, #1f2335)' : 'transparent',
                  fontWeight: detailTab === 'chat' ? 600 : 400,
                }}
                title={journeyDetail.data.meta?.subSessionId ? `Sub-Session ${journeyDetail.data.meta.subSessionId.slice(0, 8)}` : 'Keine Sub-Session für diese Journey'}
              >
                Chat-Verlauf {journeyDetail.data.meta?.subSessionId ? '✓' : ''}
              </button>
              <button onClick={() => setJourneyDetail(null)} style={miniBtnStyle}>Close</button>
            </div>
            <div style={{ flex: 1, overflow: 'auto', padding: 16, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <div style={{ color: 'var(--tn-text, #c0caf5)', fontSize: 12, lineHeight: 1.6 }}>
                {journeyDetail.data.evaluation && (
                  <div style={{
                    marginBottom: 16,
                    padding: 12,
                    background: 'var(--tn-bg-elevated, #1f2335)',
                    border: `1px solid ${journeyDetail.data.evaluation.works_e2e ? 'var(--tn-green, #9ece6a)' : 'var(--tn-orange, #ff9e64)'}`,
                    borderRadius: 6,
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                      <span style={{ fontWeight: 600, fontSize: 13 }}>KI-Bewertung</span>
                      <span style={{
                        fontSize: 16,
                        letterSpacing: 2,
                        color: journeyDetail.data.evaluation.works_e2e ? 'var(--tn-yellow, #e0af68)' : 'var(--tn-orange, #ff9e64)',
                      }}>
                        {renderStars(journeyDetail.data.evaluation.rating)}
                      </span>
                      <span style={{ fontSize: 10, color: 'var(--tn-text-muted, #a9b1d6)' }}>
                        ({journeyDetail.data.evaluation.rating}/5 · works_e2e: {String(journeyDetail.data.evaluation.works_e2e)})
                      </span>
                    </div>
                    <div style={{ fontSize: 12, marginBottom: 8 }}>{journeyDetail.data.evaluation.summary}</div>
                    {journeyDetail.data.evaluation.blockers.length > 0 && (
                      <div style={{ marginBottom: 6 }}>
                        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--tn-red, #f7768e)' }}>Blocker:</div>
                        <ul style={{ margin: '2px 0 0 20px', padding: 0, fontSize: 11, color: 'var(--tn-red, #f7768e)' }}>
                          {journeyDetail.data.evaluation.blockers.map((b, i) => <li key={i}>{b}</li>)}
                        </ul>
                      </div>
                    )}
                    {journeyDetail.data.evaluation.findings.length > 0 && (
                      <div>
                        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--tn-text-muted, #a9b1d6)' }}>Findings:</div>
                        <ul style={{ margin: '2px 0 0 20px', padding: 0, fontSize: 11, color: 'var(--tn-text-muted, #a9b1d6)' }}>
                          {journeyDetail.data.evaluation.findings.map((f, i) => <li key={i}>{f}</li>)}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
                {!journeyDetail.data.evaluation && (
                  <div style={{ marginBottom: 12, padding: '6px 10px', fontSize: 11, color: 'var(--tn-text-muted, #565f89)', background: 'rgba(86,95,137,0.1)', borderRadius: 4 }}>
                    Keine KI-Bewertung verfügbar (alte Journey oder Bridge-Fehler).{' '}
                    <button
                      onClick={() => triggerEvaluate(journeyDetail.userId, journeyDetail.workspace, journeyDetail.journeyId)}
                      style={{ ...miniBtnStyle, fontSize: 10, padding: '1px 6px' }}
                    >
                      Jetzt bewerten
                    </button>
                  </div>
                )}
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {journeyDetail.data.markdown}
                </ReactMarkdown>
              </div>
              {detailTab === 'screenshots' ? (
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
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12 }}>
                  {chatLoading && (
                    <div style={{ padding: 16, color: 'var(--tn-text-muted, #565f89)' }}>Lade Chat-Verlauf…</div>
                  )}
                  {chatError && (
                    <div style={{ padding: 12, background: 'rgba(247,118,142,0.1)', border: '1px solid var(--tn-red, #f7768e)', borderRadius: 4, color: 'var(--tn-red, #f7768e)' }}>
                      {chatError}
                    </div>
                  )}
                  {!chatLoading && !chatError && chatMessages !== null && chatMessages.length === 0 && (
                    <div style={{ padding: 16, color: 'var(--tn-text-muted, #565f89)' }}>
                      Keine Nachrichten in der Sub-Session — vielleicht noch nicht beantwortet?
                    </div>
                  )}
                  {chatMessages !== null && chatMessages.map((m, i) => (
                    <div
                      key={i}
                      style={{
                        padding: '8px 12px',
                        background: m.role === 'user'
                          ? 'rgba(86,95,137,0.15)'
                          : m.role === 'assistant'
                          ? 'rgba(125,207,255,0.1)'
                          : 'rgba(86,95,137,0.05)',
                        borderLeft: `3px solid ${m.role === 'user' ? 'var(--tn-text-muted, #a9b1d6)' : m.role === 'assistant' ? 'var(--tn-blue, #7dcfff)' : 'var(--tn-text-muted, #565f89)'}`,
                        borderRadius: 4,
                      }}
                    >
                      <div style={{ fontSize: 10, color: 'var(--tn-text-muted, #a9b1d6)', marginBottom: 4, fontWeight: 600 }}>
                        {m.role.toUpperCase()}
                        {m.timestamp && <span style={{ marginLeft: 8, fontWeight: 400 }}>{new Date(m.timestamp).toLocaleTimeString('de-DE')}</span>}
                      </div>
                      <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--tn-text, #c0caf5)' }}>
                        {m.text}
                      </div>
                    </div>
                  ))}
                </div>
              )}
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
