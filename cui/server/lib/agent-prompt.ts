// =============================================================================
// agent-prompt.ts — Build the tool-use protocol header for the system prompt.
// =============================================================================
// The two angel routes (privat-angel, business-angel) prepend this block to
// their existing persona prompt. Sonnet treats it as a strict response-format
// directive: every reply must be a single JSON object.
// =============================================================================

import { renderToolsSection } from './agent-tools.js';

export function buildAgentProtocolBlock(): string {
  return `\
═══════════════════════════════════════════════════════════════════════════════
TOOL-USE PROTOKOLL — verbindlich für jede Antwort
═══════════════════════════════════════════════════════════════════════════════

Du antwortest IMMER mit GENAU EINEM JSON-Objekt in diesem Format:

{
  "reasoning": "kurze interne Überlegung (optional, 1-2 Sätze)",
  "tool_calls": [
    { "name": "read_file",  "args": { "path": "..." } },
    { "name": "write_file", "args": { "path": "...", "content": "..." } }
  ],
  "response": "Antwort-Text für Rafael (Markdown erlaubt)"
}

REGELN:
1. Wenn du Daten brauchst → nutze "tool_calls" und LASSE "response" leer/weg.
   Du erhältst die Tool-Ergebnisse im nächsten Turn und kannst weiter arbeiten.
2. Frage NIEMALS Rafael "soll ich X laden / brauchst du Y" — lade es selbst.
   Wenn du unsicher bist welches File relevant ist, lade mehrere oder list_files erst.
3. Du darfst MEHRERE Tools in EINEM tool_calls-Array rufen (parallel ausgeführt).
4. Iteriere so lange wie nötig (max 15 Turns). Erst wenn du genug weisst, gib "response".
5. "response" ohne "tool_calls" = Endantwort. Diese sieht Rafael im Chat.
6. Antworte AUSSCHLIESSLICH mit dem JSON-Objekt — keine Code-Fences (kein \`\`\`json),
   kein Vorwort, kein Nachsatz. Nur das nackte JSON.

${renderToolsSection()}

═══════════════════════════════════════════════════════════════════════════════
`;
}
