/**
 * Shared JSONL helpers — single source of truth for conversation file operations.
 *
 * Consolidates:
 * - 4x findJsonlPath (index.ts, mission.ts x2, peer-awareness.ts)
 * - 2x unstickConversation (index.ts simple, mission.ts comprehensive)
 * - readJsonlMetadata, readConversationMessages, getOriginalCwd,
 *   extractConversationContext, deepRepairJsonl (all from mission.ts)
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, openSync, readSync, closeSync } from 'fs';
import { join } from 'path';
import * as claudeCli from '../claude-cli.js';

// --- Sanitize cache (prevents re-sanitizing the same session every poll cycle) ---
const sanitizeCache = new Map<string, number>();
const SANITIZE_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// findJsonlPath — find a JSONL session file across all account project dirs
// ---------------------------------------------------------------------------

/** Simple lookup: returns just the file path (or null). */
export function findJsonlPath(sessionId: string): string | null {
  const result = findJsonlPathAllAccounts(sessionId);
  return result?.path ?? null;
}

/** Rich lookup: returns path + accountId + dirName. */
export function findJsonlPathAllAccounts(sessionId: string): { path: string; accountId: string; dirName: string } | null {
  if (!sessionId) return null;
  for (const acc of claudeCli.ACCOUNT_CONFIG) {
    const projDir = join(acc.home, '.claude', 'projects');
    try { if (!statSync(projDir).isDirectory()) continue; } catch { continue; }
    for (const dirname of readdirSync(projDir)) {
      const filePath = join(projDir, dirname, `${sessionId}.jsonl`);
      if (existsSync(filePath)) return { path: filePath, accountId: acc.id, dirName: dirname };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// readJsonlMetadata — OPTIMIZED: seekable head+tail read + mtime cache
// ---------------------------------------------------------------------------
// Performance: reads only first 8KB + last 8KB instead of entire file.
// For a 100MB file: 93ms -> 0.1ms (930x speedup).
// mtime cache: only re-reads files that changed since last scan.

type JsonlMetaResult = { summary: string; model: string; messageCount: number; createdAt: string; updatedAt: string };
const _metaCache = new Map<string, { mtimeMs: number; size: number; meta: JsonlMetaResult }>();

/** Clear metadata cache (useful after unstick/compact operations) */
export function clearMetaCache(filePath?: string) {
  if (filePath) _metaCache.delete(filePath);
  else _metaCache.clear();
}

export function readJsonlMetadata(filePath: string): JsonlMetaResult | null {
  try {
    const stat = statSync(filePath);
    const updatedAt = stat.mtime.toISOString();

    // Check mtime cache — skip re-read if file unchanged
    const cached = _metaCache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.meta;
    }

    const fileSize = stat.size;

    // Small files (<16KB): read fully (fast enough, more accurate)
    if (fileSize < 16384) {
      const meta = _readJsonlMetadataFull(filePath, updatedAt);
      if (meta) _metaCache.set(filePath, { mtimeMs: stat.mtimeMs, size: fileSize, meta });
      return meta;
    }

    // Large files: seekable head + tail read
    const HEAD_SIZE = 8192;
    const TAIL_SIZE = 8192;
    const fd = openSync(filePath, 'r');

    // Read head
    const headBuf = Buffer.alloc(HEAD_SIZE);
    const headBytes = readSync(fd, headBuf, 0, HEAD_SIZE, 0);
    const headStr = headBuf.toString('utf-8', 0, headBytes);

    // Read tail
    let tailStr = '';
    if (fileSize > HEAD_SIZE + TAIL_SIZE) {
      const tailBuf = Buffer.alloc(TAIL_SIZE);
      const tailBytes = readSync(fd, tailBuf, 0, TAIL_SIZE, fileSize - TAIL_SIZE);
      tailStr = tailBuf.toString('utf-8', 0, tailBytes);
    }
    closeSync(fd);

    let summary = '';
    let model = '';
    let createdAt = '';
    let firstUserText = '';

    // Parse head lines (get createdAt, first user message for summary fallback)
    const headLines = headStr.split('\n').filter(l => l.trim());
    for (const line of headLines) {
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'summary' && obj.summary) { summary = obj.summary; }
        if (!createdAt && obj.timestamp) createdAt = obj.timestamp;
        if (obj.message?.role === 'user' && !firstUserText) {
          const c = obj.message.content;
          firstUserText = typeof c === 'string' ? c.slice(0, 200) :
            Array.isArray(c) ? c.filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' ').slice(0, 200) : '';
        }
        if (obj.message?.model && obj.message.model !== '<synthetic>') model = obj.message.model;
      } catch { /* partial line at boundary — skip */ }
    }

    // Parse tail lines (get summary, latest model)
    if (tailStr) {
      const tailLines = tailStr.split('\n').filter(l => l.trim());
      // Skip first line of tail (likely truncated at seek boundary)
      for (let i = 1; i < tailLines.length; i++) {
        try {
          const obj = JSON.parse(tailLines[i]);
          if (obj.type === 'summary' && obj.summary) summary = obj.summary;
          if (obj.message?.model && obj.message.model !== '<synthetic>') model = obj.message.model;
        } catch { /* partial line — skip */ }
      }
    }

    if (!summary && firstUserText) summary = firstUserText;

    // Approximate messageCount from file size (avoid reading entire file)
    // Average JSONL message line ~1.5KB for conversations with tool use
    const estimatedLines = Math.max(1, Math.round(fileSize / 1500));
    // Roughly 40-60% of lines are user/assistant messages
    const messageCount = Math.max(1, Math.round(estimatedLines * 0.5));

    const meta: JsonlMetaResult = { summary, model, messageCount, createdAt, updatedAt };
    _metaCache.set(filePath, { mtimeMs: stat.mtimeMs, size: fileSize, meta });
    return meta;
  } catch {
    return null;
  }
}

