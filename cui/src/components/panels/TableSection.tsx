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
}

interface TableSectionProps {
  title: string;
  icon: string;
  personas: PersonaCard[];
  color: 'gold' | 'blue' | 'green';
  onSelect: (p: PersonaCard) => void;
  selected: PersonaCard | null;
}

export default function TableSection({ title, icon, personas, color, onSelect, selected }: TableSectionProps) {
  const governanceType = personas[0]?.governance;

  return (
    <div className={`table-section table-${color}`}>
      {/* Header */}
      <div className="table-header">
        <span className="table-icon">{icon}</span>
        <h3>{title}</h3>
        <span className="table-count">{personas.length} members</span>
      </div>

      {/* Seats */}
      <div className="table-seats">
        {personas.map(persona => (
          <PersonaSeat
            key={persona.id}
            persona={persona}
            onClick={() => onSelect(persona)}
            isSelected={selected?.id === persona.id}
          />
        ))}
      </div>

      {/* Governance Badge */}
      <div className="table-footer">
        {governanceType === 'auto-commit' && (
          <span className="badge badge-auto">🤖 Auto-Commit</span>
        )}
        {governanceType === 'review-required' && (
          <span className="badge badge-review">👁️ Review Required</span>
        )}
      </div>
    </div>
  );
}
