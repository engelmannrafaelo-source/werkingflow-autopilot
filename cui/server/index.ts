// =============================================================================
// CUI Workspace Server — Modular Index
// =============================================================================
// Replaces the original 7098-line monolith. Each route group lives in
// ./routes/*.ts — this file only does wiring + startup.

// ─── Section 1: ENV Loading ─────────────────────────────────────────────────
import { readFileSync as _readEnvFile, existsSync as _envExists } from 'fs';
import { resolve as _resolvePath } from 'path';

const _envPath = _resolvePath(import.meta.dirname ?? '.', '..', '.env');
if (_envExists(_envPath)) {
  const _lines = _readEnvFile(_envPath, 'utf8').split('\n');
  for (const _line of _lines) {
    const _trimmed = _line.trim();
    if (!_trimmed || _trimmed.startsWith('#')) continue;
    const _eq = _trimmed.indexOf('=');
    if (_eq < 1) continue;
    const _key = _trimmed.slice(0, _eq).trim();
    const _val = _trimmed.slice(_eq + 1).trim();
    if (!process.env[_key]) process.env[_key] = _val;
  }
}

// ─── Section 1b: Env Validation ─────────────────────────────────────────────
{
  const _required: [string, string][] = [
    ["WERKING_REPORT_ADMIN_SECRET", "WR Admin panel auth"],
    ["AI_BRIDGE_API_KEY", "Bridge Monitor API access"],
  ];
  const _recommended: [string, string][] = [
    ["AI_BRIDGE_URL", "Bridge Monitor URL (fallback: 49.12.72.66:8000)"],
    ["VERCEL_TOKEN", "Deployment panel"],
    ["SYNCTHING_API_KEY", "Syncthing panel"],
    ["CUI_REBUILD_TOKEN", "Rebuild auth token"],
  ];
  for (const [k, desc] of _required) {
    if (!process.env[k]) console.error(`[ENV] MISSING REQUIRED: ${k} \u2014 ${desc} will NOT work`);
  }
  for (const [k, desc] of _recommended) {
    if (!process.env[k]) console.warn(`[ENV] missing recommended: ${k} \u2014 ${desc}`);
  }
}

// ─── Section 2: Core Imports ────────────────────────────────────────────────
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { resolve, join } from 'path';
import { readFileSync, readdirSync, existsSync, writeFileSync, statSync, renameSync } from 'fs';
import documentManager from './document-manager.js';
import * as metricsDb from './metrics-db.js';

// ─── Section 3: Module Imports ──────────────────────────────────────────────
import {
  sessionStates,
  setSessionState,
  getSessionStates,
  broadcast,
  clients,
  initWebSocket,
  cleanupState,
  visibilityRegistry,
  workspaceState,
  DATA_DIR,
  PROJECTS_DIR,
  NOTES_DIR,
  LAYOUTS_DIR,
  UPLOADS_DIR,
  ACTIVE_DIR,
  getVisibleSessionIds,
} from './routes/state.js';

import {
  initClaudeCli,
  ACCOUNT_CONFIG,
  stopAll as stopAllCli,
  getActiveProcesses as getActiveCliProcesses,
} from './routes/claude-cli.js';

import missionRouter, { initMissionRouter } from './routes/mission.js';
import type { MissionDeps } from './routes/mission.js';

import createFilesRouter from './routes/files.js';
import createLayoutsRouter from './routes/layouts.js';
import createScreenshotRoutes from './routes/screenshots.js';
import templatesRouter, { initTemplatesRouter } from './routes/templates.js';
import createAutoInjectRouter, { startAutoInjectTimer, stopAutoInjectTimer } from './routes/autoinject.js';
import agentsRouter from './routes/agents.js';
import bridgeRouter from './routes/bridge.js';
import qaRouter from './routes/qa.js';
import repoDashboardRouter from './routes/repo-dashboard.js';
import maintenanceRouter from './routes/maintenance.js';
import createInfrastructureRouter from './routes/infrastructure.js';
import createTeamRouter from './routes/team.js';
import createAdminRouter from './routes/admin.js';
import createControlRouter, { getCpuProfileResolver } from './routes/control.js';

// External route modules (pre-existing, not part of the extraction)
import knowledgeRegistryRouter from './knowledge-registry.js';
import infisicalRoutes from './routes/infisical-routes.js';

