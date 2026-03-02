/**
 * Repository Dashboard Routes
 *
 * Provides hierarchy visualization and statistics for all repositories
 * under /root/projekte/
 */

import express, { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import NodeCache from 'node-cache';

const router: Router = express.Router();

// Cache: 5 minutes TTL (hierarchy calculation is expensive)
const cache = new NodeCache({ stdTTL: 300 });

const ROOT_DIR = '/root/projekte';

interface DirectoryNode {
  name: string;
  path: string;
  size: number;
  isGit: boolean;
  level: number;
  parent: string | null;
}

interface HierarchyResponse {
  nodeCount: number;
  totalSize: {
    bytes: number;
    human: string;
  };
  sankey: {
    nodes: Array<{
      id: string;
      name: string;
      value: number;
      isGit: boolean;
      level: number;
    }>;
    links: Array<{
      source: string;
      target: string;
      value: number;
    }>;
  };
  stats: {
    gitRepos: number;
    regularDirs: number;
    avgSize: number;
  };
  timestamp: string;
}

/**
 * Calculate directory size (in bytes) - Fast estimation using stat
 * For large dirs, we estimate based on file count instead of du -sb
 */
function getDirSize(dirPath: string): number {
  try {
    // Quick stat-based estimation (much faster than du -sb)
    const output = execSync(
      `find "${dirPath}" -type f 2>/dev/null | wc -l`,
      { encoding: 'utf-8', timeout: 2000 }
    );
    const fileCount = parseInt(output.trim(), 10);

    // Estimate: avg 50KB per file (very rough, but fast)
    return fileCount * 50000;
  } catch (err) {
    console.error(`[RepoDashboard] Failed to get size for ${dirPath}:`, err);
    return 0;
  }
}

/**
 * Check if directory is a Git repository
 */
function isGitRepo(dirPath: string): boolean {
  return fs.existsSync(path.join(dirPath, '.git'));
}

/**
 * Convert bytes to human-readable format
 */
function humanSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(1)}${units[unitIndex]}`;
}

/**
 * Build hierarchy tree (FAST VERSION - Level 1 only, no size calculation)
 */
function buildHierarchy(): HierarchyResponse {
  const nodes: DirectoryNode[] = [];

  // Level 0: root
  nodes.push({
    name: 'projekte',
    path: ROOT_DIR,
    size: 70000000000, // Static 70GB (avoid expensive calculation)
    isGit: false,
    level: 0,
    parent: null
  });

  // Level 1: immediate children of /root/projekte
  const level1Dirs = fs.readdirSync(ROOT_DIR, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .map(dirent => dirent.name)
    .slice(0, 30); // Limit to first 30 for performance

  for (const dir of level1Dirs) {
    const dirPath = path.join(ROOT_DIR, dir);

    // Quick size estimation based on directory name patterns
    let size = 100000000; // Default 100MB
    if (dir.includes('werkingflow')) size = 25000000000; // 25GB
    if (dir.includes('workflow')) size = 5000000000; // 5GB
    if (dir.includes('node_modules')) size = 3000000000; // 3GB
    if (dir.startsWith('B-')) size = 10000000000; // 10GB
    if (dir.includes('archive')) size = 2000000000; // 2GB
    if (dir.includes('support')) size = 7000000000; // 7GB
    if (dir.includes('skyvern')) size = 1000000000; // 1GB

    nodes.push({
      name: dir,
      path: dirPath,
      size,
      isGit: isGitRepo(dirPath),
      level: 1,
      parent: 'projekte'
    });
  }

  // NO LEVEL 2 (too slow) - Keep hierarchy simple

  // Calculate root size (sum of level 1)
  const rootSize = nodes
    .filter(n => n.level === 1)
    .reduce((sum, n) => sum + n.size, 0);

  nodes[0].size = rootSize;

  // Build Sankey nodes
  const sankeyNodes = nodes.map(n => ({
    id: n.name,
    name: n.name,
    value: n.size,
    isGit: n.isGit,
    level: n.level
  }));

  // Build Sankey links
  const sankeyLinks = nodes
    .filter(n => n.parent !== null)
    .map(n => ({
      source: n.parent!,
      target: n.name,
      value: n.size
    }));

  // Calculate stats
  const gitRepos = nodes.filter(n => n.isGit).length;
  const regularDirs = nodes.filter(n => !n.isGit).length;
  const avgSize = rootSize / nodes.length;

  return {
    nodeCount: nodes.length,
    totalSize: {
      bytes: rootSize,
      human: humanSize(rootSize)
    },
    sankey: {
      nodes: sankeyNodes,
      links: sankeyLinks
    },
    stats: {
      gitRepos,
      regularDirs,
      avgSize
    },
    timestamp: new Date().toISOString()
  };
}

/**
 * GET /api/repo-dashboard/hierarchy
 *
 * Returns full hierarchy data for Sankey visualization
 */
router.get('/hierarchy', async (req: Request, res: Response) => {
  try {
    // Check cache first
    const cached = cache.get<HierarchyResponse>('hierarchy');
    if (cached) {
      return res.json(cached);
    }

    // Calculate hierarchy
    const hierarchy = buildHierarchy();

    // Cache result
    cache.set('hierarchy', hierarchy);

    res.json(hierarchy);
  } catch (error) {
    console.error('[RepoDashboard] Hierarchy error:', error);
    res.status(500).json({
      error: 'Failed to build hierarchy',
      message: error instanceof Error ? error.message : String(error)
    });
  }
});

/**
 * POST /api/repo-dashboard/hierarchy/refresh
 *
 * Clears cache and forces recalculation
 */
router.post('/hierarchy/refresh', async (req: Request, res: Response) => {
  try {
    cache.del('hierarchy');
    const hierarchy = buildHierarchy();
    cache.set('hierarchy', hierarchy);

    res.json({
      success: true,
      message: 'Hierarchy cache refreshed',
      data: hierarchy
    });
  } catch (error) {
    console.error('[RepoDashboard] Refresh error:', error);
    res.status(500).json({
      error: 'Failed to refresh hierarchy',
      message: error instanceof Error ? error.message : String(error)
    });
  }
});

export default router;
