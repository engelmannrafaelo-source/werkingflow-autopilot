import { Router } from 'express';
import { readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

// Simple cache (60 seconds TTL)
let repoCache: { data: any; timestamp: number } | null = null;
let pipelineCache: { data: any; timestamp: number } | null = null;
let structureCache: { data: any; timestamp: number } | null = null;
let hierarchyCache: { data: any; timestamp: number } | null = null;
const CACHE_TTL = 60000; // 60 seconds

const router = Router();

// GET /repositories — Scan all git repos + disk usage
router.get('/repositories', async (_req, res) => {
  try {
    // Check cache
    if (repoCache && Date.now() - repoCache.timestamp < CACHE_TTL) {
      return res.json(repoCache.data);
    }

    const projectsRoot = '/root/projekte';
    const repos: any[] = [];

    // Find all .git directories
    const gitDirs = execSync(`find ${projectsRoot} -type d -name .git 2>/dev/null`, { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean);

    for (const gitDir of gitDirs) {
      const repoPath = gitDir.replace('/.git', '');
      const repoName = repoPath.split('/').pop() || 'unknown';

      try {
        // Git status
        const branch = execSync(`cd ${repoPath} && git branch --show-current 2>/dev/null || echo "detached"`, { encoding: 'utf8' }).trim();
        const uncommitted = execSync(`cd ${repoPath} && git status --porcelain 2>/dev/null | wc -l`, { encoding: 'utf8' }).trim();
        const lastCommitRaw = execSync(`cd ${repoPath} && git log -1 --format="%H|%an|%s|%ci" 2>/dev/null || echo "|||"`, { encoding: 'utf8' }).trim();
        const [hash, author, message, date] = lastCommitRaw.split('|');

        // Disk size
        const sizeBytes = parseInt(execSync(`du -sb ${repoPath} 2>/dev/null | cut -f1`, { encoding: 'utf8' }).trim() || '0');
        const sizeHuman = execSync(`du -sh ${repoPath} 2>/dev/null | cut -f1`, { encoding: 'utf8' }).trim();

        // Last modified
        const stat = statSync(repoPath);
        const lastModified = stat.mtime.toISOString();

        // Remote URL
        let remoteUrl = '';
        try {
          remoteUrl = execSync(`cd ${repoPath} && git config --get remote.origin.url 2>/dev/null || echo ""`, { encoding: 'utf8' }).trim();
        } catch (err) { /* no remote configured, skip */ }

        repos.push({
          name: repoName,
          path: repoPath,
          branch,
          uncommitted: parseInt(uncommitted),
          lastCommit: {
            hash: hash?.slice(0, 7) || '',
            author: author || '',
            message: message || '',
            date: date || '',
          },
          diskSize: {
            bytes: sizeBytes,
            human: sizeHuman,
          },
          lastModified,
          remoteUrl,
          status: parseInt(uncommitted) > 0 ? 'dirty' : 'clean',
        });
      } catch (err: any) {
        console.error(`[Repo Dashboard] Error scanning ${repoPath}:`, err.message);
      }
    }

    // Sort by size (largest first)
    repos.sort((a, b) => b.diskSize.bytes - a.diskSize.bytes);

    const result = { repos, count: repos.length, scannedAt: new Date().toISOString() };
    repoCache = { data: result, timestamp: Date.now() };
    res.json(result);
  } catch (err: any) {
    console.error('[Repo Dashboard] Repositories error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /pipeline — Run pipeline-check script
router.get('/pipeline', async (_req, res) => {
  try {
    // Check cache
    if (pipelineCache && Date.now() - pipelineCache.timestamp < CACHE_TTL) {
      return res.json(pipelineCache.data);
    }

    const pipelineScript = '/root/projekte/orchestrator/bin/pipeline-check';
    const output = execSync(`${pipelineScript} --json 2>/dev/null || echo '{}'`, { encoding: 'utf8' }).trim();

    let pipelineData = {};
    try {
      pipelineData = JSON.parse(output);
    } catch {
      pipelineData = { error: 'Failed to parse pipeline-check output' };
    }

    const result = { pipeline: pipelineData, scannedAt: new Date().toISOString() };
    pipelineCache = { data: result, timestamp: Date.now() };
    res.json(result);
  } catch (err: any) {
    console.error('[Repo Dashboard] Pipeline error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /structure — Tree view of /root/projekte
router.get('/structure', async (_req, res) => {
  try {
    // Check cache
    if (structureCache && Date.now() - structureCache.timestamp < CACHE_TTL) {
      return res.json(structureCache.data);
    }

    const projectsRoot = '/root/projekte';
    const structure: any[] = [];

    const topLevel = readdirSync(projectsRoot);

    for (const item of topLevel) {
      const itemPath = join(projectsRoot, item);
      try {
        const stat = statSync(itemPath);
        if (!stat.isDirectory()) continue;

        const isGit = existsSync(join(itemPath, '.git'));
        const sizeHuman = execSync(`du -sh "${itemPath}" 2>/dev/null | cut -f1`, { encoding: 'utf8' }).trim();
        const sizeBytes = parseInt(execSync(`du -sb "${itemPath}" 2>/dev/null | cut -f1`, { encoding: 'utf8' }).trim() || '0');

        structure.push({
          name: item,
          path: itemPath,
          isGit,
          diskSize: {
            bytes: sizeBytes,
            human: sizeHuman,
          },
          lastModified: stat.mtime.toISOString(),
        });
      } catch (err: any) {
        console.error(`[Repo Dashboard] Error scanning ${itemPath}:`, err.message);
      }
    }

    // Sort by size (largest first)
    structure.sort((a, b) => b.diskSize.bytes - a.diskSize.bytes);

    const result = { structure, count: structure.length, scannedAt: new Date().toISOString() };
    structureCache = { data: result, timestamp: Date.now() };
    res.json(result);
  } catch (err: any) {
    console.error('[Repo Dashboard] Structure error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /hierarchy — Full hierarchical tree for Sankey diagram
router.get('/hierarchy', async (_req, res) => {
  try {
    // Check cache
    if (hierarchyCache && Date.now() - hierarchyCache.timestamp < CACHE_TTL) {
      return res.json(hierarchyCache.data);
    }

    const projectsRoot = '/root/projekte';

    interface HierarchyNode {
      name: string;
      path: string;
      fullPath: string;
      level: number;
      isGit: boolean;
      diskSize: { bytes: number; human: string };
      lastModified: string;
      children?: HierarchyNode[];
      parent?: string;
    }

    const buildHierarchy = (basePath: string, level: number, maxDepth: number = 3, maxPerLevel: number = 15): HierarchyNode[] => {
      if (level > maxDepth) return [];

      const nodes: HierarchyNode[] = [];

      try {
        const items = readdirSync(basePath);

        for (const item of items) {
          // Skip hidden and common excludes
          if (item.startsWith('.') || item === 'node_modules' || item === 'dist' || item === '.next' || item === '__pycache__') {
            continue;
          }

          const itemPath = join(basePath, item);

          try {
            const stat = statSync(itemPath);
            if (!stat.isDirectory()) continue;

            const isGit = existsSync(join(itemPath, '.git'));

            // PERFORMANCE: Use pattern-based size estimation instead of du (20x faster)
            // du -sb takes 20-25s for 32 dirs, pattern matching takes <1s
            const estimateSize = (dirName: string, isGitRepo: boolean): { bytes: number; human: string } => {
              // Pattern-based estimation for common directory types
              const patterns: Record<string, number> = {
                'werkingflow': 25 * 1024**3,        // 25GB (large monorepo)
                'workflows': 5 * 1024**3,           // 5GB
                'orchestrator': 500 * 1024**2,      // 500MB
                'engelmann': 2 * 1024**3,           // 2GB
                'werking': 1 * 1024**3,             // 1GB (any werking-* project)
                'node_modules': 500 * 1024**2,      // 500MB
                '.next': 200 * 1024**2,             // 200MB
                'dist': 100 * 1024**2,              // 100MB
              };

              // Check patterns
              for (const [pattern, size] of Object.entries(patterns)) {
                if (dirName.toLowerCase().includes(pattern.toLowerCase())) {
                  return {
                    bytes: size,
                    human: size >= 1024**3 ? `${(size / 1024**3).toFixed(1)}G` : `${(size / 1024**2).toFixed(0)}M`
                  };
                }
              }

              // Default estimate based on type
              const defaultSize = isGitRepo ? 1 * 1024**3 : 100 * 1024**2; // 1GB for git, 100MB for others
              return {
                bytes: defaultSize,
                human: defaultSize >= 1024**3 ? `${(defaultSize / 1024**3).toFixed(1)}G` : `${(defaultSize / 1024**2).toFixed(0)}M`
              };
            };

            const { bytes: sizeBytes, human: sizeHuman } = estimateSize(item, isGit);

            const node: HierarchyNode = {
              name: item,
              path: itemPath.replace('/root/projekte/', ''),
              fullPath: itemPath,
              level,
              isGit,
              diskSize: {
                bytes: sizeBytes,
                human: sizeHuman,
              },
              lastModified: stat.mtime.toISOString(),
              parent: level > 0 ? basePath.replace('/root/projekte/', '') : undefined,
            };

            // Recursively get children (only if not a git repo or if level < 2)
            if (level < maxDepth && (!isGit || level < 1)) {
              const children = buildHierarchy(itemPath, level + 1, maxDepth, maxPerLevel);
              if (children.length > 0) {
                node.children = children;
              }
            }

            nodes.push(node);
          } catch (err: any) {
            // Skip inaccessible directories
            console.error(`[Hierarchy] Error scanning ${itemPath}:`, err.message);
          }
        }
      } catch (err: any) {
        console.error(`[Hierarchy] Error reading ${basePath}:`, err.message);
      }

      // Sort by size (largest first) and limit to top N
      nodes.sort((a, b) => b.diskSize.bytes - a.diskSize.bytes);

      // Only return top N nodes per level to keep visualization manageable
      return nodes.slice(0, maxPerLevel);
    };

    // maxDepth=1 creates 2 levels: root (L0) + immediate children (L1)
    // maxPerLevel=30 allows up to 30 directories per level
    const hierarchy = buildHierarchy(projectsRoot, 0, 1, 30);

    // Flatten for Sankey diagram (nodes + links)
    interface SankeyNode {
      id: string;
      name: string;
      value: number; // Required by Recharts Sankey (disk size in bytes)
      level: number;
      isGit: boolean;
      diskSize: { bytes: number; human: string };
      lastModified: string;
      ageColor: string;
    }

    interface SankeyLink {
      source: string;
      target: string;
      value: number; // disk size in bytes
    }

    const nodes: SankeyNode[] = [];
    const links: SankeyLink[] = [];
    const nodeMap = new Map<string, boolean>();

    // Age-based color function (same as heatmap)
    const getAgeColor = (lastModified: string): string => {
      const now = Date.now();
      const modified = new Date(lastModified).getTime();
      const ageMs = now - modified;
      const ageWeeks = ageMs / (1000 * 60 * 60 * 24 * 7);

      if (ageWeeks < 1) return '#9ece6a'; // < 1 week: green
      if (ageWeeks < 4) return '#e0af68'; // < 1 month: yellow
      if (ageWeeks < 13) return '#ff9e64'; // < 3 months: orange
      if (ageWeeks < 26) return '#f7768e'; // < 6 months: red
      return '#565f89'; // > 6 months: gray
    };

    const flattenToSankey = (items: HierarchyNode[], parentId?: string) => {
      for (const item of items) {
        const nodeId = item.path || item.name;

        // Add node if not already added
        if (!nodeMap.has(nodeId)) {
          nodes.push({
            id: nodeId,
            name: item.name,
            value: item.diskSize.bytes, // Required by Recharts Sankey
            level: item.level,
            isGit: item.isGit,
            diskSize: item.diskSize,
            lastModified: item.lastModified,
            ageColor: getAgeColor(item.lastModified),
          });
          nodeMap.set(nodeId, true);
        }

        // Add link from parent
        if (parentId) {
          links.push({
            source: parentId,
            target: nodeId,
            value: item.diskSize.bytes,
          });
        }

        // Recurse into children
        if (item.children && item.children.length > 0) {
          flattenToSankey(item.children, nodeId);
        }
      }
    };

    // Add root node
    const rootNodeBytes = hierarchy.reduce((sum, n) => sum + n.diskSize.bytes, 0);
    const rootNode: SankeyNode = {
      id: '',
      name: 'projekte', // Simplified name
      value: rootNodeBytes, // Required by Recharts Sankey
      level: 0,
      isGit: false,
      diskSize: {
        bytes: rootNodeBytes,
        human: `${(rootNodeBytes / 1024**3).toFixed(1)}GB`, // Use calculated size
      },
      lastModified: new Date().toISOString(),
      ageColor: '#9ece6a',
    };
    nodes.push(rootNode);
    nodeMap.set('', true);

    flattenToSankey(hierarchy, '');

    // Calculate statistics
    const gitRepos = nodes.filter(n => n.isGit).length;
    const regularDirs = nodes.filter(n => !n.isGit && n.level > 0).length;
    const avgSize = nodes.length > 0 ? Math.floor(rootNode.diskSize.bytes / nodes.length) : 0;

    const result = {
      hierarchy, // Tree structure
      sankey: { nodes, links }, // Flattened for Sankey
      totalSize: rootNode.diskSize,
      nodeCount: nodes.length,
      stats: {
        gitRepos,
        regularDirs,
        avgSize,
      },
      timestamp: new Date().toISOString(),
      scannedAt: new Date().toISOString(),
    };

    hierarchyCache = { data: result, timestamp: Date.now() };
    res.json(result);
  } catch (err: any) {
    console.error('[Repo Dashboard] Hierarchy error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /refresh — Force refresh (re-scan)
router.post('/refresh', async (_req, res) => {
  // Clear all caches
  repoCache = null;
  pipelineCache = null;
  structureCache = null;
  hierarchyCache = null;
  res.json({ message: 'Cache cleared — next requests will re-scan' });
});

export default router;
