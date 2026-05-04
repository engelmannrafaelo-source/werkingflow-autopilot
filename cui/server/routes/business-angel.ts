// =============================================================================
// Business Angel Chat — context-loaded AI conversation via marker-loop
// =============================================================================
// GET  /api/business-angel/context     → read YAML config, return categories + token estimates
// GET  /api/business-angel/files       → full file tree of business dir with token counts
// POST /api/business-angel/load        → assemble lite context, create in-memory chat session
// POST /api/business-angel/chat        → marker-loop chat (READ/WRITE markers)
// =============================================================================

import { Router, type Response } from 'express';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, renameSync, unlinkSync } from 'fs';
import { randomUUID, createHash } from 'crypto';
import { join, basename, dirname, relative } from 'path';
import { load as yamlLoad } from 'js-yaml';
import chokidar from 'chokidar';
import { PATHS } from '../config/paths.js';
import { bridgeChat } from '../lib/bridge-fetch.js';
import { parseMarkers, stripMarkers } from '../lib/marker-parser.js';
import { executeMarkers, formatExecResultAsUserMessage, formatExecSummary } from '../lib/marker-executor.js';

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
  context_message: string;        // First user message (with <documents>) — IMMUTABLE after session start
  manifest: Record<string, string>; // filename -> sha256 of file content at session start
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
  context_message?: string;       // Migrated lazily — old sessions rebuild on first restore
  manifest?: Record<string, string>;
  // Only the real conversation (indices 2+), not the injected context messages
  conversation: ChatMessage[];
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

