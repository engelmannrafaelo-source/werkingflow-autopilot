import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { ACCOUNTS } from '../../types';

const API = '/api';

// --- Types ---
type AttentionState = 'working' | 'needs_attention' | 'idle';
type AttentionReason = 'plan' | 'question' | 'permission' | 'error' | 'done';

interface Conversation {
  sessionId: string;
  accountId: string;
  accountLabel: string;
  accountColor: string;
  proxyPort: number;
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
  lastPromptAt?: string;
  attentionState?: AttentionState;
  attentionReason?: AttentionReason;
  isVisible?: boolean;
  manualFinished?: boolean;
}

interface ProjectGroup {
  name: string;
  conversations: Conversation[];
  activeCount: number;
  workingCount: number;
  attentionCount: number;
  accounts: Array<{ id: string; label: string; color: string }>;
  lastActivity: string;
}

interface Message {
  role: 'user' | 'assistant';
  content: string | Array<{ type: string; text?: string; tool_use_id?: string; name?: string; input?: unknown }>;
  timestamp?: string;
}

interface Permission {
  id: string;
  type: string;
  toolName?: string;
  title?: string;
}

interface ConversationDetail {
  messages: Message[];
  summary: string;
  status: string;
  projectPath: string;
  permissions: Permission[];
  totalMessages: number;
}

interface CommanderMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
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

function extractText(content: Message['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter(b => b.type === 'text' && b.text).map(b => b.text!).join('\n');
  }
  return '';
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + '...';
}

function groupByProject(conversations: Conversation[]): ProjectGroup[] {
  const map = new Map<string, ProjectGroup>();
  for (const c of conversations) {
    let group = map.get(c.projectName);
    if (!group) {
      group = { name: c.projectName, conversations: [], activeCount: 0, workingCount: 0, attentionCount: 0, accounts: [], lastActivity: '' };
      map.set(c.projectName, group);
    }
    group.conversations.push(c);
    if (c.status === 'ongoing') group.activeCount++;
    if (c.streamingId || c.attentionState === 'working') group.workingCount++;
    if (c.attentionState === 'needs_attention') group.attentionCount++;
    if (!group.accounts.find(a => a.id === c.accountId)) {
      group.accounts.push({ id: c.accountId, label: c.accountLabel, color: c.accountColor });
    }
    if (!group.lastActivity || c.updatedAt > group.lastActivity) group.lastActivity = c.updatedAt;
  }
  return Array.from(map.values()).sort((a, b) => {
    // Attention first, then working, then active
    if (a.attentionCount !== b.attentionCount) return b.attentionCount - a.attentionCount;
    if (a.workingCount !== b.workingCount) return b.workingCount - a.workingCount;
    if (a.activeCount !== b.activeCount) return b.activeCount - a.activeCount;
    return new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime();
  });
}

