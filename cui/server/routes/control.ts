import { Router, Request, Response } from 'express';
import { resolve, join, relative } from 'path';
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { watch } from 'chokidar';
import type { WebSocket } from 'ws';
import type { SessionState, ConvAttentionState, AttentionReason, PanelVisibility } from './state.js';
import * as convMeta from './shared/conv-metadata.js';
import { getOrphanCleanupStatus, killOrphanProcesses, getActiveProcesses } from './claude-cli.js';

const execAsync = promisify(exec);

interface ControlDeps {
  broadcast: (data: Record<string, unknown>) => void;
  clients: Set<WebSocket>;
  workspaceState: {
    activeProjectId: string;
    cuiStates: Record<string, string>;
    panels: Array<{ id: string; component: string; config: Record<string, unknown>; name: string }>;
  };
  visibilityRegistry: Map<string, PanelVisibility>;
  sessionStates: Map<string, SessionState>;
  getSessionStates: () => Record<string, SessionState>;
  DATA_DIR: string;
  PROJECTS_DIR: string;
  LAYOUTS_DIR: string;
  startTime: number;
  ACCOUNT_CONFIG: Array<{ id: string; home: string; label: string; color: string }>;
}

// --- Syncthing Control ---
const SYNCTHING_URL = 'http://127.0.0.1:8384';
const SYNCTHING_API_KEY = process.env.SYNCTHING_API_KEY || '';