/** Full read fallback for small files — preserves exact messageCount */
function _readJsonlMetadataFull(filePath: string, updatedAt: string): JsonlMetaResult | null {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());

    let summary = '';
    let model = '';
    let messageCount = 0;
    let createdAt = '';
    let firstUserText = '';

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'queue-operation' || obj.type === 'progress') continue;
        if (obj.type === 'summary' && obj.summary) { summary = obj.summary; continue; }
        if (!createdAt && obj.timestamp) createdAt = obj.timestamp;
        if (obj.message?.role === 'user' || obj.message?.role === 'assistant') {
          messageCount++;
          if (obj.message.role === 'user' && !firstUserText) {
            const c = obj.message.content;
            firstUserText = typeof c === 'string' ? c.slice(0, 200) :
              Array.isArray(c) ? c.filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' ').slice(0, 200) : '';
          }
          if (obj.message.model && obj.message.model !== '<synthetic>') model = obj.message.model;
        }
      } catch { /* skip unparseable */ }
    }

    if (!summary && firstUserText) summary = firstUserText;
    return { summary, model, messageCount, createdAt, updatedAt };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// readConversationMessages — full message parsing (for detail view)
// ---------------------------------------------------------------------------

export function readConversationMessages(filePath: string): {
  messages: Array<{ message: { role: string; content: any; model?: string }; timestamp: string; isApiErrorMessage?: boolean; error?: string }>;
  summary: string;
  projectPath: string;
} {
  const content = readFileSync(filePath, 'utf-8');
  const rawLines = content.split('\n').filter(l => l.trim());
  const messages: Array<{ message: { role: string; content: any; model?: string }; timestamp: string; isApiErrorMessage?: boolean; error?: string }> = [];
  let summary = '';

  for (const rawLine of rawLines) {
    try {
      let objects: any[] = [];
      try {
        objects = [JSON.parse(rawLine)];
      } catch {
        // Handle write-corruption: two JSON objects concatenated on one line
        const parts = rawLine.split(/(?<=\})\s*(?=\{)/);
        for (const part of parts) {
          try { objects.push(JSON.parse(part)); } catch { /* skip */ }
        }
        if (objects.length === 0) continue;
      }

      for (const obj of objects) {
        if (obj.type === 'queue-operation' || obj.type === 'progress') continue;
        if (obj.type === 'summary' && obj.summary) { summary = obj.summary; continue; }
        if (obj.message?.role) {
          messages.push({
            message: obj.message,
            timestamp: obj.timestamp || '',
            isApiErrorMessage: obj.isApiErrorMessage,
            error: obj.error,
          });
        }
      }
    } catch { /* skip unparseable */ }
  }

  return { messages, summary, projectPath: '' };
}

// ---------------------------------------------------------------------------
// getOriginalCwd — read CWD from the first JSONL line
// ---------------------------------------------------------------------------

