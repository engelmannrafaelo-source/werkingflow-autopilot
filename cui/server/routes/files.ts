import { Router, Request, Response } from 'express';
import { resolve, extname, join, basename } from 'path';
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, renameSync, copyFileSync, realpathSync } from 'fs';
import { homedir, platform } from 'os';
import mime from 'mime-types';

interface FilesDeps {
  DATA_DIR: string;
  ACTIVE_DIR: string;
  PORT: number;
}

// Resolve ~ to home directory
function resolvePath(p: string): string {
  if (p.startsWith('~/') || p === '~') return join(homedir(), p.slice(1));
  return resolve(p);
}

export default function createFilesRouter(deps: FilesDeps): Router {
  const router = Router();
  const { ACTIVE_DIR, PORT, DATA_DIR } = deps;

  // Allowed filesystem bases — all path access must resolve within one of these
  const ALLOWED_PATH_BASES = [
    '/root/projekte',
    '/root/orchestrator',
    '/home/claude-user',
    '/tmp',
    DATA_DIR,
    ACTIVE_DIR,
    // Local mode (Mac): allow user home directory
    ...(platform() === 'darwin' ? [homedir()] : []),
  ];

  /** Returns true if resolved path is within an allowed base directory */
  function validatePath(resolved: string): boolean {
    return ALLOWED_PATH_BASES.some(base => resolved === base || resolved.startsWith(base + '/'));
  }

  // ============================================================================
  // Health & Version Endpoints (for Watchdog integration)
  // ============================================================================
  router.get("/api/health", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      app: "cui-workspace",
      port: PORT,
      uptime: process.uptime(),
      memory: process.memoryUsage().rss,
      timestamp: new Date().toISOString(),
    });
  });

  router.get("/api/version", (_req: Request, res: Response) => {
    res.json({
      app: "cui-workspace",
      version: "1.0.0",
      node: process.version,
      timestamp: new Date().toISOString(),
    });
  });

  // Get build timestamp from dist/index.html mtime
  router.get("/api/build-info", (_req: Request, res: Response) => {
    const distIndexPath = resolve(import.meta.dirname ?? '.', '..', '..', 'dist', 'index.html');
    let buildTime: string | null = null;

    try {
      if (existsSync(distIndexPath)) {
        const stats = statSync(distIndexPath);
        buildTime = stats.mtime.toISOString();
      }
    } catch (err) {
      console.error('[build-info] Error reading dist/index.html:', err);
    }

    res.json({
      buildTime,
      distExists: existsSync(distIndexPath),
    });
  });

  // List directory contents
  router.get('/api/files', async (req: Request, res: Response) => {
    const dirPath = req.query.path as string;
    if (!dirPath) {
      res.status(400).json({ error: 'path required' });
      return;
    }

    // All paths are local (server runs on dev server)
    const resolved = resolvePath(dirPath);
    if (!validatePath(resolved)) {
      res.status(403).json({ error: 'path outside allowed directories' });
      return;
    }
    if (!existsSync(resolved)) {
      res.status(404).json({ error: 'not found' });
      return;
    }

    try {
      const stat = statSync(resolved);
      if (!stat.isDirectory()) {
        res.status(400).json({ error: 'not a directory' });
        return;
      }

      const entries = readdirSync(resolved, { withFileTypes: true })
        .filter((e) => !e.name.startsWith('.'))
        .map((e) => ({
          name: e.name,
          path: join(resolved, e.name),
          isDir: e.isDirectory(),
          ext: e.isDirectory() ? null : extname(e.name).toLowerCase(),
        }))
        .sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
          return a.name.localeCompare(b.name);
        });

      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.json({ path: resolved, entries });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Disk tree visualization endpoint
  router.get('/api/disk-tree', async (req: Request, res: Response) => {
    const dirPath = req.query.path as string;
    const maxDepth = parseInt(req.query.maxDepth as string) || 2;
    const maxPerLevel = parseInt(req.query.maxPerLevel as string) || 20;

    if (!dirPath) {
      res.status(400).json({ error: 'path required' });
      return;
    }

    const resolved = resolvePath(dirPath);
    if (!validatePath(resolved)) {
      res.status(403).json({ error: 'path outside allowed directories' });
      return;
    }
    if (!existsSync(resolved)) {
      res.status(404).json({ error: 'not found' });
      return;
    }

    try {
      const stat = statSync(resolved);
      if (!stat.isDirectory()) {
        res.status(400).json({ error: 'not a directory' });
        return;
      }

      // Build tree structure
      const buildTree = (path: string, depth: number, id: string): any => {
        if (depth > maxDepth) return null;

        const stat = statSync(path);
        const node: any = {
          id,
          name: basename(path),
          path,
          value: stat.size,
          isDir: stat.isDirectory(),
        };

        if (stat.isDirectory() && depth < maxDepth) {
          const children = readdirSync(path, { withFileTypes: true })
            .filter(e => !e.name.startsWith('.'))
            .slice(0, maxPerLevel)
            .map((e, i) => {
              const childPath = join(path, e.name);
              const childId = `${id}-${i}`;
              return buildTree(childPath, depth + 1, childId);
            })
            .filter(Boolean);

          if (children.length > 0) {
            node.children = children;
          }
        }

        return node;
      };

      const root = buildTree(resolved, 0, '0');

      // Flatten tree to array
      const nodes: any[] = [];
      const flatten = (node: any) => {
        if (!node) return;
        const { children, ...rest } = node;
        nodes.push(rest);
        if (children) {
          children.forEach(flatten);
        }
      };
      flatten(root);

      // Calculate stats
      const totalSize = nodes.reduce((sum, n) => sum + (n.value || 0), 0);
      const dirCount = nodes.filter(n => n.isDir).length;
      const fileCount = nodes.filter(n => !n.isDir).length;

      res.json({
        nodes,
        stats: {
          totalSize,
          dirCount,
          fileCount,
        },
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Read file content (supports DOCX→HTML and XLSX→HTML conversion)
  router.get('/api/file', async (req: Request, res: Response) => {
    const filePath = req.query.path as string;
    if (!filePath) {
      res.status(400).json({ error: 'path required' });
      return;
    }

    // All files are local (server runs on dev server)
    const resolved = resolvePath(filePath);
    if (!validatePath(resolved)) {
      res.status(403).json({ error: 'path outside allowed directories' });
      return;
    }
    if (!existsSync(resolved)) {
      res.status(404).json({ error: 'not found' });
      return;
    }

    const ext = extname(resolved).toLowerCase();
    const mimeType = mime.lookup(ext) || 'application/octet-stream';

    // DOCX → convert to HTML with mammoth
    if (ext === '.docx') {
      try {
        const mammoth = await import('mammoth');
        const result = await mammoth.default.convertToHtml({ path: resolved });
        const styled = `<style>body{font-family:-apple-system,system-ui,sans-serif;font-size:14px;line-height:1.6;color:#333;padding:20px;max-width:900px;margin:0 auto}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:8px}h1,h2,h3{color:#1a1b26}</style>${result.value}`;
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.json({ path: resolved, content: styled, mimeType: 'text/html', ext: '.html' });
      } catch (err: any) {
        res.status(500).json({ error: `DOCX conversion failed: ${err.message}` });
      }
      return;
    }

    // XLSX/XLS → convert to HTML tables
    if (ext === '.xlsx' || ext === '.xls') {
      try {
        const XLSX = await import('xlsx');
        const wb = XLSX.readFile(resolved);
        const sheets = wb.SheetNames.map(name => {
          const html = XLSX.utils.sheet_to_html(wb.Sheets[name]);
          return `<h2 style="color:#7aa2f7;margin:16px 0 8px">${name}</h2>${html}`;
        }).join('');
        const styled = `<style>body{font-family:-apple-system,system-ui,sans-serif;font-size:13px;color:#333;padding:16px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:6px 10px;text-align:left}th{background:#f5f5f5;font-weight:600}tr:nth-child(even){background:#fafafa}</style>${sheets}`;
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.json({ path: resolved, content: styled, mimeType: 'text/html', ext: '.html' });
      } catch (err: any) {
        res.status(500).json({ error: `XLSX conversion failed: ${err.message}` });
      }
      return;
    }

    // For text/code files, return as text
    if (
      mimeType.startsWith('text/') ||
      mimeType === 'application/json' ||
      ['.md', '.ts', '.tsx', '.js', '.jsx', '.py', '.sh', '.yml', '.yaml', '.toml', '.cfg', '.ini', '.env', '.csv', '.log', '.mmd', '.merm'].includes(ext)
    ) {
      try {
        const content = readFileSync(resolved, 'utf8');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.json({ path: resolved, content, mimeType, ext });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
      return;
    }

    // For images/PDFs, serve the binary
    if (mimeType.startsWith('image/') || mimeType === 'application/pdf') {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.sendFile(resolved);
      return;
    }

    // Fallback: try to read as text
    try {
      const content = readFileSync(resolved, 'utf8');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.json({ path: resolved, content, mimeType, ext });
    } catch {
      res.status(415).json({ error: `Unsupported file type: ${mimeType}` });
    }
  });

  // --- Plan File Reader (for CUI Lite ExitPlanMode) ---
  router.get("/api/file-read", (req: Request, res: Response) => {
    const filePath = req.query.path as string;
    if (!filePath) {
      res.status(400).send("Invalid path");
      return;
    }
    // Resolve first to neutralize ../ traversal, then validate
    const resolved = resolve(filePath);
    if (!resolved.startsWith("/root/")) {
      res.status(403).send("Forbidden: path must be under /root/");
      return;
    }
    if (!resolved.includes(".claude/") || !resolved.endsWith(".md")) {
      res.status(403).send("Forbidden: only .claude/*.md files");
      return;
    }
    try {
      const text = readFileSync(resolved, "utf8");
      res.type("text/plain").send(text);
    } catch {
      res.status(404).send("File not found");
    }
  });

  // --- ACTIVE Folder API ---
  // Returns the ACTIVE folder path for a project (auto-creates it)
  router.get('/api/active-dir/:projectId', (req: Request, res: Response) => {
    const projectId = req.params.projectId;
    if (!/^[a-zA-Z0-9_-]+$/.test(projectId)) {
      res.status(400).json({ error: 'invalid projectId: only alphanumeric, dash, underscore allowed' });
      return;
    }
    const dir = join(ACTIVE_DIR, projectId);
    mkdirSync(dir, { recursive: true });
    res.json({ path: dir });
  });

  // --- File Move/Copy ---
  router.post('/api/files/move', async (req: Request, res: Response) => {
    const { sourcePath, targetDir, operation } = req.body as { sourcePath: string; targetDir: string; operation?: 'move' | 'copy' };
    if (!sourcePath || !targetDir) { res.status(400).json({ error: 'sourcePath and targetDir required' }); return; }
    const op = operation || 'move';
    try {
      const sourceFilename = sourcePath.split('/').pop() || 'file';
      const targetPath = targetDir.endsWith('/') ? `${targetDir}${sourceFilename}` : `${targetDir}/${sourceFilename}`;
      const resolvedSource = resolvePath(sourcePath);
      const resolvedTarget = resolvePath(targetPath);
      const resolvedTargetDir = resolvePath(targetDir);
      if (!validatePath(resolvedSource)) {
        res.status(403).json({ error: 'source path outside allowed directories' });
        return;
      }
      if (!validatePath(resolvedTarget)) {
        res.status(403).json({ error: 'target path outside allowed directories' });
        return;
      }
      if (!existsSync(resolvedSource)) { res.status(404).json({ error: 'source file not found' }); return; }
      mkdirSync(resolvedTargetDir, { recursive: true });
      if (op === 'move') { renameSync(resolvedSource, resolvedTarget); }
      else { copyFileSync(resolvedSource, resolvedTarget); }
      res.json({ ok: true, targetPath: resolvedTarget, operation: op });
    } catch (err: any) { res.status(500).json({ error: `File operation failed: ${err.message}` }); }
  });

  // --- CLAUDE.md Map Endpoint ---
  // Returns all CLAUDE.md files grouped by area, with extracted refs
  let claudeMapCache: { data: any; ts: number } | null = null;
  const CLAUDE_MAP_TTL = 5 * 60 * 1000; // 5 min cache

  router.get('/api/claude-map', (_req: Request, res: Response) => {
    const now = Date.now();
    if (claudeMapCache && (now - claudeMapCache.ts) < CLAUDE_MAP_TTL) {
      res.json(claudeMapCache.data);
      return;
    }

    try {
      const searchBases = ['/root/projekte', '/home/claude-user/.claude', '/home/claude-user/.cui-account1/.claude'];
      const found: Array<{ path: string; label: string; refs: Array<{ label: string; path: string; type: string }> }> = [];

      // Recursive CLAUDE.md finder (max depth 6)
      function findClaudeMds(dir: string, depth: number): void {
        if (depth > 6) return;
        try {
          const entries = readdirSync(dir, { withFileTypes: true });
          for (const e of entries) {
            if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '_archive' || e.name === 'archive') continue;
            const full = join(dir, e.name);
            if (e.isDirectory()) {
              findClaudeMds(full, depth + 1);
            } else if (e.name === 'CLAUDE.md') {
              // Extract refs from content — comprehensive pattern matching
              const refs: Array<{ label: string; path: string; type: string }> = [];
              const seenPaths = new Set<string>();
              const claudeDir = dir; // directory containing this CLAUDE.md

              function addRef(label: string, rawPath: string, type: string) {
                // Resolve to absolute path
                let resolved = rawPath;
                if (rawPath.startsWith('refs/')) {
                  resolved = `/home/claude-user/.claude/${rawPath}`;
                } else if (rawPath.startsWith('/')) {
                  resolved = rawPath;
                } else if (rawPath.startsWith('~/')) {
                  resolved = join(homedir(), rawPath.slice(2));
                } else {
                  resolved = resolve(claudeDir, rawPath);
                }
                // Skip URLs, duplicates, non-doc files
                if (rawPath.startsWith('http') || seenPaths.has(resolved)) return;
                // Only include doc-like files (.md, .json, .yaml, .yml, .html, .pdf)
                if (!/\.(md|json|ya?ml|html|pdf|txt)$/i.test(resolved)) return;
                // Skip template/placeholder paths with {curly braces}
                if (/\{[^}]+\}/.test(rawPath)) return;
                // Only include files that actually exist
                if (!existsSync(resolved)) return;
                // Normalize to real path for dedup (handles symlinks like /root/.claude → /home/claude-user/.claude)
                try { resolved = realpathSync(resolved); } catch {}
                if (seenPaths.has(resolved)) return;
                seenPaths.add(resolved);
                // Use short display label
                let displayLabel = label && label !== basename(rawPath) ? label : rawPath;
                // Shorten absolute paths for display
                displayLabel = displayLabel
                  .replace('/root/projekte/', '')
                  .replace('/home/claude-user/.claude/', '~/.claude/')
                  .replace('/root/.claude/', '~/.claude/');
                refs.push({ label: displayLabel, path: resolved, type });
              }

              try {
                const content = readFileSync(full, 'utf8');
                const lines = content.split('\n');

                for (const line of lines) {
                  // Pattern 1: refs/*.md inline references
                  const refsInline = line.matchAll(/refs\/[a-zA-Z0-9_-]+\.md/g);
                  for (const m of refsInline) {
                    addRef(m[0], m[0], 'ref');
                  }

                  // Pattern 2: [text](path.md) markdown links
                  const mdLinks = line.matchAll(/\[([^\]]*)\]\(([^)]+\.(?:md|json|ya?ml|html|pdf))\)/g);
                  for (const m of mdLinks) {
                    addRef(m[1] || m[2], m[2], 'link');
                  }

                  // Pattern 3: backtick-quoted file paths in tables: `docs/FILE.md`
                  const backtickPaths = line.matchAll(/`([^`]*\/[^`]+\.(?:md|json|ya?ml|html|pdf|txt))`/g);
                  for (const m of backtickPaths) {
                    // Skip absolute system paths and URLs
                    const p = m[1];
                    if (p.startsWith('/etc/') || p.startsWith('/var/') || p.startsWith('/tmp/')) continue;
                    addRef(basename(p), p, 'doc');
                  }

                  // Pattern 4: Detail-Referenzen table pattern: | Label | `path` | or | Label | path |
                  // Match table rows with a path-like value in the last cell
                  if (line.includes('|') && /\|\s*`?([a-zA-Z0-9_./-]+\.(?:md|json|ya?ml))`?\s*\|?\s*$/.test(line)) {
                    const tableMatch = line.match(/\|\s*\*?\*?([^|*]+?)\*?\*?\s*\|\s*`?([a-zA-Z0-9_./-]+\.(?:md|json|ya?ml))`?\s*\|?\s*$/);
                    if (tableMatch) {
                      addRef(tableMatch[1].trim(), tableMatch[2], 'table');
                    }
                  }
                }
              } catch {}

              // Create short label from path
              const label = full
                .replace('/root/projekte/', '')
                .replace('/home/claude-user/.cui-account1/.claude/', '~/.claude (project)/')
                .replace('/home/claude-user/.claude/', '~/.claude/')
                .replace('/CLAUDE.md', '');

              found.push({ path: full, label, refs });
            }
          }
        } catch {}
      }

      for (const base of searchBases) {
        if (existsSync(base)) findClaudeMds(base, 0);
      }

      // Deduplicate (multiple search bases can find same logical file)
      const seen = new Set<string>();
      const deduped = found.filter(f => {
        if (seen.has(f.path)) return false;
        seen.add(f.path);
        return true;
      });

      // Group by area
      const groupRules: Array<{ key: string; label: string; test: (p: string) => boolean; order: number }> = [
        { key: 'active', label: 'Aktiv (Engelmann)', test: p => p.includes('apps/engelmann'), order: 0 },
        { key: 'apps', label: 'Production Apps', test: p => p.includes('werkingflow-production/apps/') && !p.includes('engelmann'), order: 1 },
        { key: 'testing', label: 'Testing', test: p => p.includes('unified-tester') || p.includes('/tests/'), order: 2 },
        { key: 'cui', label: 'CUI & Workspace', test: p => p.includes('autopilot') || p.includes('/cui/'), order: 3 },
        { key: 'infra', label: 'Infrastruktur', test: p => (p.includes('/werkingflow/') && !p.includes('business/') && !p.includes('werkingflow-production')) || p.includes('/orchestrator/'), order: 4 },
        { key: 'workflows', label: 'Workflows', test: p => p.includes('/workflows/'), order: 5 },
        { key: 'support', label: 'Support', test: p => p.includes('/support/'), order: 6 },
        { key: 'global', label: 'Global Config', test: p => p.includes('.claude/'), order: 7 },
        { key: 'other', label: 'Sonstige', test: () => true, order: 8 },
      ];

      const groups: Array<{ key: string; label: string; items: typeof deduped }> = [];
      const assigned = new Set<string>();

      for (const rule of groupRules.sort((a, b) => a.order - b.order)) {
        const items = deduped.filter(f => !assigned.has(f.path) && rule.test(f.path));
        if (items.length > 0) {
          items.forEach(i => assigned.add(i.path));
          groups.push({ key: rule.key, label: rule.label, items });
        }
      }

      // Add refs group from global CLAUDE.md
      const globalClaude = deduped.find(f => f.path.includes('.claude/CLAUDE.md') && f.refs.some(r => r.path.includes('/refs/')));
      if (globalClaude) {
        const refItems = globalClaude.refs
          .filter(r => r.path.includes('/refs/'))
          .map(r => ({ path: r.path, label: r.label, refs: [] as Array<{ label: string; path: string; type: string }> }))
          .filter(r => existsSync(r.path));

        if (refItems.length > 0) {
          // Insert refs after infra group
          const infraIdx = groups.findIndex(g => g.key === 'infra');
          groups.splice(infraIdx + 1, 0, { key: 'refs', label: 'Refs (Detail-Docs)', items: refItems });
        }
      }

      const result = { groups, total: deduped.length };
      claudeMapCache = { data: result, ts: now };
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

export { resolvePath };
