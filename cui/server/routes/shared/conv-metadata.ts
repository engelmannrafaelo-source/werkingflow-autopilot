/**
 * ConvMetadataStore — Single file for all conversation metadata.
 *
 * Consolidates 5 separate JSON files into 1:
 * - titles.json → metadata.titles
 * - conv-accounts.json → metadata.accounts
 * - conv-workdirs.json → metadata.workdirs
 * - conv-finished.json → metadata.finished
 * - conv-last-prompt.json → metadata.lastPrompt
 *
 * In-memory cache with dirty-flag writes (debounced 2s).
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { atomicWriteFileSync } from './utils.js';

interface ConvMetadata {
  titles: Record<string, string>;
  accounts: Record<string, string>;
  workdirs: Record<string, string>;
  finished: Record<string, boolean>;
  lastPrompt: Record<string, string>;
  models: Record<string, string>;
  paused: Record<string, boolean>;
  /** reviewSessionId → originalSessionId */
  reviews: Record<string, string>;
  /** sessionIds that are sub-sessions (spawned by parent sessions) */
  subSessions: Record<string, boolean>;
  /** subSessionId → parentSessionId (tracks which parent spawned this sub-session) */
  parentSessions: Record<string, string>;
}

const EMPTY: ConvMetadata = { titles: {}, accounts: {}, workdirs: {}, finished: {}, lastPrompt: {}, models: {}, paused: {}, reviews: {}, subSessions: {}, parentSessions: {} };

let _data: ConvMetadata | null = null;
let _filePath: string = '';
let _dirty = false;
let _writeTimer: ReturnType<typeof setTimeout> | null = null;
const WRITE_DEBOUNCE_MS = 2000;

function _load(): ConvMetadata {
  if (_data) return _data;
  if (!_filePath) throw new Error('ConvMetadataStore not initialized — call init() first');

  // Try loading consolidated file
  if (existsSync(_filePath)) {
    try {
      _data = JSON.parse(readFileSync(_filePath, 'utf8'));
      // Ensure all fields exist
      _data = { ...EMPTY, ..._data };
      return _data!;
    } catch (err) {
      console.warn('[ConvMeta] Failed to load:', err instanceof Error ? err.message : err);
    }
  }
  _data = { ...EMPTY };
  return _data;
}

function _scheduleSave() {
  _dirty = true;
  if (_writeTimer) return; // Already scheduled
  _writeTimer = setTimeout(() => {
    _writeTimer = null;
    if (_dirty && _data) {
      atomicWriteFileSync(_filePath, JSON.stringify(_data, null, 2));
      _dirty = false;
    }
  }, WRITE_DEBOUNCE_MS);
}

/** Force immediate save (for shutdown / critical operations) */
export function flush() {
  if (_writeTimer) { clearTimeout(_writeTimer); _writeTimer = null; }
  if (_dirty && _data) {
    atomicWriteFileSync(_filePath, JSON.stringify(_data, null, 2));
    _dirty = false;
  }
}

// ---------------------------------------------------------------------------
// Init — must be called once with DATA_DIR path
// ---------------------------------------------------------------------------

export function init(dataDir: string) {
  _filePath = join(dataDir, 'conv-metadata.json');

  // Migrate legacy files if they exist and consolidated doesn't
  if (!existsSync(_filePath)) {
    const data: ConvMetadata = { ...EMPTY };
    const legacyFiles: Array<[keyof ConvMetadata, string]> = [
      ['titles', 'titles.json'],
      ['accounts', 'conv-accounts.json'],
      ['workdirs', 'conv-workdirs.json'],
      ['finished', 'conv-finished.json'],
      ['lastPrompt', 'conv-last-prompt.json'],
    ];
    let migrated = 0;
    for (const [key, filename] of legacyFiles) {
      const legacy = join(dataDir, filename);
      if (existsSync(legacy)) {
        try {
          (data as any)[key] = JSON.parse(readFileSync(legacy, 'utf8'));
          migrated++;
        } catch { /* skip corrupt */ }
      }
    }
    if (migrated > 0) {
      _data = data;
      atomicWriteFileSync(_filePath, JSON.stringify(data, null, 2));
      console.log(`[ConvMeta] Migrated ${migrated} legacy files → conv-metadata.json`);
    }
  }
}

// ---------------------------------------------------------------------------
// Titles
// ---------------------------------------------------------------------------

export function getTitle(sessionId: string): string {
  return _load().titles[sessionId] || '';
}

export function getAllTitles(): Record<string, string> {
  return { ..._load().titles };
}

export function saveTitle(sessionId: string, title: string) {
  _load().titles[sessionId] = title;
  _scheduleSave();
}

export function deleteTitle(sessionId: string) {
  delete _load().titles[sessionId];
  _scheduleSave();
}

// ---------------------------------------------------------------------------
// Account Assignments
// ---------------------------------------------------------------------------

