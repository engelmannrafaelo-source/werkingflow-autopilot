// =============================================================================
// Business Angel Chat v2 — Context-loaded AI conversation with diff output
// =============================================================================
// GET  /api/business-angel/context     → read YAML config, return categories + token estimates
// GET  /api/business-angel/files       → full file tree of business dir with token counts
// POST /api/business-angel/load        → assemble system prompt, create in-memory chat session
// POST /api/business-angel/chat        → send message to AI Bridge, maintain history
// POST /api/business-angel/apply-diffs → validate + backup + apply FILE/OLD/NEW diffs
// =============================================================================

import { Router, type Response } from 'express';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, renameSync, unlinkSync } from 'fs';
import { randomUUID, createHash } from 'crypto';
import { join, basename, dirname, relative } from 'path';
import { load as yamlLoad } from 'js-yaml';
import chokidar from 'chokidar';
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
const DIARY_BASE_DIR = '/root/projekte/local-storage/diary';
const DIARY_DAILY_DAYS_DEFAULT  = 14;
const DIARY_WEEKLY_DAYS_DEFAULT = 60;

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
  latestDiaryKey: number; // sortKey of newest diary entry injected in context
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
/**
 * Re-read disk diary; if newer entries exist than what was loaded into the
 * session's <verlauf> block, regenerate the block in-place. This makes a
 * resumed long-lived session pick up newly-written daily entries without
 * forcing a full /load.
 *
 * Cheap path when nothing changed: just compares sort keys, no rewrites.
 */
function refreshDiaryIfStale(session: ChatSession): void {
  try {
    const yaml = loadContextYaml();
    const diary = loadDiaryPyramid(yaml.tagebuch);
    const newestDiskKey = diary.entries.reduce((max, e) => Math.max(max, e.sortKey), 0);
    if (newestDiskKey <= (session.latestDiaryKey ?? 0)) return;

    // Render the full pyramid again (token-budget aware would require recomputing
    // the whole prompt; a simpler approach is to just re-render and accept that
    // the budget for the diary section might have shifted slightly).
    const sorted = [...diary.entries].sort((a, b) => a.sortKey - b.sortKey);
    const newSection = renderDiarySection(sorted);
    if (!newSection) return;

    // Replace the existing <verlauf>...</verlauf> block in the very first
    // user message (which carries the <documents> with <verlauf> inside).
    const firstUser = session.history.find(m => m.role === 'user');
    if (!firstUser) return;
    const re = /<verlauf[^>]*>[\s\S]*?<\/verlauf>/;
    if (!re.test(firstUser.content)) return;
    firstUser.content = firstUser.content.replace(
      re,
      `<verlauf description="Rafaels Arbeits-Tagebuch — chronologischer Verlauf. Pyramide: jüngste Tage täglich, ältere wochenweise, sehr alte monatlich. Quelle und Erzeugung: /root/projekte/local-storage/diary/CONVENTION.md">\n${newSection}\n</verlauf>`
    );
    session.latestDiaryKey = newestDiskKey;
    console.log(`[BusinessAngel] Diary refreshed for session ${session.session_id.slice(0, 8)} (new latestDiaryKey=${newestDiskKey})`);
  } catch (err: any) {
    console.warn(`[BusinessAngel] refreshDiaryIfStale failed: ${err.message}`);
  }
}

