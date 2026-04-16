import { Router, Request, Response } from 'express';
import { join } from 'path';
import { homedir } from 'os';
import { IS_LOCAL_MODE, broadcast } from './state.js';
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, writeFileSync, unlinkSync, renameSync } from 'fs';
import Busboy from 'busboy';

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

/** Find the rightmost tabset in a layout tree (DFS, last found = rightmost) */
function findRightmostTabset(node: any): any | null {
  if (!node) return null;
  let result: any = null;
  if (node.type === 'tabset') result = node;
  for (const child of node.children ?? []) {
    const found = findRightmostTabset(child);
    if (found) result = found;
  }
  return result;
}

/** Remove a tab by ID from a layout tree. Returns true if found and removed. */
function removeTabById(node: any, tabId: string): boolean {
  if (!node || !Array.isArray(node.children)) return false;
  const idx = node.children.findIndex((c: any) => c.id === tabId && c.type === 'tab');
  if (idx !== -1) {
    node.children.splice(idx, 1);
    return true;
  }
  for (const child of node.children) {
    if (removeTabById(child, tabId)) return true;
  }
  return false;
}

/** Check if a tab with the given ID exists anywhere in the layout tree */
function tabExistsById(node: any, tabId: string): boolean {
  if (!node) return false;
  if (node.id === tabId && node.type === 'tab') return true;
  for (const child of node.children ?? []) {
    if (tabExistsById(child, tabId)) return true;
  }
  return false;
}

/** Strip legacy `_pinned` flags from tab configs (no longer meaningful after sync-toggle rollout) */
function stripLegacyPinnedFlags(node: any): boolean {
  let changed = false;
  if (!node) return false;
  if (node.type === 'tab' && node.config && '_pinned' in node.config) {
    delete node.config._pinned;
    changed = true;
  }
  for (const child of node.children ?? []) {
    if (stripLegacyPinnedFlags(child)) changed = true;
  }
  return changed;
}

