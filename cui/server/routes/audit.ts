// =============================================================================
// User Input Audit Route — /api/audit/*
// =============================================================================
// Allows Rafael to query all user inputs in a time range, enriched with
// conversation metadata. "Was habe ich die letzten 2 Stunden angeschafft
// und wurde das auch umgesetzt?"

import { Router, type Request, type Response } from 'express';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { findJsonlPathAllAccounts, readConversationMessages, readJsonlMetadata } from './shared/jsonl.js';
import * as convMeta from './shared/conv-metadata.js';
import { ACCOUNT_CONFIG } from './claude-cli.js';

const router = Router();

// --- Dependencies (injected via init) ---
let DATA_DIR = '';
let INPUT_LOG_FILE = '';

export function initAuditRouter(dataDir: string) {
  DATA_DIR = dataDir;
  INPUT_LOG_FILE = join(dataDir, 'input-log.jsonl');
  convMeta.init(dataDir);
}

// --- Types ---

interface InputLogEntry {
  ts: string;
  type: string;          // "start" | "send" | "send-piped" | "auto-inject"
  accountId: string;
  workDir?: string;
  subject?: string;
  message: string;
  sessionId?: string;
  result: 'ok' | 'error';
  error?: string;
}

interface EnrichedEntry extends InputLogEntry {
  convTitle?: string;
  convStatus?: 'ongoing' | 'finished';
  convSummary?: string;
  convMessageCount?: number;
}

// --- Cache ---
let _cache: { entries: InputLogEntry[]; mtimeMs: number } | null = null;

