import { useState, useEffect, useCallback } from 'react';
import ActivityStream from './ActivityStream';
import AgentGrid from './AgentGrid';
import ActionItems from './ActionItems';
import TeamOrgChart from './TeamOrgChart';
import ResponsibilityMatrix from './ResponsibilityMatrix';
import QuickStartBanner from '../onboarding/QuickStartBanner';

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
  const [centerView, setCenterView] = useState<'grid' | 'org' | 'raci'>('grid');

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
              { id: 'grid', label: '🎯 Agent Grid' },
              { id: 'org', label: '🏢 Org Chart' },
              { id: 'raci', label: '📊 RACI Matrix' }
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
            {centerView === 'grid' && (
              <AgentGrid
                agents={agents}
                selectedAgent={selectedAgent}
                onSelectAgent={setSelectedAgent}
                onAgentUpdate={loadAgents}
              />
            )}
            {centerView === 'org' && (
              <TeamOrgChart onNodeClick={(nodeId) => setSelectedAgent(nodeId)} />
            )}
            {centerView === 'raci' && (
              <ResponsibilityMatrix />
            )}
          </div>
        </div>

        {/* Right Panel - Action Items */}
        <div style={{
          width: 320,
          borderLeft: '1px solid var(--tn-border)',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--tn-surface)'
        }}>
          <ActionItems
            items={actionItems}
            onItemClick={(item) => {
              if (item.quickAction) {
                // Navigate to quick action
                window.location.hash = item.quickAction;
              }
            }}
            onRefresh={loadActionItems}
          />
        </div>
      </div>
    </div>
  );
}
