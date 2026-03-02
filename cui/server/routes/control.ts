import { Router, Request, Response } from 'express';
import { resolve, join, relative } from 'path';
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { watch } from 'chokidar';
import type { WebSocket } from 'ws';
import type { SessionState, ConvAttentionState, AttentionReason, PanelVisibility } from './state.js';

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
  CUI_PROXIES: Array<{ id: string; localPort: number; target: string }>;
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
  const { broadcast, clients, workspaceState, visibilityRegistry, sessionStates, getSessionStates, DATA_DIR, PROJECTS_DIR, LAYOUTS_DIR, startTime, CUI_PROXIES } = deps;

  // --- Finished Status Helper (for all-active-chats) ---
  const FINISHED_FILE = join(DATA_DIR, 'conv-finished.json');
  function loadFinished(): Record<string, boolean> {
    if (!existsSync(FINISHED_FILE)) return {};
    try { return JSON.parse(readFileSync(FINISHED_FILE, 'utf8')); } catch (err) { console.warn('[Control] Failed to load finished file:', err); return {}; }
  }
  function isFinished(sessionId: string): boolean {
    return loadFinished()[sessionId] === true;
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
      cuiProxies: CUI_PROXIES.map(c => ({ id: c.id, port: c.localPort, target: c.target })),
      frontendConnected: clients.size > 0,
    });
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

  router.post('/control/project/switch', (req: Request, res: Response) => {
    const { projectId } = req.body;
    if (!projectId) { res.status(400).json({ error: 'projectId required' }); return; }
    const projectFile = join(PROJECTS_DIR, `${projectId}.json`);
    if (!existsSync(projectFile)) { res.status(404).json({ error: `project ${projectId} not found` }); return; }
    workspaceState.activeProjectId = projectId;
    broadcast({ type: 'control:project-switch', projectId });
    res.json({ ok: true, projectId });
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
  // All Active Chats API (hybrid: layout scan + visibility registry + finished filter)
  // ============================================================

  router.get('/all-active-chats', (_req: Request, res: Response) => {
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
    }

    const chats: ActiveChat[] = [];
    const seenSessions = new Set<string>();

    // Collect visible session IDs from registry (panels actually open in browser)
    const visibleSessionIds = new Set<string>();
    for (const entry of visibilityRegistry.values()) {
      if (entry.sessionId && !entry.panelId.startsWith('allchats-')) {
        visibleSessionIds.add(entry.sessionId);
      }
    }

    // Scan layout files for all configured CUI panels
    const projects = readdirSync(PROJECTS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => { try { return JSON.parse(readFileSync(join(PROJECTS_DIR, f), 'utf8')); } catch (err) { console.warn('[Control] Failed to parse project file:', f, err); return null; } })
      .filter(Boolean);

    function findCuiPanels(node: any, projectId: string, projectName: string, workDir: string): void {
      if (node.type === 'tab' && (node.component === 'cui' || node.component === 'cui-lite')) {
        const route: string = node.config?._route || '';
        const match = route.match(/\/c\/(.+)/);
        if (match) {
          const sessionId = match[1];
          // Skip finished and duplicate sessions
          if (isFinished(sessionId)) return;
          if (seenSessions.has(sessionId)) return;
          seenSessions.add(sessionId);
          chats.push({
            projectId,
            projectName,
            workDir,
            panelId: node.id || '',
            accountId: node.config?.accountId || 'rafael',
            sessionId,
            isVisible: visibleSessionIds.has(sessionId),
          });
        }
      }
      if (node.children) for (const child of node.children) findCuiPanels(child, projectId, projectName, workDir);
    }

    for (const project of projects) {
      const layoutPath = join(LAYOUTS_DIR, `${project.id}.json`);
      if (!existsSync(layoutPath)) continue;
      try {
        const layout = JSON.parse(readFileSync(layoutPath, 'utf8'));
        findCuiPanels(layout.layout || layout, project.id, project.name, project.workDir || '');
      } catch (err) { console.warn('[Control] Failed to parse layout for project:', project.id, err); }
    }

    // Enrich with attention states
    const states = getSessionStates();
    for (const chat of chats) {
      for (const [_key, state] of Object.entries(states)) {
        if (state.sessionId === chat.sessionId || state.accountId === chat.accountId) {
          chat.attentionState = state.state;
          chat.attentionReason = state.reason;
        }
      }
    }

    // Sort: visible first, then needs_attention > working > idle
    chats.sort((a, b) => {
      const score = (c: ActiveChat) => {
        let s = c.attentionState === 'needs_attention' ? 30 : c.attentionState === 'working' ? 20 : 10;
        if (c.isVisible) s += 100;
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

  return router;
}
