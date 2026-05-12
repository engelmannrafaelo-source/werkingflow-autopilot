import { Router } from 'express';
import type { Request } from 'express';
import { readdirSync, statSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { PATHS } from '../config/paths.js';
import type { JwtPayload } from '../auth/types.js';

const execFileAsync = promisify(execFile);

const router = Router();

// --- Per-user scoping ---
// Admin → PATHS.projectsRoot (the server's main projects dir).
// Partner (product-owner / fachpartner) → their own /home/{sub}/projekte.
// Auth disabled (dev fallback, no users.json) → PATHS.projectsRoot.
// If a partner user has no home dir on disk → null (empty scope).
const USER_ID_SAFE = /^[a-z0-9][a-z0-9._-]{0,62}$/i;

interface AuthedReq extends Request {
  user?: JwtPayload;
}

function resolveRepoRoot(req: AuthedReq): string | null {
  // Auth disabled or no user attached → dev-mode default
  if (!req.user) return PATHS.projectsRoot;
  if (req.user.role === 'admin') return PATHS.projectsRoot;

  // Defense in depth: validate sub looks like a safe filename
  const sub = req.user.sub;
  if (!sub || !USER_ID_SAFE.test(sub)) return null;

  const userHome = `/home/${sub}/projekte`;
  return existsSync(userHome) ? userHome : null;
}

// --- Cache (TTL-based, manual invalidation via POST /refresh) ---
interface CacheEntry { data: any; expires: number }
const cache = new Map<string, CacheEntry>();

function cacheGet<T>(key: string): T | null {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() > e.expires) { cache.delete(key); return null; }
  return e.data as T;
}
function cacheSet(key: string, data: any, ttlMs: number) {
  cache.set(key, { data, expires: Date.now() + ttlMs });
}

const TTL = {
  repos: 60_000,
  commits: 300_000,
  branches: 60_000,
  status: 5_000,
  diff: 600_000,
};

// --- Git CLI helper ---
async function git(repoPath: string, args: string[], timeoutMs = 10_000): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args], {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024, // 16 MB for large diffs/logs
    });
    return stdout;
  } catch (err: any) {
    // git returns non-zero for many normal conditions; surface stdout if present
    if (typeof err.stdout === 'string' && err.stdout.length > 0) return err.stdout;
    throw new Error(`git ${args.join(' ')} failed: ${err.message?.slice(0, 200)}`);
  }
}

// --- Recursive repo discovery (Node-native, prunes noise dirs) ---
const PRUNE = new Set([
  'node_modules', '.next', 'dist', 'build', '__pycache__',
  '.venv', 'venv', 'ENV', '.cache', '.turbo', '.vercel',
  '.stversions', '_archive', 'archive',
]);

function discoverRepos(root: string, maxDepth = 5): string[] {
  const result: string[] = [];
  function walk(dir: string, depth: number) {
    if (depth > maxDepth) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    if (entries.includes('.git')) {
      // confirm it's actually a git repo (dir or file for worktrees)
      try {
        const gitPath = join(dir, '.git');
        statSync(gitPath);
        result.push(dir);
        return; // don't recurse into a repo
      } catch { /* ignore */ }
    }
    for (const name of entries) {
      if (name.startsWith('.')) continue;
      if (PRUNE.has(name)) continue;
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full, depth + 1);
    }
  }
  walk(root, 0);
  return result;
}

function isPathAllowed(repoPath: string, root: string | null): boolean {
  if (!root) return false;
  // resolve() normalizes ../ etc., so we catch path traversal attempts
  const normalized = resolve(repoPath);
  const normalizedRoot = resolve(root);
  return normalized === normalizedRoot || normalized.startsWith(normalizedRoot + '/');
}

