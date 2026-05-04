// =============================================================================
// agent-tools.ts — Tool definitions + execution for the editor agents.
// =============================================================================
// Three tools are exposed:
//   - read_file({path})        → returns file content
//   - write_file({path, content}) → atomic write with backup, path-sandboxed
//   - list_files({dir?, depth?}) → directory tree, sandboxed
//
// All paths resolve against the agent's baseDir; traversal is rejected.
// Writes go to .tmp + rename (POSIX atomic). Existing files are backed up
// to backupDir/YYYY-MM-DD_basename[.timestamp] before overwrite.
// =============================================================================

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  statSync,
  readdirSync,
} from 'node:fs';
import { dirname, join, normalize, basename, relative } from 'node:path';

import type { ToolCall } from './agent-response-parser.js';
import type { ToolResult } from './agent-loop.js';

// ============================================================================
// Public tool catalog (used in the system prompt)
// ============================================================================

export interface ToolSpec {
  name: string;
  description: string;
  args: string;
}

export const AGENT_TOOLS: ToolSpec[] = [
  {
    name: 'read_file',
    description: 'Liest eine Datei aus dem Workspace. Gibt den vollständigen Inhalt zurück.',
    args: '{ "path": "relativer/pfad.md" }',
  },
  {
    name: 'write_file',
    description:
      'Schreibt eine Datei (komplett, kein Patch). Erstellt automatisch ein Backup wenn die Datei existiert. ' +
      'Verzeichnisse werden bei Bedarf angelegt.',
    args: '{ "path": "relativer/pfad.md", "content": "..." }',
  },
  {
    name: 'list_files',
    description:
      'Listet Dateien unterhalb eines Verzeichnisses (default: Root). Gibt einen flachen Pfad-Baum bis ' +
      'zur angegebenen Tiefe (default 2) zurück.',
    args: '{ "dir"?: "unter/pfad", "depth"?: 2 }',
  },
];

/** Render the tool catalog for inclusion in the system prompt. */
export function renderToolsSection(): string {
  const lines: string[] = ['Verfügbare Tools (rufe sie über tool_calls auf):'];
  for (const t of AGENT_TOOLS) {
    lines.push(`- ${t.name}(${t.args})`);
    lines.push(`    ${t.description}`);
  }
  return lines.join('\n');
}

// ============================================================================
// Tool execution
// ============================================================================

export interface AgentToolContext {
  /** Sandbox root — all paths resolve against this. */
  baseDir: string;
  /** Where to write backups for overwrites. */
  backupDir: string;
  /** Hard cap on read size (bytes). Default 2 MB. */
  maxReadBytes?: number;
  /** List depth cap. Default 4. */
  maxListDepth?: number;
  /** Track which paths got written (for caller to surface to UI). */
  writtenPaths?: string[];
}

const DEFAULT_MAX_READ_BYTES = 2_000_000;
const DEFAULT_MAX_LIST_DEPTH = 4;

function resolveSafe(baseDir: string, relPath: string): string | null {
  const base = normalize(baseDir);
  const cleaned = (relPath || '').replace(/^\/+/, '');
  const abs = normalize(join(base, cleaned));
  if (abs !== base && !abs.startsWith(base + '/')) return null;
  return abs;
}

