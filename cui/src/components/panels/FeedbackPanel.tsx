import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../contexts/AuthContext';

// ─── Types ───────────────────────────────────────────────────────────────────

type FeedbackType = 'bug' | 'feature' | 'ux' | 'fachlich';
type FeedbackStatus = 'new' | 'acknowledged' | 'in-progress' | 'resolved';

interface FeedbackEntry {
  id: string;
  from: string;
  type: FeedbackType;
  title: string;
  description: string;
  screenshot?: string;
  appContext?: string;
  status: FeedbackStatus;
  createdAt: string;
  response?: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const TYPE_OPTIONS: { value: FeedbackType; label: string; color: string }[] = [
  { value: 'bug',      label: 'Bug',      color: '#f7768e' },
  { value: 'feature',  label: 'Feature',  color: '#7aa2f7' },
  { value: 'ux',       label: 'UX',       color: '#bb9af7' },
  { value: 'fachlich', label: 'Fachlich', color: '#e0af68' },
];

const STATUS_OPTIONS: { value: FeedbackStatus; label: string; color: string }[] = [
  { value: 'new',         label: 'Neu',          color: '#7aa2f7' },
  { value: 'acknowledged', label: 'Bestätigt',   color: '#e0af68' },
  { value: 'in-progress', label: 'In Arbeit',    color: '#bb9af7' },
  { value: 'resolved',    label: 'Erledigt',     color: '#9ece6a' },
];

const API = '/api/partner';

// ─── Sub-components ──────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: FeedbackStatus }) {
  const opt = STATUS_OPTIONS.find(s => s.value === status);
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 3,
      background: `${opt?.color ?? '#666'}22`, color: opt?.color ?? '#666',
      border: `1px solid ${opt?.color ?? '#666'}44`,
    }}>
      {opt?.label ?? status}
    </span>
  );
}

function TypeBadge({ type }: { type: FeedbackType }) {
  const opt = TYPE_OPTIONS.find(t => t.value === type);
  return (
    <span style={{
      fontSize: 10, fontWeight: 600, padding: '2px 6px', borderRadius: 3,
      background: `${opt?.color ?? '#666'}18`, color: opt?.color ?? '#666',
    }}>
      {opt?.label ?? type}
    </span>
  );
}

// ─── Main Panel ──────────────────────────────────────────────────────────────

