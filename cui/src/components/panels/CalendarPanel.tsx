import { useState, useEffect, useCallback } from 'react';

// ── Types ────────────────────────────────────────────────────────────────────

interface CalendarEvent {
  id: string;
  date: string;
  endDate: string;
  title: string;
  type: string;
  notes: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

const TYPE_COLOR: Record<string, string> = {
  work:     '#7aa2f7', // blue
  health:   '#f7768e', // red
  acro:     '#9ece6a', // green
  social:   '#73daca', // teal
  travel:   '#e0af68', // yellow
  festival: '#bb9af7', // purple
  vacation: '#ff9e64', // orange
  open:     '#565f89', // grey
  misc:     '#565f89', // grey
};

const TYPE_LABEL: Record<string, string> = {
  work:     'Arbeit',
  health:   'Gesundheit',
  acro:     'Akro',
  social:   'Sozial',
  travel:   'Reise',
  festival: 'Festival',
  vacation: 'Urlaub',
  open:     'Offen',
  misc:     'Sonstiges',
};

const MONTH_NAMES = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

const EMPTY_FORM: Omit<CalendarEvent, 'id'> = {
  date: '',
  endDate: '',
  title: '',
  type: 'misc',
  notes: '',
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatDateRange(date: string, endDate: string): string {
  if (!date) return '—';
  const d = new Date(date + 'T00:00:00');
  const month = MONTH_NAMES[d.getMonth()];
  const day = d.getDate();
  if (!endDate || endDate === date) return `${day}. ${month}`;
  const e = new Date(endDate + 'T00:00:00');
  if (e.getMonth() === d.getMonth()) return `${day}.–${e.getDate()}. ${month}`;
  return `${day}. ${month} – ${e.getDate()}. ${MONTH_NAMES[e.getMonth()]}`;
}

function groupByMonth(events: CalendarEvent[]): Map<string, CalendarEvent[]> {
  const groups = new Map<string, CalendarEvent[]>();
  for (const ev of events) {
    const d = new Date(ev.date + 'T00:00:00');
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(ev);
  }
  return groups;
}

function monthLabel(key: string): string {
  const [year, month] = key.split('-');
  return `${MONTH_NAMES[parseInt(month, 10) - 1]} ${year}`;
}

function isUpcoming(ev: CalendarEvent): boolean {
  const today = new Date().toISOString().slice(0, 10);
  return (ev.endDate || ev.date) >= today;
}

// ── Component ────────────────────────────────────────────────────────────────

export default function CalendarPanel() {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [editing, setEditing] = useState<CalendarEvent | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<Omit<CalendarEvent, 'id'>>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch('/api/calendar/events');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { events: CalendarEvent[] };
      setEvents(data.events);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openCreate = () => {
    const today = new Date().toISOString().slice(0, 10);
    setForm({ ...EMPTY_FORM, date: today, endDate: today });
    setCreating(true);
    setEditing(null);
  };

  const openEdit = (ev: CalendarEvent) => {
    setForm({ date: ev.date, endDate: ev.endDate, title: ev.title, type: ev.type, notes: ev.notes });
    setEditing(ev);
    setCreating(false);
  };

  const cancel = () => { setEditing(null); setCreating(false); };

  const save = async () => {
    if (!form.title.trim() || !form.date) return;
    setSaving(true);
    setError(null);
    try {
      if (creating) {
        const res = await fetch('/api/calendar/events', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...form, endDate: form.endDate || form.date }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      } else if (editing) {
        const res = await fetch(`/api/calendar/events/${editing.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...form, endDate: form.endDate || form.date }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      }
      await load();
      cancel();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const deleteEvent = async (id: string) => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/calendar/events/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const filtered = showAll ? events : events.filter(isUpcoming);
  const groups = groupByMonth(filtered);

  // ── Render: Form ────────────────────────────────────────────────────────────

  const renderForm = () => (
    <div style={{
      margin: '8px 8px 0',
      padding: 10,
      background: 'var(--tn-bg-dark)',
      borderRadius: 6,
      border: '1px solid var(--tn-border)',
      fontSize: 12,
    }}>
      <div style={{ fontWeight: 600, marginBottom: 8, color: 'var(--tn-text)' }}>
        {creating ? 'Neuer Termin' : 'Termin bearbeiten'}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 6 }}>
        <label style={{ color: 'var(--tn-text-muted)' }}>
          Von
          <input type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))}
            style={inputStyle} />
        </label>
        <label style={{ color: 'var(--tn-text-muted)' }}>
          Bis
          <input type="date" value={form.endDate} onChange={e => setForm(f => ({ ...f, endDate: e.target.value }))}
            style={inputStyle} />
        </label>
      </div>

      <label style={{ display: 'block', color: 'var(--tn-text-muted)', marginBottom: 6 }}>
        Titel
        <input type="text" value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
          placeholder="Titel..." style={{ ...inputStyle, width: '100%', boxSizing: 'border-box' }} />
      </label>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 6, marginBottom: 6 }}>
        <label style={{ color: 'var(--tn-text-muted)' }}>
          Typ
          <select value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))}
            style={{ ...inputStyle, width: '100%' }}>
            {Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label style={{ color: 'var(--tn-text-muted)' }}>
          Notizen
          <input type="text" value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
            placeholder="Optional..." style={{ ...inputStyle, width: '100%', boxSizing: 'border-box' }} />
        </label>
      </div>

      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <button onClick={cancel} disabled={saving} style={btnSecondary}>Abbrechen</button>
        <button onClick={save} disabled={saving || !form.title.trim() || !form.date} style={btnPrimary}>
          {saving ? '...' : 'Speichern'}
        </button>
      </div>
    </div>
  );

  // ── Render: Main ─────────────────────────────────────────────────────────────

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--tn-surface)' }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px',
        borderBottom: '1px solid var(--tn-border)', background: 'var(--tn-bg-dark)', flexShrink: 0,
      }}>
        <span style={{ fontSize: 14 }}>📅</span>
        <span style={{ fontWeight: 600, fontSize: 12, color: 'var(--tn-text)', flex: 1 }}>Kalender</span>
        <button onClick={() => setShowAll(v => !v)} style={btnSecondary} title="Vergangene Termine ein-/ausblenden">
          {showAll ? 'Nur kommende' : 'Alle'}
        </button>
        <button onClick={openCreate} style={btnPrimary} title="Neuen Termin anlegen">+ Termin</button>
      </div>

      {/* Error */}
      {error && (
        <div style={{ padding: '6px 8px', background: '#2d1414', color: '#f7768e', fontSize: 11, flexShrink: 0 }}>
          {error}
        </div>
      )}

      {/* Form */}
      {(creating || editing) && renderForm()}

      {/* Event list */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
        {loading && (
          <div style={{ padding: 16, color: 'var(--tn-text-muted)', fontSize: 12, textAlign: 'center' }}>
            Lade...
          </div>
        )}
        {!loading && filtered.length === 0 && (
          <div style={{ padding: 16, color: 'var(--tn-text-muted)', fontSize: 12, textAlign: 'center' }}>
            {showAll ? 'Keine Termine.' : 'Keine kommenden Termine.'}
          </div>
        )}
        {!loading && Array.from(groups.entries()).map(([monthKey, evs]) => (
          <div key={monthKey}>
            {/* Month header */}
            <div style={{
              padding: '4px 10px 2px',
              fontSize: 10, fontWeight: 700,
              color: 'var(--tn-text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              borderBottom: '1px solid var(--tn-border)',
              marginTop: 2,
            }}>
              {monthLabel(monthKey)}
            </div>

            {/* Events */}
            {evs.map(ev => {
              const color = TYPE_COLOR[ev.type] || '#565f89';
              const isPast = (ev.endDate || ev.date) < new Date().toISOString().slice(0, 10);
              const isEditing = editing?.id === ev.id;

              return (
                <div
                  key={ev.id}
                  style={{
                    display: 'flex', alignItems: 'flex-start', gap: 8,
                    padding: '5px 10px',
                    opacity: isPast ? 0.55 : 1,
                    borderBottom: '1px solid rgba(255,255,255,0.04)',
                    background: isEditing ? 'rgba(122,162,247,0.08)' : 'transparent',
                  }}
                >
                  {/* Type dot */}
                  <div style={{ width: 3, alignSelf: 'stretch', borderRadius: 2, background: color, flexShrink: 0, marginTop: 2 }} />

                  {/* Date */}
                  <div style={{ minWidth: 64, fontSize: 11, color: 'var(--tn-text-muted)', paddingTop: 1, flexShrink: 0 }}>
                    {formatDateRange(ev.date, ev.endDate)}
                  </div>

                  {/* Content */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, color: 'var(--tn-text)', fontWeight: 500, lineHeight: 1.3 }}>
                      {ev.title}
                    </div>
                    {ev.notes && (
                      <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginTop: 1 }}>{ev.notes}</div>
                    )}
                    <div style={{
                      display: 'inline-block', marginTop: 2, padding: '0 4px',
                      borderRadius: 3, background: color + '22',
                      fontSize: 9, color, fontWeight: 600, letterSpacing: '0.04em',
                    }}>
                      {TYPE_LABEL[ev.type] || ev.type}
                    </div>
                  </div>

                  {/* Actions */}
                  <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
                    <button
                      onClick={() => openEdit(ev)}
                      title="Bearbeiten"
                      style={{ ...btnIcon, color: 'var(--tn-text-muted)' }}
                    >✏️</button>
                    <button
                      onClick={() => { if (confirm(`Termin löschen: "${ev.title}"?`)) deleteEvent(ev.id); }}
                      title="Löschen"
                      style={{ ...btnIcon, color: '#f7768e' }}
                    >🗑️</button>
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  display: 'block', marginTop: 2, width: '100%',
  padding: '3px 5px', borderRadius: 4,
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
  width: 20, height: 20, padding: 0, border: 'none', background: 'transparent',
  cursor: 'pointer', fontSize: 11, display: 'flex', alignItems: 'center', justifyContent: 'center',
  borderRadius: 3,
};
