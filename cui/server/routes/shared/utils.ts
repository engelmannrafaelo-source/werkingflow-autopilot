/**
 * Shared utility functions for CUI server route modules.
 *
 * Extracted from mission.ts, autoinject.ts, team.ts, and agents.ts
 * to eliminate duplication.
 */

import { appendFileSync } from 'fs';
import { basename } from 'path';
import type { CuiProxy } from './types.js';

// ---------------------------------------------------------------------------
// logUserInput — appends a structured JSONL entry to the input log file.
// Previously duplicated in mission.ts and autoinject.ts.
// ---------------------------------------------------------------------------

export interface UserInputLogEntry {
  type: string;
  accountId: string;
  workDir?: string;
  subject?: string;
  message: string;
  sessionId?: string;
  result: 'ok' | 'error';
  error?: string;
}

/**
 * Append a user-input log entry (JSONL format) to the given file.
 *
 * @param inputLogFile  Absolute path to the JSONL log file.
 * @param entry         Structured log entry to persist.
 */
export function logUserInput(inputLogFile: string, entry: UserInputLogEntry): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  try {
    appendFileSync(inputLogFile, line + '\n');
  } catch (err) {
    console.warn('[SharedUtils] Failed to write input log:', err instanceof Error ? err.message : err);
  }
}

// ---------------------------------------------------------------------------
// getProxyPort — resolves an accountId to the corresponding proxy port.
// Previously duplicated in mission.ts and autoinject.ts.
// ---------------------------------------------------------------------------

/**
 * Look up the local proxy port for the given CUI account.
 *
 * @param proxies    Array of CUI proxy definitions.
 * @param accountId  Account identifier (e.g. 'rafael', 'engelmann').
 * @returns The local port number, or null if the account is unknown.
 */
export function getProxyPort(proxies: CuiProxy[], accountId: string): number | null {
  const proxy = proxies.find(p => p.id === accountId);
  return proxy?.localPort ?? null;
}

// ---------------------------------------------------------------------------
// parsePersonaMd — parses a persona markdown file into structured data.
// Previously triplicated across team.ts and agents.ts (two inline copies).
// The team.ts version is used as the canonical implementation because it
// covers Virtual Office metadata fields (Team, Department, Table, Governance,
// ReportsTo) that the agents.ts copies lack.
// ---------------------------------------------------------------------------

export interface ParsedPersona {
  id: string;
  name: string;
  role: string;
  mbti: string;
  status: string;
  worklistPath: string;
  lastUpdated: string;
  team: string;
  department: string;
  table: string;
  governance?: 'auto-commit' | 'review-required';
  reportsTo: string | null;
}

/**
 * Parse a persona markdown file into a structured object.
 *
 * Expects markdown with a header like `# Name - Role` and optional
 * metadata fields (**MBTI**, **Team**, **Department**, **Table**,
 * **Governance**, **ReportsTo**).
 *
 * @param filename  The markdown filename (e.g. 'max-weber.md').
 * @param content   The raw markdown content.
 * @returns Parsed persona data.
 */
export function parsePersonaMd(filename: string, content: string): ParsedPersona {
  // Extract ID from filename: 'max-weber.md' -> 'max'
  const id = basename(filename, '.md').split('-')[0];

  // Parse markdown for Name, Rolle, MBTI
  const nameMatch = content.match(/# (.+?) - (.+)/);
  const mbtiMatch = content.match(/\*\*MBTI\*\*:\s*(\w+)/i) || content.match(/MBTI:\s*(\w+)/i);

  // Parse Virtual Office Metadaten
  const teamMatch = content.match(/- \*\*Team\*\*:\s*(.+)/);
  const deptMatch = content.match(/- \*\*Department\*\*:\s*(.+)/);
  const tableMatch = content.match(/- \*\*Table\*\*:\s*(.+)/);
  const governanceMatch = content.match(/- \*\*Governance\*\*:\s*(.+)/);
  const reportsToMatch = content.match(/- \*\*ReportsTo\*\*:\s*(.+)/);

  return {
    id,
    name: nameMatch?.[1] || id,
    role: nameMatch?.[2] || 'Team Member',
    mbti: mbtiMatch?.[1] || 'XXXX',
    status: 'idle',
    worklistPath: `/root/projekte/orchestrator/team/worklists/${id}.md`,
    lastUpdated: new Date().toISOString(),
    team: teamMatch?.[1]?.trim() || 'unassigned',
    department: deptMatch?.[1]?.trim() || 'General',
    table: tableMatch?.[1]?.trim() || 'general',
    governance: governanceMatch?.[1]?.trim() as 'auto-commit' | 'review-required' | undefined,
    reportsTo: reportsToMatch?.[1]?.trim() || null,
  };
}