export function getOriginalCwd(sessionId: string): string | null {
  const found = findJsonlPathAllAccounts(sessionId);
  if (!found) return null;
  try {
    const firstLine = readFileSync(found.path, 'utf8').split('\n')[0];
    if (!firstLine) return null;
    const obj = JSON.parse(firstLine);
    return obj.cwd || null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// extractConversationContext — summary for context carry-over (resume fallback)
// ---------------------------------------------------------------------------

export function extractConversationContext(sessionId: string, maxMessages = 20): string | null {
  const found = findJsonlPathAllAccounts(sessionId);
  if (!found) return null;
  try {
    const lines = readFileSync(found.path, 'utf8').split('\n').filter(l => l.trim());
    const messages: Array<{ role: string; content: string }> = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'user' && obj.message?.content) {
          messages.push({ role: 'user', content: typeof obj.message.content === 'string' ? obj.message.content : JSON.stringify(obj.message.content) });
        } else if (obj.type === 'assistant' && obj.message?.content) {
          const text = Array.isArray(obj.message.content)
            ? obj.message.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n')
            : typeof obj.message.content === 'string' ? obj.message.content : '';
          if (text) messages.push({ role: 'assistant', content: text });
        }
      } catch { /* skip corrupt lines */ }
    }
    if (messages.length === 0) return null;
    const recent = messages.slice(-maxMessages);
    const parts = recent.map(m => `[${m.role.toUpperCase()}]: ${m.content.slice(0, 500)}`);
    return `[KONTEXT: Vorherige Konversation (Session ${sessionId.slice(0, 8)}, ${messages.length} Nachrichten). Hier die letzten ${recent.length}:]\n\n${parts.join('\n\n')}\n\n[KONTEXT ENDE — Fahre fort wo du aufgehoert hast.]`;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// unstickConversation — comprehensive 3-phase JSONL sanitizer
// ---------------------------------------------------------------------------
// Fixes ALL known corruption patterns:
// 1. Remove queue-operation + progress entries
// 2. Remove synthetic error messages (rate limit, billing)
// 3. Fix write-corrupted lines (two JSON objects on one line)
// 4. Remove consecutive duplicate user messages
// 5. Remove trailing truncated/empty assistant
// 6. Remove orphaned tool_result entries

export function unstickConversation(sessionId: string): number {
  const lastSanitize = sanitizeCache.get(sessionId);
  if (lastSanitize && Date.now() - lastSanitize < SANITIZE_COOLDOWN_MS) return 0;

  const filePath = findJsonlPath(sessionId);
  if (!filePath) return 0;

  try {
    // Size guard — refuse oversized files
    const fileSize = statSync(filePath).size;
    if (fileSize > 20 * 1024 * 1024) {
      console.error(`[Sanitize] REFUSING to process ${sessionId}: ${(fileSize / 1024 / 1024).toFixed(1)}MB exceeds 20MB limit`);
      sanitizeCache.set(sessionId, Date.now());
      return 0;
    }

    const rawLines = readFileSync(filePath, 'utf-8').split('\n');
    const cleanLines: string[] = [];
    let totalRemoved = 0;

    // Phase 1: Parse, fix corrupted lines, filter non-conversation entries
    for (const rawLine of rawLines) {
      const line = rawLine.trim();
      if (!line) continue;

      let objects: any[] = [];
      try {
        objects = [JSON.parse(line)];
      } catch {
        const parts = line.split(/(?<=\})\s*(?=\{)/);
        for (const part of parts) {
          try { objects.push(JSON.parse(part)); } catch { /* skip */ }
        }
        if (objects.length === 0) { totalRemoved++; continue; }
        if (objects.length > 1) {
          console.log(`[Sanitize] ${sessionId.slice(0, 8)}: split corrupted line into ${objects.length} objects`);
        }
      }

      for (const obj of objects) {
        const type = obj.type;
        if (type === 'queue-operation' || type === 'progress') { totalRemoved++; continue; }
        if (obj.isApiErrorMessage === true) { totalRemoved++; continue; }
        if (obj.message?.model === '<synthetic>') { totalRemoved++; continue; }
        cleanLines.push(JSON.stringify(obj));
      }
    }

    // Phase 2: Fix conversation structure — trim broken tail
    let cutIndex = cleanLines.length;
    let trailingUsers = 0;
    for (let i = cleanLines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(cleanLines[i]);
        const role = obj.message?.role;
        if (role === 'assistant') {
          const content = obj.message?.content;
          const hasContent = Array.isArray(content) ? content.length > 0 : !!content;
          if (hasContent) {
            cutIndex = i + 1 + trailingUsers;
            break;
          }
          continue;
        }
        if (role === 'user') {
          trailingUsers++;
          if (trailingUsers > 1) {
            cleanLines.splice(i, 1);
            totalRemoved++;
            trailingUsers--;
          }
          continue;
        }
      } catch { break; }
    }

    // Phase 3: Remove orphaned tool_result entries
    const finalClean: string[] = [];
    for (let i = 0; i < cutIndex && i < cleanLines.length; i++) {
      try {
        const obj = JSON.parse(cleanLines[i]);
        const role = obj.message?.role;
        const content = obj.message?.content;
        if (role === 'user' && Array.isArray(content) && content.length > 0 &&
            content.every((c: any) => c.type === 'tool_result')) {
          let prevAssistant: any = null;
          for (let j = finalClean.length - 1; j >= 0; j--) {
            try {
              const prev = JSON.parse(finalClean[j]);
              if (prev.message?.role === 'assistant') { prevAssistant = prev; break; }
            } catch { /* skip */ }
          }
          if (prevAssistant) {
            const prevContent = prevAssistant.message?.content;
            const toolUseIds = new Set<string>();
            if (Array.isArray(prevContent)) {
              for (const block of prevContent) {
                if (block.type === 'tool_use' && block.id) toolUseIds.add(block.id);
              }
            }
            const allMatched = content.every((c: any) => toolUseIds.has(c.tool_use_id));
            if (!allMatched) {
              totalRemoved++;
              console.log(`[Sanitize] ${sessionId.slice(0, 8)}: removed orphaned tool_result (refs: ${content.map((c: any) => c.tool_use_id?.slice(0, 12)).join(', ')})`);
              continue;
            }
          } else {
            totalRemoved++;
            continue;
          }
        }
        finalClean.push(cleanLines[i]);
      } catch {
        finalClean.push(cleanLines[i]);
      }
    }

    if (totalRemoved > 0) {
      writeFileSync(filePath, finalClean.join('\n') + '\n');
      clearMetaCache(filePath);
      console.log(`[Sanitize] ${sessionId.slice(0, 8)}: removed ${totalRemoved} entries (${rawLines.length}→${finalClean.length} lines)`);
    }
    sanitizeCache.set(sessionId, Date.now());
    return totalRemoved;
  } catch (err) {
    console.error(`[Sanitize] ${sessionId.slice(0, 8)}: error: ${(err as Error).message}`);
    sanitizeCache.set(sessionId, Date.now());
    return 0;
  }
}


