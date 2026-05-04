// =============================================================================
// marker-executor.ts — Executes <<<READ>>> and <<<WRITE>>> markers safely.
// =============================================================================
// Path safety: all paths are resolved against `baseDir` and rejected if they
// escape (no .. traversal, no absolute paths landing outside baseDir).
//
// Write atomicity: writes go to .tmp, renamed into place (POSIX atomic).
// Backup: if the file exists before WRITE, the previous content is copied to
// `backupDir/YYYY-MM-DD_basename[.timestamp]` before overwrite.
// =============================================================================

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join, normalize, basename, relative } from 'node:path';
import type { Marker } from './marker-parser.js';

export interface ReadResult {
  path: string;
  ok: boolean;
  content?: string;
  error?: string;
}

export interface WriteResult {
  path: string;
  ok: boolean;
  is_new: boolean;
  backup?: string;   // absolute path to backup file (only for overwrites)
  error?: string;
}

export interface MarkerExecResult {
  reads: ReadResult[];
  writes: WriteResult[];
}

function resolveSafe(baseDir: string, relPath: string): string | null {
  const base = normalize(baseDir);
  const abs = normalize(join(base, relPath));
  if (abs !== base && !abs.startsWith(base + '/')) return null;
  return abs;
}

function ensureDir(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

const MAX_READ_BYTES = 2_000_000; // 2 MB — guard against accidental huge file injection

export function executeMarkers(
  markers: Marker[],
  baseDir: string,
  backupDir: string,
): MarkerExecResult {
  const result: MarkerExecResult = { reads: [], writes: [] };
  const datePrefix = new Date().toISOString().slice(0, 10);

  for (const m of markers) {
    if (m.type === 'read') {
      const abs = resolveSafe(baseDir, m.path);
      if (!abs) {
        result.reads.push({ path: m.path, ok: false, error: 'path escapes baseDir' });
        continue;
      }
      if (!existsSync(abs)) {
        result.reads.push({ path: m.path, ok: false, error: 'file not found' });
        continue;
      }
      try {
        const size = statSync(abs).size;
        if (size > MAX_READ_BYTES) {
          result.reads.push({ path: m.path, ok: false, error: `file too large (${size} bytes, max ${MAX_READ_BYTES})` });
          continue;
        }
        const content = readFileSync(abs, 'utf-8');
        result.reads.push({ path: m.path, ok: true, content });
      } catch (err: any) {
        result.reads.push({ path: m.path, ok: false, error: err.message });
      }
      continue;
    }

    // WRITE
    const abs = resolveSafe(baseDir, m.path);
    if (!abs) {
      result.writes.push({ path: m.path, ok: false, is_new: false, error: 'path escapes baseDir' });
      continue;
    }
    const isNew = !existsSync(abs);
    let backupPath: string | undefined;

    try {
      if (!isNew) {
        ensureDir(backupDir);
        const backupName = `${datePrefix}_${basename(abs)}`;
        const bp = join(backupDir, backupName);
        const finalBp = existsSync(bp) ? `${bp}.${Date.now()}` : bp;
        writeFileSync(finalBp, readFileSync(abs, 'utf-8'), 'utf-8');
        backupPath = finalBp;
      }

      ensureDir(dirname(abs));
      const tmpPath = abs + '.tmp';
      writeFileSync(tmpPath, m.content, 'utf-8');
      renameSync(tmpPath, abs);

      // Verify
      const written = readFileSync(abs, 'utf-8');
      if (written !== m.content) {
        result.writes.push({ path: m.path, ok: false, is_new: isNew, backup: backupPath, error: 'write-verify mismatch' });
        continue;
      }
      result.writes.push({ path: m.path, ok: true, is_new: isNew, backup: backupPath });
    } catch (err: any) {
      result.writes.push({ path: m.path, ok: false, is_new: isNew, backup: backupPath, error: err.message });
    }
  }

  return result;
}

// Format the execution result as a user-message string that goes back into
// the LLM conversation so it can react to the read content / confirm writes.
export function formatExecResultAsUserMessage(r: MarkerExecResult): string {
  const parts: string[] = [];

  for (const rr of r.reads) {
    if (rr.ok) {
      parts.push(`<<<READ-RESULT ${rr.path}>>>\n${rr.content}\n<<</READ-RESULT>>>`);
    } else {
      parts.push(`<<<READ-ERROR ${rr.path}: ${rr.error}>>>`);
    }
  }

  for (const wr of r.writes) {
    if (wr.ok) {
      parts.push(`<<<WRITE-OK ${wr.path}${wr.is_new ? ' (new file)' : ''}>>>`);
    } else {
      parts.push(`<<<WRITE-ERROR ${wr.path}: ${wr.error}>>>`);
    }
  }

  return parts.join('\n\n');
}

// Format a short human-readable summary for the chat-UI (appended to the
// stripped assistant response so the user sees what happened).
export function formatExecSummary(r: MarkerExecResult): string {
  if (r.reads.length === 0 && r.writes.length === 0) return '';
  const lines: string[] = ['---'];

  const readsOk    = r.reads.filter(x => x.ok);
  const readsFail  = r.reads.filter(x => !x.ok);
  const writesOk   = r.writes.filter(x => x.ok);
  const writesFail = r.writes.filter(x => !x.ok);

  if (readsOk.length > 0) {
    lines.push(`📖 Gelesen: ${readsOk.map(x => `\`${x.path}\``).join(', ')}`);
  }
  if (writesOk.length > 0) {
    const newFiles = writesOk.filter(x => x.is_new).map(x => `\`${x.path}\` (neu)`);
    const updated  = writesOk.filter(x => !x.is_new).map(x => `\`${x.path}\``);
    const items = [...newFiles, ...updated];
    lines.push(`✏️ Geschrieben: ${items.join(', ')}`);
  }
  if (readsFail.length > 0 || writesFail.length > 0) {
    const fails = [
      ...readsFail.map(x => `Read \`${x.path}\`: ${x.error}`),
      ...writesFail.map(x => `Write \`${x.path}\`: ${x.error}`),
    ];
    lines.push(`⚠️ Fehler: ${fails.join('; ')}`);
  }

  return '\n\n' + lines.join('\n');
}