/** One-time migration: convert pinned-panels.json → synced tabs in all layouts */
function runSyncedTabMigration(dataDir: string, layoutsDir: string): void {
  // Pass 1: strip dead `_pinned` flags from all existing layouts (idempotent, runs every boot)
  const layoutFilesForCleanup = existsSync(layoutsDir)
    ? readdirSync(layoutsDir).filter(f => f.endsWith('.json') && !f.endsWith('_template.json'))
    : [];
  let cleanedLayouts = 0;
  for (const file of layoutFilesForCleanup) {
    const layoutPath = join(layoutsDir, file);
    let layout: any;
    try { layout = JSON.parse(readFileSync(layoutPath, 'utf8')); }
    catch { continue; }
    if (!layout?.layout) continue;
    if (stripLegacyPinnedFlags(layout.layout)) {
      layout._v = (typeof layout._v === 'number' ? layout._v : 0) + 1;
      try { writeFileSync(layoutPath, JSON.stringify(layout, null, 2)); cleanedLayouts++; }
      catch (err) { console.warn(`[SyncedTab Cleanup] Failed to write ${file}:`, err); }
    }
  }
  if (cleanedLayouts > 0) console.log(`[SyncedTab Cleanup] Stripped _pinned flags from ${cleanedLayouts} layouts`);

  const pinnedPath = join(dataDir, 'pinned-panels.json');
  if (!existsSync(pinnedPath)) return;

  let pinnedConfig: any;
  try { pinnedConfig = JSON.parse(readFileSync(pinnedPath, 'utf8')); }
  catch (err) { console.warn('[SyncedTab Migration] Failed to parse pinned-panels.json:', err); return; }

  const tabs: Array<{ name: string; component: string; config: Record<string, unknown> }> =
    (pinnedConfig.pinnedTabsets ?? []).flatMap((pt: any) => pt.tabs ?? []);

  const backupPath = `${pinnedPath}.migrated-${new Date().toISOString().split('T')[0]}.bak`;

  if (tabs.length === 0) {
    try { renameSync(pinnedPath, backupPath); } catch { }
    console.log('[SyncedTab Migration] No tabs to migrate, renamed pinned-panels.json');
    return;
  }

  const layoutFiles = existsSync(layoutsDir)
    ? readdirSync(layoutsDir).filter(f => f.endsWith('.json') && !f.endsWith('_template.json'))
    : [];

  let totalAdded = 0;
  for (const file of layoutFiles) {
    const layoutPath = join(layoutsDir, file);
    let layout: any;
    try { layout = JSON.parse(readFileSync(layoutPath, 'utf8')); }
    catch { continue; }
    if (!layout?.layout) continue;

    const rightmost = findRightmostTabset(layout.layout);
    if (!rightmost) continue;

    let changed = false;
    for (const tab of tabs) {
      // Skip if a tab with the same component already exists in this layout
      if (JSON.stringify(layout.layout).includes(`"component":"${tab.component}"`)) continue;

      const tabId = `#synced-${tab.component}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { _pinned: _removed, ...cleanConfig } = tab.config as any;
      if (!Array.isArray(rightmost.children)) rightmost.children = [];
      rightmost.children.push({
        type: 'tab',
        id: tabId,
        name: tab.name,
        component: tab.component,
        config: { ...cleanConfig, _synced: true },
      });
      changed = true;
      totalAdded++;
    }

    if (changed) {
      layout._v = (typeof layout._v === 'number' ? layout._v : 0) + 1;
      try { writeFileSync(layoutPath, JSON.stringify(layout, null, 2)); }
      catch (err) { console.warn(`[SyncedTab Migration] Failed to write ${file}:`, err); }
    }
  }

  try { renameSync(pinnedPath, backupPath); }
  catch (err) { console.warn('[SyncedTab Migration] Failed to rename pinned-panels.json:', err); }

  console.log(`[SyncedTab Migration] Added ${totalAdded} synced tabs across ${layoutFiles.length} layouts, renamed pinned-panels.json`);
}

export default function createLayoutsRouter(deps: LayoutsDeps): Router {
  const router = Router();
  const { LAYOUTS_DIR, PROJECTS_DIR, NOTES_DIR, UPLOADS_DIR, DATA_DIR } = deps;

  // Run one-time migration from pinned-panels.json to synced tabs
  runSyncedTabMigration(DATA_DIR, LAYOUTS_DIR);

  // ============================================================================
  // Workspace Categories API
  // ============================================================================
  router.get('/workspace-categories', (_req: Request, res: Response) => {
    const categoriesPath = join(DATA_DIR, 'workspace-categories.json');
    if (!existsSync(categoriesPath)) {
      res.json({ categories: [] });
      return;
    }
    try {
      res.json(JSON.parse(readFileSync(categoriesPath, 'utf8')));
    } catch {
      res.status(500).json({ error: 'Failed to read workspace-categories.json' });
    }
  });

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
  // Workspace Categories API
  // ============================================================================
  router.get('/workspace-categories', (_req: Request, res: Response) => {
    const categoriesFile = join(DATA_DIR, 'workspace-categories.json');
    if (!existsSync(categoriesFile)) {
      res.status(404).json({ error: 'workspace-categories.json not found' });
      return;
    }
    try {
      const data = JSON.parse(readFileSync(categoriesFile, 'utf8'));
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: `Failed to read workspace-categories.json: ${err.message}` });
    }
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
  // Sync Tabs API (replaces Pinned Panels)
  // ============================================================================

  // Sync a tab into all other workspace layouts
  router.post('/sync-tab', (req: Request, res: Response) => {
    const { sourceProjectId, tabConfig } = req.body;
    if (!sourceProjectId || !tabConfig?.id || !tabConfig?.component) {
      res.status(400).json({ error: 'sourceProjectId and tabConfig (id, component) required' });
      return;
    }
    if (!isValidId(sourceProjectId)) {
      res.status(400).json({ error: 'invalid sourceProjectId' });
      return;
    }

    const layoutFiles = existsSync(LAYOUTS_DIR)
      ? readdirSync(LAYOUTS_DIR).filter(f => f.endsWith('.json') && !f.endsWith('_template.json'))
      : [];

    const tabNode = {
      type: 'tab' as const,
      id: tabConfig.id,
      name: tabConfig.name ?? tabConfig.component,
      component: tabConfig.component,
      config: { ...(tabConfig.config ?? {}), _synced: true },
    };

    const added: string[] = [];
    for (const file of layoutFiles) {
      const pid = file.replace('.json', '');
      if (pid === sourceProjectId) continue;

      const layoutPath = join(LAYOUTS_DIR, file);
      let layout: any;
      try { layout = JSON.parse(readFileSync(layoutPath, 'utf8')); }
      catch { continue; }
      if (!layout?.layout) continue;

      // Skip if tab already present
      if (tabExistsById(layout.layout, tabConfig.id)) continue;

      const rightmost = findRightmostTabset(layout.layout);
      if (!rightmost) continue;

      if (!Array.isArray(rightmost.children)) rightmost.children = [];
      rightmost.children.push(tabNode);
      layout._v = (typeof layout._v === 'number' ? layout._v : 0) + 1;

      try {
        writeFileSync(layoutPath, JSON.stringify(layout, null, 2));
        added.push(pid);
      } catch (err) { console.warn(`[SyncTab] Failed to write ${file}:`, err); }
    }

    broadcast({ type: 'synced-tab-added', tabConfig: tabNode, affectedProjectIds: added });
    res.json({ ok: true, added });
  });

  // Remove a synced tab from all layouts except the source (user turned off sync)
  router.post('/unsync-tab', (req: Request, res: Response) => {
    const { tabId, keepInProjectId } = req.body;
    if (!tabId) {
      res.status(400).json({ error: 'tabId required' });
      return;
    }

    const layoutFiles = existsSync(LAYOUTS_DIR)
      ? readdirSync(LAYOUTS_DIR).filter(f => f.endsWith('.json') && !f.endsWith('_template.json'))
      : [];

    const removed: string[] = [];
    for (const file of layoutFiles) {
      const pid = file.replace('.json', '');
      if (keepInProjectId && pid === keepInProjectId) continue;

      const layoutPath = join(LAYOUTS_DIR, file);
      let layout: any;
      try { layout = JSON.parse(readFileSync(layoutPath, 'utf8')); }
      catch { continue; }
      if (!layout?.layout) continue;

      if (!removeTabById(layout.layout, tabId)) continue;

      layout._v = (typeof layout._v === 'number' ? layout._v : 0) + 1;
      try {
        writeFileSync(layoutPath, JSON.stringify(layout, null, 2));
        removed.push(pid);
      } catch (err) { console.warn(`[UnsyncTab] Failed to write ${file}:`, err); }
    }

    broadcast({ type: 'synced-tab-removed', tabId, affectedProjectIds: removed });
    res.json({ ok: true, removed });
  });

  // Delete a synced tab from ALL layouts (user closed the tab)
  router.post('/delete-synced-tab', (req: Request, res: Response) => {
    const { tabId } = req.body;
    if (!tabId) {
      res.status(400).json({ error: 'tabId required' });
      return;
    }

    const layoutFiles = existsSync(LAYOUTS_DIR)
      ? readdirSync(LAYOUTS_DIR).filter(f => f.endsWith('.json') && !f.endsWith('_template.json'))
      : [];

    const removed: string[] = [];
    for (const file of layoutFiles) {
      const pid = file.replace('.json', '');
      const layoutPath = join(LAYOUTS_DIR, file);
      let layout: any;
      try { layout = JSON.parse(readFileSync(layoutPath, 'utf8')); }
      catch { continue; }
      if (!layout?.layout) continue;

      if (!removeTabById(layout.layout, tabId)) continue;

      layout._v = (typeof layout._v === 'number' ? layout._v : 0) + 1;
      try {
        writeFileSync(layoutPath, JSON.stringify(layout, null, 2));
        removed.push(pid);
      } catch (err) { console.warn(`[DeleteSyncedTab] Failed to write ${file}:`, err); }
    }

    broadcast({ type: 'synced-tab-removed', tabId, affectedProjectIds: removed });
    res.json({ ok: true, removed });
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

    const layoutPath = join(LAYOUTS_DIR, `${req.params.projectId}.json`);

    // Read current version from disk
    let currentV = 0;
    if (existsSync(layoutPath)) {
      try {
        const current = JSON.parse(readFileSync(layoutPath, 'utf8'));
        currentV = typeof current._v === 'number' ? current._v : 0;
      } catch { /* ignore — treat as v0 */ }
    }

    const incomingV: number | undefined = typeof req.body._v === 'number' ? req.body._v : undefined;

    // Conflict: browser has stale version — reject and return current layout
    if (incomingV !== undefined && incomingV < currentV) {
      try {
        const current = JSON.parse(readFileSync(layoutPath, 'utf8'));
        res.status(409).json({ conflict: true, _v: currentV, layout: current });
      } catch {
        res.status(409).json({ conflict: true, _v: currentV });
      }
      return;
    }

    // Accept: bump version and persist
    const newBody = { ...req.body, _v: currentV + 1 };
    writeFileSync(layoutPath, JSON.stringify(newBody, null, 2));
    broadcast({ type: 'control:apply-layout', projectId: req.params.projectId, layout: newBody });
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
