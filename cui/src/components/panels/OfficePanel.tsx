import { useState, useEffect, useCallback } from 'react';
import TaskBoard from './TaskBoard';
import PersonaChat from './PersonaChat';

const API = '/api';

// --- Types ---
interface PersonaCard {
  id: string;              // 'max', 'vera', 'sarah', ...
  name: string;            // 'Max Weber'
  role: string;            // 'CTO'
  mbti: string;            // 'ENTJ'
  status: 'idle' | 'working' | 'blocked' | 'review';
  worklistPath: string;    // '/root/.../worklists/max.md'
  lastUpdated: string;     // ISO timestamp
}

interface OfficePanelProps {
  projectId?: string;
  workDir?: string;
}

export default function OfficePanel({ projectId, workDir }: OfficePanelProps) {
  const [personas, setPersonas] = useState<PersonaCard[]>([]);
  const [selected, setSelected] = useState<PersonaCard | null>(null);
  const [worklist, setWorklist] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<'grid' | 'tasks' | 'chat'>('grid');

  // Load personas on mount
  useEffect(() => {
    loadPersonas();
  }, []);

  async function loadPersonas() {
    try {
      setLoading(true);
      setError(null);
      const response = await fetch(`${API}/team/personas`);
      if (!response.ok) throw new Error(`Failed to load personas: ${response.statusText}`);
      const data = await response.json();
      setPersonas(data);
    } catch (err: any) {
      console.error('[OfficePanel] Load personas error:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function selectPersona(persona: PersonaCard) {
    setSelected(persona);
    try {
      const response = await fetch(`${API}/team/worklist/${persona.id}`);
      if (!response.ok) {
        setWorklist(`# ${persona.name}\n\n_No worklist found._`);
        return;
      }
      const content = await response.text();
      setWorklist(content);
    } catch (err: any) {
      console.error(`[OfficePanel] Load worklist error for ${persona.id}:`, err);
      setWorklist(`# ${persona.name}\n\n_Error loading worklist: ${err.message}_`);
    }
  }

  if (loading) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        color: 'var(--tn-text-muted)',
        fontSize: 12,
      }}>
        Loading virtual office...
      </div>
    );
  }

  if (error) {
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        gap: '1rem',
        padding: '1rem',
      }}>
        <div style={{ color: 'var(--tn-red)', fontSize: 14 }}>
          Error loading office: {error}
        </div>
        <button
          onClick={loadPersonas}
          style={{
            padding: '6px 12px',
            background: 'var(--tn-blue)',
            color: 'white',
            border: 'none',
            borderRadius: 4,
            cursor: 'pointer',
            fontSize: 12,
          }}
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="office-panel">
      {/* Header with Tabs */}
      <div className="office-header">
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button
            onClick={() => setView('grid')}
            style={{
              padding: '6px 12px',
              background: view === 'grid' ? 'var(--tn-blue)' : 'var(--tn-bg)',
              color: view === 'grid' ? 'white' : 'var(--tn-text-muted)',
              border: '1px solid var(--tn-border)',
              borderRadius: 4,
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: view === 'grid' ? 600 : 400,
            }}
          >
            👥 Team
          </button>
          <button
            onClick={() => setView('tasks')}
            style={{
              padding: '6px 12px',
              background: view === 'tasks' ? 'var(--tn-blue)' : 'var(--tn-bg)',
              color: view === 'tasks' ? 'white' : 'var(--tn-text-muted)',
              border: '1px solid var(--tn-border)',
              borderRadius: 4,
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: view === 'tasks' ? 600 : 400,
            }}
          >
            📋 Tasks
          </button>
          {selected && (
            <button
              onClick={() => setView('chat')}
              style={{
                padding: '6px 12px',
                background: view === 'chat' ? 'var(--tn-blue)' : 'var(--tn-bg)',
                color: view === 'chat' ? 'white' : 'var(--tn-text-muted)',
                border: '1px solid var(--tn-border)',
                borderRadius: 4,
                cursor: 'pointer',
                fontSize: 12,
                fontWeight: view === 'chat' ? 600 : 400,
              }}
            >
              💬 Chat with {selected.name}
            </button>
          )}
        </div>
        <span style={{ fontSize: 11, color: 'var(--tn-text-muted)' }}>
          {personas.length} Team Members
        </span>
      </div>

      {/* View Content */}
      {view === 'grid' && (
        <>
          {/* Persona Grid */}
          <div className="persona-grid">
            {personas.map((persona) => (
              <div
                key={persona.id}
                className={`persona-card ${selected?.id === persona.id ? 'selected' : ''}`}
                onClick={() => selectPersona(persona)}
              >
                <div className="persona-avatar">
                  {persona.name.split(' ').map(n => n[0]).join('')}
                </div>
                <div className="persona-info">
                  <div className="persona-name">{persona.name}</div>
                  <div className="persona-role">{persona.role}</div>
                  <div className="persona-mbti">{persona.mbti}</div>
                </div>
                <div className={`persona-status ${persona.status}`}>
                  {persona.status}
                </div>
              </div>
            ))}
          </div>

          {/* Worklist Viewer */}
          {selected && (
            <div className="worklist-viewer">
              <div className="worklist-header">
                <h4 style={{ margin: 0, fontSize: 13, color: 'var(--tn-text)' }}>
                  {selected.name}'s Worklist
                </h4>
                <span style={{ fontSize: 10, color: 'var(--tn-text-muted)' }}>
                  Last updated: {new Date(selected.lastUpdated).toLocaleString()}
                </span>
              </div>
              <div className="worklist-content">
                <pre style={{
                  whiteSpace: 'pre-wrap',
                  wordWrap: 'break-word',
                  fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
                  fontSize: 11,
                  lineHeight: 1.6,
                  color: 'var(--tn-text)',
                  margin: 0,
                }}>
                  {worklist}
                </pre>
              </div>
            </div>
          )}
        </>
      )}

      {view === 'tasks' && (
        <TaskBoard personaId={selected?.id} />
      )}

      {view === 'chat' && selected && (
        <PersonaChat personaId={selected.id} personaName={selected.name} />
      )}
    </div>
  );
}