// ---------------------------------------------------------------------------
// compactJsonlForResume — truncate large tool_results before --resume
// ---------------------------------------------------------------------------
// When a JSONL file is too large for Claude's context window, --resume triggers
// automatic context compression which can lose task-specific details ("amnesia").
// This proactively truncates oversized tool_result blocks to keep the conversation
// within context limits while preserving the full conversation structure.
//
// Strategy: check the RAW JSON LINE size (not parsed string length) because
// JSON escaping can expand strings 5-10x (e.g. 32KB parsed → 313KB serialized).
// Lines over MAX_LINE_SIZE get their tool_result content aggressively truncated.

const COMPACT_SIZE_THRESHOLD = 500 * 1024;  // 500KB — compact if JSONL exceeds this
const MAX_LINE_SIZE = 8 * 1024;             // 8KB — truncate any line exceeding this
const TRUNCATED_CONTENT_SIZE = 2 * 1024;    // 2KB — keep this much of truncated content

export function compactJsonlForResume(sessionId: string): { compacted: boolean; beforeSize: number; afterSize: number } {
  const filePath = findJsonlPath(sessionId);
  if (!filePath) return { compacted: false, beforeSize: 0, afterSize: 0 };

  try {
    const fileSize = statSync(filePath).size;
    if (fileSize <= COMPACT_SIZE_THRESHOLD) {
      return { compacted: false, beforeSize: fileSize, afterSize: fileSize };
    }

    // Size guard — refuse extremely large files
    if (fileSize > 50 * 1024 * 1024) {
      console.error(`[Compact] REFUSING ${sessionId.slice(0, 8)}: ${(fileSize / 1024 / 1024).toFixed(1)}MB exceeds 50MB limit`);
      return { compacted: false, beforeSize: fileSize, afterSize: fileSize };
    }

    const raw = readFileSync(filePath, 'utf-8');
    const lines = raw.split('\n');
    const compactedLines: string[] = [];
    let truncatedCount = 0;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      // Fast path: small lines pass through unchanged
      const lineBytes = Buffer.byteLength(line, 'utf-8');
      if (lineBytes <= MAX_LINE_SIZE) {
        compactedLines.push(line);
        continue;
      }

      // Large line — truncate tool_results and toolUseResult metadata
      try {
        const obj = JSON.parse(line);
        let modified = false;

        // 1. Strip toolUseResult (Claude Code metadata, not part of conversation)
        //    Contains duplicate of tool output + task metadata — safe to remove
        if (obj.toolUseResult && JSON.stringify(obj.toolUseResult).length > TRUNCATED_CONTENT_SIZE) {
          const desc = obj.toolUseResult?.task?.description || obj.toolUseResult?.retrieval_status || '';
          obj.toolUseResult = { _compacted: true, summary: typeof desc === 'string' ? desc.slice(0, 200) : '' };
          modified = true;
          truncatedCount++;
        }

        // 2. Truncate tool_result content in message.content array
        const role = obj.message?.role;
        const msgContent = obj.message?.content;

        if (role === 'user' && Array.isArray(msgContent)) {
          const compactedContent = msgContent.map((block: any) => {
            if (block.type !== 'tool_result') return block;

            const resultContent = block.content;
            // String content (Bash output, file reads, Agent results)
            if (typeof resultContent === 'string' && resultContent.length > TRUNCATED_CONTENT_SIZE) {
              modified = true;
              truncatedCount++;
              return {
                ...block,
                content: resultContent.slice(0, TRUNCATED_CONTENT_SIZE) +
                  '\n\n[... truncated for context management]',
              };
            }
            // Array content (text + image blocks)
            if (Array.isArray(resultContent)) {
              const serialized = JSON.stringify(resultContent);
              if (serialized.length > TRUNCATED_CONTENT_SIZE) {
                modified = true;
                truncatedCount++;
                const textParts = resultContent
                  .filter((c: any) => c.type === 'text')
                  .map((c: any) => c.text || '')
                  .join('\n');
                return {
                  ...block,
                  content: textParts.slice(0, TRUNCATED_CONTENT_SIZE) +
                    '\n\n[... truncated for context management]',
                };
              }
            }
            return block;
          });
          obj.message = { ...obj.message, content: compactedContent };
        }

        compactedLines.push(modified ? JSON.stringify(obj) : line);
      } catch {
        compactedLines.push(line); // Keep unparseable lines as-is
      }
    }

    if (truncatedCount === 0) {
      return { compacted: false, beforeSize: fileSize, afterSize: fileSize };
    }

    // Atomic write: backup original, then write compacted version
    const backupPath = filePath + '.pre-compact';
    writeFileSync(backupPath, raw);
    const compactedContent = compactedLines.join('\n') + '\n';
    writeFileSync(filePath, compactedContent);

    const afterSize = Buffer.byteLength(compactedContent, 'utf-8');
    console.log(`[Compact] ${sessionId.slice(0, 8)}: ${truncatedCount} tool_results truncated (${(fileSize / 1024).toFixed(0)}KB -> ${(afterSize / 1024).toFixed(0)}KB, backup at .pre-compact)`);

    return { compacted: true, beforeSize: fileSize, afterSize };
  } catch (err) {
    console.error(`[Compact] ${sessionId.slice(0, 8)}: error: ${(err as Error).message}`);
    return { compacted: false, beforeSize: 0, afterSize: 0 };
  }
}

