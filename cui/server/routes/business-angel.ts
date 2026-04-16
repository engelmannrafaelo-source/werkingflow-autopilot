// =============================================================================
// Business Angel Chat v2 — Context-loaded AI conversation with diff output
// =============================================================================
// GET  /api/business-angel/context     → read YAML config, return categories + token estimates
// GET  /api/business-angel/files       → full file tree of business dir with token counts
// POST /api/business-angel/load        → assemble system prompt, create in-memory chat session
// POST /api/business-angel/chat        → send message to AI Bridge, maintain history
// POST /api/business-angel/apply-diffs → validate + backup + apply FILE/OLD/NEW diffs
// =============================================================================

import { Router } from 'express';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'fs';
import { randomUUID } from 'crypto';
import { join, basename, dirname, relative } from 'path';
import { load as yamlLoad } from 'js-yaml';
import { PATHS } from '../config/paths.js';
import { parseDiffs } from '../lib/diff-parser.js';
import { bridgeChat } from '../lib/bridge-fetch.js';

const router = Router();

// --- Constants ---
const BUSINESS_DIR = PATHS.businessDir;
const CONTEXT_YAML = '/root/projekte/local-storage/report-builder/business-angel-context.yaml';
const BACKUP_DIR   = '/root/projekte/local-storage/report-builder/backups';
const TEMP_DIR     = '/root/projekte/local-storage/report-builder/temp';
const SNAPSHOT_DIR = '/root/projekte/local-storage/cui/snapshots';

// Approx tokens per character (rough estimate for German/English mixed text)
const CHARS_PER_TOKEN = 4;
const SYSTEM_PROMPT_TOKEN_LIMIT = 180000;

// --- Session Store ---
interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface ChatSession {
  session_id: string;
  system_prompt: string;
  history: ChatMessage[];
  created_at: number;
  token_count: number;
  files_loaded: number;
  temp_files: string[];
  zusatz_loaded: string[];
}

// Disk-persisted session state (survives server restarts)
interface PersistedSession {
  session_id: string;
  title: string;
  created_at: number;
  updated_at: number;
  token_count: number;
  files_loaded: number;
  temp_files: string[];
  zusatz_loaded: string[];
  // Only the real conversation (indices 2+), not the injected context messages
  conversation: ChatMessage[];
}

const ACTIVE_SESSION_PATH = '/root/projekte/local-storage/report-builder/business-angel-active.json';
const SESSION_LOG_DIR     = '/root/projekte/local-storage/report-builder/business-angel-logs';

const SESSION_STORE = new Map<string, ChatSession>();

function readPersistedSession(): PersistedSession | null {
  try {
    if (!existsSync(ACTIVE_SESSION_PATH)) return null;
    return JSON.parse(readFileSync(ACTIVE_SESSION_PATH, 'utf-8')) as PersistedSession;
  } catch { return null; }
}

function deriveSessionTitle(conversation: ChatMessage[]): string {
  const firstUserMsg = conversation.find(m => m.role === 'user');
  if (!firstUserMsg) return 'Neue Session';
  // Take first 60 chars of the first user message as title
  const raw = firstUserMsg.content.replace(/\n/g, ' ').trim();
  return raw.length > 60 ? raw.slice(0, 57) + '…' : raw;
}

