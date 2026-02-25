import { useState, useEffect } from 'react';
import TaskBoard from './TaskBoard';
import PersonaChat from './PersonaChat';
import ReviewQueue from './ReviewQueue';
import MeetingRoomView from './MeetingRoomView';
import KnowledgeGraphView from './KnowledgeGraphView';
import ScanDocumentsButton from './ScanDocumentsButton';
import PersonaDocumentList from './PersonaDocumentList';
import AgentDashboard from './AgentDashboard';
import CommandSidebar from './CommandSidebar';
import VirtualOffice from './VirtualOffice';

const API = '/api';

// --- Types ---
interface PersonaCard {
  id: string;
  name: string;
  role: string;
  mbti: string;
  status: 'idle' | 'working' | 'blocked' | 'review';
  worklistPath: string;
  lastUpdated: string;
  team?: string;
  department?: string;
  table?: string;
  governance?: 'auto-commit' | 'review-required';
  reportsTo?: string | null;
  specialty?: string;
  motto?: string;
}

interface OfficePanelProps {
  projectId?: string;
  workDir?: string;
}

type OfficePanelView = 'dashboard' | 'office' | 'chat' | 'tasks' | 'reviews' | 'knowledge' | 'agents';

export default function OfficePanel({ projectId, workDir }: OfficePanelProps) {
  const [personas, setPersonas] = useState<PersonaCard[]>([]);
  const [selected, setSelected] = useState<PersonaCard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<OfficePanelView>('dashboard');

  useEffect(() => {
    loadPersonas();
  }, []);

  async function loadPersonas() {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch(`${API}/team/personas`);
      if (!res.ok) throw new Error(`Failed: ${res.statusText}`);
      setPersonas(await res.json());
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function selectPersona(persona: PersonaCard) {
    setSelected(persona);
  }

  // When a persona-agent is selected in sidebar, highlight matching persona
  function handleAgentPersonaSelect(personaId: string) {
    const persona = personas.find(p => p.id === personaId);
    if (persona) setSelected(persona);
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--tn-text-muted)', fontSize: 12 }}>
        Loading virtual office...
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: '1rem', padding: '1rem' }}>
        <div style={{ color: 'var(--tn-red)', fontSize: 14 }}>Error loading office: {error}</div>
        <button onClick={loadPersonas} style={{ padding: '6px 12px', background: 'var(--tn-blue)', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>Retry</button>
      </div>
    );
  }

  return (
    <div className="office-panel">
      {/* Header — alle Tabs */}
      <div className="office-header">
        <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap' }}>
          {([
            ['dashboard', '🎛️ Dashboard'],
            ['office',   '🏢 Office'],
            ['tasks',    '📋 Tasks'],
            ['reviews',  '📝 Reviews'],
            ['knowledge','📚 Knowledge'],
            ['agents',   '🤖 Agents'],
          ] as [OfficePanelView, string][]).map(([v, label]) => (
            <button
              key={v}
              onClick={() => setView(v)}
              style={{
                padding: '5px 11px',
                background: view === v ? 'var(--tn-blue)' : 'var(--tn-bg)',
                color: view === v ? 'white' : 'var(--tn-text-muted)',
                border: '1px solid var(--tn-border)',
                borderRadius: 4,
                cursor: 'pointer',
                fontSize: 12,
                fontWeight: view === v ? 600 : 400,
              }}
            >
              {label}
            </button>
          ))}
          <button
            onClick={() => setView('chat')}
            style={{
              padding: '5px 11px',
              background: view === 'chat' ? 'var(--tn-blue)' : 'var(--tn-bg)',
              color: view === 'chat' ? 'white' : 'var(--tn-text-muted)',
              border: '1px solid var(--tn-border)',
              borderRadius: 4,
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: view === 'chat' ? 600 : 400,
            }}
          >
            {selected ? `💬 ${selected.name.split(' ')[0]}` : '💬 Chat'}
          </button>
        </div>
        <span style={{ fontSize: 11, color: 'var(--tn-text-muted)', flexShrink: 0 }}>
          {personas.length} Members
        </span>
      </div>

      {/* Body: Main + Command Sidebar (or full-width dashboard) */}
      {view === 'dashboard' ? (
        /* Full-width dashboard (no sidebar) */
        <VirtualOffice projectId={projectId} workDir={workDir} />
      ) : (
        <div className="office-body">
          {/* Main Content */}
          <div className="office-main">
            {view === 'office' && (
              <MeetingRoomView
                personas={personas}
                onSelectPersona={(p) => { selectPersona(p); }}
                selected={selected}
              />
            )}

            {view === 'tasks' && (
              <TaskBoard personaId={selected?.id} />
            )}

          {view === 'chat' && (
            selected
              ? <PersonaChat personaId={selected.id} personaName={selected.name} />
              : (
                <div style={{ padding: '2rem', textAlign: 'center' }}>
                  <div style={{ color: 'var(--tn-text-muted)', fontSize: 12, marginBottom: '1rem' }}>
                    Persona im Meeting Room auswählen um zu chatten.
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', justifyContent: 'center', maxWidth: 500, margin: '0 auto' }}>
                    {personas.slice(0, 8).map(p => (
                      <button
                        key={p.id}
                        onClick={() => { selectPersona(p); }}
                        style={{ padding: '5px 10px', background: 'var(--tn-bg)', border: '1px solid var(--tn-border)', borderRadius: 4, cursor: 'pointer', fontSize: 11, color: 'var(--tn-text)' }}
                      >
                        {p.name}
                      </button>
                    ))}
                  </div>
                </div>
              )
          )}

          {view === 'reviews' && <ReviewQueue />}

          {view === 'knowledge' && (
            <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'auto' }}>
              <ScanDocumentsButton />
              <KnowledgeGraphView
                personas={personas}
                onPersonaClick={(personaId) => {
                  const p = personas.find(x => x.id === personaId);
                  if (p) selectPersona(p);
                }}
                selected={selected}
              />
              {selected && <PersonaDocumentList personaId={selected.id} personaName={selected.name} />}
            </div>
          )}

          {view === 'agents' && <AgentDashboard />}
          </div>

          {/* Command Center Sidebar — always visible (except in dashboard view) */}
          <CommandSidebar onPersonaAgentSelect={handleAgentPersonaSelect} />
        </div>
      )}
    </div>
  );
}
