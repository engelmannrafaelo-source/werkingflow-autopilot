import { useState } from 'react';
import type { AgentStatus } from './VirtualOffice';
import AgentDetailModal from '../modals/AgentDetailModal';

const API = '/api';

interface AgentGridProps {
  agents: AgentStatus[];
  selectedAgent: string | null;
  onSelectAgent: (agentId: string | null) => void;
  onAgentUpdate: () => void;
}

function getStatusColor(status: string): string {
  switch (status) {
    case 'working': return 'var(--tn-yellow)';
    case 'idle': return 'var(--tn-green)';
    case 'error': return 'var(--tn-red)';
    default: return 'var(--tn-text-muted)';
  }
}

function getStatusLabel(status: string): string {
  switch (status) {
    case 'working': return '⚡ Working';
    case 'idle': return '● Idle';
    case 'error': return '⭘ Error';
    default: return '○ Unknown';
  }
}

function formatTimeAgo(iso: string | null): string {
  if (!iso) return 'Never';
  const diffH = (Date.now() - new Date(iso).getTime()) / 3600000;
  if (diffH < 1) return `${Math.round(diffH * 60)}m ago`;
  if (diffH < 24) return `${Math.round(diffH)}h ago`;
  return `${Math.round(diffH / 24)}d ago`;
}

function getTaskTypeEmoji(personaName: string): string {
  // Map persona names to their task types
  const taskTypeMap: Record<string, string> = {
    'rafbot': '🎯',
    'kai-hoffmann': '🔍',
    'birgit-bauer': '🔄',
    'max-weber': '⚡',
    'vera-vertrieb': '🔍',
    'herbert-sicher': '🔍',
    'otto-operations': '🔄',
    'mira-marketing': '✍️',
    'felix-krause': '🔎',
    'anna-frontend': '✍️',
    'tim-berger': '✍️',
    'peter-doku': '✍️',
    'chris-customer': '🔍',
    'finn-finanzen': '🔎',
    'lisa-mueller': '🔎',
    'sarah-koch': '🔎',
    'klaus-schmidt': '🔎'
  };
  return taskTypeMap[personaName] || '🤖';
}