async function syncthingFetch(path: string, method = 'GET'): Promise<any> {
  if (!SYNCTHING_API_KEY) {
    throw new Error('[Control] SYNCTHING_API_KEY not configured');
  }
  const res = await fetch(`${SYNCTHING_URL}${path}`, {
    method,
    headers: { 'X-API-Key': SYNCTHING_API_KEY },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Syncthing API ${path}: ${res.status} ${res.statusText}`);
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

// --- Snapshot Storage ---
interface PanelSnapshot {
  panel: string;
  capturedAt: string;
  data: unknown;
}

const panelSnapshots = new Map<string, PanelSnapshot>();

// --- CPU Profile ---
let pendingProfileResolve: ((result: unknown) => void) | null = null;

export function getCpuProfileResolver(): ((result: unknown) => void) | null {
  return pendingProfileResolve;
}

export function resolveCpuProfile(result: unknown): void {
  if (pendingProfileResolve) {
    pendingProfileResolve(result);
  }
}

export default function createControlRouter(deps: ControlDeps): Router {
  const router = Router();
  const { broadcast, clients, workspaceState, visibilityRegistry, sessionStates, getSessionStates, DATA_DIR, PROJECTS_DIR, LAYOUTS_DIR, startTime, ACCOUNT_CONFIG } = deps;

  // Finished status via shared ConvMetadataStore
  function isFinished(sessionId: string): boolean {
    return convMeta.isFinished(sessionId);
  }

  // --- Change Detection: Watch src/ and server/, notify frontend (no auto-build) ---
  const WORKSPACE_ROOT = resolve(import.meta.dirname ?? __dirname, '..');
  let _pendingChanges = new Set<string>();
  const MAX_PENDING_CHANGES = 1000;
  let _changeDebounce: ReturnType<typeof setTimeout> | null = null;
  let _syncInProgress = false;

  const changeWatcher = watch([
    join(WORKSPACE_ROOT, 'src'),
    join(WORKSPACE_ROOT, 'server'),
  ], {
    ignored: /(node_modules|dist|\.git|__pycache__|sync-conflict)/,
    persistent: true,
    ignoreInitial: true,
    depth: 10,
  });

  changeWatcher.on('error', (err) => {
    console.warn('[ChangeWatch] Watcher error:', (err as NodeJS.ErrnoException).message);
  });

  changeWatcher.on('all', (event, filePath) => {
    if (!/\.(ts|tsx|css|html|json)$/.test(filePath)) return;
    if (filePath.includes('/dist/') || filePath.includes('/node_modules/')) return;
    const rel = relative(WORKSPACE_ROOT, filePath);
    // No per-file console.log -- only log summary when broadcasting
    if (_pendingChanges.size >= MAX_PENDING_CHANGES) {
      console.warn(`[ChangeWatch] Pending changes cap reached (${MAX_PENDING_CHANGES}), dropping oldest`);
      const first = _pendingChanges.values().next().value;
      if (first !== undefined) _pendingChanges.delete(first);
    }
    _pendingChanges.add(rel);

    // Debounce: notify frontend after 5s quiet period (was 2s -- too aggressive during Syncthing bursts)
    if (_changeDebounce) clearTimeout(_changeDebounce);
    _changeDebounce = setTimeout(() => {
      const pending = Array.from(_pendingChanges);
      console.log(`[ChangeWatch] Update available: ${_pendingChanges.size} files: ${pending.slice(0, 5).join(', ')}${_pendingChanges.size > 5 ? '...' : ''}`);
      broadcast({ type: 'cui-update-available', files: pending.slice(0, 20), count: _pendingChanges.size });
    }, 5000);
  });

  console.log('[ChangeWatch] Watching src/ and server/ for changes (notify-only, no auto-build)');

  // ============================================================
  // Control API - Workspace Steering
  // ============================================================

  router.get('/control/health', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      uptime: Math.floor((Date.now() - startTime) / 1000),
      wsClients: clients.size,
      accounts: ACCOUNT_CONFIG.map(a => ({ id: a.id, label: a.label, home: a.home })),
      frontendConnected: clients.size > 0,
      orphanCleanup: getOrphanCleanupStatus(),
      activeProcesses: getActiveProcesses().length,
    });
  });


  // Kill orphan wrapper processes (manual trigger)
  router.post('/control/kill-orphans', async (_req: Request, res: Response) => {
    try {
      const result = await killOrphanProcesses();
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'unknown' });
    }
  });

  router.get('/control/state', (_req: Request, res: Response) => {
    const projects = readdirSync(PROJECTS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => { try { return JSON.parse(readFileSync(join(PROJECTS_DIR, f), 'utf8')); } catch (err) { console.warn('[Control] Failed to parse project file:', f, err); return null; } })
      .filter(Boolean);
    res.json({
      activeProjectId: workspaceState.activeProjectId,
      projects,
      cuiStates: workspaceState.cuiStates,
      panels: workspaceState.panels,
    });
  });

  // --- Fetch active conversations for a workspace (shared helper) ---
  async function getWorkspaceConversations(projectId: string): Promise<{
    mainConvs: Array<{ sessionId: string; accountId: string; customName: string }>;
    subConvs: Array<{ sessionId: string; accountId: string; customName: string }>;
    error?: string;
  }> {
    const mainConvs: Array<{ sessionId: string; accountId: string; customName: string }> = [];
    const subConvs: Array<{ sessionId: string; accountId: string; customName: string }> = [];
    try {
      const convResp = await fetch(`http://localhost:${process.env.PORT || 4005}/api/mission/conversations?fresh=true`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!convResp.ok) return { mainConvs, subConvs, error: 'conv fetch failed' };
      const convData = await convResp.json() as any;
      const allConvs: any[] = convData.conversations || [];

      const projectFile = join(PROJECTS_DIR, `${projectId}.json`);
      let projectWorkDir = '';
      let projectName = '';
      if (existsSync(projectFile)) {
        try {
          const p = JSON.parse(readFileSync(projectFile, 'utf8'));
          projectWorkDir = p.workDir || '';
          projectName = (p.name || projectId).toLowerCase();
        } catch { /* ignore */ }
      }

      for (const c of allConvs) {
        if (c.manualFinished) continue;
        if (c.status && c.status !== 'ongoing') continue;

        let matches = false;
        if (projectId === 'sub-sessions') {
          matches = !!c.isSubSession;
        } else {
          if (projectWorkDir && c.projectPath === projectWorkDir) matches = true;
          if (!matches) {
            const cName = (c.projectName || '').toLowerCase().replace(/[^a-z0-9]/g, '-');
            const pId = projectId.toLowerCase();
            matches = cName === pId || cName.includes(pId) || pId.includes(cName) || (projectName && cName === projectName);
          }
        }
        if (!matches) continue;

        const entry = { sessionId: c.sessionId, accountId: c.accountId || 'werking', customName: c.customName || c.summary?.slice(0, 40) || '' };
        if (c.isSubSession) {
          subConvs.push(entry);
        } else {
          mainConvs.push(entry);
        }
      }
    } catch { return { mainConvs, subConvs, error: 'conv fetch failed' }; }
    return { mainConvs, subConvs };
  }

  // --- Layout Status Check (READ-ONLY) ---
  // Returns which sessions exist vs which are in the layout. NEVER modifies the layout.
  async function checkLayoutStatus(projectId: string): Promise<{
    total: number; inLayout: number; missing: number; subSessions: number;
    missingSessions: Array<{ sessionId: string; customName: string }>;
  }> {
    const { mainConvs, subConvs } = await getWorkspaceConversations(projectId);

    // Check which sessions are already in the layout
    const layoutPath = join(LAYOUTS_DIR, `${projectId}.json`);
    const cuiPanelSessions = new Set<string>();
    try {
      if (existsSync(layoutPath)) {
        const layout = JSON.parse(readFileSync(layoutPath, 'utf8'));
        function collectCuiSessions(node: any): void {
          if (!node) return;
          if (node.type === 'tab' && (node.component === 'cui' || node.component === 'cui-lite')) {
            const sid = node.config?.initialSessionId || node.config?.sessionId;
            if (sid) cuiPanelSessions.add(sid);
          }
          for (const child of node.children ?? []) collectCuiSessions(child);
        }
        collectCuiSessions(layout?.layout);
      }
    } catch { /* no layout or parse error */ }

    const missingSessions = mainConvs.filter(c => !cuiPanelSessions.has(c.sessionId));

    return {
      total: mainConvs.length,
      inLayout: mainConvs.length - missingSessions.length,
      missing: missingSessions.length,
      subSessions: subConvs.length,
      missingSessions: missingSessions.map(c => ({ sessionId: c.sessionId, customName: c.customName })),
    };
  }

  // --- Generate Layout (WRITE) — ONLY called by explicit Layout button click ---
  // Generates a complete layout with ALL main sessions + sub-sessions panel + utilities
  async function generateLayout(projectId: string): Promise<{ triggered: boolean; reason?: string; total?: number; subSessions?: number }> {
    const { mainConvs, subConvs, error } = await getWorkspaceConversations(projectId);
    if (error) return { triggered: false, reason: error };
    if (mainConvs.length === 0 && subConvs.length === 0) {
      return { triggered: false, reason: 'no active conversations for this workspace', total: 0 };
    }

    let idCounter = 1;
    const nextId = () => `#auto-${idCounter++}`;

    const cuiTabs = mainConvs.map((c, i) => ({
      type: 'tab' as const, id: nextId(),
      name: c.customName || `Session ${i + 1}`,
      component: 'cui',
      config: { initialSessionId: c.sessionId, accountId: c.accountId },
    }));

    const utilityTabs = [
      { type: 'tab' as const, id: nextId(), name: 'File Preview', component: 'preview', config: {} },
      { type: 'tab' as const, id: nextId(), name: 'Notes', component: 'notes', config: {} },
      { type: 'tab' as const, id: nextId(), name: 'Browser', component: 'browser', config: {} },
      { type: 'tab' as const, id: nextId(), name: 'Images', component: 'images', config: {} },
    ];
    if (subConvs.length > 0) {
      utilityTabs.push({ type: 'tab' as const, id: nextId(), name: 'Sub-Sessions', component: 'sub-sessions', config: {} });
    }

    let layoutChildren: any[];
    if (cuiTabs.length <= 1) {
      layoutChildren = [
        { type: 'tabset', id: nextId(), weight: 60, children: cuiTabs.length > 0 ? cuiTabs : [{ type: 'tab', id: nextId(), name: 'CUI', component: 'cui', config: {} }] },
        { type: 'tabset', id: nextId(), weight: 40, children: utilityTabs },
      ];
    } else if (cuiTabs.length === 2) {
      layoutChildren = [
        { type: 'row', id: nextId(), weight: 60, children: [
          { type: 'tabset', id: nextId(), weight: 50, children: [cuiTabs[0]] },
          { type: 'tabset', id: nextId(), weight: 50, children: [cuiTabs[1]] },
        ]},
        { type: 'tabset', id: nextId(), weight: 40, children: utilityTabs },
      ];
    } else {
      const cuiTabsets = cuiTabs.map(tab => ({
        type: 'tabset', id: nextId(), weight: Math.floor(100 / cuiTabs.length), children: [tab],
      }));
      layoutChildren = [
        { type: 'row', id: nextId(), weight: 65, children: cuiTabsets },
        { type: 'tabset', id: nextId(), weight: 35, children: utilityTabs },
      ];
    }

    const newLayout = { global: { splitterSize: 4 }, borders: [], layout: { type: 'row', id: nextId(), weight: 100, children: layoutChildren } };

    const layoutPath = join(LAYOUTS_DIR, `${projectId}.json`);
    let currentVersion = 0;
    try {
      if (existsSync(layoutPath)) {
        const current = JSON.parse(readFileSync(layoutPath, 'utf8'));
        currentVersion = (current._v || 0);
      }
    } catch { /* new file */ }

    const layoutWithVersion = { ...newLayout, _v: currentVersion + 1 };
    try { mkdirSync(LAYOUTS_DIR, { recursive: true }); } catch { /* exists */ }
    writeFileSync(layoutPath, JSON.stringify(layoutWithVersion, null, 2));
    broadcast({ type: 'control:apply-layout', projectId, layout: layoutWithVersion });
    console.log(`[AutoLayout] ${projectId}: Generated fresh layout with ${mainConvs.length} main + ${subConvs.length} sub-sessions`);

    return { triggered: true, total: mainConvs.length + subConvs.length, subSessions: subConvs.length };
  }

  // Backwards-compat wrapper — project/switch now only checks status, never overwrites
  async function runAutoLayout(projectId: string): Promise<{ triggered: boolean; reason?: string; total?: number; existing?: number; unassigned?: number; subSessions?: number }> {
    const status = await checkLayoutStatus(projectId);
    return {
      triggered: false,
      reason: status.missing > 0 ? `${status.missing} sessions not in layout` : 'all sessions in layout',
      total: status.total,
      existing: status.inLayout,
      unassigned: status.missing,
      subSessions: status.subSessions,
    };
  }

  router.post('/control/project/switch', async (req: Request, res: Response) => {
    const { projectId } = req.body;
    if (!projectId) { res.status(400).json({ error: 'projectId required' }); return; }
    const projectFile = join(PROJECTS_DIR, `${projectId}.json`);
    if (!existsSync(projectFile)) { res.status(404).json({ error: `project ${projectId} not found` }); return; }
    workspaceState.activeProjectId = projectId;
    broadcast({ type: 'control:project-switch', projectId });
    // Auto-layout on project/switch: ensure all conversations get a panel
    const layoutResult = await runAutoLayout(projectId);
    if (layoutResult.triggered) {
      console.log(`[ProjectSwitch] Auto-layout triggered for ${projectId}: ${layoutResult.unassigned} new panels`);
    }
    res.json({ ok: true, projectId, autoLayout: layoutResult });
  });

  router.post('/control/cui/reload', (req: Request, res: Response) => {
    const { cuiId } = req.body;
    if (!cuiId) { res.status(400).json({ error: 'cuiId required' }); return; }
    broadcast({ type: 'control:cui-reload', cuiId });
    res.json({ ok: true, cuiId });
  });

  router.post('/control/cui/new', (req: Request, res: Response) => {
    const { cuiId } = req.body;
    if (!cuiId) { res.status(400).json({ error: 'cuiId required' }); return; }
    broadcast({ type: 'control:cui-new-conversation', cuiId });
    res.json({ ok: true, cuiId });
  });

  router.post('/control/cui/cwd', (req: Request, res: Response) => {
    const { cuiId, cwd } = req.body;
    if (!cuiId || !cwd) { res.status(400).json({ error: 'cuiId and cwd required' }); return; }
    broadcast({ type: 'control:cui-set-cwd', cuiId, cwd });
    res.json({ ok: true, cuiId, cwd });
  });

  // ============================================================
  // CUI Sync (git pull + build + systemd restart)
  // ============================================================

  router.post('/cui-sync', async (_req: Request, res: Response) => {
    if (_syncInProgress) {
      res.status(409).json({ error: 'Sync already in progress' });
      return;
    }
    _syncInProgress = true;
    const pendingArr = Array.from(_pendingChanges);
    console.log(`[Sync] Triggered with ${_pendingChanges.size} pending changes: ${pendingArr.slice(0, 5).join(', ')}${_pendingChanges.size > 5 ? '...' : ''}`);
    broadcast({ type: 'cui-sync', status: 'started' });

    const PATH_PREFIX = '/usr/local/bin:' + (process.env.PATH || '');
    const devEnv = { ...process.env, PATH: PATH_PREFIX, NODE_ENV: 'development' };
    const execOpts = { cwd: WORKSPACE_ROOT, env: devEnv, timeout: 120_000 };

    let gitResult = 'skipped';
    try {
      // 1. Git pull (best-effort: skip if dirty tree or no remote)
      try {
        const { stdout } = await execAsync('git pull 2>&1', execOpts);
        gitResult = stdout.trim();
      } catch (err) {
        console.warn('[Control] Git pull failed:', err);
        gitResult = 'skipped (uncommitted changes)';
      }
      broadcast({ type: 'cui-sync', status: 'pulled', detail: gitResult });

      // 2. npm install (NODE_ENV=development so devDependencies like vite get installed)
      await execAsync('npm install --prefer-offline 2>&1', execOpts);
      broadcast({ type: 'cui-sync', status: 'installing' });

      // 3. Build frontend
      const { stdout: buildOut } = await execAsync('npm run build 2>&1', { ...execOpts, env: { ...devEnv, NODE_ENV: 'production' } });
      const builtMatch = buildOut.match(/built in ([\d.]+s)/);
      broadcast({ type: 'cui-sync', status: 'built', detail: builtMatch?.[1] || 'ok' });

      // Check if server code changed (requires process restart) vs frontend-only (just reload)
      const serverChanged = pendingArr.some(f => f.startsWith('server/'));
      const gitChangedServer = /server\//.test(gitResult);
      const needsRestart = serverChanged || gitChangedServer;

      _syncInProgress = false;
      _pendingChanges.clear();
      res.json({ ok: true, git: gitResult, build: builtMatch?.[1] || 'ok', serverRestart: needsRestart });

      if (needsRestart) {
        // Server code changed - must restart to pick up new TypeScript
        setTimeout(() => {
          console.log('[Sync] Server code changed, exiting for systemd restart');
          process.exit(0);
        }, 500);
      } else {
        // Frontend-only - new bundle is already in dist/, just notify clients to reload
        console.log('[Sync] Frontend-only build complete (no server restart needed)');
        broadcast({ type: 'cui-update-available', files: [], count: 0, rebuilt: true });
      }

    } catch (err: any) {
      _syncInProgress = false;
      broadcast({ type: 'cui-sync', status: 'error', detail: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // API: get pending changes
  router.get('/cui-sync/pending', (_req: Request, res: Response) => {
    const pendingList = Array.from(_pendingChanges);
    res.json({ pending: _pendingChanges.size > 0, files: pendingList.slice(0, 20), count: _pendingChanges.size, syncing: _syncInProgress });
  });

  // ============================================================
  // Syncthing Control API
  // ============================================================

  // GET /api/syncthing/status -- paused state, last sync time, connection info
  router.get('/syncthing/status', async (_req: Request, res: Response) => {
    try {
      const [systemR, connectionsR, folderStatsR, devicesR] = await Promise.allSettled([
        syncthingFetch('/rest/system/status'),
        syncthingFetch('/rest/system/connections'),
        syncthingFetch('/rest/stats/folder'),
        syncthingFetch('/rest/config/devices'),
      ]);
      if (systemR.status === 'rejected') throw systemR.reason;
      const system = systemR.value;
      const connections = connectionsR.status === 'fulfilled' ? connectionsR.value : { connections: {} };
      const folderStats = folderStatsR.status === 'fulfilled' ? folderStatsR.value : {};
      const devices = devicesR.status === 'fulfilled' ? devicesR.value : [];

      // Find last synced file across all folders
      let lastSyncAt = '';
      let lastFile = '';
      for (const [, stats] of Object.entries(folderStats) as [string, any][]) {
        const at = stats.lastFile?.at || '';
        if (at > lastSyncAt && at > '2000') { // Ignore zero dates
          lastSyncAt = at;
          lastFile = stats.lastFile?.filename || '';
        }
      }

      // Check connections
      const conns = connections.connections || {};
      let anyConnected = false;
      for (const [, conn] of Object.entries(conns) as [string, any][]) {
        if (conn.connected) anyConnected = true;
      }

      // Check if any remote device is paused (skip own device)
      const remoteDevices = (devices as any[]).filter((d: any) => d.deviceID !== system.myID);
      const allPaused = remoteDevices.length > 0 && remoteDevices.every((d: any) => d.paused);

      res.json({
        paused: allPaused,
        connected: anyConnected,
        lastSyncAt: lastSyncAt || null,
        lastFile: lastFile || null,
        uptime: system.uptime,
        myID: system.myID?.substring(0, 7),
      });
    } catch (err: any) {
      res.status(502).json({ error: `Syncthing unreachable: ${err.message}` });
    }
  });

  // POST /api/syncthing/pause -- pause all device connections
  router.post('/syncthing/pause', async (_req: Request, res: Response) => {
    try {
      const devices: any[] = await syncthingFetch('/rest/config/devices');
      for (const device of devices) {
        if (!device.paused) {
          device.paused = true;
          await fetch(`${SYNCTHING_URL}/rest/config/devices/${device.deviceID}`, {
            method: 'PATCH',
            headers: { 'X-API-Key': SYNCTHING_API_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ paused: true }),
            signal: AbortSignal.timeout(8000),
          });
        }
      }
      console.log('[Syncthing] All devices paused');
      res.json({ ok: true, paused: true });
    } catch (err: any) {
      res.status(502).json({ error: `Syncthing pause failed: ${err.message}` });
    }
  });

  // POST /api/syncthing/resume -- resume all device connections
  router.post('/syncthing/resume', async (_req: Request, res: Response) => {
    try {
      const devices: any[] = await syncthingFetch('/rest/config/devices');
      for (const device of devices) {
        if (device.paused) {
          device.paused = false;
          await fetch(`${SYNCTHING_URL}/rest/config/devices/${device.deviceID}`, {
            method: 'PATCH',
            headers: { 'X-API-Key': SYNCTHING_API_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ paused: false }),
            signal: AbortSignal.timeout(8000),
          });
        }
      }
      console.log('[Syncthing] All devices resumed');
      res.json({ ok: true, paused: false });
    } catch (err: any) {
      res.status(502).json({ error: `Syncthing resume failed: ${err.message}` });
    }
  });

  // ============================================================
  // Auto-Layout API
  // POST /api/control/auto-layout?projectId=X
  // Checks if active conversations > existing CUI panels.
  // Only triggers activate-conversations broadcast if new sessions
  // have no panel yet. Existing layout is preserved and re-saved
  // by the frontend after the split (saveLayoutRef called in activate-conversations handler).
  // ============================================================

  // GET /api/control/layout-status?projectId=X — Read-only check: which sessions are missing from layout?
  // Frontend uses this to color the Layout button (green = all good, orange = missing sessions)
  router.get('/control/layout-status', async (req: Request, res: Response) => {
    const projectId = req.query.projectId as string;
    if (!projectId) { res.status(400).json({ error: 'projectId required' }); return; }
    const status = await checkLayoutStatus(projectId);
    res.json({ projectId, ...status });
  });

  // POST /api/control/auto-layout — EXPLICIT button click: generate fresh layout
  router.post('/control/auto-layout', async (req: Request, res: Response) => {
    const projectId: string = req.body.projectId || req.query.projectId as string;
    if (!projectId) { res.status(400).json({ error: 'projectId required' }); return; }
    const result = await generateLayout(projectId);
    res.json({ projectId, ...result });
  });

  // ============================================================
  // All Active Chats API — shows ALL ongoing + recent 24h conversations
  // This is Rafael's management dashboard: everything not FINISH'd
  // ============================================================

  router.get('/all-active-chats', async (_req: Request, res: Response) => {
    interface ActiveChat {
      projectId: string;
      projectName: string;
      workDir: string;
      panelId: string;
      accountId: string;
      sessionId: string;
      attentionState?: string;
      attentionReason?: string;
      isVisible?: boolean;
      openInWorkspace?: string;
    }

    const chats: ActiveChat[] = [];
    const seenSessions = new Set<string>();

    // 1. Collect visibility info (which workspace has which chat open)
    const sessionToWorkspace = new Map<string, string>();
    for (const [_key, entry] of visibilityRegistry.entries()) {
      if (entry.sessionId && !entry.panelId.startsWith('allchats-')) {
        sessionToWorkspace.set(entry.sessionId, entry.projectId || 'unknown');
      }
    }

    // 2. Get ALL conversations from the cached conversation list
    try {
      const convResp = await fetch(`http://localhost:${process.env.PORT || 4005}/api/mission/conversations`, { signal: AbortSignal.timeout(5000) });
      if (!convResp.ok) throw new Error('conv fetch failed');
      const convData = await convResp.json();
      const conversations = convData.conversations || [];

      for (const conv of conversations) {
        const isFinishedConv = conv.manualFinished === true;
        if (isFinishedConv) continue;
        // Sub-sessions have their own dedicated panel — hide from All Chats
        if (conv.isSubSession) continue;

        // Show all non-finished conversations
        {
          if (seenSessions.has(conv.sessionId)) continue;
          seenSessions.add(conv.sessionId);

          chats.push({
            projectId: conv.projectName?.toLowerCase().replace(/[^a-z0-9-]/g, '-') || 'unknown',
            projectName: conv.projectName || 'Unknown',
            workDir: conv.projectPath || '',
            panelId: conv.sessionId,
            accountId: conv.accountId || 'engelmann',
            sessionId: conv.sessionId,
            isVisible: sessionToWorkspace.has(conv.sessionId),
            openInWorkspace: sessionToWorkspace.get(conv.sessionId),
          });
        }
      }
    } catch (err) {
      console.warn('[AllChats] Failed to fetch conversations:', (err as Error).message);
    }

    // 3. Enrich with attention states
    const states = getSessionStates();
    for (const chat of chats) {
      for (const [_key, state] of Object.entries(states)) {
        if (state.sessionId === chat.sessionId) {
          chat.attentionState = state.state;
          chat.attentionReason = state.reason;
        }
      }
    }

    // 4. Sort: needs_attention first, then working, then visible, then by recency
    chats.sort((a, b) => {
      const score = (c: ActiveChat) => {
        let s = 0;
        if (c.attentionState === 'needs_attention') s += 40;
        if (c.attentionState === 'working') s += 30;
        if (c.isVisible) s += 20;
        return s;
      };
      return score(b) - score(a);
    });

    res.json({ chats, total: chats.length });
  });

  // ============================================================
  // Snapshot API - Capture current state of a panel as JSON
  // ============================================================

  // POST /api/snapshot/:panel -- store snapshot from frontend
  router.post('/snapshot/:panel', (req: Request, res: Response) => {
    const { panel } = req.params;
    const snapshot: PanelSnapshot = {
      panel,
      capturedAt: new Date().toISOString(),
      data: req.body,
    };
    panelSnapshots.set(panel, snapshot);
    broadcast({ type: 'snapshot-stored', panel, capturedAt: snapshot.capturedAt });
    res.json({ ok: true, panel, capturedAt: snapshot.capturedAt });
  });

  // GET /api/snapshot/:panel -- retrieve latest snapshot
  router.get('/snapshot/:panel', (req: Request, res: Response) => {
    const { panel } = req.params;
    const snapshot = panelSnapshots.get(panel);
    if (!snapshot) {
      res.status(404).json({ error: `No snapshot for panel: ${panel}` });
      return;
    }
    res.json(snapshot);
  });

  // GET /api/snapshot -- list all stored panel snapshots
  router.get('/snapshot', (_req: Request, res: Response) => {
    const list = Array.from(panelSnapshots.values()).map(s => ({
      panel: s.panel,
      capturedAt: s.capturedAt,
    }));
    res.json({ snapshots: list });
  });

  // POST /api/control/snapshot/request -- tell frontend to capture + POST a snapshot
  router.post('/control/snapshot/request', (req: Request, res: Response) => {
    const { panel } = req.body;
    if (!panel) { res.status(400).json({ error: 'panel required' }); return; }
    broadcast({ type: 'control:snapshot-request', panel });
    res.json({ ok: true, panel, message: 'Snapshot request sent to frontend' });
  });

  // ============================================================
  // CPU Profile API (triggers renderer-side V8 profiling via WebSocket)
  // ============================================================

  router.post('/cpu-profile', (_req: Request, res: Response) => {
    broadcast({ type: 'control:cpu-profile' });
    const timeout = setTimeout(() => {
      pendingProfileResolve = null;
      res.json({ error: 'timeout - no response from renderer within 10s' });
    }, 10000);
    pendingProfileResolve = (result) => {
      clearTimeout(timeout);
      pendingProfileResolve = null;
      res.json(result);
    };
  });

  // ============================================================
  // Layout Visibility API
  // GET /api/layout — shows which panels are foreground/background
  // per project, enriched with live session + attention state
  // ============================================================

  interface TabInfo {
    tabId: string;
    name: string;
    component: string;
    sessionId?: string;
    accountId?: string;
    attentionState?: string;
    attentionReason?: string;
    liveVisible?: boolean;
  }

  interface TabsetInfo {
    tabsetId: string;
    foreground: TabInfo;
    background: TabInfo[];
  }

  interface ProjectLayout {
    projectId: string;
    projectName: string;
    tabsets: TabsetInfo[];
  }

  function extractTabsets(node: any, result: TabsetInfo[]): void {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'tabset' && Array.isArray(node.children)) {
      const selected = typeof node.selected === 'number' ? node.selected : 0;
      const tabs: TabInfo[] = node.children.map((tab: any) => ({
        tabId: tab.id || '',
        name: tab.name || '',
        component: tab.component || '',
        sessionId: tab.config?.initialSessionId || tab.config?.sessionId || undefined,
        accountId: tab.config?.accountId || undefined,
      }));
      if (tabs.length === 0) return;
      const fg = tabs[selected] ?? tabs[0];
      const bg = tabs.filter((_: TabInfo, i: number) => i !== (selected < tabs.length ? selected : 0));
      result.push({ tabsetId: node.id || '', foreground: fg, background: bg });
    }
    for (const child of node.children ?? []) {
      extractTabsets(child, result);
    }
  }

  router.get('/layout', (_req: Request, res: Response) => {
    // Build session → attention state lookup
    const stateMap = new Map<string, { state: string; reason?: string }>();
    for (const [, s] of sessionStates) {
      if (s.sessionId) stateMap.set(s.sessionId, { state: s.state, reason: s.reason });
    }

    // Build live visibility lookup: sessionId → panelId (from visibilityRegistry)
    const liveSessionIds = new Set<string>();
    for (const entry of visibilityRegistry.values()) {
      if (entry.sessionId) liveSessionIds.add(entry.sessionId);
    }

    // Load all projects
    const projects: ProjectLayout[] = [];
    let projectFiles: string[] = [];
    try {
      projectFiles = readdirSync(PROJECTS_DIR).filter(f => f.endsWith('.json'));
    } catch {
      res.status(500).json({ error: 'Cannot read projects dir' });
      return;
    }

    for (const pf of projectFiles) {
      let project: any;
      try { project = JSON.parse(readFileSync(join(PROJECTS_DIR, pf), 'utf8')); } catch { continue; }
      const projectId: string = project.id || pf.replace('.json', '');
      const projectName: string = project.name || projectId;

      const layoutPath = join(LAYOUTS_DIR, `${projectId}.json`);
      if (!existsSync(layoutPath)) continue;

      let layout: any;
      try { layout = JSON.parse(readFileSync(layoutPath, 'utf8')); } catch { continue; }

      const tabsets: TabsetInfo[] = [];
      extractTabsets(layout?.layout, tabsets);

      // Enrich tabs with live state
      for (const ts of tabsets) {
        for (const tab of [ts.foreground, ...ts.background]) {
          if (tab.sessionId) {
            const s = stateMap.get(tab.sessionId);
            if (s) { tab.attentionState = s.state; tab.attentionReason = s.reason; }
            tab.liveVisible = liveSessionIds.has(tab.sessionId);
          }
        }
      }

      if (tabsets.length > 0) {
        projects.push({ projectId, projectName, tabsets });
      }
    }

    // Sort: active project first
    projects.sort((a, b) => {
      if (a.projectId === workspaceState.activeProjectId) return -1;
      if (b.projectId === workspaceState.activeProjectId) return 1;
      return a.projectId.localeCompare(b.projectId);
    });

    // Live visibility entries (raw, for debugging)
    const liveEntries = Array.from(visibilityRegistry.values()).map(e => ({
      panelId: e.panelId,
      projectId: e.projectId,
      sessionId: e.sessionId,
      route: e.route,
      updatedAt: e.updatedAt,
    }));

    res.json({
      activeProjectId: workspaceState.activeProjectId,
      projects,
      liveVisibility: liveEntries,
    });
  });

  return router;
}
