// SandboxAngelPanel — Chat panel backed by the agent-sandbox daemon.
//
// Replaces the FullContext-Bridge logic in PrivatAngelPanel / BusinessAngelPanel.
// Uses /api/sandbox-angel/:mode/{start,exec,stop,stream} as backend.
//
// SSE events expected from daemon:
//   event: chat   — { role: 'assistant', text: '...' }
//   event: status — { phase: 'running' | 'idle' | 'result', text?: string }

import { useState, useEffect, useRef, useCallback } from 'react';
import { Send, Loader2, Bot } from 'lucide-react';
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
      '- `rafael-*.md` — dein kuratiertes Persönlichkeitsprofil (Philosophie, Psychologie, Beziehungen, Training, Biohacking, Coaching, Sexualität, Personen-Map) — **read-only**\n' +
      '- `tagebuch/YYYY-MM/` — dein Tagebuch-Verlauf, lese- und schreibbar\n' +
      '- `inbox/` — Rohnotizen + Voice-Transkripte, lese- und schreibbar\n' +
      '- `kalender-*.md`, `acro-festivals-*.md`, `ashtanga-*` — Termin- und Trainingsplanung\n\n' +
      CAPABILITIES_BLOCK +
      '\n\nWorum gehts heute?',
  },
  business: {
    title: 'Business-Assistent',
    welcome:
      'Hi Rafael — ich bin dein **Business-Assistent**.\n\n' +
      '## Daten die ich kenne (`/work/sources/`)\n' +
      '- `shared/strategy/` — Vision, Businessplan, Strategy Insights — **read-only**\n' +
      '- `marketing/`, `sales/`, `customer-success/` — lesbar, Drafts schreibbar\n' +
      '- `finance/` — **read-only**\n' +
      '- `products/` — Engelmann, WerkING Energy/Safety/Report/Noise Konzepte\n' +
      '- `foerderung/` — FFG-Projektbeschreibungen, Gutachter-Reviews\n' +
      '- `team/`, `legal/`, `reports/` — internes Material\n' +
      '- `drafts/`, `inbox/` — schreibbare Arbeitsbereiche\n\n' +
      CAPABILITIES_BLOCK +
      '\n\nWorum gehts heute?',
  },
};

const S = {
  root: { display: 'flex', flexDirection: 'column' as const, height: '100%', background: 'var(--tn-surface, #1a1b26)', color: 'var(--tn-text, #c0caf5)', overflow: 'hidden' },
  header: { padding: '10px 16px', borderBottom: '1px solid var(--tn-border, #414868)', fontWeight: 600 as const, fontSize: 13, display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 },
  headerSub: { fontWeight: 400 as const, fontSize: 11, color: 'var(--tn-text-muted, #565f89)' },
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

export default function SandboxAngelPanel({ mode }: Props) {
  const endpoint = `/api/sandbox-angel/${mode}`;
  const label = LABELS[mode];

  const [messages, setMessages] = useState<Msg[]>([
    { id: 'welcome', role: 'assistant', content: label.welcome },
  ]);
  const [input, setInput] = useState('');
  const [session, setSession] = useState<Session | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [statusText, setStatusText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const bottomRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<Session | null>(null);

  // Keep ref in sync for cleanup
  useEffect(() => { sessionRef.current = session; }, [session]);

  // Start sandbox session on mount
  useEffect(() => {
    let cancelled = false;
    setStatus('starting');

    fetch(`${endpoint}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resourceId: 'main' }),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`start ${res.status}: ${await res.text()}`);
        return res.json() as Promise<{ sid: string; token: string; resumed?: boolean }>;
      })
      .then(async (data) => {
        if (cancelled) return;
        setSession({ sid: data.sid, token: data.token });
        setStatus('ready');
        if (!data.resumed) return;

        // Resumed session — pull the actual conversation history from disk so
        // the user sees what they discussed before, instead of just a stub
        // "Willkommen zurück" with empty chat.
        try {
          const r = await fetch(
            `${endpoint}/history?sid=${encodeURIComponent(data.sid)}&t=${encodeURIComponent(data.token)}`,
          );
          if (!r.ok) throw new Error(`history ${r.status}`);
          const { messages: hist } = await r.json() as { messages: Array<{ role: 'user' | 'assistant'; text: string }> };
          if (cancelled) return;
          if (hist.length === 0) {
            setMessages(prev => prev.map(m =>
              m.id === 'welcome' ? { ...m, content: 'Willkommen zurück — keine alten Nachrichten gefunden.' } : m,
            ));
            return;
          }
          setMessages(hist.map((m, i) => ({ id: `h-${i}`, role: m.role, content: m.text })));
        } catch {
          // Fallback: show stub welcome — better than nothing.
          setMessages(prev => prev.map(m =>
            m.id === 'welcome' ? { ...m, content: 'Willkommen zurück — wir machen weiter wo wir aufgehört haben.' } : m,
          ));
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setStatus('error');
      });

    return () => { cancelled = true; };
  }, [endpoint]);

  // SSE stream — reconnects whenever session changes
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
      } catch { /* ignore malformed events */ }
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

  // Best-effort stop on unmount — reads from ref to avoid stale closure
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
  // endpoint is stable (derived from mode prop which doesn't change)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-scroll on new messages / status updates
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, statusText]);

  const callExec = useCallback(async (sess: Session, prompt: string): Promise<Response> => {
    return fetch(`${endpoint}/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sandbox-Token': sess.token },
      body: JSON.stringify({ sid: sess.sid, t: sess.token, prompt }),
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

    setMessages(prev => [...prev, {
      id: `u-${Date.now()}`,
      role: 'user',
      content: prompt,
    }]);
    setInput('');
    setStatus('running');
    setStatusText('Sende…');

    try {
      let res = await callExec(session, prompt);
      if (res.status === 404) {
        // Container is gone (idle-killed). Resume session and retry once.
        setStatusText('Session abgelaufen — starte neu…');
        const fresh = await restart();
        res = await callExec(fresh, prompt);
      }
      if (!res.ok) throw new Error(`exec ${res.status}: ${await res.text()}`);
      // Response comes back via SSE stream
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setMessages(prev => [...prev, { id: `err-${Date.now()}`, role: 'assistant', content: `Fehler: ${msg}` }]);
      setStatus('ready');
      setStatusText(null);
    }
  }, [input, session, status, callExec, restart]);

  const onKey = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
  }, [send]);

  const isDisabled = status !== 'ready';

  return (
    <div style={S.root}>
      <div style={S.header}>
        <Bot size={15} />
        {label.title}
        {status === 'starting' && <span style={S.headerSub}> — starte Session…</span>}
        {status === 'error' && <span style={{ ...S.headerSub, color: '#f7768e' }}> — Fehler</span>}
        {status === 'running' && <span style={S.headerSub}> — läuft</span>}
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
          placeholder={isDisabled ? 'Warte auf Session…' : 'Nachricht eingeben… (Enter = Senden, Shift+Enter = Zeilenumbruch)'}
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
