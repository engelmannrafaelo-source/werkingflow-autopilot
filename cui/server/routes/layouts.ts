import { Router, Request, Response } from 'express';
import { join } from 'path';
import { homedir } from 'os';
import { IS_LOCAL_MODE } from './state.js';
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';

interface LayoutsDeps {
  LAYOUTS_DIR: string;
  PROJECTS_DIR: string;
  NOTES_DIR: string;
  UPLOADS_DIR: string;
  DATA_DIR: string;
}

/** Validates that an ID param contains only safe characters (no path traversal) */
function isValidId(id: string): boolean {
  return /^[a-zA-Z0-9_.-]+$/.test(id);
}

export default function createLayoutsRouter(deps: LayoutsDeps): Router {
  const router = Router();
  const { LAYOUTS_DIR, PROJECTS_DIR, NOTES_DIR, UPLOADS_DIR, DATA_DIR } = deps;

  // ============================================================================
  // Projects API
  // ============================================================================
  router.get('/projects', (_req: Request, res: Response) => {
    const projects = readdirSync(PROJECTS_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try { return JSON.parse(readFileSync(join(PROJECTS_DIR, f), 'utf8')); }
        catch { return null; }
      })
      .filter(Boolean);
    res.json(projects);
  });

  router.post('/projects', async (req: Request, res: Response) => {
    const project = req.body;
    if (!project?.id) {
      res.status(400).json({ error: 'project id required' });
      return;
    }
    if (!isValidId(project.id)) {
      res.status(400).json({ error: 'invalid project id: only alphanumeric, dash, underscore, dot allowed' });
      return;
    }

    // Only auto-create remote workspace for NEW projects (no existing file)
    const projectFile = join(PROJECTS_DIR, `${project.id}.json`);
    const isNew = !existsSync(projectFile);

    if (isNew && !project.workDir) {
      // Auto-create workspace: local (~/Projects/) or remote (/root/orchestrator/workspaces/)
      const baseDir = IS_LOCAL_MODE
        ? join(homedir(), 'Projects')
        : '/root/orchestrator/workspaces';
      const workDir = join(baseDir, project.id);
      try {
        mkdirSync(workDir, { recursive: true });
        project.workDir = workDir;
        console.log(`[Project] Created workspace: ${workDir}`);
      } catch (err: any) {
        console.error(`[Project] Failed to create workspace: ${err.message}`);
      }
    }

    writeFileSync(projectFile, JSON.stringify(project, null, 2));
    res.json({ ok: true });
  });

  router.delete('/projects/:id', (req: Request, res: Response) => {
    if (!isValidId(req.params.id)) {
      res.status(400).json({ error: 'invalid project id' });
      return;
    }
    const filePath = join(PROJECTS_DIR, `${req.params.id}.json`);
    if (existsSync(filePath)) unlinkSync(filePath);
    // Also remove associated notes and layout
    const notePath = join(NOTES_DIR, `${req.params.id}.md`);
    if (existsSync(notePath)) unlinkSync(notePath);
    const layoutPath = join(LAYOUTS_DIR, `${req.params.id}.json`);
    if (existsSync(layoutPath)) unlinkSync(layoutPath);
    res.json({ ok: true });
  });

  // ============================================================================
  // Notes API
  // ============================================================================
  // Common notes on a separate path to avoid clash with project ID 'common'
  router.get('/common-notes', (_req: Request, res: Response) => {
    const notePath = join(NOTES_DIR, 'common.md');
    if (!existsSync(notePath)) { res.json({ content: '' }); return; }
    res.json({ content: readFileSync(notePath, 'utf8') });
  });

  router.post('/common-notes', (req: Request, res: Response) => {
    writeFileSync(join(NOTES_DIR, 'common.md'), req.body.content ?? '');
    res.json({ ok: true });
  });

  router.get('/notes/:projectId', (req: Request, res: Response) => {
    if (!isValidId(req.params.projectId)) {
      res.status(400).json({ error: 'invalid projectId' });
      return;
    }
    const notePath = join(NOTES_DIR, `${req.params.projectId}.md`);
    if (!existsSync(notePath)) { res.json({ content: '' }); return; }
    res.json({ content: readFileSync(notePath, 'utf8') });
  });

  router.post('/notes/:projectId', (req: Request, res: Response) => {
    if (!isValidId(req.params.projectId)) {
      res.status(400).json({ error: 'invalid projectId' });
      return;
    }
    writeFileSync(join(NOTES_DIR, `${req.params.projectId}.md`), req.body.content ?? '');
    res.json({ ok: true });
  });

  // Shared Notes: auto-generated credentials (read-only)
  router.get('/shared-notes', (_req: Request, res: Response) => {
    const sharedPath = join(NOTES_DIR, 'shared.md');
    if (!existsSync(sharedPath)) {
      // Try generating on-the-fly
      const credPath = join(DATA_DIR, 'credentials.json');
      if (existsSync(credPath)) {
        try {
          const creds = JSON.parse(readFileSync(credPath, 'utf8'));
          const now = new Date().toISOString().split('T')[0];
          let md = `# Shared Notes - Zugangsdaten\n\n*Auto-generated: ${now}*\n\n---\n\n`;
          for (const [_appId, appData] of Object.entries(creds) as [string, any][]) {
            md += `## ${appData.name}`;
            if (appData.productionUrl) md += ` — [${appData.productionUrl}](${appData.productionUrl})`;
            md += `\n\n`;
            if (!appData.users?.length) { md += `*No users*\n\n`; continue; }
            md += `| Email | Password | Role | Notes |\n|-------|----------|------|-------|\n`;
            for (const u of appData.users) {
              md += `| ${u.email} | \`${u.password || '—'}\` | ${u.role || '—'} | ${u.notes || u.userId || '—'} |\n`;
            }
            if (appData.extras?.length) {
              md += `\n`;
              for (const e of appData.extras) md += `> ${e}\n`;
            }
            md += `\n---\n\n`;
          }
          md += `\n*Refresh: aggregate-credentials + generate-shared-notes*\n`;
          res.json({ content: md });
          return;
        } catch (err) { console.warn('[Server] shared-notes generation error:', err); }
      }
      res.json({ content: '' });
      return;
    }
    res.json({ content: readFileSync(sharedPath, 'utf8') });
  });

  // Shared Notes: trigger regeneration
  router.post('/shared-notes/refresh', async (_req: Request, res: Response) => {
    const { exec } = await import('child_process');
    const cwd = process.cwd();
    // Use simple script that reads DIRECTLY from test-credentials.json (Single Source of Truth)
    exec('npx tsx scripts/generate-shared-notes-simple.ts', { cwd, timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        console.error('[SharedNotes] Refresh failed:', stderr || err.message);
        res.status(500).json({ error: stderr || err.message });
        return;
      }
      console.log('[SharedNotes] Refreshed:', stdout);
      res.json({ ok: true, output: stdout });
    });
  });

  // ============================================================================
  // Layout API
  // ============================================================================
  router.get('/layouts/:projectId', (req: Request, res: Response) => {
    if (!isValidId(req.params.projectId)) {
      res.status(400).json({ error: 'invalid projectId' });
      return;
    }
    const layoutPath = join(LAYOUTS_DIR, `${req.params.projectId}.json`);
    if (!existsSync(layoutPath)) { res.json(null); return; }
    try {
      res.json(JSON.parse(readFileSync(layoutPath, 'utf8')));
    } catch {
      res.json(null);
    }
  });

  router.post('/layouts/:projectId', (req: Request, res: Response) => {
    if (!isValidId(req.params.projectId)) {
      res.status(400).json({ error: 'invalid projectId' });
      return;
    }
    writeFileSync(join(LAYOUTS_DIR, `${req.params.projectId}.json`), JSON.stringify(req.body, null, 2));
    res.json({ ok: true });
  });

  // Layout template (the "blueprint" from Layout Builder, used for restore)
  router.get('/layouts/:projectId/template', (req: Request, res: Response) => {
    if (!isValidId(req.params.projectId)) {
      res.status(400).json({ error: 'invalid projectId' });
      return;
    }
    const tplPath = join(LAYOUTS_DIR, `${req.params.projectId}_template.json`);
    if (!existsSync(tplPath)) { res.json(null); return; }
    try {
      res.json(JSON.parse(readFileSync(tplPath, 'utf8')));
    } catch {
      res.json(null);
    }
  });

  router.post('/layouts/:projectId/template', (req: Request, res: Response) => {
    if (!isValidId(req.params.projectId)) {
      res.status(400).json({ error: 'invalid projectId' });
      return;
    }
    writeFileSync(join(LAYOUTS_DIR, `${req.params.projectId}_template.json`), JSON.stringify(req.body, null, 2));
    res.json({ ok: true });
  });

  // ============================================================================
  // Upload API
  // ============================================================================
  router.post('/upload', (req: Request, res: Response) => {
    const { data, filename } = req.body;
    if (!data) {
      res.status(400).json({ error: 'data required (base64)' });
      return;
    }

    const ext = filename?.match(/\.[^.]+$/)?.[0] || '.png';
    const name = `${Date.now()}${ext}`;
    const filePath = join(UPLOADS_DIR, name);

    // Strip data URL prefix if present
    const base64Data = data.replace(/^data:image\/[^;]+;base64,/, '');
    writeFileSync(filePath, Buffer.from(base64Data, 'base64'));

    console.log(`[Upload] Saved ${name} (${Math.round(Buffer.from(base64Data, 'base64').length / 1024)}KB)`);
    res.json({ path: filePath, filename: name, url: `/api/uploads/${name}` });
  });

  // Upload images for CUI: saves locally + optionally sends to remote server
  const REMOTE_IMG_DIR = '/tmp/cui-images';

  router.post('/images', async (req: Request, res: Response) => {
    const { images, accountId } = req.body as {
      images: { name: string; data: string }[];
      accountId: string;
    };

    if (!images?.length) {
      res.status(400).json({ error: 'images array required' });
      return;
    }
    if (images.length > 20) {
      res.status(400).json({ error: 'too many images: maximum 20 per request' });
      return;
    }

    const results: { localPath: string; name: string }[] = [];

    // Save all images locally (server IS the dev server)
    mkdirSync(REMOTE_IMG_DIR, { recursive: true });
    for (const img of images) {
      const ext = img.name?.match(/\.[^.]+$/)?.[0] || '.png';
      const safeName = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}${ext}`;
      const localPath = join(REMOTE_IMG_DIR, safeName);
      const base64Data = img.data.replace(/^data:[^;]+;base64,/, '');
      writeFileSync(localPath, Buffer.from(base64Data, 'base64'));
      results.push({ localPath, name: safeName });
    }

    console.log(`[Images] Saved ${results.length} images to ${REMOTE_IMG_DIR}`);

    // Build the Read command for Claude
    const paths = results.map(r => r.localPath);
    const readCommand = paths.length === 1
      ? `Schau dir dieses Bild an: ${paths[0]}`
      : `Schau dir diese ${paths.length} Bilder an:\n${paths.map(p => `- ${p}`).join('\n')}`;

    res.json({
      ok: true,
      count: results.length,
      paths,
      readCommand,
      results,
    });
  });

  // Serve uploaded images
  router.get('/uploads/:filename', (req: Request, res: Response) => {
    if (!isValidId(req.params.filename)) {
      res.status(400).json({ error: 'invalid filename' });
      return;
    }
    const filePath = join(UPLOADS_DIR, req.params.filename);
    if (!existsSync(filePath)) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.sendFile(filePath);
  });

  // Clean up old uploads (keep last 100)
  router.delete('/uploads/cleanup', (_req: Request, res: Response) => {
    const files = readdirSync(UPLOADS_DIR)
      .map(f => ({ name: f, time: statSync(join(UPLOADS_DIR, f)).mtimeMs }))
      .sort((a, b) => b.time - a.time);
    let removed = 0;
    for (const f of files.slice(100)) {
      unlinkSync(join(UPLOADS_DIR, f.name));
      removed++;
    }
    res.json({ ok: true, removed });
  });

  return router;
}
