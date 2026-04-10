/**
 * PartnerInboxPanel — Partner Messaging Inbox
 *
 * Admin: can send announcements + direct messages, sees all messages.
 * Partner: sees own messages + announcements, can reply.
 *
 * Auto-refreshes via WebSocket (partner-message-new, partner-message-read events).
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '../../contexts/AuthContext';

const API = '/api';

interface PartnerMessage {
  id: string;
  from: string;
  to: string;
  type: 'announcement' | 'direct' | 'system';
  subject: string;
  body: string;
  createdAt: string;
  readAt: string | null;
}

const TYPE_COLORS: Record<string, string> = {
  announcement: 'var(--tn-orange)',
  direct: 'var(--tn-blue)',
  system: 'var(--tn-text-muted)',
};

const TYPE_LABELS: Record<string, string> = {
  announcement: 'Ankündigung',
  direct: 'Direkt',
  system: 'System',
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

interface PartnerInboxPanelProps {
  projectId: string;
}

export default function PartnerInboxPanel({ projectId: _projectId }: PartnerInboxPanelProps) {
  const { user, authEnabled } = useAuth();
  const isAdmin = !authEnabled || !user || user.role === 'admin';
  const userId = user?.id ?? 'admin';

  const [messages, setMessages] = useState<PartnerMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'all' | 'announcements' | 'direct'>('all');

  // Send form state
  const [sendTo, setSendTo] = useState('all');
  const [sendType, setSendType] = useState<'announcement' | 'direct' | 'system'>('announcement');
  const [sendSubject, setSendSubject] = useState('');
  const [sendBody, setSendBody] = useState('');
  const [sending, setSending] = useState(false);
  const [sendStatus, setSendStatus] = useState<'idle' | 'ok' | 'error'>('idle');
  const [sendError, setSendError] = useState('');

  // Reply state
  const [replyBody, setReplyBody] = useState('');
  const [replying, setReplying] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);

  // --- Load messages ---
  const loadMessages = useCallback(async () => {
    if ((window as any).__cuiServerAlive === false) return;
    try {
      const res = await fetch(`${API}/partner/messages?userId=${encodeURIComponent(userId)}`, {
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setMessages(data.messages ?? []);
      setError(null);
    } catch (err: any) {
      setError(err.message || 'Fehler beim Laden');
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    loadMessages();
  }, [loadMessages]);

  // --- WebSocket for live updates ---
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${protocol}://${window.location.host}/ws`);
    wsRef.current = ws;
    ws.onerror = () => {};

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'partner-message-new') {
          setMessages(prev => {
            const m = msg.message as PartnerMessage;
            // Only add if relevant for this user
            const relevant = isAdmin || m.to === userId || m.to === 'all' || m.from === userId;
            if (!relevant) return prev;
            // Deduplicate
            if (prev.some(p => p.id === m.id)) return prev;
            return [m, ...prev];
          });
        } else if (msg.type === 'partner-message-read') {
          setMessages(prev => prev.map(m =>
            m.id === msg.messageId ? { ...m, readAt: msg.readAt } : m,
          ));
        }
      } catch { /* malformed WS message */ }
    };

    return () => {
      ws.close();
    };
  }, [isAdmin, userId]);

  // --- Mark as read when selected ---
  const handleSelect = useCallback(async (msg: PartnerMessage) => {
    setSelectedId(msg.id);
    setReplyBody('');

    if (msg.readAt !== null || msg.from === userId) return;

    try {
      await fetch(`${API}/partner/messages/${msg.id}/read`, {
        method: 'POST',
        signal: AbortSignal.timeout(5000),
      });
      // Optimistic update — WS broadcast will confirm
      setMessages(prev => prev.map(m =>
        m.id === msg.id ? { ...m, readAt: new Date().toISOString() } : m,
      ));
    } catch { /* non-critical */ }
  }, [userId]);

  // --- Send message (admin) ---
  const handleSend = useCallback(async () => {
    if (!sendBody.trim()) return;
    setSending(true);
    setSendStatus('idle');
    setSendError('');

    try {
      const res = await fetch(`${API}/partner/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: userId,
          to: sendTo || 'all',
          type: sendType,
          subject: sendSubject,
          body: sendBody,
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Fehler' }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }

      setSendStatus('ok');
      setSendBody('');
      setSendSubject('');
      setSendTo('all');
      setTimeout(() => setSendStatus('idle'), 2000);
    } catch (err: any) {
      setSendStatus('error');
      setSendError(err.message || 'Senden fehlgeschlagen');
    } finally {
      setSending(false);
    }
  }, [userId, sendTo, sendType, sendSubject, sendBody]);

  // --- Reply (partner) ---
  const handleReply = useCallback(async (originalMsg: PartnerMessage) => {
    if (!replyBody.trim()) return;
    setReplying(true);

    try {
      const res = await fetch(`${API}/partner/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: userId,
          to: 'admin',
          type: 'direct',
          subject: originalMsg.subject ? `Re: ${originalMsg.subject}` : '',
          body: replyBody,
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      setReplyBody('');
    } catch (err: any) {
      console.error('[PartnerInboxPanel] Reply failed:', err);
    } finally {
      setReplying(false);
    }
  }, [userId, replyBody]);

  // --- Filter ---
  const filtered = messages.filter(m => {
    if (activeTab === 'announcements') return m.type === 'announcement';
    if (activeTab === 'direct') return m.type === 'direct';
    return true;
  });

  const unreadCount = messages.filter(m => m.readAt === null && m.from !== userId).length;
  const selectedMsg = selectedId ? messages.find(m => m.id === selectedId) : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--tn-surface)' }}>

      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 10px', borderBottom: '1px solid var(--tn-border)',
        background: 'var(--tn-bg-dark)', flexShrink: 0,
      }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--tn-text)', flex: 1 }}>
          Partner Inbox
        </span>
        {unreadCount > 0 && (
          <span style={{
            background: 'var(--tn-orange)', color: '#000', borderRadius: 10,
            padding: '1px 6px', fontSize: 9, fontWeight: 700,
          }}>
            {unreadCount}
          </span>
        )}
        <button
          onClick={loadMessages}
          title="Aktualisieren"
          style={{
            background: 'transparent', border: 'none', cursor: 'pointer',
            color: 'var(--tn-text-muted)', fontSize: 12, padding: '2px 4px',
          }}
        >
          ↻
        </button>
      </div>

      {/* Tabs */}
      <div style={{
        display: 'flex', background: 'var(--tn-bg-dark)',
        borderBottom: '1px solid var(--tn-border)', flexShrink: 0,
      }}>
        {(['all', 'announcements', 'direct'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            style={{
              flex: 1, background: activeTab === tab ? 'var(--tn-surface)' : 'transparent',
              color: activeTab === tab ? 'var(--tn-blue)' : 'var(--tn-text-muted)',
              border: 'none',
              borderBottom: activeTab === tab ? '2px solid var(--tn-blue)' : '2px solid transparent',
              padding: '4px 6px', fontSize: 10, cursor: 'pointer',
            }}
          >
            {tab === 'all' ? 'Alle' : tab === 'announcements' ? 'Ankündigungen' : 'Direkt'}
          </button>
        ))}
      </div>

      {/* Main content */}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>

        {/* Message list */}
        <div style={{
          width: selectedMsg ? '38%' : '100%',
          borderRight: selectedMsg ? '1px solid var(--tn-border)' : 'none',
          overflowY: 'auto', flexShrink: 0,
        }}>
          {loading && (
            <div style={{ padding: 16, color: 'var(--tn-text-muted)', fontSize: 11 }}>Lade…</div>
          )}
          {error && (
            <div style={{ padding: 12, color: 'var(--tn-red)', fontSize: 11 }}>{error}</div>
          )}
          {!loading && filtered.length === 0 && (
            <div style={{ padding: 16, color: 'var(--tn-text-muted)', fontSize: 11, textAlign: 'center' }}>
              Keine Nachrichten
            </div>
          )}
          {filtered.map(msg => {
            const isUnread = msg.readAt === null && msg.from !== userId;
            const isSelected = msg.id === selectedId;
            return (
              <div
                key={msg.id}
                onClick={() => handleSelect(msg)}
                style={{
                  padding: '8px 10px', cursor: 'pointer',
                  borderBottom: '1px solid var(--tn-border)',
                  background: isSelected ? 'var(--tn-bg-highlight)' : isUnread ? 'rgba(59,130,246,0.06)' : 'transparent',
                  borderLeft: isUnread ? '2px solid var(--tn-blue)' : '2px solid transparent',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2 }}>
                  <span style={{
                    fontSize: 9, padding: '1px 4px', borderRadius: 3,
                    background: `${TYPE_COLORS[msg.type]}22`,
                    color: TYPE_COLORS[msg.type], fontWeight: 600,
                  }}>
                    {TYPE_LABELS[msg.type]}
                  </span>
                  <span style={{ flex: 1, fontSize: 11, fontWeight: isUnread ? 600 : 400, color: 'var(--tn-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {msg.subject || msg.body.slice(0, 40)}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 10, color: 'var(--tn-text-muted)' }}>
                    Von: {msg.from}
                  </span>
                  <span style={{ fontSize: 9, color: 'var(--tn-text-muted)' }}>
                    {formatDate(msg.createdAt)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Message detail */}
        {selectedMsg && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {/* Detail header */}
            <div style={{
              padding: '8px 12px', borderBottom: '1px solid var(--tn-border)',
              background: 'var(--tn-bg-dark)', flexShrink: 0,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <span style={{
                  fontSize: 9, padding: '1px 5px', borderRadius: 3,
                  background: `${TYPE_COLORS[selectedMsg.type]}22`,
                  color: TYPE_COLORS[selectedMsg.type], fontWeight: 600,
                }}>
                  {TYPE_LABELS[selectedMsg.type]}
                </span>
                <button
                  onClick={() => setSelectedId(null)}
                  style={{
                    marginLeft: 'auto', background: 'transparent', border: 'none',
                    cursor: 'pointer', color: 'var(--tn-text-muted)', fontSize: 13, padding: '0 4px',
                  }}
                >
                  ✕
                </button>
              </div>
              {selectedMsg.subject && (
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--tn-text)', marginBottom: 2 }}>
                  {selectedMsg.subject}
                </div>
              )}
              <div style={{ fontSize: 10, color: 'var(--tn-text-muted)' }}>
                Von: <strong>{selectedMsg.from}</strong> → {selectedMsg.to} · {formatDate(selectedMsg.createdAt)}
                {selectedMsg.readAt && (
                  <span style={{ marginLeft: 8, color: 'var(--tn-green)', fontSize: 9 }}>
                    ✓ Gelesen {formatDate(selectedMsg.readAt)}
                  </span>
                )}
              </div>
            </div>

            {/* Body */}
            <div style={{
              flex: 1, overflowY: 'auto', padding: '12px',
              fontSize: 12, color: 'var(--tn-text)', lineHeight: 1.6,
              whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            }}>
              {selectedMsg.body}
            </div>

            {/* Reply area — only for partners replying to admin messages */}
            {!isAdmin && selectedMsg.from !== userId && (
              <div style={{
                borderTop: '1px solid var(--tn-border)', padding: '8px 10px',
                background: 'var(--tn-bg-dark)', flexShrink: 0,
              }}>
                <textarea
                  value={replyBody}
                  onChange={e => setReplyBody(e.target.value)}
                  placeholder="Antwort schreiben…"
                  rows={3}
                  style={{
                    width: '100%', resize: 'none', padding: '6px 8px',
                    background: 'var(--tn-bg)', color: 'var(--tn-text)',
                    border: '1px solid var(--tn-border)', borderRadius: 4,
                    fontSize: 11, fontFamily: 'inherit', boxSizing: 'border-box',
                    outline: 'none',
                  }}
                />
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
                  <button
                    onClick={() => handleReply(selectedMsg)}
                    disabled={replying || !replyBody.trim()}
                    style={{
                      padding: '4px 12px', borderRadius: 4, fontSize: 11, cursor: 'pointer',
                      background: replying || !replyBody.trim() ? 'var(--tn-border)' : 'var(--tn-blue)',
                      color: replying || !replyBody.trim() ? 'var(--tn-text-muted)' : '#fff',
                      border: 'none', fontWeight: 600,
                    }}
                  >
                    {replying ? 'Sende…' : 'Antworten'}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Admin Send Form */}
      {isAdmin && (
        <div style={{
          borderTop: '1px solid var(--tn-border)', padding: '8px 10px',
          background: 'var(--tn-bg-dark)', flexShrink: 0,
        }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--tn-text-muted)', marginBottom: 6 }}>
            NEUE NACHRICHT
          </div>
          <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
            <select
              value={sendType}
              onChange={e => setSendType(e.target.value as typeof sendType)}
              style={{
                background: 'var(--tn-bg)', color: 'var(--tn-text)',
                border: '1px solid var(--tn-border)', borderRadius: 3,
                fontSize: 10, padding: '2px 4px',
              }}
            >
              <option value="announcement">Ankündigung</option>
              <option value="direct">Direkt</option>
              <option value="system">System</option>
            </select>
            <input
              value={sendTo}
              onChange={e => setSendTo(e.target.value)}
              placeholder="An (userId oder 'all')"
              style={{
                flex: 1, background: 'var(--tn-bg)', color: 'var(--tn-text)',
                border: '1px solid var(--tn-border)', borderRadius: 3,
                fontSize: 10, padding: '2px 6px', outline: 'none',
              }}
            />
          </div>
          <input
            value={sendSubject}
            onChange={e => setSendSubject(e.target.value)}
            placeholder="Betreff (optional)"
            style={{
              width: '100%', background: 'var(--tn-bg)', color: 'var(--tn-text)',
              border: '1px solid var(--tn-border)', borderRadius: 3,
              fontSize: 10, padding: '2px 6px', marginBottom: 4,
              outline: 'none', boxSizing: 'border-box',
            }}
          />
          <textarea
            value={sendBody}
            onChange={e => setSendBody(e.target.value)}
            placeholder="Nachricht…"
            rows={3}
            style={{
              width: '100%', resize: 'none', padding: '5px 7px',
              background: 'var(--tn-bg)', color: 'var(--tn-text)',
              border: '1px solid var(--tn-border)', borderRadius: 3,
              fontSize: 11, fontFamily: 'inherit', boxSizing: 'border-box',
              outline: 'none', marginBottom: 4,
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
            {sendStatus === 'ok' && (
              <span style={{ fontSize: 10, color: 'var(--tn-green)' }}>✓ Gesendet</span>
            )}
            {sendStatus === 'error' && (
              <span style={{ fontSize: 10, color: 'var(--tn-red)' }}>{sendError}</span>
            )}
            <button
              onClick={handleSend}
              disabled={sending || !sendBody.trim()}
              style={{
                padding: '4px 14px', borderRadius: 4, fontSize: 11, cursor: 'pointer',
                background: sending || !sendBody.trim() ? 'var(--tn-border)' : 'var(--tn-blue)',
                color: sending || !sendBody.trim() ? 'var(--tn-text-muted)' : '#fff',
                border: 'none', fontWeight: 600,
              }}
            >
              {sending ? 'Sende…' : 'Senden'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
