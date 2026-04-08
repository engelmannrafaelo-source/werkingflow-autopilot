/**
 * Business Angel Panel — Context-loaded AI session for business document editing.
 *
 * Workflow:
 * 1. Panel loads context info (kern token count, zusatz categories, temp files)
 * 2. Rafael selects zusatz categories via checkboxes
 * 3. "Session starten" → assembles full system prompt, starts CUI session
 * 4. After session, Rafael says "bau die Diffs" → AI outputs FILE/OLD/NEW blocks
 * 5. "Apply all" button applies the diffs to business docs
 */

import { useState, useEffect, useCallback, useRef } from 'react';

interface FileTokenInfo {
  path: string;
  exists: boolean;
  tokens: number;
}

interface KategorieInfo {
  files: FileTokenInfo[];
  totalTokens: number;
}

interface ContextData {
  kern_files: FileTokenInfo[];
  kern_tokens: number;
  zusatz_kategorien: Record<string, KategorieInfo>;
  temp_files: Array<{ name: string; tokens: number }>;
  temp_tokens: number;
  temp_dir: string;
}

interface LoadResult {
  session_id: string;
  token_count: number;
  files_loaded: number;
  temp_files: string[];
  zusatz_loaded: string[];
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface ApplyResult {
  ok: boolean;
  applied: string[];
  failed: Array<{ file: string; reason: string }>;
  backup_dir: string;
}

const KATEGORIE_LABELS: Record<string, string> = {
  kunden: 'Kunden (Engelmann, Teufel, Bacher, Sommer)',
  team: 'Team & Partner',
  legal: 'Legal & Verträge',
  foerderung: 'Förderung (FFG)',
  marketing: 'Marketing & Brand',
  produkte: 'Produkte & Specs',
};

function formatTokens(n: number): string {
  if (n >= 1000) return `~${(n / 1000).toFixed(1)}k`;
  return `~${n}`;
}

function tokenColor(n: number): string {
  if (n > 80000) return 'var(--tn-red, #f7768e)';
  if (n > 50000) return 'var(--tn-yellow, #e0af68)';
  return 'var(--tn-green, #9ece6a)';
}

export default function BusinessAngelPanel() {
  const [ctx, setCtx] = useState<ContextData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [selectedZusatz, setSelectedZusatz] = useState<Set<string>>(new Set());
  const [starting, setStarting] = useState(false);
  const [startResult, setStartResult] = useState<LoadResult | null>(null);
  const [startError, setStartError] = useState('');

  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatSending, setChatSending] = useState(false);
  const [chatError, setChatError] = useState('');
  const chatEndRef = useRef<HTMLDivElement>(null);

  const [rawDiffText, setRawDiffText] = useState('');
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<ApplyResult | null>(null);
  const [applyError, setApplyError] = useState('');

