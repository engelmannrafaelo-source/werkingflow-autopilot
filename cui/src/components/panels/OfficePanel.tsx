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

// Simplified view types - removed redundant tabs (dashboard is now the main office view)
type OfficePanelView = 'office' | 'tasks' | 'reviews';

export default function OfficePanel({ projectId, workDir }: OfficePanelProps) {
  const [personas, setPersonas] = useState<PersonaCard[]>([]);
  const [selected, setSelected] = useState<PersonaCard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<OfficePanelView>('office'); // Default to office (Virtual Office 3-panel)

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
      {/* Header — Clean 3 Tabs */}
      <div className="office-header">
        <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap' }}>
          {([
            ['office',   '🏢 Office'],
            ['tasks',    '📋 Tasks'],
            ['reviews',  '📝 Reviews'],
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
        </div>
        <span style={{ fontSize: 11, color: 'var(--tn-text-muted)', flexShrink: 0 }}>
          {personas.length} Members
        </span>
      </div>

      {/* Body: Main + Command Sidebar (or full-width office view) */}
      {view === 'office' ? (
        /* Full-width Virtual Office - 3-panel dashboard with Activity Stream, Agent Grid, Action Items */
        <VirtualOffice projectId={projectId} workDir={workDir} />
      ) : (
        <div className="office-body">
          {/* Main Content */}
          <div className="office-main">

            {view === 'tasks' && (
              <TaskBoard personaId={selected?.id} />
            )}

            {view === 'reviews' && <ReviewQueue />}
          </div>

          {/* Command Center Sidebar — only for tasks/reviews (office has its own right panel) */}
          {(view === 'tasks' || view === 'reviews') && (
            <CommandSidebar onPersonaAgentSelect={handleAgentPersonaSelect} />
          )}
        </div>
      )}
    </div>
  );
}
