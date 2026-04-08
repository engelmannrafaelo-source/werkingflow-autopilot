/**
 * Session and conversation storage for the Gemini adapter.
 *
 * - sessions.json: Index of all sessions with metadata
 * - conversations/{sessionId}.jsonl: Message history per session (Claude-compatible format)
 *
 * Mirrors the JSONL format Claude Code uses so the CUI dashboard can display
 * Gemini conversations identically to Claude conversations.
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

import type { ClaudeMessage } from './translator.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SessionInfo {
  sessionId: string;
  geminiSessionId: string | null;  // Gemini's internal session ID (for --resume)
  createdAt: string;
  updatedAt: string;
  workingDirectory: string;
  model: string;
  messageCount: number;
  summary: string;
  status: 'ongoing' | 'completed';
}

interface SessionIndex {
  sessions: Record<string, SessionInfo>;
}

// ─── Config ───────────────────────────────────────────────────────────────────

const DATA_DIR = process.env.GEMINI_DATA_DIR || join(dirname(new URL(import.meta.url).pathname), '..', 'data');
const SESSIONS_FILE = join(DATA_DIR, 'sessions.json');
const CONVERSATIONS_DIR = join(DATA_DIR, 'conversations');

// Ensure directories exist
mkdirSync(CONVERSATIONS_DIR, { recursive: true });

// ─── Session Index ────────────────────────────────────────────────────────────

function loadIndex(): SessionIndex {
  if (!existsSync(SESSIONS_FILE)) {
    return { sessions: {} };
  }
  try {
    return JSON.parse(readFileSync(SESSIONS_FILE, 'utf-8'));
  } catch (err) {
    console.error(`[Store] Failed to parse ${SESSIONS_FILE}: ${err}`);
    return { sessions: {} };
  }
}

function saveIndex(index: SessionIndex): void {
  writeFileSync(SESSIONS_FILE, JSON.stringify(index, null, 2));
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function createSession(opts: {
  sessionId: string;
  workingDirectory: string;
  model: string;
  initialPrompt: string;
}): SessionInfo {
  const now = new Date().toISOString();
  const info: SessionInfo = {
    sessionId: opts.sessionId,
    geminiSessionId: null,
    createdAt: now,
    updatedAt: now,
    workingDirectory: opts.workingDirectory,
    model: opts.model,
    messageCount: 0,
    summary: opts.initialPrompt.slice(0, 200),
    status: 'ongoing',
  };

  const index = loadIndex();
  index.sessions[opts.sessionId] = info;
  saveIndex(index);

  return info;
}

export function updateSession(sessionId: string, updates: Partial<SessionInfo>): void {
  const index = loadIndex();
  const session = index.sessions[sessionId];
  if (!session) {
    console.warn(`[Store] updateSession: session ${sessionId} not found`);
    return;
  }

  Object.assign(session, updates, { updatedAt: new Date().toISOString() });
  saveIndex(index);
}

export function getSession(sessionId: string): SessionInfo | null {
  const index = loadIndex();
  return index.sessions[sessionId] ?? null;
}

export function listSessions(opts: {
  limit?: number;
  sortBy?: 'updated' | 'created';
  order?: 'asc' | 'desc';
} = {}): { conversations: SessionInfo[]; total: number } {
  const index = loadIndex();
  const all = Object.values(index.sessions);

  const sortField = opts.sortBy === 'created' ? 'createdAt' : 'updatedAt';
  const dir = opts.order === 'asc' ? 1 : -1;

  all.sort((a, b) => dir * a[sortField].localeCompare(b[sortField]));

  const limit = opts.limit ?? 500;
  return {
    conversations: all.slice(0, limit),
    total: all.length,
  };
}

// ─── JSONL Conversation Storage ───────────────────────────────────────────────

function jsonlPath(sessionId: string): string {
  return join(CONVERSATIONS_DIR, `${sessionId}.jsonl`);
}

export function appendMessage(sessionId: string, entry: ClaudeMessage): void {
  const path = jsonlPath(sessionId);
  appendFileSync(path, JSON.stringify(entry) + '\n');

  // Update message count
  const index = loadIndex();
  const session = index.sessions[sessionId];
  if (session) {
    session.messageCount++;
    session.updatedAt = new Date().toISOString();
    saveIndex(index);
  }
}

export function getMessages(sessionId: string, opts?: { tail?: number }): ClaudeMessage[] {
  const path = jsonlPath(sessionId);
  if (!existsSync(path)) return [];

  const lines = readFileSync(path, 'utf-8').split('\n').filter(Boolean);
  const messages: ClaudeMessage[] = [];

  for (const line of lines) {
    try {
      messages.push(JSON.parse(line));
    } catch {
      console.warn(`[Store] Skipping corrupt JSONL line in ${sessionId}`);
    }
  }

  if (opts?.tail && messages.length > opts.tail) {
    return messages.slice(-opts.tail);
  }

  return messages;
}

/**
 * Store a user prompt as a message entry in JSONL.
 */
export function appendUserPrompt(sessionId: string, prompt: string): void {
  const entry: ClaudeMessage = {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: prompt }],
    },
    timestamp: new Date().toISOString(),
  };
  appendMessage(sessionId, entry);
}

/**
 * Map a SessionInfo to the conversation list format CUI server expects.
 */
export function sessionToConversationEntry(session: SessionInfo, streamingId?: string): Record<string, unknown> {
  return {
    sessionId: session.sessionId,
    summary: session.summary,
    customName: null,
    status: session.status,
    streamingId: streamingId ?? null,
    model: session.model,
    messageCount: session.messageCount,
    updatedAt: session.updatedAt,
    createdAt: session.createdAt,
    projectPath: session.workingDirectory,
    projectName: session.workingDirectory.split('/').pop() ?? '',
    accountId: 'gemini',
    accountLabel: 'Gemini',
    accountColor: '#4285F4',
  };
}
