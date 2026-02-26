import { useState, useEffect, useCallback } from 'react';
import ActivityStream from './ActivityStream';
import AgentGrid from './AgentGrid';
import ActionItems from './ActionItems';
import TeamOrgChart from './TeamOrgChart';
import ResponsibilityMatrix from './ResponsibilityMatrix';
import QuickStartBanner from '../onboarding/QuickStartBanner';
import KnowledgeGraphView from './KnowledgeGraphView';
import PersonaChat from './PersonaChat';
import ScanDocumentsButton from './ScanDocumentsButton';
import PersonaDocumentList from './PersonaDocumentList';
import AgentDetailModal from '../modals/AgentDetailModal';

const API = '/api';

export interface AgentStatus {
  id: string;
  persona_id: string;
  persona_name: string;
  schedule: string;
  status: 'idle' | 'working' | 'error';
  last_run: string | null;
  last_actions: number;
  last_action_types: string[];
  last_trigger: string | null;
  next_run: string;
  has_pending_approvals: boolean;
  approvals_count: number;
  inbox_count: number;
}

export interface ActivityEvent {
  timestamp: string;
  personaId: string;
  personaName: string;
  action: string; // "started", "completed", "error", "wrote", "messaged"
  description: string;
  progress?: number; // 0-100
}

export interface ActionItem {
  id: string;
  type: 'approval' | 'review' | 'decision' | 'suggestion';
  priority: 'urgent' | 'normal' | 'low';
  title: string;
  description: string;
  personaId?: string;
  personaName?: string;
  age?: number; // days old
  blocking?: boolean; // blocks other work
  quickAction?: string; // URL for one-click action
}

interface VirtualOfficeProps {
  projectId?: string;
  workDir?: string;
}

