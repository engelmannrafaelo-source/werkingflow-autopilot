// =============================================================================
// Maintenance Dashboard Route — /api/maintenance/*
// =============================================================================
// Aggregates freshness data from refs/, worklists, business docs, and git repos.

import { Router } from 'express';
import { existsSync, readdirSync, statSync, readFileSync } from 'fs';
import { resolve, basename } from 'path';
import { execFileSync } from 'child_process';

const router = Router();

// --- Paths ---
const REFS_DIR = '/home/claude-user/.cui-account1/.claude/refs';
const WORKLISTS_DIR = '/root/projekte/orchestrator/team/worklists';
const CLAUDE_MD = '/home/claude-user/.cui-account1/.claude/CLAUDE.md';
const BUSINESS_DIR = '/root/projekte/werkingflow/business';
const DOCS_MAINTENANCE_BIN = '/root/projekte/orchestrator/bin/docs-maintenance';

const REPOS: { name: string; path: string }[] = [
  { name: 'werkingflow-production', path: '/root/projekte/werkingflow-production' },
  { name: 'werkingflow', path: '/root/projekte/werkingflow' },
  { name: 'orchestrator', path: '/root/projekte/orchestrator' },
  { name: 'workflows', path: '/root/projekte/workflows' },
];

// --- Thresholds (days) ---
const REFS_STALE_DAYS = 14;
const WORKLIST_STALE_DAYS = 3;
const CLAUDE_MD_STALE_DAYS = 7;
const BUSINESS_STALE_DAYS = 30;

// --- Cache ---
let cache: { data: any; timestamp: number } | null = null;
const CACHE_TTL = 30000; // 30s

// --- Helpers ---
function ageDays(filePath: string): number {
  try {
    const mtime = statSync(filePath).mtimeMs;
    return Math.floor((Date.now() - mtime) / 86400000);
  } catch {
    return -1;
  }
}

function freshnessLevel(days: number, threshold: number): 'fresh' | 'warning' | 'stale' {
  if (days < 0) return 'stale';
  if (days <= threshold) return 'fresh';
  if (days <= threshold * 2) return 'warning';
  return 'stale';
}

function gitStatusSafe(repoPath: string): { branch: string; dirty: number; unpushed: number } {
  try {
    const branch = execFileSync('git', ['branch', '--show-current'], {
      cwd: repoPath, encoding: 'utf8', timeout: 5000,
    }).trim();

    const statusOut = execFileSync('git', ['status', '--porcelain'], {
      cwd: repoPath, encoding: 'utf8', timeout: 10000,
    }).trim();
    const dirty = statusOut ? statusOut.split('\n').length : 0;

    let unpushed = 0;
    try {
      const logOut = execFileSync('git', ['log', '@{u}..HEAD', '--oneline'], {
        cwd: repoPath, encoding: 'utf8', timeout: 5000,
      }).trim();
      unpushed = logOut ? logOut.split('\n').length : 0;
    } catch {
      // No upstream or error — ignore
    }

    return { branch, dirty, unpushed };
  } catch {
    return { branch: 'unknown', dirty: -1, unpushed: 0 };
  }
}

function scanDirectory(dir: string, extension: string, staleThreshold: number): any[] {
  if (!existsSync(dir)) return [];
  const results: any[] = [];
  try {
    const files = readdirSync(dir).filter(f => f.endsWith(extension));
    for (const file of files) {
      const fullPath = resolve(dir, file);
      const days = ageDays(fullPath);
      results.push({
        name: file,
        path: fullPath,
        ageDays: days,
        level: freshnessLevel(days, staleThreshold),
      });
    }
  } catch {
    // Directory read error
  }
  return results.sort((a, b) => b.ageDays - a.ageDays);
}

