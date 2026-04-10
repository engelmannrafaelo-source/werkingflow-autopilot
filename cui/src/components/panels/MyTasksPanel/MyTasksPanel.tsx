/**
 * MyTasksPanel — Task assignment and status tracking for partners.
 *
 * - Partners: See own tasks, toggle status, add comments
 * - Admins: Full CRUD, task creation form, all tasks visible
 * - Badge: Open task count shown in parent tab header via data attribute
 */

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../../contexts/AuthContext';

// --- Types ---
interface TaskComment {
  from: string;
  text: string;
  date: string;
}

interface PartnerTask {
  id: string;
  title: string;
  description: string;
  assignedTo: string;
  assignedBy: string;
  status: 'assigned' | 'in-progress' | 'done' | 'review';
  priority: 'high' | 'medium' | 'low';
  dueDate?: string;
  createdAt: string;
  updatedAt: string;
  comments: TaskComment[];
}

type TaskStatus = PartnerTask['status'];
type TaskPriority = PartnerTask['priority'];

const STATUS_LABELS: Record<TaskStatus, string> = {
  'assigned': 'Zugewiesen',
  'in-progress': 'In Arbeit',
  'review': 'Review',
  'done': 'Erledigt',
};

const STATUS_ORDER: TaskStatus[] = ['assigned', 'in-progress', 'review', 'done'];

const PRIORITY_COLORS: Record<TaskPriority, string> = {
  high: '#f7768e',
  medium: '#e0af68',
  low: 'var(--tn-text-muted)',
};

const PRIORITY_LABELS: Record<TaskPriority, string> = {
  high: 'Hoch',
  medium: 'Mittel',
  low: 'Niedrig',
};

// Status sequence for toggle (partners cycle through assigned → in-progress → review → done)
const NEXT_STATUS: Record<TaskStatus, TaskStatus> = {
  'assigned': 'in-progress',
  'in-progress': 'review',
  'review': 'done',
  'done': 'assigned',
};

