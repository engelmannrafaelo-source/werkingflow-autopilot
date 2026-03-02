import { useState, useEffect } from 'react';
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

interface MeetingRoomViewProps {
  personas: PersonaCard[];
  onSelectPersona: (p: PersonaCard) => void;
  selected: PersonaCard | null;
}

export default function MeetingRoomView({ personas, onSelectPersona, selected }: MeetingRoomViewProps) {
  // persona_id → AgentInfo
  const [agentMap, setAgentMap] = useState<Record<string, AgentInfo>>({});

  useEffect(() => {
    async function fetchAgentStatus() {
      if ((window as any).__cuiServerAlive === false) return;
      try {
        const r = await fetch('/api/agents/status', { signal: AbortSignal.timeout(8000) });
        if (!r.ok) throw new Error(`[MeetingRoom] agents/status failed: HTTP ${r.status}`);
        const d = await r.json();
        const map: Record<string, AgentInfo> = {};
        for (const agent of (d.agents ?? [])) {
          map[agent.persona_id] = {
            status: agent.status,
            schedule: agent.schedule,
            last_run: agent.last_run,
            last_actions: agent.last_actions,
            inbox_count: agent.inbox_count,
            approvals_count: agent.approvals_count,
          };
        }
        setAgentMap(map);
      } catch (err) {
        console.warn('[MeetingRoom] fetch agent status error:', err);
      }
    }
    fetchAgentStatus();
    // Refresh every 60s
    const iv = setInterval(fetchAgentStatus, 60000);
    return () => clearInterval(iv);
  }, []);
  const tables = {
    product:    personas.filter(p => p.table === 'product'),
    revenue:    personas.filter(p => p.table === 'revenue'),
    delivery:   personas.filter(p => p.table === 'delivery'),
    operations: personas.filter(p => p.table === 'operations'),
  };

  return (
    <div className="meeting-room">
      <TableSection
        title="Product Table"
        icon="🎯"
        description="WAS bauen wir? — Birgit definiert die Roadmap und Priorities. Anna bringt UX-Perspektive. Felix evaluiert neue Technologien und Innovationspotenzial. Gemeinsam entscheiden sie was ins nächste Sprint kommt."
        personas={tables.product}
        color="gold"
        onSelect={onSelectPersona}
        selected={selected}
        agentMap={agentMap}
      />
      <TableSection
        title="Revenue Table"
        icon="💰"
        description="WIE verdienen wir? — Vera akquiriert Kunden, Mira generiert Leads, Chris hält Kunden glücklich. Kai scannt den Markt: Konkurrenten, Open-Source Tools, DACH-Trends — liefert Weekly Briefings und Battle Cards."
        personas={tables.revenue}
        color="green"
        onSelect={onSelectPersona}
        selected={selected}
        agentMap={agentMap}
      />
      <TableSection
        title="Delivery Table"
        icon="⚙️"
        description="WIE bauen wir? — Max führt das Engineering-Team. Sarah, Klaus, Tim, Herbert und Lisa bauen, testen und sichern das Produkt. Peter dokumentiert alles. Code-Änderungen laufen über Auto-Commit mit Review-Ausnahmen."
        personas={tables.delivery}
        color="blue"
        onSelect={onSelectPersona}
        selected={selected}
        agentMap={agentMap}
      />
      <TableSection
        title="Operations Table"
        icon="🔧"
        description="WIE laufen wir? — Otto koordiniert Prozesse, Ressourcen und Team-Koordination. Finn behält die Finanzen, Cash Flow und Budget im Blick. Beide stellen sicher dass das Unternehmen effizient und gesund läuft."
        personas={tables.operations}
        color="purple"
        onSelect={onSelectPersona}
        selected={selected}
        agentMap={agentMap}
      />
    </div>
  );
}
