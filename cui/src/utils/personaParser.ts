export interface ParsedPersona {
  id: string;
  name: string;
  role: string;
  mbti: string;
  specialty?: string;
  reportsTo?: string;
  team?: string;
  department?: string;
  governance?: string;
  motto?: string;
  strengths: string[];
  weaknesses: string[];
  responsibilities: string[];
  collaboration: Array<{ person: string; reason: string }>;
  scenarios: Array<{ title: string; steps: string[] }>;
  schedule?: string;
}

/**
 * Parse a persona markdown file into structured data
 */
export function parsePersonaMarkdown(content: string, personaId: string): ParsedPersona {
  const lines = content.split('\n');

  const persona: ParsedPersona = {
    id: personaId,
    name: '',
    role: '',
    mbti: '',
    strengths: [],
    weaknesses: [],
    responsibilities: [],
    collaboration: [],
    scenarios: []
  };

  // Extract name and role from header (e.g., "# Birgit Bauer - Product Manager")
  const headerMatch = content.match(/^#\s+(.+?)\s+-\s+(.+?)$/m);
  if (headerMatch) {
    persona.name = headerMatch[1].trim();
    persona.role = headerMatch[2].trim();
  }

  // Extract MBTI
  const mbtiMatch = content.match(/\*\*MBTI\*\*:\s+(.+?)$/m);
  if (mbtiMatch) {
    persona.mbti = mbtiMatch[1].trim();
  }

  // Extract Specialty
  const specialtyMatch = content.match(/\*\*Spezialgebiet\*\*:\s+(.+?)$/m);
  if (specialtyMatch) {
    persona.specialty = specialtyMatch[1].trim();
  }

  // Extract Reports To
  const reportsToMatch = content.match(/\*\*Berichtet an\*\*:\s+(.+?)$/m);
  if (reportsToMatch) {
    persona.reportsTo = reportsToMatch[1].trim();
  }

  // Extract Virtual Office Metadata
  const teamMatch = content.match(/\*\*Team\*\*:\s+(.+?)$/m);
  if (teamMatch) persona.team = teamMatch[1].trim();

  const deptMatch = content.match(/\*\*Department\*\*:\s+(.+?)$/m);
  if (deptMatch) persona.department = deptMatch[1].trim();

  const govMatch = content.match(/\*\*Governance\*\*:\s+(.+?)$/m);
  if (govMatch) persona.governance = govMatch[1].trim();

  // Extract motto (quote after Persönlichkeit)
  const mottoMatch = content.match(/>\s+"(.+?)"/);
  if (mottoMatch) {
    persona.motto = mottoMatch[1].trim();
  }

  // Extract Strengths (list items under ### Stärken)
  const strengthsSection = content.match(/###\s+Stärken\s*([\s\S]*?)(?=###|##|$)/);
  if (strengthsSection) {
    const items = strengthsSection[1].match(/^-\s+(.+?)$/gm);
    if (items) {
      persona.strengths = items.map(item => item.replace(/^-\s+/, '').trim());
    }
  }

  // Extract Weaknesses (list items under ### Schwächen)
  const weaknessesSection = content.match(/###\s+Schwächen\s*([\s\S]*?)(?=###|##|$)/);
  if (weaknessesSection) {
    const items = weaknessesSection[1].match(/^-\s+(.+?)$/gm);
    if (items) {
      persona.weaknesses = items.map(item => item.replace(/^-\s+/, '').trim());
    }
  }

  // Extract Responsibilities (numbered list under ## Verantwortlichkeiten)
  const responsSection = content.match(/##\s+Verantwortlichkeiten\s*([\s\S]*?)(?=##|$)/);
  if (responsSection) {
    const items = responsSection[1].match(/^\d+\.\s+\*\*(.+?)\*\*\s+—\s+(.+?)$/gm);
    if (items) {
      persona.responsibilities = items.map(item => {
        const match = item.match(/^\d+\.\s+\*\*(.+?)\*\*\s+—\s+(.+?)$/);
        return match ? `${match[1]}: ${match[2]}` : item;
      });
    }
  }

  // Extract Collaboration (table under ## Zusammenarbeit)
  const collabSection = content.match(/##\s+Zusammenarbeit\s*([\s\S]*?)(?=##|$)/);
  if (collabSection) {
    const rows = collabSection[1].match(/^\|\s+\*\*(.+?)\*\*\s+\|\s+(.+?)\s+\|$/gm);
    if (rows) {
      persona.collaboration = rows.map(row => {
        const match = row.match(/^\|\s+\*\*(.+?)\*\*\s+\|\s+(.+?)\s+\|$/);
        if (match) {
          return { person: match[1].trim(), reason: match[2].trim() };
        }
        return { person: '', reason: '' };
      }).filter(c => c.person);
    }
  }

  // Extract Scenarios (### headings under ## Typische Szenarien)
  const scenariosSection = content.match(/##\s+Typische Szenarien\s*([\s\S]*?)(?=##|---|$)/);
  if (scenariosSection) {
    const scenarioBlocks = scenariosSection[1].split('###').slice(1);
    persona.scenarios = scenarioBlocks.map(block => {
      const titleMatch = block.match(/^(.+?)$/m);
      const title = titleMatch ? titleMatch[1].trim() : 'Untitled';

      // Extract numbered steps from code block
      const codeBlock = block.match(/```\s*([\s\S]*?)\s*```/);
      const steps: string[] = [];
      if (codeBlock) {
        const stepLines = codeBlock[1].split('\n').filter(l => /^\d+\./.test(l.trim()));
        stepLines.forEach(line => {
          steps.push(line.replace(/^\d+\.\s+/, '').trim());
        });
      }

      return { title, steps };
    });
  }

  return persona;
}