export default function VirtualOffice({ projectId, workDir }: VirtualOfficeProps) {
  const [agents, setAgents] = useState<AgentStatus[]>([]);
  const [activities, setActivities] = useState<ActivityEvent[]>([]);
  const [actionItems, setActionItems] = useState<ActionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [centerView, setCenterView] = useState<'tables' | 'grid' | 'org' | 'raci'>('tables'); // Default to 4 Tables view
  const [rightView, setRightView] = useState<'actions' | 'knowledge' | 'chat'>('actions'); // Right panel tabs
  const [detailModalAgent, setDetailModalAgent] = useState<AgentStatus | null>(null);
  const [detailModalTab, setDetailModalTab] = useState<'overview' | 'inbox' | 'approvals' | 'history' | 'current'>('overview');

  // Fetch agent status
  const loadAgents = useCallback(async () => {
    try {
      const res = await fetch(`${API}/agents/claude/status`);
      if (!res.ok) throw new Error('Failed to load agents');
      const data = await res.json();
      setAgents(data.agents || []);
    } catch (err) {
      console.error('Failed to load agents:', err);
    }
  }, []);

  // Fetch activity events from events.json
  const loadActivities = useCallback(async () => {
    try {
      const res = await fetch(`${API}/team/events`);
      if (!res.ok) throw new Error('Failed to load events');
      const data = await res.json();

      // events.json has { events: [...] }
      const events = data.events || [];

      // Sort by timestamp (newest first) and take last 20
      const sorted = events
        .sort((a: ActivityEvent, b: ActivityEvent) =>
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
        )
        .slice(0, 20);

      setActivities(sorted);
    } catch (err) {
      console.error('Failed to load activities:', err);
      // Keep existing activities or set empty
    }
  }, []);

  // Fetch action items (approvals, pending reviews, etc.)
  const loadActionItems = useCallback(async () => {
    try {
      const [pendingRes, recommendationsRes] = await Promise.all([
        fetch(`${API}/agents/business/pending`),
        fetch(`${API}/agents/recommendations`).catch(() => ({ ok: false }))
      ]);

      const items: ActionItem[] = [];

      // Business approvals
      if (pendingRes.ok) {
        const { pending } = await pendingRes.json();
        pending.forEach((entry: any, index: number) => {
          const ageMs = Date.now() - new Date(entry.timestamp).getTime();
          const ageDays = Math.floor(ageMs / 86400000);
          items.push({
            id: `approval-${index}`,
            type: 'approval',
            priority: ageDays > 3 ? 'urgent' : 'normal',
            title: `Approve: ${entry.file.split('/').pop().replace('.pending', '')}`,
            description: entry.summary || 'Business document awaiting approval',
            personaId: entry.persona,
            personaName: entry.persona,
            age: ageDays,
            blocking: ageDays > 3,
            quickAction: `/business?file=${encodeURIComponent(entry.file)}`
          });
        });
      }

      // Recommendations (if endpoint exists)
      if (recommendationsRes.ok) {
        const recs = await recommendationsRes.json();

        (recs.urgent || []).forEach((item: any, index: number) => {
          items.push({
            id: `urgent-${index}`,
            type: 'decision',
            priority: 'urgent',
            title: item.title || 'Urgent action needed',
            description: item.description || '',
            age: item.ageDays,
            blocking: true
          });
        });

        (recs.recommended || []).forEach((item: any, index: number) => {
          items.push({
            id: `rec-${index}`,
            type: 'suggestion',
            priority: 'normal',
            title: item.title || 'Recommended action',
            description: item.description || '',
            personaId: item.personaId,
            personaName: item.personaName
          });
        });
      }

      setActionItems(items);
    } catch (err) {
      console.error('Failed to load action items:', err);
    }
  }, []);

  // Initial load
  useEffect(() => {
    Promise.all([loadAgents(), loadActionItems(), loadActivities()]).finally(() => setLoading(false));
  }, [loadAgents, loadActionItems, loadActivities]);

  // Poll for updates every 10 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      loadAgents();
      loadActionItems();
      loadActivities();
    }, 10000);
    return () => clearInterval(interval);
  }, [loadAgents, loadActionItems, loadActivities]);

  // Listen to SSE for activity stream (non-critical - falls back to polling)
  useEffect(() => {
    const eventSource = new EventSource(`${API}/agents/activity-stream`);
    let connectionFailed = false;

    eventSource.onmessage = (e) => {
      try {
        const event: ActivityEvent = JSON.parse(e.data);
        setActivities(prev => [event, ...prev].slice(0, 20)); // Keep last 20
      } catch (err) {
        console.error('Failed to parse activity event:', err);
      }
    };

    eventSource.onerror = () => {
      if (!connectionFailed) {
        console.warn('Activity stream SSE not available - using polling fallback');
        connectionFailed = true;
      }
      eventSource.close();
    };

    return () => eventSource.close();
  }, []);

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
        Loading Virtual Office...
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
            🏢 Virtual Office
          </span>
          <span style={{ fontSize: 11, color: 'var(--tn-text-muted)' }}>
            {agents.length} Agents
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8, fontSize: 11 }}>
          <div style={{
            padding: '4px 8px',
            borderRadius: 4,
            background: 'var(--tn-surface-alt)',
            color: 'var(--tn-text-muted)'
          }}>
            {agents.filter(a => a.status === 'working').length} Working
          </div>
          <div style={{
            padding: '4px 8px',
            borderRadius: 4,
            background: 'var(--tn-surface-alt)',
            color: 'var(--tn-text-muted)'
          }}>
            {agents.filter(a => a.status === 'idle').length} Idle
          </div>
          {agents.filter(a => a.status === 'error').length > 0 && (
            <div style={{
              padding: '4px 8px',
              borderRadius: 4,
              background: 'rgba(255, 59, 48, 0.1)',
              color: 'var(--tn-red)'
            }}>
              {agents.filter(a => a.status === 'error').length} Errors
            </div>
          )}
        </div>
      </div>

      {/* Quick Start Banner */}
      <QuickStartBanner />

      {/* 3-Panel Layout */}
      <div style={{
        display: 'flex',
        flex: 1,
        minHeight: 0,
        overflow: 'hidden'
      }}>
        {/* Left Panel - Activity Stream */}
        <div style={{
          width: 280,
          borderRight: '1px solid var(--tn-border)',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--tn-surface)'
        }}>
          <ActivityStream activities={activities} />
        </div>

        {/* Center Panel - Agent Grid / Org Chart / RACI */}
        <div style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          background: 'var(--tn-bg)'
        }}>
          {/* View Tabs */}
          <div style={{
            padding: '12px 16px',
            borderBottom: '1px solid var(--tn-border)',
            display: 'flex',
            gap: 8,
            background: 'var(--tn-surface)'
          }}>
            {[
              { id: 'tables', label: '📊 4 Tables' },
              { id: 'grid', label: '🎯 Agent Grid' },
              { id: 'org', label: '🏢 Org Chart' },
              { id: 'raci', label: '📋 RACI Matrix' }
            ].map(({ id, label }) => (
              <button
                key={id}
                onClick={() => setCenterView(id as any)}
                style={{
                  padding: '6px 12px',
                  background: centerView === id ? 'var(--tn-blue)' : 'transparent',
                  color: centerView === id ? 'white' : 'var(--tn-text-muted)',
                  border: 'none',
                  borderRadius: 6,
                  fontSize: 12,
                  fontWeight: centerView === id ? 600 : 400,
                  cursor: 'pointer',
                  transition: 'all 0.2s ease'
                }}
              >
                {label}
              </button>
            ))}
          </div>

          {/* View Content */}
          <div style={{ flex: 1, overflow: 'auto' }}>
            {centerView === 'tables' && (
              <FourTablesView
                agents={agents}
                selectedAgent={selectedAgent}
                onSelectAgent={setSelectedAgent}
                onOpenDetails={(agent, tab) => {
                  setDetailModalAgent(agent);
                  setDetailModalTab(tab);
                }}
              />
            )}
            {centerView === 'grid' && (
              <AgentGrid
                agents={agents}
                selectedAgent={selectedAgent}
                onSelectAgent={setSelectedAgent}
                onAgentUpdate={loadAgents}
                onOpenChat={(personaId) => {
                  setSelectedAgent(personaId);
                  setRightView('chat');
                }}
              />
            )}
            {centerView === 'org' && (
              <TeamOrgChart
                onNodeClick={(nodeId) => setSelectedAgent(nodeId)}
                selectedNode={selectedAgent}
              />
            )}
            {centerView === 'raci' && (
              <ResponsibilityMatrix />
            )}
          </div>
        </div>

        {/* Right Panel - Actions / Knowledge / Chat */}
        <div style={{
          width: 320,
          borderLeft: '1px solid var(--tn-border)',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--tn-surface)'
        }}>
          {/* Right Panel Tabs */}
          <div style={{
            padding: '12px 16px',
            borderBottom: '1px solid var(--tn-border)',
            display: 'flex',
            gap: 6,
            background: 'var(--tn-bg)'
          }}>
            {[
              { id: 'actions', label: '🎯 Actions', badge: actionItems.length },
              { id: 'knowledge', label: '📚 Knowledge', badge: 0 },
              { id: 'chat', label: '💬 Chat', badge: 0 }
            ].map(({ id, label, badge }) => (
              <button
                key={id}
                onClick={() => setRightView(id as any)}
                style={{
                  flex: 1,
                  padding: '6px 8px',
                  background: rightView === id ? 'var(--tn-blue)' : 'transparent',
                  color: rightView === id ? 'white' : 'var(--tn-text-muted)',
                  border: 'none',
                  borderRadius: 6,
                  fontSize: 11,
                  fontWeight: rightView === id ? 600 : 400,
                  cursor: 'pointer',
                  transition: 'all 0.2s ease',
                  whiteSpace: 'nowrap'
                }}
              >
                {label}
                {badge > 0 && ` (${badge})`}
              </button>
            ))}
          </div>

          {/* Right Panel Content */}
          <div style={{ flex: 1, overflow: 'auto' }}>
            {rightView === 'actions' && (
              <ActionItems
                items={actionItems}
                onItemClick={(item) => {
                  if (item.quickAction) {
                    window.location.hash = item.quickAction;
                  }
                }}
                onRefresh={loadActionItems}
              />
            )}

            {rightView === 'knowledge' && (
              <div style={{
                display: 'flex',
                flexDirection: 'column',
                height: '100%',
                overflow: 'auto'
              }}>
                <div style={{ padding: 12 }}>
                  <ScanDocumentsButton />
                </div>
                <KnowledgeGraphView
                  personas={agents.map(a => ({
                    id: a.persona_id,
                    name: a.persona_name,
                    role: a.schedule,
                    status: a.status,
                    mbti: '',
                    worklistPath: '',
                    lastUpdated: a.last_run || ''
                  }))}
                  onPersonaClick={(personaId) => {
                    setSelectedAgent(personaId);
                  }}
                  selected={selectedAgent ? {
                    id: selectedAgent,
                    name: agents.find(a => a.persona_id === selectedAgent)?.persona_name || '',
                    role: agents.find(a => a.persona_id === selectedAgent)?.schedule || '',
                    status: agents.find(a => a.persona_id === selectedAgent)?.status || 'idle',
                    mbti: '',
                    worklistPath: '',
                    lastUpdated: agents.find(a => a.persona_id === selectedAgent)?.last_run || ''
                  } : null}
                />
                {selectedAgent && (
                  <PersonaDocumentList
                    personaId={selectedAgent}
                    personaName={agents.find(a => a.persona_id === selectedAgent)?.persona_name || ''}
                  />
                )}
              </div>
            )}

            {rightView === 'chat' && (
              <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
                {selectedAgent ? (
                  <PersonaChat
                    personaId={selectedAgent}
                    personaName={agents.find(a => a.persona_id === selectedAgent)?.persona_name || ''}
                  />
                ) : (
                  <div style={{
                    flex: 1,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexDirection: 'column',
                    gap: 16,
                    padding: 20
                  }}>
                    <div style={{
                      fontSize: 13,
                      color: 'var(--tn-text-muted)',
                      textAlign: 'center'
                    }}>
                      💬 Select an agent to start chatting
                    </div>
                    <div style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: 8,
                      justifyContent: 'center'
                    }}>
                      {agents.slice(0, 6).map(agent => (
                        <button
                          key={agent.persona_id}
                          onClick={() => {
                            setSelectedAgent(agent.persona_id);
                          }}
                          style={{
                            padding: '6px 12px',
                            background: 'var(--tn-bg)',
                            border: '1px solid var(--tn-border)',
                            borderRadius: 6,
                            cursor: 'pointer',
                            fontSize: 11,
                            color: 'var(--tn-text)',
                            transition: 'all 0.2s ease'
                          }}
                        >
                          {agent.persona_name.split(' ')[0]}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Agent Detail Modal */}
      {detailModalAgent && (
        <AgentDetailModal
          agent={detailModalAgent}
          initialTab={detailModalTab}
          onClose={() => {
            setDetailModalAgent(null);
            setDetailModalTab('overview');
          }}
          onRunAgent={(personaId) => {
            // Refresh agents after running
            setTimeout(loadAgents, 2000);
          }}
          onOpenChat={(personaId) => {
            setSelectedAgent(personaId);
            setRightView('chat');
            setDetailModalAgent(null);
          }}
        />
      )}
    </div>
  );
}

// 4 Tables View Component - Product, Revenue, Delivery, Operations
function FourTablesView({ agents, selectedAgent, onSelectAgent, onOpenDetails }: {
  agents: AgentStatus[];
  selectedAgent: string | null;
  onSelectAgent: (id: string) => void;
  onOpenDetails?: (agent: AgentStatus, tab: 'inbox' | 'approvals') => void;
}) {
  // Define the 4 tables structure with agent assignments
  const tables = [
    {
      id: 'product',
      title: '📊 Product Table',
      description: 'Customer-facing: Marketing, Sales, Customer Success, UX',
      agentIds: ['mira-marketing', 'vera-vertrieb', 'chris-customer', 'anna-ux']
    },
    {
      id: 'revenue',
      title: '💰 Revenue Table',
      description: 'Money & Growth: Sales, Finance, Revenue Operations',
      agentIds: ['vera-vertrieb', 'finn-finanzen', 'birgit-bauer', 'david-sales', 'emma-sales', 'michael-sales']
    },
    {
      id: 'delivery',
      title: '🚀 Delivery Table',
      description: 'Engineering & Product: Development, DevOps, QA, Docs',
      agentIds: ['max-weber', 'sarah-koch', 'klaus-schmidt', 'herbert-sicher', 'lisa-mueller', 'tim-berger', 'peter-doku']
    },
    {
      id: 'operations',
      title: '⚙️ Operations Table',
      description: 'Internal Ops: Operations, IT, Infrastructure',
      agentIds: ['otto-operations', 'felix-cio', 'kai-ops', 'finn-finanzen']
    }
  ];

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(2, 1fr)',
      gap: 16,
      padding: 16,
      height: '100%',
      overflow: 'auto'
    }}>
      {tables.map(table => {
        const tableAgents = agents.filter(a => table.agentIds.includes(a.persona_id));

        return (
          <div
            key={table.id}
            style={{
              background: 'var(--tn-surface)',
              border: '1px solid var(--tn-border)',
              borderRadius: 12,
              padding: 16,
              display: 'flex',
              flexDirection: 'column',
              gap: 12
            }}
          >
            {/* Table Header */}
            <div>
              <div style={{
                fontSize: 15,
                fontWeight: 600,
                color: 'var(--tn-text)',
                marginBottom: 4
              }}>
                {table.title}
              </div>
              <div style={{
                fontSize: 11,
                color: 'var(--tn-text-muted)',
                marginBottom: 8
              }}>
                {table.description}
              </div>
              <div style={{
                fontSize: 10,
                color: 'var(--tn-text-muted)',
                opacity: 0.7
              }}>
                {tableAgents.length} Members
              </div>
            </div>

            {/* Table Members */}
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 8
            }}>
              {tableAgents.length === 0 ? (
                <div style={{
                  textAlign: 'center',
                  padding: 20,
                  color: 'var(--tn-text-muted)',
                  fontSize: 11
                }}>
                  No agents assigned
                </div>
              ) : (
                tableAgents.map(agent => {
                  const isSelected = selectedAgent === agent.persona_id;
                  const hasInbox = agent.inbox_count > 0;
                  const hasApprovals = agent.approvals_count > 0;

                  return (
                    <div
                      key={agent.persona_id}
                      onClick={() => onSelectAgent(agent.persona_id)}
                      style={{
                        padding: 10,
                        background: isSelected ? 'var(--tn-blue-dim)' : 'var(--tn-bg)',
                        border: `1px solid ${isSelected ? 'var(--tn-blue)' : 'var(--tn-border)'}`,
                        borderRadius: 6,
                        cursor: 'pointer',
                        transition: 'all 0.2s ease',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10
                      }}
                    >
                      {/* Status Dot */}
                      <div style={{
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        background: agent.status === 'working' ? 'var(--tn-yellow)' : 'var(--tn-green)',
                        flexShrink: 0
                      }} />

                      {/* Name & Role */}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{
                          fontSize: 12,
                          fontWeight: 600,
                          color: 'var(--tn-text)',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis'
                        }}>
                          {agent.persona_name}
                        </div>
                        <div style={{
                          fontSize: 10,
                          color: 'var(--tn-text-muted)',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis'
                        }}>
                          {agent.schedule}
                        </div>
                      </div>

                      {/* Badges */}
                      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                        {hasInbox && (
                          <div
                            onClick={(e) => {
                              e.stopPropagation();
                              onOpenDetails?.(agent, 'inbox');
                            }}
                            onMouseEnter={(e) => e.currentTarget.style.transform = 'scale(1.05)'}
                            onMouseLeave={(e) => e.currentTarget.style.transform = 'scale(1)'}
                            style={{
                              fontSize: 10,
                              fontWeight: 600,
                              color: 'white',
                              background: 'var(--tn-blue)',
                              padding: '2px 6px',
                              borderRadius: 10,
                              cursor: 'pointer',
                              transition: 'transform 0.2s ease'
                            }}>
                            📬 {agent.inbox_count}
                          </div>
                        )}
                        {hasApprovals && (
                          <div
                            onClick={(e) => {
                              e.stopPropagation();
                              onOpenDetails?.(agent, 'approvals');
                            }}
                            onMouseEnter={(e) => e.currentTarget.style.transform = 'scale(1.05)'}
                            onMouseLeave={(e) => e.currentTarget.style.transform = 'scale(1)'}
                            style={{
                              fontSize: 10,
                              fontWeight: 600,
                              color: 'white',
                              background: 'var(--tn-orange)',
                              padding: '2px 6px',
                              borderRadius: 10,
                              cursor: 'pointer',
                              transition: 'transform 0.2s ease'
                            }}>
                            ✅ {agent.approvals_count}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