function writePersistedSession(session: ChatSession): void {
  // conversation = history minus the first 2 pre-seeded context messages
  const conversation = session.history.slice(2);
  const data: PersistedSession = {
    session_id: session.session_id,
    title: deriveSessionTitle(conversation),
    created_at: session.created_at,
    updated_at: Date.now(),
    token_count: session.token_count,
    files_loaded: session.files_loaded,
    temp_files: session.temp_files,
    zusatz_loaded: session.zusatz_loaded,
    conversation,
  };
  writeFileSync(ACTIVE_SESSION_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Auto-restore: if session is not in memory but exists on disk, rebuild it.
 * This handles CUI server restarts / hot-reloads without losing the active session.
 */
function getOrRestoreSession(session_id: string): ChatSession | null {
  const existing = SESSION_STORE.get(session_id);
  if (existing) return existing;

  // Try to restore from disk
  const persisted = readPersistedSession();
  if (!persisted || persisted.session_id !== session_id) return null;

  try {
    // Rebuild system prompt from current YAML + files (same logic as /load)
    const yaml = loadContextYaml();
    const tempDir = yaml.temp_ordner || TEMP_DIR;

    const TEMPLATE_OVERHEAD = 300;
    let budget = SYSTEM_PROMPT_TOKEN_LIMIT - TEMPLATE_OVERHEAD;
    let filesLoaded = 0;
    let totalTokens = 0;

    const kernSections: string[] = [];
    for (const relPath of yaml.kern_files) {
      const content = readFileContent(relPath);
      if (!content) continue;
      const tokens = estimateTokens(content);
      if (tokens > budget) continue;
      kernSections.push(`### ${relPath}\n\n${content}`);
      filesLoaded++;
      totalTokens += tokens;
      budget -= tokens;
    }

    const tempFiles = readTempFiles(tempDir);
    const tempSections: string[] = [];
    for (const f of tempFiles) {
      const tokens = estimateTokens(f.content);
      if (tokens > budget) continue;
      tempSections.push(`### ${f.name}\n\n${f.content}`);
      filesLoaded++;
      totalTokens += tokens;
      budget -= tokens;
    }

    const systemPrompt = `Du bist ein strategischer Berater für WerkING Tools / Engelmann Data Energyneering.

Deine erste Nachricht enthält Kontext-Dokumente in <documents> Tags.
Lies diese Dokumente und verwende sie als einzige Wissensquelle.
Antworte NUR auf Rafaels Fragen — gib den Inhalt der Dokumente NICHT wieder.

REGELN:
- Verwende AUSSCHLIESSLICH was in den <documents> steht
- Erfinde keine Zahlen, Konditionen, Personen oder Deals
- Wenn du etwas nicht weißt: sag es direkt
- Wenn Rafael sagt "bau die Diffs" oder "Generiere Diffs": schreibe strukturierte Diff-Blöcke
  BEVORZUGTES Format für Änderungen an bestehenden Dateien:
    <<<DIFF pfad/zur/datei.md
    old_string: |
      ...exakter Text aus dem Original-Dokument...
    new_string: |
      ...neuer Text...
    >>>
  Format für NEUE Dateien:
    <<<NEW pfad/zur/neuen-datei.md
    content: |
      ...vollständiger Inhalt...
    >>>
  ALTERNATIVES Format (auch akzeptiert):
    FILE: <relativer Pfad ab business/>
    OLD:
    <Text aus dem Original>
    NEW:
    <Neuer Text>
- KRITISCH für old_string/OLD: Beziehe dich IMMER auf den ORIGINAL-Inhalt der Dateien (wie sie zu Beginn der Session geladen wurden), NICHT auf zwischenzeitliche Änderungen
- KRITISCH: Genug Kontext-Zeilen für eindeutigen Match
- Mehrere Diff-Blöcke pro Datei sind erlaubt
- Bei neuen Dateien: <<<NEW verwenden mit vollständigem Inhalt
- Nur die betroffenen Abschnitte liefern, nicht das gesamte Dokument
- PFADE: Der <dateibaum> Block enthält die aktuelle Ordnerstruktur. Verwende IMMER existierende Pfade und Namenskonventionen daraus. Für neue Dateien: orientiere dich am Namensschema der Nachbar-Dateien im gleichen Ordner.`;

    const fileTreeText = renderFileTreeText(BUSINESS_DIR, '');

    const contextMessage = `<documents>

<dateibaum description="Aktuelle Ordnerstruktur von /root/projekte/werkingflow-business/ — verwende diese Pfade wenn du neue Dateien erstellst oder bestehende referenzierst">
${fileTreeText}
</dateibaum>

<kern_business_docs>
${kernSections.join('\n\n---\n\n')}
</kern_business_docs>

${tempSections.length > 0 ? `<temp_ordner>
${tempSections.join('\n\n---\n\n')}
</temp_ordner>` : ''}

</documents>

Dokumente geladen (${filesLoaded} Dateien). Bitte stelle mir deine Fragen.`;

    const initialHistory: ChatMessage[] = [
      { role: 'user', content: contextMessage },
      { role: 'assistant', content: 'Verstanden. Dokumente geladen und bereit.' },
      ...persisted.conversation,
    ];

    const restored: ChatSession = {
      session_id: persisted.session_id,
      system_prompt: systemPrompt,
      history: initialHistory,
      created_at: persisted.created_at,
      token_count: totalTokens,
      files_loaded: filesLoaded,
      temp_files: tempFiles.map(f => f.name),
      zusatz_loaded: persisted.zusatz_loaded ?? [],
    };

    SESSION_STORE.set(session_id, restored);
    console.log(`[BusinessAngel] Auto-restored session ${session_id.slice(0, 8)} from disk (${persisted.conversation.length} turns, ${filesLoaded} files)`);
    return restored;
  } catch (err: any) {
    console.error(`[BusinessAngel] Auto-restore failed: ${err.message}`);
    return null;
  }
}

function archiveSession(session: PersistedSession): void {
  try {
    mkdirSync(SESSION_LOG_DIR, { recursive: true });
    const date = new Date(session.created_at).toISOString().slice(0, 10);
    const logPath = join(SESSION_LOG_DIR, `session-${date}-${session.session_id.slice(0, 8)}.json`);
    writeFileSync(logPath, JSON.stringify(session, null, 2), 'utf-8');
    // Remove active session file
    if (existsSync(ACTIVE_SESSION_PATH)) {
      writeFileSync(ACTIVE_SESSION_PATH, '', 'utf-8'); // truncate instead of delete
    }
  } catch (err: any) {
    console.error('[BusinessAngel] Archive failed:', err.message);
  }
}

// --- Types ---
interface ContextYaml {
  kern_files: string[];
  zusatz_kategorien: Record<string, string[]>;
  temp_ordner: string;
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
  path: string;    // relative to BUSINESS_DIR
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
  const absPath = join(BUSINESS_DIR, relativePath);
  if (!existsSync(absPath)) {
    return { path: relativePath, exists: false, tokens: 0 };
  }
  const content = readFileSync(absPath, 'utf-8');
  return { path: relativePath, exists: true, tokens: estimateTokens(content) };
}

function readFileContent(relativePath: string): string | null {
  const absPath = join(BUSINESS_DIR, relativePath);
  if (!existsSync(absPath)) return null;
  return readFileSync(absPath, 'utf-8');
}

function readTempFiles(tempDir: string): Array<{ name: string; content: string }> {
  if (!existsSync(tempDir)) return [];
  const files: Array<{ name: string; content: string }> = [];
  for (const entry of readdirSync(tempDir)) {
    // Skip HTML, logs, archives, READMEs
    if (/\.(html|log)$/i.test(entry)) continue;
    if (/^readme/i.test(entry)) continue;
    const fullPath = join(tempDir, entry);
    try {
      const stat = statSync(fullPath);
      if (!stat.isFile()) continue;
      files.push({ name: entry, content: readFileSync(fullPath, 'utf-8') });
    } catch {
      // skip unreadable files
    }
  }
  return files;
}

const SKIP_DIR = /^(_archive|archive|archiv|_archiv|reports|_reports)$/i;
const SKIP_FILE_EXT = /\.(html|log)$/i;
const SKIP_FILE_NAME = /^(readme|CLAUDE)/i;

/** Render the business directory tree as indented text for context injection */
function renderFileTreeText(absBase: string, relDir: string, indent: number = 0): string {
  const fullDir = join(absBase, relDir);
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(fullDir, { withFileTypes: true });
  } catch {
    return '';
  }

  const lines: string[] = [];
  const prefix = '  '.repeat(indent);

  // Sort: dirs first, then files
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
  } catch {
    return [];
  }

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
        const content = readFileSync(absPath, 'utf-8');
        tokens = estimateTokens(content);
      } catch { continue; }
      nodes.push({ type: 'file', name: entry.name, path: relPath, tokens, is_kern: kernSet.has(relPath) });
    }
  }

  // Dirs first, then files, both alpha-sorted
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
    throw new Error(`Context YAML not found: ${CONTEXT_YAML}`);
  }
  const raw = readFileSync(CONTEXT_YAML, 'utf-8');
  return yamlLoad(raw) as ContextYaml;
}