function getOrRestoreSession(session_id: string): ChatSession | null {
  const existing = SESSION_STORE.get(session_id);
  if (existing) {
    refreshDiaryIfStale(existing);
    return existing;
  }

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

    // Tagebuch-Pyramide auch beim Auto-Restore neu aufbauen
    const diaryRestore = loadDiaryPyramid(yaml.tagebuch);
    const diaryIncluded: DiaryEntry[] = [];
    for (const e of [...diaryRestore.entries].sort((a, b) => b.sortKey - a.sortKey)) {
      if (e.tokens > budget) continue;
      diaryIncluded.push(e);
      filesLoaded++;
      totalTokens += e.tokens;
      budget -= e.tokens;
    }
    diaryIncluded.sort((a, b) => a.sortKey - b.sortKey);
    const diarySectionRestore = renderDiarySection(diaryIncluded);

    const systemPrompt = `Du bist ein strategischer Berater für WerkING Tools / Engelmann Data Energyneering.

Deine erste Nachricht enthält Kontext-Dokumente in <documents> Tags.
Lies diese Dokumente und verwende sie als einzige Wissensquelle.
Antworte NUR auf Rafaels Fragen — gib den Inhalt der Dokumente NICHT wieder.

REGELN:
- Verwende AUSSCHLIESSLICH was in den <documents> steht
- Erfinde keine Zahlen, Konditionen, Personen oder Deals
- Wenn du etwas nicht weißt: sag es direkt
- Wenn Rafael sagt "bau die Diffs" oder "Generiere Diffs": schreibe Diff-Blöcke im folgenden Format:
  FORMAT (für neue UND bestehende Dateien — immer gleich):
    FILE: <relativer Pfad ab business/>
    NEW:
    <VOLLSTÄNDIGER neuer Inhalt der Datei>
- KRITISCH: Schreibe IMMER den KOMPLETTEN Dateiinhalt in NEW — nie nur den geänderten Abschnitt
- Mehrere FILE/NEW Blöcke pro Antwort sind erlaubt
- Falls ein [KONTEXT-UPDATE] in der Konversation erscheint: Verwende diesen aktuellen Stand als Basis für weitere Änderungen
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

${diarySectionRestore ? `<verlauf description="Rafaels Arbeits-Tagebuch — chronologischer Verlauf. Pyramide: jüngste Tage täglich, ältere wochenweise, sehr alte monatlich. Quelle und Erzeugung: /root/projekte/local-storage/diary/CONVENTION.md">
${diarySectionRestore}
</verlauf>` : ''}

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
      latestDiaryKey: diaryIncluded.reduce((max, e) => Math.max(max, e.sortKey), 0),
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
interface DiaryConfig {
  base_dir?: string;
  daily_days?: number;
  weekly_days?: number;
}

interface ContextYaml {
  kern_files: string[];
  zusatz_kategorien: Record<string, string[]>;
  temp_ordner: string;
  tagebuch?: DiaryConfig;
}

interface DiaryEntry {
  type: 'daily' | 'weekly' | 'monthly';
  name: string;        // filename (e.g. 2026-04-28.md, 2026-W17.md, 2026-04.md)
  label: string;       // human-friendly date label (e.g. 2026-04-28, 2026 KW17, 2026-04)
  sortKey: number;     // unix ms — used to order chronologically
  content: string;
  tokens: number;
}

interface DiaryStats {
  daily_count: number;
  weekly_count: number;
  monthly_count: number;
  total_tokens: number;
  latest_daily: string | null;
  base_dir: string;
  config: { daily_days: number; weekly_days: number };
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

/** Sunday (week-end) of an ISO 8601 week as unix-ms. Jan 4 is always in ISO week 1. */
function isoWeekEndMs(year: number, week: number): number {
  const jan4 = new Date(year, 0, 4);
  const jan4Day = jan4.getDay() || 7; // ISO: Sun=7
  const mondayWeek1 = new Date(year, 0, 4 - (jan4Day - 1));
  const sunday = new Date(mondayWeek1);
  sunday.setDate(mondayWeek1.getDate() + (week - 1) * 7 + 6);
  return sunday.getTime();
}

/**
 * Load the diary pyramid: 0..daily_days days → daily files, daily..weekly_days → weekly,
 * older → monthly. Returns entries sorted chronologically (oldest first) for prompt rendering.
 * Reads silently if dirs are missing — diary is optional.
 */
function loadDiaryPyramid(cfg: DiaryConfig | undefined): { entries: DiaryEntry[]; stats: DiaryStats } {
  const baseDir   = cfg?.base_dir   || DIARY_BASE_DIR;
  const dailyDays  = cfg?.daily_days  ?? DIARY_DAILY_DAYS_DEFAULT;
  const weeklyDays = cfg?.weekly_days ?? DIARY_WEEKLY_DAYS_DEFAULT;
  const todayMs = Date.now();
  const DAY = 86_400_000;

  const daily:   DiaryEntry[] = [];
  const weekly:  DiaryEntry[] = [];
  const monthly: DiaryEntry[] = [];

  // Daily — files named YYYY-MM-DD.md
  const dailyDir = join(baseDir, 'daily');
  if (existsSync(dailyDir)) {
    for (const f of readdirSync(dailyDir)) {
      const m = /^(\d{4})-(\d{2})-(\d{2})\.md$/.exec(f);
      if (!m) continue;
      const dateMs = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00`).getTime();
      if (Number.isNaN(dateMs)) continue;
      const ageDays = (todayMs - dateMs) / DAY;
      if (ageDays < 0 || ageDays > dailyDays) continue;
      try {
        const content = readFileSync(join(dailyDir, f), 'utf-8');
        daily.push({
          type: 'daily',
          name: f,
          label: `${m[1]}-${m[2]}-${m[3]}`,
          sortKey: dateMs,
          content,
          tokens: estimateTokens(content),
        });
      } catch { /* skip unreadable */ }
    }
  }

  // Weekly — files named YYYY-Www.md (ISO week)
  const weeklyDir = join(baseDir, 'weekly');
  if (existsSync(weeklyDir)) {
    for (const f of readdirSync(weeklyDir)) {
      const m = /^(\d{4})-W(\d{1,2})\.md$/.exec(f);
      if (!m) continue;
      const year = parseInt(m[1], 10);
      const week = parseInt(m[2], 10);
      const weekEndMs = isoWeekEndMs(year, week);
      const ageDays = (todayMs - weekEndMs) / DAY;
      if (ageDays <= dailyDays || ageDays > weeklyDays) continue;
      try {
        const content = readFileSync(join(weeklyDir, f), 'utf-8');
        weekly.push({
          type: 'weekly',
          name: f,
          label: `${m[1]} KW${m[2].padStart(2, '0')}`,
          sortKey: weekEndMs,
          content,
          tokens: estimateTokens(content),
        });
      } catch { /* skip unreadable */ }
    }
  }

  // Monthly — files named YYYY-MM.md
  const monthlyDir = join(baseDir, 'monthly');
  if (existsSync(monthlyDir)) {
    for (const f of readdirSync(monthlyDir)) {
      const m = /^(\d{4})-(\d{2})\.md$/.exec(f);
      if (!m) continue;
      const year  = parseInt(m[1], 10);
      const month = parseInt(m[2], 10);
      const monthEndMs = new Date(year, month, 0).getTime(); // day 0 of next month = last day of this month
      const ageDays = (todayMs - monthEndMs) / DAY;
      if (ageDays <= weeklyDays) continue;
      try {
        const content = readFileSync(join(monthlyDir, f), 'utf-8');
        monthly.push({
          type: 'monthly',
          name: f,
          label: `${m[1]}-${m[2]}`,
          sortKey: monthEndMs,
          content,
          tokens: estimateTokens(content),
        });
      } catch { /* skip unreadable */ }
    }
  }

  // Latest daily for stats (descending order → first)
  const latestDaily = daily.length > 0
    ? [...daily].sort((a, b) => b.sortKey - a.sortKey)[0].label
    : null;

  // Render order: chronological (oldest → newest), monthly → weekly → daily within their bands
  const entries: DiaryEntry[] = [
    ...monthly.sort((a, b) => a.sortKey - b.sortKey),
    ...weekly .sort((a, b) => a.sortKey - b.sortKey),
    ...daily  .sort((a, b) => a.sortKey - b.sortKey),
  ];

  const totalTokens = entries.reduce((s, e) => s + e.tokens, 0);

  return {
    entries,
    stats: {
      daily_count: daily.length,
      weekly_count: weekly.length,
      monthly_count: monthly.length,
      total_tokens: totalTokens,
      latest_daily: latestDaily,
      base_dir: baseDir,
      config: { daily_days: dailyDays, weekly_days: weeklyDays },
    },
  };
}