  const fetchContext = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const resp = await fetch('/api/business-angel/context');
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data: ContextData = await resp.json();
      setCtx(data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchContext(); }, [fetchContext]);

  // Auto-scroll chat to bottom on new messages
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  const sendMessage = async () => {
    if (!chatInput.trim() || !startResult || chatSending) return;
    const userMsg = chatInput.trim();
    setChatInput('');
    setChatSending(true);
    setChatError('');
    setChatMessages(prev => [...prev, { role: 'user', content: userMsg }]);
    try {
      const resp = await fetch('/api/business-angel/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: startResult.session_id, message: userMsg }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      const assistantMsg: ChatMessage = { role: 'assistant', content: data.response };
      setChatMessages(prev => [...prev, assistantMsg]);
      // Auto-populate diff textarea if response contains FILE/OLD/NEW blocks
      if (/^FILE:/m.test(data.response)) {
        setRawDiffText(data.response);
      }
    } catch (e: unknown) {
      setChatError(e instanceof Error ? e.message : String(e));
    } finally {
      setChatSending(false);
    }
  };

  const toggleZusatz = (key: string) => {
    setSelectedZusatz(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const totalTokens = (ctx?.kern_tokens ?? 0)
    + (ctx?.temp_tokens ?? 0)
    + [...selectedZusatz].reduce((sum, key) => sum + (ctx?.zusatz_kategorien[key]?.totalTokens ?? 0), 0);

  const startSession = async () => {
    setStarting(true);
    setStartError('');
    setStartResult(null);
    try {
      const resp = await fetch('/api/business-angel/load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ zusatz: [...selectedZusatz] }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      setStartResult(data as LoadResult);
    } catch (e: unknown) {
      setStartError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  };

  const applyDiffs = async () => {
    if (!rawDiffText.trim()) return;
    setApplying(true);
    setApplyError('');
    setApplyResult(null);
    try {
      const resp = await fetch('/api/business-angel/apply-diffs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw_text: rawDiffText }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      setApplyResult(data as ApplyResult);
    } catch (e: unknown) {
      setApplyError(e instanceof Error ? e.message : String(e));
    } finally {
      setApplying(false);
    }
  };

  const s: Record<string, React.CSSProperties> = {
    root: { padding: '16px', fontFamily: 'monospace', fontSize: '13px', color: 'var(--tn-text)', height: '100%', overflowY: 'auto' },
    h2: { margin: '0 0 12px', fontSize: '15px', color: 'var(--tn-purple, #bb9af7)', fontWeight: 600 },
    section: { marginBottom: '20px' },
    label: { color: 'var(--tn-text-muted)', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '8px' },
    checkbox: { display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 8px', cursor: 'pointer', borderRadius: '4px', userSelect: 'none', marginBottom: '4px' },
    checkboxHover: { background: 'var(--tn-surface2, rgba(255,255,255,0.05))' },
    tokenBadge: { marginLeft: 'auto', fontSize: '11px', color: 'var(--tn-text-muted)' },
    btn: {
      padding: '8px 16px', borderRadius: '4px', border: 'none', cursor: 'pointer',
      fontFamily: 'monospace', fontSize: '13px', fontWeight: 600,
    },
    btnPrimary: { background: 'var(--tn-purple, #bb9af7)', color: '#1a1b26' },
    btnSecondary: { background: 'var(--tn-surface2, rgba(255,255,255,0.08))', color: 'var(--tn-text)' },
    statusLine: { fontSize: '12px', color: 'var(--tn-text-muted)', marginTop: '8px' },
    success: { color: 'var(--tn-green, #9ece6a)' },
    errMsg: { color: 'var(--tn-red, #f7768e)', fontSize: '12px', marginTop: '6px' },
    textarea: {
      width: '100%', minHeight: '120px', background: 'var(--tn-surface, #1e2030)',
      border: '1px solid var(--tn-border, rgba(255,255,255,0.1))', borderRadius: '4px',
      color: 'var(--tn-text)', fontFamily: 'monospace', fontSize: '12px', padding: '8px',
      resize: 'vertical', boxSizing: 'border-box',
    },
    divider: { borderTop: '1px solid var(--tn-border, rgba(255,255,255,0.08))', margin: '16px 0' },
    sessionBox: {
      background: 'var(--tn-surface, #1e2030)', border: '1px solid var(--tn-green, #9ece6a)',
      borderRadius: '4px', padding: '10px 12px', fontSize: '12px',
    },
    tempFile: { color: 'var(--tn-cyan, #7dcfff)', fontSize: '12px' },
    chatContainer: {
      display: 'flex', flexDirection: 'column' as const, gap: '8px',
      maxHeight: '360px', overflowY: 'auto' as const,
      border: '1px solid var(--tn-border, rgba(255,255,255,0.1))',
      borderRadius: '4px', padding: '8px',
      background: 'var(--tn-surface, #1e2030)',
    },
    chatMsgUser: {
      alignSelf: 'flex-end', background: 'var(--tn-purple, #bb9af7)',
      color: '#1a1b26', borderRadius: '4px', padding: '6px 10px',
      maxWidth: '85%', fontSize: '12px', whiteSpace: 'pre-wrap' as const, wordBreak: 'break-word' as const,
    },
    chatMsgAssistant: {
      alignSelf: 'flex-start', background: 'var(--tn-surface2, rgba(255,255,255,0.07))',
      color: 'var(--tn-text)', borderRadius: '4px', padding: '6px 10px',
      maxWidth: '90%', fontSize: '12px', whiteSpace: 'pre-wrap' as const, wordBreak: 'break-word' as const,
    },
    chatInputRow: { display: 'flex', gap: '6px', marginTop: '6px' },
    chatInput: {
      flex: 1, background: 'var(--tn-surface, #1e2030)',
      border: '1px solid var(--tn-border, rgba(255,255,255,0.1))', borderRadius: '4px',
      color: 'var(--tn-text)', fontFamily: 'monospace', fontSize: '12px', padding: '6px 8px',
    },
  };

  if (loading) return <div style={s.root}>Lade Kontext-Konfiguration…</div>;
  if (error) return <div style={s.root}><span style={s.errMsg}>Fehler: {error}</span><br /><button style={{...s.btn, ...s.btnSecondary, marginTop: 8}} onClick={fetchContext}>Retry</button></div>;

  return (
    <div style={s.root}>
      <h2 style={s.h2}>Business Angel</h2>

      {/* Kern-Kontext */}
      <div style={s.section}>
        <div style={s.label}>Kern-Kontext (immer geladen)</div>
        <div style={{ color: 'var(--tn-text-muted)', fontSize: '12px' }}>
          {ctx!.kern_files.filter(f => f.exists).length} / {ctx!.kern_files.length} Dateien
          {' — '}
          <span style={{ color: tokenColor(ctx!.kern_tokens) }}>{formatTokens(ctx!.kern_tokens)} Tokens</span>
        </div>
      </div>

      {/* Temp-Ordner */}
      <div style={s.section}>
        <div style={s.label}>Temp-Ordner (frischer Input)</div>
        {ctx!.temp_files.length === 0 ? (
          <div style={{ color: 'var(--tn-text-muted)', fontSize: '12px' }}>Keine Dateien</div>
        ) : (
          <>
            {ctx!.temp_files.map(f => (
              <div key={f.name} style={s.tempFile}>
                {f.name} <span style={{ color: 'var(--tn-text-muted)' }}>({formatTokens(f.tokens)})</span>
              </div>
            ))}
            <div style={{ color: tokenColor(ctx!.temp_tokens), fontSize: '12px', marginTop: 4 }}>
              {formatTokens(ctx!.temp_tokens)} Tokens
            </div>
          </>
        )}
      </div>

      {/* Zusatz-Kategorien */}
      <div style={s.section}>
        <div style={s.label}>Zusatz-Kontext</div>
        {Object.entries(ctx!.zusatz_kategorien).map(([key, info]) => (
          <div
            key={key}
            style={{ ...s.checkbox, background: selectedZusatz.has(key) ? 'var(--tn-surface2, rgba(255,255,255,0.07))' : undefined }}
            onClick={() => toggleZusatz(key)}
          >
            <span style={{ color: selectedZusatz.has(key) ? 'var(--tn-purple, #bb9af7)' : 'var(--tn-text-muted)' }}>
              {selectedZusatz.has(key) ? '☑' : '☐'}
            </span>
            <span>{KATEGORIE_LABELS[key] || key}</span>
            <span style={s.tokenBadge}>{formatTokens(info.totalTokens)}</span>
          </div>
        ))}
      </div>

      {/* Token Counter */}
      <div style={s.section}>
        <div style={s.label}>Gesamt-Kontext</div>
        <div style={{ fontSize: '14px', fontWeight: 600, color: tokenColor(totalTokens) }}>
          {formatTokens(totalTokens)} Tokens
          {totalTokens > 80000 && ' ⚠ sehr groß'}
        </div>
      </div>

      {/* Start Button */}
      <div style={s.section}>
        {!startResult ? (
          <>
            <button
              style={{ ...s.btn, ...s.btnPrimary, opacity: starting ? 0.6 : 1 }}
              onClick={startSession}
              disabled={starting}
            >
              {starting ? 'Starte Session…' : 'Session starten'}
            </button>
            {startError && <div style={s.errMsg}>{startError}</div>}
          </>
        ) : (
          <>
            <div style={{ ...s.sessionBox, marginBottom: 10 }}>
              <div style={s.success}>Session aktiv — {startResult.files_loaded} Dateien, {formatTokens(startResult.token_count)} Tokens</div>
              <div style={{ color: 'var(--tn-text-muted)', fontSize: '11px', marginTop: 2 }}>
                ID: {startResult.session_id.slice(0, 8)}…
              </div>
            </div>

            {/* Chat Interface */}
            <div style={s.chatContainer}>
              {chatMessages.length === 0 && (
                <div style={{ color: 'var(--tn-text-muted)', fontSize: '12px', textAlign: 'center', padding: '16px 0' }}>
                  Business Angel bereit — stelle deine Frage
                </div>
              )}
              {chatMessages.map((msg, i) => (
                <div key={i} style={msg.role === 'user' ? s.chatMsgUser : s.chatMsgAssistant}>
                  {msg.content}
                </div>
              ))}
              {chatSending && (
                <div style={{ ...s.chatMsgAssistant, color: 'var(--tn-text-muted)', fontStyle: 'italic' }}>
                  Denkt nach…
                </div>
              )}
              <div ref={chatEndRef} />
            </div>

            <div style={s.chatInputRow}>
              <input
                style={s.chatInput}
                placeholder="Nachricht eingeben…"
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
                disabled={chatSending}
              />
              <button
                style={{ ...s.btn, ...s.btnPrimary, opacity: chatSending || !chatInput.trim() ? 0.6 : 1 }}
                onClick={sendMessage}
                disabled={chatSending || !chatInput.trim()}
              >
                Senden
              </button>
            </div>
            {chatError && <div style={s.errMsg}>{chatError}</div>}
          </>
        )}
      </div>

      <div style={s.divider} />

      {/* Apply Diffs Section */}
      <div style={s.section}>
        <div style={s.label}>Diffs anwenden</div>
        <div style={{ color: 'var(--tn-text-muted)', fontSize: '12px', marginBottom: '8px' }}>
          AI-Output mit FILE/OLD/NEW-Blöcken einfügen:
        </div>
        <textarea
          style={s.textarea}
          placeholder={'FILE: sales/PIPELINE.md\nOLD: alter Text\nNEW: neuer Text'}
          value={rawDiffText}
          onChange={e => setRawDiffText(e.target.value)}
        />
        <button
          style={{ ...s.btn, ...s.btnPrimary, marginTop: '8px', opacity: applying || !rawDiffText.trim() ? 0.6 : 1 }}
          onClick={applyDiffs}
          disabled={applying || !rawDiffText.trim()}
        >
          {applying ? 'Anwenden…' : 'Apply all'}
        </button>
        {applyError && <div style={s.errMsg}>{applyError}</div>}
        {applyResult && (
          <div style={{ marginTop: '10px', fontSize: '12px' }}>
            {applyResult.applied.length > 0 && (
              <div style={s.success}>
                Angewendet: {applyResult.applied.join(', ')}
              </div>
            )}
            {applyResult.failed.length > 0 && (
              <div style={{ color: 'var(--tn-red, #f7768e)', marginTop: 4 }}>
                {applyResult.failed.map(f => (
                  <div key={f.file}>{f.file}: {f.reason}</div>
                ))}
              </div>
            )}
            <div style={s.statusLine}>Backup: {applyResult.backup_dir}</div>
          </div>
        )}
      </div>

      <div style={s.divider} />

      <button style={{ ...s.btn, ...s.btnSecondary, fontSize: '11px' }} onClick={fetchContext}>
        Kontext neu laden
      </button>
    </div>
  );
}