// --- Styles ---
const s = {
  root: {
    display: 'flex',
    flexDirection: 'column' as const,
    height: '100%',
    background: 'var(--tn-bg-dark)',
    color: 'var(--tn-text)',
    fontSize: 13,
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 14px',
    borderBottom: '1px solid var(--tn-border)',
    background: 'var(--tn-surface)',
    flexShrink: 0,
  },
  headerTitle: {
    fontWeight: 600,
    fontSize: 14,
    color: 'var(--tn-text)',
  },
  badge: {
    background: '#f7768e',
    color: '#fff',
    borderRadius: 10,
    padding: '1px 7px',
    fontSize: 11,
    fontWeight: 700,
    marginLeft: 8,
  },
  btnPrimary: {
    background: 'var(--tn-accent)',
    color: '#fff',
    border: 'none',
    borderRadius: 4,
    padding: '5px 12px',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 600,
  },
  content: {
    flex: 1,
    overflowY: 'auto' as const,
    padding: '12px 14px',
  },
  section: {
    marginBottom: 20,
  },
  sectionHeader: {
    fontSize: 11,
    fontWeight: 700,
    textTransform: 'uppercase' as const,
    letterSpacing: 1,
    color: 'var(--tn-text-muted)',
    marginBottom: 8,
    paddingBottom: 4,
    borderBottom: '1px solid var(--tn-border)',
  },
  card: {
    background: 'var(--tn-surface)',
    border: '1px solid var(--tn-border)',
    borderRadius: 6,
    padding: '10px 12px',
    marginBottom: 8,
    cursor: 'pointer',
    transition: 'border-color 0.15s',
  },
  cardSelected: {
    borderColor: 'var(--tn-accent)',
  },
  cardRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  cardTitle: {
    fontWeight: 600,
    fontSize: 13,
    flex: 1,
    whiteSpace: 'nowrap' as const,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  priorityDot: (priority: TaskPriority) => ({
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: PRIORITY_COLORS[priority],
    flexShrink: 0,
  }),
  statusChip: (status: TaskStatus) => ({
    fontSize: 10,
    fontWeight: 700,
    padding: '2px 7px',
    borderRadius: 10,
    background: status === 'done' ? '#9ece6a22' : status === 'in-progress' ? '#7aa2f722' : status === 'review' ? '#e0af6822' : 'var(--tn-border)',
    color: status === 'done' ? '#9ece6a' : status === 'in-progress' ? '#7aa2f7' : status === 'review' ? '#e0af68' : 'var(--tn-text-muted)',
    cursor: 'pointer',
    userSelect: 'none' as const,
    flexShrink: 0,
  }),
  meta: {
    fontSize: 11,
    color: 'var(--tn-text-muted)',
    marginTop: 4,
  },
  emptyHint: {
    color: 'var(--tn-text-muted)',
    fontSize: 12,
    textAlign: 'center' as const,
    padding: '20px 0',
  },
  // Detail view
  detail: {
    background: 'var(--tn-surface)',
    border: '1px solid var(--tn-border)',
    borderRadius: 6,
    padding: '14px 16px',
    marginBottom: 16,
  },
  detailTitle: {
    fontWeight: 700,
    fontSize: 15,
    marginBottom: 6,
  },
  detailMeta: {
    fontSize: 11,
    color: 'var(--tn-text-muted)',
    marginBottom: 10,
    display: 'flex',
    gap: 12,
    flexWrap: 'wrap' as const,
  },
  description: {
    fontSize: 12,
    color: 'var(--tn-text)',
    lineHeight: 1.6,
    marginBottom: 12,
    whiteSpace: 'pre-wrap' as const,
  },
  commentsHeader: {
    fontSize: 11,
    fontWeight: 700,
    color: 'var(--tn-text-muted)',
    textTransform: 'uppercase' as const,
    letterSpacing: 0.8,
    marginBottom: 8,
  },
  comment: {
    background: 'var(--tn-bg-dark)',
    borderRadius: 4,
    padding: '7px 10px',
    marginBottom: 6,
    fontSize: 12,
  },
  commentMeta: {
    fontSize: 10,
    color: 'var(--tn-text-muted)',
    marginBottom: 2,
  },
  commentForm: {
    display: 'flex',
    gap: 8,
    marginTop: 8,
  },
  textarea: {
    flex: 1,
    background: 'var(--tn-bg-dark)',
    border: '1px solid var(--tn-border)',
    borderRadius: 4,
    color: 'var(--tn-text)',
    fontSize: 12,
    padding: '6px 8px',
    resize: 'vertical' as const,
    minHeight: 56,
    fontFamily: 'inherit',
  },
  btnSmall: {
    background: 'var(--tn-accent)',
    color: '#fff',
    border: 'none',
    borderRadius: 4,
    padding: '6px 12px',
    cursor: 'pointer',
    fontSize: 12,
    alignSelf: 'flex-end',
  },
  btnBack: {
    background: 'none',
    border: 'none',
    color: 'var(--tn-text-muted)',
    cursor: 'pointer',
    fontSize: 12,
    padding: 0,
    marginBottom: 12,
    display: 'flex',
    alignItems: 'center',
    gap: 4,
  },
  // Create form
  form: {
    background: 'var(--tn-surface)',
    border: '1px solid var(--tn-border)',
    borderRadius: 6,
    padding: '14px 16px',
    marginBottom: 16,
  },
  formTitle: {
    fontWeight: 700,
    fontSize: 14,
    marginBottom: 12,
  },
  formField: {
    marginBottom: 10,
  },
  label: {
    display: 'block',
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--tn-text-muted)',
    marginBottom: 4,
    textTransform: 'uppercase' as const,
    letterSpacing: 0.5,
  },
  input: {
    width: '100%',
    background: 'var(--tn-bg-dark)',
    border: '1px solid var(--tn-border)',
    borderRadius: 4,
    color: 'var(--tn-text)',
    fontSize: 12,
    padding: '6px 8px',
    boxSizing: 'border-box' as const,
    fontFamily: 'inherit',
  },
  select: {
    width: '100%',
    background: 'var(--tn-bg-dark)',
    border: '1px solid var(--tn-border)',
    borderRadius: 4,
    color: 'var(--tn-text)',
    fontSize: 12,
    padding: '6px 8px',
    boxSizing: 'border-box' as const,
    fontFamily: 'inherit',
  },
  formRow: {
    display: 'flex',
    gap: 10,
  },
  formActions: {
    display: 'flex',
    gap: 8,
    marginTop: 12,
  },
  btnSecondary: {
    background: 'var(--tn-border)',
    color: 'var(--tn-text)',
    border: 'none',
    borderRadius: 4,
    padding: '5px 12px',
    cursor: 'pointer',
    fontSize: 12,
  },
  error: {
    color: '#f7768e',
    fontSize: 12,
    marginTop: 8,
  },
};