export function getAssignment(sessionId: string): string {
  return _load().accounts[sessionId] || '';
}

export function getAllAssignments(): Record<string, string> {
  return { ..._load().accounts };
}

export function saveAssignment(sessionId: string, accountId: string) {
  const data = _load();
  if (data.accounts[sessionId] === accountId) return;
  data.accounts[sessionId] = accountId;
  // Account assignments are critical — flush immediately (no debounce)
  flush();
}

// ---------------------------------------------------------------------------
// WorkDirs
// ---------------------------------------------------------------------------

export function getWorkDir(sessionId: string): string {
  return _load().workdirs[sessionId] || '';
}

export function getAllWorkDirs(): Record<string, string> {
  return { ..._load().workdirs };
}

export function saveWorkDir(sessionId: string, workDir: string) {
  const data = _load();
  if (data.workdirs[sessionId] === workDir) return;
  data.workdirs[sessionId] = workDir;
  _scheduleSave();
}

// ---------------------------------------------------------------------------
// Finished
// ---------------------------------------------------------------------------

export function isFinished(sessionId: string): boolean {
  return _load().finished[sessionId] === true;
}

export function getAllFinished(): Record<string, boolean> {
  return { ..._load().finished };
}

export function setFinished(sessionId: string, finished: boolean) {
  const data = _load();
  if (finished) data.finished[sessionId] = true;
  else delete data.finished[sessionId];
  _scheduleSave();
}

// ---------------------------------------------------------------------------
// Last Prompt
// ---------------------------------------------------------------------------

export function getLastPrompt(sessionId: string): string {
  return _load().lastPrompt[sessionId] || '';
}

export function getAllLastPrompts(): Record<string, string> {
  return { ..._load().lastPrompt };
}

export function setLastPrompt(sessionId: string) {
  _load().lastPrompt[sessionId] = new Date().toISOString();
  _scheduleSave();
}

export function deleteLastPrompt(sessionId: string) {
  delete _load().lastPrompt[sessionId];
  _scheduleSave();
}

// ---------------------------------------------------------------------------
// Models (per-session model override)
// ---------------------------------------------------------------------------

export function getModel(sessionId: string): string {
  return _load().models[sessionId] || '';
}

export function getAllModels(): Record<string, string> {
  return { ..._load().models };
}

export function saveModel(sessionId: string, model: string) {
  const data = _load();
  if (data.models[sessionId] === model) return;
  data.models[sessionId] = model;
  // Model changes are critical for next resume — flush immediately
  flush();
}

// ---------------------------------------------------------------------------
// Paused (manual pause — suppresses needs_attention indicator)
// ---------------------------------------------------------------------------

export function isPaused(sessionId: string): boolean {
  return _load().paused?.[sessionId] === true;
}

export function getAllPaused(): Record<string, boolean> {
  return { ...(_load().paused ?? {}) };
}

// ---------------------------------------------------------------------------
// Reviews (reviewSessionId → originalSessionId)
// ---------------------------------------------------------------------------

export function getReviewOriginal(reviewSessionId: string): string | undefined {
  return _load().reviews?.[reviewSessionId];
}

export function setReview(reviewSessionId: string, originalSessionId: string) {
  const data = _load();
  if (!data.reviews) data.reviews = {};
  data.reviews[reviewSessionId] = originalSessionId;
  _scheduleSave();
}

export function deleteReview(reviewSessionId: string) {
  const data = _load();
  if (data.reviews) delete data.reviews[reviewSessionId];
  _scheduleSave();
}

export function setPaused(sessionId: string, paused: boolean) {
  const data = _load();
  if (!data.paused) data.paused = {};
  if (paused) data.paused[sessionId] = true;
  else delete data.paused[sessionId];
  _scheduleSave();
}

// Sub-session tracking
export function isSubSession(sessionId: string): boolean {
  const data = _load();
  return !!(data.subSessions && data.subSessions[sessionId]);
}

export function getAllSubSessions(): Record<string, boolean> {
  const data = _load();
  return data.subSessions || {};
}

export function setSubSession(sessionId: string, isSub: boolean) {
  const data = _load();
  if (!data.subSessions) data.subSessions = {};
  if (isSub) data.subSessions[sessionId] = true;
  else delete data.subSessions[sessionId];
  _scheduleSave();
}

// ---------------------------------------------------------------------------
// Parent Sessions (subSessionId → parentSessionId)
// ---------------------------------------------------------------------------

export function getParentSessionId(subSessionId: string): string | undefined {
  const data = _load();
  return data.parentSessions?.[subSessionId];
}

export function setParentSession(subSessionId: string, parentSessionId: string) {
  const data = _load();
  if (!data.parentSessions) data.parentSessions = {};
  data.parentSessions[subSessionId] = parentSessionId;
  _scheduleSave();
}

export function deleteParentSession(subSessionId: string) {
  const data = _load();
  if (data.parentSessions) delete data.parentSessions[subSessionId];
  _scheduleSave();
}
