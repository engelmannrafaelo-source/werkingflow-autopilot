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
console.log('[.env] WERKING_REPORT_ADMIN_SECRET:', process.env.WERKING_REPORT_ADMIN_SECRET ? `set (${process.env.WERKING_REPORT_ADMIN_SECRET.length} chars)` : 'MISSING');

// ─── Section 2: Core Imports ────────────────────────────────────────────────
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { resolve, join } from 'path';
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'fs';
import documentManager from './document-manager.js';
import * as metricsDb from './metrics-db.js';

// ─── Section 3: Module Imports ──────────────────────────────────────────────
import {
  sessionStates,
  activeStreams,
  setSessionState,
  getSessionStates,
  detectAttentionMarkers,
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
  CUI_PROXIES,
  setupCuiProxies,
  monitorStream,
} from './routes/proxy.js';

import missionRouter, { initMissionRouter } from './routes/mission.js';
import type { MissionDeps } from './routes/mission.js';

import createFilesRouter from './routes/files.js';
import createLayoutsRouter from './routes/layouts.js';
import createScreenshotRoutes from './routes/screenshots.js';
import templatesRouter, { initTemplatesRouter } from './routes/templates.js';
import createAutoInjectRouter, { startAutoInjectTimer, stopAutoInjectTimer } from './routes/autoinject.js';
import agentsRouter from './routes/agents.js';
import bridgeRouter from './routes/bridge.js';
import repoDashboardRouter from './routes/repo-dashboard.js';
import createInfrastructureRouter from './routes/infrastructure.js';
import createTeamRouter from './routes/team.js';
import createAdminRouter from './routes/admin.js';
import createControlRouter, { getCpuProfileResolver } from './routes/control.js';

// External route modules (pre-existing, not part of the extraction)
import knowledgeRegistryRouter from './knowledge-registry.js';
import infisicalRoutes from './routes/infisical-routes.js';

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

// ─── Section 8: Proxy Setup ────────────────────────────────────────────────

// findJsonlPath: searches CUI account project dirs for JSONL session files
function findJsonlPath(sessionId: string): string | null {
  if (!sessionId) return null;
  const accountDirs = [
    '/home/claude-user/.cui-account1/.claude/projects',
    '/home/claude-user/.cui-account2/.claude/projects',
    '/home/claude-user/.cui-account3/.claude/projects',
  ];
  for (const accDir of accountDirs) {
    try {
      const workspaces = readdirSync(accDir);
      for (const ws of workspaces) {
        const wsPath = join(accDir, ws);
        try {
          const files = readdirSync(wsPath);
          const match = files.find(f => f.startsWith(sessionId));
          if (match) return join(wsPath, match);
        } catch (err) { console.warn('[Index] Unreadable dir in findJsonlPath:', err instanceof Error ? err.message : err); }
      }
    } catch (err) { console.warn('[Index] Account dir not found:', err instanceof Error ? err.message : err); }
  }
  return null;
}

// setLastPrompt: tracks when the last prompt was sent per session
const LAST_PROMPT_FILE = join(DATA_DIR, 'conv-last-prompt.json');
function setLastPrompt(sessionId: string) {
  try {
    let data: Record<string, string> = {};
    if (existsSync(LAST_PROMPT_FILE)) {
      try { data = JSON.parse(readFileSync(LAST_PROMPT_FILE, 'utf8')); } catch (err) { console.warn('[Index] Failed to parse last-prompt file:', err instanceof Error ? err.message : err); }
    }
    data[sessionId] = new Date().toISOString();
    writeFileSync(LAST_PROMPT_FILE, JSON.stringify(data, null, 2));
  } catch (err) { console.warn('[Index] Failed to write last-prompt:', err instanceof Error ? err.message : err); }
}

setupCuiProxies({
  broadcast,
  setSessionState,
  sessionStates,
  detectAttentionMarkers,
  findJsonlPath,
  setLastPrompt,
});

// ─── Section 9: cuiFetch + unstickConversation ──────────────────────────────
// Shared by autoinject (injection into CUI binaries) and mission (conversation control)

