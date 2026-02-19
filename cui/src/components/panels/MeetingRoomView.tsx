import TableSection from './TableSection';

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

interface MeetingRoomViewProps {
  personas: PersonaCard[];
  onSelectPersona: (p: PersonaCard) => void;
  selected: PersonaCard | null;
}

export default function MeetingRoomView({ personas, onSelectPersona, selected }: MeetingRoomViewProps) {
  // Gruppiere Personas nach Table
  const tables = {
    leadership: personas.filter(p => p.table === 'leadership'),
    engineering: personas.filter(p => p.table === 'engineering'),
    business: personas.filter(p => p.table === 'business'),
  };

  return (
    <div className="meeting-room">
      <TableSection
        title="Leadership Table"
        icon="👔"
        personas={tables.leadership}
        color="gold"
        onSelect={onSelectPersona}
        selected={selected}
      />
      <TableSection
        title="Engineering Table"
        icon="⚙️"
        personas={tables.engineering}
        color="blue"
        onSelect={onSelectPersona}
        selected={selected}
      />
      <TableSection
        title="Business Table"
        icon="💼"
        personas={tables.business}
        color="green"
        onSelect={onSelectPersona}
        selected={selected}
      />
    </div>
  );
}