const BUSINESS_ANGEL_SYSTEM_PROMPT = `Du bist ein strategischer Berater für WerkING Tools / Engelmann Data Energyneering.

Deine erste Nachricht enthaelt eine Workspace-Uebersicht:
- <dateibaum>: Ordnerstruktur mit Token-Counts pro Datei (z.B. "PIPELINE.md (~3.2k)")
- <verlauf>: Liste der Tagebuch-Eintraege (Pyramide)
- <temp_ordner>: Frische Inputs (Voice-Transkripte, Notizen)

Du hast initial KEINEN Datei-Inhalt geladen. Nutze die Token-Counts im Dateibaum um zu planen welche Files du laden willst.

ERSTE ANTWORT:
- Begruesse Rafael kurz, nenne die Bereiche aus dem Dateibaum
- Wenn <temp_ordner> Files enthaelt: erwaehne sie
- Frage Rafael was er heute machen will
- Lade noch keine Files — warte auf seine Antwort

DANACH (KRITISCH — sei NICHT zu vorsichtig mit Reads):
- Sobald Rafaels Intent klar ist, lade GROSSZUEGIG die relevanten Files in EINEM Antwort-Block via mehreren <<<READ>>>-Markern.
- 10-20k Tokens Kontext sind voellig OK — das Window hat 200k. Bessere Antworten > Token-Sparen.
- Beispiel: bei "lass uns Pipeline durchgehen" lade direkt: sales/PIPELINE.md, customer-success/KUNDEN-UEBERSICHT.md, finance/CASH-FLOW.md, ggf. die einschlaegigen Kunden-Specs. Alles in EINEM Antwort-Block.
- Frage NIEMALS "soll ich das lesen?". Wenn es relevant scheint, lies es.
- Die einzige Ausnahme: wenn ein einzelnes File >10k waere und du nicht sicher bist, dann fragst du ob's gewollt ist.
- Im Verlauf weiter nachladen via <<<READ>>> wenn neue Themen aufkommen.
- Aenderungen schreiben via <<<WRITE>>> mit komplettem Datei-Inhalt.

REGELN:
- Verwende AUSSCHLIESSLICH was in den <documents> steht oder was du via <<<READ>>> nachlaedst
- Erfinde keine Zahlen, Konditionen, Personen oder Deals
- Wenn du etwas nicht weisst: sag es direkt
- Falls ein [KONTEXT-UPDATE] in der Konversation erscheint: Verwende diesen aktuellen Stand als Basis fuer weitere Aenderungen

DATEI-ZUGRIFF (du kannst lesen und schreiben):

LESEN — wenn du den aktuellen Inhalt einer Datei brauchst, schreib in deine Antwort:
    <<<READ pfad/zur/datei.md>>>
Ich lese die Datei und gib dir den Inhalt in der naechsten User-Nachricht zurueck. Mehrere READ-Marker pro Antwort sind moeglich.

SCHREIBEN — wenn du eine Datei aendern oder neu erzeugen willst:
    <<<WRITE pfad/zur/datei.md
    [VOLLSTAENDIGER neuer Inhalt der Datei — niemals nur ein Ausschnitt]
    >>>
Ich backupe und ueberschreibe komplett. Niemals Diffs, niemals nur Aenderungen — immer der ganze Datei-Inhalt.

WICHTIG:
- Wenn du eine bestehende Datei aendern willst: erst <<<READ pfad>>> um den aktuellen Stand zu sehen, dann <<<WRITE pfad ...>>> mit dem neuen Vollinhalt.
- Mehrere WRITE-Bloecke pro Antwort sind erlaubt.
- PFADE: Der <dateibaum> Block enthaelt die aktuelle Ordnerstruktur. Verwende existierende Pfade und Namenskonventionen.
- Schreib niemals FILE/OLD/NEW Bloecke, <<<DIFF>>> oder old_string/new_string — diese Formate sind veraltet und werden ignoriert.

ANTWORT-FORMAT (KRITISCH):
- Antworte direkt in Prosa. KEINE Speaker-Labels — kein "H:", "A:", "User:", "Assistant:", "Sprecher 1:".
- Erfinde NIE eine User-Antwort. Antworte nicht auf Sätze, die Rafael nicht gesagt hat.
- Wenn Rafael Audio-Transkripte mit "Sprecher 1/2" oder "H:/A:" einfügt: Referenziere sie als "du sagtest X" — übernimm das Format NICHT in deine eigene Antwort.
- Stoppe nach deiner Antwort. Kein Cliffhanger, keine fiktiven Folge-Turns, kein "H: ..." am Ende.`;

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
    context_message: session.context_message,
    manifest: session.manifest,
    conversation,
  };
  writeFileSync(ACTIVE_SESSION_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Auto-restore: if session is not in memory but exists on disk, rebuild it.
 * This handles CUI server restarts / hot-reloads without losing the active session.
 *
 * Fast-Path: persisted session has context_message → restore 1:1 (cache stable, no rebuild).
 * Migration-Path: legacy session without context_message → rebuild from current yaml,
 * then persist context_message + manifest so next restore is 1:1.
 *
 * Diary/yaml updates during a running session are no longer auto-injected here.
 * Frontend must call /sync-context explicitly (general delta detection via manifest).
 */
function getOrRestoreSession(session_id: string): ChatSession | null {
  const existing = SESSION_STORE.get(session_id);
  if (existing) return existing;

  // Try to restore from disk
  const persisted = readPersistedSession();
  if (!persisted || persisted.session_id !== session_id) return null;

  // Fast-path: persisted has context_message → restore 1:1 without rebuild.
  if (persisted.context_message) {
    const restored: ChatSession = {
      session_id: persisted.session_id,
      system_prompt: BUSINESS_ANGEL_SYSTEM_PROMPT,
      context_message: persisted.context_message,
      manifest: persisted.manifest ?? {},
      history: [
        { role: 'user', content: persisted.context_message },
        { role: 'assistant', content: 'Verstanden. Dokumente geladen und bereit.' },
        ...persisted.conversation,
      ],
      created_at: persisted.created_at,
      token_count: persisted.token_count,
      files_loaded: persisted.files_loaded,
      temp_files: persisted.temp_files,
      zusatz_loaded: persisted.zusatz_loaded ?? [],
    };
    SESSION_STORE.set(session_id, restored);
    console.log(`[BusinessAngel] Auto-restored session ${session_id.slice(0, 8)} from persisted context (${persisted.conversation.length} turns)`);
    return restored;
  }

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

    // Build manifest for the migrated session so /sync-context can compare future deltas.
    const migrationManifest: Record<string, string> = {};
    for (const relPath of yaml.kern_files) {
      const c = readFileContent(relPath);
      if (c) migrationManifest[relPath] = sha256(c);
    }
    for (const f of tempFiles) migrationManifest[`temp/${f.name}`] = sha256(f.content);
    for (const e of diaryIncluded) migrationManifest[`diary/${e.label}`] = sha256(e.content);

    const initialHistory: ChatMessage[] = [
      { role: 'user', content: contextMessage },
      { role: 'assistant', content: 'Verstanden. Dokumente geladen und bereit.' },
      ...persisted.conversation,
    ];

    const restored: ChatSession = {
      session_id: persisted.session_id,
      system_prompt: BUSINESS_ANGEL_SYSTEM_PROMPT,
      context_message: contextMessage,
      manifest: migrationManifest,
      history: initialHistory,
      created_at: persisted.created_at,
      token_count: totalTokens,
      files_loaded: filesLoaded,
      temp_files: tempFiles.map(f => f.name),
      zusatz_loaded: persisted.zusatz_loaded ?? [],
    };

    SESSION_STORE.set(session_id, restored);
    writePersistedSession(restored);  // Persist context_message + manifest for next 1:1 restore
    console.log(`[BusinessAngel] Migrated legacy session ${session_id.slice(0, 8)} — persisted context_message + manifest (${persisted.conversation.length} turns, ${filesLoaded} files)`);
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
    const absPath = join(absBase, relPath);

    if (entry.isDirectory()) {
      if (SKIP_DIR.test(entry.name)) continue;
      const children = renderFileTreeText(absBase, relPath, indent + 1);
      if (!children) continue;
      lines.push(`${prefix}${entry.name}/`);
      lines.push(children);
    } else if (entry.isFile()) {
      if (SKIP_FILE_EXT.test(entry.name)) continue;
      if (SKIP_FILE_NAME.test(entry.name)) continue;
      // Annotate file with token count so the model can plan READs.
      let tokenLabel = '';
      try {
        const sz = statSync(absPath).size;
        const tk = Math.round(sz / CHARS_PER_TOKEN);
        if (tk >= 1000) tokenLabel = ` (~${(tk / 1000).toFixed(1)}k)`;
        else if (tk > 0) tokenLabel = ` (~${tk})`;
      } catch { /* file removed mid-walk */ }
      lines.push(`${prefix}${entry.name}${tokenLabel}`);
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
    const { zusatz = [], extra_files = [], restore = false, lite = true } = req.body as {
      zusatz?: string[];
      extra_files?: string[];
      restore?: boolean;
      lite?: boolean;  // default: true — only file tree + diary list + temp list, no contents
    };

    const yaml = loadContextYaml();
    const tempDir = yaml.temp_ordner || TEMP_DIR;
    const kernSet = new Set<string>(yaml.kern_files);

    const TEMPLATE_OVERHEAD = 300;
    let budget = SYSTEM_PROMPT_TOKEN_LIMIT - TEMPLATE_OVERHEAD;

    // 1. Kern content — full mode only
    const kernSections: string[] = [];
    const kernExcluded: string[] = [];
    let filesLoaded = 0;
    let totalTokens = 0;

    if (!lite) {
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
    }

    // 2. Temp files — list always, content only in full mode
    const tempFiles = readTempFiles(tempDir);
    const tempSections: string[] = [];
    const tempExcluded: string[] = [];
    if (!lite) {
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
    }

    // 3. Tagebuch-Pyramide — list always, content only in full mode
    const diary = loadDiaryPyramid(yaml.tagebuch);
    const diaryEntriesIncluded: DiaryEntry[] = [];
    let diarySection = '';
    let diarySkippedCount = 0;
    if (!lite) {
      const diaryByRecency = [...diary.entries].sort((a, b) => b.sortKey - a.sortKey);
      for (const e of diaryByRecency) {
        if (e.tokens > budget) continue;
        diaryEntriesIncluded.push(e);
        filesLoaded++;
        totalTokens += e.tokens;
        budget -= e.tokens;
      }
      diaryEntriesIncluded.sort((a, b) => a.sortKey - b.sortKey);
      diarySection = renderDiarySection(diaryEntriesIncluded);
      diarySkippedCount = diary.entries.length - diaryEntriesIncluded.length;
      if (diarySkippedCount > 0) {
        console.warn(`[BusinessAngel] Tagebuch: ${diarySkippedCount} Eintrag/Einträge wegen Token-Budget übersprungen`);
      }
    }

    // 4. Zusatz + extra_files — full mode only
    const zusatzSections: string[] = [];
    const loadedPaths = new Set<string>(lite ? [] : yaml.kern_files);

    if (!lite) {
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
    }

    const excluded = [...kernExcluded, ...tempExcluded];

    // Build file tree text for context injection (so Angel knows all paths)
    const fileTreeText = renderFileTreeText(BUSINESS_DIR, '');
    const fileTreeTokens = estimateTokens(fileTreeText);
    console.log(`[BusinessAngel] File tree injected (~${fileTreeTokens} tokens)`);

    let contextMessage: string;

    if (lite) {
      const tempList = tempFiles.length > 0
        ? tempFiles.map(f => `- temp/${f.name}`).join('\n')
        : '(leer)';
      const diaryList = diary.entries.length > 0
        ? diary.entries.map(e => `- ${e.label}`).join('\n')
        : '(keine Eintraege)';

      contextMessage = `<workspace_overview>

<dateibaum description="Aktuelle Ordnerstruktur von /root/projekte/werkingflow-business/. Lade Inhalte gezielt via <<<READ>>>.">
${fileTreeText}
</dateibaum>

<verlauf description="Rafaels Arbeits-Tagebuch (Pyramide). Inhalte gezielt via <<<READ>>>.">
${diaryList}
</verlauf>

<temp_ordner description="Frische Inputs (Voice-Transkripte, Notizen). Inhalte via <<<READ>>>.">
${tempList}
</temp_ordner>

</workspace_overview>

Workspace geladen (Lite-Mode: ${diary.entries.length} Tagebuch-Eintraege gelistet, ${tempFiles.length} Temp-Files gelistet, KEIN Datei-Inhalt vorgeladen).`;
    } else {
      contextMessage = `<documents>

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
    }

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

    // Build manifest of all loaded files (filename -> sha256). Used by /sync-context to
    // detect added/changed/removed files relative to the original session-start state.
    const freshManifest: Record<string, string> = {};
    for (const relPath of loadedPaths) {
      const c = readFileContent(relPath);
      if (c) freshManifest[relPath] = sha256(c);
    }
    for (const f of tempFiles) freshManifest[`temp/${f.name}`] = sha256(f.content);
    for (const e of diaryEntriesIncluded) freshManifest[`diary/${e.label}`] = sha256(e.content);

    // PROMPT-CACHING + KONSISTENZ: bei restore IMMER persisted context_message + manifest 1:1
    // verwenden (falls vorhanden). Updates während laufender Session laufen über /sync-context.
    const usePersistedContext = restore && persisted?.context_message;
    const sessionContextMessage = usePersistedContext ? persisted.context_message! : contextMessage;
    const sessionManifest = usePersistedContext && persisted!.manifest ? persisted!.manifest : freshManifest;

    const ackMessage = lite
      ? `Workspace gesehen. Verfuegbar: customer-success/, sales/, marketing/, finance/, legal/, foerderung/, products/, shared/, team/, tools/. Plus Tagebuch-Pyramide (${diary.entries.length} Eintraege gelistet) und Temp-Inputs (${tempFiles.length}).

Worum gehts heute? Sag mir den Bereich oder die konkrete Frage — ich lade gezielt via READ was ich brauche.`
      : 'Verstanden. Dokumente geladen und bereit.';

    const initialHistory: ChatMessage[] = [
      { role: 'user', content: sessionContextMessage },
      { role: 'assistant', content: ackMessage },
      ...restoredConversation,
    ];

    // 5. Create in-memory chat session
    const session_id = persisted?.session_id ?? randomUUID();
    const newSession: ChatSession = {
      session_id,
      system_prompt: BUSINESS_ANGEL_SYSTEM_PROMPT,
      context_message: sessionContextMessage,
      manifest: sessionManifest,
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
      tagebuch: {
        loaded_daily:   diaryEntriesIncluded.filter(e => e.type === 'daily').length,
        loaded_weekly:  diaryEntriesIncluded.filter(e => e.type === 'weekly').length,
        loaded_monthly: diaryEntriesIncluded.filter(e => e.type === 'monthly').length,
        skipped: diarySkippedCount,
        tokens: diaryEntriesIncluded.reduce((s, e) => s + e.tokens, 0),
        latest_daily: diary.stats.latest_daily,
      },
      ack_message: ackMessage,
      lite,
    });
  } catch (err: any) {
    console.error('[BusinessAngel] /load error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- POST /sync-context ---
// Compares the current yaml + filesystem state against the session's manifest (frozen at session
// start) and appends a single user message to the conversation listing added/changed/removed
// files (plus optional extra_files chosen by the user). Manifest is updated. Keeps the original
// context_message immutable for prompt caching + consistency.
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
    const tempDir = yaml.temp_ordner || TEMP_DIR;

    type CandidateFile = { key: string; content: string };
    const current: CandidateFile[] = [];
    for (const relPath of yaml.kern_files) {
      const c = readFileContent(relPath);
      if (c) current.push({ key: relPath, content: c });
    }
    for (const f of readTempFiles(tempDir)) {
      current.push({ key: `temp/${f.name}`, content: f.content });
    }
    for (const e of loadDiaryPyramid(yaml.tagebuch).entries) {
      current.push({ key: `diary/${e.label}`, content: e.content });
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

    console.log(`[BusinessAngel] /sync-context session=${session_id.slice(0, 8)}: +${added.length} new, ~${changed.length} changed, -${removed.length} removed, ${truncated.length} truncated`);

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
    console.error('[BusinessAngel] /sync-context error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- POST /chat ---
// Marker-Loop: assistant antwortet mit <<<READ>>> oder <<<WRITE>>> Markern,
// Backend fuehrt aus, Ergebnis geht als naechste user message zurueck zum
// Modell, bis es ohne Marker antwortet (= final answer).
const MAX_MARKER_LOOPS_BA = 10;

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

    session.history.push({ role: 'user', content: message.trim() });

    console.log(`[BusinessAngel] /chat session=${session_id.slice(0, 8)} history=${session.history.length} msg_len=${message.length} sys_len=${session.system_prompt.length}`);

    let finalResponse = '';
    let totalReads = 0;
    let totalWrites = 0;
    let loops = 0;
    const writtenPathsAccum: string[] = [];

    for (loops = 0; loops < MAX_MARKER_LOOPS_BA; loops++) {
      const responseText = await bridgeChat({
        model: 'claude-sonnet-4-6',
        messages: [
          { role: 'system', content: session.system_prompt },
          ...session.history,
        ],
      });

      const markers = parseMarkers(responseText);

      if (markers.length === 0) {
        finalResponse = responseText;
        session.history.push({ role: 'assistant', content: responseText });
        break;
      }

      const exec = executeMarkers(markers, BUSINESS_DIR, BACKUP_DIR);
      totalReads  += exec.reads.length;
      totalWrites += exec.writes.length;
      for (const w of exec.writes) {
        if (w.ok) writtenPathsAccum.push(w.path);
      }
      console.log(`[BusinessAngel] loop ${loops + 1}: ${exec.reads.length} read(s), ${exec.writes.length} write(s)`);

      session.history.push({ role: 'assistant', content: responseText });
      session.history.push({ role: 'user', content: formatExecResultAsUserMessage(exec) });

      const stripped = stripMarkers(responseText);
      finalResponse = stripped + formatExecSummary(exec);
    }

    if (loops >= MAX_MARKER_LOOPS_BA) {
      console.warn(`[BusinessAngel] /chat hit MAX_MARKER_LOOPS (${MAX_MARKER_LOOPS_BA}) — returning last partial response`);
      finalResponse += `\n\n⚠️ Marker-Loop-Limit (${MAX_MARKER_LOOPS_BA}) erreicht. Bitte erneut anstossen falls noch was offen ist.`;
    }

    writePersistedSession(session);

    console.log(`[BusinessAngel] /chat done: ${loops + 1} loop(s), ${totalReads} read(s), ${totalWrites} write(s), resp_len=${finalResponse.length}`);

    res.json({
      ok: true,
      response: finalResponse,
      session_id,
      reads: totalReads,
      writes: totalWrites,
      written_paths: writtenPathsAccum,
    });
  } catch (err: any) {
    console.error('[BusinessAngel] /chat error:', err.message);
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
