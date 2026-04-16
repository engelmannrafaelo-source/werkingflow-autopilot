import { Router, Request, Response } from 'express';
import { join } from 'path';
import { homedir } from 'os';
import { IS_LOCAL_MODE, broadcast } from './state.js';
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
import Busboy from 'busboy';

interface LayoutsDeps {
  LAYOUTS_DIR: string;
  PROJECTS_DIR: string;
  NOTES_DIR: string;
  UPLOADS_DIR: string;
  DATA_DIR: string;
}

// --- Pinned Panels ---
interface PinnedTabset {
  id: string;
  position: 'left' | 'right';
  weight: number;
  tabs: Array<{ name: string; component: string; config: Record<string, unknown> }>;
}

interface PinnedPanelsConfig {
  pinnedTabsets: PinnedTabset[];
}

function readPinnedPanels(dataDir: string): PinnedPanelsConfig {
  const filePath = join(dataDir, 'pinned-panels.json');
  if (!existsSync(filePath)) return { pinnedTabsets: [] };
  try { return JSON.parse(readFileSync(filePath, 'utf8')); }
  catch { return { pinnedTabsets: [] }; }
}

function writePinnedPanels(dataDir: string, config: PinnedPanelsConfig): void {
  writeFileSync(join(dataDir, 'pinned-panels.json'), JSON.stringify(config, null, 2));
}

/** Merge pinned tabsets into a layout JSON (for GET responses).
 *  Pinned panels get injected at fixed positions with their exact saved weight,
 *  so every workspace has the identical panel arrangement and size. */
export function mergePinnedIntoLayout(layout: any, pinned: PinnedPanelsConfig): any {
  if (!pinned.pinnedTabsets.length || !layout?.layout) return layout;
  const root = layout.layout;
  if (root.type !== 'row' || !Array.isArray(root.children)) return layout;

  // Remove any existing nodes with pinned IDs first (avoid duplicates on re-merge)
  const pinnedIds = new Set(pinned.pinnedTabsets.map(pt => pt.id));
  function stripPinned(node: any): any {
    if (!node) return node;
    if (pinnedIds.has(node.id)) return null;
    if (Array.isArray(node.children)) {
      node.children = node.children.map(stripPinned).filter(Boolean);
    }
    return node;
  }
  stripPinned(root);

  // Also strip placeholder from previous merges
  if (Array.isArray(root.children)) {
    root.children = root.children.filter((c: any) => c.id !== '#pinned-placeholder');
  }

  // Build pinned tabset nodes with exact saved weight
  const pinnedNodes = pinned.pinnedTabsets.map(pt => ({
    type: 'tabset' as const,
    id: pt.id,
    weight: pt.weight,
    children: pt.tabs.map((tab, i) => ({
      type: 'tab' as const,
      id: `${pt.id}-tab-${i}`,
      name: tab.name,
      component: tab.component,
      config: { ...tab.config, _pinned: true },
    })),
    _pinned: true,
  }));

  // Group by position
  const leftPinned = pinnedNodes.filter((_, i) => pinned.pinnedTabsets[i].position === 'left');
  const rightPinned = pinnedNodes.filter((_, i) => pinned.pinnedTabsets[i].position === 'right');

  // Calculate total pinned weight to set remaining content weight proportionally
  const totalPinnedWeight = pinned.pinnedTabsets.reduce((s, pt) => s + pt.weight, 0);
  const contentWeight = Math.max(100 - totalPinnedWeight, 20);

  // Scale existing children's weights to fit within the remaining content space.
  // IMPORTANT: Do NOT wrap in a nested row — flexlayout alternates direction on nesting,
  // which would cause vertical stacking. Keep everything flat in the top-level row.
  const existingChildren = root.children;
  if (existingChildren.length > 0) {
    const totalExisting = existingChildren.reduce((s: number, c: any) => s + (c.weight || 50), 0);
    for (const child of existingChildren) {
      const origWeight = child.weight || 50;
      child.weight = Math.round((origWeight / totalExisting) * contentWeight);
    }
  } else {
    existingChildren.push({ type: 'tabset', id: '#pinned-placeholder', weight: contentWeight, children: [] });
  }

  root.children = [...leftPinned, ...existingChildren, ...rightPinned];

  return layout;
}

