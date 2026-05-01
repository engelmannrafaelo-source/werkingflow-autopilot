// =============================================================================
// Partner Audit Chat — read-only audit assistant for partner activity
// =============================================================================
// POST /api/partner-audit/chat  { messages: [...] } → { response: string }
// Context assembled fresh per request:
//   - input-log.jsonl last 72h (all user inputs)
//   - getSessionStates() (active sessions)
//   - /var/log/partner-sync.log last 200 lines
// =============================================================================

import { Router } from 'express';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { bridgeChat } from '../lib/bridge-fetch.js';
import { getSessionStates } from './state.js';

const router = Router();

let DATA_DIR = '';

export function initPartnerAuditRouter(dataDir: string) {
  DATA_DIR = dataDir;
}

const SYSTEM_PROMPT = `Du bist Rafaels Audit-Assistent. Beantworte Fragen zur Partner-Aktivität anhand der mitgegebenen API-Daten. Sei prägnant. Bei Unsicherheit sag das. Keine Spekulation, keine code-Vorschläge.`;

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

// POST /chat
router.post('/chat', async (req, res) => {
  try {
    const { messages } = req.body as { messages: Array<{ role: string; content: string }> };
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({ error: 'messages array required' });
      return;
    }

    const context = assembleContext();
    const systemWithContext = `${SYSTEM_PROMPT}\n\n---\n\n${context}`;

    console.log(`[PartnerAudit] /chat msgs=${messages.length} context_len=${systemWithContext.length}`);

    const response = await bridgeChat({
      model: 'claude-sonnet-4-6',
      messages: [
        { role: 'system', content: systemWithContext },
        ...messages,
      ],
      attribution: { appId: 'cui', agentId: 'partner-audit' },
    });

    res.json({ response });
  } catch (err: any) {
    console.error('[PartnerAudit] /chat error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
