import { useState, useEffect } from 'react';
import type { AgentStatus } from '../panels/VirtualOffice';

const API = '/api';

interface PersonaData {
  id: string;
  name: string;
  role: string;
  mbti: string;
  specialty?: string;
  reportsTo?: string;
  team?: string;
  department?: string;
  motto?: string;
  strengths: string[];
  weaknesses: string[];
  responsibilities: string[];
  collaboration: Array<{ person: string; reason: string }>;
}

interface MemoryEntry {
  timestamp: string;
  trigger: string;
  actions: number;
  action_types: string[];
  response_preview?: string;
}

interface AgentDetailModalProps {
  agent: AgentStatus;
  onClose: () => void;
  onRunAgent?: (personaId: string, task?: string) => void;
}

type Tab = 'overview' | 'history' | 'current';

export default function AgentDetailModal({ agent, onClose, onRunAgent }: AgentDetailModalProps) {
  const [tab, setTab] = useState<Tab>('overview');
  const [persona, setPersona] = useState<PersonaData | null>(null);
  const [memory, setMemory] = useState<MemoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [customTask, setCustomTask] = useState('');

  useEffect(() => {
    loadPersonaData();
    loadMemory();
  }, [agent.persona_id]);

  async function loadPersonaData() {
    try {
      const res = await fetch(`${API}/agents/persona/${agent.persona_id}`);
      if (!res.ok) throw new Error('Failed to load persona');
      setPersona(await res.json());
    } catch (err) {
      console.error('Failed to load persona:', err);
    } finally {
      setLoading(false);
    }
  }

  async function loadMemory() {
    try {
      const res = await fetch(`${API}/agents/claude/memory/${agent.persona_id}`);
      if (!res.ok) throw new Error('Failed to load memory');
      const data = await res.json();
      setMemory(data.memory || []);
    } catch (err) {
      console.error('Failed to load memory:', err);
    }
  }

  function handleRunCustomTask() {
    if (customTask.trim() && onRunAgent) {
      onRunAgent(agent.persona_id, customTask.trim());
      onClose();
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2000,
        background: 'rgba(0, 0, 0, 0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--tn-surface)',
          border: '1px solid var(--tn-border)',
          borderRadius: 12,
          width: '100%',
          maxWidth: 700,
          maxHeight: '85vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 8px 32px rgba(0, 0, 0, 0.3)'
        }}
      >
        {/* Header */}
        <div style={{
          padding: '16px 20px',
          borderBottom: '1px solid var(--tn-border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between'
        }}>
          <div>
            <div style={{
              fontSize: 16,
              fontWeight: 600,
              color: 'var(--tn-text)',
              marginBottom: 4
            }}>
              {agent.persona_name}
            </div>
            <div style={{
              fontSize: 12,
              color: 'var(--tn-text-muted)'
            }}>
              {persona?.role || agent.schedule}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--tn-text-muted)',
              fontSize: 20,
              cursor: 'pointer',
              padding: 4,
              lineHeight: 1
            }}
          >
            ×
          </button>
        </div>

        {/* Tabs */}
        <div style={{
          display: 'flex',
          gap: 4,
          padding: '12px 20px',
          borderBottom: '1px solid var(--tn-border)',
          background: 'var(--tn-bg)'
        }}>
          {[
            { id: 'overview', label: '📋 Overview' },
            { id: 'history', label: '📜 History' },
            { id: 'current', label: '⚡ Current' }
          ].map(({ id, label }) => (
            <button
              key={id}
              onClick={() => setTab(id as Tab)}
              style={{
                padding: '6px 12px',
                background: tab === id ? 'var(--tn-blue)' : 'transparent',
                color: tab === id ? 'white' : 'var(--tn-text-muted)',
                border: 'none',
                borderRadius: 6,
                fontSize: 12,
                fontWeight: tab === id ? 600 : 400,
                cursor: 'pointer',
                transition: 'all 0.2s ease'
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div style={{
          flex: 1,
          overflow: 'auto',
          padding: 20
        }}>
          {loading && tab === 'overview' ? (
            <div style={{ textAlign: 'center', padding: 40, color: 'var(--tn-text-muted)', fontSize: 12 }}>
              Loading persona data...
            </div>
          ) : tab === 'overview' ? (
            <OverviewTab persona={persona} agent={agent} />
          ) : tab === 'history' ? (
            <HistoryTab memory={memory} />
          ) : (
            <CurrentTab agent={agent} customTask={customTask} setCustomTask={setCustomTask} onRunCustomTask={handleRunCustomTask} />
          )}
        </div>
      </div>
    </div>
  );
}

function OverviewTab({ persona, agent }: { persona: PersonaData | null; agent: AgentStatus }) {
  if (!persona) {
    return (
      <div style={{ textAlign: 'center', padding: 40, color: 'var(--tn-text-muted)', fontSize: 12 }}>
        Persona data not found
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Profile Header */}
      <div style={{
        padding: 16,
        background: 'var(--tn-bg)',
        borderRadius: 8,
        border: '1px solid var(--tn-border)'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
          <div style={{ fontSize: 11, color: 'var(--tn-text-muted)' }}>
            <span style={{ fontWeight: 600 }}>MBTI:</span> {persona.mbti}
          </div>
          {persona.reportsTo && (
            <div style={{ fontSize: 11, color: 'var(--tn-text-muted)' }}>
              <span style={{ fontWeight: 600 }}>Reports to:</span> {persona.reportsTo}
            </div>
          )}
        </div>
        {persona.team && (
          <div style={{ fontSize: 11, color: 'var(--tn-text-muted)' }}>
            <span style={{ fontWeight: 600 }}>Team:</span> {persona.team}
            {persona.department && ` (${persona.department})`}
          </div>
        )}
        {persona.motto && (
          <div style={{
            marginTop: 12,
            fontSize: 12,
            fontStyle: 'italic',
            color: 'var(--tn-text)',
            paddingLeft: 12,
            borderLeft: '2px solid var(--tn-blue)'
          }}>
            "{persona.motto}"
          </div>
        )}
      </div>

      {/* Responsibilities */}
      {persona.responsibilities.length > 0 && (
        <Section title="📋 Responsibilities">
          <ul style={{ margin: 0, paddingLeft: 20, fontSize: 12, lineHeight: 1.8, color: 'var(--tn-text)' }}>
            {persona.responsibilities.map((resp, i) => (
              <li key={i}>{resp}</li>
            ))}
          </ul>
        </Section>
      )}

      {/* Collaboration */}
      {persona.collaboration.length > 0 && (
        <Section title="🔄 Collaboration">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {persona.collaboration.map((collab, i) => (
              <div key={i} style={{
                padding: '8px 12px',
                background: 'var(--tn-bg)',
                borderRadius: 6,
                border: '1px solid var(--tn-border)'
              }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--tn-text)', marginBottom: 2 }}>
                  {collab.person}
                </div>
                <div style={{ fontSize: 11, color: 'var(--tn-text-muted)' }}>
                  {collab.reason}
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* Schedule */}
      <Section title="⏰ Schedule">
        <div style={{ fontSize: 12, color: 'var(--tn-text)' }}>
          {agent.schedule || 'On-demand'}
        </div>
        {agent.next_run && (
          <div style={{ fontSize: 11, color: 'var(--tn-text-muted)', marginTop: 4 }}>
            Next run: {agent.next_run}
          </div>
        )}
      </Section>
    </div>
  );
}

function HistoryTab({ memory }: { memory: MemoryEntry[] }) {
  if (memory.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: 40, color: 'var(--tn-text-muted)', fontSize: 12 }}>
        No history yet
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {memory.map((entry, index) => (
        <div key={index} style={{
          padding: 12,
          background: 'var(--tn-bg)',
          borderRadius: 8,
          border: '1px solid var(--tn-border)'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--tn-text)' }}>
              {entry.trigger}
            </div>
            <div style={{ fontSize: 10, color: 'var(--tn-text-muted)' }}>
              {new Date(entry.timestamp).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}
            </div>
          </div>
          <div style={{ fontSize: 11, color: 'var(--tn-text-muted)', marginBottom: 6 }}>
            {entry.actions} actions: {entry.action_types.join(', ')}
          </div>
          {entry.response_preview && (
            <div style={{
              fontSize: 10,
              color: 'var(--tn-text-muted)',
              fontFamily: 'monospace',
              whiteSpace: 'pre-wrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              display: '-webkit-box',
              WebkitLineClamp: 3,
              WebkitBoxOrient: 'vertical'
            }}>
              {entry.response_preview}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function CurrentTab({ agent, customTask, setCustomTask, onRunCustomTask }: {
  agent: AgentStatus;
  customTask: string;
  setCustomTask: (task: string) => void;
  onRunCustomTask: () => void;
}) {
  const isWorking = agent.status === 'working';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Status */}
      <Section title="⚡ Current Status">
        <div style={{
          padding: 12,
          background: 'var(--tn-bg)',
          borderRadius: 8,
          border: '1px solid var(--tn-border)',
          display: 'flex',
          alignItems: 'center',
          gap: 12
        }}>
          <div style={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            background: isWorking ? 'var(--tn-yellow)' : 'var(--tn-green)',
            animation: isWorking ? 'pulse 1.5s ease-in-out infinite' : 'none'
          }} />
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--tn-text)' }}>
              {isWorking ? '⚡ Working' : '● Idle'}
            </div>
            {agent.last_run && (
              <div style={{ fontSize: 11, color: 'var(--tn-text-muted)', marginTop: 2 }}>
                Last run: {new Date(agent.last_run).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}
              </div>
            )}
          </div>
        </div>
      </Section>

      {/* Custom Task */}
      <Section title="✎ Custom Task">
        <textarea
          value={customTask}
          onChange={(e) => setCustomTask(e.target.value)}
          placeholder="Enter a custom task for this agent..."
          disabled={isWorking}
          style={{
            width: '100%',
            minHeight: 100,
            padding: 10,
            background: 'var(--tn-bg)',
            border: '1px solid var(--tn-border)',
            borderRadius: 6,
            color: 'var(--tn-text)',
            fontSize: 12,
            fontFamily: 'inherit',
            resize: 'vertical',
            opacity: isWorking ? 0.5 : 1,
            cursor: isWorking ? 'not-allowed' : 'text'
          }}
        />
        <button
          onClick={onRunCustomTask}
          disabled={isWorking || !customTask.trim()}
          style={{
            marginTop: 8,
            padding: '8px 16px',
            background: isWorking || !customTask.trim() ? 'var(--tn-surface-alt)' : 'var(--tn-blue)',
            color: isWorking || !customTask.trim() ? 'var(--tn-text-muted)' : 'white',
            border: 'none',
            borderRadius: 6,
            fontSize: 12,
            fontWeight: 600,
            cursor: isWorking || !customTask.trim() ? 'not-allowed' : 'pointer',
            width: '100%'
          }}
        >
          {isWorking ? 'Agent is running...' : '▶ Run Task'}
        </button>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{
        fontSize: 12,
        fontWeight: 600,
        color: 'var(--tn-text)',
        marginBottom: 10
      }}>
        {title}
      </div>
      {children}
    </div>
  );
}
