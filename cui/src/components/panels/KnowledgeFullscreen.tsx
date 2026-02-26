import { useState, useEffect } from 'react';
import ScanDocumentsButton from './ScanDocumentsButton';
import KnowledgeGraphView from './KnowledgeGraphView';
import PersonaDocumentList from './PersonaDocumentList';

const API = '/api';

interface Persona {
  id: string;
  name: string;
  role: string;
  status: 'idle' | 'working' | 'error';
  mbti: string;
  worklistPath: string;
  lastUpdated: string;
}

interface KnowledgeFullscreenProps {
  projectId?: string;
  workDir?: string;
}

export default function KnowledgeFullscreen({ projectId, workDir }: KnowledgeFullscreenProps) {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [selectedPersona, setSelectedPersona] = useState<Persona | null>(null);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<'graph' | 'list'>('graph');

  useEffect(() => {
    loadPersonas();
  }, []);

  async function loadPersonas() {
    try {
      const res = await fetch(`${API}/agents/claude/status`);
      if (!res.ok) throw new Error('Failed to load personas');
      const data = await res.json();

      const agentPersonas: Persona[] = (data.agents || []).map((agent: any) => ({
        id: agent.persona_id,
        name: agent.persona_name,
        role: agent.schedule,
        status: agent.status,
        mbti: '',
        worklistPath: '',
        lastUpdated: agent.last_run || ''
      }));

      setPersonas(agentPersonas);
    } catch (err) {
      console.error('Failed to load personas:', err);
    } finally {
      setLoading(false);
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
        fontSize: 12
      }}>
        Loading knowledge base...
      </div>
    );
  }

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      background: 'var(--tn-bg)',
      overflow: 'hidden'
    }}>
      {/* Header */}
      <div style={{
        padding: '12px 16px',
        borderBottom: '1px solid var(--tn-border)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        background: 'var(--tn-surface)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--tn-text)' }}>
            📚 Knowledge Base
          </span>
          {selectedPersona && (
            <>
              <span style={{ fontSize: 12, color: 'var(--tn-text-muted)' }}>→</span>
              <span style={{ fontSize: 13, color: 'var(--tn-text)' }}>
                {selectedPersona.name}
              </span>
            </>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {/* View Mode Toggle */}
          <div style={{
            display: 'flex',
            gap: 4,
            padding: 4,
            background: 'var(--tn-bg)',
            borderRadius: 6,
            border: '1px solid var(--tn-border)'
          }}>
            <button
              onClick={() => setViewMode('graph')}
              style={{
                padding: '4px 10px',
                background: viewMode === 'graph' ? 'var(--tn-blue)' : 'transparent',
                color: viewMode === 'graph' ? 'white' : 'var(--tn-text-muted)',
                border: 'none',
                borderRadius: 4,
                fontSize: 11,
                fontWeight: 600,
                cursor: 'pointer',
                transition: 'all 0.2s ease'
              }}
            >
              🕸️ Graph
            </button>
            <button
              onClick={() => setViewMode('list')}
              style={{
                padding: '4px 10px',
                background: viewMode === 'list' ? 'var(--tn-blue)' : 'transparent',
                color: viewMode === 'list' ? 'white' : 'var(--tn-text-muted)',
                border: 'none',
                borderRadius: 4,
                fontSize: 11,
                fontWeight: 600,
                cursor: 'pointer',
                transition: 'all 0.2s ease'
              }}
            >
              📋 List
            </button>
          </div>

          <ScanDocumentsButton />

          {selectedPersona && (
            <button
              onClick={() => setSelectedPersona(null)}
              style={{
                padding: '4px 12px',
                background: 'var(--tn-surface-alt)',
                color: 'var(--tn-text)',
                border: '1px solid var(--tn-border)',
                borderRadius: 6,
                fontSize: 11,
                fontWeight: 600,
                cursor: 'pointer',
                transition: 'all 0.2s ease'
              }}
            >
              ← Back to All
            </button>
          )}
        </div>
      </div>

      {/* Content Area */}
      <div style={{
        display: 'flex',
        flex: 1,
        minHeight: 0,
        overflow: 'hidden'
      }}>
        {/* Left Panel - Persona Selector */}
        <div style={{
          width: 280,
          borderRight: '1px solid var(--tn-border)',
          background: 'var(--tn-surface)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden'
        }}>
          <div style={{
            padding: 12,
            borderBottom: '1px solid var(--tn-border)',
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--tn-text)'
          }}>
            Team Members ({personas.length})
          </div>
          <div style={{ flex: 1, overflow: 'auto', padding: 8 }}>
            {personas.map(persona => {
              const isSelected = selectedPersona?.id === persona.id;
              return (
                <div
                  key={persona.id}
                  onClick={() => setSelectedPersona(persona)}
                  style={{
                    padding: 10,
                    background: isSelected ? 'var(--tn-blue-dim)' : 'var(--tn-bg)',
                    border: `1px solid ${isSelected ? 'var(--tn-blue)' : 'var(--tn-border)'}`,
                    borderRadius: 6,
                    marginBottom: 6,
                    cursor: 'pointer',
                    transition: 'all 0.2s ease'
                  }}
                  onMouseEnter={(e) => {
                    if (!isSelected) {
                      e.currentTarget.style.background = 'var(--tn-surface-hover)';
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!isSelected) {
                      e.currentTarget.style.background = 'var(--tn-bg)';
                    }
                  }}
                >
                  <div style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: 'var(--tn-text)',
                    marginBottom: 2
                  }}>
                    {persona.name}
                  </div>
                  <div style={{
                    fontSize: 10,
                    color: 'var(--tn-text-muted)'
                  }}>
                    {persona.role}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Main Content - Graph or Documents */}
        <div style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden'
        }}>
          {viewMode === 'graph' ? (
            <div style={{ flex: 1, overflow: 'auto', padding: 20 }}>
              <KnowledgeGraphView
                personas={personas}
                onPersonaClick={(personaId) => {
                  const persona = personas.find(p => p.id === personaId);
                  if (persona) setSelectedPersona(persona);
                }}
                selected={selectedPersona}
              />
            </div>
          ) : (
            <div style={{ flex: 1, overflow: 'auto' }}>
              {selectedPersona ? (
                <PersonaDocumentList
                  personaId={selectedPersona.id}
                  personaName={selectedPersona.name}
                />
              ) : (
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  height: '100%',
                  flexDirection: 'column',
                  gap: 16,
                  color: 'var(--tn-text-muted)',
                  fontSize: 13
                }}>
                  <div>📋 Select a team member to view their documents</div>
                  <div style={{ fontSize: 11 }}>
                    {personas.length} personas available
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right Panel - Document Preview (when persona selected) */}
        {selectedPersona && (
          <div style={{
            width: 400,
            borderLeft: '1px solid var(--tn-border)',
            background: 'var(--tn-surface)',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden'
          }}>
            <div style={{
              padding: 12,
              borderBottom: '1px solid var(--tn-border)',
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--tn-text)'
            }}>
              📄 Documents
            </div>
            <div style={{ flex: 1, overflow: 'auto' }}>
              <PersonaDocumentList
                personaId={selectedPersona.id}
                personaName={selectedPersona.name}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