function loadInputLog(): InputLogEntry[] {
  if (!existsSync(INPUT_LOG_FILE)) return [];

  // Use mtime cache to avoid re-reading unchanged file
  try {
    const { mtimeMs } = require('fs').statSync(INPUT_LOG_FILE);
    if (_cache && _cache.mtimeMs === mtimeMs) return _cache.entries;
  } catch { /* proceed to full read */ }

  try {
    const lines = readFileSync(INPUT_LOG_FILE, 'utf8').trim().split('\n').filter(Boolean);
    const entries: InputLogEntry[] = [];
    for (const line of lines) {
      try { entries.push(JSON.parse(line)); } catch { /* skip corrupt */ }
    }
    try {
      const { mtimeMs } = require('fs').statSync(INPUT_LOG_FILE);
      _cache = { entries, mtimeMs };
    } catch { /* no cache */ }
    return entries;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// GET /api/audit/inputs — query user inputs with time filter
// ---------------------------------------------------------------------------
// Query params:
//   hours=2       — last N hours (default: 2)
//   from=ISO      — explicit start timestamp
//   to=ISO        — explicit end timestamp
//   account=...   — filter by accountId
//   type=...      — filter by type (start|send|send-piped)
//   enrich=true   — include conversation metadata (default: true)

router.get('/inputs', (req: Request, res: Response) => {
  try {
    const allEntries = loadInputLog();
    if (allEntries.length === 0) {
      res.json({ entries: [], total: 0, timeRange: { from: null, to: null } });
      return;
    }

    // --- Time filtering ---
    const now = Date.now();
    let fromMs: number;
    let toMs: number = now;

    if (req.query.from) {
      fromMs = new Date(req.query.from as string).getTime();
    } else {
      const hours = parseFloat(req.query.hours as string) || 2;
      fromMs = now - hours * 60 * 60 * 1000;
    }
    if (req.query.to) {
      toMs = new Date(req.query.to as string).getTime();
    }

    // --- Filter entries ---
    let filtered = allEntries.filter(e => {
      const entryMs = new Date(e.ts).getTime();
      return entryMs >= fromMs && entryMs <= toMs;
    });

    // Account filter
    if (req.query.account) {
      const acc = req.query.account as string;
      filtered = filtered.filter(e => e.accountId === acc);
    }

    // Type filter
    if (req.query.type) {
      const t = req.query.type as string;
      filtered = filtered.filter(e => e.type === t);
    }

    // --- Enrichment (default on) ---
    const shouldEnrich = req.query.enrich !== 'false';
    let enriched: EnrichedEntry[];

    if (shouldEnrich) {
      const titles = convMeta.getAllTitles();
      const finished = convMeta.getAllFinished();

      enriched = filtered.map(entry => {
        const result: EnrichedEntry = { ...entry };
        if (!entry.sessionId) return result;

        result.convTitle = titles[entry.sessionId] || undefined;
        result.convStatus = finished[entry.sessionId] ? 'finished' : 'ongoing';

        // Get conversation metadata for summary + message count
        const found = findJsonlPathAllAccounts(entry.sessionId);
        if (found) {
          const meta = readJsonlMetadata(found.path);
          if (meta) {
            result.convSummary = meta.summary || undefined;
            result.convMessageCount = meta.messageCount;
          }
        }

        return result;
      });
    } else {
      enriched = filtered;
    }

    // Sort by timestamp descending (newest first)
    enriched.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());

    res.json({
      entries: enriched,
      total: enriched.length,
      totalInLog: allEntries.length,
      timeRange: {
        from: new Date(fromMs).toISOString(),
        to: new Date(toMs).toISOString(),
        hours: ((toMs - fromMs) / (60 * 60 * 1000)).toFixed(1),
      },
    });
  } catch (err: any) {
    console.error('[Audit] inputs error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/audit/inputs/:sessionId/context — get conversation context for a session
// ---------------------------------------------------------------------------
// Returns the last N messages from the conversation for verification

router.get('/inputs/:sessionId/context', (req: Request, res: Response) => {
  try {
    const sessionId = req.params.sessionId as string;
    const tail = Math.min(parseInt(req.query.tail as string) || 20, 100);

    const found = findJsonlPathAllAccounts(sessionId);
    if (!found) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }

    const { messages, summary } = readConversationMessages(found.path);
    const recentMessages = messages.slice(-tail);

    // Extract only the text content for readability
    const simplified = recentMessages.map(m => {
      let text = '';
      if (typeof m.message.content === 'string') {
        text = m.message.content;
      } else if (Array.isArray(m.message.content)) {
        text = m.message.content
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text || '')
          .join('\n');
      }
      return {
        role: m.message.role,
        text,
        timestamp: m.timestamp,
      };
    });

    const title = convMeta.getTitle(sessionId);
    const isFinished = convMeta.isFinished(sessionId);

    res.json({
      sessionId,
      title: title || summary || '(no title)',
      status: isFinished ? 'finished' : 'ongoing',
      accountId: found.accountId,
      totalMessages: messages.length,
      showing: simplified.length,
      messages: simplified,
    });
  } catch (err: any) {
    console.error('[Audit] context error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/audit/summary — aggregate stats for the given time range
// ---------------------------------------------------------------------------

router.get('/summary', (req: Request, res: Response) => {
  try {
    const allEntries = loadInputLog();
    const now = Date.now();
    const hours = parseFloat(req.query.hours as string) || 24;
    const fromMs = now - hours * 60 * 60 * 1000;

    const recent = allEntries.filter(e => new Date(e.ts).getTime() >= fromMs);

    // Group by session
    const sessionMap = new Map<string, InputLogEntry[]>();
    for (const e of recent) {
      const sid = e.sessionId || '__no_session__';
      if (!sessionMap.has(sid)) sessionMap.set(sid, []);
      sessionMap.get(sid)!.push(e);
    }

    // Group by account
    const accountMap = new Map<string, number>();
    for (const e of recent) {
      accountMap.set(e.accountId, (accountMap.get(e.accountId) || 0) + 1);
    }

    // Group by type
    const typeMap = new Map<string, number>();
    for (const e of recent) {
      typeMap.set(e.type, (typeMap.get(e.type) || 0) + 1);
    }

    // Errors
    const errors = recent.filter(e => e.result === 'error');

    res.json({
      hours,
      totalInputs: recent.length,
      totalSessions: sessionMap.size,
      byAccount: Object.fromEntries(accountMap),
      byType: Object.fromEntries(typeMap),
      errorCount: errors.length,
      errors: errors.slice(0, 10), // Last 10 errors
    });
  } catch (err: any) {
    console.error('[Audit] summary error:', err.message);
    res.status(500).json({ error: err.message });
  }
});



// ---------------------------------------------------------------------------
// stripSystemContext - remove auto-injected CUI system blocks from user text
// ---------------------------------------------------------------------------
function stripSystemContext(text: string): string {
  let s = text;

  // Bracket blocks
  s = s.replace(/\[KONTEXT:[^\]]*\]/g, '');
  s = s.replace(/\[PEERS:[^\]]*\]/g, '');
  s = s.replace(/\[TEAM\]/g, '');

  // Team Context blocks (multi-line)
  s = s.replace(/# Team Context \(auto-updated\)[\s\S]*?(?=\n(?![#_*\-\s])|$)/gm, '');
  s = s.replace(/_Stand:[^_]*_/g, '');
  s = s.replace(/## Freshness[\s\S]*?(?=\n(?:## (?!Freshness)|[^#\-\s*_\n])|$)/gm, '');
  s = s.replace(/## Leader Status[\s\S]*?(?=\n(?:## (?!Leader)|[^#*\-\s_\n])|$)/gm, '');
  s = s.replace(/### Stale Docs[\s\S]*?(?=\n##|\n[^#\-\s*_\n]|$)/gm, '');
  s = s.replace(/^\*\*(max|herbert|vera|finn|felix)\*\*:.*$/gm, '');

  // Hook output
  s = s.replace(/^Run:.*$/gm, '');
  s = s.replace(/^FRESHNESS WARNING:.*$/gm, '');
  s = s.replace(/^- STALE WORKLIST:.*$/gm, '');
  s = s.replace(/^- HIGH UNCOMMITTED:.*$/gm, '');
  s = s.replace(/<user-prompt-submit-hook>[\s\S]*?<\/user-prompt-submit-hook>/g, '');
  s = s.replace(/^SessionStart:compact hook.*$/gm, '');

  // Hook file lists
  s = s.replace(/^- (?:business|team|data|config|deploy|docs|bin|lib|scripts|templates)\/[^\n]*$/gm, '');
  s = s.replace(/^---$/gm, '');

  // Continuation summaries (entire block)
  s = s.replace(/This session is being continued from a previous conversation[\s\S]*/g, '');

  // Image metadata lines
  s = s.replace(/^\[Image: original \d+x\d+[^\]]*\]\.?$/gm, '');

  // Sync feedback
  s = s.replace(/^\[Sync-Feedback[^\]]*\].*$/gm, '');
  s = s.replace(/^\[Sync-Update[^\]]*\].*$/gm, '');

  // Skill command headers at end
  s = s.replace(/\n#\s*\/\w+:\w+\s*[-\u2014].*$/g, '');

  // Other auto-patterns
  s = s.replace(/^If you need specific details from before compaction.*$/gm, '');
  s = s.replace(/^Please continue the conversation from where we left off.*$/gm, '');
  s = s.replace(/^Please read the full transcript at:.*$/gm, '');

  // Clean up whitespace
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

// ---------------------------------------------------------------------------
// isRealUserInput - skip entire messages that are auto-generated
// ---------------------------------------------------------------------------
function isRealUserInput(text: string): boolean {
  const t = text.trim();
  if (!t || t.length < 3) return false;

  // Mission briefings (structured task from CUI mission/start)
  if (/^##\s+\S.*\n\n\*\*(Ziel|Context|Kontext|Goal|Aufgabe):\*\*/s.test(t)) return false;

  // Sync feedback
  if (t.startsWith('[Sync-Feedback')) return false;
  if (t.startsWith('[Sync-Update')) return false;

  // System tags
  if (t.startsWith('<task-notification>')) return false;
  if (t.startsWith('<system-reminder>')) return false;
  if (t.startsWith('<session-context>')) return false;
  if (t.startsWith('<user-prompt-submit-hook>')) return false;

  // Auto-continue
  if (t.startsWith('Continue from where you left off')) return false;
  if (t.startsWith('This session is being continued')) return false;
  if (t === 'Continue') return false;
  if (/^Continue\s*[-\u2014]\s*/.test(t)) return false;

  // Pure skill invocations
  if (/^#\s*\/\w+:\w+\s*[-\u2014]/.test(t)) return false;

  // Pure image metadata
  if (/^\[Image: original \d+x\d+/.test(t)) return false;

  // SessionStart hook
  if (t.startsWith('SessionStart:')) return false;

  // Pure file lists from hooks
  const lines = t.split('\n').map(l => l.trim()).filter(l => l);
  if (lines.length > 0 && lines.every(l =>
    /^[-*]\s+(?:business|team|data|config|deploy|docs|bin|lib|scripts|templates)\//.test(l) ||
    l === '---'
  )) return false;

  return true;
}

// ---------------------------------------------------------------------------
// GET /api/audit/extract — scan ALL JSONL files, extract user inputs to /tmp
// ---------------------------------------------------------------------------
// Scans all conversation JSONL files across all accounts/projects.
// Extracts only user text messages, writes one file per conversation to /tmp.
// Returns file paths so Claude can read them directly.
//
// Query params:
//   hours=24      — last N hours (default: 24)
//   from=ISO      — explicit start timestamp
//   to=ISO        — explicit end timestamp
//   account=...   — filter by accountId (optional)
//   project=...   — filter by project dir name (optional, substring match)

router.get('/extract', (req: Request, res: Response) => {
  try {
    const now = Date.now();
    let fromMs: number;
    let toMs: number = now;

    if (req.query.from) {
      fromMs = new Date(req.query.from as string).getTime();
    } else {
      const hours = parseFloat(req.query.hours as string) || 24;
      fromMs = now - hours * 60 * 60 * 1000;
    }
    if (req.query.to) {
      toMs = new Date(req.query.to as string).getTime();
    }

    const accountFilter = req.query.account as string | undefined;
    const projectFilter = req.query.project as string | undefined;

    // Scan all JSONL files across all accounts
    const results: Array<{
      sessionId: string;
      accountId: string;
      project: string;
      filePath: string;
      inputCount: number;
      timeRange: { first: string; last: string };
    }> = [];

    const outDir = '/tmp/cui-audit';
    mkdirSync(outDir, { recursive: true });

    for (const acc of ACCOUNT_CONFIG) {
      if (accountFilter && acc.id !== accountFilter) continue;

      const projDir = join(acc.home, '.claude', 'projects');
      try { if (!statSync(projDir).isDirectory()) continue; } catch { continue; }

      for (const dirname of readdirSync(projDir)) {
        if (projectFilter && !dirname.toLowerCase().includes(projectFilter.toLowerCase())) continue;

        const dirPath = join(projDir, dirname);
        try { if (!statSync(dirPath).isDirectory()) continue; } catch { continue; }

        let jsonlFiles: string[];
        try {
          jsonlFiles = readdirSync(dirPath).filter(f => f.endsWith('.jsonl'));
        } catch { continue; }

        for (const jsonlFile of jsonlFiles) {
          const filePath = join(dirPath, jsonlFile);
          const sessionId = jsonlFile.replace('.jsonl', '');

          // Quick mtime check — skip files not modified in time range
          try {
            const fstat = statSync(filePath);
            if (fstat.mtimeMs < fromMs) continue;
            // Skip tiny files (< 1KB = empty/test conversations)
            if (fstat.size < 1024) continue;
          } catch { continue; }

          // Parse JSONL — extract only user text messages in time range
          let rawContent: string;
          try { rawContent = readFileSync(filePath, 'utf8'); } catch { continue; }

          const lines = rawContent.split('\n').filter(l => l.trim());
          const userInputs: Array<{ ts: string; text: string }> = [];

          for (const line of lines) {
            try {
              const obj = JSON.parse(line);
              if (obj.type !== 'user') continue;

              const ts = obj.timestamp || '';
              if (ts) {
                const entryMs = new Date(ts).getTime();
                if (entryMs < fromMs || entryMs > toMs) continue;
              }

              // Extract text content
              let text = '';
              const content = obj.message?.content;
              if (typeof content === 'string') {
                text = content;
              } else if (Array.isArray(content)) {
                text = content
                  .filter((b: any) => b.type === 'text')
                  .map((b: any) => b.text || '')
                  .join(' ');
              }

              // Skip system messages, hooks, empty
              if (!text) continue;
              if (text.startsWith('<task-notification>')) continue;
              if (text.startsWith('<system-reminder>')) continue;
              if (text.startsWith('<session-context>')) continue;
              if (text.startsWith('Continue from where you left off')) continue;
              if (text.startsWith('This session is being continued')) continue;
              if (text.startsWith('Continue - ') && text.includes('fasse zusammen')) continue;
              if (text.startsWith('Continue')) continue;
              if (text.length < 3) continue;

              // Skip entire auto-generated messages
              if (!isRealUserInput(text)) continue;
              // Strip remaining system noise from mixed messages
              const cleanText = stripSystemContext(text);
              if (!cleanText || cleanText.length < 3) continue;
              userInputs.push({ ts, text: cleanText });
            } catch { /* skip corrupt */ }
          }

          if (userInputs.length === 0) continue;

          // Dedup: skip if already extracted from another account
          if (results.some(r => r.sessionId === sessionId)) continue;

          // Write to /tmp/cui-audit/{sessionId-short}_{project}.txt
          const projectShort = dirname.replace(/-/g, '_').slice(0, 40);
          const outFile = join(outDir, `${sessionId.slice(0, 8)}_${projectShort}.txt`);

          const fileContent = [
            `# Session: ${sessionId}`,
            `# Account: ${acc.id}`,
            `# Project: ${dirname}`,
            `# Inputs: ${userInputs.length}`,
            `# Time: ${userInputs[0].ts} — ${userInputs[userInputs.length - 1].ts}`,
            '',
            ...userInputs.map(i => `[${i.ts.slice(0, 16)}] ${i.text}`),
            '',
          ].join('\n');

          writeFileSync(outFile, fileContent, 'utf8');

          results.push({
            sessionId,
            accountId: acc.id,
            project: dirname,
            filePath: outFile,
            inputCount: userInputs.length,
            timeRange: {
              first: userInputs[0].ts,
              last: userInputs[userInputs.length - 1].ts,
            },
          });
        }
      }
    }

    // Sort by input count descending
    results.sort((a, b) => b.inputCount - a.inputCount);

    res.json({
      extracted: results.length,
      totalInputs: results.reduce((sum, r) => sum + r.inputCount, 0),
      outputDir: outDir,
      timeRange: {
        from: new Date(fromMs).toISOString(),
        to: new Date(toMs).toISOString(),
        hours: ((toMs - fromMs) / (60 * 60 * 1000)).toFixed(1),
      },
      files: results,
    });
  } catch (err: any) {
    console.error('[Audit] extract error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