// --- GET /context ---
router.get('/context', (_req, res) => {
  try {
    const yaml = loadContextYaml();

    // Kern-files info
    const kernFiles = yaml.kern_files.map(f => readFileTokenInfo(f));
    const kernTokens = kernFiles.reduce((sum, f) => sum + f.tokens, 0);

    // Temp files
    const tempDir = yaml.temp_ordner || TEMP_DIR;
    const tempFiles = readTempFiles(tempDir);
    const tempTokens = tempFiles.reduce((sum, f) => sum + estimateTokens(f.content), 0);

    // Zusatz-Kategorien info
    const zusatz: Record<string, KategorieInfo> = {};
    for (const [key, paths] of Object.entries(yaml.zusatz_kategorien)) {
      const files = (paths as string[]).map(f => readFileTokenInfo(f));
      zusatz[key] = { files, totalTokens: files.reduce((s, f) => s + f.tokens, 0) };
    }

    res.json({
      kern_files: kernFiles,
      kern_tokens: kernTokens,
      zusatz_kategorien: zusatz,
      temp_files: tempFiles.map(f => ({ name: f.name, tokens: estimateTokens(f.content) })),
      temp_tokens: tempTokens,
      temp_dir: tempDir,
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

    // Check business dir first, then temp dir
    const absPath = join(BUSINESS_DIR, relPath);
    const tempPath = join(TEMP_DIR, relPath);

    let finalPath: string;
    if (existsSync(absPath) && absPath.startsWith(BUSINESS_DIR)) {
      finalPath = absPath;
    } else if (existsSync(tempPath) && tempPath.startsWith(TEMP_DIR)) {
      finalPath = tempPath;
    } else {
      res.status(404).json({ error: 'File not found' }); return;
    }

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
    const tree = buildFileTree(BUSINESS_DIR, '', kernSet);
    res.json({ tree });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Context documents go in the first USER MESSAGE, not the system prompt.
// This bypasses the Bridge's ~32k char system-prompt limit — user messages are unlimited.
// Token budget is generous; only warn if approaching model context window (200k).
// (SYSTEM_PROMPT_TOKEN_LIMIT defined at top of file)

// --- POST /load ---
// --- GET /session/active — check for persisted session ---
router.get('/session/active', (_req, res) => {
  const persisted = readPersistedSession();
  if (!persisted || !persisted.session_id || persisted.conversation === undefined) {
    return res.json({ active: false });
  }
  // Check if already loaded in memory
  const inMemory = SESSION_STORE.has(persisted.session_id);
  res.json({
    active: true,
    session_id: persisted.session_id,
    created_at: persisted.created_at,
    updated_at: persisted.updated_at,
    token_count: persisted.token_count,
    files_loaded: persisted.files_loaded,
    temp_files: persisted.temp_files,
    conversation_turns: persisted.conversation.length,
    in_memory: inMemory,
  });
});

// --- POST /session/end — archive current session ---
router.post('/session/end', (_req, res) => {
  const persisted = readPersistedSession();
  if (persisted && persisted.session_id) {
    SESSION_STORE.delete(persisted.session_id);
    deleteSnapshot(persisted.session_id);
    archiveSession(persisted);
    console.log(`[BusinessAngel] Session archived + snapshot deleted: ${persisted.session_id}`);
  }
  res.json({ ok: true });
});

// --- GET /sessions — list all archived sessions ---
router.get('/sessions', (_req, res) => {
  try {
    mkdirSync(SESSION_LOG_DIR, { recursive: true });
    const files = readdirSync(SESSION_LOG_DIR).filter(f => f.endsWith('.json')).sort().reverse();
    const sessions: Array<{
      id: string;
      title: string;
      created_at: number;
      updated_at: number;
      turns: number;
      filename: string;
    }> = [];

    for (const file of files) {
      try {
        const raw = readFileSync(join(SESSION_LOG_DIR, file), 'utf-8');
        const data = JSON.parse(raw) as PersistedSession;
        sessions.push({
          id: data.session_id,
          title: data.title || deriveSessionTitle(data.conversation),
          created_at: data.created_at,
          updated_at: data.updated_at,
          turns: data.conversation.length,
          filename: file,
        });
      } catch {
        // skip corrupt files
      }
    }

    res.json({ sessions });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /session/new — archive current + start fresh ---
router.post('/session/new', (_req, res) => {
  try {
    // Archive current active session if it exists and has conversation
    const persisted = readPersistedSession();
    if (persisted && persisted.session_id && persisted.conversation && persisted.conversation.length > 0) {
      // Ensure title is set before archiving
      if (!persisted.title) {
        persisted.title = deriveSessionTitle(persisted.conversation);
      }
      SESSION_STORE.delete(persisted.session_id);
      deleteSnapshot(persisted.session_id);
      archiveSession(persisted);
      console.log(`[BusinessAngel] Session archived before new: ${persisted.session_id}`);
    } else if (persisted?.session_id) {
      // Empty session — just clear it
      SESSION_STORE.delete(persisted.session_id);
      deleteSnapshot(persisted.session_id);
    }

    // Clear active session file
    writeFileSync(ACTIVE_SESSION_PATH, '', 'utf-8');

    res.json({ ok: true, archived: !!(persisted?.conversation?.length) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /session/load/:id — load a specific archived session ---
router.post('/session/load/:id', (req, res) => {
  try {
    const targetId = req.params.id;
    if (!targetId) {
      res.status(400).json({ error: 'session id required' });
      return;
    }

    mkdirSync(SESSION_LOG_DIR, { recursive: true });
    const files = readdirSync(SESSION_LOG_DIR).filter(f => f.endsWith('.json'));

    let found: PersistedSession | null = null;
    let foundFile = '';
    for (const file of files) {
      try {
        const raw = readFileSync(join(SESSION_LOG_DIR, file), 'utf-8');
        const data = JSON.parse(raw) as PersistedSession;
        if (data.session_id === targetId) {
          found = data;
          foundFile = file;
          break;
        }
      } catch {
        // skip
      }
    }

    if (!found) {
      res.status(404).json({ error: `Session not found: ${targetId}` });
      return;
    }

    // Archive current active session first (if exists and has content)
    const current = readPersistedSession();
    if (current && current.session_id && current.conversation && current.conversation.length > 0) {
      if (!current.title) {
        current.title = deriveSessionTitle(current.conversation);
      }
      SESSION_STORE.delete(current.session_id);
      archiveSession(current);
      console.log(`[BusinessAngel] Current session archived before load: ${current.session_id}`);
    } else if (current?.session_id) {
      SESSION_STORE.delete(current.session_id);
    }

    // Write the loaded session as the new active session
    writeFileSync(ACTIVE_SESSION_PATH, JSON.stringify(found, null, 2), 'utf-8');

    console.log(`[BusinessAngel] Session loaded from archive: ${targetId} (${foundFile})`);

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

// --- Snapshot API ---
// Immutable file-content snapshot for diff baseline. Created once per session,
// survives until session.finish(). Diffs are always computed against this snapshot.

interface Snapshot {
  sessionId: string;
  createdAt: string;
  files: Record<string, string>; // path → original content
}

function snapshotPath(sessionId: string): string {
  return join(SNAPSHOT_DIR, `${sessionId}.json`);
}

function readSnapshot(sessionId: string): Snapshot | null {
  const p = snapshotPath(sessionId);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as Snapshot;
  } catch {
    return null;
  }
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

// POST /snapshot — create immutable snapshot of file contents
router.post('/snapshot', (req, res) => {
  try {
    const { session_id, files } = req.body as {
      session_id: string;
      files: Record<string, string>;
    };

    if (!session_id) {
      res.status(400).json({ error: 'session_id required' });
      return;
    }
    if (!files || typeof files !== 'object' || Object.keys(files).length === 0) {
      res.status(400).json({ error: 'files required (Record<path, content>)' });
      return;
    }

    // Immutable: if snapshot already exists for this session, reject
    const existing = readSnapshot(session_id);
    if (existing) {
      res.status(409).json({
        error: 'Snapshot already exists for this session (immutable until finish)',
        file_count: Object.keys(existing.files).length,
        created_at: existing.createdAt,
      });
      return;
    }

    const snapshot: Snapshot = {
      sessionId: session_id,
      createdAt: new Date().toISOString(),
      files,
    };
    writeSnapshot(snapshot);

    console.log(`[BusinessAngel] Snapshot created: ${session_id} (${Object.keys(files).length} files)`);
    res.json({ ok: true, file_count: Object.keys(files).length, created_at: snapshot.createdAt });
  } catch (err: any) {
    console.error('[BusinessAngel] /snapshot POST error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /snapshot — read snapshot for a session
router.get('/snapshot', (req, res) => {
  try {
    const session_id = req.query.session_id as string;
    if (!session_id) {
      res.status(400).json({ error: 'session_id query param required' });
      return;
    }

    const snapshot = readSnapshot(session_id);
    if (!snapshot) {
      res.status(404).json({ error: 'No snapshot found for this session' });
      return;
    }

    res.json(snapshot);
  } catch (err: any) {
    console.error('[BusinessAngel] /snapshot GET error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/load', async (req, res) => {
  try {
    const { zusatz = [], extra_files = [], restore = false } = req.body as {
      zusatz?: string[];
      extra_files?: string[];
      restore?: boolean;
    };

    const yaml = loadContextYaml();
    const tempDir = yaml.temp_ordner || TEMP_DIR;
    const kernSet = new Set<string>(yaml.kern_files);

    // Template overhead (instructions, section headers, rules)
    const TEMPLATE_OVERHEAD = 300;
    let budget = SYSTEM_PROMPT_TOKEN_LIMIT - TEMPLATE_OVERHEAD;

    // 1. Collect kern content — highest priority, included first
    const kernSections: string[] = [];
    const kernExcluded: string[] = [];
    let filesLoaded = 0;
    let totalTokens = 0;

    for (const relPath of yaml.kern_files) {
      const content = readFileContent(relPath);
      if (!content) {
        console.warn(`[BusinessAngel] Kern-file not found: ${relPath}`);
        continue;
      }
      const tokens = estimateTokens(content);
      if (tokens > budget) {
        kernExcluded.push(relPath);
        console.warn(`[BusinessAngel] Kern-file excluded (budget): ${relPath} (${tokens} tokens)`);
        continue;
      }
      kernSections.push(`### ${relPath}\n\n${content}`);
      filesLoaded++;
      totalTokens += tokens;
      budget -= tokens;
    }

    // 2. Collect temp files — second priority (most recent context)
    const tempFiles = readTempFiles(tempDir);
    const tempSections: string[] = [];
    const tempExcluded: string[] = [];
    for (const f of tempFiles) {
      const tokens = estimateTokens(f.content);
      if (tokens > budget) {
        tempExcluded.push(f.name);
        console.warn(`[BusinessAngel] Temp-file excluded (budget): ${f.name} (${tokens} tokens)`);
        continue;
      }
      tempSections.push(`### ${f.name}\n\n${f.content}`);
      filesLoaded++;
      totalTokens += tokens;
      budget -= tokens;
    }

    // 3. Collect zusatz content (category-based) + extra_files
    const zusatzSections: string[] = [];
    const loadedPaths = new Set<string>(yaml.kern_files);

    for (const key of zusatz) {
      const paths = yaml.zusatz_kategorien[key];
      if (!paths) {
        console.warn(`[BusinessAngel] Unknown zusatz category: ${key}`);
        continue;
      }
      for (const relPath of paths) {
        if (loadedPaths.has(relPath)) continue;
        const content = readFileContent(relPath);
        if (!content) continue;
        const tokens = estimateTokens(content);
        if (tokens > budget) continue; // silently skip if over budget
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
      if (!content) {
        console.warn(`[BusinessAngel] Extra file not found: ${relPath}`);
        continue;
      }
      const tokens = estimateTokens(content);
      if (tokens > budget) {
        console.warn(`[BusinessAngel] Extra file excluded (budget): ${relPath} (${tokens} tokens)`);
        continue;
      }
      zusatzSections.push(`### ${relPath}\n\n${content}`);
      loadedPaths.add(relPath);
      filesLoaded++;
      totalTokens += tokens;
      budget -= tokens;
    }

    const excluded = [...kernExcluded, ...tempExcluded];

    // 4. Assemble prompts
    // IMPORTANT: Large document context goes into the FIRST USER MESSAGE, not the system prompt.
    // Bridge's Claude Code SDK has a ~32k char limit on system messages, but user messages are unlimited.
    // The context is wrapped in <documents> tags so the model clearly distinguishes it from conversation.
    const systemPrompt = `Du bist ein strategischer Berater für WerkING Tools / Engelmann Data Energyneering.

Deine erste Nachricht enthält Kontext-Dokumente in <documents> Tags.
Lies diese Dokumente und verwende sie als einzige Wissensquelle.
Antworte NUR auf Rafaels Fragen — gib den Inhalt der Dokumente NICHT wieder.

REGELN:
- Verwende AUSSCHLIESSLICH was in den <documents> steht
- Erfinde keine Zahlen, Konditionen, Personen oder Deals
- Wenn du etwas nicht weißt: sag es direkt
- Wenn Rafael sagt "bau die Diffs" oder "Generiere Diffs": schreibe strukturierte Diff-Blöcke
  BEVORZUGTES Format für Änderungen an bestehenden Dateien:
    <<<DIFF pfad/zur/datei.md
    old_string: |
      ...exakter Text aus dem Original-Dokument...
    new_string: |
      ...neuer Text...
    >>>
  Format für NEUE Dateien:
    <<<NEW pfad/zur/neuen-datei.md
    content: |
      ...vollständiger Inhalt...
    >>>
  ALTERNATIVES Format (auch akzeptiert):
    FILE: <relativer Pfad ab business/>
    OLD:
    <Text aus dem Original>
    NEW:
    <Neuer Text>
- KRITISCH für old_string/OLD: Beziehe dich IMMER auf den ORIGINAL-Inhalt der Dateien (wie sie zu Beginn der Session geladen wurden), NICHT auf zwischenzeitliche Änderungen
- KRITISCH: Genug Kontext-Zeilen für eindeutigen Match
- Mehrere Diff-Blöcke pro Datei sind erlaubt
- Bei neuen Dateien: <<<NEW verwenden mit vollständigem Inhalt
- Nur die betroffenen Abschnitte liefern, nicht das gesamte Dokument
- PFADE: Der <dateibaum> Block enthält die aktuelle Ordnerstruktur. Verwende IMMER existierende Pfade und Namenskonventionen daraus. Für neue Dateien: orientiere dich am Namensschema der Nachbar-Dateien im gleichen Ordner.`;

    // Build file tree text for context injection (so Angel knows all paths)
    const fileTreeText = renderFileTreeText(BUSINESS_DIR, '');
    const fileTreeTokens = estimateTokens(fileTreeText);
    console.log(`[BusinessAngel] File tree injected (~${fileTreeTokens} tokens)`);

    // Context wrapped in <documents> tags — clearly not part of the conversation
    const contextMessage = `<documents>

<dateibaum description="Aktuelle Ordnerstruktur von /root/projekte/werkingflow-business/ — verwende diese Pfade wenn du neue Dateien erstellst oder bestehende referenzierst">
${fileTreeText}
</dateibaum>

<kern_business_docs>
${kernSections.join('\n\n---\n\n')}
</kern_business_docs>

${tempSections.length > 0 ? `<temp_ordner>
${tempSections.join('\n\n---\n\n')}
</temp_ordner>` : ''}

${zusatzSections.length > 0 ? `<zusatz_kontext>
${zusatzSections.join('\n\n---\n\n')}
</zusatz_kontext>` : ''}

</documents>

Dokumente geladen (${filesLoaded} Dateien). Bitte stelle mir deine Fragen.`;

    // Pre-seeded history: context in user message, minimal ack from assistant
    // On restore: append previous conversation turns after the pre-seed
    const persisted = restore ? readPersistedSession() : null;
    const restoredConversation: ChatMessage[] = persisted?.conversation ?? [];

    // KRITISCH: Wenn restore=false und eine andere aktive Session mit Inhalt existiert,
    // MUSS diese zuerst archiviert werden — sonst geht die Konversation verloren!
    if (!restore) {
      const currentActive = readPersistedSession();
      if (currentActive
          && currentActive.session_id
          && currentActive.conversation
          && currentActive.conversation.length > 0) {
        if (!currentActive.title) {
          currentActive.title = deriveSessionTitle(currentActive.conversation);
        }
        SESSION_STORE.delete(currentActive.session_id);
        deleteSnapshot(currentActive.session_id);
        archiveSession(currentActive);
        console.log(`[BusinessAngel] /load: Auto-archived stale active session ${currentActive.session_id.slice(0, 8)} (${currentActive.conversation.length} turns) before starting fresh`);
      }
    }

    const initialHistory: ChatMessage[] = [
      { role: 'user', content: contextMessage },
      { role: 'assistant', content: 'Verstanden. Dokumente geladen und bereit.' },
      ...restoredConversation,
    ];

    // 5. Create in-memory chat session
    const session_id = persisted?.session_id ?? randomUUID();
    const newSession: ChatSession = {
      session_id,
      system_prompt: systemPrompt,
      history: initialHistory,
      created_at: persisted?.created_at ?? Date.now(),
      token_count: totalTokens,
      files_loaded: filesLoaded,
      temp_files: tempFiles.map(f => f.name),
      zusatz_loaded: zusatz,
    };
    SESSION_STORE.set(session_id, newSession);
    writePersistedSession(newSession);

    // 6. Create immutable snapshot for diff baseline (only on fresh session, not restore)
    if (!restore || !readSnapshot(session_id)) {
      const snapshotFiles: Record<string, string> = {};
      // Collect all loaded file contents for the snapshot
      for (const relPath of loadedPaths) {
        const content = readFileContent(relPath);
        if (content) snapshotFiles[relPath] = content;
      }
      // Also include temp files
      for (const tf of tempFiles) {
        snapshotFiles[`temp/${tf.name}`] = tf.content;
      }
      if (Object.keys(snapshotFiles).length > 0) {
        // Delete old snapshot if exists (fresh session)
        if (!restore) deleteSnapshot(session_id);
        const snapshot: Snapshot = {
          sessionId: session_id,
          createdAt: new Date().toISOString(),
          files: snapshotFiles,
        };
        writeSnapshot(snapshot);
        console.log(`[BusinessAngel] Snapshot auto-created: ${session_id} (${Object.keys(snapshotFiles).length} files)`);
      }
    }

    const action = restore && restoredConversation.length > 0 ? 'restored' : 'created';
    console.log(`[BusinessAngel] Session ${action}: ${session_id} (${filesLoaded} files, ~${totalTokens} tokens, ${restoredConversation.length} turns restored)`);

    res.json({
      ok: true,
      session_id,
      token_count: totalTokens,
      files_loaded: filesLoaded,
      temp_files: tempSections.map(s => s.split('\n')[0].replace('### ', '')),
      zusatz_loaded: zusatz,
      excluded: excluded.length > 0 ? excluded : undefined,
      token_limit: SYSTEM_PROMPT_TOKEN_LIMIT,
      restored: restore && restoredConversation.length > 0,
      conversation_turns: restoredConversation.length,
      conversation: restore && restoredConversation.length > 0 ? restoredConversation : undefined,
    });
  } catch (err: any) {
    console.error('[BusinessAngel] /load error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- POST /chat ---
router.post('/chat', async (req, res) => {
  try {
    const { session_id, message } = req.body as { session_id: string; message: string };

    if (!session_id) {
      res.status(400).json({ error: 'session_id required' });
      return;
    }
    if (!message?.trim()) {
      res.status(400).json({ error: 'message required' });
      return;
    }

    const session = getOrRestoreSession(session_id);
    if (!session) {
      res.status(404).json({ error: `Session not found: ${session_id}. Bitte Session neu laden.` });
      return;
    }

    // Build messages for Bridge call
    const messages: ChatMessage[] = [
      ...session.history,
      { role: 'user', content: message.trim() },
    ];

    console.log(`[BusinessAngel] /chat session=${session_id.slice(0, 8)} history=${session.history.length} msg_len=${message.length} sys_len=${session.system_prompt.length}`);

    const responseText = await bridgeChat({
      messages: [
        { role: 'system', content: session.system_prompt },
        ...messages,
      ],
    });

    // Update history
    session.history.push({ role: 'user', content: message.trim() });
    session.history.push({ role: 'assistant', content: responseText });

    // Persist to disk after every message
    writePersistedSession(session);

    console.log(`[BusinessAngel] /chat response: ${responseText.length} chars`);

    res.json({ ok: true, response: responseText, session_id });
  } catch (err: any) {
    console.error('[BusinessAngel] /chat error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- POST /apply-diffs ---
router.post('/apply-diffs', (req, res) => {
  try {
    const { diffs, raw_text, dry_run = false } = req.body as {
      diffs?: Array<{ file: string; old: string; newText: string }>;
      raw_text?: string;
      dry_run?: boolean;
    };

    // Accept either pre-parsed diffs or raw AI text to parse
    const resolvedDiffs = diffs || (raw_text ? parseDiffs(raw_text) : []);

    if (!resolvedDiffs.length) {
      res.status(400).json({ error: 'No diffs provided. Pass diffs[] or raw_text.' });
      return;
    }

    if (!dry_run) ensureDir(BACKUP_DIR);

    const applied: string[] = [];
    const failed: Array<{ file: string; reason: string }> = [];

    const datePrefix = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    for (const diff of resolvedDiffs) {
      const absPath = join(BUSINESS_DIR, diff.file);

      // New file: OLD is empty → create file with NEW content
      if (!diff.old.trim()) {
        if (existsSync(absPath)) {
          failed.push({ file: diff.file, reason: 'NEW FILE: file already exists (use OLD/NEW diff to modify)' });
          continue;
        }
        if (dry_run) { applied.push(diff.file); continue; }
        ensureDir(dirname(absPath));
        writeFileSync(absPath, diff.newText, 'utf-8');
        applied.push(diff.file);
        continue;
      }

      // Existing file: validate it exists
      if (!existsSync(absPath)) {
        failed.push({ file: diff.file, reason: 'File not found' });
        continue;
      }

      const current = readFileSync(absPath, 'utf-8');

      // Normalize: trim trailing spaces per line (AI often produces slightly different whitespace in tables)
      const normalizeWs = (s: string) =>
        s.replace(/\r\n/g, '\n').split('\n').map(l => l.trimEnd()).join('\n');

      // Try to build the replacement — prefer exact match, fall back to normalized match, then section-level
      let updated: string | null = null;

      if (current.includes(diff.old)) {
        // 1. Exact match: straight replace (first occurrence)
        updated = current.replace(diff.old, diff.newText);
      } else {
        // 2. Normalized match: trim trailing whitespace from each line before comparing
        const normCurrent = normalizeWs(current);
        const normOld = normalizeWs(diff.old);
        if (normCurrent.includes(normOld)) {
          updated = normCurrent.replace(normOld, normalizeWs(diff.newText));
        } else {
          // 3. Section-level replace: if OLD is a bare ## heading, replace from that heading
          // to the next heading of same or higher level
          const headingMatch = diff.old.trim().match(/^(#{1,6})\s+(.+)$/);
          if (headingMatch) {
            const level = headingMatch[1].length;
            // Regex: from this heading to next heading of same/higher level (or EOF)
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
        failed.push({ file: diff.file, reason: 'OLD text not found in file (exact match and section-level both failed)' });
        continue;
      }

      if (dry_run) {
        // Validation only — don't write anything
        applied.push(diff.file);
        continue;
      }

      // Backup
      const backupName = `${datePrefix}_${basename(diff.file)}`;
      const backupPath = join(BACKUP_DIR, backupName);
      const finalBackupPath = existsSync(backupPath)
        ? `${backupPath}.${Date.now()}`
        : backupPath;
      writeFileSync(finalBackupPath, current, 'utf-8');

      writeFileSync(absPath, updated, 'utf-8');

      applied.push(diff.file);
    }

    res.json({
      ok: true,
      dry_run,
      applied,
      failed,
      backup_dir: dry_run ? null : BACKUP_DIR,
    });
  } catch (err: any) {
    console.error('[BusinessAngel] /apply-diffs error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
