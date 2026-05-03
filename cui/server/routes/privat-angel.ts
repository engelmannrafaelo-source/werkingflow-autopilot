// =============================================================================
// Privat Angel — Personal Coach Chat (Klon vom Business Angel)
// =============================================================================
// Unterschiede zum Business Angel:
// - Arbeitet auf /root/orchestrator/workspaces/privat/ statt werkingflow-business
// - Auto-Load: Heutiger Tagebuch-Eintrag + Rolling Window letzte 7 Tage
// - Inbox-Ordner statt temp_ordner (semantisch derselbe Slot)
// - System-Prompt: persoenlicher Coach statt strategischer Berater
// =============================================================================
//
// GET  /api/privat-angel/context     → YAML config + token estimates
// GET  /api/privat-angel/files       → file tree of privat dir
// POST /api/privat-angel/load        → assemble context, create session
// POST /api/privat-angel/chat        → send message, maintain history
// POST /api/privat-angel/apply-diffs → validate + backup + apply diffs
// =============================================================================

import { Router } from 'express';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, renameSync } from 'fs';
import { randomUUID, createHash } from 'crypto';
import { join, basename, dirname, relative } from 'path';
import { load as yamlLoad } from 'js-yaml';
import { parseDiffs } from '../lib/diff-parser.js';
import { autoApplyNewFiles, summarizeApplyResult } from '../lib/auto-apply-new.js';
import { bridgeChat } from '../lib/bridge-fetch.js';

const router = Router();

// --- Constants ---
const PRIVAT_DIR   = process.env.CUI_PRIVAT_DIR || '/root/orchestrator/workspaces/privat';
const CONTEXT_YAML = '/root/projekte/local-storage/report-builder/privat-angel-context.yaml';
const BACKUP_DIR   = '/root/projekte/local-storage/report-builder/privat-backups';
const INBOX_DIR    = join(PRIVAT_DIR, 'inbox');
const TAGEBUCH_DIR = join(PRIVAT_DIR, 'tagebuch');
const SNAPSHOT_DIR = '/root/projekte/local-storage/cui/snapshots-privat';

const ACTIVE_SESSION_PATH = '/root/projekte/local-storage/report-builder/privat-angel-active.json';
const SESSION_LOG_DIR     = '/root/projekte/local-storage/report-builder/privat-angel-logs';

const CHARS_PER_TOKEN = 4;
const SYSTEM_PROMPT_TOKEN_LIMIT = 180000;
const TAGEBUCH_ROLLING_DAYS_DEFAULT = 7;

// --- Session Store ---
interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface ChatSession {
  session_id: string;
  system_prompt: string;
  context_message: string;        // First user message (with <documents>) — IMMUTABLE after session start
  manifest: Record<string, string>; // filename -> sha256 of file content at session start
  history: ChatMessage[];
  created_at: number;
  token_count: number;
  files_loaded: number;
  inbox_files: string[];
  tagebuch_files: string[];
  zusatz_loaded: string[];
}

interface PersistedSession {
  session_id: string;
  title: string;
  created_at: number;
  updated_at: number;
  token_count: number;
  files_loaded: number;
  inbox_files: string[];
  tagebuch_files: string[];
  zusatz_loaded: string[];
  context_message?: string;       // Migrated lazily — old sessions rebuild on first restore
  manifest?: Record<string, string>;
  conversation: ChatMessage[];
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

const SESSION_STORE = new Map<string, ChatSession>();

function readPersistedSession(): PersistedSession | null {
  try {
    if (!existsSync(ACTIVE_SESSION_PATH)) return null;
    const raw = readFileSync(ACTIVE_SESSION_PATH, 'utf-8');
    if (!raw.trim()) return null;
    return JSON.parse(raw) as PersistedSession;
  } catch { return null; }
}

function deriveSessionTitle(conversation: ChatMessage[]): string {
  const firstUserMsg = conversation.find(m => m.role === 'user');
  if (!firstUserMsg) return 'Neue Session';
  const raw = firstUserMsg.content.replace(/\n/g, ' ').trim();
  return raw.length > 60 ? raw.slice(0, 57) + '…' : raw;
}

function writePersistedSession(session: ChatSession): void {
  const conversation = session.history.slice(2);
  const data: PersistedSession = {
    session_id: session.session_id,
    title: deriveSessionTitle(conversation),
    created_at: session.created_at,
    updated_at: Date.now(),
    token_count: session.token_count,
    files_loaded: session.files_loaded,
    inbox_files: session.inbox_files,
    tagebuch_files: session.tagebuch_files,
    zusatz_loaded: session.zusatz_loaded,
    context_message: session.context_message,
    manifest: session.manifest,
    conversation,
  };
  writeFileSync(ACTIVE_SESSION_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

function archiveSession(session: PersistedSession): void {
  try {
    mkdirSync(SESSION_LOG_DIR, { recursive: true });
    const date = new Date(session.created_at).toISOString().slice(0, 10);
    const logPath = join(SESSION_LOG_DIR, `session-${date}-${session.session_id.slice(0, 8)}.json`);
    writeFileSync(logPath, JSON.stringify(session, null, 2), 'utf-8');
    if (existsSync(ACTIVE_SESSION_PATH)) {
      writeFileSync(ACTIVE_SESSION_PATH, '', 'utf-8');
    }
  } catch (err: any) {
    console.error('[PrivatAngel] Archive failed:', err.message);
  }
}

// --- Types ---
interface ContextYaml {
  kern_files: string[];
  zusatz_kategorien: Record<string, string[]>;
  inbox_ordner?: string;
  tagebuch_root?: string;
  tagebuch_rolling_days?: number;
}

interface FileTokenInfo {
  path: string;
  exists: boolean;
  tokens: number;
}

interface KategorieInfo {
  files: FileTokenInfo[];
  totalTokens: number;
}

interface TreeFile {
  type: 'file';
  name: string;
  path: string;
  tokens: number;
  is_kern: boolean;
}

interface TreeDir {
  type: 'dir';
  name: string;
  path: string;
  children: TreeNode[];
  totalTokens: number;
}

type TreeNode = TreeFile | TreeDir;

// --- Helpers ---
function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function readFileTokenInfo(relativePath: string): FileTokenInfo {
  const absPath = join(PRIVAT_DIR, relativePath);
  if (!existsSync(absPath)) {
    return { path: relativePath, exists: false, tokens: 0 };
  }
  const content = readFileSync(absPath, 'utf-8');
  return { path: relativePath, exists: true, tokens: estimateTokens(content) };
}

function readFileContent(relativePath: string): string | null {
  const absPath = join(PRIVAT_DIR, relativePath);
  if (!existsSync(absPath)) return null;
  return readFileSync(absPath, 'utf-8');
}

function readInboxFiles(inboxDir: string): Array<{ name: string; content: string }> {
  if (!existsSync(inboxDir)) return [];
  const files: Array<{ name: string; content: string }> = [];
  for (const entry of readdirSync(inboxDir)) {
    if (/\.(html|log|png|jpg|jpeg|gif|webp|mp3|wav|m4a)$/i.test(entry)) continue;
    if (/^readme/i.test(entry)) continue;
    const fullPath = join(inboxDir, entry);
    try {
      const stat = statSync(fullPath);
      if (!stat.isFile()) continue;
      files.push({ name: entry, content: readFileSync(fullPath, 'utf-8') });
    } catch { /* skip */ }
  }
  return files;
}

/**
 * Find the last N days of diary entries.
 * Path structure: tagebuch/YYYY-MM/YYYY-MM-DD.md
 * Returns oldest-first so chat sees chronological order.
 */
function readRecentDiary(days: number): Array<{ date: string; name: string; content: string }> {
  const result: Array<{ date: string; name: string; content: string }> = [];
  if (!existsSync(TAGEBUCH_DIR)) return result;

  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    const yyyy = d.getFullYear();
    const mm   = String(d.getMonth() + 1).padStart(2, '0');
    const dd   = String(d.getDate()).padStart(2, '0');
    const monthDir = `${yyyy}-${mm}`;
    const fileName = `${yyyy}-${mm}-${dd}.md`;
    const absPath  = join(TAGEBUCH_DIR, monthDir, fileName);
    if (!existsSync(absPath)) continue;
    try {
      const content = readFileSync(absPath, 'utf-8');
      result.push({ date: `${yyyy}-${mm}-${dd}`, name: `tagebuch/${monthDir}/${fileName}`, content });
    } catch { /* skip */ }
  }
  return result;
}

const SKIP_DIR = /^(_archive|archive|archiv|_archiv|reports|_reports|inbox|ashtanga-images)$/i;
const SKIP_FILE_EXT = /\.(html|log|png|jpg|jpeg|gif|webp|mp3|wav|m4a)$/i;
const SKIP_FILE_NAME = /^(readme|CLAUDE)/i;

function renderFileTreeText(absBase: string, relDir: string, indent: number = 0): string {
  const fullDir = join(absBase, relDir);
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(fullDir, { withFileTypes: true });
  } catch { return ''; }

  const lines: string[] = [];
  const prefix = '  '.repeat(indent);

  const sorted = [...entries].sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });

  for (const entry of sorted) {
    if (entry.name.startsWith('.')) continue;
    const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      if (SKIP_DIR.test(entry.name)) continue;
      const children = renderFileTreeText(absBase, relPath, indent + 1);
      if (!children) continue;
      lines.push(`${prefix}${entry.name}/`);
      lines.push(children);
    } else if (entry.isFile()) {
      if (SKIP_FILE_EXT.test(entry.name)) continue;
      if (SKIP_FILE_NAME.test(entry.name)) continue;
      lines.push(`${prefix}${entry.name}`);
    }
  }
  return lines.join('\n');
}

