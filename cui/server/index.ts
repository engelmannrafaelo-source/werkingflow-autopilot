// =============================================================================
// CUI Workspace Server — Modular Index
// =============================================================================
// Replaces the original 7098-line monolith. Each route group lives in
// ./routes/*.ts — this file only does wiring + startup.

// ─── Section 1: ENV Loading ─────────────────────────────────────────────────
import { readFileSync as _readEnvFile, existsSync as _envExists } from 'fs';
import { resolve as _resolvePath } from 'path';

const _envPath = _resolvePath(import.meta.dirname ?? process.cwd(), '..', '.env');
const _envPathCwd = _resolvePath(process.cwd(), '.env');
// tsx doesn't set import.meta.dirname — fallback to cwd-based .env
const _resolvedEnvPath = _envExists(_envPath) ? _envPath : _envPathCwd;
if (_envExists(_resolvedEnvPath)) {
  const _lines = _readEnvFile(_resolvedEnvPath, 'utf8').split('\n');
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
import { PATHS, BRIDGE_URL, getAppHost } from './config/paths.js';
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
import qaBackendRouter from './routes/qa-backend.js';
import repoDashboardRouter from './routes/repo-dashboard.js';
import maintenanceRouter from './routes/maintenance.js';
import panelsInspectRouter from './routes/panels-inspect.js';
import auditRouter, { initAuditRouter } from './routes/audit.js';
import createInfrastructureRouter from './routes/infrastructure.js';
import createTeamRouter from './routes/team.js';
import createAdminRouter from './routes/admin.js';
import createControlRouter, { getCpuProfileResolver } from './routes/control.js';
import architectureRouter from './routes/architecture.js';
import architectureStatusRouter from './routes/architecture-status.js';
import reportBuilderRouter, { initReportBuilder } from './routes/report-builder.js';
import businessAngelRouter from './routes/business-angel.js';
import privatAngelRouter from './routes/privat-angel.js';

// External route modules (pre-existing, not part of the extraction)
import knowledgeRegistryRouter from './knowledge-registry.js';
import infisicalRoutes from './routes/infisical-routes.js';

// Auth (multi-user support for partner servers)
import authRouter from './routes/auth.js';
import { requireAuth } from './auth/middleware.js';

// Peer Awareness (cross-session work visibility)
import { initPeerAwareness, startPeerAwarenessTimer, stopPeerAwarenessTimer, createPeerAwarenessRouter } from './routes/peer-awareness.js';

// App Proxy (reverse proxy for localhost app ports — enables browser panel on remote servers)
import createAppProxyRouter from './routes/app-proxy.js';

// Background Ops (event buffer for system monitoring panel)
import { createBackgroundOpsRouter } from './routes/background-ops.js';

// Prompt Explorer (live pipeline & prompt scanner)
import { createPromptExplorerRouter } from './routes/prompt-explorer.js';

// Partner Tasks (task assignment and status tracking for partners)
import partnerTasksRouter, { initPartnerTasksRouter } from './routes/partner-tasks.js';

// Partner Activity Feed (auto-generated changelog from git commits)
import partnerActivityRouter from './routes/partner-activity.js';

// Partner Docs (self-service curated business document access)
import partnerDocsRouter, { initPartnerDocsRouter } from './routes/partner-docs.js';

// Partner Messages (admin↔partner inbox with announcements + DMs)
import partnerMessagesRouter from './routes/partner-messages.js';

// Calendar (private event storage — /root/projekte/local-storage/privat/calendar.json)
import { createCalendarRouter } from './routes/calendar.js';

// Mail (IONOS IMAP read + SMTP send + local draft queue with approve-before-send)
import { createMailRouter } from './routes/mail.js';

// Partner Feedback (structured feedback form for partners)
import createPartnerFeedbackRouter from './routes/partner-feedback.js';

// Partner Team Status (worklist sections visible to partners)
import createPartnerTeamStatusRouter from './routes/partner-team-status.js';

// Error Monitor (Sentry webhook ingestion + CUI panel API)
import createErrorsRouter, { createPublicErrorsRouter } from './routes/errors.js';

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
initAuditRouter(DATA_DIR);
initReportBuilder(DATA_DIR);
initPartnerTasksRouter(DATA_DIR);
initPartnerDocsRouter(DATA_DIR);

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

// --- Frontend Path Config (served to browser, public) ---
app.get('/api/config/paths', (_req, res) => {
  res.json({
    businessDir: PATHS.businessDir,
    orchestratorDir: PATHS.orchestratorDir,
    worklistsDir: PATHS.worklistsDir,
    personasDir: PATHS.personasDir,
    projectsRoot: PATHS.projectsRoot,
    werkingflowProductionDir: PATHS.werkingflowProductionDir,
    claudeUserHome: PATHS.claudeUserHome,
    appHost: getAppHost(),
  });
});

// --- App Proxy (BEFORE /api auth — has its own requireAuth per-route) ---
app.use(createAppProxyRouter());

// --- Error Webhooks (BEFORE /api auth — protected via ERROR_WEBHOOK_SECRET) ---
app.use('/api', createPublicErrorsRouter());  // POST /api/errors/sentry-webhook, /api/errors/report

// --- Auth routes (public — must be BEFORE requireAuth middleware) ---
app.use('/api/auth', authRouter);

// --- Auth middleware (no-op when users.json doesn't exist) ---
app.use('/api', requireAuth);

// --- Mount all routers (protected when auth is enabled) ---
app.use(filesRouter);                               // /api/health, /api/version, /api/files, /api/file, /api/file-read, /api/active-dir, /api/files/move
app.use('/api', layoutsRouter);                      // /api/projects, /api/notes, /api/layouts, /api/upload, /api/images, /api/uploads
app.use('/api/mission', missionRouter);              // /api/mission/conversations, /send, /states, /unstick, /start, etc.
app.use('/api', screenshotsRouter);                  // /api/screenshot/*, /api/capture/*, /api/panels, /api/control/screenshot/*
app.use('/api/prompt-templates', templatesRouter);   // /api/prompt-templates (GET/POST/PUT/DELETE)
app.use(autoInjectRouter);                               // /api/auto-inject (GET/POST/DELETE) — full paths in module
app.use(agentsRouter);                               // /api/agents/* (full paths in module)
app.use(bridgeRouter);                               // /api/claude-code/*, /api/bridge/* (full paths in module)
app.use(qaRouter);                                   // /api/qa/* (QA Dashboard - Unified-Tester integration)
app.use(qaBackendRouter);                            // /api/qa/backend-pyramid (Backend-Pyramide: Manifest + pytest)
app.use('/api/repo-dashboard', repoDashboardRouter);  // /api/repo-dashboard/repositories, /pipeline, /structure, /hierarchy
app.use('/api/maintenance', maintenanceRouter);       // /api/maintenance/status, /refresh, /run
app.use(panelsInspectRouter);                         // /api/panels/inspect (meta: probes each panel's GET endpoints)
app.use('/api/audit', auditRouter);                   // /api/audit/inputs, /summary, /inputs/:id/context
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
  app.use(createBackgroundOpsRouter());                // /api/background-ops (GET)

// --- Architecture Explorer API ---
app.use('/api/architecture', architectureRouter);    // /api/architecture/graph, /refresh
app.use('/api/architecture/status', architectureStatusRouter); // /api/architecture/status (live port checks)

// --- Report Builder API ---
app.use('/api/report-builder', reportBuilderRouter); // /api/report-builder/sessions, /extract, /generate, /save, /business-tree

// --- Business Angel API ---
app.use('/api/business-angel', businessAngelRouter); // /api/business-angel/context, /load, /apply-diffs

// --- Privat Angel API (personal coach, clone of business-angel for privat workspace) ---
app.use('/api/privat-angel', privatAngelRouter);     // /api/privat-angel/context, /load, /apply-diffs

// --- Prompt Explorer API ---
app.use('/api/prompt-explorer', createPromptExplorerRouter()); // /api/prompt-explorer/pipelines, /scan, /prompt

// --- Partner Tasks API ---
app.use('/api/partner', partnerTasksRouter);                   // /api/partner/tasks (GET/POST/PATCH/DELETE)

// --- Partner Activity Feed API ---
app.use('/api/partner', partnerActivityRouter);                // /api/partner/activity?app=&limit=

// --- Partner Docs API ---
app.use('/api/partner', partnerDocsRouter);                    // /api/partner/docs (GET/POST/DELETE)
app.use(partnerMessagesRouter);                             // /api/partner/messages (GET/POST)

// --- Partner Feedback API ---
app.use('/api/partner', createPartnerFeedbackRouter());     // /api/partner/feedback (GET/POST/PATCH)

// --- Partner Team Status API ---
app.use('/api/partner', createPartnerTeamStatusRouter());   // /api/partner/team-status?app=

// --- Calendar API ---
app.use(createCalendarRouter());                            // /api/calendar/events (GET/POST/PUT/DELETE)

// --- Mail API (IONOS IMAP + SMTP + draft queue) ---
app.use(createMailRouter());                                // /api/mail/*

// --- Error Monitor API (protected — Sentry webhook is public above) ---
app.use('/api/errors', createErrorsRouter());               // /api/errors (GET), /stream, /:id, spawn-fix, etc.

// --- Document Manager (Phase 3) ---
app.use('/api/team', documentManager);

// ─── Section 11: Frontend Serving (Production) ──────────────────────────────
{
  const distPath = join(WORKSPACE_ROOT, 'dist');
  if (existsSync(distPath)) {
    app.use('/assets', express.static(join(distPath, 'assets'), { maxAge: '1y', immutable: true }));
    // Serve static files EXCEPT index.html (which needs token injection)
    app.use(express.static(distPath, { etag: false, lastModified: false, index: false, setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }}));
    // ALL HTML responses (root + SPA fallback) get token injection
    // BUT: Skip paths that belong to proxied apps (/_next/, etc.) — return 404 instead
    // of CUI's index.html. This prevents "CUI within CUI" when the app-proxy interceptor
    // misses a dynamic script/resource load from a Next.js app.
    app.use((req, res, next) => {
      const p = req.path;
      // Paths that are clearly NOT CUI frontend routes
      if (p.startsWith('/_next/') || p.startsWith('/app-proxy/') ||
          (p.startsWith('/__next') || p.match(/\.(js|css|map|json|woff2?|ttf|ico|png|jpg|svg)$/))) {
        res.status(404).end();
        return;
      }
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      // Prevent CUI from being embedded in an iframe (blocks "CUI within CUI" recursion)
      res.setHeader('X-Frame-Options', 'DENY');

      // Read index.html and inject CUI_REBUILD_TOKEN (Herbert's Security Recommendation #2)
      const indexPath = join(distPath, 'index.html');
      let html = readFileSync(indexPath, 'utf-8');

      const rebuildToken = process.env.CUI_REBUILD_TOKEN || '';
      const bridgeApiKey = process.env.AI_BRIDGE_API_KEY || '';
      const bridgeUrl = BRIDGE_URL;
      const tokenScript = `<script>window.CUI_REBUILD_TOKEN = ${JSON.stringify(rebuildToken)};window.__CUI_BRIDGE_API_KEY__ = ${JSON.stringify(bridgeApiKey)};window.__CUI_BRIDGE_URL__ = ${JSON.stringify(bridgeUrl)};window.__CUI_APP_HOST__ = ${JSON.stringify(getAppHost())};</script>`;

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
  base_path: PATHS.businessDir,
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
  // Persist conv-metadata before exit — debounced writes would be lost otherwise
  try {
    const convMeta = await import('./routes/shared/conv-metadata.js');
    convMeta.flush();
    console.log('[Process] convMeta flushed to disk');
  } catch (err) {
    console.error('[Process] convMeta flush failed:', (err as Error).message);
  }
  cleanupState();
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err.message, err.stack?.split('\n').slice(0, 3).join(' | '));
});

process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason instanceof Error ? reason.message : String(reason));
});

// Start Server — fail loud if port is occupied (zombie protection).
// Defensive in-process guard: pre-start-cleanup.sh should have terminated any
// prior instance, but if it didn't (or wasn't run) we MUST NOT silently coexist.
// Parallel tsx servers fire duplicate setInterval timers → sub-session reminder spam.
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[FATAL] Port ${PORT} already in use — another CUI server is running. Refusing to start. ` +
      `Run scripts/pre-start-cleanup.sh or kill the existing tsx process.`);
    process.exit(1);
  }
  console.error('[FATAL] Server error:', err.message);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`CUI Workspace ${PROD ? '(production)' : '(dev)'} on http://localhost:${PORT} (pid=${process.pid})`);
});
