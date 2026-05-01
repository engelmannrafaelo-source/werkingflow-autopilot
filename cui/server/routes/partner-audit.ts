// =============================================================================
// Partner Audit Chat — read-only audit assistant for partner activity.
// =============================================================================
// Two operating modes:
//   1. NATIVE  — assembles context from local input-log/sync-log/sessions
//                and persists chat history on disk.
//   2. FORWARD — proxies all requests to the live partner-server CUI so the
//                LLM sees the partner's real input log + persistence lives
//                where the data lives.
//
// Endpoints:
//   GET  /api/partner-audit/session  → { messages, updated_at, mode }
//   POST /api/partner-audit/chat     → { response }   (also persists turn)
//   POST /api/partner-audit/reset    → clears history
// =============================================================================

import { Router } from 'express';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { join } from 'path';
import { bridgeChat } from '../lib/bridge-fetch.js';
import { getSessionStates } from './state.js';
import { isForwardMode, adminOrInternal, forwardToPartner } from '../lib/partner-forward.js';

const router = Router();

let DATA_DIR = '';
let PERSIST_PATH = '';

export function initPartnerAuditRouter(dataDir: string) {
  DATA_DIR = dataDir;
  PERSIST_PATH = join(dataDir, 'partner-audit-active.json');
}

const SYSTEM_PROMPT = `Du bist Rafaels Audit-Assistent. Beantworte Fragen zur Partner-Aktivität anhand der mitgegebenen API-Daten. Sei prägnant. Bei Unsicherheit sag das. Keine Spekulation, keine code-Vorschläge.

ANTWORT-FORMAT:
- Antworte direkt in Prosa. KEINE Speaker-Labels (kein "H:", "A:", "User:", "Assistant:").
- Erfinde NIE eine User-Antwort. Stoppe nach deiner Antwort. Kein Cliffhanger.`;

interface InputLogEntry {
  ts: string;
  type: string;
  accountId: string;
  workDir?: string;
  subject?: string;
  message: string;
  sessionId?: string;
  result: 'ok' | 'error';
  error?: string;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface PersistedAuditSession {
  messages: ChatMessage[];
  updated_at: number;
}

function loadRecentInputs(hours = 72): InputLogEntry[] {
  if (!DATA_DIR) return [];
  const path = join(DATA_DIR, 'input-log.jsonl');
  if (!existsSync(path)) return [];
  const fromMs = Date.now() - hours * 60 * 60 * 1000;
  try {
    return readFileSync(path, 'utf8')
      .trim().split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l) as InputLogEntry; } catch { return null; } })
      .filter((e): e is InputLogEntry => e !== null && new Date(e.ts).getTime() >= fromMs);
  } catch { return []; }
}

function readSyncLog(): string {
  const logPath = '/var/log/partner-sync.log';
  try {
    if (!existsSync(logPath)) return '(nicht vorhanden)';
    const lines = readFileSync(logPath, 'utf8').trim().split('\n');
    return lines.slice(-200).join('\n') || '(leer)';
  } catch (e: any) {
    return `(Lesefehler: ${e.message})`;
  }
}

function assembleContext(): string {
  const inputs = loadRecentInputs(72);
  const sessions = getSessionStates();
  const syncLog = readSyncLog();

  const parts: string[] = [];

  parts.push(`## Audit Inputs (letzte 72h, ${inputs.length} Einträge)`);
  if (inputs.length > 0) {
    const shown = inputs.slice(-100);
    parts.push(shown.map(e =>
      `[${e.ts}] account=${e.accountId} type=${e.type} workDir=${e.workDir || '-'}\n  ${(e.message || '').slice(0, 300)}`
    ).join('\n\n'));
  } else {
    parts.push('(keine Einträge)');
  }

  const sessionEntries = Object.entries(sessions);
  parts.push(`\n## Aktive Sessions (${sessionEntries.length})`);
  if (sessionEntries.length > 0) {
    parts.push(sessionEntries.map(([key, s]) =>
      `- key=${key.slice(0, 8)} account=${s.accountId} state=${s.state} since=${new Date(s.since).toISOString()}`
    ).join('\n'));
  } else {
    parts.push('(keine Sessions)');
  }

  parts.push(`\n## Partner-Sync Log (letzte 200 Zeilen)`);
  parts.push(syncLog);

  return parts.join('\n');
}

function readPersisted(): PersistedAuditSession {
  if (!PERSIST_PATH || !existsSync(PERSIST_PATH)) return { messages: [], updated_at: 0 };
  try {
    return JSON.parse(readFileSync(PERSIST_PATH, 'utf8')) as PersistedAuditSession;
  } catch {
    return { messages: [], updated_at: 0 };
  }
}

function writePersisted(messages: ChatMessage[]): void {
  if (!PERSIST_PATH) return;
  const data: PersistedAuditSession = { messages, updated_at: Date.now() };
  const tmp = PERSIST_PATH + '.tmp';
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  renameSync(tmp, PERSIST_PATH);
}

// --- Forward mode: proxy everything to partner-server ---
if (isForwardMode()) {
  router.use(adminOrInternal);
  router.use(forwardToPartner);
} else {
  router.use(adminOrInternal);

  // GET /session — restore persisted history on panel mount
  router.get('/session', (_req, res) => {
    const data = readPersisted();
    res.json(data);
  });

  // POST /reset — clear history
  router.post('/reset', (_req, res) => {
    writePersisted([]);
    res.json({ ok: true });
  });

  // POST /chat — append user msg, call LLM, append assistant, persist
  router.post('/chat', async (req, res) => {
    try {
      const { messages: incomingMessages } = req.body as { messages: ChatMessage[] };
      if (!incomingMessages || !Array.isArray(incomingMessages) || incomingMessages.length === 0) {
        res.status(400).json({ error: 'messages array required' });
        return;
      }

      const context = assembleContext();
      const systemWithContext = `${SYSTEM_PROMPT}\n\n---\n\n${context}`;

      console.log(`[PartnerAudit] /chat msgs=${incomingMessages.length} context_len=${systemWithContext.length}`);

      const response = await bridgeChat({
        model: 'claude-sonnet-4-6',
        messages: [
          { role: 'system', content: systemWithContext },
          ...incomingMessages,
        ],
        attribution: { appId: 'cui', agentId: 'partner-audit' },
      });

      // Persist the full new history (incoming includes the just-appended user msg)
      const newHistory: ChatMessage[] = [...incomingMessages, { role: 'assistant', content: response }];
      writePersisted(newHistory);

      res.json({ response });
    } catch (err: any) {
      console.error('[PartnerAudit] /chat error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });
}

// Frontend learns forward-state from the existing /api/partner-server/health
// endpoint (which already returns mode + forwardUrl). No separate /mode route
// needed here — would just be a no-op behind the forward-catchall anyway.

export default router;
