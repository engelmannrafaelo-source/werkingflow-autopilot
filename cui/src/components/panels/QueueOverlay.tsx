import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { ACCOUNTS } from '../../types';

const API = '/api';

// --- Types ---
interface Conversation {
  sessionId: string;
  accountId: string;
  accountLabel: string;
  accountColor: string;
  projectPath: string;
  projectName: string;
  summary: string;
  customName: string;
  status: 'ongoing' | 'completed';
  streamingId: string | null;
  model: string;
  messageCount: number;
  updatedAt: string;
  createdAt: string;
}

interface QueueOverlayProps {
  accountId: string;
  projectId?: string;
  workDir?: string;
  useLocal?: boolean;
  onNavigate: (sessionId: string) => void;  // Navigate CUI iframe to conversation
  onStartNew: (subject: string, message: string) => Promise<boolean>;  // Start new conversation, returns success
  refreshSignal?: number;  // Increment to trigger conversation list refresh (from parent WS)
}

// --- Helpers ---
function timeAgo(dateStr: string): string {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'jetzt';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function duration(created: string, updated: string): string {
  if (!created || !updated) return '';
  const diff = new Date(updated).getTime() - new Date(created).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '<1m';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remainMins = mins % 60;
  return remainMins > 0 ? `${hours}h${remainMins}m` : `${hours}h`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + '...';
}

// --- Styles (injected once) ---
const STYLE_ID = 'queue-styles';
function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    @keyframes q-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }
    .q-row:hover { background: var(--tn-bg-highlight) !important; }
    .q-row:hover .q-actions { opacity: 1 !important; }
    .q-btn:hover { filter: brightness(1.2); }
  `;
  document.head.appendChild(style);
}

// --- Status indicator ---
function StatusIcon({ status, streaming }: { status: string; streaming: boolean }) {
  if (streaming) {
    return <span style={{
      width: 8, height: 8, borderRadius: '50%', background: '#9ece6a',
      display: 'inline-block', flexShrink: 0,
      animation: 'q-pulse 1.5s ease-in-out infinite',
    }} />;
  }
  if (status === 'ongoing') {
    return <span style={{
      width: 8, height: 8, borderRadius: '50%', background: '#e0af68',
      display: 'inline-block', flexShrink: 0,
    }} />;
  }
  // completed
  return <span style={{
    width: 8, height: 8, borderRadius: '50%', background: 'var(--tn-text-muted)',
    display: 'inline-block', flexShrink: 0, opacity: 0.5,
  }} />;
}

// --- Conversation Row ---
function ConvRow({ conv, onNavigate, onStop, onSetName }: {
  conv: Conversation;
  onNavigate: () => void;
  onStop: () => void;
  onSetName: (name: string) => void;
}) {
  const isStreaming = !!conv.streamingId;
  const displayName = conv.customName || truncate(conv.summary.split('\n')[0], 70) || 'Ohne Betreff';
  const previewText = conv.customName
    ? truncate(conv.summary.split('\n')[0], 80)
    : '';

  return (
    <div
      className="q-row"
      onClick={onNavigate}
      style={{
        padding: '8px 12px', cursor: 'pointer',
        borderBottom: '1px solid var(--tn-border)',
        borderLeft: isStreaming ? '3px solid #9ece6a'
          : conv.status === 'ongoing' ? '3px solid #e0af68'
          : '3px solid transparent',
        transition: 'background 0.1s',
        position: 'relative',
      }}
    >
      {/* Line 1: Status + Title + Time + Actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <StatusIcon status={conv.status} streaming={isStreaming} />
        <span style={{
          fontSize: 12, color: 'var(--tn-text)', flex: 1,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          fontWeight: conv.customName ? 600 : 400,
        }}>
          {displayName}
        </span>
        <span style={{ fontSize: 10, color: 'var(--tn-text-muted)', opacity: 0.5, flexShrink: 0 }}>
          {duration(conv.createdAt, conv.updatedAt)}
        </span>
        {/* Hover actions */}
        <div className="q-actions" style={{ opacity: 0, display: 'flex', gap: 4, flexShrink: 0, transition: 'opacity 0.15s' }}>
          {conv.status === 'ongoing' && isStreaming && (
            <button className="q-btn" onClick={(e) => { e.stopPropagation(); onStop(); }} style={{
              padding: '1px 6px', fontSize: 9, borderRadius: 3, cursor: 'pointer',
              background: 'var(--tn-red)', border: 'none', color: '#fff', fontWeight: 600,
            }}>Stop</button>
          )}
          <button className="q-btn" onClick={(e) => { e.stopPropagation(); onNavigate(); }} style={{
            padding: '1px 6px', fontSize: 9, borderRadius: 3, cursor: 'pointer',
            background: 'var(--tn-blue)', border: 'none', color: '#fff', fontWeight: 600,
          }}>{conv.status === 'completed' ? 'Fortsetzen' : 'Oeffnen'}</button>
        </div>
      </div>

      {/* Line 2: Preview + metadata */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3 }}>
        {previewText && (
          <span style={{
            fontSize: 10, color: 'var(--tn-text-muted)', opacity: 0.6,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
          }}>
            {previewText}
          </span>
        )}
        {!previewText && <span style={{ flex: 1 }} />}
        <span style={{ fontSize: 9, color: 'var(--tn-text-muted)', opacity: 0.4, flexShrink: 0, fontFamily: 'monospace' }}>
          {conv.messageCount} msgs
        </span>
        {conv.model && (
          <span style={{ fontSize: 9, color: 'var(--tn-text-muted)', opacity: 0.3, flexShrink: 0 }}>
            {conv.model.replace('claude-', '').replace(/-\d+$/, '')}
          </span>
        )}
        <span style={{ fontSize: 9, color: 'var(--tn-text-muted)', opacity: 0.4, flexShrink: 0 }}>
          {timeAgo(conv.updatedAt)}
        </span>
      </div>
    </div>
  );
}

// --- Main Component ---
export default function QueueOverlay({ accountId, projectId, workDir, useLocal, onNavigate, onStartNew, refreshSignal }: QueueOverlayProps) {
  // Load cached conversations for instant display
  const [conversations, setConversations] = useState<Conversation[]>(() => {
    try {
      const cached = localStorage.getItem(`cui-convs-${accountId}`);
      return cached ? JSON.parse(cached) : [];
    } catch { return []; }
  });
  const [loading, setLoading] = useState(() => {
    try { return !localStorage.getItem(`cui-convs-${accountId}`); } catch { return true; }
  });
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [showCompleted, setShowCompleted] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState('');
  const subjectRef = useRef<HTMLInputElement>(null);

  // --- Start Templates ---
  interface PromptTemplate { id: string; label: string; message: string; category: "reply" | "start"; subject?: string; order: number; createdAt: string; }
  const [startTemplates, setStartTemplates] = useState<PromptTemplate[]>([]);
  const [showStartTplForm, setShowStartTplForm] = useState(false);
  const [newStartTplLabel, setNewStartTplLabel] = useState("");
  const [newStartTplSubject, setNewStartTplSubject] = useState("");
  const [newStartTplMessage, setNewStartTplMessage] = useState("");
  const [editingStartTpl, setEditingStartTpl] = useState<PromptTemplate | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval>>(null);

  useEffect(() => { ensureStyles(); }, []);

  const account = ACCOUNTS.find(a => a.id === accountId) ?? ACCOUNTS[0];

  // Fetch conversations
  const lastCountRef = useRef(-1);
  const fetchConversations = useCallback(() => {
    if ((window as any).__cuiServerAlive === false) { setLoading(false); return; }
    fetch(`${API}/mission/conversations`, { signal: AbortSignal.timeout(8000) })
      .then(r => { if (!r.ok) throw new Error('fetch failed'); return r.json(); })
      .then(data => {
        const convs: Conversation[] = data.conversations || [];
        const REMOTE_IDS = new Set(['rafael', 'engelmann', 'office']);
        const REMOTE_WS_PREFIX = '/root/orchestrator/workspaces/';
        const LOCAL_WS_PREFIX_MATCH = '/.cui/workspaces/';
        const wsName = workDir?.startsWith(REMOTE_WS_PREFIX)
          ? workDir.slice(REMOTE_WS_PREFIX.length).replace(/\/$/, '')
          : '';
        const filtered = convs.filter(c => {
          if (useLocal) {
            if (c.accountId !== 'local') return false;
          } else if (REMOTE_IDS.has(accountId)) {
            if (c.accountId !== accountId) return false;
          } else {
            if (c.accountId !== accountId) return false;
          }
          if (workDir) {
            const pp = (c.projectPath || '').replace(/\/$/, '');
            const wd = workDir.replace(/\/$/, '');
            if (pp === wd || pp.startsWith(wd + '/')) return true;
            if (wsName && (pp.includes(LOCAL_WS_PREFIX_MATCH + wsName) || pp.endsWith('/' + wsName))) return true;
            return false;
          }
          return true;
        });
        // Only log when count changes (avoid console spam)
        if (filtered.length !== lastCountRef.current) {
          console.log(`[QueueOverlay:${accountId}] ${filtered.length} conversations (${convs.length} total)`);
          lastCountRef.current = filtered.length;
        }
        setConversations(filtered);
        setLoading(false);
        // Cache for instant load next time
        try { localStorage.setItem(`cui-convs-${accountId}`, JSON.stringify(filtered.slice(0, 20))); } catch {}
      })
      .catch((err) => { console.warn('[QueueOverlay] fetchConversations:', err); setLoading(false); });
  }, [accountId, workDir, useLocal]);

  useEffect(() => {
    fetchConversations();
    pollRef.current = setInterval(fetchConversations, 60000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetchConversations]);

  // Refresh when parent signals via WS — debounced to prevent request floods
  useEffect(() => {
    if (refreshSignal && refreshSignal > 0) {
      const timeout = setTimeout(fetchConversations, 2000);
      return () => clearTimeout(timeout);
    }
  }, [refreshSignal, fetchConversations]);

  // Split conversations
  const active = useMemo(
    () => conversations.filter(c => c.status === 'ongoing').sort((a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    ),
    [conversations]
  );
  const completed = useMemo(
    () => conversations.filter(c => c.status === 'completed').sort((a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    ),
    [conversations]
  );

  // Start new conversation

  // --- Fetch Start Templates ---
  useEffect(() => {
    if ((window as any).__cuiServerAlive !== true) return;
    fetch('/api/prompt-templates', { signal: AbortSignal.timeout(10000) })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data) return;
        const start = (data.templates || []).filter((t: PromptTemplate) => t.category === 'start');
        start.sort((a: PromptTemplate, b: PromptTemplate) => a.order - b.order);
        setStartTemplates(start);
      })
      .catch(() => { /* templates load lazily */ });
  }, []);

  const handleSaveStartTemplate = useCallback(async () => {
    if ((window as any).__cuiServerAlive === false) return;
    if (!newStartTplLabel.trim() || !newStartTplMessage.trim()) return;
    try {
      if (editingStartTpl) {
        const resp = await fetch(`/api/prompt-templates/${editingStartTpl.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: newStartTplLabel, message: newStartTplMessage, subject: newStartTplSubject, category: 'start' }),
          signal: AbortSignal.timeout(15000),
        });
        if (!resp.ok) throw new Error(`PUT prompt-templates ${resp.status}`);
        const data = await resp.json();
        setStartTemplates(prev => prev.map(t => t.id === data.template.id ? data.template : t));
      } else {
        const resp = await fetch('/api/prompt-templates', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: newStartTplLabel, message: newStartTplMessage, subject: newStartTplSubject, category: 'start' }),
          signal: AbortSignal.timeout(15000),
        });
        if (!resp.ok) throw new Error(`POST prompt-templates ${resp.status}`);
        const data = await resp.json();
        setStartTemplates(prev => [...prev, data.template]);
      }
    } catch (err) {
      console.warn('[QueueOverlay] handleSaveStartTemplate:', err);
    }
    setShowStartTplForm(false);
    setEditingStartTpl(null);
    setNewStartTplLabel('');
    setNewStartTplSubject('');
    setNewStartTplMessage('');
  }, [newStartTplLabel, newStartTplSubject, newStartTplMessage, editingStartTpl]);

  const handleDeleteStartTemplate = useCallback(async (id: string) => {
    if ((window as any).__cuiServerAlive === false) return;
    try {
      const resp = await fetch(`/api/prompt-templates/${id}`, { method: 'DELETE', signal: AbortSignal.timeout(15000) });
      if (!resp.ok) throw new Error(`DELETE prompt-templates ${resp.status}`);
      setStartTemplates(prev => prev.filter(t => t.id !== id));
    } catch (err) {
      console.warn('[QueueOverlay] handleDeleteStartTemplate:', err);
    }
  }, []);

  const handleStart = useCallback(async () => {
    if (!subject.trim() || !message.trim() || starting) return;
    setStarting(true);
    setStartError('');
    const ok = await onStartNew(subject.trim(), message.trim());
    if (ok) {
      setSubject('');
      setMessage('');
    } else {
      setStartError('Konversation konnte nicht gestartet werden');
    }
    setStarting(false);
  }, [subject, message, starting, onStartNew]);

  // Stop conversation
  const handleStop = useCallback((conv: Conversation) => {
    if ((window as any).__cuiServerAlive === false) return;
    fetch(`${API}/mission/conversation/${conv.accountId}/${conv.sessionId}/stop`, { method: 'POST', signal: AbortSignal.timeout(15000) })
      .then(r => { if (!r.ok) throw new Error(`stop ${r.status}`); })
      .then(() => setTimeout(fetchConversations, 1000))
      .catch((err) => console.warn('[QueueOverlay] handleStop:', err));
  }, [fetchConversations]);

  // Set custom name
  const handleSetName = useCallback((conv: Conversation, name: string) => {
    if ((window as any).__cuiServerAlive === false) return;
    fetch(`${API}/mission/conversation/${conv.accountId}/${conv.sessionId}/name`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ custom_name: name }),
      signal: AbortSignal.timeout(15000),
    }).then(r => { if (!r.ok) throw new Error(`setName ${r.status}`); })
      .then(() => setTimeout(fetchConversations, 500))
      .catch((err) => console.warn('[QueueOverlay] handleSetName:', err));
  }, [fetchConversations]);

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      background: 'var(--tn-surface)', color: 'var(--tn-text)',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        padding: '12px 16px', background: 'var(--tn-bg-dark)',
        borderBottom: '1px solid var(--tn-border)', flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: account.color }} />
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--tn-text)' }}>
            {account.label}
          </span>
          {projectId && (
            <span style={{ fontSize: 10, color: 'var(--tn-text-muted)' }}>
              {projectId}
            </span>
          )}
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 10, color: '#9ece6a', fontWeight: 600 }}>
            {active.filter(c => c.streamingId).length} streaming
          </span>
          <span style={{ fontSize: 10, color: '#e0af68' }}>
            {active.length} aktiv
          </span>
          <span style={{ fontSize: 10, color: 'var(--tn-text-muted)', opacity: 0.5 }}>
            {completed.length} fertig
          </span>
        </div>

        {/* New conversation form */}
        <div style={{
          background: 'var(--tn-bg)', border: '1px solid var(--tn-border)',
          borderRadius: 6, padding: 10,
        }}>
          {/* Start Template Chips */}
          {startTemplates.length > 0 && !showStartTplForm && (
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 6 }}>
              {startTemplates.map(tpl => (
                <button
                  key={tpl.id}
                  onClick={(e) => { if (e.altKey) { setEditingStartTpl(tpl); setNewStartTplLabel(tpl.label); setNewStartTplSubject(tpl.subject || ""); setNewStartTplMessage(tpl.message); setShowStartTplForm(true); return; } setSubject(tpl.subject || ""); setMessage(tpl.message); }}
                  onContextMenu={(e) => { e.preventDefault(); if (confirm(`"${tpl.label}" löschen?`)) handleDeleteStartTemplate(tpl.id); }}
                  title={`${tpl.subject ? tpl.subject + ": " : ""}${tpl.message}\n\nAlt+Klick = Bearbeiten | Rechtsklick = Löschen`}
                  style={{ padding: "3px 8px", borderRadius: 3, fontSize: 10, cursor: "pointer", background: "rgba(59,130,246,0.08)", border: "1px solid rgba(59,130,246,0.2)", color: "var(--tn-blue)", whiteSpace: "nowrap", fontFamily: "inherit" }}
                >
                  {tpl.label}
                </button>
              ))}
              <button
                onClick={() => { setShowStartTplForm(true); setEditingStartTpl(null); setNewStartTplLabel(""); setNewStartTplSubject(""); setNewStartTplMessage(""); }}
                title="Neues Start-Template"
                style={{ padding: "3px 6px", borderRadius: 3, fontSize: 10, cursor: "pointer", background: "transparent", border: "1px dashed var(--tn-border)", color: "var(--tn-text-muted)", opacity: 0.5 }}
              >
                +
              </button>
            </div>
          )}
          {showStartTplForm && (
            <div style={{ display: "flex", gap: 4, marginBottom: 6, flexWrap: "wrap" }}>
              <input value={newStartTplLabel} onChange={e => setNewStartTplLabel(e.target.value)} placeholder="Label" style={{ width: 70, padding: "3px 6px", fontSize: 10, background: "var(--tn-bg)", color: "var(--tn-text)", border: "1px solid var(--tn-blue)", borderRadius: 3, fontFamily: "inherit" }} />
              <input value={newStartTplSubject} onChange={e => setNewStartTplSubject(e.target.value)} placeholder="Betreff" style={{ width: 80, padding: "3px 6px", fontSize: 10, background: "var(--tn-bg)", color: "var(--tn-text)", border: "1px solid var(--tn-blue)", borderRadius: 3, fontFamily: "inherit" }} />
              <input value={newStartTplMessage} onChange={e => setNewStartTplMessage(e.target.value)} placeholder="Nachricht" onKeyDown={e => { if (e.key === "Enter") handleSaveStartTemplate(); if (e.key === "Escape") { setShowStartTplForm(false); setEditingStartTpl(null); } }} style={{ flex: 1, minWidth: 120, padding: "3px 6px", fontSize: 10, background: "var(--tn-bg)", color: "var(--tn-text)", border: "1px solid var(--tn-blue)", borderRadius: 3, fontFamily: "inherit" }} />
              <button onClick={handleSaveStartTemplate} disabled={!newStartTplLabel.trim() || !newStartTplMessage.trim()} style={{ padding: "3px 8px", borderRadius: 3, fontSize: 10, cursor: "pointer", background: newStartTplLabel.trim() && newStartTplMessage.trim() ? "var(--tn-blue)" : "var(--tn-border)", border: "none", color: "#fff", fontWeight: 600 }}>{editingStartTpl ? "Update" : "Save"}</button>
              <button onClick={() => { setShowStartTplForm(false); setEditingStartTpl(null); }} style={{ padding: "3px 6px", borderRadius: 3, fontSize: 10, cursor: "pointer", background: "transparent", border: "1px solid var(--tn-border)", color: "var(--tn-text-muted)" }}>X</button>
            </div>
          )}
          <input
            ref={subjectRef}
            value={subject}
            onChange={e => { setSubject(e.target.value); setStartError(''); }}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey && subject.trim()) {
                // Focus message field
                const ta = e.currentTarget.parentElement?.querySelector('textarea');
                if (ta) ta.focus();
              }
            }}
            placeholder="Betreff (Pflicht)"
            style={{
              width: '100%', padding: '5px 8px', fontSize: 12,
              background: 'var(--tn-bg-dark)', color: 'var(--tn-text)',
              border: '1px solid var(--tn-border)', borderRadius: 4,
              marginBottom: 6, boxSizing: 'border-box',
              fontWeight: 600,
            }}
          />
          <div style={{ display: 'flex', gap: 6 }}>
            <textarea
              value={message}
              onChange={e => { setMessage(e.target.value); setStartError(''); }}
              onKeyDown={e => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  handleStart();
                }
              }}
              placeholder="Aufgabe beschreiben... (Cmd+Enter zum Starten)"
              rows={2}
              style={{
                flex: 1, padding: '5px 8px', fontSize: 11,
                background: 'var(--tn-bg-dark)', color: 'var(--tn-text)',
                border: '1px solid var(--tn-border)', borderRadius: 4,
                resize: 'vertical', minHeight: 32, maxHeight: 100,
                fontFamily: 'inherit', lineHeight: 1.4, boxSizing: 'border-box',
              }}
            />
            <button
              onClick={handleStart}
              disabled={!subject.trim() || !message.trim() || starting}
              style={{
                padding: '5px 14px', borderRadius: 4, fontSize: 11, cursor: 'pointer',
                background: subject.trim() && message.trim() ? 'var(--tn-blue)' : 'var(--tn-border)',
                border: 'none', color: '#fff', fontWeight: 600, alignSelf: 'flex-end',
                opacity: subject.trim() && message.trim() ? 1 : 0.4,
                whiteSpace: 'nowrap',
              }}
            >
              {starting ? '...' : 'Start'}
            </button>
          </div>
          {startError && (
            <div style={{
              marginTop: 6, padding: '4px 8px', fontSize: 11, fontWeight: 600,
              color: '#f7768e', background: 'rgba(247,118,142,0.1)',
              borderRadius: 4, border: '1px solid rgba(247,118,142,0.3)',
            }}>
              {startError}
            </div>
          )}
        </div>
      </div>

      {/* Scrollable content */}
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        {loading && (
          <div style={{ padding: 20, textAlign: 'center', color: 'var(--tn-text-muted)', fontSize: 11 }}>
            Lade...
          </div>
        )}

        {/* Active conversations */}
        {active.length > 0 && (
          <>
            <div style={{
              padding: '6px 12px', fontSize: 10, fontWeight: 700,
              color: '#e0af68', textTransform: 'uppercase', letterSpacing: 0.5,
              background: 'var(--tn-bg-dark)', borderBottom: '1px solid var(--tn-border)',
              position: 'sticky', top: 0, zIndex: 1,
            }}>
              Aktiv ({active.length})
            </div>
            {active.map(conv => (
              <ConvRow
                key={conv.sessionId}
                conv={conv}
                onNavigate={() => onNavigate(conv.sessionId)}
                onStop={() => handleStop(conv)}
                onSetName={(name) => handleSetName(conv, name)}
              />
            ))}
          </>
        )}

        {/* Completed conversations */}
        {completed.length > 0 && (
          <>
            <div
              onClick={() => setShowCompleted(!showCompleted)}
              style={{
                padding: '6px 12px', fontSize: 10, fontWeight: 700,
                color: 'var(--tn-text-muted)', textTransform: 'uppercase', letterSpacing: 0.5,
                background: 'var(--tn-bg-dark)', borderBottom: '1px solid var(--tn-border)',
                cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
                position: 'sticky', top: active.length > 0 ? 0 : undefined, zIndex: 1,
              }}
            >
              <span style={{ fontSize: 9, transition: 'transform 0.15s', transform: showCompleted ? 'rotate(90deg)' : 'none' }}>
                ▶
              </span>
              Abgeschlossen ({completed.length})
            </div>
            {showCompleted && completed.slice(0, 30).map(conv => (
              <ConvRow
                key={conv.sessionId}
                conv={conv}
                onNavigate={() => onNavigate(conv.sessionId)}
                onStop={() => {}}
                onSetName={(name) => handleSetName(conv, name)}
              />
            ))}
            {showCompleted && completed.length > 30 && (
              <div style={{ padding: '8px 12px', fontSize: 10, color: 'var(--tn-text-muted)', textAlign: 'center' }}>
                +{completed.length - 30} weitere
              </div>
            )}
          </>
        )}

        {/* Empty state */}
        {!loading && conversations.length === 0 && (
          <div style={{ padding: 32, textAlign: 'center' }}>
            <div style={{ fontSize: 13, color: 'var(--tn-text-muted)', marginBottom: 8 }}>
              Keine Konversationen in diesem Workspace
            </div>
            <div style={{ fontSize: 11, color: 'var(--tn-text-muted)', opacity: 0.5 }}>
              Starte oben eine neue Konversation mit Betreff
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