export default function FeedbackPanel() {
  const { user } = useAuth();
  const isAdmin = !user || user.role === 'admin' || user.role === 'product-owner';

  const [view, setView] = useState<'list' | 'new'>('list');
  const [entries, setEntries] = useState<FeedbackEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<FeedbackEntry | null>(null);

  // Form state
  const [form, setForm] = useState({
    type: 'bug' as FeedbackType,
    title: '',
    description: '',
    appContext: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  // Admin: status edit
  const [editStatus, setEditStatus] = useState('');
  const [editResponse, setEditResponse] = useState('');
  const [saving, setSaving] = useState(false);

  const fetchEntries = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (!isAdmin && user?.id) params.set('userId', user.id);
      const res = await fetch(`${API}/feedback?${params}`, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: FeedbackEntry[] = await res.json();
      setEntries(data);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [isAdmin, user?.id]);

  useEffect(() => { fetchEntries(); }, [fetchEntries]);

  const handleSubmit = useCallback(async () => {
    if (!form.title.trim() || !form.description.trim()) {
      setSubmitError('Titel und Beschreibung sind Pflichtfelder');
      return;
    }
    setSubmitting(true);
    setSubmitError('');
    try {
      const res = await fetch(`${API}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: user?.id || user?.email || 'unknown',
          type: form.type,
          title: form.title,
          description: form.description,
          appContext: form.appContext || undefined,
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const created: FeedbackEntry = await res.json();
      setEntries(prev => [created, ...prev]);
      setForm({ type: 'bug', title: '', description: '', appContext: '' });
      setView('list');
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [form, user]);

  const handleSaveStatus = useCallback(async () => {
    if (!selected || !editStatus) return;
    setSaving(true);
    try {
      const res = await fetch(`${API}/feedback/${selected.id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: editStatus, response: editResponse || undefined }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const updated: FeedbackEntry = await res.json();
      setEntries(prev => prev.map(e => e.id === updated.id ? updated : e));
      setSelected(updated);
    } catch (err) {
      console.error('[FeedbackPanel] save status failed:', err);
    } finally {
      setSaving(false);
    }
  }, [selected, editStatus, editResponse]);

  const openDetail = useCallback((entry: FeedbackEntry) => {
    setSelected(entry);
    setEditStatus(entry.status);
    setEditResponse(entry.response ?? '');
  }, []);

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })
      + ' ' + d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  };

  // ── Detail View ─────────────────────────────────────────────────────────────
  if (selected) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--tn-bg)' }}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
          background: 'var(--tn-bg-dark)', borderBottom: '1px solid var(--tn-border)',
          flexShrink: 0,
        }}>
          <button onClick={() => setSelected(null)} style={backBtnStyle}>← Zurück</button>
          <TypeBadge type={selected.type} />
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--tn-text)', flex: 1 }}>{selected.title}</span>
          <StatusBadge status={selected.status} />
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
          {/* Meta */}
          <div style={{ display: 'flex', gap: 12, marginBottom: 12, fontSize: 11, color: 'var(--tn-text-muted)' }}>
            <span>Von: <strong style={{ color: 'var(--tn-text)' }}>{selected.from}</strong></span>
            <span>{formatDate(selected.createdAt)}</span>
            {selected.appContext && <span>App: <strong style={{ color: 'var(--tn-cyan)' }}>{selected.appContext}</strong></span>}
          </div>

          {/* Description */}
          <div style={{
            background: 'var(--tn-surface)', border: '1px solid var(--tn-border)',
            borderRadius: 4, padding: 10, marginBottom: 12,
            fontSize: 12, color: 'var(--tn-text)', lineHeight: 1.6,
            whiteSpace: 'pre-wrap',
          }}>
            {selected.description}
          </div>

          {/* Screenshot */}
          {selected.screenshot && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: 'var(--tn-text-muted)', marginBottom: 4 }}>Screenshot:</div>
              <img
                src={selected.screenshot}
                alt="Screenshot"
                style={{ maxWidth: '100%', borderRadius: 4, border: '1px solid var(--tn-border)' }}
              />
            </div>
          )}

          {/* Response (if exists) */}
          {selected.response && (
            <div style={{
              background: 'rgba(158,206,106,0.08)', border: '1px solid rgba(158,206,106,0.2)',
              borderRadius: 4, padding: 10, marginBottom: 12,
            }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#9ece6a', marginBottom: 4 }}>Antwort:</div>
              <div style={{ fontSize: 12, color: 'var(--tn-text)', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                {selected.response}
              </div>
            </div>
          )}

          {/* Admin: status + response edit */}
          {isAdmin && (
            <div style={{
              background: 'var(--tn-surface)', border: '1px solid var(--tn-border)',
              borderRadius: 4, padding: 10,
            }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--tn-text-muted)', marginBottom: 8 }}>
                ADMIN — Status & Antwort
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontSize: 11, color: 'var(--tn-text-muted)' }}>Status:</span>
                <select
                  value={editStatus}
                  onChange={e => setEditStatus(e.target.value)}
                  style={selectStyle}
                >
                  {STATUS_OPTIONS.map(s => (
                    <option key={s.value} value={s.value}>{s.label}</option>
                  ))}
                </select>
              </div>
              <textarea
                placeholder="Antwort an Partner (optional)..."
                value={editResponse}
                onChange={e => setEditResponse(e.target.value)}
                style={{ ...inputStyle, height: 80, resize: 'vertical' }}
              />
              <button
                onClick={handleSaveStatus}
                disabled={saving}
                style={{ ...primaryBtnStyle, marginTop: 8, opacity: saving ? 0.6 : 1 }}
              >
                {saving ? 'Speichern...' : 'Speichern'}
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── New Feedback Form ────────────────────────────────────────────────────────
  if (view === 'new') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--tn-bg)' }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
          background: 'var(--tn-bg-dark)', borderBottom: '1px solid var(--tn-border)',
          flexShrink: 0,
        }}>
          <button onClick={() => setView('list')} style={backBtnStyle}>← Zurück</button>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--tn-text)' }}>Neues Feedback</span>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
          {/* Type selector */}
          <div style={{ marginBottom: 12 }}>
            <label style={labelStyle}>Typ</label>
            <div style={{ display: 'flex', gap: 6 }}>
              {TYPE_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  onClick={() => setForm(f => ({ ...f, type: opt.value }))}
                  style={{
                    padding: '5px 12px', borderRadius: 4, fontSize: 12, cursor: 'pointer',
                    fontWeight: form.type === opt.value ? 700 : 400,
                    background: form.type === opt.value ? `${opt.color}22` : 'var(--tn-surface)',
                    color: form.type === opt.value ? opt.color : 'var(--tn-text-muted)',
                    border: `1px solid ${form.type === opt.value ? opt.color + '88' : 'var(--tn-border)'}`,
                    transition: 'all 0.15s',
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Title */}
          <div style={{ marginBottom: 10 }}>
            <label style={labelStyle}>Titel *</label>
            <input
              type="text"
              placeholder="Kurze Zusammenfassung..."
              value={form.title}
              onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
              style={inputStyle}
              maxLength={200}
            />
          </div>

          {/* Description */}
          <div style={{ marginBottom: 10 }}>
            <label style={labelStyle}>Beschreibung *</label>
            <textarea
              placeholder="Detaillierte Beschreibung, Schritte zur Reproduktion, Erwartetes Verhalten..."
              value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              style={{ ...inputStyle, height: 120, resize: 'vertical' }}
            />
          </div>

          {/* App context */}
          <div style={{ marginBottom: 12 }}>
            <label style={labelStyle}>App / Kontext (optional)</label>
            <input
              type="text"
              placeholder="z.B. werking-energy, werking-safety..."
              value={form.appContext}
              onChange={e => setForm(f => ({ ...f, appContext: e.target.value }))}
              style={inputStyle}
            />
          </div>

          {submitError && (
            <div style={{ marginBottom: 8, fontSize: 12, color: '#f7768e' }}>{submitError}</div>
          )}

          <button
            onClick={handleSubmit}
            disabled={submitting}
            style={{ ...primaryBtnStyle, opacity: submitting ? 0.6 : 1 }}
          >
            {submitting ? 'Wird gesendet...' : 'Feedback senden'}
          </button>
        </div>
      </div>
    );
  }

  // ── List View ────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--tn-bg)' }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '4px 10px',
        background: 'var(--tn-bg-dark)', borderBottom: '1px solid var(--tn-border)',
        height: 34, flexShrink: 0,
      }}>
        <span style={{ fontWeight: 700, fontSize: 12, color: 'var(--tn-cyan)' }}>FEEDBACK</span>
        <span style={{ fontSize: 11, color: 'var(--tn-text-muted)', flex: 1 }}>
          {entries.length} Einträge
        </span>
        <button onClick={fetchEntries} style={ghostBtnStyle}>↺</button>
        <button onClick={() => setView('new')} style={primaryBtnStyle}>+ Neu</button>
      </div>

      {/* Error */}
      {error && (
        <div style={{ padding: '6px 10px', fontSize: 11, color: '#f7768e', background: 'rgba(247,118,142,0.08)' }}>
          Fehler: {error}
        </div>
      )}

      {/* List */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        {loading ? (
          <div style={{ padding: 20, textAlign: 'center', color: 'var(--tn-text-muted)', fontSize: 12 }}>
            Lädt...
          </div>
        ) : entries.length === 0 ? (
          <div style={{ padding: 20, textAlign: 'center', color: 'var(--tn-text-muted)', fontSize: 12 }}>
            Noch kein Feedback vorhanden.
          </div>
        ) : (
          entries.map(entry => (
            <div
              key={entry.id}
              onClick={() => openDetail(entry)}
              style={{
                padding: '8px 10px', borderBottom: '1px solid var(--tn-border)',
                cursor: 'pointer', transition: 'background 0.1s',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--tn-surface)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                <TypeBadge type={entry.type} />
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--tn-text)', flex: 1 }}>
                  {entry.title}
                </span>
                <StatusBadge status={entry.status} />
              </div>
              <div style={{ display: 'flex', gap: 10, fontSize: 11, color: 'var(--tn-text-muted)' }}>
                <span>{entry.from}</span>
                <span>{formatDate(entry.createdAt)}</span>
                {entry.appContext && (
                  <span style={{ color: 'var(--tn-cyan)' }}>{entry.appContext}</span>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 11, fontWeight: 600,
  color: 'var(--tn-text-muted)', marginBottom: 4,
};

const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box',
  background: 'var(--tn-surface)', color: 'var(--tn-text)',
  border: '1px solid var(--tn-border)', borderRadius: 4,
  padding: '6px 8px', fontSize: 12, outline: 'none',
  fontFamily: 'inherit',
};

const selectStyle: React.CSSProperties = {
  background: 'var(--tn-surface)', color: 'var(--tn-text)',
  border: '1px solid var(--tn-border)', borderRadius: 4,
  padding: '4px 8px', fontSize: 12, cursor: 'pointer',
};

const primaryBtnStyle: React.CSSProperties = {
  background: 'var(--tn-blue)', color: '#fff',
  border: 'none', borderRadius: 4,
  padding: '5px 12px', fontSize: 12, fontWeight: 600,
  cursor: 'pointer',
};

const ghostBtnStyle: React.CSSProperties = {
  background: 'transparent', color: 'var(--tn-text-muted)',
  border: '1px solid var(--tn-border)', borderRadius: 4,
  padding: '3px 8px', fontSize: 12, cursor: 'pointer',
};

const backBtnStyle: React.CSSProperties = {
  background: 'transparent', color: 'var(--tn-blue)',
  border: 'none', fontSize: 12, cursor: 'pointer', padding: 0,
};
