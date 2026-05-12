// SandboxAngelPanel — Multi-conversation chat panel backed by the agent-sandbox daemon.
//
// Each panel holds many independent threads. Switcher in the header lets the
// user jump between them, archive old ones, or start a new one. Active
// conversation's full Claude Code history is replayed on switch.
//
// Endpoints (all rooted at /api/sandbox-angel/${mode}):
//   POST /start                          — open or resume the sandbox session
//   POST /exec                           — run a turn against conversationId
//   POST /stop                           — stop on unmount
//   GET  /stream                         — SSE for assistant deltas + status
//   GET  /conversations                  — list { active, conversations[] }
//   POST /conversation/new               — body { sid, title? } → returns conv
//   POST /conversation/switch            — body { sid, conversationId }
//   POST /conversation/archive           — body { sid, conversationId }
//   GET  /history?conversationId=        — replay turns of one conversation

import { useState, useEffect, useRef, useCallback } from 'react';
import { Send, Loader2, Bot, Plus, ChevronDown, Archive } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface Msg {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

interface Session {
  sid: string;
  token: string;
}

interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  lastActivityAt: string;
  messageCount: number;
  archived: boolean;
}

type Status = 'idle' | 'starting' | 'ready' | 'running' | 'error';

interface Props {
  mode: 'private' | 'business';
}

const CAPABILITIES_BLOCK =
  '## Was ich kann\n' +
  '- **Files durchsuchen** im gemounteten Workspace (Glob/Grep/Read)\n' +
  '- **Inhalte aus vielen Files extrahieren** via `bridge-summarize` — schickt ganze Files an einen frischen Claude mit großem Context und kriegt eine fokussierte Zusammenfassung zurück. **Besser** als selber alle Files lesen weil mein Context-Window klein bleibt und der Bridge-Claude alles voll überblickt.\n' +
  '- **Web-Recherchen** via `bridge-research` — WebSearch + WebFetch durch die Bridge\n' +
  '- **Editieren** in erlaubten Ordnern (Schreibrechte siehe unten)\n\n' +
  '## Vorgehen\n' +
  'Erst klären worum es geht → Recherche-Phase (lokal/Web/Mix entscheide ich) → dann Arbeit.';

const LABELS: Record<Props['mode'], { title: string; welcome: string }> = {
  private: {
    title: 'Privat-Assistent',
    welcome:
      'Hi Rafael — ich bin dein **Privat-Assistent**.\n\n' +
      '## Daten die ich kenne (`/work/sources/`)\n' +
      '- `rafael-*.md` — dein kuratiertes Persönlichkeitsprofil — **read-only**\n' +
      '- `tagebuch/YYYY-MM/` — Tagebuch-Verlauf, lese- und schreibbar\n' +
      '- `inbox/`, `kalender-*.md`, `acro-festivals-*.md` — Notizen & Planung\n\n' +
      CAPABILITIES_BLOCK +
      '\n\nWorum gehts?',
  },
  business: {
    title: 'Business-Assistent',
    welcome:
      'Hi Rafael — ich bin dein **Business-Assistent**.\n\n' +
      '## Daten die ich kenne (`/work/sources/`)\n' +
      '- `shared/strategy/`, `finance/` — **read-only**\n' +
      '- `marketing/`, `sales/`, `customer-success/`, `products/`, `foerderung/`, `team/`, `drafts/`, `inbox/` — lese- und schreibbar\n\n' +
      CAPABILITIES_BLOCK +
      '\n\nWorum gehts?',
  },
};