function buildFileTree(absBase: string, relDir: string, kernSet: Set<string>): TreeNode[] {
  const fullDir = join(absBase, relDir);
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(fullDir, { withFileTypes: true });
  } catch { return []; }

  const nodes: TreeNode[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      if (SKIP_DIR.test(entry.name)) continue;
      const children = buildFileTree(absBase, relPath, kernSet);
      if (children.length === 0) continue;
      const totalTokens = calcDirTokens(children);
      nodes.push({ type: 'dir', name: entry.name, path: relPath, children, totalTokens });
    } else if (entry.isFile()) {
      if (SKIP_FILE_EXT.test(entry.name)) continue;
      if (SKIP_FILE_NAME.test(entry.name)) continue;
      const absPath = join(absBase, relPath);
      let tokens = 0;
      try {
        tokens = estimateTokens(readFileSync(absPath, 'utf-8'));
      } catch { continue; }
      nodes.push({ type: 'file', name: entry.name, path: relPath, tokens, is_kern: kernSet.has(relPath) });
    }
  }

  return nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name, 'de');
  });
}

function calcDirTokens(nodes: TreeNode[]): number {
  return nodes.reduce((sum, n) => {
    if (n.type === 'file') return sum + n.tokens;
    return sum + n.totalTokens;
  }, 0);
}

function loadContextYaml(): ContextYaml {
  if (!existsSync(CONTEXT_YAML)) {
    throw new Error(`Privat Angel context YAML not found: ${CONTEXT_YAML}`);
  }
  return yamlLoad(readFileSync(CONTEXT_YAML, 'utf-8')) as ContextYaml;
}

const SYSTEM_PROMPT = `Du bist Rafaels persoenlicher Coach und Reflexionsspiegel.

Deine erste Nachricht enthaelt Rafaels Kontext-Dokumente in <documents> Tags:
- <persona>: Wer er ist (Identitaet, Psychologie, Coaching-Stil, Personen-Map)
- <betriebssystem>: Sein aktuelles Lebens-OS (Prioritaeten, Trainings-Plan, Tagesmodi)
- <recent_diary>: Tagebuch-Eintraege der letzten Tage (chronologisch)
- <inbox>: Frische Inputs (Voice-Transkripte, Notizen) fuer diese Session
- <zusatz_kontext>: Optional gewaehlte Vertiefungs-Bereiche
- <dateibaum>: Aktuelle Ordnerstruktur fuer Pfad-Referenzen

Lies diese Dokumente und behandle sie als deine einzige Wissensquelle ueber Rafael.
Antworte NUR auf seine Fragen — gib den Inhalt der Dokumente NICHT wieder.

COACHING-PRINZIPIEN (aus rafael-coaching.md ableiten und anwenden):
- Direkt, analytisch, ohne Beschoenigung. Kein "Du schaffst das schon"-Gerede.
- Sparringspartner statt Therapeut. Mitdenken, hinterfragen, Gegenargumente bringen.
- Ingenieur-Sprache und Frameworks (MBTI, Nietzsche, Systemtheorie) wenn passend.
- Keine Floskeln, keine F-Typen-Sprache. NT-Niveau (Logik + Intuition).
- Wenn du etwas nicht weisst: sag es direkt. Nichts erfinden.

DIFF-OUTPUT (wenn Rafael sagt "bau die Diffs", "Generiere Diffs", "schreib das ins Tagebuch", "update Betriebssystem"):
- BEVORZUGTES Format fuer Aenderungen an bestehenden Dateien:
    <<<DIFF pfad/zur/datei.md
    old_string: |
      ...exakter Text aus dem Original-Dokument...
    new_string: |
      ...neuer Text...
    >>>
- Format fuer NEUE Dateien (z.B. neuer Tagebuch-Eintrag):
    <<<NEW pfad/zur/neuen-datei.md
    content: |
      ...vollstaendiger Inhalt...
    >>>
- KRITISCH: old_string bezieht sich IMMER auf den ORIGINAL-Inhalt der Dateien (wie zu Session-Start geladen), NICHT auf zwischenzeitliche Aenderungen
- Genug Kontext-Zeilen fuer eindeutigen Match
- Mehrere Diff-Bloecke pro Datei sind erlaubt
- Nur betroffene Abschnitte liefern, nicht das gesamte Dokument
- PFADE: Der <dateibaum> Block enthaelt die aktuelle Ordnerstruktur. Verwende existierende Pfade. Tagebuch-Eintraege folgen dem Schema tagebuch/YYYY-MM/YYYY-MM-DD.md.

ANTWORT-FORMAT (KRITISCH):
- Antworte direkt in Prosa. KEINE Speaker-Labels — kein "H:", "A:", "User:", "Assistant:", "Sprecher 1:".
- Erfinde NIE eine User-Antwort. Antworte nicht auf Saetze, die Rafael nicht gesagt hat.
- Wenn Rafael Audio-Transkripte mit "Sprecher 1/2" oder "H:/A:" einfuegt: Referenziere sie als "du sagtest X" — uebernimm das Format NICHT in deine eigene Antwort.
- Stoppe nach deiner Antwort. Kein Cliffhanger, keine fiktiven Folge-Turns, kein "H: ..." am Ende.`;

