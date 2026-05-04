// =============================================================================
// marker-parser.ts — Parses <<<READ>>> and <<<WRITE>>> markers from AI output.
// =============================================================================
// Format:
//   <<<READ pfad/zur/datei.md>>>           (single-line, content fetched by server)
//
//   <<<WRITE pfad/zur/datei.md
//   ...vollstaendiger neuer Inhalt...
//   >>>                                     (multi-line, server overwrites file)
//
// Multiple markers per response are allowed. Markers may be interleaved with
// prose. Whitespace inside the WRITE body is preserved exactly (only the
// trailing newline before `>>>` is stripped).
// =============================================================================

export interface MarkerRead { type: 'read'; path: string; }
export interface MarkerWrite { type: 'write'; path: string; content: string; }
export type Marker = MarkerRead | MarkerWrite;

const READ_RE  = /<<<READ\s+([^\n>]+?)\s*>>>/g;
const WRITE_RE = /<<<WRITE\s+([^\n]+?)\n([\s\S]*?)\n?>>>/g;

export function parseMarkers(raw: string): Marker[] {
  const text = raw.replace(/\r\n/g, '\n');
  const out: Marker[] = [];
  let m: RegExpExecArray | null;

  while ((m = READ_RE.exec(text)) !== null) {
    const path = m[1].trim();
    if (path) out.push({ type: 'read', path });
  }

  while ((m = WRITE_RE.exec(text)) !== null) {
    const path = m[1].trim();
    if (path) out.push({ type: 'write', path, content: m[2] });
  }

  return out;
}

// Strip markers from text — used to render a clean assistant message in UI.
export function stripMarkers(raw: string): string {
  return raw
    .replace(/<<<READ\s+[^\n>]+?\s*>>>/g, '')
    .replace(/<<<WRITE\s+[^\n]+?\n[\s\S]*?\n?>>>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