// --- Inline CSS ---
const STYLE_ID = 'mc-styles';
function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    @keyframes mc-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }
    @keyframes mc-slide-in { from { transform: translateX(100%); } to { transform: translateX(0); } }
    .mc-card:hover { border-color: var(--tn-blue) !important; background: rgba(122,162,247,0.08) !important; }
    .mc-sidebar-item:hover { background: rgba(255,255,255,0.05) !important; }
    .mc-preview-msg:hover { background: rgba(255,255,255,0.03) !important; }
  `;
  document.head.appendChild(style);
}

// --- Sub-components ---

const ATTENTION_LABELS: Record<string, string> = {
  plan: 'PLAN',
  question: 'FRAGE',
  permission: 'PERM',
  error: 'FEHLER',
};

function StatusDot({ conv }: { conv: Conversation }) {
  const attn = conv.attentionState;
  const reason = conv.attentionReason;
  const isStreaming = !!conv.streamingId;

  // Needs attention: orange pulsing dot + label
  if (attn === 'needs_attention' && reason) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#F59E0B', display: 'inline-block', animation: 'mc-pulse 1s ease-in-out infinite', boxShadow: '0 0 6px rgba(245,158,11,0.6)' }} />
        <span style={{ fontSize: 9, fontWeight: 700, color: '#F59E0B' }}>{ATTENTION_LABELS[reason] || reason.toUpperCase()}</span>
      </span>
    );
  }

  // Working: blue pulsing dot, no text
  if (isStreaming || (attn === 'working')) {
    return <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#3B82F6', display: 'inline-block', animation: 'mc-pulse 1.5s ease-in-out infinite' }} />;
  }

  // Ongoing but not streaming
  if (conv.status === 'ongoing') {
    return <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#F59E0B', display: 'inline-block', opacity: 0.6 }} />;
  }

  // Idle/Done: dim grey dot
  return <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--tn-text-subtle)', display: 'inline-block', opacity: 0.3 }} />;
}

function AccountDots({ accounts }: { accounts: ProjectGroup['accounts'] }) {
  return (
    <div style={{ display: 'flex', gap: 2 }}>
      {accounts.map(a => (
        <span key={a.id} title={a.label} style={{
          width: 6, height: 6, borderRadius: '50%',
          background: a.color, display: 'inline-block',
          border: '1px solid rgba(0,0,0,0.3)',
        }} />
      ))}
    </div>
  );
}

// --- Session Card (compact, attention-based) ---
function SessionCard({ conv, isSelected, onClick, checked, onCheck, onActivate, onFinish, onDelete, panelLabel, expanded, snippet }: {
  conv: Conversation; isSelected: boolean; onClick: () => void;
  checked?: boolean; onCheck?: (checked: boolean) => void;
  onActivate?: (conv: Conversation) => void;
  onFinish?: (conv: Conversation) => void;
  onDelete?: (conv: Conversation) => void;
  panelLabel?: string;
  expanded?: boolean;
  snippet?: string;
}) {
  const needsAttention = conv.attentionState === 'needs_attention';
  const isWorking = !!conv.streamingId || conv.attentionState === 'working';
  const displayName = conv.customName || truncate(conv.summary.split('\n')[0], 60) || 'Neue Konversation';

  // Border color: attention > checked > selected > working > default
  const borderColor = needsAttention ? 'rgba(245,158,11,0.5)'
    : checked ? '#10B981'
    : isSelected ? 'var(--tn-blue)'
    : isWorking ? 'rgba(59,130,246,0.15)'
    : 'var(--tn-border)';

  // Preview: summary lines that differ from title, plus metadata
  const summaryText = conv.summary || '';
  const summaryFirstLine = summaryText.split('\n')[0];
  // If summary first line matches the display name, skip it to avoid repetition
  const extraLines = displayName === truncate(summaryFirstLine, 60)
    ? summaryText.split('\n').slice(1).join('\n').trim()
    : summaryText.trim();

  return (
    <div className="mc-card" onClick={onClick} style={{
      padding: expanded ? '10px 14px' : '8px 12px', borderRadius: 8, cursor: 'pointer', overflow: 'hidden',
      border: `1.5px solid ${borderColor}`,
      background: needsAttention ? 'rgba(245,158,11,0.06)' : checked ? 'rgba(16,185,129,0.08)' : isSelected ? 'rgba(122,162,247,0.1)' : 'var(--tn-bg)',
      transition: 'all 0.1s',
    }}>
      {/* Row 1: Title + meta + buttons */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {onCheck && (
          <input type="checkbox" checked={!!checked}
            onChange={e => { e.stopPropagation(); onCheck(e.target.checked); }}
            onClick={e => e.stopPropagation()}
            style={{ accentColor: '#10B981', cursor: 'pointer', width: 14, height: 14, flexShrink: 0 }} />
        )}
        <StatusDot conv={conv} />
        {panelLabel && (
          <span title={`Offen in: ${panelLabel}`} style={{
            maxWidth: 80, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            padding: '1px 5px', borderRadius: 3, fontSize: 9, fontWeight: 600,
            background: 'rgba(16,185,129,0.15)', border: '1px solid rgba(16,185,129,0.4)',
            color: '#10B981', flexShrink: 0,
          }}>{panelLabel}</span>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 13, color: needsAttention ? '#F59E0B' : 'var(--tn-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            fontWeight: needsAttention ? 700 : 600, lineHeight: 1.4,
          }}>
            {displayName}
          </div>
          <div style={{ display: 'flex', gap: 8, fontSize: 10, color: 'var(--tn-text-muted)', marginTop: 2, alignItems: 'center' }}>
            <span style={{ fontWeight: 600 }}>{conv.projectName}</span>
            <span style={{ fontWeight: 700, color: conv.accountColor }}>{conv.accountLabel.slice(0, 3).toUpperCase()}</span>
            <span style={{ color: 'var(--tn-text-subtle)' }}>{conv.messageCount} msgs</span>
          </div>
        </div>
        {!panelLabel && onActivate && (
          <button onClick={(e) => { e.stopPropagation(); onActivate(conv); }}
            title="In Panel oeffnen"
            style={{
              background: 'none', border: '1px solid rgba(139,92,246,0.3)',
              color: '#8B5CF6', cursor: 'pointer', fontSize: 10,
              padding: '2px 6px', borderRadius: 3, fontWeight: 600, flexShrink: 0,
            }}>&#8594;</button>
        )}
        {!conv.manualFinished && onFinish && (
          <button onClick={(e) => { e.stopPropagation(); onFinish(conv); }}
            title="Als fertig markieren"
            style={{
              background: 'none', border: '1px solid rgba(16,185,129,0.3)',
              color: '#10B981', cursor: 'pointer', fontSize: 13,
              padding: '0px 5px', borderRadius: 3, flexShrink: 0, lineHeight: 1,
            }}>&#10003;</button>
        )}
        {onDelete && (
          <button onClick={(e) => { e.stopPropagation(); onDelete(conv); }}
            title="Konversation loeschen"
            style={{
              background: 'none', border: '1px solid rgba(239,68,68,0.3)',
              color: '#EF4444', cursor: 'pointer', fontSize: 13,
              padding: '0px 5px', borderRadius: 3, flexShrink: 0, lineHeight: 1,
            }}>&#10005;</button>
        )}
        <span title={conv.lastPromptAt ? `Letzter Prompt: ${new Date(conv.lastPromptAt).toLocaleString()}` : `Letzte Aktivität: ${new Date(conv.updatedAt).toLocaleString()}`}
          style={{ fontSize: 10, color: conv.lastPromptAt ? 'var(--tn-text-muted)' : 'var(--tn-text-subtle)', flexShrink: 0, fontWeight: 500 }}>
          {conv.lastPromptAt ? timeAgo(conv.lastPromptAt) : <span style={{ opacity: 0.6 }}>{timeAgo(conv.updatedAt)}</span>}
        </span>
      </div>
      {/* Row 2: Snippet preview */}
      {expanded && snippet && (
        <div style={{
          marginTop: 8, padding: '8px 10px', borderRadius: 4,
          background: 'rgba(0,0,0,0.25)', borderLeft: '3px solid rgba(122,162,247,0.5)',
        }}>
          <div style={{
            fontFamily: 'ui-monospace, "SF Mono", Monaco, Menlo, monospace',
            fontSize: 11, lineHeight: '16px',
            color: '#c0caf5', overflow: 'hidden',
            maxHeight: 80, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          }}>
            {snippet}
          </div>
          <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', marginTop: 4 }}>
            {conv.model ? conv.model.split('-').slice(0, 2).join('-') : ''} &middot; {conv.status}
          </div>
        </div>
      )}
    </div>
  );
}

// --- Preview Panel (right side detail view) ---
function PreviewPanel({ conv, onSend, onStop, onNameChange, onPermission }: {
  conv: Conversation;
  onSend: (message: string) => void;
  onStop: () => void;
  onNameChange: (name: string) => void;
  onPermission: (permId: string, action: 'approve' | 'deny') => void;
}) {
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [inputValue, setInputValue] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(conv.customName);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setLoading(true);
    setDetail(null);
    fetch(`${API}/mission/conversation/${conv.accountId}/${conv.sessionId}?tail=100`)
      .then(r => r.json())
      .then(data => { setDetail(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, [conv.sessionId, conv.accountId]);

  // Only refresh detail when attention state changes (not on a timer)
  useEffect(() => {
    if (conv.status !== 'ongoing') return;
    // Single refresh when attention state changes to show latest messages
    fetch(`${API}/mission/conversation/${conv.accountId}/${conv.sessionId}?tail=100`)
      .then(r => r.json()).then(data => setDetail(data)).catch(() => {});
  }, [conv.sessionId, conv.accountId, conv.status, conv.attentionState]);

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [detail?.messages]);
  useEffect(() => { if (editingName) { nameInputRef.current?.focus(); nameInputRef.current?.select(); } }, [editingName]);

  const handleSend = () => { const msg = inputValue.trim(); if (!msg) return; onSend(msg); setInputValue(''); };
  const handleNameSave = () => { onNameChange(nameValue); setEditingName(false); };
  const isStreaming = !!conv.streamingId;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--tn-surface)' }}>
      {/* Header */}
      <div style={{
        padding: '6px 12px', background: 'var(--tn-bg-dark)',
        borderBottom: '1px solid var(--tn-border)', flexShrink: 0,
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <StatusDot conv={conv} />
        <span style={{ fontSize: 11, fontWeight: 700, color: conv.accountColor }}>{conv.accountLabel}</span>
        <span style={{ fontSize: 10, color: 'var(--tn-text-subtle)' }}>{conv.projectName}</span>

        {editingName ? (
          <div style={{ flex: 1, display: 'flex', gap: 4 }}>
            <input ref={nameInputRef} value={nameValue} onChange={e => setNameValue(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleNameSave(); if (e.key === 'Escape') setEditingName(false); }}
              style={{ flex: 1, padding: '3px 8px', fontSize: 12, background: 'var(--tn-bg)', color: 'var(--tn-text)', border: '1px solid var(--tn-blue)', borderRadius: 3 }}
              placeholder="Betreff..." />
            <button onClick={handleNameSave} style={{ padding: '3px 8px', fontSize: 10, background: 'var(--tn-blue)', border: 'none', color: '#fff', borderRadius: 3, cursor: 'pointer' }}>OK</button>
          </div>
        ) : (
          <span onClick={() => { setNameValue(conv.customName); setEditingName(true); }}
            style={{ flex: 1, fontSize: 12, fontWeight: 600, color: 'var(--tn-text)', cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            title="Klick zum Bearbeiten">
            {conv.customName || <span style={{ color: 'var(--tn-text-muted)', fontStyle: 'italic', fontWeight: 400, fontSize: 10 }}>+ Betreff</span>}
          </span>
        )}

        <span style={{ fontSize: 10, color: 'var(--tn-text-subtle)' }}>{detail ? `${detail.totalMessages} msgs` : ''}</span>
        {isStreaming && (
          <button onClick={onStop} style={{ padding: '2px 8px', borderRadius: 3, fontSize: 9, cursor: 'pointer', background: '#EF4444', border: 'none', color: '#fff', fontWeight: 600 }}>Stop</button>
        )}
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflow: 'auto', padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 }}>
        {loading && <div style={{ color: 'var(--tn-text-muted)', fontSize: 13, textAlign: 'center', padding: 20 }}>Lade...</div>}
        {detail?.messages.map((msg, i) => {
          const text = extractText(msg.content);
          if (!text) return null;
          const isUser = msg.role === 'user';
          return (
            <div key={i} className="mc-preview-msg" style={{
              padding: '8px 12px', borderRadius: 6,
              borderLeft: `3px solid ${isUser ? '#3B82F6' : '#10B981'}`,
              background: isUser ? 'rgba(59,130,246,0.06)' : 'rgba(16,185,129,0.04)',
            }}>
              <div style={{ fontSize: 10, color: isUser ? '#3B82F6' : '#10B981', fontWeight: 600, marginBottom: 3 }}>
                {isUser ? 'User' : 'Assistant'}
                {msg.timestamp && <span style={{ marginLeft: 8, color: 'var(--tn-text-muted)', fontWeight: 400 }}>{new Date(msg.timestamp).toLocaleTimeString()}</span>}
              </div>
              <div style={{ fontSize: 13, color: 'var(--tn-text)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.5 }}>
                {text.length > 3000 ? text.slice(0, 3000) + '\n...' : text}
              </div>
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      {/* Permissions */}
      {detail?.permissions && detail.permissions.length > 0 && (
        <div style={{ padding: '8px 14px', borderTop: '1px solid var(--tn-border)', background: 'rgba(245,158,11,0.08)', flexShrink: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#F59E0B', marginBottom: 4 }}>Genehmigungen</div>
          {detail.permissions.map(perm => (
            <div key={perm.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <span style={{ fontSize: 12, color: 'var(--tn-text)', flex: 1 }}>{perm.toolName || perm.type}: {perm.title || perm.id.slice(0, 8)}</span>
              <button onClick={() => onPermission(perm.id, 'approve')} style={{ padding: '3px 10px', fontSize: 11, borderRadius: 3, cursor: 'pointer', background: '#10B981', border: 'none', color: '#fff', fontWeight: 600 }}>OK</button>
              <button onClick={() => onPermission(perm.id, 'deny')} style={{ padding: '3px 10px', fontSize: 11, borderRadius: 3, cursor: 'pointer', background: '#EF4444', border: 'none', color: '#fff', fontWeight: 600 }}>X</button>
            </div>
          ))}
        </div>
      )}

      {/* Input */}
      <div style={{ padding: '8px 14px', borderTop: '1px solid var(--tn-border)', background: 'var(--tn-bg-dark)', flexShrink: 0, display: 'flex', gap: 6 }}>
        <input value={inputValue} onChange={e => setInputValue(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); handleSend(); } }}
          placeholder="Nachricht... (Cmd+Enter)"
          style={{ flex: 1, padding: '6px 10px', fontSize: 13, background: 'var(--tn-bg)', color: 'var(--tn-text)', border: '1px solid var(--tn-border)', borderRadius: 4, fontFamily: 'inherit' }} />
        <button onClick={handleSend} disabled={!inputValue.trim()}
          style={{ padding: '6px 14px', borderRadius: 4, fontSize: 12, cursor: 'pointer', background: inputValue.trim() ? '#3B82F6' : 'var(--tn-border)', border: 'none', color: '#fff', fontWeight: 600, opacity: inputValue.trim() ? 1 : 0.5 }}>
          Senden
        </button>
      </div>
    </div>
  );
}

// --- Commander Chat (Slide Panel) ---
const CMD_STORAGE_KEY = 'mc-commander-messages';

function loadCommanderMessages(): CommanderMessage[] {
  try {
    const stored = localStorage.getItem(CMD_STORAGE_KEY);
    if (!stored) return [];
    return (JSON.parse(stored) as CommanderMessage[]).slice(-50);
  } catch { return []; }
}

function saveCommanderMessages(msgs: CommanderMessage[]) {
  try { localStorage.setItem(CMD_STORAGE_KEY, JSON.stringify(msgs.slice(-50))); } catch {}
}

function CommanderPanel({ onClose }: { onClose: () => void }) {
  const [messages, setMessages] = useState<CommanderMessage[]>(loadCommanderMessages);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  const updateMessages = (updater: (prev: CommanderMessage[]) => CommanderMessage[]) => {
    setMessages(prev => { const next = updater(prev); saveCommanderMessages(next); return next; });
  };

  const clearHistory = () => { setMessages([]); try { localStorage.removeItem(CMD_STORAGE_KEY); } catch {} };

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || loading) return;
    setInput('');
    const userMsg: CommanderMessage = { role: 'user', content: text, timestamp: Date.now() };
    updateMessages(prev => [...prev, userMsg]);
    setLoading(true);
    try {
      const resp = await fetch(`${API}/mission/commander`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [...messages, userMsg].map(m => ({ role: m.role, content: m.content })), context: messages.length === 0 }),
      });
      if (!resp.ok) { const err = await resp.json().catch(() => ({ error: 'Request failed' })); throw new Error(err.error || `HTTP ${resp.status}`); }
      const data = await resp.json();
      updateMessages(prev => [...prev, { role: 'assistant', content: data.choices?.[0]?.message?.content || data.content || 'Keine Antwort', timestamp: Date.now() }]);
    } catch (err: any) {
      updateMessages(prev => [...prev, { role: 'assistant', content: `Fehler: ${err.message}`, timestamp: Date.now() }]);
    } finally { setLoading(false); }
  };

  return (
    <div style={{
      position: 'absolute', top: 0, right: 0, bottom: 0, width: '45%', minWidth: 320, maxWidth: 550, zIndex: 30,
      background: 'var(--tn-surface)', borderLeft: '2px solid var(--tn-border)', boxShadow: '-4px 0 20px rgba(0,0,0,0.4)',
      display: 'flex', flexDirection: 'column', animation: 'mc-slide-in 0.2s ease-out',
    }}>
      <div style={{ padding: '8px 12px', background: 'var(--tn-bg-dark)', borderBottom: '1px solid var(--tn-border)', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 16 }}>&#129504;</span>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--tn-text)' }}>Commander</span>
        <span style={{ fontSize: 9, color: 'var(--tn-text-muted)' }}>Haiku</span>
        {messages.length > 0 && (
          <button onClick={clearHistory} style={{ marginLeft: 'auto', background: 'none', border: '1px solid var(--tn-border)', color: 'var(--tn-text-muted)', cursor: 'pointer', fontSize: 9, padding: '2px 6px', borderRadius: 3 }}>Clear</button>
        )}
        <button onClick={onClose} style={{ marginLeft: messages.length > 0 ? 0 : 'auto', background: 'none', border: 'none', color: 'var(--tn-text-muted)', cursor: 'pointer', fontSize: 16 }}>x</button>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {messages.length === 0 && (
          <div style={{ textAlign: 'center', color: 'var(--tn-text-muted)', padding: 20 }}>
            <div style={{ fontSize: 24, marginBottom: 8 }}>&#129504;</div>
            <div style={{ fontSize: 11, marginBottom: 4 }}>Cross-Projekt Commander</div>
            <div style={{ fontSize: 10, opacity: 0.6, lineHeight: 1.4 }}>Zusammenfassungen, Git-Diffs, Tasks dispatchen</div>
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {['Was laeuft gerade?', 'Git-Aenderungen heute', 'Management Summary'].map(q => (
                <button key={q} onClick={() => setInput(q)}
                  style={{ padding: '4px 8px', fontSize: 10, background: 'var(--tn-bg)', border: '1px solid var(--tn-border)', borderRadius: 4, color: 'var(--tn-text-muted)', cursor: 'pointer', textAlign: 'left' }}>
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} style={{
            padding: '6px 10px', borderRadius: 6,
            background: msg.role === 'user' ? 'rgba(59,130,246,0.08)' : 'var(--tn-bg)',
            border: `1px solid ${msg.role === 'user' ? 'rgba(59,130,246,0.2)' : 'var(--tn-border)'}`,
            borderLeftWidth: 3, borderLeftColor: msg.role === 'user' ? '#3B82F6' : '#10B981',
          }}>
            <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', marginBottom: 2, fontWeight: 600 }}>
              {msg.role === 'user' ? 'Du' : 'Commander'}
              <span style={{ marginLeft: 6, opacity: 0.5 }}>{new Date(msg.timestamp).toLocaleTimeString()}</span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--tn-text)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.4 }}>{msg.content}</div>
          </div>
        ))}
        {loading && <div style={{ padding: 8, textAlign: 'center' }}><span style={{ fontSize: 10, color: 'var(--tn-text-muted)', animation: 'mc-pulse 1s ease-in-out infinite' }}>Commander denkt...</span></div>}
        <div ref={messagesEndRef} />
      </div>
      <div style={{ padding: '8px 10px', borderTop: '1px solid var(--tn-border)', background: 'var(--tn-bg-dark)', flexShrink: 0, display: 'flex', gap: 6 }}>
        <textarea value={input} onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendMessage(); } }}
          placeholder="Cmd+Enter zum Senden"
          style={{ flex: 1, padding: '6px 8px', fontSize: 11, background: 'var(--tn-bg)', color: 'var(--tn-text)', border: '1px solid var(--tn-border)', borderRadius: 4, resize: 'vertical', minHeight: 36, maxHeight: 100, fontFamily: 'inherit', lineHeight: 1.4 }} />
        <button onClick={sendMessage} disabled={!input.trim() || loading}
          style={{ padding: '6px 14px', borderRadius: 4, fontSize: 11, cursor: 'pointer', background: input.trim() && !loading ? '#3B82F6' : 'var(--tn-border)', border: 'none', color: '#fff', fontWeight: 600, alignSelf: 'flex-end', opacity: input.trim() && !loading ? 1 : 0.5 }}>
          Senden
        </button>
      </div>
    </div>
  );
}

// --- New Conversation Dialog ---
function NewConversationDialog({ projects, onStart, onClose }: {
  projects: Array<{ id: string; name: string; workDir: string }>;
  onStart: (accountId: string, workDir: string, subject: string, message: string) => void;
  onClose: () => void;
}) {
  const [accountId, setAccountId] = useState('rafael');
  const [projectId, setProjectId] = useState(projects[0]?.id || '');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const subjectRef = useRef<HTMLInputElement>(null);
  useEffect(() => { subjectRef.current?.focus(); }, []);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!subject.trim() || !message.trim()) return;
    const proj = projects.find(p => p.id === projectId);
    onStart(accountId, proj?.workDir || '/root', subject.trim(), message.trim());
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '6px 10px', fontSize: 12,
    background: 'var(--tn-bg)', color: 'var(--tn-text)',
    border: '1px solid var(--tn-border)', borderRadius: 4,
    marginBottom: 12, boxSizing: 'border-box',
  };

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 2000, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <form onSubmit={handleSubmit} onClick={e => e.stopPropagation()}
        style={{ background: 'var(--tn-surface)', border: '1px solid var(--tn-border)', borderRadius: 8, padding: 20, width: 420, boxShadow: '0 8px 32px rgba(0,0,0,0.5)' }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--tn-text)', marginBottom: 16 }}>Neue Konversation</div>
        <label style={{ fontSize: 11, color: 'var(--tn-text-muted)', display: 'block', marginBottom: 4 }}>Account</label>
        <select value={accountId} onChange={e => setAccountId(e.target.value)} style={inputStyle}>
          {ACCOUNTS.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
        </select>
        <label style={{ fontSize: 11, color: 'var(--tn-text-muted)', display: 'block', marginBottom: 4 }}>Workspace</label>
        <select value={projectId} onChange={e => setProjectId(e.target.value)} style={inputStyle}>
          {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <label style={{ fontSize: 11, color: 'var(--tn-text-muted)', display: 'block', marginBottom: 4 }}>Betreff *</label>
        <input ref={subjectRef} value={subject} onChange={e => setSubject(e.target.value)} placeholder="z.B. API Bridge refactoring" style={inputStyle} />
        <label style={{ fontSize: 11, color: 'var(--tn-text-muted)', display: 'block', marginBottom: 4 }}>Nachricht *</label>
        <textarea value={message} onChange={e => setMessage(e.target.value)} placeholder="Was soll Claude tun?" rows={4}
          style={{ ...inputStyle, marginBottom: 16, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.4 }} />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" onClick={onClose} style={{ padding: '6px 14px', borderRadius: 5, fontSize: 12, cursor: 'pointer', background: 'var(--tn-bg)', border: '1px solid var(--tn-border)', color: 'var(--tn-text-muted)' }}>Abbrechen</button>
          <button type="submit" disabled={!subject.trim() || !message.trim()}
            style={{ padding: '6px 16px', borderRadius: 5, fontSize: 12, cursor: 'pointer', fontWeight: 600, background: subject.trim() && message.trim() ? '#3B82F6' : 'var(--tn-border)', border: 'none', color: '#fff', opacity: subject.trim() && message.trim() ? 1 : 0.5 }}>
            Starten
          </button>
        </div>
      </form>
    </div>
  );
}

// ============================================================
// --- MAIN COMPONENT: 3-Panel Layout (Sidebar + Cards + Detail)
// ============================================================

interface MissionControlProps {
  projectId?: string;
  workDir?: string;
}

export default function MissionControl({ projectId }: MissionControlProps) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNewDialog, setShowNewDialog] = useState(false);
  const [showCommander, setShowCommander] = useState(false);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [selectedConv, setSelectedConv] = useState<Conversation | null>(null);
  const [projects, setProjects] = useState<Array<{ id: string; name: string; workDir: string }>>([]);
  const [checkedConvs, setCheckedConvs] = useState<Set<string>>(new Set());
  const [bulkStatus, setBulkStatus] = useState<string | null>(null);
  const [autoTitleStatus, setAutoTitleStatus] = useState<string | null>(null);
  const [syncEnabled, setSyncEnabled] = useState(() => {
    try { return localStorage.getItem('mc-sync') !== 'off'; } catch { return true; }
  });
  const [hiddenProjects, setHiddenProjects] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem('mc-hidden-projects');
      return stored ? new Set(JSON.parse(stored)) : new Set();
    } catch { return new Set(); }
  });
  const pollRef = useRef<ReturnType<typeof setInterval>>(null);
  const [visibleSessionIds, setVisibleSessionIds] = useState<Set<string>>(new Set());
  const [panelMap, setPanelMap] = useState<Map<string, string>>(new Map()); // sessionId → panel label
  const [showPreviews, setShowPreviews] = useState(() => {
    try { return localStorage.getItem('mc-show-previews') === '1'; } catch { return false; }
  });
  const [snippets, setSnippets] = useState<Map<string, string>>(new Map());

  useEffect(() => { ensureStyles(); }, []);
  useEffect(() => { fetch(`${API}/projects`).then(r => r.json()).then(setProjects).catch(() => {}); }, []);
  const toggleProjectVisibility = useCallback((projectName: string) => {
    setHiddenProjects(prev => {
      const next = new Set(prev);
      if (next.has(projectName)) next.delete(projectName); else next.add(projectName);
      try { localStorage.setItem('mc-hidden-projects', JSON.stringify([...next])); } catch {}
      return next;
    });
  }, []);

  const fetchConversations = useCallback(() => {
    const qs = projectId ? `?project=${encodeURIComponent(projectId)}` : '';
    Promise.all([
      fetch(`${API}/mission/conversations${qs}`).then(r => r.json()),
      fetch(`${API}/mission/visibility`).then(r => r.json()).catch(() => ({ panels: [], visibleSessionIds: [] })),
    ]).then(([convData, visData]) => {
      setConversations(convData.conversations || []);
      setVisibleSessionIds(new Set(visData.visibleSessionIds || []));
      // Build sessionId → panel label map from panel data
      const pm = new Map<string, string>();
      for (const p of (visData.panels || [])) {
        if (p.sessionId) {
          // Label: projectId or "Panel {panelId short}"
          const label = p.projectId && p.projectId !== 'default' ? p.projectId : `Panel ${(p.panelId || '').slice(0, 4)}`;
          pm.set(p.sessionId, label);
        }
      }
      setPanelMap(pm);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [projectId]);

  // Poll every 60s - no WebSocket streaming
  useEffect(() => {
    if (!syncEnabled) { setLoading(false); return; }
    fetchConversations();
    pollRef.current = setInterval(fetchConversations, 60000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetchConversations, syncEnabled]);

  const visibleConversations = useMemo(() =>
    conversations.filter(c => !hiddenProjects.has(c.projectName)),
    [conversations, hiddenProjects]
  );

  const groups = useMemo(() => groupByProject(visibleConversations), [visibleConversations]);
  const allGroups = useMemo(() => groupByProject(conversations), [conversations]);
  // Enrich conversations with visibility from registry
  const enrichedConversations = useMemo(() =>
    visibleConversations.map(c => ({ ...c, isVisible: visibleSessionIds.has(c.sessionId) })),
    [visibleConversations, visibleSessionIds]
  );

  const stats = useMemo(() => ({
    total: enrichedConversations.length,
    attention: enrichedConversations.filter(c => c.attentionState === 'needs_attention').length,
    working: enrichedConversations.filter(c => c.streamingId || c.attentionState === 'working').length,
    idle: enrichedConversations.filter(c => !c.streamingId && c.attentionState !== 'working' && c.attentionState !== 'needs_attention').length,
    visible: enrichedConversations.filter(c => c.isVisible).length,
    orphans: visibleSessionIds.size > 0 ? enrichedConversations.filter(c => !c.isVisible).length : 0,
  }), [enrichedConversations]);

  const selectedConvId = selectedConv ? `${selectedConv.accountId}-${selectedConv.sessionId}` : null;

  // Split into active (top) and finished (bottom)
  const projectFiltered = useMemo(() => {
    return selectedProject
      ? enrichedConversations.filter(c => c.projectName === selectedProject)
      : enrichedConversations;
  }, [enrichedConversations, selectedProject]);

  const sortByPriority = (list: Conversation[]) => [...list].sort((a, b) => {
    const scoreOf = (c: Conversation) => {
      if (c.attentionState === 'needs_attention') return 4;
      if (c.streamingId || c.attentionState === 'working') return 3;
      if (c.status === 'ongoing') return 2;
      return 1;
    };
    const diff = scoreOf(b) - scoreOf(a);
    if (diff !== 0) return diff;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });

  const displayedConvs = useMemo(() =>
    sortByPriority(projectFiltered.filter(c => !c.manualFinished)),
    [projectFiltered]);

  const finishedConvs = useMemo(() =>
    projectFiltered.filter(c => c.manualFinished)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
    [projectFiltered]);

  // Fetch snippets (last lines of conversation) when previews are expanded
  useEffect(() => {
    if (!showPreviews) return;
    if (displayedConvs.length === 0) return;

    const toFetch = displayedConvs.slice(0, 30);
    let cancelled = false;

    Promise.allSettled(
      toFetch.map(conv =>
        fetch(`${API}/mission/conversation/${conv.accountId}/${conv.sessionId}?tail=3`)
          .then(r => r.json())
          .then((data: ConversationDetail) => {
            const msgs = data.messages || [];
            const lastAssistant = [...msgs].reverse().find(m => m.role === 'assistant');
            if (!lastAssistant) return { sessionId: conv.sessionId, snippet: '' };
            const text = extractText(lastAssistant.content);
            // Take meaningful lines, skip empty ones, limit to ~400 chars
            const lines = text.split('\n').filter(l => l.trim());
            const preview = lines.slice(-8).join('\n');
            return { sessionId: conv.sessionId, snippet: preview.length > 400 ? preview.slice(-400) : preview };
          })
          .catch(() => ({ sessionId: conv.sessionId, snippet: '' }))
      )
    ).then(results => {
      if (cancelled) return;
      const next = new Map<string, string>();
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value.snippet) {
          next.set(r.value.sessionId, r.value.snippet);
        }
      }
      setSnippets(next);
    });

    return () => { cancelled = true; };
  }, [showPreviews, displayedConvs]);

  // Actions
  const handleSend = useCallback((conv: Conversation, message: string) => {
    fetch(`${API}/mission/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: conv.accountId, sessionId: conv.sessionId, message, workDir: conv.projectPath }),
    }).then(() => { setTimeout(fetchConversations, 2000); }).catch(() => {});
  }, [fetchConversations]);

  const handleStop = useCallback((conv: Conversation) => {
    fetch(`${API}/mission/conversation/${conv.accountId}/${conv.sessionId}/stop`, { method: 'POST' })
      .then(() => { setTimeout(fetchConversations, 1000); }).catch(() => {});
  }, [fetchConversations]);

  const handleNameChange = useCallback((conv: Conversation, name: string) => {
    fetch(`${API}/mission/conversation/${conv.accountId}/${conv.sessionId}/name`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ custom_name: name }),
    }).then(() => { setTimeout(fetchConversations, 500); }).catch(() => {});
  }, [fetchConversations]);

  const handlePermission = useCallback((_conv: Conversation, permId: string, action: 'approve' | 'deny') => {
    fetch(`${API}/mission/permissions/${_conv.accountId}/${permId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }),
    }).catch(() => {});
  }, []);

  const handleNewConversation = useCallback((accountId: string, wd: string, subject: string, message: string) => {
    fetch(`${API}/mission/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId, workDir: wd, subject, message }),
    }).then(() => { setShowNewDialog(false); setTimeout(fetchConversations, 2000); }).catch(() => {});
  }, [fetchConversations]);

  const convKey = (conv: Conversation) => `${conv.accountId}-${conv.sessionId}`;

  const toggleCheck = useCallback((conv: Conversation, checked: boolean) => {
    setCheckedConvs(prev => {
      const next = new Set(prev);
      const key = `${conv.accountId}-${conv.sessionId}`;
      if (checked) next.add(key); else next.delete(key);
      return next;
    });
  }, []);

  const handleBulkContinue = useCallback(() => {
    const targets = displayedConvs.filter(c => checkedConvs.has(convKey(c)));
    if (targets.length === 0) return;
    setBulkStatus(`Sende continue an ${targets.length}...`);
    const promises = targets.map(conv =>
      fetch(`${API}/mission/send`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: conv.accountId, sessionId: conv.sessionId, message: 'continue', workDir: conv.projectPath }),
      }).catch(() => {})
    );
    Promise.all(promises).then(() => {
      setBulkStatus(`${targets.length} gesendet`);
      setCheckedConvs(new Set());
      setTimeout(() => { setBulkStatus(null); fetchConversations(); }, 2000);
    });
  }, [displayedConvs, checkedConvs, fetchConversations]);

  const handleBulkAccountSwitch = useCallback((newAccountId: string) => {
    const targets = displayedConvs.filter(c => checkedConvs.has(convKey(c)));
    if (targets.length === 0) return;
    const label = ACCOUNTS.find(a => a.id === newAccountId)?.label || newAccountId;
    setBulkStatus(`Wechsle ${targets.length} zu ${label}...`);
    const promises = targets.map(conv =>
      fetch(`${API}/mission/conversation/${conv.sessionId}/assign`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: newAccountId }),
      }).catch(() => {})
    );
    Promise.all(promises).then(() => {
      setBulkStatus(`${targets.length} → ${label}`);
      setCheckedConvs(new Set());
      setTimeout(() => { setBulkStatus(null); fetchConversations(); }, 2000);
    });
  }, [displayedConvs, checkedConvs, fetchConversations]);

  const handleSelectAll = useCallback(() => {
    const allKeys = new Set(displayedConvs.map(convKey));
    const allChecked = displayedConvs.every(c => checkedConvs.has(convKey(c)));
    setCheckedConvs(allChecked ? new Set() : allKeys);
  }, [displayedConvs, checkedConvs]);

  // Activate: open selected conversations as panels in their project layouts
  const handleActivateSelected = useCallback(() => {
    const targets = displayedConvs.filter(c => checkedConvs.has(convKey(c)));
    if (targets.length === 0) return;
    setBulkStatus(`Aktiviere ${targets.length}...`);
    fetch(`${API}/mission/activate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversations: targets.map(c => ({ sessionId: c.sessionId, accountId: c.accountId, projectName: c.projectName })) }),
    }).then(r => r.json()).then(() => {
      setBulkStatus(`${targets.length} aktiviert`);
      setCheckedConvs(new Set());
      setTimeout(() => setBulkStatus(null), 3000);
    }).catch(() => {
      setBulkStatus('Aktivierung fehlgeschlagen');
      setTimeout(() => setBulkStatus(null), 3000);
    });
  }, [displayedConvs, checkedConvs]);

  // Single conversation activate (from "Open" button on orphan cards)
  const handleActivateSingle = useCallback((conv: Conversation) => {
    setBulkStatus('Aktiviere...');
    fetch(`${API}/mission/activate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversations: [{ sessionId: conv.sessionId, accountId: conv.accountId, projectName: conv.projectName }] }),
    }).then(() => {
      setBulkStatus('Aktiviert');
      setTimeout(() => setBulkStatus(null), 2000);
    }).catch(() => {
      setBulkStatus('Fehlgeschlagen');
      setTimeout(() => setBulkStatus(null), 2000);
    });
  }, []);

  const handleFinish = useCallback((conv: Conversation) => {
    fetch(`${API}/mission/conversation/${conv.sessionId}/finish`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ finished: true }),
    }).then(() => { setTimeout(fetchConversations, 500); }).catch(() => {});
  }, [fetchConversations]);

  const handleDelete = useCallback((conv: Conversation) => {
    if (!confirm(`"${conv.customName || conv.summary?.slice(0, 40) || conv.sessionId}" wirklich loeschen? Die .jsonl Datei wird unwiderruflich geloescht.`)) return;
    fetch(`${API}/mission/conversation/${conv.sessionId}`, { method: 'DELETE' })
      .then(r => r.json())
      .then(data => {
        if (data.ok) {
          // Deselect if this was the selected conversation
          if (selectedConv?.sessionId === conv.sessionId) setSelectedConv(null);
          setTimeout(fetchConversations, 500);
        }
      })
      .catch(() => {});
  }, [fetchConversations, selectedConv]);

  const handleBulkFinish = useCallback(() => {
    const targets = displayedConvs.filter(c => checkedConvs.has(convKey(c)));
    if (targets.length === 0) return;
    setBulkStatus(`Markiere ${targets.length} als fertig...`);
    Promise.all(targets.map(c =>
      fetch(`${API}/mission/conversation/${c.sessionId}/finish`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ finished: true }),
      }).catch(() => {})
    )).then(() => {
      setBulkStatus(`${targets.length} fertig`);
      setCheckedConvs(new Set());
      setTimeout(() => { setBulkStatus(null); fetchConversations(); }, 2000);
    });
  }, [displayedConvs, checkedConvs, fetchConversations]);

  const handleAutoTitles = useCallback(() => {
    setAutoTitleStatus('...');
    fetch(`${API}/mission/auto-titles`, { method: 'POST' }).then(r => r.json())
      .then(data => { setAutoTitleStatus(`${data.updated} Titel`); setTimeout(() => { setAutoTitleStatus(null); fetchConversations(); }, 2000); })
      .catch(() => setAutoTitleStatus('Fehler'));
  }, [fetchConversations]);

  const handleRebuild = useCallback(() => {
    if (!confirm('Frontend neu bauen und Server neustarten? (App ist kurz offline)')) return;
    setBulkStatus('Rebuilding...');
    fetch(`${API}/rebuild`, { method: 'POST' }).then(r => r.json())
      .then(() => {
        setBulkStatus('Build laeuft, reload in 8s...');
        setTimeout(() => window.location.reload(), 8000);
      })
      .catch(() => setBulkStatus('Rebuild fehlgeschlagen'));
  }, []);

  const toggleSync = useCallback(() => {
    setSyncEnabled(prev => {
      const next = !prev;
      try { localStorage.setItem('mc-sync', next ? 'on' : 'off'); } catch {}
      if (next) fetchConversations();
      return next;
    });
  }, [fetchConversations]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--tn-surface)' }}>

      {/* ===== GLOBAL STATUS BAR ===== */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '4px 12px', background: 'var(--tn-bg-dark)',
        borderBottom: '1px solid var(--tn-border)', flexShrink: 0,
      }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--tn-text)' }}>Mission Control</span>
        <span style={{ fontSize: 10, color: 'var(--tn-text-muted)' }}>
          {stats.orphans > 0 && <span style={{ color: '#EF4444', fontWeight: 700 }}>{stats.orphans} orphan{stats.orphans > 1 ? 's' : ''} </span>}
          {stats.attention > 0 && <span style={{ color: '#F59E0B', fontWeight: 700 }}>{stats.attention} braucht dich </span>}
          {stats.working > 0 && <span style={{ color: '#3B82F6', fontWeight: 600 }}>{stats.working} arbeitet </span>}
          {stats.visible > 0 && <span style={{ color: '#10B981' }}>{stats.visible} sichtbar </span>}
          <span>{stats.total} total</span>
        </span>
        <div style={{ flex: 1 }} />
        {bulkStatus && <span style={{ fontSize: 9, color: '#F59E0B', fontWeight: 600 }}>{bulkStatus}</span>}
        {autoTitleStatus && <span style={{ fontSize: 9, color: '#10B981', fontWeight: 600 }}>{autoTitleStatus}</span>}

        <button onClick={toggleSync} style={{
          padding: '2px 8px', borderRadius: 3, fontSize: 9, cursor: 'pointer',
          background: syncEnabled ? 'rgba(16,185,129,0.15)' : 'var(--tn-bg)',
          border: `1px solid ${syncEnabled ? '#10B981' : 'var(--tn-border)'}`,
          color: syncEnabled ? '#10B981' : 'var(--tn-text-muted)', fontWeight: 600,
        }}>
          {syncEnabled ? 'Sync ON' : 'Sync OFF'}
        </button>

        <button onClick={() => {
          setShowPreviews(prev => { const next = !prev; try { localStorage.setItem('mc-show-previews', next ? '1' : '0'); } catch {} return next; });
        }} style={{
          padding: '2px 8px', borderRadius: 3, fontSize: 9, cursor: 'pointer',
          background: showPreviews ? 'rgba(122,162,247,0.15)' : 'var(--tn-bg)',
          border: `1px solid ${showPreviews ? 'var(--tn-blue)' : 'var(--tn-border)'}`,
          color: showPreviews ? 'var(--tn-blue)' : 'var(--tn-text-muted)', fontWeight: 600,
        }}>{showPreviews ? 'Kompakt' : 'Expand'}</button>

        <button onClick={handleAutoTitles} style={{
          background: 'none', border: '1px solid var(--tn-border)', color: 'var(--tn-text-muted)',
          cursor: 'pointer', fontSize: 9, padding: '2px 8px', borderRadius: 3,
        }}>Titel</button>

        <button onClick={handleRebuild} title="Frontend neu bauen & Server neustarten" style={{
          padding: '2px 8px', borderRadius: 3, fontSize: 9, cursor: 'pointer',
          background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)',
          color: '#EF4444', fontWeight: 600,
        }}>Rebuild</button>

        <button onClick={fetchConversations} style={{
          background: 'none', border: 'none', color: 'var(--tn-text-muted)',
          cursor: 'pointer', fontSize: 14, padding: '1px 4px',
        }}>&#8635;</button>

        <button onClick={() => setShowNewDialog(true)} style={{
          padding: '2px 10px', borderRadius: 3, fontSize: 10, cursor: 'pointer',
          background: '#3B82F6', border: 'none', color: '#fff', fontWeight: 600,
        }}>+ Neu</button>

        <button onClick={() => setShowCommander(prev => !prev)} style={{
          padding: '2px 8px', borderRadius: 3, fontSize: 12, cursor: 'pointer',
          background: showCommander ? '#10B981' : 'var(--tn-bg)',
          border: `1px solid ${showCommander ? '#10B981' : 'var(--tn-border)'}`,
          color: showCommander ? '#fff' : 'var(--tn-text)', fontWeight: 600,
        }}>&#129504;</button>
      </div>

      {/* ===== BULK ACTION BAR ===== */}
      {checkedConvs.size > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '5px 12px', background: 'rgba(16,185,129,0.1)',
          borderBottom: '1px solid rgba(16,185,129,0.3)', flexShrink: 0,
        }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: '#10B981' }}>
            {checkedConvs.size} ausgewaehlt
          </span>
          {bulkStatus && <span style={{ fontSize: 10, color: '#10B981' }}>{bulkStatus}</span>}
          <div style={{ flex: 1 }} />
          <button onClick={handleSelectAll} style={{
            padding: '3px 10px', borderRadius: 3, fontSize: 10, cursor: 'pointer',
            background: 'none', border: '1px solid var(--tn-border)', color: 'var(--tn-text-muted)', fontWeight: 600,
          }}>
            {displayedConvs.every(c => checkedConvs.has(convKey(c))) ? 'Keine' : 'Alle'}
          </button>
          <button onClick={() => setCheckedConvs(new Set())} style={{
            padding: '3px 10px', borderRadius: 3, fontSize: 10, cursor: 'pointer',
            background: 'none', border: '1px solid var(--tn-border)', color: 'var(--tn-text-muted)', fontWeight: 600,
          }}>Abwaehlen</button>
          <button onClick={handleBulkContinue} style={{
            padding: '4px 14px', borderRadius: 4, fontSize: 11, cursor: 'pointer',
            background: '#10B981', border: 'none', color: '#fff', fontWeight: 700,
          }}>
            Continue ({checkedConvs.size})
          </button>
          <button onClick={handleActivateSelected} style={{
            padding: '4px 14px', borderRadius: 4, fontSize: 11, cursor: 'pointer',
            background: '#8B5CF6', border: 'none', color: '#fff', fontWeight: 700,
          }}>
            Aktivieren ({checkedConvs.size})
          </button>
          <button onClick={handleBulkFinish} style={{
            padding: '4px 14px', borderRadius: 4, fontSize: 11, cursor: 'pointer',
            background: 'rgba(16,185,129,0.15)', border: '1px solid #10B981', color: '#10B981', fontWeight: 700,
          }}>
            &#10003; Fertig ({checkedConvs.size})
          </button>
          <span style={{ fontSize: 10, color: 'var(--tn-text-muted)', margin: '0 2px' }}>|</span>
          <span style={{ fontSize: 10, color: 'var(--tn-text-muted)' }}>Account:</span>
          {ACCOUNTS.map(a => (
            <button key={a.id} onClick={() => handleBulkAccountSwitch(a.id)} style={{
              padding: '3px 10px', borderRadius: 3, fontSize: 10, cursor: 'pointer',
              background: a.color || '#2563eb', border: 'none', color: '#1a1b26', fontWeight: 600,
            }}>
              {a.label.slice(0, 3).toUpperCase()}
            </button>
          ))}
        </div>
      )}

      {/* ===== 3-PANEL SPLIT ===== */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0, position: 'relative' }}>

        {/* SIDEBAR (220px): Projects + Controls */}
        <div style={{
          width: 220, flexShrink: 0, display: 'flex', flexDirection: 'column',
          borderRight: '1px solid var(--tn-border)', background: 'var(--tn-bg-dark)',
        }}>
          {/* Project list header */}
          <div style={{ padding: '6px 10px', borderBottom: '1px solid var(--tn-border)', display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--tn-text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Projekte</span>
            <span style={{ fontSize: 9, color: 'var(--tn-text-subtle)' }}>({groups.length})</span>
            {hiddenProjects.size > 0 && <span style={{ fontSize: 9, color: '#F59E0B' }}>+{hiddenProjects.size} hidden</span>}
          </div>

          {/* All projects button */}
          <div className="mc-sidebar-item" onClick={() => setSelectedProject(null)}
            style={{
              padding: '5px 10px', cursor: 'pointer', fontSize: 11, fontWeight: 600,
              color: !selectedProject ? '#3B82F6' : 'var(--tn-text)',
              background: !selectedProject ? 'rgba(59,130,246,0.1)' : 'transparent',
              borderBottom: '1px solid var(--tn-border)',
            }}>
            Alle ({visibleConversations.length})
          </div>

          {/* Project list */}
          <div style={{ flex: 1, overflow: 'auto' }}>
            {groups.map(g => (
              <div key={g.name} className="mc-sidebar-item"
                onClick={() => setSelectedProject(prev => prev === g.name ? null : g.name)}
                style={{
                  padding: '5px 10px', cursor: 'pointer',
                  borderLeft: `3px solid ${selectedProject === g.name ? '#3B82F6' : g.attentionCount > 0 ? '#F59E0B' : g.workingCount > 0 ? '#3B82F6' : g.activeCount > 0 ? 'rgba(245,158,11,0.3)' : 'transparent'}`,
                  background: selectedProject === g.name ? 'rgba(59,130,246,0.08)' : 'transparent',
                }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{
                    fontSize: 11, fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    color: selectedProject === g.name ? '#3B82F6' : 'var(--tn-text)',
                  }}>
                    {g.name}
                  </span>
                  <AccountDots accounts={g.accounts} />
                </div>
                <div style={{ display: 'flex', gap: 6, fontSize: 9, color: 'var(--tn-text-subtle)', marginTop: 1 }}>
                  <span>{g.conversations.length}</span>
                  {g.attentionCount > 0 && <span style={{ color: '#F59E0B', fontWeight: 700 }}>{g.attentionCount} wartet</span>}
                  {g.workingCount > 0 && <span style={{ color: '#3B82F6', fontWeight: 600 }}>{g.workingCount} aktiv</span>}
                </div>
              </div>
            ))}

            {/* Hidden projects section */}
            {allGroups.filter(g => hiddenProjects.has(g.name)).length > 0 && (
              <>
                <div style={{ padding: '6px 10px', fontSize: 9, color: 'var(--tn-text-subtle)', borderTop: '1px solid var(--tn-border)', marginTop: 4, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  Ausgeblendet
                </div>
                {allGroups.filter(g => hiddenProjects.has(g.name)).map(g => (
                  <div key={g.name} className="mc-sidebar-item"
                    onClick={() => toggleProjectVisibility(g.name)}
                    style={{ padding: '4px 10px', cursor: 'pointer', opacity: 0.4 }}>
                    <span style={{ fontSize: 10, color: 'var(--tn-text-muted)' }}>{g.name}</span>
                  </div>
                ))}
              </>
            )}
          </div>

          {/* Sidebar footer: Sync status */}
          {!syncEnabled && (
            <div style={{ padding: '6px 10px', borderTop: '1px solid var(--tn-border)', fontSize: 10, color: '#EF4444', fontWeight: 600, textAlign: 'center' }}>
              Sync OFF
            </div>
          )}
        </div>

        {/* MAIN: Session Card Grid */}
        <div style={{ flex: 1, overflow: 'auto', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
          {/* Filter header */}
          {selectedProject && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 4px', marginBottom: 2 }}>
              <button onClick={() => setSelectedProject(null)} style={{ background: 'none', border: 'none', color: 'var(--tn-text-muted)', cursor: 'pointer', fontSize: 14 }}>&#8592;</button>
              <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--tn-text)' }}>{selectedProject}</span>
              <span style={{ fontSize: 10, color: 'var(--tn-text-muted)' }}>{displayedConvs.length} Sessions</span>
            </div>
          )}

          {!syncEnabled && conversations.length === 0 ? (
            <div style={{ padding: 30, textAlign: 'center', color: 'var(--tn-text-muted)', fontSize: 12 }}>
              Sync deaktiviert - klicke Sync ON zum Laden
            </div>
          ) : loading ? (
            <div style={{ padding: 30, textAlign: 'center', color: 'var(--tn-text-muted)', fontSize: 12 }}>Lade Sessions...</div>
          ) : displayedConvs.length === 0 && finishedConvs.length === 0 ? (
            <div style={{ padding: 30, textAlign: 'center', color: 'var(--tn-text-muted)', fontSize: 12 }}>
              {selectedProject ? 'Keine Sessions in diesem Projekt' : 'Keine Sessions gefunden'}
            </div>
          ) : selectedProject ? (
            /* Single project view - flat list */
            <>
              {displayedConvs.map(conv => (
                <SessionCard key={`${conv.accountId}-${conv.sessionId}`}
                  conv={conv}
                  isSelected={selectedConvId === `${conv.accountId}-${conv.sessionId}`}
                  onClick={() => setSelectedConv(conv)}
                  checked={checkedConvs.has(convKey(conv))}
                  onCheck={(checked) => toggleCheck(conv, checked)}
                  onActivate={handleActivateSingle}
                  onFinish={handleFinish}
                  panelLabel={panelMap.get(conv.sessionId)}
                  expanded={showPreviews}
                  snippet={snippets.get(conv.sessionId)}
                />
              ))}
              {finishedConvs.length > 0 && (
                <>
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 8, padding: '8px 4px 4px',
                    borderTop: '1px solid var(--tn-border)', marginTop: 4,
                  }}>
                    <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--tn-text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                      Abgeschlossen ({finishedConvs.length})
                    </span>
                  </div>
                  {finishedConvs.map(conv => (
                    <SessionCard key={`${conv.accountId}-${conv.sessionId}`}
                      conv={conv}
                      isSelected={selectedConvId === `${conv.accountId}-${conv.sessionId}`}
                      onClick={() => setSelectedConv(conv)}
                      onDelete={handleDelete}
                      panelLabel={panelMap.get(conv.sessionId)}
                      expanded={showPreviews}
                      snippet={snippets.get(conv.sessionId)}
                    />
                  ))}
                </>
              )}
            </>
          ) : (
            /* ALL view - grouped by project with headers */
            <>
              {groups.map(group => {
                const groupActive = group.conversations.filter(c => !c.manualFinished);
                const groupFinished = group.conversations.filter(c => c.manualFinished);
                const sortedActive = sortByPriority(groupActive);
                return (
                  <div key={group.name} style={{ marginBottom: 4 }}>
                    {/* Project group header */}
                    <div
                      onClick={() => setSelectedProject(group.name)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        padding: '6px 8px', marginBottom: 4, cursor: 'pointer',
                        borderLeft: `3px solid ${group.attentionCount > 0 ? '#F59E0B' : group.workingCount > 0 ? '#3B82F6' : group.activeCount > 0 ? '#10B981' : 'var(--tn-border)'}`,
                        background: 'rgba(255,255,255,0.03)', borderRadius: '0 4px 4px 0',
                      }}>
                      <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--tn-text)' }}>{group.name}</span>
                      <AccountDots accounts={group.accounts} />
                      <span style={{ fontSize: 10, color: 'var(--tn-text-muted)' }}>{groupActive.length} Sessions</span>
                      {group.attentionCount > 0 && <span style={{ fontSize: 9, color: '#F59E0B', fontWeight: 700 }}>{group.attentionCount} wartet</span>}
                      {group.workingCount > 0 && <span style={{ fontSize: 9, color: '#3B82F6', fontWeight: 600 }}>{group.workingCount} aktiv</span>}
                    </div>
                    {/* Active sessions */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingLeft: 6 }}>
                      {sortedActive.map(conv => (
                        <SessionCard key={`${conv.accountId}-${conv.sessionId}`}
                          conv={conv}
                          isSelected={selectedConvId === `${conv.accountId}-${conv.sessionId}`}
                          onClick={() => setSelectedConv(conv)}
                          checked={checkedConvs.has(convKey(conv))}
                          onCheck={(checked) => toggleCheck(conv, checked)}
                          onActivate={handleActivateSingle}
                          onFinish={handleFinish}
                          panelLabel={panelMap.get(conv.sessionId)}
                          expanded={showPreviews}
                          snippet={snippets.get(conv.sessionId)}
                        />
                      ))}
                    </div>
                    {/* Finished sessions (collapsed) */}
                    {groupFinished.length > 0 && (
                      <div style={{ paddingLeft: 6, marginTop: 2 }}>
                        <div style={{ fontSize: 9, color: 'var(--tn-text-subtle)', padding: '2px 4px' }}>
                          +{groupFinished.length} abgeschlossen
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </>
          )}
        </div>

        {/* DETAIL PANEL (right, 380px when a conversation is selected) */}
        {selectedConv && (
          <div style={{ width: 380, flexShrink: 0, borderLeft: '1px solid var(--tn-border)', display: 'flex', flexDirection: 'column' }}>
            <PreviewPanel
              conv={selectedConv}
              onSend={(msg) => handleSend(selectedConv, msg)}
              onStop={() => handleStop(selectedConv)}
              onNameChange={(name) => handleNameChange(selectedConv, name)}
              onPermission={(permId, action) => handlePermission(selectedConv, permId, action)}
            />
          </div>
        )}

        {/* Commander overlay */}
        {showCommander && <CommanderPanel onClose={() => setShowCommander(false)} />}
      </div>

      {showNewDialog && (
        <NewConversationDialog projects={projects} onStart={handleNewConversation} onClose={() => setShowNewDialog(false)} />
      )}
    </div>
  );
}