// --- GET /context ---
router.get('/context', (_req, res) => {
  try {
    const yaml = loadContextYaml();
    const kernFiles = yaml.kern_files.map(f => readFileTokenInfo(f));
    const kernTokens = kernFiles.reduce((sum, f) => sum + f.tokens, 0);

    const inboxDir = yaml.inbox_ordner || INBOX_DIR;
    const inboxFiles = readInboxFiles(inboxDir);
    const inboxTokens = inboxFiles.reduce((sum, f) => sum + estimateTokens(f.content), 0);

    const days = yaml.tagebuch_rolling_days ?? TAGEBUCH_ROLLING_DAYS_DEFAULT;
    const diary = readRecentDiary(days);
    const diaryTokens = diary.reduce((sum, d) => sum + estimateTokens(d.content), 0);

    const zusatz: Record<string, KategorieInfo> = {};
    for (const [key, paths] of Object.entries(yaml.zusatz_kategorien)) {
      const files = (paths as string[]).map(f => readFileTokenInfo(f));
      zusatz[key] = { files, totalTokens: files.reduce((s, f) => s + f.tokens, 0) };
    }

    res.json({
      kern_files: kernFiles,
      kern_tokens: kernTokens,
      zusatz_kategorien: zusatz,
      inbox_files: inboxFiles.map(f => ({ name: f.name, tokens: estimateTokens(f.content) })),
      inbox_tokens: inboxTokens,
      inbox_dir: inboxDir,
      tagebuch_files: diary.map(d => ({ date: d.date, name: d.name, tokens: estimateTokens(d.content) })),
      tagebuch_tokens: diaryTokens,
      tagebuch_rolling_days: days,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// --- GET /file-preview ---
router.get('/file-preview', (req, res) => {
  try {
    const relPath = req.query.path as string;
    if (!relPath) { res.status(400).json({ error: 'path required' }); return; }

    const absPath  = join(PRIVAT_DIR, relPath);
    const inboxAbs = join(INBOX_DIR, relPath);

    let finalPath: string;
    if (existsSync(absPath) && absPath.startsWith(PRIVAT_DIR)) finalPath = absPath;
    else if (existsSync(inboxAbs) && inboxAbs.startsWith(INBOX_DIR)) finalPath = inboxAbs;
    else { res.status(404).json({ error: 'File not found' }); return; }

    const content = readFileSync(finalPath, 'utf-8');
    const { size } = statSync(finalPath);
    res.json({ path: relPath, preview: content, totalLines: content.split('\n').length, size, tokenEstimate: estimateTokens(content) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// --- GET /files ---
router.get('/files', (_req, res) => {
  try {
    const yaml = loadContextYaml();
    const kernSet = new Set<string>(yaml.kern_files);
    const tree = buildFileTree(PRIVAT_DIR, '', kernSet);
    res.json({ tree });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// --- GET /session/active ---
router.get('/session/active', (_req, res) => {
  const persisted = readPersistedSession();
  if (!persisted || !persisted.session_id || persisted.conversation === undefined) {
    return res.json({ active: false });
  }
  const inMemory = SESSION_STORE.has(persisted.session_id);
  res.json({
    active: true,
    session_id: persisted.session_id,
    created_at: persisted.created_at,
    updated_at: persisted.updated_at,
    token_count: persisted.token_count,
    files_loaded: persisted.files_loaded,
    inbox_files: persisted.inbox_files,
    tagebuch_files: persisted.tagebuch_files,
    conversation_turns: persisted.conversation.length,
    in_memory: inMemory,
  });
});

// --- POST /session/end ---
router.post('/session/end', (_req, res) => {
  const persisted = readPersistedSession();
  if (persisted && persisted.session_id) {
    SESSION_STORE.delete(persisted.session_id);
    deleteSnapshot(persisted.session_id);
    archiveSession(persisted);
    console.log(`[PrivatAngel] Session archived + snapshot deleted: ${persisted.session_id}`);
  }
  res.json({ ok: true });
});

// --- GET /sessions ---
router.get('/sessions', (_req, res) => {
  try {
    mkdirSync(SESSION_LOG_DIR, { recursive: true });
    const files = readdirSync(SESSION_LOG_DIR).filter(f => f.endsWith('.json')).sort().reverse();
    const sessions: Array<{
      id: string; title: string; created_at: number; updated_at: number; turns: number; filename: string;
    }> = [];

    for (const file of files) {
      try {
        const data = JSON.parse(readFileSync(join(SESSION_LOG_DIR, file), 'utf-8')) as PersistedSession;
        sessions.push({
          id: data.session_id,
          title: data.title || deriveSessionTitle(data.conversation),
          created_at: data.created_at,
          updated_at: data.updated_at,
          turns: data.conversation.length,
          filename: file,
        });
      } catch { /* skip */ }
    }
    res.json({ sessions });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /session/new ---
router.post('/session/new', (_req, res) => {
  try {
    const persisted = readPersistedSession();
    if (persisted && persisted.session_id && persisted.conversation && persisted.conversation.length > 0) {
      if (!persisted.title) persisted.title = deriveSessionTitle(persisted.conversation);
      SESSION_STORE.delete(persisted.session_id);
      deleteSnapshot(persisted.session_id);
      archiveSession(persisted);
    } else if (persisted?.session_id) {
      SESSION_STORE.delete(persisted.session_id);
      deleteSnapshot(persisted.session_id);
    }
    writeFileSync(ACTIVE_SESSION_PATH, '', 'utf-8');
    res.json({ ok: true, archived: !!(persisted?.conversation?.length) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /session/load/:id ---
router.post('/session/load/:id', (req, res) => {
  try {
    const targetId = req.params.id;
    if (!targetId) { res.status(400).json({ error: 'session id required' }); return; }

    mkdirSync(SESSION_LOG_DIR, { recursive: true });
    const files = readdirSync(SESSION_LOG_DIR).filter(f => f.endsWith('.json'));

    let found: PersistedSession | null = null;
    let foundFile = '';
    for (const file of files) {
      try {
        const data = JSON.parse(readFileSync(join(SESSION_LOG_DIR, file), 'utf-8')) as PersistedSession;
        if (data.session_id === targetId) { found = data; foundFile = file; break; }
      } catch { /* skip */ }
    }
    if (!found) { res.status(404).json({ error: `Session not found: ${targetId}` }); return; }

    const current = readPersistedSession();
    if (current && current.session_id && current.conversation && current.conversation.length > 0) {
      if (!current.title) current.title = deriveSessionTitle(current.conversation);
      SESSION_STORE.delete(current.session_id);
      archiveSession(current);
    } else if (current?.session_id) {
      SESSION_STORE.delete(current.session_id);
    }

    writeFileSync(ACTIVE_SESSION_PATH, JSON.stringify(found, null, 2), 'utf-8');

    res.json({
      ok: true,
      session_id: found.session_id,
      title: found.title || deriveSessionTitle(found.conversation),
      created_at: found.created_at,
      updated_at: found.updated_at,
      conversation: found.conversation,
      conversation_turns: found.conversation.length,
      token_count: found.token_count,
      files_loaded: found.files_loaded,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// --- Snapshot ---
interface Snapshot {
  sessionId: string;
  createdAt: string;
  files: Record<string, string>;
}

function snapshotPath(sessionId: string): string {
  return join(SNAPSHOT_DIR, `${sessionId}.json`);
}

function readSnapshot(sessionId: string): Snapshot | null {
  const p = snapshotPath(sessionId);
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, 'utf-8');
    if (!raw.trim()) return null;
    return JSON.parse(raw) as Snapshot;
  } catch { return null; }
}

function writeSnapshot(snapshot: Snapshot): void {
  ensureDir(SNAPSHOT_DIR);
  writeFileSync(snapshotPath(snapshot.sessionId), JSON.stringify(snapshot, null, 2), 'utf-8');
}

function deleteSnapshot(sessionId: string): void {
  const p = snapshotPath(sessionId);
  if (existsSync(p)) {
    try { writeFileSync(p, '', 'utf-8'); } catch { /* best effort */ }
  }
}

router.post('/snapshot', (req, res) => {
  try {
    const { session_id, files } = req.body as { session_id: string; files: Record<string, string> };
    if (!session_id) { res.status(400).json({ error: 'session_id required' }); return; }
    if (!files || typeof files !== 'object' || Object.keys(files).length === 0) {
      res.status(400).json({ error: 'files required (Record<path, content>)' }); return;
    }
    const existing = readSnapshot(session_id);
    if (existing) {
      res.status(409).json({
        error: 'Snapshot already exists for this session (immutable until finish)',
        file_count: Object.keys(existing.files).length,
        created_at: existing.createdAt,
      });
      return;
    }
    const snapshot: Snapshot = { sessionId: session_id, createdAt: new Date().toISOString(), files };
    writeSnapshot(snapshot);
    res.json({ ok: true, file_count: Object.keys(files).length, created_at: snapshot.createdAt });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/snapshot', (req, res) => {
  try {
    const session_id = req.query.session_id as string;
    if (!session_id) { res.status(400).json({ error: 'session_id query param required' }); return; }
    const snapshot = readSnapshot(session_id);
    if (!snapshot) { res.status(404).json({ error: 'No snapshot found for this session' }); return; }
    res.json(snapshot);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /load ---
router.post('/load', async (req, res) => {
  try {
    const { zusatz = [], extra_files = [], restore = false } = req.body as {
      zusatz?: string[];
      extra_files?: string[];
      restore?: boolean;
    };

    const yaml = loadContextYaml();
    const inboxDir = yaml.inbox_ordner || INBOX_DIR;
    const days = yaml.tagebuch_rolling_days ?? TAGEBUCH_ROLLING_DAYS_DEFAULT;

    const TEMPLATE_OVERHEAD = 500;
    let budget = SYSTEM_PROMPT_TOKEN_LIMIT - TEMPLATE_OVERHEAD;

    // 1. Persona kern
    const personaSections: string[] = [];
    const kernExcluded: string[] = [];
    let filesLoaded = 0;
    let totalTokens = 0;

    for (const relPath of yaml.kern_files) {
      const content = readFileContent(relPath);
      if (!content) {
        console.warn(`[PrivatAngel] Kern-file not found: ${relPath}`);
        continue;
      }
      const tokens = estimateTokens(content);
      if (tokens > budget) {
        kernExcluded.push(relPath);
        continue;
      }
      personaSections.push(`### ${relPath}\n\n${content}`);
      filesLoaded++;
      totalTokens += tokens;
      budget -= tokens;
    }

    // 2. Recent diary (rolling N days)
    const diary = readRecentDiary(days);
    const diarySections: string[] = [];
    const diaryFileNames: string[] = [];
    for (const d of diary) {
      const tokens = estimateTokens(d.content);
      if (tokens > budget) continue;
      diarySections.push(`### ${d.name}\n\n${d.content}`);
      diaryFileNames.push(d.name);
      filesLoaded++;
      totalTokens += tokens;
      budget -= tokens;
    }

    // 3. Inbox
    const inboxFiles = readInboxFiles(inboxDir);
    const inboxSections: string[] = [];
    const inboxExcluded: string[] = [];
    for (const f of inboxFiles) {
      const tokens = estimateTokens(f.content);
      if (tokens > budget) {
        inboxExcluded.push(f.name);
        continue;
      }
      inboxSections.push(`### ${f.name}\n\n${f.content}`);
      filesLoaded++;
      totalTokens += tokens;
      budget -= tokens;
    }

    // 4. Zusatz categories + extra_files
    const zusatzSections: string[] = [];
    const loadedPaths = new Set<string>(yaml.kern_files);

    for (const key of zusatz) {
      const paths = yaml.zusatz_kategorien[key];
      if (!paths) {
        console.warn(`[PrivatAngel] Unknown zusatz category: ${key}`);
        continue;
      }
      for (const relPath of paths) {
        if (loadedPaths.has(relPath)) continue;
        const content = readFileContent(relPath);
        if (!content) continue;
        const tokens = estimateTokens(content);
        if (tokens > budget) continue;
        zusatzSections.push(`### ${relPath}\n\n${content}`);
        loadedPaths.add(relPath);
        filesLoaded++;
        totalTokens += tokens;
        budget -= tokens;
      }
    }

    for (const relPath of extra_files) {
      if (loadedPaths.has(relPath)) continue;
      const content = readFileContent(relPath);
      if (!content) continue;
      const tokens = estimateTokens(content);
      if (tokens > budget) continue;
      zusatzSections.push(`### ${relPath}\n\n${content}`);
      loadedPaths.add(relPath);
      filesLoaded++;
      totalTokens += tokens;
      budget -= tokens;
    }

    const excluded = [...kernExcluded, ...inboxExcluded];

    // Build manifest of all loaded files (filename -> sha256). Used by /sync-context to
    // detect added/changed/removed files relative to the original session-start state.
    const freshManifest: Record<string, string> = {};
    for (const relPath of loadedPaths) {
      const c = readFileContent(relPath);
      if (c) freshManifest[relPath] = sha256(c);
    }
    for (const f of inboxFiles) freshManifest[`inbox/${f.name}`] = sha256(f.content);
    for (const d of diary) freshManifest[d.name] = sha256(d.content);

    const fileTreeText = renderFileTreeText(PRIVAT_DIR, '');

    // Split persona kern into <persona> (identity files) and <betriebssystem> (rafael-betriebssystem*)
    const personaIdentity: string[] = [];
    const personaOS: string[] = [];
    for (const section of personaSections) {
      const firstLine = section.split('\n')[0];
      if (/betriebssystem/i.test(firstLine)) personaOS.push(section);
      else personaIdentity.push(section);
    }

    const contextMessage = `<documents>

<dateibaum description="Aktuelle Ordnerstruktur von ${PRIVAT_DIR} — verwende diese Pfade fuer neue/bestehende Dateien">
${fileTreeText}
</dateibaum>

<persona>
${personaIdentity.join('\n\n---\n\n')}
</persona>

${personaOS.length > 0 ? `<betriebssystem>
${personaOS.join('\n\n---\n\n')}
</betriebssystem>` : ''}

${diarySections.length > 0 ? `<recent_diary description="Tagebuch-Eintraege der letzten ${days} Tage, chronologisch">
${diarySections.join('\n\n---\n\n')}
</recent_diary>` : ''}

${inboxSections.length > 0 ? `<inbox description="Frische Inputs fuer diese Session (Voice-Transkripte, Notizen)">
${inboxSections.join('\n\n---\n\n')}
</inbox>` : ''}

${zusatzSections.length > 0 ? `<zusatz_kontext>
${zusatzSections.join('\n\n---\n\n')}
</zusatz_kontext>` : ''}

</documents>

Dokumente geladen (${filesLoaded} Dateien, ${diary.length} Tagebuch-Tage, ${inboxFiles.length} Inbox-Files). Was beschaeftigt dich?`;

    // Auto-archive stale active session if starting fresh
    if (!restore) {
      const currentActive = readPersistedSession();
      if (currentActive && currentActive.session_id && currentActive.conversation && currentActive.conversation.length > 0) {
        if (!currentActive.title) currentActive.title = deriveSessionTitle(currentActive.conversation);
        SESSION_STORE.delete(currentActive.session_id);
        deleteSnapshot(currentActive.session_id);
        archiveSession(currentActive);
        console.log(`[PrivatAngel] /load: Auto-archived stale active session ${currentActive.session_id.slice(0, 8)} before fresh start`);
      }
    }

    const persisted = restore ? readPersistedSession() : null;
    const restoredConversation: ChatMessage[] = persisted?.conversation ?? [];

    // PROMPT-CACHING + KONSISTENZ: bei restore IMMER persisted context_message + manifest 1:1 verwenden
    // (falls vorhanden). Nur Migration alter Sessions ohne persistierten Context fällt auf den frisch
    // gebauten contextMessage zurück. Updates während laufender Session laufen über /sync-context.
    const usePersistedContext = restore && persisted?.context_message;
    const sessionContextMessage = usePersistedContext ? persisted.context_message! : contextMessage;
    const sessionManifest = usePersistedContext && persisted!.manifest ? persisted!.manifest : freshManifest;

    const initialHistory: ChatMessage[] = [
      { role: 'user', content: sessionContextMessage },
      { role: 'assistant', content: 'Verstanden. Ich kenne deinen Kontext. Frag mich.' },
      ...restoredConversation,
    ];

    const session_id = persisted?.session_id ?? randomUUID();
    const newSession: ChatSession = {
      session_id,
      system_prompt: SYSTEM_PROMPT,
      context_message: sessionContextMessage,
      manifest: sessionManifest,
      history: initialHistory,
      created_at: persisted?.created_at ?? Date.now(),
      token_count: totalTokens,
      files_loaded: filesLoaded,
      inbox_files: inboxFiles.map(f => f.name),
      tagebuch_files: diaryFileNames,
      zusatz_loaded: zusatz,
    };
    SESSION_STORE.set(session_id, newSession);
    writePersistedSession(newSession);

    // Snapshot for diff baseline
    if (!restore || !readSnapshot(session_id)) {
      const snapshotFiles: Record<string, string> = {};
      for (const relPath of loadedPaths) {
        const content = readFileContent(relPath);
        if (content) snapshotFiles[relPath] = content;
      }
      for (const inf of inboxFiles) snapshotFiles[`inbox/${inf.name}`] = inf.content;
      for (const d of diary) snapshotFiles[d.name] = d.content;
      if (Object.keys(snapshotFiles).length > 0) {
        if (!restore) deleteSnapshot(session_id);
        writeSnapshot({ sessionId: session_id, createdAt: new Date().toISOString(), files: snapshotFiles });
      }
    }

    const action = restore && restoredConversation.length > 0 ? 'restored' : 'created';
    console.log(`[PrivatAngel] Session ${action}: ${session_id} (${filesLoaded} files, ~${totalTokens} tokens, ${restoredConversation.length} turns restored)`);

    res.json({
      ok: true,
      session_id,
      token_count: totalTokens,
      files_loaded: filesLoaded,
      inbox_files: inboxFiles.map(f => f.name),
      tagebuch_files: diaryFileNames,
      zusatz_loaded: zusatz,
      excluded: excluded.length > 0 ? excluded : undefined,
      token_limit: SYSTEM_PROMPT_TOKEN_LIMIT,
      restored: restore && restoredConversation.length > 0,
      conversation_turns: restoredConversation.length,
      conversation: restore && restoredConversation.length > 0 ? restoredConversation : undefined,
    });
  } catch (err: any) {
    console.error('[PrivatAngel] /load error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Auto-restore: rebuild a session from disk if it dropped from memory after restart.
 * Mirrors the rebuild logic in /load (kern + diary + inbox + tree).
 */
function getOrRestoreSession(session_id: string): ChatSession | null {
  const existing = SESSION_STORE.get(session_id);
  if (existing) return existing;

  const persisted = readPersistedSession();
  if (!persisted || persisted.session_id !== session_id) return null;

  // Fast-path: persisted has context_message → restore 1:1 without rebuild (keeps Cache stable).
  if (persisted.context_message) {
    const restored: ChatSession = {
      session_id: persisted.session_id,
      system_prompt: SYSTEM_PROMPT,
      context_message: persisted.context_message,
      manifest: persisted.manifest ?? {},
      history: [
        { role: 'user', content: persisted.context_message },
        { role: 'assistant', content: 'Verstanden. Ich kenne deinen Kontext. Frag mich.' },
        ...persisted.conversation,
      ],
      created_at: persisted.created_at,
      token_count: persisted.token_count,
      files_loaded: persisted.files_loaded,
      inbox_files: persisted.inbox_files,
      tagebuch_files: persisted.tagebuch_files,
      zusatz_loaded: persisted.zusatz_loaded ?? [],
    };
    SESSION_STORE.set(session_id, restored);
    console.log(`[PrivatAngel] Auto-restored session ${session_id.slice(0, 8)} from persisted context (${persisted.conversation.length} turns)`);
    return restored;
  }

  // Migration path: legacy session without persisted context_message → rebuild from current yaml,
  // then persist so next restore is 1:1.
  try {
    const yaml = loadContextYaml();
    const inboxDir = yaml.inbox_ordner || INBOX_DIR;
    const days = yaml.tagebuch_rolling_days ?? TAGEBUCH_ROLLING_DAYS_DEFAULT;

    let budget = SYSTEM_PROMPT_TOKEN_LIMIT - 500;
    let filesLoaded = 0;
    let totalTokens = 0;

    const personaSections: string[] = [];
    for (const relPath of yaml.kern_files) {
      const content = readFileContent(relPath);
      if (!content) continue;
      const tokens = estimateTokens(content);
      if (tokens > budget) continue;
      personaSections.push(`### ${relPath}\n\n${content}`);
      filesLoaded++; totalTokens += tokens; budget -= tokens;
    }

    const diary = readRecentDiary(days);
    const diarySections: string[] = [];
    for (const d of diary) {
      const tokens = estimateTokens(d.content);
      if (tokens > budget) continue;
      diarySections.push(`### ${d.name}\n\n${d.content}`);
      filesLoaded++; totalTokens += tokens; budget -= tokens;
    }

    const inboxFiles = readInboxFiles(inboxDir);
    const inboxSections: string[] = [];
    for (const f of inboxFiles) {
      const tokens = estimateTokens(f.content);
      if (tokens > budget) continue;
      inboxSections.push(`### ${f.name}\n\n${f.content}`);
      filesLoaded++; totalTokens += tokens; budget -= tokens;
    }

    const fileTreeText = renderFileTreeText(PRIVAT_DIR, '');

    const personaIdentity: string[] = [];
    const personaOS: string[] = [];
    for (const section of personaSections) {
      const firstLine = section.split('\n')[0];
      if (/betriebssystem/i.test(firstLine)) personaOS.push(section);
      else personaIdentity.push(section);
    }

    const contextMessage = `<documents>

<dateibaum>
${fileTreeText}
</dateibaum>

<persona>
${personaIdentity.join('\n\n---\n\n')}
</persona>

${personaOS.length > 0 ? `<betriebssystem>
${personaOS.join('\n\n---\n\n')}
</betriebssystem>` : ''}

${diarySections.length > 0 ? `<recent_diary>
${diarySections.join('\n\n---\n\n')}
</recent_diary>` : ''}

${inboxSections.length > 0 ? `<inbox>
${inboxSections.join('\n\n---\n\n')}
</inbox>` : ''}

</documents>

Dokumente geladen (${filesLoaded} Dateien). Was beschaeftigt dich?`;

    // Build manifest for the migrated session so future /sync-context can compare deltas.
    const migrationManifest: Record<string, string> = {};
    for (const relPath of yaml.kern_files) {
      const c = readFileContent(relPath);
      if (c) migrationManifest[relPath] = sha256(c);
    }
    for (const f of inboxFiles) migrationManifest[`inbox/${f.name}`] = sha256(f.content);
    for (const d of diary) migrationManifest[d.name] = sha256(d.content);

    const initialHistory: ChatMessage[] = [
      { role: 'user', content: contextMessage },
      { role: 'assistant', content: 'Verstanden. Ich kenne deinen Kontext. Frag mich.' },
      ...persisted.conversation,
    ];

    const restored: ChatSession = {
      session_id: persisted.session_id,
      system_prompt: SYSTEM_PROMPT,
      context_message: contextMessage,
      manifest: migrationManifest,
      history: initialHistory,
      created_at: persisted.created_at,
      token_count: totalTokens,
      files_loaded: filesLoaded,
      inbox_files: inboxFiles.map(f => f.name),
      tagebuch_files: diary.map(d => d.name),
      zusatz_loaded: persisted.zusatz_loaded ?? [],
    };

    SESSION_STORE.set(session_id, restored);
    writePersistedSession(restored);  // Persist the migrated context_message + manifest
    console.log(`[PrivatAngel] Migrated legacy session ${session_id.slice(0, 8)} — persisted context_message + manifest (${persisted.conversation.length} turns)`);
    return restored;
  } catch (err: any) {
    console.error(`[PrivatAngel] Auto-restore failed: ${err.message}`);
    return null;
  }
}

// --- POST /sync-context ---
// Compares the current yaml + filesystem state against the session's manifest (frozen at session
// start) and appends a single user message to the conversation listing added/changed files (and
// optional extra_files chosen by the user). Manifest is updated so subsequent syncs only show
// the new delta. Keeps the original context_message immutable for prompt caching + consistency.
router.post('/sync-context', (req, res) => {
  try {
    const { session_id, extra_files = [] } = req.body as {
      session_id?: string;
      extra_files?: string[];
    };
    if (!session_id) { res.status(400).json({ error: 'session_id required' }); return; }

    const session = getOrRestoreSession(session_id);
    if (!session) { res.status(404).json({ error: `Session not found: ${session_id}` }); return; }

    const yaml = loadContextYaml();
    const inboxDir = yaml.inbox_ordner || INBOX_DIR;
    const days = yaml.tagebuch_rolling_days ?? TAGEBUCH_ROLLING_DAYS_DEFAULT;

    // Collect everything that should be in the current context (kern + diary + inbox + extras).
    type CandidateFile = { key: string; content: string };
    const current: CandidateFile[] = [];
    for (const relPath of yaml.kern_files) {
      const c = readFileContent(relPath);
      if (c) current.push({ key: relPath, content: c });
    }
    for (const d of readRecentDiary(days)) {
      current.push({ key: d.name, content: d.content });
    }
    for (const f of readInboxFiles(inboxDir)) {
      current.push({ key: `inbox/${f.name}`, content: f.content });
    }
    for (const relPath of extra_files) {
      const c = readFileContent(relPath);
      if (c && !current.some(x => x.key === relPath)) current.push({ key: relPath, content: c });
    }

    const oldManifest = session.manifest ?? {};
    const added: CandidateFile[] = [];
    const changed: CandidateFile[] = [];
    const newManifest: Record<string, string> = {};

    for (const f of current) {
      const hash = sha256(f.content);
      newManifest[f.key] = hash;
      if (!(f.key in oldManifest)) added.push(f);
      else if (oldManifest[f.key] !== hash) changed.push(f);
    }
    const removed = Object.keys(oldManifest).filter(k => !(k in newManifest));

    if (added.length === 0 && changed.length === 0 && removed.length === 0) {
      res.json({ ok: true, no_changes: true, message: 'Kein Update — Dokumente unverändert.' });
      return;
    }

    const TOKEN_BUDGET = 50000;
    let budget = TOKEN_BUDGET;
    const sections: string[] = [];
    const truncated: string[] = [];

    if (added.length > 0) {
      sections.push(`### NEU hinzugekommen (${added.length})\n`);
      for (const f of added) {
        const tokens = estimateTokens(f.content);
        if (tokens > budget) { truncated.push(f.key); continue; }
        sections.push(`#### ${f.key}\n\n${f.content}`);
        budget -= tokens;
      }
    }
    if (changed.length > 0) {
      sections.push(`\n### GEÄNDERT seit Session-Start (${changed.length})\n`);
      for (const f of changed) {
        const tokens = estimateTokens(f.content);
        if (tokens > budget) { truncated.push(f.key); continue; }
        sections.push(`#### ${f.key}\n\n${f.content}`);
        budget -= tokens;
      }
    }
    if (removed.length > 0) {
      sections.push(`\n### Nicht mehr im aktuellen Kontext (${removed.length}):\n${removed.map(k => `- ${k}`).join('\n')}`);
    }
    if (truncated.length > 0) {
      sections.push(`\n_Wegen Token-Budget übersprungen: ${truncated.join(', ')}_`);
    }

    const updateMessage = `📎 **Stand-Update seit Session-Start**\n\n${sections.join('\n\n')}`;
    const ackMessage = `Verstanden. Update integriert (${added.length} neu, ${changed.length} geändert, ${removed.length} entfallen).`;

    session.history.push({ role: 'user', content: updateMessage });
    session.history.push({ role: 'assistant', content: ackMessage });
    session.manifest = newManifest;
    writePersistedSession(session);

    console.log(`[PrivatAngel] /sync-context session=${session_id.slice(0, 8)}: +${added.length} new, ~${changed.length} changed, -${removed.length} removed, ${truncated.length} truncated`);

    res.json({
      ok: true,
      added: added.map(f => f.key),
      changed: changed.map(f => f.key),
      removed,
      truncated,
      messages: [
        { role: 'user', content: updateMessage },
        { role: 'assistant', content: ackMessage },
      ],
    });
  } catch (err: any) {
    console.error('[PrivatAngel] /sync-context error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- POST /chat ---
router.post('/chat', async (req, res) => {
  try {
    const { session_id, message } = req.body as { session_id: string; message: string };
    if (!session_id) { res.status(400).json({ error: 'session_id required' }); return; }
    if (!message?.trim()) { res.status(400).json({ error: 'message required' }); return; }

    const session = getOrRestoreSession(session_id);
    if (!session) {
      res.status(404).json({ error: `Session not found: ${session_id}. Bitte Session neu laden.` });
      return;
    }

    const messages: ChatMessage[] = [
      ...session.history,
      { role: 'user', content: message.trim() },
    ];

    console.log(`[PrivatAngel] /chat session=${session_id.slice(0, 8)} history=${session.history.length} msg_len=${message.length}`);

    const responseText = await bridgeChat({
      messages: [
        { role: 'system', content: session.system_prompt },
        ...messages,
      ],
      attribution: { appId: 'cui', userId: 'rafael', agentId: 'privat-angel' },
    });

    // Auto-apply <<<NEW>>> blocks (only safe new-file writes, never overwrites).
    const applyResult = autoApplyNewFiles(responseText, PRIVAT_DIR);
    const finalResponse = responseText + summarizeApplyResult(applyResult);
    if (applyResult.written.length > 0) {
      console.log(`[PrivatAngel] auto-applied ${applyResult.written.length} new file(s): ${applyResult.written.join(', ')}`);
    }

    session.history.push({ role: 'user', content: message.trim() });
    session.history.push({ role: 'assistant', content: finalResponse });
    writePersistedSession(session);

    res.json({ ok: true, response: finalResponse, session_id });
  } catch (err: any) {
    console.error('[PrivatAngel] /chat error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- POST /apply-diffs ---
router.post('/apply-diffs', (req, res) => {
  try {
    const { diffs, raw_text, dry_run = false, session_id } = req.body as {
      diffs?: Array<{ file: string; old: string; newText: string }>;
      raw_text?: string;
      dry_run?: boolean;
      session_id?: string;
    };

    const resolvedDiffs = diffs || (raw_text ? parseDiffs(raw_text) : []);
    if (!resolvedDiffs.length) {
      res.status(400).json({ error: 'No diffs provided. Pass diffs[] or raw_text.' });
      return;
    }

    const datePrefix = new Date().toISOString().slice(0, 10);
    const normalizeWs = (s: string) =>
      s.replace(/\r\n/g, '\n').split('\n').map(l => l.trimEnd()).join('\n');

    const workingVersions = new Map<string, string>();
    const originalContents = new Map<string, string>();

    interface SimResult {
      diff: (typeof resolvedDiffs)[0];
      absPath: string;
      status: 'ok' | 'already_applied' | 'failed';
      reason?: string;
    }
    const simResults: SimResult[] = [];

    for (const diff of resolvedDiffs) {
      const absPath = join(PRIVAT_DIR, diff.file);

      if (
        diff.old.includes('\n') &&
        !diff.newText.includes('\n') &&
        diff.newText.trim().length > 0 &&
        diff.newText.length < diff.old.length * 0.1
      ) {
        simResults.push({
          diff, absPath, status: 'failed',
          reason: `Refused: suspicious shrink (old=${diff.old.length} chars, new=${diff.newText.length} chars, single line). Likely parser corruption.`,
        });
        continue;
      }

      if (!diff.old.trim()) {
        if (existsSync(absPath)) {
          simResults.push({ diff, absPath, status: 'failed', reason: 'NEW FILE: file already exists' });
          continue;
        }
        workingVersions.set(absPath, diff.newText);
        simResults.push({ diff, absPath, status: 'ok' });
        continue;
      }

      if (!existsSync(absPath)) {
        simResults.push({ diff, absPath, status: 'failed', reason: 'File not found' });
        continue;
      }

      if (!workingVersions.has(absPath)) {
        const diskContent = readFileSync(absPath, 'utf-8');
        workingVersions.set(absPath, diskContent);
        originalContents.set(absPath, diskContent);
      }
      const current = workingVersions.get(absPath)!;

      if (diff.newText.length > 0 && current.includes(diff.newText) && !current.includes(diff.old)) {
        simResults.push({ diff, absPath, status: 'already_applied' });
        continue;
      }

      let updated: string | null = null;
      if (current.includes(diff.old)) {
        updated = current.replace(diff.old, diff.newText);
      } else {
        const normCurrent = normalizeWs(current);
        const normOld = normalizeWs(diff.old);
        if (normCurrent.includes(normOld)) {
          updated = normCurrent.replace(normOld, normalizeWs(diff.newText));
        } else {
          const headingMatch = diff.old.trim().match(/^(#{1,6})\s+(.+)$/);
          if (headingMatch) {
            const level = headingMatch[1].length;
            const escapedHeading = diff.old.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const sectionRe = new RegExp(
              `(${escapedHeading}[\\s\\S]*?)(?=\\n#{1,${level}} |\\n#{1,${level}}\\t|$)`,
            );
            if (sectionRe.test(normCurrent)) {
              updated = normCurrent.replace(sectionRe, normalizeWs(diff.newText).trimEnd() + '\n');
            }
          }
        }
      }

      if (updated === null) {
        simResults.push({ diff, absPath, status: 'failed', reason: 'OLD text not found in file' });
        continue;
      }

      workingVersions.set(absPath, updated);
      simResults.push({ diff, absPath, status: 'ok' });
    }

    const failedSims  = simResults.filter(r => r.status === 'failed');
    const okSims      = simResults.filter(r => r.status === 'ok');
    const alreadySims = simResults.filter(r => r.status === 'already_applied');

    if (dry_run) {
      res.json({
        ok: true, dry_run: true,
        applied:         okSims.map(r => r.diff.file),
        already_applied: alreadySims.map(r => r.diff.file),
        failed:          failedSims.map(r => ({ file: r.diff.file, reason: r.reason! })),
        backup_dir: null,
      });
      return;
    }

    if (failedSims.length > 0) {
      const failedSimSet = new Set(failedSims);
      res.json({
        ok: true, dry_run: false,
        applied: [],
        already_applied: alreadySims.map(r => r.diff.file),
        failed: simResults
          .filter(r => r.status !== 'already_applied')
          .map(r => ({
            file: r.diff.file,
            reason: failedSimSet.has(r) ? r.reason! : 'blocked: other diffs in batch failed',
          })),
        backup_dir: null, aborted: true,
      });
      return;
    }

    ensureDir(BACKUP_DIR);

    const filesToWrite = new Map<string, { content: string; isNew: boolean; relPath: string }>();
    for (const [absPath, finalContent] of workingVersions) {
      const orig = originalContents.get(absPath);
      if (orig === undefined || finalContent !== orig) {
        filesToWrite.set(absPath, {
          content: finalContent,
          isNew: orig === undefined,
          relPath: relative(PRIVAT_DIR, absPath),
        });
      }
    }

    const backupMap = new Map<string, string>();
    for (const [absPath, { isNew }] of filesToWrite) {
      if (!isNew) {
        const backupName = `${datePrefix}_${basename(relative(PRIVAT_DIR, absPath))}`;
        const bp = join(BACKUP_DIR, backupName);
        const finalBp = existsSync(bp) ? `${bp}.${Date.now()}` : bp;
        writeFileSync(finalBp, originalContents.get(absPath)!, 'utf-8');
        backupMap.set(absPath, finalBp);
      }
    }

    const sha256 = (s: string) => createHash('sha256').update(s, 'utf-8').digest('hex');
    const writtenPaths: string[] = [];
    let rollbackCause: { file: string; reason: string; expected_hash?: string; actual_hash?: string } | null = null;

    for (const [absPath, { content, isNew }] of filesToWrite) {
      if (rollbackCause) break;
      const tmpPath = absPath + '.tmp';
      const relPath = relative(PRIVAT_DIR, absPath);
      try {
        if (isNew) ensureDir(dirname(absPath));
        writeFileSync(tmpPath, content, 'utf-8');
        renameSync(tmpPath, absPath);
        const actual = readFileSync(absPath, 'utf-8');
        const expectedHash = sha256(content);
        const actualHash   = sha256(actual);
        if (expectedHash !== actualHash) {
          rollbackCause = { file: relPath, reason: 'write-verify mismatch', expected_hash: expectedHash, actual_hash: actualHash };
          break;
        }
        writtenPaths.push(absPath);
      } catch (e: any) {
        if (existsSync(tmpPath)) {
          try { renameSync(tmpPath, `${tmpPath}.failed`); } catch { /* best effort */ }
        }
        rollbackCause = { file: relPath, reason: e.message };
        break;
      }
    }

    if (rollbackCause) {
      for (const absPath of writtenPaths) {
        const bp = backupMap.get(absPath);
        try {
          if (bp && existsSync(bp)) {
            writeFileSync(absPath, readFileSync(bp, 'utf-8'), 'utf-8');
          } else {
            if (existsSync(absPath)) renameSync(absPath, `${absPath}.rolled_back`);
          }
        } catch { /* best effort */ }
      }
      const writtenRelSet = new Set(writtenPaths.map(a => relative(PRIVAT_DIR, a)));
      const unreachedRel  = Array.from(filesToWrite.values())
        .map(v => v.relPath)
        .filter(p => p !== rollbackCause!.file && !writtenRelSet.has(p));

      res.json({
        ok: false, dry_run: false,
        applied: [],
        already_applied: alreadySims.map(r => r.diff.file),
        failed: [
          rollbackCause,
          ...writtenPaths.map(a => ({ file: relative(PRIVAT_DIR, a), reason: 'rolled back' })),
          ...unreachedRel.map(p => ({ file: p, reason: 'not reached due to earlier failure' })),
        ],
        backup_dir: BACKUP_DIR, rollback: true,
      });
      return;
    }

    const finalRelPaths = Array.from(filesToWrite.values()).map(v => v.relPath);
    let snapshotRefreshed = false;
    if (session_id && finalRelPaths.length > 0) {
      const snap = readSnapshot(session_id);
      if (snap) {
        for (const relPath of finalRelPaths) {
          const absPath = join(PRIVAT_DIR, relPath);
          if (existsSync(absPath)) snap.files[relPath] = readFileSync(absPath, 'utf-8');
        }
        writeSnapshot(snap);
        snapshotRefreshed = true;
      }
    }

    res.json({
      ok: true, dry_run: false,
      applied:           finalRelPaths,
      already_applied:   alreadySims.map(r => r.diff.file),
      failed:            [],
      write_verified:    true,
      backup_dir:        BACKUP_DIR,
      snapshot_refreshed: snapshotRefreshed,
    });
  } catch (err: any) {
    console.error('[PrivatAngel] /apply-diffs error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
