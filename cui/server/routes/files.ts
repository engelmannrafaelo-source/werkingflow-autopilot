import { Router, Request, Response } from 'express';
import { resolve, extname, join, basename } from 'path';
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, renameSync, copyFileSync } from 'fs';
import { homedir } from 'os';
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
  const { ACTIVE_DIR, PORT } = deps;

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
      ['.md', '.ts', '.tsx', '.js', '.jsx', '.py', '.sh', '.yml', '.yaml', '.toml', '.cfg', '.ini', '.env', '.csv', '.log'].includes(ext)
    ) {
      try {
        const content = readFileSync(resolved, 'utf8');
        res.json({ path: resolved, content, mimeType, ext });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
      return;
    }

    // For images/PDFs, serve the binary
    if (mimeType.startsWith('image/') || mimeType === 'application/pdf') {
      res.sendFile(resolved);
      return;
    }

    // Fallback: try to read as text
    try {
      const content = readFileSync(resolved, 'utf8');
      res.json({ path: resolved, content, mimeType, ext });
    } catch {
      res.status(415).json({ error: `Unsupported file type: ${mimeType}` });
    }
  });

  // --- Plan File Reader (for CUI Lite ExitPlanMode) ---
  router.get("/api/file-read", (req: Request, res: Response) => {
    const filePath = req.query.path as string;
    if (!filePath || !filePath.startsWith("/root/")) {
      res.status(400).send("Invalid path");
      return;
    }
    if (!filePath.includes(".claude/") || !filePath.endsWith(".md")) {
      res.status(403).send("Forbidden: only .claude/*.md files");
      return;
    }
    try {
      const text = readFileSync(filePath, "utf8");
      res.type("text/plain").send(text);
    } catch {
      res.status(404).send("File not found");
    }
  });

  // --- ACTIVE Folder API ---
  // Returns the ACTIVE folder path for a project (auto-creates it)
  router.get('/api/active-dir/:projectId', (req: Request, res: Response) => {
    const dir = join(ACTIVE_DIR, req.params.projectId);
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
      if (!existsSync(resolvedSource)) { res.status(404).json({ error: 'source file not found' }); return; }
      mkdirSync(resolvedTargetDir, { recursive: true });
      if (op === 'move') { renameSync(resolvedSource, resolvedTarget); }
      else { copyFileSync(resolvedSource, resolvedTarget); }
      res.json({ ok: true, targetPath: resolvedTarget, operation: op });
    } catch (err: any) { res.status(500).json({ error: `File operation failed: ${err.message}` }); }
  });

  return router;
}

export { resolvePath };
