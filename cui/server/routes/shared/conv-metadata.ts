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
}

const EMPTY: ConvMetadata = { titles: {}, accounts: {}, workdirs: {}, finished: {}, lastPrompt: {} };

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
  _scheduleSave();
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