export default function AgentGrid({ agents, selectedAgent, onSelectAgent, onAgentUpdate }: AgentGridProps) {
  const [runningAgent, setRunningAgent] = useState<string | null>(null);
  const [detailModalAgent, setDetailModalAgent] = useState<AgentStatus | null>(null);

  async function runAgent(personaId: string) {
    try {
      setRunningAgent(personaId);
      const res = await fetch(`${API}/agents/claude/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ persona_id: personaId, mode: 'plan' })
      });

      if (!res.ok) throw new Error('Failed to run agent');

      // Refresh agent status after starting
      setTimeout(() => {
        onAgentUpdate();
        setRunningAgent(null);
      }, 2000);
    } catch (err) {
      console.error('Failed to run agent:', err);
      setRunningAgent(null);
    }
  }

  return (
    <>
      <div style={{
        padding: 16,
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
        gap: 12,
        alignContent: 'start'
      }}>
        {agents.map((agent) => {
          const isSelected = selectedAgent === agent.persona_id;
          const isRunning = runningAgent === agent.persona_id || agent.status === 'working';

          return (
            <div
              key={agent.persona_id}
              onClick={() => setDetailModalAgent(agent)}
            style={{
              background: isSelected ? 'var(--tn-surface-hover)' : 'var(--tn-surface)',
              border: `1px solid ${isSelected ? 'var(--tn-blue)' : 'var(--tn-border)'}`,
              borderRadius: 8,
              padding: 12,
              cursor: 'pointer',
              transition: 'all 0.2s ease',
              position: 'relative',
              minHeight: 160
            }}
            onMouseEnter={(e) => {
              if (!isSelected) {
                e.currentTarget.style.borderColor = 'var(--tn-border-hover)';
                e.currentTarget.style.background = 'var(--tn-surface-hover)';
              }
            }}
            onMouseLeave={(e) => {
              if (!isSelected) {
                e.currentTarget.style.borderColor = 'var(--tn-border)';
                e.currentTarget.style.background = 'var(--tn-surface)';
              }
            }}
          >
            {/* Status Indicator */}
            <div style={{
              position: 'absolute',
              top: 8,
              right: 8,
              display: 'flex',
              alignItems: 'center',
              gap: 4
            }}>
              <div style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: getStatusColor(agent.status),
                animation: isRunning ? 'pulse 1.5s ease-in-out infinite' : 'none'
              }} />
            </div>

            {/* Agent Icon */}
            <div style={{
              fontSize: 24,
              marginBottom: 8
            }}>
              {getTaskTypeEmoji(agent.persona_id)}
            </div>

            {/* Agent Name */}
            <div style={{
              fontSize: 13,
              fontWeight: 600,
              color: 'var(--tn-text)',
              marginBottom: 2,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}>
              {agent.persona_name}
            </div>

            {/* Role/Schedule */}
            <div style={{
              fontSize: 10,
              color: 'var(--tn-text-muted)',
              marginBottom: 10,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}>
              {agent.schedule || 'On-demand'}
            </div>

            {/* Status Line */}
            <div style={{
              fontSize: 10,
              color: getStatusColor(agent.status),
              marginBottom: 8,
              display: 'flex',
              alignItems: 'center',
              gap: 4
            }}>
              <span>{getStatusLabel(agent.status)}</span>
              {agent.last_actions > 0 && (
                <span style={{ color: 'var(--tn-text-muted)' }}>
                  • {agent.last_actions} actions
                </span>
              )}
            </div>

            {/* Last Run */}
            <div style={{
              fontSize: 10,
              color: 'var(--tn-text-muted)',
              marginBottom: 10
            }}>
              {agent.last_run ? `Last run: ${formatTimeAgo(agent.last_run)}` : 'Never run'}
            </div>

            {/* Action Buttons */}
            <div style={{
              display: 'flex',
              gap: 6,
              marginTop: 'auto'
            }}>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  runAgent(agent.persona_id);
                }}
                disabled={isRunning}
                style={{
                  flex: 1,
                  padding: '6px 10px',
                  background: isRunning ? 'var(--tn-surface-alt)' : 'var(--tn-blue)',
                  color: isRunning ? 'var(--tn-text-muted)' : 'white',
                  border: 'none',
                  borderRadius: 4,
                  fontSize: 10,
                  fontWeight: 600,
                  cursor: isRunning ? 'not-allowed' : 'pointer',
                  transition: 'opacity 0.2s ease'
                }}
                onMouseEnter={(e) => {
                  if (!isRunning) e.currentTarget.style.opacity = '0.9';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.opacity = '1';
                }}
              >
                {isRunning ? 'Running...' : '▶ Run'}
              </button>

              {(agent.inbox_count > 0 || agent.approvals_count > 0) && (
                <div style={{
                  display: 'flex',
                  gap: 4,
                  alignItems: 'center'
                }}>
                  {agent.inbox_count > 0 && (
                    <div style={{
                      padding: '4px 6px',
                      background: 'var(--tn-blue)',
                      color: 'white',
                      borderRadius: 4,
                      fontSize: 9,
                      fontWeight: 600
                    }}>
                      📬 {agent.inbox_count}
                    </div>
                  )}
                  {agent.approvals_count > 0 && (
                    <div style={{
                      padding: '4px 6px',
                      background: 'var(--tn-orange)',
                      color: 'white',
                      borderRadius: 4,
                      fontSize: 9,
                      fontWeight: 600
                    }}>
                      ⚠️ {agent.approvals_count}
                    </div>
                  )}
                </div>
              )}
            </div>
            </div>
          );
        })}

        {/* Pulse Animation */}
        <style>
          {`
            @keyframes pulse {
              0%, 100% { opacity: 1; }
              50% { opacity: 0.5; }
            }
          `}
        </style>
      </div>

      {/* Agent Detail Modal */}
      {detailModalAgent && (
        <AgentDetailModal
          agent={detailModalAgent}
          onClose={() => setDetailModalAgent(null)}
          onRunAgent={(personaId, task) => {
            runAgent(personaId);
            setDetailModalAgent(null);
          }}
        />
      )}
    </>
  );
}
