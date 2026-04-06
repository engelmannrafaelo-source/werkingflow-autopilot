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
import { join, basename, relative } from 'path';
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

// Approx tokens per character (rough estimate for German/English mixed text)
const CHARS_PER_TOKEN = 4;

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

function writePersistedSession(session: ChatSession): void {
  // conversation = history minus the first 2 pre-seeded context messages
  const conversation = session.history.slice(2);
  const data: PersistedSession = {
    session_id: session.session_id,
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
const SYSTEM_PROMPT_TOKEN_LIMIT = 180000;

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
    archiveSession(persisted);
    console.log(`[BusinessAngel] Session archived: ${persisted.session_id}`);
  }
  res.json({ ok: true });
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
- Wenn Rafael sagt "bau die Diffs": schreibe Edit-Befehle für die betroffenen Dateien
  Format pro Änderung:
    FILE: <relativer Pfad ab business/>
    OLD: <exakter Originaltext>
    NEW: <neuer Text>
- Keine ganzen Dokumente umschreiben — nur was sich wirklich ändert`;

    // Context wrapped in <documents> tags — clearly not part of the conversation
    const contextMessage = `<documents>

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

    const session = SESSION_STORE.get(session_id);
    if (!session) {
      res.status(404).json({ error: `Session not found: ${session_id}` });
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

      // Validate file exists
      if (!existsSync(absPath)) {
        failed.push({ file: diff.file, reason: 'File not found' });
        continue;
      }

      const current = readFileSync(absPath, 'utf-8');

      // Validate old text exists exactly in file
      if (!current.includes(diff.old)) {
        failed.push({ file: diff.file, reason: 'OLD text not found in file (exact match required)' });
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

      // Apply diff (replace first occurrence)
      const updated = current.replace(diff.old, diff.newText);
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