// =========================================================================
// GET /repos — Discover all git repos under the user's resolved root
// =========================================================================
router.get('/repos', async (req: AuthedReq, res) => {
  try {
    const root = resolveRepoRoot(req);
    if (!root) return res.json({ repos: [], count: 0, scannedAt: new Date().toISOString(), root: null });

    const cacheKey = `repos:${root}`;
    const cached = cacheGet<any>(cacheKey);
    if (cached) return res.json(cached);

    const paths = discoverRepos(root);

    const repos = await Promise.all(paths.map(async (path) => {
      const name = path.split('/').pop() || 'unknown';
      try {
        const [branchRaw, statusRaw, headRaw] = await Promise.all([
          git(path, ['branch', '--show-current']).catch(() => ''),
          git(path, ['status', '--porcelain']).catch(() => ''),
          git(path, ['log', '-1', '--format=%H|%an|%s|%ct']).catch(() => ''),
        ]);
        const branch = branchRaw.trim() || 'detached';
        const uncommitted = statusRaw.split('\n').filter(Boolean).length;
        const [hash, author, message, ts] = headRaw.trim().split('|');
        return {
          path,
          name,
          branch,
          uncommitted,
          dirty: uncommitted > 0,
          head: hash ? {
            hash: hash.slice(0, 7),
            author: author || '',
            message: message || '',
            date: ts ? new Date(parseInt(ts) * 1000).toISOString() : '',
          } : null,
        };
      } catch (err: any) {
        return { path, name, branch: '', uncommitted: 0, dirty: false, head: null, error: err.message };
      }
    }));

    repos.sort((a, b) => a.name.localeCompare(b.name));
    const result = { repos, count: repos.length, root, scannedAt: new Date().toISOString() };
    cacheSet(cacheKey, result, TTL.repos);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// =========================================================================
// GET /commits?repo=PATH&limit=50&offset=0
// Returns commit DAG (sha, parents, author, date, message)
// =========================================================================
router.get('/commits', async (req: AuthedReq, res) => {
  try {
    const repo = String(req.query.repo || '');
    const limit = Math.min(parseInt(String(req.query.limit || '50')), 500);
    const offset = parseInt(String(req.query.offset || '0'));
    const root = resolveRepoRoot(req);

    if (!repo || !isPathAllowed(repo, root)) {
      return res.status(403).json({ error: 'repo not accessible' });
    }

    const cacheKey = `commits:${repo}:${limit}:${offset}`;
    const cached = cacheGet<any>(cacheKey);
    if (cached) return res.json(cached);

    // %x1f = unit separator, %x1e = record separator (safer than | with messages)
    const SEP = String.fromCharCode(0x1f);
    const REC = String.fromCharCode(0x1e);
    const format = ['%H', '%P', '%an', '%ae', '%ct', '%s'].join(SEP) + REC;

    const stdout = await git(repo, [
      'log', '--all', '--topo-order',
      `--format=${format}`,
      '--skip', String(offset),
      '-n', String(limit),
    ]);

    const commits = stdout.split(REC).map(s => s.trim()).filter(Boolean).map(block => {
      const [sha, parents, author, email, ts, message] = block.split(SEP);
      return {
        sha,
        shortSha: sha.slice(0, 7),
        parents: parents ? parents.split(' ').filter(Boolean) : [],
        author: author || '',
        email: email || '',
        date: ts ? new Date(parseInt(ts) * 1000).toISOString() : '',
        message: message || '',
      };
    });

    // Get branch tips so frontend can label heads
    const refsRaw = await git(repo, ['for-each-ref', '--format=%(objectname) %(refname:short)', 'refs/heads', 'refs/remotes']).catch(() => '');
    const refs: Record<string, string[]> = {};
    refsRaw.split('\n').filter(Boolean).forEach(line => {
      const [hash, ...nameParts] = line.split(' ');
      const name = nameParts.join(' ');
      if (!refs[hash]) refs[hash] = [];
      refs[hash].push(name);
    });

    const result = { commits, refs, hasMore: commits.length === limit, scannedAt: new Date().toISOString() };
    cacheSet(cacheKey, result, TTL.commits);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// =========================================================================
// GET /branches?repo=PATH
// =========================================================================
router.get('/branches', async (req: AuthedReq, res) => {
  try {
    const repo = String(req.query.repo || '');
    const root = resolveRepoRoot(req);
    if (!repo || !isPathAllowed(repo, root)) return res.status(403).json({ error: 'repo not accessible' });

    const cacheKey = `branches:${repo}`;
    const cached = cacheGet<any>(cacheKey);
    if (cached) return res.json(cached);

    const SEP = String.fromCharCode(0x1f);
    const format = ['%(refname:short)', '%(upstream:short)', '%(upstream:track)', '%(committerdate:iso8601)', '%(objectname:short)', '%(subject)'].join(SEP);

    const [localRaw, currentRaw] = await Promise.all([
      git(repo, ['for-each-ref', `--format=${format}`, 'refs/heads']).catch(() => ''),
      git(repo, ['branch', '--show-current']).catch(() => ''),
    ]);
    const current = currentRaw.trim();

    const branches = localRaw.split('\n').filter(Boolean).map(line => {
      const [name, upstream, track, date, headHash, headMsg] = line.split(SEP);
      const aheadMatch = track.match(/ahead (\d+)/);
      const behindMatch = track.match(/behind (\d+)/);
      return {
        name,
        upstream: upstream || null,
        ahead: aheadMatch ? parseInt(aheadMatch[1]) : 0,
        behind: behindMatch ? parseInt(behindMatch[1]) : 0,
        gone: track.includes('gone'),
        date,
        headHash,
        headMsg,
        isCurrent: name === current,
      };
    });

    branches.sort((a, b) => {
      if (a.isCurrent) return -1;
      if (b.isCurrent) return 1;
      return new Date(b.date).getTime() - new Date(a.date).getTime();
    });

    const result = { branches, current, scannedAt: new Date().toISOString() };
    cacheSet(cacheKey, result, TTL.branches);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// =========================================================================
// GET /status?repo=PATH — Working tree state
// =========================================================================
router.get('/status', async (req: AuthedReq, res) => {
  try {
    const repo = String(req.query.repo || '');
    const root = resolveRepoRoot(req);
    if (!repo || !isPathAllowed(repo, root)) return res.status(403).json({ error: 'repo not accessible' });

    const cacheKey = `status:${repo}`;
    const cached = cacheGet<any>(cacheKey);
    if (cached) return res.json(cached);

    const raw = await git(repo, ['status', '--porcelain=v1', '-z']).catch(() => '');
    // -z gives NUL-separated records, but rename entries have two paths separated by NUL too.
    // For MVP, parse simple case.
    const records = raw.split('\0').filter(Boolean);
    const files = records.map(rec => {
      const xy = rec.slice(0, 2);
      const path = rec.slice(3);
      const x = xy[0]; // staged
      const y = xy[1]; // unstaged
      let kind: 'staged' | 'unstaged' | 'untracked' | 'conflicted' | 'mixed';
      if (xy === '??') kind = 'untracked';
      else if (xy.includes('U') || xy === 'DD' || xy === 'AA') kind = 'conflicted';
      else if (x !== ' ' && y !== ' ') kind = 'mixed';
      else if (x !== ' ') kind = 'staged';
      else kind = 'unstaged';
      return { path, x, y, kind };
    });

    const summary = {
      staged: files.filter(f => f.kind === 'staged' || f.kind === 'mixed').length,
      unstaged: files.filter(f => f.kind === 'unstaged' || f.kind === 'mixed').length,
      untracked: files.filter(f => f.kind === 'untracked').length,
      conflicted: files.filter(f => f.kind === 'conflicted').length,
    };

    const result = { files, summary, scannedAt: new Date().toISOString() };
    cacheSet(cacheKey, result, TTL.status);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// =========================================================================
// GET /diff?repo=PATH&base=SHA&head=SHA&path=FILE
// Returns unified diff. If no base/head given: diff vs working tree.
// =========================================================================
router.get('/diff', async (req: AuthedReq, res) => {
  try {
    const repo = String(req.query.repo || '');
    const base = req.query.base ? String(req.query.base) : '';
    const head = req.query.head ? String(req.query.head) : '';
    const path = req.query.path ? String(req.query.path) : '';
    const root = resolveRepoRoot(req);
    if (!repo || !isPathAllowed(repo, root)) return res.status(403).json({ error: 'repo not accessible' });

    // simple SHA validation
    const isSha = (s: string) => /^[a-f0-9]{4,40}$/i.test(s);
    if (base && !isSha(base)) return res.status(400).json({ error: 'invalid base sha' });
    if (head && !isSha(head)) return res.status(400).json({ error: 'invalid head sha' });

    const cacheKey = `diff:${repo}:${base}:${head}:${path}`;
    if (base && head) {
      const cached = cacheGet<any>(cacheKey);
      if (cached) return res.json(cached);
    }

    const args: string[] = ['diff', '--no-color', '--unified=3'];
    if (base && head) {
      args.push(`${base}..${head}`);
    } else if (head) {
      args.push(`${head}^!`); // single commit
    }
    // else: working tree diff
    if (path) args.push('--', path);

    const diff = await git(repo, args, 30_000);
    const result = { diff, scannedAt: new Date().toISOString() };
    if (base && head) cacheSet(cacheKey, result, TTL.diff);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// =========================================================================
// POST /refresh — clear cache
// =========================================================================
router.post('/refresh', (_req, res) => {
  cache.clear();
  res.json({ message: 'git cache cleared' });
});

export default router;
