// =============================================================================
// auto-apply-new.ts — Auto-write <<<NEW>>> blocks from chat responses.
// =============================================================================
// SAFETY: Only writes files that do NOT already exist. Never overwrites.
// Used by privat-angel and business-angel /chat handlers to remove the
// manual "Apply" click step for net-new files (the safe case).
// =============================================================================
import { existsSync, writeFileSync, mkdirSync, renameSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { parseDiffs } from './diff-parser.js';

export interface AutoApplyResult {
  written: string[];   // relative paths actually written
  skipped: string[];   // relative paths skipped because file exists
  failed: Array<{ file: string; reason: string }>;
}

/**
 * Parse <<<NEW>>> blocks from text and write them to disk *if and only if*
 * the target file does not already exist. Returns a structured result so the
 * caller can append a summary to the chat response.
 *
 * Atomic write: writes to .tmp then renames (POSIX rename is atomic).
 * Path safety: rejects files that resolve outside baseDir (no ../ escape).
 */
export function autoApplyNewFiles(text: string, baseDir: string): AutoApplyResult {
  const result: AutoApplyResult = { written: [], skipped: [], failed: [] };
  const diffs = parseDiffs(text);

  for (const d of diffs) {
    // Only auto-apply pure NEW blocks (old === ''); never edits.
    if (d.old !== '') continue;

    // Resolve & guard against path traversal.
    const absPath = normalize(join(baseDir, d.file));
    if (!absPath.startsWith(normalize(baseDir) + '/')) {
      result.failed.push({ file: d.file, reason: 'path escapes baseDir' });
      continue;
    }

    if (existsSync(absPath)) {
      // Idempotent: if already-existing file matches expected content, count as skipped (already done).
      try {
        const current = readFileSync(absPath, 'utf-8');
        if (current === d.newText) {
          result.skipped.push(d.file + ' (already up-to-date)');
        } else {
          result.skipped.push(d.file + ' (exists, content differs — manual review needed)');
        }
      } catch {
        result.skipped.push(d.file + ' (exists)');
      }
      continue;
    }

    try {
      mkdirSync(dirname(absPath), { recursive: true });
      const tmpPath = absPath + '.tmp';
      writeFileSync(tmpPath, d.newText, 'utf-8');
      renameSync(tmpPath, absPath);
      result.written.push(d.file);
    } catch (err: any) {
      result.failed.push({ file: d.file, reason: err.message });
    }
  }

  return result;
}

/**
 * Format a one-line markdown summary suitable for appending to a chat response.
 * Returns empty string when nothing was applied (no noise in normal replies).
 */
export function summarizeApplyResult(r: AutoApplyResult): string {
  if (r.written.length === 0 && r.failed.length === 0) return '';
  const parts: string[] = [];
  if (r.written.length > 0) {
    parts.push(`✅ **Auto-applied** ${r.written.length} neue Datei${r.written.length === 1 ? '' : 'en'}:\n${r.written.map(f => `- \`${f}\``).join('\n')}`);
  }
  if (r.failed.length > 0) {
    parts.push(`⚠️ **Apply failed** für ${r.failed.length}:\n${r.failed.map(f => `- \`${f.file}\`: ${f.reason}`).join('\n')}`);
  }
  if (r.skipped.length > 0 && r.written.length > 0) {
    // Only mention skipped if we wrote something else — pure-skip noise (re-saves on restore) is suppressed.
    parts.push(`(${r.skipped.length} bereits vorhanden, übersprungen)`);
  }
  return '\n\n---\n\n' + parts.join('\n\n');
}
