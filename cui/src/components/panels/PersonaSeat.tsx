import { useState } from 'react';

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

interface AgentInfo {
  status: 'idle' | 'working' | 'error';
  schedule: string;
  last_run: string | null;
  last_actions: number;
  inbox_count: number;
  approvals_count: number;
}

interface PersonaSeatProps {
  persona: PersonaCard;
  onClick: () => void;
  isSelected: boolean;
  agentInfo?: AgentInfo;
}

function fmtTimeAgo(iso: string | null): string {
  if (!iso) return '—';
  const diffH = (Date.now() - new Date(iso).getTime()) / 3600000;
  if (diffH < 1) return `vor ${Math.round(diffH * 60)}min`;
  if (diffH < 24) return `vor ${Math.round(diffH)}h`;
  return new Date(iso).toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit' });
}

export default function PersonaSeat({ persona, onClick, isSelected, agentInfo }: PersonaSeatProps) {
  const [showTooltip, setShowTooltip] = useState(false);

  const initials = persona.name
    .split(' ')
    .map(n => n[0])
    .join('')
    .toUpperCase();

  const statusLabel: Record<string, string> = {
    idle: 'Verfügbar',
    working: 'Aktiv',
    blocked: 'Blockiert',
    review: 'Review',
  };

  const handleInfoClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setShowTooltip(v => !v);
  };

  const handleInfoBlur = () => {
    setTimeout(() => setShowTooltip(false), 150);
  };

  return (
    <div
      className={`persona-seat ${isSelected ? 'selected' : ''}`}
      onClick={onClick}
    >
      {/* Info Button */}
      <button
        className="persona-seat-info-btn"
        onClick={handleInfoClick}
        onBlur={handleInfoBlur}
        title="Details"
        tabIndex={0}
      >
        ℹ
      </button>

      {/* Tooltip */}
      {showTooltip && (
        <div className="persona-seat-tooltip" onClick={e => e.stopPropagation()}>
          <div className="tooltip-name">{persona.name}</div>
          <div className="tooltip-row">
            <span className="tooltip-label">Rolle</span>
            <span>{persona.role}</span>
          </div>
          <div className="tooltip-row">
            <span className="tooltip-label">MBTI</span>
            <span className="tooltip-mbti">{persona.mbti}</span>
          </div>
          {persona.specialty && (
            <div className="tooltip-row">
              <span className="tooltip-label">Spezialgebiet</span>
              <span>{persona.specialty}</span>
            </div>
          )}
          {persona.motto && (
            <div className="tooltip-motto">„{persona.motto}"</div>
          )}
          <div className="tooltip-row">
            <span className="tooltip-label">Status</span>
            <span className={`tooltip-status status-${persona.status}`}>
              ⬤ {statusLabel[persona.status]}
            </span>
          </div>
          {persona.reportsTo && (
            <div className="tooltip-row">
              <span className="tooltip-label">Reports to</span>
              <span>{persona.reportsTo}</span>
            </div>
          )}
          {persona.governance && (
            <div className="tooltip-row">
              <span className="tooltip-label">Governance</span>
              <span>{persona.governance === 'auto-commit' ? '🤖 Auto' : '👁️ Review'}</span>
            </div>
          )}
          {agentInfo && (
            <div className="tooltip-agent-section">
              <div className="tooltip-agent-header">🤖 Agent</div>
              <div className="tooltip-row">
                <span className="tooltip-label">Schedule</span>
                <span>{agentInfo.schedule}</span>
              </div>
              <div className="tooltip-row">
                <span className="tooltip-label">Letzter Lauf</span>
                <span>
                  {fmtTimeAgo(agentInfo.last_run)}
                  {agentInfo.last_actions > 0 && ` (${agentInfo.last_actions} Aktionen)`}
                </span>
              </div>
              {agentInfo.inbox_count > 0 && (
                <div className="tooltip-row">
                  <span className="tooltip-label">Inbox</span>
                  <span style={{ color: '#3b82f6' }}>📬 {agentInfo.inbox_count} Nachricht{agentInfo.inbox_count !== 1 ? 'en' : ''}</span>
                </div>
              )}
              {agentInfo.approvals_count > 0 && (
                <div className="tooltip-row">
                  <span className="tooltip-label">Approvals</span>
                  <span style={{ color: '#f59e0b' }}>⚠️ {agentInfo.approvals_count} ausstehend</span>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Avatar with Status Dot + Agent Ring */}
      <div className={`persona-seat-avatar${
        agentInfo
          ? agentInfo.status === 'working'
            ? ' has-agent-working'
            : agentInfo.status === 'error'
              ? ' has-agent-error'
              : ' has-agent'
          : ''
      }`}>
        {initials}
        <div className={`persona-seat-status status-${persona.status}`} />
        {agentInfo && <div className="persona-seat-robot-badge">🤖</div>}
      </div>

      {/* Name + Role */}
      <div className="persona-seat-name">{persona.name}</div>
      <div className="persona-seat-role">{persona.role}</div>

      {/* Specialty — truncated, voller Text im Tooltip */}
      {persona.specialty && (
        <div className="persona-seat-specialty">{persona.specialty.split(',')[0].trim()}</div>
      )}
    </div>
  );
}
