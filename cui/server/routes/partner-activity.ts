/**
 * Partner Activity Route — Auto-generated changelog from git commits.
 *
 * Endpoints:
 *   GET /api/partner/activity?app=werking-energy&limit=50
 *
 * Reads git log from werkingflow-production filtered by app path.
 * Parses conventional commit prefixes (feat, fix, chore, etc.).
 * Only returns entries from the last 30 days.
 */

import { Router, Request, Response } from 'express';
import { execSync } from 'child_process';
import { existsSync, statSync, readdirSync } from 'fs';
import { join } from 'path';
import { PATHS } from '../config/paths.js';

// Workspace ID → directory under shared-storage. Apps share a tenant subtree.
const STORAGE_BASE = process.env.PARTNER_SHARED_STORAGE || '/opt/shared-storage';
const WORKSPACE_TO_STORAGE: Record<string, string> = {
  'engelmann-ai-hub': 'engelmann',
  'engelmann-developer': 'engelmann',
  'engelmann-dashboards': 'engelmann',
  'werking-energy': 'werking-energy',
  'werking-report': 'werking-report',
  'werkingsafety': 'werking-safety',
  'werking-noise': 'werking-noise',
};

// --- Types ---
export type ActivityType = 'feat' | 'fix' | 'chore' | 'refactor' | 'docs' | 'test' | 'style' | 'perf' | 'ci' | 'build' | 'revert' | 'commit';

export interface ActivityEntry {
  type: ActivityType;
  message: string;
  author: string;
  date: string;
  hash: string;
}

// --- Helpers ---

const COMMIT_PREFIX_MAP: Record<string, ActivityType> = {
  feat: 'feat',
  fix: 'fix',
  chore: 'chore',
  refactor: 'refactor',
  docs: 'docs',
  test: 'test',
  style: 'style',
  perf: 'perf',
  ci: 'ci',
  build: 'build',
  revert: 'revert',
};

function parseCommitType(message: string): ActivityType {
  const match = message.match(/^(\w+)(?:\([^)]*\))?!?:/);
  if (match) {
    const prefix = match[1].toLowerCase();
    if (prefix in COMMIT_PREFIX_MAP) {
      return COMMIT_PREFIX_MAP[prefix];
    }
  }
  return 'commit';
}

function getActivity(app: string, limit: number): ActivityEntry[] {
  const repoDir = PATHS.werkingflowProductionDir;
  const appPath = `apps/${app}`;

  // 30 days ago in ISO format for --after
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // git log: hash|author|date|subject — separated by unit separator (ASCII 31) to avoid collision
  const SEP = '\x1f';
  const FORMAT = `--format=%H${SEP}%an${SEP}%aI${SEP}%s`;

  let output: string;
  try {
    output = execSync(
      `git log ${FORMAT} --after="${since}" -- "${appPath}" 2>/dev/null | head -${limit * 2}`,
      { cwd: repoDir, encoding: 'utf8', timeout: 10000 }
    );
  } catch (err) {
    throw new Error(`[partner-activity] git log failed: ${err}`);
  }

  const entries: ActivityEntry[] = [];
  const lines = output.split('\n').filter(Boolean);

  for (const line of lines) {
    const parts = line.split(SEP);
    if (parts.length < 4) continue;

    const [hash, author, date, ...messageParts] = parts;
    const message = messageParts.join(SEP).trim();

    if (!hash || !author || !date || !message) continue;

    entries.push({
      type: parseCommitType(message),
      message,
      author,
      date,
      hash: hash.slice(0, 8),
    });

    if (entries.length >= limit) break;
  }

  return entries;
}

// --- Router ---
const router = Router();

/**
 * GET /api/partner/storage-activity?workspace=engelmann-ai-hub&hours=72
 * Lists files in /opt/shared-storage/<app>/ modified in the last N hours
 * (default 72). Shows cross-partner activity — what other partners (or
 * Rafael on dev-server) have written into shared storage. Files are
 * synced bidirectionally via Syncthing, so this view works on any node.
 */
router.get('/storage-activity', (req: Request, res: Response) => {
  const workspace = (req.query.workspace as string | undefined)?.trim();
  if (!workspace) {
    res.status(400).json({ error: 'Query param "workspace" is required' });
    return;
  }
  if (!/^[a-z0-9-]+$/.test(workspace)) {
    res.status(400).json({ error: 'Invalid workspace name' });
    return;
  }

  const storageSlug = WORKSPACE_TO_STORAGE[workspace];
  if (!storageSlug) {
    res.json({ files: [], note: `No shared-storage mapping for workspace ${workspace}` });
    return;
  }

  const root = join(STORAGE_BASE, storageSlug);
  if (!existsSync(root)) {
    res.json({ files: [], note: `Storage dir ${root} not present yet` });
    return;
  }

  const hoursRaw = parseInt((req.query.hours as string) ?? '72', 10);
  const hours = isNaN(hoursRaw) || hoursRaw < 1 ? 72 : Math.min(hoursRaw, 720);
  const cutoff = Date.now() - hours * 3600 * 1000;
  const limitRaw = parseInt((req.query.limit as string) ?? '50', 10);
  const limit = isNaN(limitRaw) || limitRaw < 1 ? 50 : Math.min(limitRaw, 200);

  // Walk dir tree, collect entries newer than cutoff. Skip versioning dirs and binaries.
  const SKIP_DIRS = new Set(['.stversions', '.stfolder', '_backups', 'pids', 'node_modules']);
  const SKIP_EXT = new Set(['.lock', '.tmp', '.swp', '.log']);
  type Entry = { path: string; size: number; modified: string; owner: string };
  const found: Entry[] = [];

  function walk(dir: string, depth = 0) {
    if (depth > 6 || found.length >= limit * 4) return;
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (SKIP_DIRS.has(name)) continue;
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        walk(full, depth + 1);
      } else if (st.isFile()) {
        if (st.mtimeMs < cutoff) continue;
        const ext = name.match(/\.[^.]+$/)?.[0]?.toLowerCase() ?? '';
        if (SKIP_EXT.has(ext)) continue;
        const rel = full.slice(root.length + 1);
        found.push({
          path: rel,
          size: st.size,
          modified: new Date(st.mtimeMs).toISOString(),
          owner: String(st.uid),
        });
      }
    }
  }

  walk(root);

  // Sort newest-first, limit
  found.sort((a, b) => b.modified.localeCompare(a.modified));
  res.json({
    storageRoot: root,
    hours,
    files: found.slice(0, limit),
    truncated: found.length > limit,
  });
});

/** GET /api/partner/activity — List recent commits for an app. */
router.get('/activity', (req: Request, res: Response) => {
  const app = (req.query.app as string | undefined)?.trim();
  if (!app) {
    res.status(400).json({ error: 'Query param "app" is required' });
    return;
  }

  // Validate: only allow alphanumeric + dash (prevent path traversal)
  if (!/^[a-z0-9-]+$/.test(app)) {
    res.status(400).json({ error: 'Invalid app name' });
    return;
  }

  const limitRaw = parseInt((req.query.limit as string) ?? '50', 10);
  const limit = isNaN(limitRaw) || limitRaw < 1 ? 50 : Math.min(limitRaw, 200);

  let activity: ActivityEntry[];
  try {
    activity = getActivity(app, limit);
  } catch (err) {
    console.error('[partner-activity]', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to read git log' });
    return;
  }

  res.json({ activity });
});

export default router;