async function cuiFetch(proxyPort: number, path: string, options?: { method?: string; body?: string; timeoutMs?: number }): Promise<{ data: any; ok: boolean; status: number; error?: string }> {
  const url = `http://localhost:${proxyPort}${path}`;
  const controller = new AbortController();
  const ms = options?.timeoutMs ?? 8000;
  const timeout = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, {
      method: options?.method || 'GET',
      headers: options?.body ? { 'Content-Type': 'application/json' } : {},
      body: options?.body,
      signal: controller.signal,
    });
    const data = await res.json();
    if (!res.ok) {
      const errMsg = data?.error?.message || data?.error?.code || data?.message || data?.error || `HTTP ${res.status}`;
      return { data, ok: false, status: res.status, error: String(errMsg) };
    }
    return { data, ok: true, status: res.status };
  } catch (err: any) {
    const msg = err?.name === 'AbortError' ? `timeout (${ms / 1000}s)` : (err?.cause?.code === 'ECONNREFUSED' ? 'connection refused' : (err?.message || 'network error'));
    return { data: null, ok: false, status: 0, error: msg };
  } finally {
    clearTimeout(timeout);
  }
}

function unstickConversation(sessionId: string): number {
  const jsonlPath = findJsonlPath(sessionId);
  if (!jsonlPath || !existsSync(jsonlPath)) return 0;
  try {
    const content = readFileSync(jsonlPath, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    let removed = 0;
    while (lines.length > 0) {
      const lastLine = lines[lines.length - 1];
      try {
        const entry = JSON.parse(lastLine);
        if (entry.isApiErrorMessage && entry.error === 'rate_limit') {
          lines.pop();
          removed++;
          continue;
        }
      } catch { /* not JSON, stop */ }
      break;
    }
    if (removed > 0) {
      writeFileSync(jsonlPath, lines.join('\n') + '\n');
      console.log(`[Unstick] Removed ${removed} rate_limit entries from ${sessionId}`);
    }
    return removed;
  } catch (err) {
    console.warn(`[Unstick] Error processing ${sessionId}:`, err);
    return 0;
  }
}

// ─── Section 10: Route Mounting ─────────────────────────────────────────────

// --- Initialize factory-based modules ---
initMissionRouter({
  CUI_PROXIES,
  broadcast,
  sessionStates,
  setSessionState,
  getSessionStates,
  DATA_DIR,
  PROJECTS_DIR,
  PORT,
  monitorStream,
  activeStreams,
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
  CUI_PROXIES,
});
const autoInjectRouter = createAutoInjectRouter({
  cuiFetch,
  sessionStates,
  setSessionState,
  broadcast,
  CUI_PROXIES,
  DATA_DIR,
  activeStreams,
  monitorStream,
  unstickConversation,
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
app.use('/api/repo', repoDashboardRouter);           // /api/repo/repositories, /pipeline, /structure, /hierarchy
app.use(infrastructureRouter);                       // /watchdog/*, /api/rebuild, /api/panel-health, /api/bridge-db/*, /api/infrastructure/*
app.use('/api/team', teamRouter);                    // /api/team/personas, /worklist, /tasks, /events, /reviews, /task-board, /chat
app.use('/api', adminRouter);                        // /api/admin/wr/*, /api/ops/deployments
app.use('/api', controlRouter);                      // /api/control/*, /api/cui-sync, /api/syncthing/*, /api/all-active-chats, /api/snapshot/*, /api/cpu-profile

// --- External route modules (pre-existing, not extracted) ---
app.use('/api/team/knowledge', knowledgeRegistryRouter);
app.use('/api/infisical', infisicalRoutes);

// --- Document Manager (Phase 3) ---
app.use('/api/team', documentManager);

// ─── Section 11: Frontend Serving (Production) ──────────────────────────────
{
  const distPath = resolve(import.meta.dirname ?? '.', '..', 'dist');
  if (existsSync(distPath)) {
    app.use('/assets', express.static(join(distPath, 'assets'), { maxAge: '1y', immutable: true }));
    app.use(express.static(distPath, { etag: false, lastModified: false, setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }}));
    // SPA fallback
    app.use((_req, res) => {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.sendFile(join(distPath, 'index.html'));
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

// Graceful Shutdown
process.on('SIGTERM', () => {
  console.log('[Process] SIGTERM received, shutting down gracefully');
  knowledgeWatcher.stop();
  stopAutoInjectTimer();
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
