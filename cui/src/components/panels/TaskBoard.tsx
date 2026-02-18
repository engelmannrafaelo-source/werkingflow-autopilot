import { useState, useEffect, useCallback } from 'react';

const API = '/api';

interface Task {
  id: string;
  title: string;
  description: string;
  assignee: string;
  status: 'backlog' | 'in_progress' | 'review' | 'done';
  priority: 'low' | 'medium' | 'high';
  documentRef?: string;
  createdAt: string;
  updatedAt: string;
}

interface TaskBoardProps {
  personaId?: string;  // Filter für spezifische Persona
}

export default function TaskBoard({ personaId }: TaskBoardProps) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNewTask, setShowNewTask] = useState(false);
  const [newTask, setNewTask] = useState({ title: '', description: '', assignee: personaId || '', priority: 'medium' as Task['priority'] });

  useEffect(() => {
    loadTasks();
  }, [personaId]);

  async function loadTasks() {
    try {
      setLoading(true);
      const params = personaId ? `?assignee=${personaId}` : '';
      const response = await fetch(`${API}/team/tasks${params}`);
      if (!response.ok) throw new Error('Failed to load tasks');
      const data = await response.json();
      setTasks(data);
    } catch (err: any) {
      console.error('[TaskBoard] Load error:', err);
    } finally {
      setLoading(false);
    }
  }

  async function updateTaskStatus(taskId: string, status: Task['status']) {
    try {
      await fetch(`${API}/team/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      loadTasks();
    } catch (err: any) {
      console.error('[TaskBoard] Update error:', err);
    }
  }

  async function createTask() {
    if (!newTask.title.trim()) return;

    try {
      await fetch(`${API}/team/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newTask),
      });
      setNewTask({ title: '', description: '', assignee: personaId || '', priority: 'medium' });
      setShowNewTask(false);
      loadTasks();
    } catch (err: any) {
      console.error('[TaskBoard] Create error:', err);
    }
  }

  async function deleteTask(taskId: string) {
    try {
      await fetch(`${API}/team/tasks/${taskId}`, { method: 'DELETE' });
      loadTasks();
    } catch (err: any) {
      console.error('[TaskBoard] Delete error:', err);
    }
  }

  const columns = {
    backlog: tasks.filter(t => t.status === 'backlog'),
    in_progress: tasks.filter(t => t.status === 'in_progress'),
    review: tasks.filter(t => t.status === 'review'),
    done: tasks.filter(t => t.status === 'done'),
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--tn-text-muted)', fontSize: 12 }}>
        Loading tasks...
      </div>
    );
  }

  return (
    <div className="task-board">
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.75rem 1rem', borderBottom: '1px solid var(--tn-border)' }}>
        <h3 style={{ margin: 0, fontSize: 14, color: 'var(--tn-text)' }}>
          Task Board {personaId && `- ${personaId}`}
        </h3>
        <button
          onClick={() => setShowNewTask(!showNewTask)}
          style={{
            padding: '4px 12px',
            background: 'var(--tn-blue)',
            color: 'white',
            border: 'none',
            borderRadius: 4,
            cursor: 'pointer',
            fontSize: 12,
          }}
        >
          + New Task
        </button>
      </div>

      {/* New Task Form */}
      {showNewTask && (
        <div style={{ padding: '1rem', background: 'var(--tn-bg-highlight)', borderBottom: '1px solid var(--tn-border)' }}>
          <input
            type="text"
            placeholder="Task title..."
            value={newTask.title}
            onChange={(e) => setNewTask({ ...newTask, title: e.target.value })}
            style={{
              width: '100%',
              padding: '6px 8px',
              background: 'var(--tn-bg)',
              color: 'var(--tn-text)',
              border: '1px solid var(--tn-border)',
              borderRadius: 4,
              fontSize: 12,
              marginBottom: '0.5rem',
            }}
          />
          <textarea
            placeholder="Description (optional)..."
            value={newTask.description}
            onChange={(e) => setNewTask({ ...newTask, description: e.target.value })}
            rows={2}
            style={{
              width: '100%',
              padding: '6px 8px',
              background: 'var(--tn-bg)',
              color: 'var(--tn-text)',
              border: '1px solid var(--tn-border)',
              borderRadius: 4,
              fontSize: 12,
              marginBottom: '0.5rem',
              resize: 'vertical',
            }}
          />
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button onClick={createTask} style={{ padding: '4px 12px', background: 'var(--tn-green)', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 11 }}>
              Create
            </button>
            <button onClick={() => setShowNewTask(false)} style={{ padding: '4px 12px', background: 'var(--tn-bg)', color: 'var(--tn-text-muted)', border: '1px solid var(--tn-border)', borderRadius: 4, cursor: 'pointer', fontSize: 11 }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Kanban Columns */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '1rem', padding: '1rem', height: 'calc(100% - 60px)', overflow: 'hidden' }}>
        {Object.entries(columns).map(([status, columnTasks]) => (
          <div key={status} style={{ display: 'flex', flexDirection: 'column', background: 'var(--tn-surface)', borderRadius: 8, border: '1px solid var(--tn-border)', overflow: 'hidden' }}>
            {/* Column Header */}
            <div style={{ padding: '0.75rem', background: 'var(--tn-bg-dark)', borderBottom: '1px solid var(--tn-border)', fontWeight: 600, fontSize: 12, color: 'var(--tn-text)', textTransform: 'capitalize' }}>
              {status.replace('_', ' ')} ({columnTasks.length})
            </div>

            {/* Tasks */}
            <div style={{ flex: 1, padding: '0.5rem', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {columnTasks.map(task => (
                <div
                  key={task.id}
                  style={{
                    padding: '0.75rem',
                    background: 'var(--tn-bg)',
                    border: '1px solid var(--tn-border)',
                    borderRadius: 6,
                    cursor: 'pointer',
                    transition: 'all 0.2s',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--tn-blue)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--tn-border)'; }}
                >
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--tn-text)', marginBottom: '0.25rem' }}>{task.title}</div>
                  {task.description && (
                    <div style={{ fontSize: 11, color: 'var(--tn-text-muted)', marginBottom: '0.5rem' }}>
                      {task.description.slice(0, 80)}{task.description.length > 80 ? '...' : ''}
                    </div>
                  )}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '0.5rem' }}>
                    <span style={{ fontSize: 10, color: 'var(--tn-text-muted)' }}>{task.assignee}</span>
                    <div style={{ display: 'flex', gap: '0.25rem' }}>
                      {status !== 'backlog' && (
                        <button onClick={() => updateTaskStatus(task.id, 'backlog')} style={{ padding: '2px 6px', fontSize: 10, background: 'var(--tn-bg)', border: '1px solid var(--tn-border)', borderRadius: 3, cursor: 'pointer' }}>←</button>
                      )}
                      {status !== 'done' && (
                        <button onClick={() => updateTaskStatus(task.id, status === 'backlog' ? 'in_progress' : status === 'in_progress' ? 'review' : 'done')} style={{ padding: '2px 6px', fontSize: 10, background: 'var(--tn-blue)', color: 'white', border: 'none', borderRadius: 3, cursor: 'pointer' }}>→</button>
                      )}
                      <button onClick={() => deleteTask(task.id)} style={{ padding: '2px 6px', fontSize: 10, background: 'var(--tn-red)', color: 'white', border: 'none', borderRadius: 3, cursor: 'pointer' }}>×</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
