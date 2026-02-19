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

interface PersonaSeatProps {
  persona: PersonaCard;
  onClick: () => void;
  isSelected: boolean;
}

export default function PersonaSeat({ persona, onClick, isSelected }: PersonaSeatProps) {
  const initials = persona.name
    .split(' ')
    .map(n => n[0])
    .join('')
    .toUpperCase();

  return (
    <div
      className={`persona-seat ${isSelected ? 'selected' : ''}`}
      onClick={onClick}
      title={`${persona.name}\n${persona.role}\nMBTI: ${persona.mbti}\nStatus: ${persona.status}`}
    >
      {/* Avatar with Status Dot */}
      <div className="persona-seat-avatar">
        {initials}
        <div className={`persona-seat-status status-${persona.status}`} />
      </div>

      {/* Name */}
      <div className="persona-seat-name">{persona.name}</div>
    </div>
  );
}
