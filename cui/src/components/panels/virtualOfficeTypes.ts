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
  action: string;
  description: string;
  progress?: number;
}

export interface ActionItem {
  id: string;
  type: 'approval' | 'review' | 'decision' | 'suggestion';
  priority: 'urgent' | 'normal' | 'low';
  title: string;
  description: string;
  personaId?: string;
  personaName?: string;
  age?: number;
  blocking?: boolean;
  quickAction?: string;
}