// Peer Awareness (cross-session work visibility)
import { initPeerAwareness, startPeerAwarenessTimer, stopPeerAwarenessTimer, createPeerAwarenessRouter } from './routes/peer-awareness.js';

// Background Ops (event buffer for system monitoring panel)
import { createSynchroniseRouter } from './routes/synchronise.js';
import { createBackgroundOpsRouter } from './routes/background-ops.js';

// ─── Section 4: Constants ───────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT ?? '4005', 10);
const PROD = process.env.NODE_ENV === 'production';
const WORKSPACE_ROOT = resolve(import.meta.dirname ?? __dirname, '..');

// ─── Section 5: Express + HTTP + WebSocket Setup ────────────────────────────
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// ─── Section 6: Middleware ──────────────────────────────────────────────────
app.use(express.json({ limit: '50mb' }));
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-secret');
  if (_req.method === 'OPTIONS') { res.sendStatus(200); return; }
  next();
});

// HTML Cache-Control: no-store (prevent stale frontend after rebuild)
app.use((_req, res, next) => {
  const origSend = res.send.bind(res);
  res.send = function (body) {
    if (typeof body === 'string' && body.includes('<!DOCTYPE html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
    return origSend(body);
  };
  next();
});

// ─── Section 7: WebSocket Initialization ────────────────────────────────────
initWebSocket(wss, getCpuProfileResolver);

// ─── Section 8: Claude CLI Initialization ─────────────────────────────────

// Initialize Claude CLI direct spawn (replaces cui-server entirely)
initClaudeCli({
  broadcast,
  setSessionState,
  sessionStates,
});




// ─── Section 10: Route Mounting ─────────────────────────────────────────────

// --- Initialize factory-based modules ---
initMissionRouter({
  broadcast,
  sessionStates,
  setSessionState,
  getSessionStates,
  DATA_DIR,
  PROJECTS_DIR,
  PORT,
  visibilityRegistry,
  getVisibleSessionIds,
} satisfies MissionDeps);

initTemplatesRouter(DATA_DIR);

const filesRouter = createFilesRouter({ DATA_DIR, ACTIVE_DIR, PORT });
const layoutsRouter = createLayoutsRouter({ LAYOUTS_DIR, PROJECTS_DIR, NOTES_DIR, UPLOADS_DIR, DATA_DIR });
const screenshotsRouter = createScreenshotRoutes({ broadcast });
const infrastructureRouter = createInfrastructureRouter({ metricsDb, broadcast, WORKSPACE_ROOT });
const teamRouter = createTeamRouter();
const adminRouter = createAdminRouter({ broadcast });
const controlRouter = createControlRouter({
  broadcast,
  clients,
  workspaceState,
  visibilityRegistry,
  sessionStates,
  getSessionStates,
  DATA_DIR,
  PROJECTS_DIR,
  LAYOUTS_DIR,
  startTime: Date.now(),
  ACCOUNT_CONFIG,
});
const autoInjectRouter = createAutoInjectRouter({
  sessionStates,
  setSessionState,
  broadcast,
  DATA_DIR,
});

// --- Mount all routers ---
app.use(filesRouter);                               // /api/health, /api/version, /api/files, /api/file, /api/file-read, /api/active-dir, /api/files/move
app.use('/api', layoutsRouter);                      // /api/projects, /api/notes, /api/layouts, /api/upload, /api/images, /api/uploads
app.use('/api/mission', missionRouter);              // /api/mission/conversations, /send, /states, /unstick, /start, etc.
app.use('/api', screenshotsRouter);                  // /api/screenshot/*, /api/capture/*, /api/panels, /api/control/screenshot/*
app.use('/api/prompt-templates', templatesRouter);   // /api/prompt-templates (GET/POST/PUT/DELETE)
app.use(autoInjectRouter);                               // /api/auto-inject (GET/POST/DELETE) — full paths in module
app.use(agentsRouter);                               // /api/agents/* (full paths in module)
app.use(bridgeRouter);                               // /api/claude-code/*, /api/bridge/* (full paths in module)
app.use(qaRouter);                                   // /api/qa/* (QA Dashboard - Unified-Tester integration)
app.use('/api/repo-dashboard', repoDashboardRouter);  // /api/repo-dashboard/repositories, /pipeline, /structure, /hierarchy
app.use('/api/maintenance', maintenanceRouter);       // /api/maintenance/status, /refresh, /run
app.use(infrastructureRouter);                       // /watchdog/*, /api/rebuild, /api/panel-health, /api/bridge-db/*, /api/infrastructure/*
app.use('/api/team', teamRouter);                    // /api/team/personas, /worklist, /tasks, /events, /reviews, /task-board, /chat
app.use('/api', adminRouter);                        // /api/admin/wr/*, /api/ops/deployments
app.use('/api', controlRouter);                      // /api/control/*, /api/cui-sync, /api/syncthing/*, /api/all-active-chats, /api/snapshot/*, /api/cpu-profile

// --- External route modules (pre-existing, not extracted) ---
app.use('/api/team/knowledge', knowledgeRegistryRouter);
app.use('/api/infisical', infisicalRoutes);

// --- Peer Awareness API ---
app.use(createPeerAwarenessRouter());                // /api/peer-awareness (GET + POST /refresh)

// --- Background Ops API ---
app.use(createSynchroniseRouter({ broadcast, sessionStates, setSessionState }));
  app.use(createBackgroundOpsRouter());                // /api/background-ops (GET)

// --- Document Manager (Phase 3) ---
app.use('/api/team', documentManager);

// ─── Section 11: Frontend Serving (Production) ──────────────────────────────
{
  const distPath = resolve(import.meta.dirname ?? '.', '..', 'dist');
  if (existsSync(distPath)) {
    app.use('/assets', express.static(join(distPath, 'assets'), { maxAge: '1y', immutable: true }));
    // Serve static files EXCEPT index.html (which needs token injection)
    app.use(express.static(distPath, { etag: false, lastModified: false, index: false, setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }}));
    // ALL HTML responses (root + SPA fallback) get token injection
    app.use((_req, res) => {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

      // Read index.html and inject CUI_REBUILD_TOKEN (Herbert's Security Recommendation #2)
      const indexPath = join(distPath, 'index.html');
      let html = readFileSync(indexPath, 'utf-8');

      const rebuildToken = process.env.CUI_REBUILD_TOKEN || '';
      const bridgeApiKey = process.env.AI_BRIDGE_API_KEY || '';
      const bridgeUrl = process.env.AI_BRIDGE_URL || 'http://49.12.72.66:8000';
      const tokenScript = `<script>window.CUI_REBUILD_TOKEN = ${JSON.stringify(rebuildToken)};window.__CUI_BRIDGE_API_KEY__ = ${JSON.stringify(bridgeApiKey)};window.__CUI_BRIDGE_URL__ = ${JSON.stringify(bridgeUrl)};</script>`;

      // Inject before closing </head> tag
      html = html.replace('</head>', `${tokenScript}\n</head>`);

      res.send(html);
    });
  }
}

// ─── Section 12: Startup + Shutdown ─────────────────────────────────────────

// Knowledge Watcher
import { KnowledgeWatcher } from './knowledge-watcher.js';
const knowledgeWatcher = new KnowledgeWatcher({
  base_path: '/root/projekte/werkingflow/business',
  ignore_patterns: ['**/archive/**', '**/_archiv/**', '**/.DS_Store', '**/*.pdf', '**/*.html'],
  debounce_ms: 2000,
  auto_scan_threshold: 5,
});
knowledgeWatcher.start();

// Auto-Inject Timer
startAutoInjectTimer();

// Peer Awareness Timer (cross-session visibility, 5min interval)
initPeerAwareness({ getSessionStates, DATA_DIR });
startPeerAwarenessTimer();

// Graceful Shutdown
process.on('SIGTERM', async () => {
  console.log('[Process] SIGTERM received, shutting down gracefully');
  knowledgeWatcher.stop();
  stopAutoInjectTimer();
  stopPeerAwarenessTimer();
  await stopAllCli();
  cleanupState();
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err.message, err.stack?.split('\n').slice(0, 3).join(' | '));
});

process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason instanceof Error ? reason.message : String(reason));
});

// Start Server
server.listen(PORT, () => {
  console.log(`CUI Workspace ${PROD ? '(production)' : '(dev)'} on http://localhost:${PORT}`);
});