function ensureDir(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

/**
 * Execute one tool call and return a structured result.
 * Errors are caught and returned as ok:false ToolResults so the agent loop
 * can feed them back to the model rather than aborting.
 */
export async function executeAgentTool(
  call: ToolCall,
  ctx: AgentToolContext,
): Promise<ToolResult> {
  const maxReadBytes = ctx.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
  const maxListDepth = ctx.maxListDepth ?? DEFAULT_MAX_LIST_DEPTH;

  switch (call.name) {
    case 'read_file':
      return execRead(call, ctx, maxReadBytes);
    case 'write_file':
      return execWrite(call, ctx);
    case 'list_files':
      return execList(call, ctx, maxListDepth);
    default:
      return {
        name: call.name,
        args: call.args,
        ok: false,
        error: `unknown tool '${call.name}' (allowed: ${AGENT_TOOLS.map(t => t.name).join(', ')})`,
      };
  }
}

function execRead(call: ToolCall, ctx: AgentToolContext, maxBytes: number): ToolResult {
  const path = String(call.args.path ?? '').trim();
  if (!path) {
    return { name: call.name, args: call.args, ok: false, error: 'path required' };
  }
  const abs = resolveSafe(ctx.baseDir, path);
  if (!abs) {
    return { name: call.name, args: call.args, ok: false, error: 'path escapes baseDir' };
  }
  if (!existsSync(abs)) {
    return { name: call.name, args: call.args, ok: false, error: 'file not found' };
  }
  try {
    const size = statSync(abs).size;
    if (size > maxBytes) {
      return {
        name: call.name,
        args: call.args,
        ok: false,
        error: `file too large (${size} bytes, max ${maxBytes})`,
      };
    }
    const content = readFileSync(abs, 'utf-8');
    return { name: call.name, args: call.args, ok: true, result: content };
  } catch (err: any) {
    return { name: call.name, args: call.args, ok: false, error: err.message };
  }
}

function execWrite(call: ToolCall, ctx: AgentToolContext): ToolResult {
  const path = String(call.args.path ?? '').trim();
  const content = call.args.content;

  if (!path) {
    return { name: call.name, args: call.args, ok: false, error: 'path required' };
  }
  if (typeof content !== 'string') {
    return { name: call.name, args: call.args, ok: false, error: 'content must be a string' };
  }
  const abs = resolveSafe(ctx.baseDir, path);
  if (!abs) {
    return { name: call.name, args: call.args, ok: false, error: 'path escapes baseDir' };
  }

  const isNew = !existsSync(abs);
  let backupPath: string | undefined;
  const datePrefix = new Date().toISOString().slice(0, 10);

  try {
    if (!isNew) {
      ensureDir(ctx.backupDir);
      const backupName = `${datePrefix}_${basename(abs)}`;
      const bp = join(ctx.backupDir, backupName);
      const finalBp = existsSync(bp) ? `${bp}.${Date.now()}` : bp;
      writeFileSync(finalBp, readFileSync(abs, 'utf-8'), 'utf-8');
      backupPath = finalBp;
    }

    ensureDir(dirname(abs));
    const tmpPath = abs + '.tmp';
    writeFileSync(tmpPath, content, 'utf-8');
    renameSync(tmpPath, abs);

    // Verify (defensive — catches stale fs cache, partial writes)
    const verify = readFileSync(abs, 'utf-8');
    if (verify !== content) {
      return {
        name: call.name,
        args: call.args,
        ok: false,
        error: 'write-verify mismatch',
      };
    }

    if (ctx.writtenPaths) ctx.writtenPaths.push(path);

    const note = isNew ? 'created' : `updated (backup: ${backupPath ? relative(ctx.baseDir, backupPath) : 'n/a'})`;
    return {
      name: call.name,
      args: { path },               // strip large content from args echo
      ok: true,
      result: `wrote ${content.length} chars — ${note}`,
    };
  } catch (err: any) {
    return {
      name: call.name,
      args: { path },
      ok: false,
      error: err.message,
    };
  }
}

function execList(call: ToolCall, ctx: AgentToolContext, maxDepth: number): ToolResult {
  const dirArg = String(call.args.dir ?? '').trim();
  const depthArg = Number(call.args.depth ?? 2);
  const depth = Math.max(1, Math.min(Math.floor(depthArg) || 2, maxDepth));

  const startAbs = resolveSafe(ctx.baseDir, dirArg);
  if (!startAbs) {
    return { name: call.name, args: call.args, ok: false, error: 'path escapes baseDir' };
  }
  if (!existsSync(startAbs)) {
    return { name: call.name, args: call.args, ok: false, error: 'dir not found' };
  }
  if (!statSync(startAbs).isDirectory()) {
    return { name: call.name, args: call.args, ok: false, error: 'not a directory' };
  }

  const entries: string[] = [];
  walkDir(startAbs, ctx.baseDir, depth, 0, entries);
  const result = entries.length === 0 ? '(empty)' : entries.join('\n');
  return { name: call.name, args: call.args, ok: true, result };
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', '.cache',
  '_archive', '_archiv', '.DS_Store',
]);

function walkDir(absDir: string, baseDir: string, maxDepth: number, depth: number, out: string[]): void {
  if (depth >= maxDepth) return;
  let items: string[];
  try {
    items = readdirSync(absDir).sort();
  } catch {
    return;
  }
  for (const name of items) {
    if (SKIP_DIRS.has(name)) continue;
    if (name.startsWith('.')) continue;
    const abs = join(absDir, name);
    let st;
    try { st = statSync(abs); } catch { continue; }
    const rel = relative(baseDir, abs);
    if (st.isDirectory()) {
      out.push(rel + '/');
      walkDir(abs, baseDir, maxDepth, depth + 1, out);
    } else if (st.isFile()) {
      out.push(rel);
    }
  }
}

// ============================================================================
// UI summary helpers
// ============================================================================

/** Compact human-readable summary of tool results (for chat-UI footer). */
export function formatToolSummaryForUI(results: ToolResult[]): string {
  if (results.length === 0) return '';
  const reads = results.filter(r => r.name === 'read_file');
  const writes = results.filter(r => r.name === 'write_file');
  const lists = results.filter(r => r.name === 'list_files');
  const lines: string[] = [];

  if (reads.length > 0) {
    const ok = reads.filter(r => r.ok).map(r => `\`${(r.args as any).path}\``);
    const fail = reads.filter(r => !r.ok).map(r => `\`${(r.args as any).path}\` (${r.error})`);
    if (ok.length > 0) lines.push(`📖 Gelesen: ${ok.join(', ')}`);
    if (fail.length > 0) lines.push(`⚠️ Lese-Fehler: ${fail.join(', ')}`);
  }
  if (writes.length > 0) {
    const ok = writes.filter(r => r.ok).map(r => `\`${(r.args as any).path}\``);
    const fail = writes.filter(r => !r.ok).map(r => `\`${(r.args as any).path}\` (${r.error})`);
    if (ok.length > 0) lines.push(`✏️ Geschrieben: ${ok.join(', ')}`);
    if (fail.length > 0) lines.push(`⚠️ Schreib-Fehler: ${fail.join(', ')}`);
  }
  if (lists.length > 0) {
    const ok = lists.filter(r => r.ok).map(r => `\`${(r.args as any).dir || '/'}\``);
    if (ok.length > 0) lines.push(`📂 Aufgelistet: ${ok.join(', ')}`);
  }
  if (lines.length === 0) return '';
  return '\n\n---\n' + lines.join('\n');
}
