// =============================================================================
// diff-parser.ts — Parses FILE/OLD/NEW diff blocks from AI output
// =============================================================================
// Expected format (one or more blocks, separated by --- or consecutive FILE:):
//
//   FILE: customer-success/engelmann/ENGELMANN.md
//   OLD: exact old text
//   (can span multiple lines)
//   NEW: new replacement text
//   (can span multiple lines)
//
//   ---
//
//   FILE: sales/PIPELINE.md
//   OLD: ...
//   NEW: ...
// =============================================================================

export interface ParsedDiff {
  file: string;
  old: string;
  newText: string;
}

export function parseDiffs(raw: string): ParsedDiff[] {
  const results: ParsedDiff[] = [];

  // Normalize line endings
  const normalized = raw.replace(/\r\n/g, '\n');

  // ── Format 0: <<<DIFF ... >>> and <<<NEW ... >>> blocks ──────────
  const diffBlockRe = /<<<DIFF\s+(.+?)\n([\s\S]*?)>>>/g;
  const newBlockRe  = /<<<NEW\s+(.+?)\n([\s\S]*?)>>>/g;
  const dedent = (s: string) => s.replace(/^  /gm, '').replace(/\n+$/, '');

  let match: RegExpExecArray | null;
  while ((match = diffBlockRe.exec(normalized)) !== null) {
    const file = match[1].trim();
    const body = match[2];
    const oldMatch = body.match(/^old_string:\s*\|?\s*\n([\s\S]*?)(?=^new_string:)/m);
    const newMatch = body.match(/^new_string:\s*\|?\s*\n([\s\S]*?)$/m);
    if (oldMatch && newMatch) {
      results.push({ file, old: dedent(oldMatch[1]), newText: dedent(newMatch[1]) });
    }
  }
  while ((match = newBlockRe.exec(normalized)) !== null) {
    const file = match[1].trim();
    const body = match[2];
    const contentMatch = body.match(/^content:\s*\|?\s*\n([\s\S]*?)$/m);
    if (contentMatch) {
      results.push({ file, old: '', newText: dedent(contentMatch[1]) });
    }
  }
  if (results.length > 0) return results;

  // Split into blocks by --- separator OR by FILE: at start of line
  let blocks: string[] = normalized.split(/\n---+\n/);

  // If no --- separators, split by FILE: boundaries
  if (blocks.length === 1) {
    blocks = normalized.split(/(?=^FILE:)/m).filter(b => b.trim());
  }

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed || !trimmed.includes('FILE:')) continue;

    // Extract FILE: line
    const fileMatch = trimmed.match(/^FILE:\s*(.+)$/m);
    if (!fileMatch) continue;
    const file = fileMatch[1].trim();

    // Extract OLD: content (everything between OLD: and NEW:)
    // Uses non-greedy match across lines
    const oldNewMatch = trimmed.match(/^OLD:\s*([\s\S]*?)^NEW:\s*([\s\S]*)$/m);
    if (!oldNewMatch) continue;

    // Trim trailing newlines only (preserve internal whitespace)
    const old = oldNewMatch[1].replace(/\n+$/, '');
    const newText = oldNewMatch[2].replace(/\n+$/, '');

    if (file && old !== undefined) {
      results.push({ file, old, newText });
    }
  }

  return results;
}