/** Strip pinned tabsets from a layout JSON (for POST/save — pinned panels stored separately).
 *  Also rescales remaining children weights back to fill the full space. */
function stripPinnedFromLayout(layout: any, pinned: PinnedPanelsConfig): any {
  if (!pinned.pinnedTabsets.length || !layout?.layout) return layout;
  const pinnedIds = new Set(pinned.pinnedTabsets.map(pt => pt.id));

  function strip(node: any): any {
    if (!node) return node;
    if (pinnedIds.has(node.id)) return null;
    if (Array.isArray(node.children)) {
      node.children = node.children.map(strip).filter(Boolean);
    }
    return node;
  }
  strip(layout.layout);

  // Also remove placeholder if present
  const root = layout.layout;
  if (root?.type === 'row' && Array.isArray(root.children)) {
    root.children = root.children.filter((c: any) => c.id !== '#pinned-placeholder');

    // Rescale remaining children weights to fill full space (undo the scaling from merge)
    const totalWeight = root.children.reduce((s: number, c: any) => s + (c.weight || 50), 0);
    if (totalWeight > 0 && totalWeight < 95) {
      // Weights were scaled down — scale them back up proportionally
      for (const child of root.children) {
        const w = child.weight || 50;
        child.weight = Math.round((w / totalWeight) * 100);
      }
    }
  }

  return layout;
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
    const explicitProjects = readdirSync(PROJECTS_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try { return JSON.parse(readFileSync(join(PROJECTS_DIR, f), 'utf8')); }
        catch { return null; }
      })
      .filter(Boolean);

    // Auto-discover workspace dirs that have no project JSON yet
    const WORKSPACES_BASE = IS_LOCAL_MODE
      ? join(homedir(), 'Projects')
      : '/root/orchestrator/workspaces';
    const SKIP_DIRS = new Set(['_archive', 'sub-sessions', 'mission-chat', 'cui-workspace']);
    const explicitIds = new Set(explicitProjects.map((p: any) => p.id));
    const autoProjects: any[] = [];
    if (existsSync(WORKSPACES_BASE)) {
      try {
        readdirSync(WORKSPACES_BASE).forEach((entry) => {
          if (entry.startsWith('.') || SKIP_DIRS.has(entry)) return;
          const fullPath = join(WORKSPACES_BASE, entry);
          try { if (!statSync(fullPath).isDirectory()) return; } catch { return; }
          if (explicitIds.has(entry)) return;
          const name = entry.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
          autoProjects.push({ id: entry, name, workDir: fullPath, _auto: true });
        });
      } catch { /* non-critical */ }
    }

    res.json([...explicitProjects, ...autoProjects]);
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
    let content = readFileSync(notePath, 'utf8');
    // Replace {{APP_HOST}} placeholder with actual server URL
    const appHost = process.env.CUI_APP_HOST || 'http://localhost';
    content = content.replace(/\{\{APP_HOST\}\}/g, appHost);
    res.json({ content });
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

  // Shared Notes: auto-generated credentials (read-only, user-aware)
  // - Admins see everything including partnerCuiLogin
  // - Partners only see their app's credentials, no partnerCuiLogin
  // - Primary users shown prominently, rest in collapsible section
  router.get('/shared-notes', (req: Request, res: Response) => {
    const credPath = join(DATA_DIR, 'credentials.json');
    if (!existsSync(credPath)) { res.json({ content: '' }); return; }
    try {
      const creds = JSON.parse(readFileSync(credPath, 'utf8'));
      const userId = (req as any).user?.sub;
      // No auth = dev-server context → treat as admin (see all credentials)
      const isAdmin = !userId || (req as any).user?.role === 'admin';

      // Determine which apps this user can see
      let allowedApps: string[] | null = null; // null = all (admin)
      if (!isAdmin && userId) {
        try {
          const usersPath = join(DATA_DIR, 'users.json');
          if (existsSync(usersPath)) {
            const usersData = JSON.parse(readFileSync(usersPath, 'utf8'));
            const cuiUser = usersData.users?.find((u: any) => u.id === userId);
            if (cuiUser?.allowedWorkspaces && cuiUser.allowedWorkspaces !== '*') {
              allowedApps = cuiUser.allowedWorkspaces;
            }
          }
        } catch { /* ignore */ }
      }

      // Map workspace IDs to credential keys
      const wsToCredKey: Record<string, string[]> = {
        'engelmann-ai-hub': ['engelmann-ai-hub', '_global'],
        'engelmann-developer': ['engelmann-ai-hub', '_global'],
        'engelmann-dashboards': ['engelmann-ai-hub', '_global'],
        'werking-energy': ['werking-energy', '_global'],
        'werking-report': ['werking-report', '_global'],
        'werkingsafety': ['werking-safety', '_global'],
      };

      const now = new Date().toISOString().split('T')[0];
      let md = `# Zugangsdaten\n\n*Stand: ${now}*\n\n`;

      for (const [appId, appData] of Object.entries(creds) as [string, any][]) {
        // Filter: non-admin only sees their allowed apps
        if (allowedApps) {
          const visible = allowedApps.some(ws => (wsToCredKey[ws] || []).includes(appId));
          if (!visible) continue;
        }

        md += `---\n\n## ${appData.name}`;
        if (appData.productionUrl) md += ` — [${appData.productionUrl}](${appData.productionUrl})`;
        md += `\n\n`;

        if (!appData.users?.length) { md += `*Keine Benutzer*\n\n`; continue; }

        // Split into primary (first user or marked primary) and secondary
        const primary = appData.users.filter((u: any) => u.primary);
        const secondary = appData.users.filter((u: any) => !u.primary);
        // If no one is marked primary, first user is primary
        if (primary.length === 0 && appData.users.length > 0) {
          primary.push(appData.users[0]);
          secondary.shift();  // remove from secondary if it was there
        }

        // Primary credentials table
        if (primary.length > 0) {
          md += `| Email | Passwort | Rolle |\n|-------|----------|-------|\n`;
          for (const u of primary) {
            const name = u.name ? `**${u.name}** — ` : '';
            md += `| ${name}${u.email} | \`${u.password || '—'}\` | ${u.role || '—'} |\n`;
          }
          md += `\n`;
        }

        // Secondary credentials in collapsible section
        if (secondary.length > 0) {
          md += `<details><summary>Weitere Benutzer (${secondary.length})</summary>\n\n`;
          md += `| Email | Passwort | Rolle |\n|-------|----------|-------|\n`;
          for (const u of secondary) {
            const name = u.name ? `**${u.name}** — ` : '';
            md += `| ${name}${u.email} | \`${u.password || '—'}\` | ${u.role || '—'} |\n`;
          }
          md += `\n</details>\n\n`;
        }

        if (appData.extras?.length) {
          for (const e of appData.extras) md += `> ${e}\n`;
          md += `\n`;
        }

        // Partner CUI Login: ONLY for admins
        if (isAdmin && appData.partnerCuiLogin?.users?.length) {
          md += `<details><summary>Partner CUI Login (${appData.partnerCuiLogin.users.length})</summary>\n\n`;
          md += `| Name | Username | Passwort |\n|------|----------|----------|\n`;
          for (const u of appData.partnerCuiLogin.users) {
            md += `| ${u.name} | \`${u.username}\` | \`${u.password}\` |\n`;
          }
          md += `\n</details>\n\n`;
        }
      }

      res.json({ content: md });
    } catch (err) { console.warn('[Server] shared-notes generation error:', err); res.json({ content: '' }); }
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
  // Pinned Panels API
  // ============================================================================
  router.get('/pinned-panels', (_req: Request, res: Response) => {
    res.json(readPinnedPanels(DATA_DIR));
  });

  router.post('/pinned-panels', (req: Request, res: Response) => {
    const config = req.body as PinnedPanelsConfig;
    if (!config?.pinnedTabsets || !Array.isArray(config.pinnedTabsets)) {
      res.status(400).json({ error: 'pinnedTabsets array required' });
      return;
    }
    writePinnedPanels(DATA_DIR, config);
    broadcast({ type: 'pinned-panels-changed', config });
    res.json({ ok: true });
  });

  // Pin a tabset from the current layout
  router.post('/pinned-panels/pin', (req: Request, res: Response) => {
    const { tabsetId, projectId, position = 'right', weight = 30 } = req.body;
    if (!tabsetId || !projectId) {
      res.status(400).json({ error: 'tabsetId and projectId required' });
      return;
    }
    if (!isValidId(projectId)) {
      res.status(400).json({ error: 'invalid projectId' });
      return;
    }

    // Read the current layout to extract the tabset's tabs
    const layoutPath = join(LAYOUTS_DIR, `${projectId}.json`);
    if (!existsSync(layoutPath)) {
      res.status(404).json({ error: 'layout not found' });
      return;
    }

    let tabsetNode: any = null;
    let tabsetParent: any = null;
    try {
      const layout = JSON.parse(readFileSync(layoutPath, 'utf8'));
      function findTabset(node: any, parent: any): void {
        if (!node) return;
        if (node.id === tabsetId && node.type === 'tabset') { tabsetNode = node; tabsetParent = parent; return; }
        for (const child of node.children ?? []) { findTabset(child, node); if (tabsetNode) return; }
      }
      findTabset(layout?.layout, null);
    } catch { /* parse error */ }

    if (!tabsetNode) {
      res.status(404).json({ error: `tabset ${tabsetId} not found in layout` });
      return;
    }

    // Extract tabs (skip CUI panels — those are session-specific)
    const tabs = (tabsetNode.children || [])
      .filter((t: any) => t.type === 'tab' && t.component !== 'cui' && t.component !== 'cui-lite')
      .map((t: any) => ({ name: t.name, component: t.component, config: t.config || {} }));

    if (tabs.length === 0) {
      res.status(400).json({ error: 'tabset has no pinnable tabs (CUI panels cannot be pinned)' });
      return;
    }

    // Calculate percentage weight: tabset weight / sum of sibling weights * 100
    // This ensures the pinned panel gets the exact same visual proportion in every layout
    let percentWeight = weight;
    if (tabsetParent && Array.isArray(tabsetParent.children)) {
      const siblings = tabsetParent.children;
      const totalWeight = siblings.reduce((s: number, c: any) => s + (c.weight || 50), 0);
      const nodeWeight = tabsetNode.weight || 50;
      percentWeight = Math.round((nodeWeight / totalWeight) * 100);
    }

    const pinnedId = `#pinned-${Date.now().toString(36)}`;
    const config = readPinnedPanels(DATA_DIR);
    config.pinnedTabsets.push({ id: pinnedId, position: position as 'left' | 'right', weight: percentWeight, tabs });
    writePinnedPanels(DATA_DIR, config);
    broadcast({ type: 'pinned-panels-changed', config });
    res.json({ ok: true, pinnedId, tabs: tabs.length, weight: percentWeight });
  });

  // Unpin a tabset
  router.delete('/pinned-panels/:pinnedId', (req: Request, res: Response) => {
    const { pinnedId } = req.params;
    const config = readPinnedPanels(DATA_DIR);
    const before = config.pinnedTabsets.length;
    config.pinnedTabsets = config.pinnedTabsets.filter(pt => pt.id !== `#${pinnedId}` && pt.id !== pinnedId);
    if (config.pinnedTabsets.length === before) {
      res.status(404).json({ error: 'pinned tabset not found' });
      return;
    }
    writePinnedPanels(DATA_DIR, config);
    broadcast({ type: 'pinned-panels-changed', config });
    res.json({ ok: true });
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
      const layout = JSON.parse(readFileSync(layoutPath, 'utf8'));
      // Merge pinned panels into the layout for the client
      const pinned = readPinnedPanels(DATA_DIR);
      const merged = mergePinnedIntoLayout(JSON.parse(JSON.stringify(layout)), pinned);
      // Preserve version from disk
      merged._v = layout._v;
      merged._hasPinnedPanels = pinned.pinnedTabsets.length > 0;
      res.json(merged);
    } catch {
      res.json(null);
    }
  });

  router.post('/layouts/:projectId', (req: Request, res: Response) => {
    if (!isValidId(req.params.projectId)) {
      res.status(400).json({ error: 'invalid projectId' });
      return;
    }

    const layoutPath = join(LAYOUTS_DIR, `${req.params.projectId}.json`);

    // Strip pinned panels before saving (they're stored separately)
    const pinned = readPinnedPanels(DATA_DIR);
    const stripped = stripPinnedFromLayout(JSON.parse(JSON.stringify(req.body)), pinned);

    // Read current version from disk
    let currentV = 0;
    if (existsSync(layoutPath)) {
      try {
        const current = JSON.parse(readFileSync(layoutPath, 'utf8'));
        currentV = typeof current._v === 'number' ? current._v : 0;
      } catch { /* ignore — treat as v0 */ }
    }

    const incomingV: number | undefined = typeof stripped._v === 'number' ? stripped._v : undefined;

    // Conflict: browser has stale version — reject and return current layout
    if (incomingV !== undefined && incomingV < currentV) {
      try {
        const current = JSON.parse(readFileSync(layoutPath, 'utf8'));
        const merged = mergePinnedIntoLayout(JSON.parse(JSON.stringify(current)), pinned);
        merged._v = currentV;
        res.status(409).json({ conflict: true, _v: currentV, layout: merged });
      } catch {
        res.status(409).json({ conflict: true, _v: currentV });
      }
      return;
    }

    // Accept: bump version and persist (without pinned panels)
    const newBody = { ...stripped, _v: currentV + 1 };
    delete newBody._hasPinnedPanels;
    writeFileSync(layoutPath, JSON.stringify(newBody, null, 2));
    // Broadcast merged version (with pinned panels) to clients
    const mergedForBroadcast = mergePinnedIntoLayout(JSON.parse(JSON.stringify(newBody)), pinned);
    mergedForBroadcast._v = currentV + 1;
    broadcast({ type: 'control:apply-layout', projectId: req.params.projectId, layout: mergedForBroadcast });
    res.json({ ok: true, _v: currentV + 1 });
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
  // File Upload API (multipart FormData — for UploadPanel)
  // ============================================================================
  const FILE_UPLOADS_DIR = '/tmp/cui-uploads';
  mkdirSync(FILE_UPLOADS_DIR, { recursive: true });

  router.post('/uploads/file', (req: Request, res: Response) => {
    let bb: any;
    try {
      bb = Busboy({ headers: req.headers, limits: { fileSize: 100 * 1024 * 1024 } });
    } catch (e: any) {
      res.status(400).json({ error: 'Invalid multipart request: ' + e.message });
      return;
    }

    let handled = false;
    bb.on('file', (fieldname: string, file: any, info: any) => {
      if (handled) return;
      handled = true;

      const originalName = info.filename || 'upload';
      const ext = originalName.match(/\.[^.]+$/)?.[0] || '';
      const safeName = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
      const finalPath = join(FILE_UPLOADS_DIR, safeName);

      const chunks: Buffer[] = [];
      file.on('data', (chunk: Buffer) => chunks.push(chunk));
      file.on('end', () => {
        const buffer = Buffer.concat(chunks);
        writeFileSync(finalPath, buffer);
        console.log(`[FileUpload] Saved ${originalName} -> ${finalPath} (${Math.round(buffer.length / 1024)}KB)`);
        res.json({ path: finalPath, filename: originalName, size: buffer.length });
      });
      file.on('error', (err: Error) => {
        res.status(500).json({ error: 'Upload stream error: ' + err.message });
      });
    });

    bb.on('error', (err: Error) => {
      if (!handled) res.status(400).json({ error: 'Parse error: ' + err.message });
    });

    bb.on('close', () => {
      if (!handled) res.status(400).json({ error: 'No file field found in upload' });
    });

    req.pipe(bb);
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

  // --- ToolHub: persist active tool selection ---
  const TOOLHUB_PATH = join(DATA_DIR, 'toolhub.json');

  router.get('/toolhub/active', (_req: Request, res: Response) => {
    try {
      if (existsSync(TOOLHUB_PATH)) {
        res.json(JSON.parse(readFileSync(TOOLHUB_PATH, 'utf8')));
      } else {
        res.json({ activeTool: null });
      }
    } catch { res.json({ activeTool: null }); }
  });

  router.post('/toolhub/active', (req: Request, res: Response) => {
    const { activeTool } = req.body;
    if (typeof activeTool !== 'string') {
      res.status(400).json({ error: 'activeTool required' });
      return;
    }
    writeFileSync(TOOLHUB_PATH, JSON.stringify({ activeTool }, null, 2));
    broadcast({ type: 'toolhub-changed', activeTool });
    res.json({ ok: true, activeTool });
  });

  return router;
}
