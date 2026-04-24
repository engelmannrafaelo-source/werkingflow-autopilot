import { useState, useEffect, useCallback } from 'react';

// ── Types ────────────────────────────────────────────────────────────────────

interface InboxMessage {
  uid: number;
  from: string;
  to: string;
  subject: string;
  date: string;
  seen: boolean;
  size: number;
}

interface MessageDetail {
  uid: number;
  from: string;
  to: string;
  cc: string;
  subject: string;
  date: string | null;
  text: string;
  html: string | null;
  attachments: Array<{ filename: string; size: number; contentType: string }>;
}

interface Draft {
  id: string;
  createdAt: string;
  updatedAt: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  status: 'draft' | 'sent' | 'failed';
  sentAt: string | null;
  error: string | null;
  messageId: string | null;
}

interface MailConfigStatus {
  configured: boolean;
  email?: string;
  fromName?: string;
  imap?: { host: string; port: number };
  smtp?: { host: string; port: number };
  hint?: string;
}

type Tab = 'inbox' | 'drafts' | 'compose';

const EMPTY_COMPOSE = {
  id: '',
  to: '',
  cc: '',
  bcc: '',
  subject: '',
  body: '',
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: 'short', year: 'numeric' });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Component ────────────────────────────────────────────────────────────────

export default function MailPanel() {
  const [tab, setTab] = useState<Tab>('inbox');
  const [config, setConfig] = useState<MailConfigStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Inbox
  const [messages, setMessages] = useState<InboxMessage[]>([]);
  const [loadingInbox, setLoadingInbox] = useState(false);
  const [selectedMsg, setSelectedMsg] = useState<MessageDetail | null>(null);
  const [loadingMsg, setLoadingMsg] = useState(false);

  // Drafts
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loadingDrafts, setLoadingDrafts] = useState(false);

  // Compose / Edit
  const [compose, setCompose] = useState(EMPTY_COMPOSE);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);

  // ── Config ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    fetch('/api/mail/config')
      .then(r => r.json())
      .then((c: MailConfigStatus) => setConfig(c))
      .catch(e => setError(String(e)));
  }, []);

  // ── Inbox ───────────────────────────────────────────────────────────────────

  const loadInbox = useCallback(async () => {
    setLoadingInbox(true);
    setError(null);
    try {
      const r = await fetch('/api/mail/messages?folder=INBOX&limit=50');
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
      const data = await r.json() as { messages: InboxMessage[] };
      setMessages(data.messages);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingInbox(false);
    }
  }, []);

  const openMessage = async (uid: number) => {
    setLoadingMsg(true);
    setError(null);
    try {
      const r = await fetch(`/api/mail/messages/${uid}?folder=INBOX`);
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
      const data = await r.json() as { message: MessageDetail };
      setSelectedMsg(data.message);
      setMessages(ms => ms.map(m => m.uid === uid ? { ...m, seen: true } : m));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingMsg(false);
    }
  };

  const replyToMessage = (msg: MessageDetail) => {
    setCompose({
      id: '',
      to: msg.from,
      cc: '',
      bcc: '',
      subject: msg.subject.startsWith('Re:') ? msg.subject : `Re: ${msg.subject}`,
      body: `\n\n-------- Ursprüngliche Nachricht --------\nVon: ${msg.from}\nDatum: ${msg.date || ''}\nBetreff: ${msg.subject}\n\n${msg.text}`,
    });
    setSelectedMsg(null);
    setTab('compose');
  };

  // ── Drafts ──────────────────────────────────────────────────────────────────

  const loadDrafts = useCallback(async () => {
    setLoadingDrafts(true);
    setError(null);
    try {
      const r = await fetch('/api/mail/drafts');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json() as { drafts: Draft[] };
      setDrafts(data.drafts);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingDrafts(false);
    }
  }, []);

  const openDraft = (d: Draft) => {
    setCompose({
      id: d.id,
      to: d.to,
      cc: d.cc,
      bcc: d.bcc,
      subject: d.subject,
      body: d.body,
    });
    setTab('compose');
  };

  const saveDraft = async () => {
    setSaving(true);
    setError(null);
    try {
      const body = { to: compose.to, cc: compose.cc, bcc: compose.bcc, subject: compose.subject, body: compose.body };
      let draft: Draft;
      if (compose.id) {
        const r = await fetch(`/api/mail/drafts/${compose.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
        draft = (await r.json() as { draft: Draft }).draft;
      } else {
        const r = await fetch('/api/mail/drafts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
        draft = (await r.json() as { draft: Draft }).draft;
      }
      setCompose({ ...EMPTY_COMPOSE, id: draft.id, to: draft.to, cc: draft.cc, bcc: draft.bcc, subject: draft.subject, body: draft.body });
      await loadDrafts();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const sendDraft = async (draftId?: string) => {
    let id = draftId || compose.id;
    if (!id) {
      // Save first, then send
      setSaving(true);
      try {
        const r = await fetch('/api/mail/drafts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to: compose.to, cc: compose.cc, bcc: compose.bcc, subject: compose.subject, body: compose.body }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
        const d = (await r.json() as { draft: Draft }).draft;
        id = d.id;
        setCompose(c => ({ ...c, id: d.id }));
      } catch (e) {
        setError(String(e));
        setSaving(false);
        return;
      }
      setSaving(false);
    }
    if (!confirm('Diese E-Mail jetzt wirklich senden?')) return;

    setSending(true);
    setError(null);
    try {
      const r = await fetch(`/api/mail/drafts/${id}/send`, { method: 'POST' });
      const data = await r.json() as { draft?: Draft; error?: string };
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      await loadDrafts();
      setCompose(EMPTY_COMPOSE);
      setTab('drafts');
    } catch (e) {
      setError(String(e));
      await loadDrafts();
    } finally {
      setSending(false);
    }
  };

  const deleteDraft = async (id: string) => {
    if (!confirm('Entwurf löschen?')) return;
    try {
      const r = await fetch(`/api/mail/drafts/${id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      if (compose.id === id) setCompose(EMPTY_COMPOSE);
      await loadDrafts();
    } catch (e) {
      setError(String(e));
    }
  };

  const newCompose = () => {
    setCompose(EMPTY_COMPOSE);
    setTab('compose');
  };

  // ── Tab Load Triggers ───────────────────────────────────────────────────────

  useEffect(() => {
    if (!config?.configured) return;
    if (tab === 'inbox' && messages.length === 0) loadInbox();
    if (tab === 'drafts') loadDrafts();
  }, [tab, config?.configured]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Render: Not Configured ──────────────────────────────────────────────────

  if (config && !config.configured) {
    return (
      <div style={containerStyle}>
        <div style={headerStyle}>
          <span style={{ fontSize: 14 }}>✉️</span>
          <span style={{ fontWeight: 600, fontSize: 12, color: 'var(--tn-text)' }}>Mail</span>
        </div>
        <div style={{ padding: 24, textAlign: 'center', color: 'var(--tn-text-muted)', fontSize: 12, lineHeight: 1.6 }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>⚙️</div>
          <div style={{ fontWeight: 600, color: 'var(--tn-text)', marginBottom: 8 }}>Mail noch nicht konfiguriert</div>
          <div>{config.hint || 'IONOS-Credentials fehlen.'}</div>
          <div style={{ marginTop: 12, fontSize: 11 }}>
            Setze <code style={codeStyle}>IONOS_EMAIL</code> und <code style={codeStyle}>IONOS_PASSWORD</code> im Infisical-Projekt <code style={codeStyle}>dev-server</code>.
          </div>
        </div>
      </div>
    );
  }

  // ── Render: Main ────────────────────────────────────────────────────────────

  return (
    <div style={containerStyle}>
      {/* Header */}
      <div style={headerStyle}>
        <span style={{ fontSize: 14 }}>✉️</span>
        <span style={{ fontWeight: 600, fontSize: 12, color: 'var(--tn-text)' }}>Mail</span>
        {config?.email && (
          <span style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginLeft: 4 }}>{config.email}</span>
        )}

        {/* Tab toggle */}
        <div style={{ display: 'flex', gap: 1, background: 'rgba(0,0,0,0.2)', borderRadius: 4, padding: 1, marginLeft: 8 }}>
          {(['inbox', 'drafts', 'compose'] as Tab[]).map(t => (
            <button
              key={t}
              onClick={() => { setTab(t); setSelectedMsg(null); }}
              style={{
                padding: '2px 8px', borderRadius: 3, border: 'none', cursor: 'pointer',
                fontSize: 10, fontWeight: tab === t ? 700 : 400,
                background: tab === t ? 'var(--tn-blue, #7aa2f7)' : 'transparent',
                color: tab === t ? '#fff' : 'var(--tn-text-muted)',
              }}
            >
              {t === 'inbox' ? 'Inbox' : t === 'drafts' ? `Drafts${drafts.length ? ` (${drafts.length})` : ''}` : 'Verfassen'}
            </button>
          ))}
        </div>

        <div style={{ flex: 1 }} />

        {tab === 'inbox' && !selectedMsg && (
          <button onClick={loadInbox} disabled={loadingInbox} style={btnSecondary} title="Inbox neu laden">
            {loadingInbox ? '…' : '↻'}
          </button>
        )}
        {tab !== 'compose' && (
          <button onClick={newCompose} style={btnPrimary} title="Neue E-Mail verfassen">+ Neu</button>
        )}
      </div>

      {/* Error */}
      {error && (
        <div style={{ padding: '6px 8px', background: '#2d1414', color: '#f7768e', fontSize: 11, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ flex: 1 }}>{error}</span>
          <button onClick={() => setError(null)} style={{ ...btnIcon, color: '#f7768e' }}>✕</button>
        </div>
      )}

      {/* Tab content */}
      {tab === 'inbox' && !selectedMsg && renderInbox(messages, loadingInbox, openMessage)}
      {tab === 'inbox' && selectedMsg && renderMessage(selectedMsg, loadingMsg, () => setSelectedMsg(null), () => replyToMessage(selectedMsg))}
      {tab === 'drafts' && renderDraftsList(drafts, loadingDrafts, openDraft, deleteDraft, sendDraft)}
      {tab === 'compose' && renderCompose(compose, setCompose, saveDraft, sendDraft, saving, sending, () => deleteDraft(compose.id))}
    </div>
  );
}

// ── Render: Inbox List ──────────────────────────────────────────────────────

function renderInbox(
  messages: InboxMessage[],
  loading: boolean,
  onOpen: (uid: number) => void,
) {
  if (loading && messages.length === 0) {
    return <div style={emptyStateStyle}>Lade Inbox…</div>;
  }
  if (messages.length === 0) {
    return <div style={emptyStateStyle}>Keine Nachrichten.</div>;
  }
  return (
    <div style={{ flex: 1, overflowY: 'auto' }}>
      {messages.map(m => (
        <div
          key={m.uid}
          onClick={() => onOpen(m.uid)}
          style={{
            padding: '6px 10px',
            borderBottom: '1px solid rgba(255,255,255,0.04)',
            cursor: 'pointer',
            background: m.seen ? 'transparent' : 'rgba(122,162,247,0.05)',
            display: 'flex', gap: 8, alignItems: 'flex-start',
          }}
          onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.04)'}
          onMouseLeave={e => e.currentTarget.style.background = m.seen ? 'transparent' : 'rgba(122,162,247,0.05)'}
        >
          <div style={{
            width: 6, height: 6, borderRadius: '50%',
            background: m.seen ? 'transparent' : '#7aa2f7',
            marginTop: 6, flexShrink: 0,
          }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
              <div style={{
                fontSize: 11, fontWeight: m.seen ? 400 : 700,
                color: 'var(--tn-text)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                flex: 1, minWidth: 0,
              }}>
                {m.from || '(unbekannt)'}
              </div>
              <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', flexShrink: 0 }}>
                {formatDate(m.date)}
              </div>
            </div>
            <div style={{
              fontSize: 11, color: 'var(--tn-text)', marginTop: 1,
              fontWeight: m.seen ? 400 : 600,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {m.subject || '(kein Betreff)'}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Render: Message Detail ──────────────────────────────────────────────────

function renderMessage(
  msg: MessageDetail,
  loading: boolean,
  onBack: () => void,
  onReply: () => void,
) {
  if (loading) return <div style={emptyStateStyle}>Lade Nachricht…</div>;
  return (
    <div style={{ flex: 1, overflowY: 'auto' }}>
      <div style={{ padding: '6px 10px', borderBottom: '1px solid var(--tn-border)', display: 'flex', gap: 6, alignItems: 'center' }}>
        <button onClick={onBack} style={btnSecondary}>‹ Zurück</button>
        <button onClick={onReply} style={btnPrimary}>↩ Antworten</button>
      </div>
      <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--tn-border)' }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--tn-text)', marginBottom: 6 }}>
          {msg.subject || '(kein Betreff)'}
        </div>
        <div style={{ fontSize: 11, color: 'var(--tn-text-muted)', lineHeight: 1.5 }}>
          <div><b>Von:</b> {msg.from}</div>
          <div><b>An:</b> {msg.to}</div>
          {msg.cc && <div><b>CC:</b> {msg.cc}</div>}
          <div><b>Datum:</b> {formatDate(msg.date)}</div>
          {msg.attachments.length > 0 && (
            <div style={{ marginTop: 4 }}>
              <b>Anhänge:</b> {msg.attachments.map(a => `${a.filename} (${formatSize(a.size)})`).join(', ')}
            </div>
          )}
        </div>
      </div>
      <div style={{
        padding: '10px 12px',
        fontSize: 12, lineHeight: 1.5,
        color: 'var(--tn-text)',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}>
        {msg.text || '(leerer Nachrichtentext)'}
      </div>
    </div>
  );
}

// ── Render: Drafts List ─────────────────────────────────────────────────────

function renderDraftsList(
  drafts: Draft[],
  loading: boolean,
  onOpen: (d: Draft) => void,
  onDelete: (id: string) => void,
  onSend: (id: string) => void,
) {
  if (loading && drafts.length === 0) return <div style={emptyStateStyle}>Lade…</div>;
  if (drafts.length === 0) return <div style={emptyStateStyle}>Keine Entwürfe.</div>;
  return (
    <div style={{ flex: 1, overflowY: 'auto' }}>
      {drafts.map(d => {
        const statusColor = d.status === 'sent' ? '#9ece6a' : d.status === 'failed' ? '#f7768e' : '#7aa2f7';
        const statusLabel = d.status === 'sent' ? 'Gesendet' : d.status === 'failed' ? 'Fehler' : 'Entwurf';
        return (
          <div key={d.id} style={{
            padding: '6px 10px',
            borderBottom: '1px solid rgba(255,255,255,0.04)',
            display: 'flex', gap: 8, alignItems: 'flex-start',
          }}>
            <div style={{ width: 3, alignSelf: 'stretch', borderRadius: 2, background: statusColor, flexShrink: 0, marginTop: 2 }} />
            <div style={{ flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={() => onOpen(d)}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
                <div style={{
                  fontSize: 11, color: 'var(--tn-text)', fontWeight: 600,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  flex: 1, minWidth: 0,
                }}>
                  {d.subject || '(kein Betreff)'}
                </div>
                <div style={{
                  fontSize: 9, color: statusColor, fontWeight: 600,
                  padding: '1px 5px', borderRadius: 3,
                  background: statusColor + '22',
                  flexShrink: 0,
                }}>
                  {statusLabel}
                </div>
              </div>
              <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                An: {d.to || '(kein Empfänger)'}
              </div>
              {d.error && (
                <div style={{ fontSize: 10, color: '#f7768e', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {d.error}
                </div>
              )}
              <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', marginTop: 1 }}>
                {formatDate(d.updatedAt)}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
              {d.status !== 'sent' && (
                <button onClick={() => onSend(d.id)} style={{ ...btnIcon, color: '#9ece6a' }} title="Senden">📤</button>
              )}
              <button onClick={() => onDelete(d.id)} style={{ ...btnIcon, color: '#f7768e' }} title="Löschen">🗑️</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Render: Compose ─────────────────────────────────────────────────────────

function renderCompose(
  compose: typeof EMPTY_COMPOSE,
  setCompose: (c: typeof EMPTY_COMPOSE) => void,
  onSave: () => void,
  onSend: () => void,
  saving: boolean,
  sending: boolean,
  onDelete: () => void,
) {
  const hasRecipient = compose.to.trim().length > 0;
  const hasSubject = compose.subject.trim().length > 0;

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 4, borderBottom: '1px solid var(--tn-border)', flexShrink: 0 }}>
        <FieldRow label="An">
          <input
            type="text"
            value={compose.to}
            onChange={e => setCompose({ ...compose, to: e.target.value })}
            placeholder="empfaenger@domain.de, ..."
            style={inputStyle}
          />
        </FieldRow>
        <FieldRow label="CC">
          <input
            type="text"
            value={compose.cc}
            onChange={e => setCompose({ ...compose, cc: e.target.value })}
            placeholder="Optional"
            style={inputStyle}
          />
        </FieldRow>
        <FieldRow label="BCC">
          <input
            type="text"
            value={compose.bcc}
            onChange={e => setCompose({ ...compose, bcc: e.target.value })}
            placeholder="Optional"
            style={inputStyle}
          />
        </FieldRow>
        <FieldRow label="Betreff">
          <input
            type="text"
            value={compose.subject}
            onChange={e => setCompose({ ...compose, subject: e.target.value })}
            placeholder="Betreff..."
            style={inputStyle}
          />
        </FieldRow>
      </div>

      <textarea
        value={compose.body}
        onChange={e => setCompose({ ...compose, body: e.target.value })}
        placeholder="Nachrichtentext..."
        style={{
          flex: 1,
          padding: '10px 12px',
          border: 'none',
          borderBottom: '1px solid var(--tn-border)',
          background: 'var(--tn-surface)',
          color: 'var(--tn-text)',
          fontSize: 12,
          lineHeight: 1.5,
          fontFamily: 'inherit',
          resize: 'none',
          outline: 'none',
        }}
      />

      <div style={{ padding: '6px 10px', display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
        <button onClick={onSave} disabled={saving} style={btnSecondary} title="Als Entwurf speichern">
          {saving ? '…' : '💾 Entwurf'}
        </button>
        {compose.id && (
          <button onClick={onDelete} style={{ ...btnSecondary, color: '#f7768e', borderColor: '#f7768e44' }}>
            🗑️ Löschen
          </button>
        )}
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 10, color: 'var(--tn-text-muted)' }}>
          {compose.id ? `ID: ${compose.id.slice(0, 8)}` : 'Neuer Entwurf'}
        </span>
        <button
          onClick={onSend}
          disabled={sending || !hasRecipient || !hasSubject}
          style={{ ...btnPrimary, background: hasRecipient && hasSubject ? '#9ece6a' : 'var(--tn-border)' }}
          title={!hasRecipient ? 'Empfänger fehlt' : !hasSubject ? 'Betreff fehlt' : 'Senden (mit Bestätigung)'}
        >
          {sending ? 'Sende…' : '📤 Senden'}
        </button>
      </div>
    </div>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div style={{ width: 48, fontSize: 11, color: 'var(--tn-text-muted)', flexShrink: 0 }}>{label}</div>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────

const containerStyle: React.CSSProperties = {
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  background: 'var(--tn-surface)',
};

const headerStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6,
  padding: '6px 8px',
  borderBottom: '1px solid var(--tn-border)',
  background: 'var(--tn-bg-dark)',
  flexShrink: 0,
};

const emptyStateStyle: React.CSSProperties = {
  flex: 1,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: 'var(--tn-text-muted)',
  fontSize: 12,
  padding: 16,
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '3px 6px',
  borderRadius: 4,
  border: '1px solid var(--tn-border)',
  background: 'var(--tn-surface)',
  color: 'var(--tn-text)',
  fontSize: 11,
};

const btnPrimary: React.CSSProperties = {
  padding: '3px 8px', borderRadius: 4, border: 'none', cursor: 'pointer',
  background: 'var(--tn-blue, #7aa2f7)', color: '#fff', fontSize: 11, fontWeight: 600,
};

const btnSecondary: React.CSSProperties = {
  padding: '3px 8px', borderRadius: 4, cursor: 'pointer', fontSize: 11,
  background: 'transparent', border: '1px solid var(--tn-border)',
  color: 'var(--tn-text-muted)',
};

const btnIcon: React.CSSProperties = {
  width: 22, height: 22, padding: 0, border: 'none', background: 'transparent',
  cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center',
  borderRadius: 3,
};

const codeStyle: React.CSSProperties = {
  padding: '1px 5px',
  borderRadius: 3,
  background: 'rgba(255,255,255,0.08)',
  color: 'var(--tn-text)',
  fontFamily: 'monospace',
  fontSize: 10,
};
