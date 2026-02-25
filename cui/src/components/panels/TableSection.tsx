import PersonaSeat from './PersonaSeat';

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

interface TableSectionProps {
  title: string;
  icon: string;
  description: string;
  personas: PersonaCard[];
  color: 'gold' | 'blue' | 'green' | 'purple';
  onSelect: (p: PersonaCard) => void;
  selected: PersonaCard | null;
  agentMap?: Record<string, AgentInfo>;
}

export default function TableSection({ title, icon, description, personas, color, onSelect, selected, agentMap }: TableSectionProps) {
  const governanceType = personas[0]?.governance;

  return (
    <div className={`table-section table-${color}`}>
      {/* Header */}
      <div className="table-header">
        <span className="table-icon">{icon}</span>
        <div style={{ flex: 1 }}>
          <h3 style={{ margin: 0 }}>{title}</h3>
          <div style={{ fontSize: 11, color: 'var(--tn-text-muted)', marginTop: 2, fontWeight: 400 }}>
            {description}
          </div>
        </div>
        <span className="table-count">{personas.length} Members</span>
      </div>

      {/* Seats */}
      <div className="table-seats">
        {personas.map(persona => (
          <PersonaSeat
            key={persona.id}
            persona={persona}
            onClick={() => onSelect(persona)}
            isSelected={selected?.id === persona.id}
            agentInfo={agentMap?.[persona.id]}
          />
        ))}
      </div>

      {/* Governance Badge */}
      <div className="table-footer">
        {governanceType === 'auto-commit' && (
          <span className="badge badge-auto">🤖 Auto-Commit — Änderungen werden direkt committed</span>
        )}
        {governanceType === 'review-required' && (
          <span className="badge badge-review">👁️ Review Required — Alle Änderungen müssen genehmigt werden</span>
        )}
      </div>
    </div>
  );
}