// --- Component ---
export default function MyTasksPanel() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin' || user?.role === 'product-owner';

  const [tasks, setTasks] = useState<PartnerTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedTask, setSelectedTask] = useState<PartnerTask | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [commentText, setCommentText] = useState('');
  const [submittingComment, setSubmittingComment] = useState(false);
  const [togglingStatus, setTogglingStatus] = useState<string | null>(null);

  // Create form state
  const [createForm, setCreateForm] = useState({
    title: '',
    description: '',
    assignedTo: '',
    priority: 'medium' as TaskPriority,
    dueDate: '',
  });
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const fetchTasks = useCallback(async () => {
    try {
      const url = isAdmin ? '/api/partner/tasks' : `/api/partner/tasks${user ? `?userId=${encodeURIComponent(user.id)}` : ''}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setTasks(data.tasks ?? []);
      setError(null);
    } catch (err) {
      console.warn('[MyTasksPanel] fetch failed:', err);
      setError('Tasks konnten nicht geladen werden.');
    } finally {
      setLoading(false);
    }
  }, [isAdmin, user]);

  useEffect(() => {
    fetchTasks();
    const interval = setInterval(fetchTasks, 30000);
    return () => clearInterval(interval);
  }, [fetchTasks]);

  // Keep selected task in sync after refresh
  useEffect(() => {
    if (selectedTask) {
      const updated = tasks.find(t => t.id === selectedTask.id);
      if (updated) setSelectedTask(updated);
    }
  }, [tasks]);

  // Open task count (non-done tasks)
  const openCount = tasks.filter(t => t.status !== 'done').length;

  async function toggleStatus(task: PartnerTask, e: React.MouseEvent) {
    e.stopPropagation();
    const nextStatus = NEXT_STATUS[task.status];
    setTogglingStatus(task.id);
    try {
      const res = await fetch(`/api/partner/tasks/${task.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: nextStatus }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setTasks(prev => prev.map(t => t.id === task.id ? data.task : t));
      if (selectedTask?.id === task.id) setSelectedTask(data.task);
    } catch (err) {
      console.error('[MyTasksPanel] toggleStatus failed:', err);
    } finally {
      setTogglingStatus(null);
    }
  }

  async function submitComment() {
    if (!selectedTask || !commentText.trim()) return;
    setSubmittingComment(true);
    try {
      const res = await fetch(`/api/partner/tasks/${selectedTask.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          comment: {
            from: user?.name || user?.id || 'Partner',
            text: commentText.trim(),
          },
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setTasks(prev => prev.map(t => t.id === selectedTask.id ? data.task : t));
      setSelectedTask(data.task);
      setCommentText('');
    } catch (err) {
      console.error('[MyTasksPanel] submitComment failed:', err);
    } finally {
      setSubmittingComment(false);
    }
  }

  async function deleteTask(taskId: string) {
    if (!window.confirm('Task wirklich löschen?')) return;
    try {
      const res = await fetch(`/api/partner/tasks/${taskId}`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setTasks(prev => prev.filter(t => t.id !== taskId));
      if (selectedTask?.id === taskId) setSelectedTask(null);
    } catch (err) {
      console.error('[MyTasksPanel] deleteTask failed:', err);
    }
  }

  async function submitCreate() {
    if (!createForm.title.trim()) { setCreateError('Titel ist erforderlich.'); return; }
    if (!createForm.assignedTo.trim()) { setCreateError('Empfänger ist erforderlich.'); return; }
    setCreating(true);
    setCreateError(null);
    try {
      const res = await fetch('/api/partner/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: createForm.title.trim(),
          description: createForm.description.trim(),
          assignedTo: createForm.assignedTo.trim(),
          priority: createForm.priority,
          dueDate: createForm.dueDate.trim() || undefined,
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Fehler beim Erstellen' }));
        setCreateError(err.error || 'Fehler beim Erstellen');
        return;
      }
      const data = await res.json();
      setTasks(prev => [...prev, data.task]);
      setShowCreateForm(false);
      setCreateForm({ title: '', description: '', assignedTo: '', priority: 'medium', dueDate: '' });
    } catch (err) {
      setCreateError('Netzwerkfehler beim Erstellen.');
    } finally {
      setCreating(false);
    }
  }

  // --- Task list grouped by status ---
  function renderTaskList() {
    const sections = STATUS_ORDER.filter(status => {
      // Don't show empty 'done' section by default if no done tasks
      const statusTasks = tasks.filter(t => t.status === status);
      return statusTasks.length > 0 || status !== 'done';
    });

    return (
      <>
        {sections.map(status => {
          const statusTasks = tasks.filter(t => t.status === status);
          return (
            <div key={status} style={s.section}>
              <div style={s.sectionHeader}>
                {STATUS_LABELS[status]}
                {statusTasks.length > 0 && (
                  <span style={{ marginLeft: 6, fontWeight: 400, color: 'var(--tn-text-muted)' }}>
                    ({statusTasks.length})
                  </span>
                )}
              </div>
              {statusTasks.length === 0 ? (
                <div style={s.emptyHint}>Keine Tasks</div>
              ) : (
                statusTasks.map(task => (
                  <div
                    key={task.id}
                    style={{ ...s.card, ...(selectedTask?.id === task.id ? s.cardSelected : {}) }}
                    onClick={() => setSelectedTask(task)}
                    data-task-id={task.id}
                  >
                    <div style={s.cardRow}>
                      <div style={s.priorityDot(task.priority)} title={PRIORITY_LABELS[task.priority]} />
                      <div style={s.cardTitle}>{task.title}</div>
                      <div
                        style={s.statusChip(task.status)}
                        onClick={(e) => toggleStatus(task, e)}
                        title="Klicken zum Status-Wechsel"
                      >
                        {togglingStatus === task.id ? '…' : STATUS_LABELS[task.status]}
                      </div>
                    </div>
                    {(task.assignedTo || task.dueDate) && (
                      <div style={s.meta}>
                        {isAdmin && <span>{task.assignedTo}</span>}
                        {isAdmin && task.dueDate && <span> · </span>}
                        {task.dueDate && <span>Fällig: {task.dueDate}</span>}
                        {task.comments.length > 0 && (
                          <span style={{ marginLeft: 8, opacity: 0.7 }}>
                            💬 {task.comments.length}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          );
        })}
      </>
    );
  }

  // --- Task detail view ---
  function renderDetail(task: PartnerTask) {
    return (
      <div>
        <button style={s.btnBack} onClick={() => setSelectedTask(null)}>
          ← Zurück zur Liste
        </button>
        <div style={s.detail}>
          <div style={s.cardRow}>
            <div style={s.detailTitle}>{task.title}</div>
            <div style={{ ...s.priorityDot(task.priority), width: 10, height: 10 }} title={PRIORITY_LABELS[task.priority]} />
          </div>
          <div style={s.detailMeta}>
            <span style={s.statusChip(task.status)} onClick={(e) => toggleStatus(task, e)} title="Klicken zum Status-Wechsel">
              {STATUS_LABELS[task.status]}
            </span>
            <span>Priorität: <strong style={{ color: PRIORITY_COLORS[task.priority] }}>{PRIORITY_LABELS[task.priority]}</strong></span>
            {isAdmin && <span>Zugewiesen an: <strong>{task.assignedTo}</strong></span>}
            <span>Von: {task.assignedBy}</span>
            {task.dueDate && <span>Fällig: {task.dueDate}</span>}
            <span style={{ marginLeft: 'auto', opacity: 0.6 }}>
              Erstellt: {new Date(task.createdAt).toLocaleDateString('de')}
            </span>
          </div>
          {task.description && (
            <div style={s.description}>{task.description}</div>
          )}
          {isAdmin && (
            <button
              style={{ ...s.btnSecondary, fontSize: 11, color: '#f7768e', marginTop: 4 }}
              onClick={() => deleteTask(task.id)}
            >
              Task löschen
            </button>
          )}
        </div>

        {/* Comments */}
        <div style={{ marginBottom: 12 }}>
          <div style={s.commentsHeader}>Kommentare ({task.comments.length})</div>
          {task.comments.length === 0 && (
            <div style={s.emptyHint}>Noch keine Kommentare</div>
          )}
          {task.comments.map((c, i) => (
            <div key={i} style={s.comment}>
              <div style={s.commentMeta}>
                <strong>{c.from}</strong> · {new Date(c.date).toLocaleString('de')}
              </div>
              <div>{c.text}</div>
            </div>
          ))}
        </div>

        {/* Comment form */}
        <div>
          <div style={s.commentsHeader}>Kommentar hinzufügen</div>
          <div style={s.commentForm}>
            <textarea
              style={s.textarea}
              value={commentText}
              onChange={e => setCommentText(e.target.value)}
              placeholder="Kommentar schreiben..."
            />
            <button
              style={s.btnSmall}
              onClick={submitComment}
              disabled={!commentText.trim() || submittingComment}
            >
              {submittingComment ? '…' : 'Senden'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // --- Create form ---
  function renderCreateForm() {
    return (
      <div>
        <button style={s.btnBack} onClick={() => { setShowCreateForm(false); setCreateError(null); }}>
          ← Zurück
        </button>
        <div style={s.form}>
          <div style={s.formTitle}>Neuen Task erstellen</div>
          <div style={s.formField}>
            <label style={s.label}>Titel *</label>
            <input
              style={s.input}
              value={createForm.title}
              onChange={e => setCreateForm(f => ({ ...f, title: e.target.value }))}
              placeholder="Task-Titel"
            />
          </div>
          <div style={s.formField}>
            <label style={s.label}>Beschreibung</label>
            <textarea
              style={{ ...s.textarea, minHeight: 80 }}
              value={createForm.description}
              onChange={e => setCreateForm(f => ({ ...f, description: e.target.value }))}
              placeholder="Optionale Beschreibung..."
            />
          </div>
          <div style={{ ...s.formRow }}>
            <div style={{ ...s.formField, flex: 1 }}>
              <label style={s.label}>Empfänger (User-ID) *</label>
              <input
                style={s.input}
                value={createForm.assignedTo}
                onChange={e => setCreateForm(f => ({ ...f, assignedTo: e.target.value }))}
                placeholder="partner-user-id"
              />
            </div>
            <div style={{ ...s.formField, flex: 1 }}>
              <label style={s.label}>Priorität</label>
              <select
                style={s.select}
                value={createForm.priority}
                onChange={e => setCreateForm(f => ({ ...f, priority: e.target.value as TaskPriority }))}
              >
                <option value="high">Hoch</option>
                <option value="medium">Mittel</option>
                <option value="low">Niedrig</option>
              </select>
            </div>
          </div>
          <div style={s.formField}>
            <label style={s.label}>Fälligkeitsdatum</label>
            <input
              type="date"
              style={s.input}
              value={createForm.dueDate}
              onChange={e => setCreateForm(f => ({ ...f, dueDate: e.target.value }))}
            />
          </div>
          {createError && <div style={s.error}>{createError}</div>}
          <div style={s.formActions}>
            <button style={s.btnPrimary} onClick={submitCreate} disabled={creating}>
              {creating ? 'Erstelle…' : 'Task erstellen'}
            </button>
            <button style={s.btnSecondary} onClick={() => { setShowCreateForm(false); setCreateError(null); }}>
              Abbrechen
            </button>
          </div>
        </div>
      </div>
    );
  }

  // --- Render ---
  return (
    <div style={s.root} data-ai-id="my-tasks-panel">
      <div style={s.header}>
        <div style={s.headerTitle}>
          Meine Tasks
          {openCount > 0 && <span style={s.badge}>{openCount}</span>}
        </div>
        {isAdmin && !showCreateForm && !selectedTask && (
          <button style={s.btnPrimary} onClick={() => setShowCreateForm(true)}>
            + Task
          </button>
        )}
      </div>

      <div style={s.content}>
        {loading && (
          <div style={s.emptyHint}>Lade Tasks…</div>
        )}
        {!loading && error && (
          <div style={{ ...s.emptyHint, color: '#f7768e' }}>{error}</div>
        )}
        {!loading && !error && (
          <>
            {showCreateForm && renderCreateForm()}
            {!showCreateForm && selectedTask && renderDetail(selectedTask)}
            {!showCreateForm && !selectedTask && (
              tasks.length === 0 ? (
                <div style={s.emptyHint}>
                  Keine Tasks vorhanden.
                  {isAdmin && <div style={{ marginTop: 8 }}>Erstelle einen neuen Task mit dem + Button.</div>}
                </div>
              ) : renderTaskList()
            )}
          </>
        )}
      </div>
    </div>
  );
}
