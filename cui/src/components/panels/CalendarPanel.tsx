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

type ViewMode = 'list' | 'week' | 'month' | 'year';

// ── Constants ────────────────────────────────────────────────────────────────

const TYPE_COLOR: Record<string, string> = {
  work:     '#7aa2f7',
  health:   '#f7768e',
  acro:     '#9ece6a',
  social:   '#73daca',
  travel:   '#e0af68',
  festival: '#bb9af7',
  vacation: '#ff9e64',
  open:     '#565f89',
  misc:     '#565f89',
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
const MONTH_NAMES_FULL = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const DAY_NAMES_SHORT = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

const EMPTY_FORM: Omit<CalendarEvent, 'id'> = {
  date: '',
  endDate: '',
  title: '',
  type: 'misc',
  notes: '',
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function toDateStr(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

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

function eventTouchesDate(ev: CalendarEvent, dateStr: string): boolean {
  return ev.date <= dateStr && (ev.endDate || ev.date) >= dateStr;
}

function getEventsForDate(events: CalendarEvent[], dateStr: string): CalendarEvent[] {
  return events.filter(ev => eventTouchesDate(ev, dateStr));
}

// European Mon-first: returns the 7 days of the week containing `date`
function getWeekDays(date: Date): Date[] {
  const d = new Date(date);
  const day = d.getDay(); // 0=Sun
  const mondayOffset = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + mondayOffset);
  return Array.from({ length: 7 }, (_, i) => {
    const dd = new Date(d);
    dd.setDate(dd.getDate() + i);
    return dd;
  });
}

// Returns 42 days (6 weeks) for a month grid, European Mon-first
function getMonthGridDays(year: number, month: number): Date[] {
  const firstDay = new Date(year, month, 1);
  const startDay = firstDay.getDay(); // 0=Sun
  const mondayOffset = startDay === 0 ? 6 : startDay - 1;
  const gridStart = new Date(firstDay);
  gridStart.setDate(gridStart.getDate() - mondayOffset);
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(gridStart);
    d.setDate(d.getDate() + i);
    return d;
  });
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
  const [view, setView] = useState<ViewMode>('list');
  const [navDate, setNavDate] = useState<Date>(() => new Date());

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

  const today = toDateStr(new Date());

  // ── Render: Form ────────────────────────────────────────────────────────────

  const renderForm = () => (
    <div style={{
      margin: '8px 8px 0',
      padding: 10,
      background: 'var(--tn-bg-dark)',
      borderRadius: 6,
      border: '1px solid var(--tn-border)',
      fontSize: 12,
      flexShrink: 0,
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

  // ── Render: List View ────────────────────────────────────────────────────────

  const renderListView = () => {
    const filtered = showAll ? events : events.filter(isUpcoming);
    const groups = groupByMonth(filtered);

    return (
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

            {evs.map(ev => {
              const color = TYPE_COLOR[ev.type] || '#565f89';
              const isPast = (ev.endDate || ev.date) < today;
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
                  <div style={{ width: 3, alignSelf: 'stretch', borderRadius: 2, background: color, flexShrink: 0, marginTop: 2 }} />
                  <div style={{ minWidth: 64, fontSize: 11, color: 'var(--tn-text-muted)', paddingTop: 1, flexShrink: 0 }}>
                    {formatDateRange(ev.date, ev.endDate)}
                  </div>
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
                  <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
                    <button onClick={() => openEdit(ev)} title="Bearbeiten" style={{ ...btnIcon, color: 'var(--tn-text-muted)' }}>✏️</button>
                    <button onClick={() => { if (confirm(`Termin löschen: "${ev.title}"?`)) deleteEvent(ev.id); }} title="Löschen" style={{ ...btnIcon, color: '#f7768e' }}>🗑️</button>
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    );
  };

  // ── Render: Week View ────────────────────────────────────────────────────────

  const renderWeekView = () => {
    const weekDays = getWeekDays(navDate);
    const startStr = `${weekDays[0].getDate()}. ${MONTH_NAMES[weekDays[0].getMonth()]}`;
    const endStr = `${weekDays[6].getDate()}. ${MONTH_NAMES[weekDays[6].getMonth()]} ${weekDays[6].getFullYear()}`;

    return (
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {/* Navigation */}
        <div style={{ display: 'flex', alignItems: 'center', padding: '4px 8px 6px', gap: 6, borderBottom: '1px solid var(--tn-border)' }}>
          <button onClick={() => setNavDate(d => { const nd = new Date(d); nd.setDate(nd.getDate() - 7); return nd; })} style={btnNav}>‹</button>
          <span style={{ flex: 1, textAlign: 'center', fontSize: 11, color: 'var(--tn-text-muted)' }}>
            {startStr} – {endStr}
          </span>
          <button onClick={() => setNavDate(d => { const nd = new Date(d); nd.setDate(nd.getDate() + 7); return nd; })} style={btnNav}>›</button>
        </div>

        {/* Day columns */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 2, padding: '6px 4px' }}>
          {/* Day name headers */}
          {DAY_NAMES_SHORT.map(n => (
            <div key={n} style={{ textAlign: 'center', fontSize: 9, fontWeight: 700, color: 'var(--tn-text-muted)', paddingBottom: 3 }}>
              {n}
            </div>
          ))}

          {/* Day cells */}
          {weekDays.map((day, i) => {
            const dateStr = toDateStr(day);
            const isToday = dateStr === today;
            const dayEvents = getEventsForDate(events, dateStr);

            return (
              <div key={i} style={{
                minHeight: 80,
                minWidth: 0,
                overflow: 'hidden',
                padding: 3,
                borderRadius: 4,
                background: isToday ? 'rgba(122,162,247,0.1)' : 'rgba(255,255,255,0.02)',
                border: isToday ? '1px solid rgba(122,162,247,0.4)' : '1px solid var(--tn-border)',
              }}>
                <div style={{
                  fontSize: 11, fontWeight: isToday ? 700 : 400,
                  color: isToday ? '#7aa2f7' : 'var(--tn-text)',
                  textAlign: 'center',
                  marginBottom: 3,
                }}>
                  {day.getDate()}
                </div>
                {dayEvents.map(ev => (
                  <div
                    key={ev.id}
                    onClick={() => openEdit(ev)}
                    title={ev.title}
                    style={{
                      fontSize: 9,
                      padding: '1px 3px',
                      borderRadius: 2,
                      background: (TYPE_COLOR[ev.type] || '#565f89') + '33',
                      color: TYPE_COLOR[ev.type] || '#565f89',
                      marginBottom: 1,
                      overflow: 'hidden',
                      whiteSpace: 'nowrap',
                      textOverflow: 'ellipsis',
                      cursor: 'pointer',
                      borderLeft: `2px solid ${TYPE_COLOR[ev.type] || '#565f89'}`,
                    }}
                  >
                    {ev.title}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  // ── Render: Month View ───────────────────────────────────────────────────────

  const renderMonthView = () => {
    const year = navDate.getFullYear();
    const month = navDate.getMonth();
    const gridDays = getMonthGridDays(year, month);
    const monthStart = toDateStr(new Date(year, month, 1));
    const monthEnd = toDateStr(new Date(year, month + 1, 0));

    const monthEvents = events.filter(ev =>
      ev.date <= monthEnd && (ev.endDate || ev.date) >= monthStart
    );

    return (
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {/* Navigation */}
        <div style={{ display: 'flex', alignItems: 'center', padding: '4px 8px 6px', gap: 6, borderBottom: '1px solid var(--tn-border)' }}>
          <button onClick={() => setNavDate(d => new Date(d.getFullYear(), d.getMonth() - 1, 1))} style={btnNav}>‹</button>
          <span style={{ flex: 1, textAlign: 'center', fontSize: 12, fontWeight: 600, color: 'var(--tn-text)' }}>
            {MONTH_NAMES_FULL[month]} {year}
          </span>
          <button onClick={() => setNavDate(d => new Date(d.getFullYear(), d.getMonth() + 1, 1))} style={btnNav}>›</button>
        </div>

        {/* Calendar grid */}
        <div style={{ padding: '4px 6px' }}>
          {/* Day headers */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 1, marginBottom: 1 }}>
            {DAY_NAMES_SHORT.map(n => (
              <div key={n} style={{ textAlign: 'center', fontSize: 9, fontWeight: 700, color: 'var(--tn-text-muted)', padding: '2px 0' }}>
                {n}
              </div>
            ))}
          </div>

          {/* Day cells */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 1 }}>
            {gridDays.map((day, i) => {
              const dateStr = toDateStr(day);
              const isCurrentMonth = day.getMonth() === month;
              const isToday = dateStr === today;
              const dayEvents = getEventsForDate(events, dateStr);

              return (
                <div key={i} style={{
                  minHeight: 34,
                  padding: '2px 1px',
                  borderRadius: 3,
                  background: isToday ? 'rgba(122,162,247,0.15)' : 'transparent',
                  border: isToday ? '1px solid rgba(122,162,247,0.5)' : '1px solid transparent',
                  opacity: isCurrentMonth ? 1 : 0.25,
                }}>
                  <div style={{
                    fontSize: 10,
                    fontWeight: isToday ? 700 : 400,
                    color: isToday ? '#7aa2f7' : 'var(--tn-text)',
                    textAlign: 'center',
                    marginBottom: 2,
                  }}>
                    {day.getDate()}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 1, justifyContent: 'center' }}>
                    {dayEvents.slice(0, 3).map(ev => (
                      <div key={ev.id} style={{
                        width: 5, height: 5, borderRadius: '50%',
                        background: TYPE_COLOR[ev.type] || '#565f89',
                        flexShrink: 0,
                      }} title={ev.title} />
                    ))}
                    {dayEvents.length > 3 && (
                      <div style={{ fontSize: 7, color: 'var(--tn-text-muted)', lineHeight: '5px' }}>+{dayEvents.length - 3}</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Event list for this month */}
        {monthEvents.length > 0 && (
          <div style={{ borderTop: '1px solid var(--tn-border)', marginTop: 4 }}>
            {monthEvents.map(ev => {
              const color = TYPE_COLOR[ev.type] || '#565f89';
              const isPast = (ev.endDate || ev.date) < today;
              return (
                <div key={ev.id} style={{
                  display: 'flex', alignItems: 'flex-start', gap: 8,
                  padding: '4px 8px',
                  opacity: isPast ? 0.5 : 1,
                  borderBottom: '1px solid rgba(255,255,255,0.04)',
                }}>
                  <div style={{ width: 3, alignSelf: 'stretch', borderRadius: 2, background: color, flexShrink: 0, marginTop: 2 }} />
                  <div style={{ minWidth: 58, fontSize: 10, color: 'var(--tn-text-muted)', paddingTop: 1, flexShrink: 0 }}>
                    {formatDateRange(ev.date, ev.endDate)}
                  </div>
                  <div style={{ flex: 1, fontSize: 11, color: 'var(--tn-text)', lineHeight: 1.3 }}>{ev.title}</div>
                  <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
                    <button onClick={() => openEdit(ev)} style={{ ...btnIcon, color: 'var(--tn-text-muted)' }}>✏️</button>
                    <button onClick={() => { if (confirm(`Löschen: "${ev.title}"?`)) deleteEvent(ev.id); }} style={{ ...btnIcon, color: '#f7768e' }}>🗑️</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {monthEvents.length === 0 && !loading && (
          <div style={{ padding: 12, color: 'var(--tn-text-muted)', fontSize: 11, textAlign: 'center' }}>
            Keine Termine diesen Monat.
          </div>
        )}
      </div>
    );
  };

  // ── Render: Year View ────────────────────────────────────────────────────────

  const renderYearView = () => {
    const year = navDate.getFullYear();
    const todayDate = new Date();

    return (
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {/* Navigation */}
        <div style={{ display: 'flex', alignItems: 'center', padding: '4px 8px 6px', gap: 6, borderBottom: '1px solid var(--tn-border)' }}>
          <button onClick={() => setNavDate(d => new Date(d.getFullYear() - 1, 0, 1))} style={btnNav}>‹</button>
          <span style={{ flex: 1, textAlign: 'center', fontSize: 13, fontWeight: 700, color: 'var(--tn-text)' }}>
            {year}
          </span>
          <button onClick={() => setNavDate(d => new Date(d.getFullYear() + 1, 0, 1))} style={btnNav}>›</button>
        </div>

        {/* 12 mini calendars */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, padding: '6px 4px' }}>
          {Array.from({ length: 12 }, (_, m) => {
            const gridDays = getMonthGridDays(year, m);
            const isCurrentMonth = todayDate.getFullYear() === year && todayDate.getMonth() === m;

            return (
              <div
                key={m}
                onClick={() => { setNavDate(new Date(year, m, 1)); setView('month'); }}
                style={{
                  border: isCurrentMonth ? '1px solid rgba(122,162,247,0.5)' : '1px solid var(--tn-border)',
                  borderRadius: 4,
                  padding: 4,
                  cursor: 'pointer',
                  background: isCurrentMonth ? 'rgba(122,162,247,0.04)' : 'transparent',
                }}
              >
                <div style={{
                  textAlign: 'center',
                  fontSize: 9,
                  fontWeight: 700,
                  color: isCurrentMonth ? '#7aa2f7' : 'var(--tn-text-muted)',
                  marginBottom: 2,
                }}>
                  {MONTH_NAMES[m]}
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 0 }}>
                  {/* Day name headers (single char) */}
                  {DAY_NAMES_SHORT.map(n => (
                    <div key={n} style={{ fontSize: 5.5, textAlign: 'center', color: 'var(--tn-text-muted)', fontWeight: 700 }}>
                      {n[0]}
                    </div>
                  ))}

                  {gridDays.map((day, i) => {
                    const dateStr = toDateStr(day);
                    const isThisMonth = day.getMonth() === m;
                    const isToday = dateStr === today;
                    const dayEvents = isThisMonth ? getEventsForDate(events, dateStr) : [];
                    const hasEvents = dayEvents.length > 0;
                    const mainColor = hasEvents ? (TYPE_COLOR[dayEvents[0].type] || '#565f89') : null;

                    return (
                      <div key={i} style={{
                        aspectRatio: '1',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 6,
                        borderRadius: 1.5,
                        background: isToday
                          ? '#7aa2f7'
                          : (hasEvents && mainColor ? mainColor + '2a' : 'transparent'),
                        color: isToday ? '#fff' : (isThisMonth ? 'var(--tn-text)' : 'transparent'),
                        fontWeight: isToday ? 700 : 400,
                        position: 'relative',
                      }}>
                        {isThisMonth ? day.getDate() : ''}
                        {hasEvents && !isToday && mainColor && (
                          <div style={{
                            position: 'absolute',
                            bottom: 0.5,
                            left: '50%',
                            transform: 'translateX(-50%)',
                            width: 2,
                            height: 1.5,
                            background: mainColor,
                            borderRadius: 1,
                          }} />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  // ── Render: Main ─────────────────────────────────────────────────────────────

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--tn-surface)' }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px',
        borderBottom: '1px solid var(--tn-border)', background: 'var(--tn-bg-dark)', flexShrink: 0,
      }}>
        <span style={{ fontSize: 14 }}>📅</span>
        <span style={{ fontWeight: 600, fontSize: 12, color: 'var(--tn-text)' }}>Kalender</span>

        {/* View toggle */}
        <div style={{ display: 'flex', gap: 1, background: 'rgba(0,0,0,0.2)', borderRadius: 4, padding: 1, marginLeft: 2 }}>
          {(['list', 'week', 'month', 'year'] as ViewMode[]).map(v => (
            <button key={v} onClick={() => setView(v)} style={{
              padding: '2px 6px', borderRadius: 3, border: 'none', cursor: 'pointer',
              fontSize: 10, fontWeight: view === v ? 700 : 400,
              background: view === v ? 'var(--tn-blue, #7aa2f7)' : 'transparent',
              color: view === v ? '#fff' : 'var(--tn-text-muted)',
              transition: 'background 0.1s',
            }}>
              {v === 'list' ? 'Liste' : v === 'week' ? 'Woche' : v === 'month' ? 'Monat' : 'Jahr'}
            </button>
          ))}
        </div>

        <div style={{ flex: 1 }} />

        {view === 'list' && (
          <button onClick={() => setShowAll(v => !v)} style={btnSecondary} title="Vergangene Termine ein-/ausblenden">
            {showAll ? 'Kommende' : 'Alle'}
          </button>
        )}
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

      {/* Loading */}
      {loading && (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--tn-text-muted)', fontSize: 12 }}>
          Lade...
        </div>
      )}

      {/* Views */}
      {!loading && view === 'list' && renderListView()}
      {!loading && view === 'week' && renderWeekView()}
      {!loading && view === 'month' && renderMonthView()}
      {!loading && view === 'year' && renderYearView()}
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

const btnNav: React.CSSProperties = {
  padding: '1px 8px', borderRadius: 4, border: '1px solid var(--tn-border)',
  background: 'transparent', cursor: 'pointer', color: 'var(--tn-text)',
  fontSize: 14, fontWeight: 600, lineHeight: 1.4,
};
