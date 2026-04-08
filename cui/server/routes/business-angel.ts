// =============================================================================
// Business Angel Chat v2 — Context-loaded AI conversation with diff output
// =============================================================================
// GET  /api/business-angel/context     → read YAML config, return categories + token estimates
// POST /api/business-angel/load        → assemble system prompt, create in-memory chat session
// POST /api/business-angel/chat        → send message to AI Bridge, maintain history
// POST /api/business-angel/apply-diffs → validate + backup + apply FILE/OLD/NEW diffs
// =============================================================================

import { Router } from 'express';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'fs';
import { randomUUID } from 'crypto';
import { join, basename } from 'path';
import { load as yamlLoad } from 'js-yaml';
import { PATHS } from '../config/paths.js';
import { parseDiffs } from '../lib/diff-parser.js';

const router = Router();

// --- Constants ---
const BUSINESS_DIR = PATHS.businessDir;
const CONTEXT_YAML = '/root/projekte/local-storage/report-builder/business-angel-context.yaml';
const BACKUP_DIR   = '/root/projekte/local-storage/report-builder/backups';
const TEMP_DIR     = '/root/projekte/local-storage/report-builder/temp';

// Approx tokens per character (rough estimate for German/English mixed text)
const CHARS_PER_TOKEN = 4;

// --- Session Store (in-memory) ---
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

const SESSION_STORE = new Map<string, ChatSession>();

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

// --- POST /load ---
router.post('/load', async (req, res) => {
  try {
    const { zusatz = [] } = req.body as {
      zusatz?: string[];
    };

    const yaml = loadContextYaml();
    const tempDir = yaml.temp_ordner || TEMP_DIR;

    // 1. Collect kern content
    const kernSections: string[] = [];
    let filesLoaded = 0;
    let totalTokens = 0;

    for (const relPath of yaml.kern_files) {
      const content = readFileContent(relPath);
      if (!content) {
        console.warn(`[BusinessAngel] Kern-file not found: ${relPath}`);
        continue;
      }
      kernSections.push(`### ${relPath}\n\n${content}`);
      filesLoaded++;
      totalTokens += estimateTokens(content);
    }

    // 2. Collect zusatz content
    const zusatzSections: string[] = [];
    for (const key of zusatz) {
      const paths = yaml.zusatz_kategorien[key];
      if (!paths) {
        console.warn(`[BusinessAngel] Unknown zusatz category: ${key}`);
        continue;
      }
      for (const relPath of paths) {
        const content = readFileContent(relPath);
        if (!content) continue;
        zusatzSections.push(`### ${relPath}\n\n${content}`);
        filesLoaded++;
        totalTokens += estimateTokens(content);
      }
    }

    // 3. Collect temp files
    const tempFiles = readTempFiles(tempDir);
    const tempSections: string[] = tempFiles.map(f => `### ${f.name}\n\n${f.content}`);
    for (const f of tempFiles) {
      filesLoaded++;
      totalTokens += estimateTokens(f.content);
    }

    // 4. Assemble system prompt
    const systemPrompt = `Du bist ein strategischer Berater für WerkING Tools / Engelmann Data Energyneering.

KONTEXT:
Die folgenden Dateien sind deine einzige Informationsquelle.
Du hast kein Gedächtnis über diese Dokumente hinaus.

STANDINFORMATIONEN (Kern-Business-Docs):
${kernSections.join('\n\n---\n\n')}

${tempSections.length > 0 ? `NEUE INFORMATIONEN (Temp-Ordner):
${tempSections.join('\n\n---\n\n')}` : 'NEUE INFORMATIONEN (Temp-Ordner): Keine Dateien im Temp-Ordner.'}

${zusatzSections.length > 0 ? `ZUSATZ-KONTEXT (gewählt für diese Session):
${zusatzSections.join('\n\n---\n\n')}` : ''}

---

REGELN:
- Verwende AUSSCHLIESSLICH was in den obigen Dokumenten steht
- Erfinde keine Zahlen, Konditionen, Personen oder Deals
- Wenn du etwas nicht weißt: sag es direkt
- Wenn Rafael sagt "bau die Diffs": schreibe Edit-Befehle für die betroffenen Dateien
  Format pro Änderung:
    FILE: <relativer Pfad ab business/>
    OLD: <exakter Originaltext>
    NEW: <neuer Text>
- Keine ganzen Dokumente umschreiben — nur was sich wirklich ändert`;

    // 5. Create in-memory chat session (no CUI session)
    const session_id = randomUUID();
    SESSION_STORE.set(session_id, {
      session_id,
      system_prompt: systemPrompt,
      history: [],
      created_at: Date.now(),
      token_count: totalTokens,
      files_loaded: filesLoaded,
      temp_files: tempFiles.map(f => f.name),
      zusatz_loaded: zusatz,
    });

    console.log(`[BusinessAngel] Session created: ${session_id} (${filesLoaded} files, ~${totalTokens} tokens)`);

    res.json({
      ok: true,
      session_id,
      token_count: totalTokens,
      files_loaded: filesLoaded,
      temp_files: tempFiles.map(f => f.name),
      zusatz_loaded: zusatz,
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

    const BRIDGE_URL = process.env.AI_BRIDGE_URL;
    const BRIDGE_API_KEY = process.env.AI_BRIDGE_API_KEY;

    if (!BRIDGE_URL) throw new Error('AI_BRIDGE_URL not set');
    if (!BRIDGE_API_KEY) throw new Error('AI_BRIDGE_API_KEY not set');

    // Build messages for Bridge call
    const messages: ChatMessage[] = [
      ...session.history,
      { role: 'user', content: message.trim() },
    ];

    console.log(`[BusinessAngel] /chat session=${session_id.slice(0, 8)} history=${session.history.length} msg_len=${message.length}`);

    const bridgeResp = await fetch(`${BRIDGE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${BRIDGE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 8192,
        messages: [
          { role: 'system', content: session.system_prompt },
          ...messages,
        ],
      }),
      signal: AbortSignal.timeout(300000), // 5min timeout
    });

    if (!bridgeResp.ok) {
      const errText = await bridgeResp.text();
      throw new Error(`Bridge API ${bridgeResp.status}: ${errText}`);
    }

    const data = await bridgeResp.json() as { choices?: Array<{ message?: { content?: string } }> };
    const responseText = data.choices?.[0]?.message?.content;
    if (!responseText) throw new Error('Bridge returned empty response');

    // Update history
    session.history.push({ role: 'user', content: message.trim() });
    session.history.push({ role: 'assistant', content: responseText });

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
    const { diffs, raw_text } = req.body as {
      diffs?: Array<{ file: string; old: string; newText: string }>;
      raw_text?: string;
    };

    // Accept either pre-parsed diffs or raw AI text to parse
    const resolvedDiffs = diffs || (raw_text ? parseDiffs(raw_text) : []);

    if (!resolvedDiffs.length) {
      res.status(400).json({ error: 'No diffs provided. Pass diffs[] or raw_text.' });
      return;
    }

    ensureDir(BACKUP_DIR);

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

      // Backup
      const backupName = `${datePrefix}_${basename(diff.file)}`;
      const backupPath = join(BACKUP_DIR, backupName);
      // Append suffix if backup already exists
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
      applied,
      failed,
      backup_dir: BACKUP_DIR,
    });
  } catch (err: any) {
    console.error('[BusinessAngel] /apply-diffs error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
