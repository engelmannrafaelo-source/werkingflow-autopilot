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
import { PATHS } from '../config/paths.js';

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