// ---------------------------------------------------------------------------
// deepRepairJsonl — aggressive tail stripping for CLI-rejected sessions
// ---------------------------------------------------------------------------

export function deepRepairJsonl(sessionId: string): number {
  const filePath = findJsonlPath(sessionId);
  if (!filePath) return 0;
  try {
    const lines = readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim());
    if (lines.length < 2) return 0;

    let removed = 0;
    let cutAt = lines.length;
    let foundCleanAssistant = false;

    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        const role = obj.message?.role;

        if (role === 'assistant') {
          const content = obj.message?.content;
          const hasText = Array.isArray(content)
            ? content.some((c: any) => c.type === 'text' && c.text?.length > 0)
            : typeof content === 'string' && content.length > 0;
          if (hasText) {
            cutAt = i + 1;
            foundCleanAssistant = true;
            break;
          }
          const hasToolUse = Array.isArray(content)
            ? content.some((c: any) => c.type === 'tool_use')
            : false;
          if (hasToolUse) {
            cutAt = i + 1;
            foundCleanAssistant = true;
            break;
          }
        }
      } catch { /* skip unparseable */ }
    }

    if (!foundCleanAssistant) return 0;

    removed = lines.length - cutAt;
    if (removed > 0) {
      writeFileSync(filePath, lines.slice(0, cutAt).join('\n') + '\n');
      clearMetaCache(filePath);
      console.log(`[DeepRepair] ${sessionId.slice(0, 8)}: stripped ${removed} trailing entries (${lines.length}→${cutAt})`);
    }
    return removed;
  } catch (err) {
    console.error(`[DeepRepair] ${sessionId.slice(0, 8)}: error: ${(err as Error).message}`);
    return 0;
  }
}