const S = {
  root: { display: 'flex', flexDirection: 'column' as const, height: '100%', background: 'var(--tn-surface, #1a1b26)', color: 'var(--tn-text, #c0caf5)', overflow: 'hidden' },
  header: { padding: '6px 10px 5px', borderBottom: '1px solid var(--tn-border, #414868)', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, fontSize: 12 },
  headerTitle: { fontWeight: 600 as const, fontSize: 12, color: 'var(--tn-text)', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 },
  headerSub: { fontWeight: 400 as const, fontSize: 10, color: 'var(--tn-text-muted, #565f89)' },
  convSwitcher: { flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 4, position: 'relative' as const },
  convButton: { background: 'var(--tn-surface2, #24283b)', color: 'var(--tn-text)', border: '1px solid var(--tn-border, #414868)', borderRadius: 6, padding: '3px 6px 3px 8px', fontSize: 11, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, flex: 1, minWidth: 0, maxWidth: '100%' },
  convTitle: { flex: 1, textAlign: 'left' as const, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  iconBtn: { background: 'var(--tn-surface2, #24283b)', color: 'var(--tn-text-muted)', border: '1px solid var(--tn-border, #414868)', borderRadius: 6, padding: '3px 5px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  dropdown: { position: 'absolute' as const, top: 'calc(100% + 4px)', left: 0, right: 0, background: 'var(--tn-bg-dark, #16161e)', border: '1px solid var(--tn-border, #414868)', borderRadius: 6, boxShadow: '0 4px 16px rgba(0,0,0,0.4)', zIndex: 50, maxHeight: 280, overflowY: 'auto' as const },
  dropdownItem: { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', cursor: 'pointer', fontSize: 11, borderBottom: '1px solid rgba(255,255,255,0.04)' },
  dropdownItemActive: { background: 'var(--tn-accent, #7aa2f7)', color: '#fff' },
  dropdownItemTitle: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  dropdownItemMeta: { fontSize: 9, color: 'var(--tn-text-muted)', flexShrink: 0 },
  dropdownArchive: { padding: '2px 4px', cursor: 'pointer', opacity: 0.4, color: 'var(--tn-text-muted)' },
  messages: { flex: 1, overflowY: 'auto' as const, padding: '14px 16px', display: 'flex', flexDirection: 'column' as const, gap: 10 },
  msgUser: { alignSelf: 'flex-end' as const, background: 'var(--tn-accent, #7aa2f7)', color: '#fff', borderRadius: 12, borderBottomRightRadius: 4, padding: '8px 12px', maxWidth: '80%', fontSize: 13, whiteSpace: 'pre-wrap' as const, wordBreak: 'break-word' as const },
  msgAssistant: { alignSelf: 'flex-start' as const, background: 'var(--tn-surface2, #24283b)', color: 'var(--tn-text, #c0caf5)', borderRadius: 12, borderBottomLeftRadius: 4, padding: '8px 12px', maxWidth: '85%', fontSize: 13, whiteSpace: 'pre-wrap' as const, wordBreak: 'break-word' as const },
  statusMsg: { alignSelf: 'flex-start' as const, display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--tn-text-muted, #565f89)', padding: '6px 0' },
  error: { padding: '6px 16px', fontSize: 12, color: '#f7768e', background: 'rgba(247,118,142,0.08)', borderTop: '1px solid rgba(247,118,142,0.2)', flexShrink: 0 },
  inputArea: { display: 'flex', gap: 8, padding: '10px 16px', borderTop: '1px solid var(--tn-border, #414868)', flexShrink: 0 },
  textarea: { flex: 1, background: 'var(--tn-surface2, #24283b)', color: 'var(--tn-text, #c0caf5)', border: '1px solid var(--tn-border, #414868)', borderRadius: 8, padding: '8px 12px', fontSize: 13, resize: 'none' as const, fontFamily: 'inherit', outline: 'none' },
  btn: { background: 'var(--tn-accent, #7aa2f7)', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, flexShrink: 0 },
  markdown: { lineHeight: 1.5 } as React.CSSProperties,
} as const;

const welcomeMsg = (mode: Props['mode']): Msg => ({ id: 'welcome', role: 'assistant', content: LABELS[mode].welcome });

export default function SandboxAngelPanel({ mode }: Props) {
  const endpoint = `/api/sandbox-angel/${mode}`;
  const label = LABELS[mode];

  const [messages, setMessages] = useState<Msg[]>([welcomeMsg(mode)]);
  const [input, setInput] = useState('');
  const [session, setSession] = useState<Session | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [statusText, setStatusText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<Session | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => { sessionRef.current = session; }, [session]);

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!dropdownOpen) return;
    const onClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) setDropdownOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [dropdownOpen]);

  const fetchConversations = useCallback(async (sess: Session): Promise<{ active: string | null; conversations: Conversation[] }> => {
    const r = await fetch(`${endpoint}/conversations?sid=${encodeURIComponent(sess.sid)}&t=${encodeURIComponent(sess.token)}`);
    if (!r.ok) throw new Error(`conversations ${r.status}`);
    return r.json();
  }, [endpoint]);

  const fetchHistory = useCallback(async (sess: Session, convId?: string): Promise<Msg[]> => {
    const url = new URL(`${endpoint}/history`, window.location.origin);
    url.searchParams.set('sid', sess.sid);
    url.searchParams.set('t', sess.token);
    if (convId) url.searchParams.set('conversationId', convId);
    const r = await fetch(url.toString());
    if (!r.ok) throw new Error(`history ${r.status}`);
    const { messages: hist } = await r.json() as { messages: Array<{ role: 'user' | 'assistant'; text: string }> };
    return hist.map((m, i) => ({ id: `h-${i}-${Date.now()}`, role: m.role, content: m.text }));
  }, [endpoint]);

  // Start session on mount + load conversation list + history of active conv.
  useEffect(() => {
    let cancelled = false;
    setStatus('starting');

    (async () => {
      try {
        const startRes = await fetch(`${endpoint}/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ resourceId: 'main' }),
        });
        if (!startRes.ok) throw new Error(`start ${startRes.status}: ${await startRes.text()}`);
        const startData = await startRes.json() as { sid: string; token: string; resumed?: boolean };
        if (cancelled) return;
        const sess: Session = { sid: startData.sid, token: startData.token };
        setSession(sess);

        const { active, conversations: convs } = await fetchConversations(sess);
        if (cancelled) return;
        setConversations(convs);
        setActiveConvId(active);

        if (active) {
          const hist = await fetchHistory(sess, active);
          if (cancelled) return;
          setMessages(hist.length > 0 ? hist : [welcomeMsg(mode)]);
        } else {
          setMessages([welcomeMsg(mode)]);
        }
        setStatus('ready');
      } catch (e: unknown) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setStatus('error');
      }
    })();

    return () => { cancelled = true; };
  }, [endpoint, mode, fetchConversations, fetchHistory]);

  // SSE stream
  useEffect(() => {
    if (!session) return;
    const url = `${endpoint}/stream?sid=${encodeURIComponent(session.sid)}&t=${encodeURIComponent(session.token)}`;
    const es = new EventSource(url, { withCredentials: true });

    es.addEventListener('chat', (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as { role?: string; text?: string };
        if (data.role === 'assistant' && data.text) {
          setMessages(prev => [...prev, {
            id: `a-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            role: 'assistant',
            content: data.text!,
          }]);
          setStatus('ready');
          setStatusText(null);
        }
      } catch { /* ignore */ }
    });

    es.addEventListener('status', (ev) => {
      try {
        const d = JSON.parse((ev as MessageEvent).data) as { phase?: string; text?: string };
        if (d.phase === 'running') {
          setStatus('running');
          setStatusText(d.text ?? 'Arbeite…');
        } else if (d.phase === 'idle' || d.phase === 'result') {
          setStatus('ready');
          setStatusText(null);
        }
      } catch { /* ignore */ }
    });

    return () => { es.close(); };
  }, [session, endpoint]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      const s = sessionRef.current;
      if (!s) return;
      fetch(`${endpoint}/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Sandbox-Token': s.token },
        body: JSON.stringify({ sid: s.sid }),
        keepalive: true,
      }).catch(() => {});
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, statusText]);

  // Refresh conversation metadata (title, lastActivity, messageCount) after
  // each turn so the switcher list stays in sync.
  const refreshConvs = useCallback(async () => {
    const s = sessionRef.current; if (!s) return;
    try {
      const { conversations: convs, active } = await fetchConversations(s);
      setConversations(convs);
      if (active) setActiveConvId(active);
    } catch { /* ignore */ }
  }, [fetchConversations]);

  const callExec = useCallback(async (sess: Session, prompt: string, convId: string | null): Promise<Response> => {
    return fetch(`${endpoint}/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sandbox-Token': sess.token },
      body: JSON.stringify({ sid: sess.sid, t: sess.token, prompt, conversationId: convId ?? undefined }),
    });
  }, [endpoint]);

  const restart = useCallback(async (): Promise<Session> => {
    const res = await fetch(`${endpoint}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resourceId: 'main' }),
    });
    if (!res.ok) throw new Error(`restart ${res.status}: ${await res.text()}`);
    const data = await res.json() as { sid: string; token: string };
    const next = { sid: data.sid, token: data.token };
    setSession(next);
    return next;
  }, [endpoint]);

  const send = useCallback(async () => {
    const prompt = input.trim();
    if (!prompt || !session || status !== 'ready') return;

    setMessages(prev => [...prev, { id: `u-${Date.now()}`, role: 'user', content: prompt }]);
    setInput('');
    setStatus('running');
    setStatusText('Sende…');

    try {
      let res = await callExec(session, prompt, activeConvId);
      if (res.status === 404) {
        setStatusText('Session abgelaufen — starte neu…');
        const fresh = await restart();
        res = await callExec(fresh, prompt, activeConvId);
      }
      if (!res.ok) throw new Error(`exec ${res.status}: ${await res.text()}`);
      const data = await res.json() as { conversationId?: string };
      if (data.conversationId && data.conversationId !== activeConvId) {
        setActiveConvId(data.conversationId);
      }
      // Re-fetch conv list shortly after — the daemon updates messageCount + title async.
      setTimeout(() => { void refreshConvs(); }, 3000);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setMessages(prev => [...prev, { id: `err-${Date.now()}`, role: 'assistant', content: `Fehler: ${msg}` }]);
      setStatus('ready');
      setStatusText(null);
    }
  }, [input, session, status, callExec, restart, activeConvId, refreshConvs]);

  const switchConv = useCallback(async (id: string) => {
    const s = sessionRef.current; if (!s) return;
    setDropdownOpen(false);
    setMessages([welcomeMsg(mode)]);
    try {
      await fetch(`${endpoint}/conversation/switch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Sandbox-Token': s.token },
        body: JSON.stringify({ sid: s.sid, conversationId: id }),
      });
      setActiveConvId(id);
      const hist = await fetchHistory(s, id);
      setMessages(hist.length > 0 ? hist : [welcomeMsg(mode)]);
      void refreshConvs();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [endpoint, mode, fetchHistory, refreshConvs]);

  const newConv = useCallback(async () => {
    const s = sessionRef.current; if (!s) return;
    setDropdownOpen(false);
    try {
      const r = await fetch(`${endpoint}/conversation/new`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Sandbox-Token': s.token },
        body: JSON.stringify({ sid: s.sid }),
      });
      if (!r.ok) throw new Error(`new ${r.status}`);
      const conv = await r.json() as Conversation;
      setActiveConvId(conv.id);
      setMessages([welcomeMsg(mode)]);
      void refreshConvs();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [endpoint, mode, refreshConvs]);

  const archiveConv = useCallback(async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const s = sessionRef.current; if (!s) return;
    try {
      await fetch(`${endpoint}/conversation/archive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Sandbox-Token': s.token },
        body: JSON.stringify({ sid: s.sid, conversationId: id }),
      });
      // Refresh — if we archived the active conv, daemon picks a new active.
      const { conversations: convs, active } = await fetchConversations(s);
      setConversations(convs);
      setActiveConvId(active);
      if (id === activeConvId) {
        if (active) {
          const hist = await fetchHistory(s, active);
          setMessages(hist.length > 0 ? hist : [welcomeMsg(mode)]);
        } else {
          setMessages([welcomeMsg(mode)]);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [endpoint, mode, fetchConversations, fetchHistory, activeConvId]);

  const onKey = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
  }, [send]);

  const isDisabled = status !== 'ready';
  const activeConv = conversations.find((c) => c.id === activeConvId);
  const activeTitle = activeConv?.title ?? (status === 'starting' ? 'lade…' : 'Neue Konversation');

  return (
    <div style={S.root}>
      <div style={S.header}>
        <div style={S.headerTitle}>
          <Bot size={13} />
          {label.title}
        </div>
        <div style={S.convSwitcher} ref={dropdownRef}>
          <button
            style={S.convButton}
            onClick={() => setDropdownOpen((v) => !v)}
            title="Konversation wechseln"
          >
            <span style={S.convTitle}>{activeTitle}</span>
            <ChevronDown size={11} />
          </button>
          <button style={S.iconBtn} onClick={() => void newConv()} title="Neue Konversation">
            <Plus size={12} />
          </button>
          {dropdownOpen && (
            <div style={S.dropdown}>
              {conversations.length === 0 && (
                <div style={{ ...S.dropdownItem, color: 'var(--tn-text-muted)', cursor: 'default' }}>
                  Noch keine Konversationen
                </div>
              )}
              {conversations
                .slice()
                .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
                .map((c) => (
                  <div
                    key={c.id}
                    style={c.id === activeConvId ? { ...S.dropdownItem, ...S.dropdownItemActive } : S.dropdownItem}
                    onClick={() => void switchConv(c.id)}
                  >
                    <span style={S.dropdownItemTitle}>{c.title}</span>
                    <span style={S.dropdownItemMeta}>{c.messageCount} msg</span>
                    <span
                      style={S.dropdownArchive}
                      onClick={(e) => void archiveConv(c.id, e)}
                      title="Archivieren"
                    >
                      <Archive size={11} />
                    </span>
                  </div>
                ))}
            </div>
          )}
        </div>
        {status === 'starting' && <span style={S.headerSub}>starte…</span>}
        {status === 'error' && <span style={{ ...S.headerSub, color: '#f7768e' }}>Fehler</span>}
        {status === 'running' && <span style={S.headerSub}>läuft</span>}
      </div>

      <div style={S.messages}>
        {messages.map((m) => (
          <div key={m.id} style={m.role === 'user' ? S.msgUser : S.msgAssistant}>
            {m.role === 'user' ? (
              m.content
            ) : (
              <div style={S.markdown}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
              </div>
            )}
          </div>
        ))}

        {statusText && (
          <div style={S.statusMsg}>
            <Loader2 size={13} className="animate-spin" />
            {statusText}
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {error && <div style={S.error}>{error}</div>}

      <div style={S.inputArea}>
        <textarea
          style={{ ...S.textarea, opacity: isDisabled ? 0.6 : 1 }}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={onKey}
          placeholder={isDisabled ? 'Warte auf Session…' : 'Nachricht… (Enter = Senden)'}
          rows={2}
          disabled={isDisabled}
        />
        <button
          style={{ ...S.btn, opacity: isDisabled ? 0.5 : 1, cursor: isDisabled ? 'not-allowed' : 'pointer' }}
          onClick={() => void send()}
          disabled={isDisabled}
          title="Senden"
        >
          <Send size={15} />
        </button>
      </div>
    </div>
  );
}