function scanBusinessDocs(): any[] {
  if (!existsSync(BUSINESS_DIR)) return [];
  const results: any[] = [];
  const subdirs = ['shared', 'marketing', 'customer-success', 'sales', 'finance'];

  for (const sub of subdirs) {
    const subPath = resolve(BUSINESS_DIR, sub);
    if (!existsSync(subPath)) continue;
    try {
      const files = readdirSync(subPath, { recursive: true }) as string[];
      for (const file of files) {
        if (!String(file).endsWith('.md')) continue;
        const fullPath = resolve(subPath, String(file));
        try {
          if (!statSync(fullPath).isFile()) continue;
        } catch { continue; }
        const days = ageDays(fullPath);
        results.push({
          name: `${sub}/${file}`,
          path: fullPath,
          ageDays: days,
          level: freshnessLevel(days, BUSINESS_STALE_DAYS),
        });
      }
    } catch {
      // Skip unreadable
    }
  }
  return results.sort((a, b) => b.ageDays - a.ageDays);
}

// --- GET /api/maintenance/status ---
router.get('/status', (_req, res) => {
  try {
    if (cache && Date.now() - cache.timestamp < CACHE_TTL) {
      return res.json(cache.data);
    }

    // 1. Refs freshness
    const refs = scanDirectory(REFS_DIR, '.md', REFS_STALE_DAYS);

    // 2. Worklists freshness
    const worklists = scanDirectory(WORKLISTS_DIR, '.md', WORKLIST_STALE_DAYS);

    // 3. CLAUDE.md
    const claudeMdAge = ageDays(CLAUDE_MD);
    const claudeMd = {
      ageDays: claudeMdAge,
      level: freshnessLevel(claudeMdAge, CLAUDE_MD_STALE_DAYS),
    };

    // 4. Business docs
    const businessDocs = scanBusinessDocs();

    // 5. Git repos
    const repos = REPOS.map(r => {
      if (!existsSync(r.path)) return { ...r, status: { branch: 'missing', dirty: -1, unpushed: 0 } };
      return { ...r, status: gitStatusSafe(r.path) };
    });

    // 6. Summary
    const staleRefs = refs.filter(r => r.level === 'stale').length;
    const staleWorklists = worklists.filter(w => w.level === 'stale').length;
    const staleBusiness = businessDocs.filter(d => d.level === 'stale').length;
    const dirtyRepos = repos.filter(r => r.status.dirty > 0).length;
    const unpushedRepos = repos.filter(r => r.status.unpushed > 0).length;

    const totalIssues = staleRefs + staleWorklists + staleBusiness + dirtyRepos + unpushedRepos
      + (claudeMd.level === 'stale' ? 1 : 0);

    const overallLevel: 'green' | 'yellow' | 'red' =
      totalIssues === 0 ? 'green' :
      totalIssues <= 3 ? 'yellow' : 'red';

    const result = {
      overall: { level: overallLevel, issues: totalIssues },
      team: {
        worklists,
        staleCount: staleWorklists,
      },
      docs: {
        refs,
        claudeMd,
        businessDocs,
        staleRefs,
        staleBusiness,
      },
      repos,
      dirtyRepos,
      unpushedRepos,
      checkedAt: new Date().toISOString(),
    };

    cache = { data: result, timestamp: Date.now() };
    res.json(result);
  } catch (err: any) {
    console.error('[Maintenance] status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- POST /api/maintenance/refresh --- (invalidate cache)
router.post('/refresh', (_req, res) => {
  cache = null;
  res.json({ ok: true, message: 'Cache cleared, next GET will re-scan' });
});

// --- POST /api/maintenance/run --- (trigger docs-maintenance)
router.post('/run', (_req, res) => {
  try {
    if (!existsSync(DOCS_MAINTENANCE_BIN)) {
      return res.status(404).json({ error: 'docs-maintenance script not found' });
    }

    // Run in dry-run mode first to show what would be done
    const dryRun = execFileSync('bash', [DOCS_MAINTENANCE_BIN, '--dry-run'], {
      encoding: 'utf8',
      timeout: 15000,
    });

    cache = null;
    res.json({ ok: true, output: dryRun });
  } catch (err: any) {
    console.error('[Maintenance] run error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