/** Render diary entries as a single block for the system prompt. */
function renderDiarySection(entries: DiaryEntry[]): string {
  if (entries.length === 0) return '';
  const headerByType: Record<DiaryEntry['type'], string> = {
    monthly: 'Monats-Rollup',
    weekly:  'Wochen-Rollup',
    daily:   'Tag',
  };
  return entries
    .map(e => `### ${headerByType[e.type]} ${e.label}\n\n${e.content.trim()}`)
    .join('\n\n---\n\n');
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

    // Tagebuch-Pyramide — Status (nicht geladen, nur Übersicht)
    const diary = loadDiaryPyramid(yaml.tagebuch);

    res.json({
      kern_files: kernFiles,
      kern_tokens: kernTokens,
      zusatz_kategorien: zusatz,
      temp_files: tempFiles.map(f => ({ name: f.name, tokens: estimateTokens(f.content) })),
      temp_tokens: tempTokens,
      temp_dir: tempDir,
      tagebuch: diary.stats,
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

    // 3. Tagebuch-Pyramide — historischer Verlauf, automatisch aus local-storage/diary
    const diary = loadDiaryPyramid(yaml.tagebuch);
    const diaryEntriesIncluded: DiaryEntry[] = [];
    // Walk newest → oldest so the most recent entries survive a tight budget.
    const diaryByRecency = [...diary.entries].sort((a, b) => b.sortKey - a.sortKey);
    for (const e of diaryByRecency) {
      if (e.tokens > budget) continue;
      diaryEntriesIncluded.push(e);
      filesLoaded++;
      totalTokens += e.tokens;
      budget -= e.tokens;
    }
    // Re-render in chronological order for prompt readability
    diaryEntriesIncluded.sort((a, b) => a.sortKey - b.sortKey);
    const diarySection = renderDiarySection(diaryEntriesIncluded);
    const diarySkippedCount = diary.entries.length - diaryEntriesIncluded.length;
    if (diarySkippedCount > 0) {
      console.warn(`[BusinessAngel] Tagebuch: ${diarySkippedCount} Eintrag/Einträge wegen Token-Budget übersprungen`);
    }

    // 4. Collect zusatz content (category-based) + extra_files
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
- Wenn Rafael sagt "bau die Diffs" oder "Generiere Diffs": schreibe Diff-Blöcke im folgenden Format:
  FORMAT (für neue UND bestehende Dateien — immer gleich):
    FILE: <relativer Pfad ab business/>
    NEW:
    <VOLLSTÄNDIGER neuer Inhalt der Datei>
- KRITISCH: Schreibe IMMER den KOMPLETTEN Dateiinhalt in NEW — nie nur den geänderten Abschnitt
- Mehrere FILE/NEW Blöcke pro Antwort sind erlaubt
- Falls ein [KONTEXT-UPDATE] in der Konversation erscheint: Verwende diesen aktuellen Stand als Basis für weitere Änderungen
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

${diarySection ? `<verlauf description="Rafaels Arbeits-Tagebuch — chronologischer Verlauf. Pyramide: jüngste Tage täglich, ältere wochenweise, sehr alte monatlich. Quelle und Erzeugung: /root/projekte/local-storage/diary/CONVENTION.md">
${diarySection}
</verlauf>` : ''}

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
      latestDiaryKey: diaryEntriesIncluded.reduce((max, e) => Math.max(max, e.sortKey), 0),
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
      tagebuch: {
        loaded_daily:   diaryEntriesIncluded.filter(e => e.type === 'daily').length,
        loaded_weekly:  diaryEntriesIncluded.filter(e => e.type === 'weekly').length,
        loaded_monthly: diaryEntriesIncluded.filter(e => e.type === 'monthly').length,
        skipped: diarySkippedCount,
        tokens: diaryEntriesIncluded.reduce((s, e) => s + e.tokens, 0),
        latest_daily: diary.stats.latest_daily,
      },
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
      model: 'claude-sonnet-4-6',
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

    // ── Phase 1: Simulate all diffs (no disk writes) ──────────────────────
    // workingVersions tracks in-progress content for sequential multi-diff on
    // the same file; originalContents holds the pristine disk content for backup.
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
      const absPath = join(BUSINESS_DIR, diff.file);

      if (!diff.newText.trim()) {
        simResults.push({ diff, absPath, status: 'failed', reason: 'NEW content is empty' });
        continue;
      }

      // Idempotency: disk content already matches newText exactly
      if (existsSync(absPath) && !workingVersions.has(absPath)) {
        const diskContent = readFileSync(absPath, 'utf-8');
        originalContents.set(absPath, diskContent);
        if (normalizeWs(diskContent) === normalizeWs(diff.newText)) {
          simResults.push({ diff, absPath, status: 'already_applied' });
          continue;
        }
      }

      // Full-replace: always write complete new content (no string matching)
      workingVersions.set(absPath, diff.newText);
      simResults.push({ diff, absPath, status: 'ok' });
    }

    const failedSims  = simResults.filter(r => r.status === 'failed');
    const okSims      = simResults.filter(r => r.status === 'ok');
    const alreadySims = simResults.filter(r => r.status === 'already_applied');

    if (dry_run) {
      res.json({
        ok: true, dry_run: true,
        applied:          okSims.map(r => r.diff.file),
        already_applied:  alreadySims.map(r => r.diff.file),
        failed:           failedSims.map(r => ({ file: r.diff.file, reason: r.reason! })),
        backup_dir: null,
      });
      return;
    }

    // ── Multi-diff atomicity: if ANY sim failed, abort ALL writes ────────
    if (failedSims.length > 0) {
      const failedSimSet = new Set(failedSims); // identity comparison, not file name
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

    // ── Phase 2: Commit all writes atomically ─────────────────────────────
    ensureDir(BACKUP_DIR);

    // Only write files whose content actually changed
    const filesToWrite = new Map<string, { content: string; isNew: boolean; relPath: string }>();
    for (const [absPath, finalContent] of workingVersions) {
      const orig = originalContents.get(absPath);
      if (orig === undefined || finalContent !== orig) {
        filesToWrite.set(absPath, {
          content: finalContent,
          isNew: orig === undefined,
          relPath: relative(BUSINESS_DIR, absPath),
        });
      }
    }

    // Backup all existing files before any writes
    const backupMap = new Map<string, string>();
    for (const [absPath, { isNew }] of filesToWrite) {
      if (!isNew) {
        const backupName = `${datePrefix}_${basename(relative(BUSINESS_DIR, absPath))}`;
        const bp = join(BACKUP_DIR, backupName);
        const finalBp = existsSync(bp) ? `${bp}.${Date.now()}` : bp;
        writeFileSync(finalBp, originalContents.get(absPath)!, 'utf-8');
        backupMap.set(absPath, finalBp);
      }
    }

    // Atomic write (tmp + POSIX rename) + post-write SHA256 verify
    const sha256 = (s: string) => createHash('sha256').update(s, 'utf-8').digest('hex');
    const writtenPaths: string[] = [];
    let rollbackCause: { file: string; reason: string; expected_hash?: string; actual_hash?: string } | null = null;

    for (const [absPath, { content, isNew }] of filesToWrite) {
      if (rollbackCause) break;
      const tmpPath = absPath + '.tmp';
      const relPath = relative(BUSINESS_DIR, absPath);
      try {
        if (isNew) ensureDir(dirname(absPath));
        writeFileSync(tmpPath, content, 'utf-8');
        renameSync(tmpPath, absPath); // POSIX atomic rename — no half-written files on crash
        // Post-write verify: SHA256 expected vs actual
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

    // Rollback all written files on failure
    if (rollbackCause) {
      for (const absPath of writtenPaths) {
        const bp = backupMap.get(absPath);
        try {
          if (bp && existsSync(bp)) {
            writeFileSync(absPath, readFileSync(bp, 'utf-8'), 'utf-8');
          } else {
            // Was a new file — remove it
            if (existsSync(absPath)) renameSync(absPath, `${absPath}.rolled_back`);
          }
        } catch { /* best effort */ }
      }
      const writtenRelSet = new Set(writtenPaths.map(a => relative(BUSINESS_DIR, a)));
      const unreachedRel  = Array.from(filesToWrite.values())
        .map(v => v.relPath)
        .filter(p => p !== rollbackCause!.file && !writtenRelSet.has(p));

      res.json({
        ok: false, dry_run: false,
        applied: [],
        already_applied: alreadySims.map(r => r.diff.file),
        failed: [
          rollbackCause,
          ...writtenPaths.map(a => ({ file: relative(BUSINESS_DIR, a), reason: 'rolled back' })),
          ...unreachedRel.map(p => ({ file: p, reason: 'not reached due to earlier failure' })),
        ],
        backup_dir: BACKUP_DIR, rollback: true,
      });
      return;
    }

    // ── Phase 3: Refresh snapshot so next generate round uses updated baseline ──
    const finalRelPaths = Array.from(filesToWrite.values()).map(v => v.relPath);
    let snapshotRefreshed = false;
    if (session_id && finalRelPaths.length > 0) {
      const snap = readSnapshot(session_id);
      if (snap) {
        for (const relPath of finalRelPaths) {
          const absPath = join(BUSINESS_DIR, relPath);
          if (existsSync(absPath)) snap.files[relPath] = readFileSync(absPath, 'utf-8');
        }
        writeSnapshot(snap);
        snapshotRefreshed = true;
        console.log(`[BusinessAngel] Snapshot refreshed for session ${session_id}: ${finalRelPaths.join(', ')}`);
      }
    }

    // ── Phase 4: Inject context-update into live session history ─────────────
    if (session_id && SESSION_STORE.has(session_id) && finalRelPaths.length > 0) {
      const liveSession = SESSION_STORE.get(session_id)!;
      for (const relPath of finalRelPaths) {
        const absPath = join(BUSINESS_DIR, relPath);
        const newContent = existsSync(absPath) ? readFileSync(absPath, 'utf-8') : '[gelöscht]';
        liveSession.history.push({
          role: 'user',
          content: `[KONTEXT-UPDATE] \`${relPath}\` wurde soeben gespeichert. Aktueller Inhalt:\n\n\`\`\`\n${newContent}\n\`\`\`\n\nVerwende ab jetzt diesen Stand als Basis für weitere Änderungen.`,
        });
        liveSession.history.push({
          role: 'assistant',
          content: `Verstanden — \`${relPath}\` aktualisiert. Ich arbeite ab jetzt mit dem neuen Stand.`,
        });
      }
      console.log(`[BusinessAngel] Context injected for ${finalRelPaths.length} file(s) into session ${session_id.slice(0, 8)}`);
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
    console.error('[BusinessAngel] /apply-diffs error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- POST /revert ---
// Reverts a single file to its snapshot state (state at session load time).
// If the file wasn't in the snapshot (created during session), it is deleted.
router.post('/revert', (req, res) => {
  try {
    const { file, session_id } = req.body as { file?: string; session_id?: string };
    if (!file) { res.status(400).json({ error: 'file required' }); return; }

    const absPath = join(BUSINESS_DIR, file);

    if (session_id) {
      const snap = readSnapshot(session_id);
      if (snap && file in snap.files) {
        // File existed at session start — restore to snapshot content
        const tmp = absPath + '.revert-tmp.' + Date.now();
        writeFileSync(tmp, snap.files[file], 'utf-8');
        renameSync(tmp, absPath);
        console.log(`[BusinessAngel] Reverted ${file} to snapshot (session ${session_id})`);
        res.json({ ok: true, source: 'snapshot', file });
        return;
      }
      if (snap && !(file in snap.files)) {
        // File was created during the session — delete it
        if (existsSync(absPath)) {
          unlinkSync(absPath);
          console.log(`[BusinessAngel] Deleted session-created file ${file}`);
          res.json({ ok: true, source: 'deleted_new_file', file });
        } else {
          res.json({ ok: true, source: 'already_gone', file });
        }
        return;
      }
    }

    res.status(404).json({ error: 'No snapshot found for this session — cannot revert' });
  } catch (err: any) {
    console.error('[BusinessAngel] /revert error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- GET /file-watch --- SSE stream for file changes during active session ---
// Client connects once per session; receives events when files in BUSINESS_DIR change.
const watchClients = new Map<string, Set<Response>>();

const watcher = chokidar.watch(BUSINESS_DIR, {
  ignored: /(^|[/\\])\..|(node_modules|_archive|backups)/,
  persistent: true,
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
});

function emitFileChange(event: 'change' | 'add' | 'unlink', absPath: string) {
  const relPath = relative(BUSINESS_DIR, absPath);
  const payload = JSON.stringify({ event, file: relPath, ts: Date.now() });
  for (const clients of watchClients.values()) {
    for (const res of clients) {
      try { res.write(`data: ${payload}\n\n`); } catch { /* client gone */ }
    }
  }
}

watcher.on('change', p => emitFileChange('change', p));
watcher.on('add',    p => emitFileChange('add',    p));
watcher.on('unlink', p => emitFileChange('unlink', p));

router.get('/file-watch', (req, res) => {
  const sessionId = req.query.session_id as string | undefined;
  if (!sessionId) { res.status(400).json({ error: 'session_id required' }); return; }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  if (!watchClients.has(sessionId)) watchClients.set(sessionId, new Set());
  watchClients.get(sessionId)!.add(res);

  const keepalive = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, 15000);

  req.on('close', () => {
    clearInterval(keepalive);
    watchClients.get(sessionId)?.delete(res);
    if (watchClients.get(sessionId)?.size === 0) watchClients.delete(sessionId);
  });
});

export default router;
