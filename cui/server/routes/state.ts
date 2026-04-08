/**
 * State management module — extracted from index.ts lines ~700-1075.
 *
 * Contains: workspace state, panel visibility, active streams, session states
 * (persistence + detection), file watchers, broadcast system, and WebSocket handler.
 */

import { resolve, join } from 'path';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { atomicWriteFileSync } from './shared/utils.js';
import { homedir } from 'os';
import { watch } from 'chokidar';
import type { WebSocket as WsType, WebSocketServer as WssType } from 'ws';
import { registerWebSocketClient } from '../document-manager.js';

// Re-export WebSocket constant for readyState checks in broadcast()
// (ws module exports WebSocket class with OPEN/CLOSED statics)
import { WebSocket } from 'ws';

// --- Local Mode Detection ---
export const IS_LOCAL_MODE = process.env.CUI_LOCAL_MODE === 'true';

// Track WS liveness without unsafe (ws as any) casts
const wsAlive = new WeakMap<WsType, boolean>();

// --- Interval tracking for cleanup ---
const _intervals: ReturnType<typeof setInterval>[] = [];

// --- Workspace Runtime State (for Control API) ---
const startTime = Date.now();
export const workspaceState = {
  activeProjectId: '',
  cuiStates: {} as Record<string, string>,
  panels: [] as Array<{ id: string; component: string; config: Record<string, unknown>; name: string }>,
};

// --- Panel Visibility Registry ---
// Type imported from shared/types.ts — re-exported for backward compatibility
import type { PanelVisibility as _PanelVisibility } from './shared/types.js';
export type PanelVisibility = _PanelVisibility;

export const visibilityRegistry = new Map<string, PanelVisibility>();

export function updatePanelVisibility(data: { panelId: string; projectId: string; accountId: string; sessionId: string; route: string }): void {
  const key = `${data.projectId}:${data.panelId}`;
  const prev = visibilityRegistry.get(key);
  visibilityRegistry.set(key, { ...data, updatedAt: Date.now() });
  if (!prev || prev.sessionId !== data.sessionId) {
    // Session exclusivity: if this session is now claimed by a new panel, evict it from other panels
    if (data.sessionId) {
      for (const [otherKey, entry] of visibilityRegistry) {
        if (otherKey !== key && entry.sessionId === data.sessionId) {
          console.log(`[Visibility] Session ${data.sessionId.slice(0, 8)} claimed by ${data.panelId} — evicting from ${entry.panelId}`);
          broadcast({ type: 'session-claimed', sessionId: data.sessionId, claimedByPanelId: data.panelId, evictPanelId: entry.panelId, projectId: data.projectId });
          entry.sessionId = ''; // Clear old panel's session
          entry.route = '';
        }
      }
    }
    broadcast({ type: 'visibility-update', visibleSessionIds: [...getVisibleSessionIds()] });
  }
}

export function removePanelVisibility(projectId: string, panelId: string): void {
  visibilityRegistry.delete(`${projectId}:${panelId}`);
  broadcast({ type: 'visibility-update', visibleSessionIds: [...getVisibleSessionIds()] });
}

export function getVisibleSessionIds(): Set<string> {
  const ids = new Set<string>();
  for (const entry of visibilityRegistry.values()) {
    if (entry.sessionId) ids.add(entry.sessionId);
  }
  return ids;
}

// Cleanup stale entries every 60s (panels closed, browser refreshed)
_intervals.push(setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [key, entry] of visibilityRegistry) {
    if (entry.updatedAt < cutoff) visibilityRegistry.delete(key);
  }
}, 60000));

// --- Per-Session Attention State Tracker ---
// Types imported from shared/types.ts — re-exported for backward compatibility.
// Modules that previously imported these from state.ts will continue to work.
import type {
  AttentionReason as _AttentionReason,
  ConvAttentionState as _ConvAttentionState,
  SessionState as _SessionState,
} from './shared/types.js';
export type AttentionReason = _AttentionReason;
export type ConvAttentionState = _ConvAttentionState;
export type SessionState = _SessionState;

// --- Persistent Storage Dirs ---
export const DATA_DIR = IS_LOCAL_MODE
  ? resolve(process.env.CUI_DATA_DIR || join(homedir(), '.cui', 'local-data'))
  : resolve(import.meta.dirname ?? __dirname, '..', '..', 'data');
export const PROJECTS_DIR = join(DATA_DIR, 'projects');
export const NOTES_DIR = join(DATA_DIR, 'notes');
export const LAYOUTS_DIR = join(DATA_DIR, 'layouts');
export const UPLOADS_DIR = join(DATA_DIR, 'uploads');
export const ACTIVE_DIR = join(DATA_DIR, 'active');
export const SESSION_STATES_FILE = join(DATA_DIR, "session-states.json");

// Ensure dirs exist
for (const dir of [PROJECTS_DIR, NOTES_DIR, LAYOUTS_DIR, UPLOADS_DIR, ACTIVE_DIR]) {
  mkdirSync(dir, { recursive: true });
}

export const sessionStates = new Map<string, SessionState>();

export function persistSessionStates() {
  try {
    const out: Record<string, SessionState> = {};
    for (const [k, v] of sessionStates) out[k] = v;
    atomicWriteFileSync(SESSION_STATES_FILE, JSON.stringify(out, null, 2));
  } catch (err) { console.warn('[State] Failed to persist session states:', err instanceof Error ? err.message : err); }
}

export function restoreSessionStates() {
  if (!existsSync(SESSION_STATES_FILE)) return;
  try {
    const data = JSON.parse(readFileSync(SESSION_STATES_FILE, "utf8")) as Record<string, SessionState>;
    const now = Date.now();
    for (const [key, val] of Object.entries(data)) {
      // Only restore states less than 1 hour old
      if (now - val.since > 60 * 60 * 1000) continue;
      // After restart, assume previously "working" sessions are now idle
      // (the CUI binary process was likely killed or finished during restart)
      if (val.state === "working") {
        sessionStates.set(key, { ...val, state: "idle", reason: "done", since: now });
      } else {
        sessionStates.set(key, val);
      }
    }
    const restored = sessionStates.size;
    if (restored > 0) console.log(`[SessionState] Restored ${restored} states from disk (working->idle)`);
  } catch (err) {
    console.log(`[SessionState] Failed to restore states: ${err}`);
  }
}

// Restore session states on startup
restoreSessionStates();

export function setSessionState(key: string, accountId: string, state: ConvAttentionState, reason?: AttentionReason, sessionId?: string) {
  const prev = sessionStates.get(key);
  if (prev?.state === state && prev?.reason === reason) return; // no change
  sessionStates.set(key, { state, reason, since: Date.now(), accountId, sessionId });
  broadcast({ type: 'conv-attention', key, accountId, sessionId, state, reason });
  // Persist to disk for restart recovery
  persistSessionStates();
}

export function getSessionStates(): Record<string, SessionState> {
  const out: Record<string, SessionState> = {};
  for (const [k, v] of sessionStates) out[k] = v;
  return out;
}

// --- Periodic cleanup of stale state entries ---
_intervals.push(setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  // sessionStates: remove entries older than 24h
  for (const [k, v] of sessionStates) {
    if (now - v.since > 24 * 60 * 60 * 1000) { sessionStates.delete(k); cleaned++; }
  }
  // _lastBroadcast: evict entries older than 5 minutes when map grows beyond 100 keys
  const lbKeys = Object.keys(_lastBroadcast);
  if (lbKeys.length > 100) {
    for (const k of lbKeys) {
      if (now - _lastBroadcast[k].at > 300000) delete _lastBroadcast[k];
    }
  }
  if (cleaned > 0) console.log(`[Cleanup] Removed ${cleaned} stale state entries`);
}, 300000)); // Every 5 minutes

// --- File Watcher ---
const watchers = new Map<string, ReturnType<typeof watch>>();
export const clients = new Set<WsType>();

export function cleanupOldWatchers() {
  // Limit to 10 active watchers max to prevent resource exhaustion
  if (watchers.size <= 10) return;
  const entries = [...watchers.entries()];
  const toRemove = entries.slice(0, entries.length - 10);
  for (const [path, watcher] of toRemove) {
    watcher.close();
    watchers.delete(path);
    console.log(`[Watcher] Cleaned up old watcher: ${path}`);
  }
}

export function startWatching(dirPath: string) {

  const resolved = resolve(dirPath);
  if (watchers.has(resolved)) return;

  // Block overly broad paths (home dir, root, etc.) to prevent watcher crashes
  const home = homedir();
  if (resolved === home || resolved === '/') {
    console.warn(`[Watcher] Blocked overly broad watch path: ${resolved}`);
    return;
  }

  cleanupOldWatchers();

  const watcher = watch(resolved, {
    ignored: /(^|[\/\\])\.|node_modules|Library/,
    persistent: true,
    ignoreInitial: true,
    depth: 3,
  });

  // Prevent unhandled EPERM crashes on protected directories
  watcher.on('error', (err) => {
    const e = err as NodeJS.ErrnoException;
    console.warn(`[Watcher] Error on ${resolved}: ${e.code || e.message || err}`);
  });

  // file-change broadcasts removed — no frontend consumer listens for this type.
  // ChangeWatch (below) handles src/server change notifications via cui-update-available.

  watchers.set(resolved, watcher);
  console.log(`Watching: ${resolved}`);
}

// --- Broadcast dedup + throttling ---
// Tracks last broadcast per type+key to suppress duplicates
const _lastBroadcast: Record<string, { state: string; at: number }> = {};
// Global broadcast rate counter (for diagnostics)
let _broadcastCount = 0;
let _broadcastDropped = 0;
let _broadcastT0 = Date.now();
// Per-type throttle: maps "type:key" -> pending setTimeout
const _broadcastThrottled: Record<string, ReturnType<typeof setTimeout>> = {};

// Log broadcast rate every 60s
_intervals.push(setInterval(() => {
  if (_broadcastCount > 0 || _broadcastDropped > 0) {
    const s = ((Date.now() - _broadcastT0) / 1000).toFixed(0);
    console.log(`[Broadcast] ${s}s: ${_broadcastCount} sent, ${_broadcastDropped} dropped (${(_broadcastCount / (+s || 1)).toFixed(1)}/s)`);
  }
  _broadcastCount = 0;
  _broadcastDropped = 0;
  _broadcastT0 = Date.now();
}, 60000));

// Reference to _pendingChanges — set by caller via setPendingChangesRef()
let _pendingChangesRef: { length: number } = { length: 0 };

export function setPendingChangesRef(ref: { length: number }) {
  _pendingChangesRef = ref;
}

// Log memory + health every 5 minutes
_intervals.push(setInterval(() => {
  const mem = process.memoryUsage();
  const uptimeMin = (process.uptime() / 60).toFixed(0);
  console.log(`[Health] uptime=${uptimeMin}m rss=${(mem.rss / 1024 / 1024).toFixed(0)}MB heap=${(mem.heapUsed / 1024 / 1024).toFixed(0)}/${(mem.heapTotal / 1024 / 1024).toFixed(0)}MB ws=${clients.size} pending=${_pendingChangesRef.length}`);
}, 300000));

export function broadcast(data: Record<string, unknown>) {
  const type = data.type as string;

  // Track CUI states in workspace state store
  if (type === 'cui-state' && data.cuiId && data.state) {
    const id = data.cuiId as string;
    const state = data.state as string;
    workspaceState.cuiStates[id] = state;
    // Dedup: skip if same state was broadcast for this cuiId within last 2s
    const prev = _lastBroadcast[id];
    if (prev && prev.state === state && Date.now() - prev.at < 2000) { _broadcastDropped++; return; }
    _lastBroadcast[id] = { state, at: Date.now() };
  }

  // Dedup cui-response-ready: skip if last state is already 'done'
  if (type === 'cui-response-ready' && data.cuiId) {
    const id = data.cuiId as string;
    const prev = _lastBroadcast[id];
    if (prev && prev.state === 'done' && Date.now() - prev.at < 500) { _broadcastDropped++; return; }
  }

  // Throttle high-frequency types: coalesce rapid-fire messages of same type+key
  // Only latest value is sent after the throttle window
  const throttledTypes: Record<string, number> = {
    'visibility-update': 2000,
    'conv-attention': 1000,
    'cui-update-available': 5000,
    'tool-heartbeat': 10000,
  };
  const throttleMs = throttledTypes[type];
  if (throttleMs) {
    const throttleKey = `${type}:${data.cuiId || data.key || '_'}`;
    if (_broadcastThrottled[throttleKey]) {
      clearTimeout(_broadcastThrottled[throttleKey]);
      _broadcastDropped++;
    }
    _broadcastThrottled[throttleKey] = setTimeout(() => {
      delete _broadcastThrottled[throttleKey];
      _broadcastCount++;
      const json = JSON.stringify(data);
      for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) {
          try { client.send(json); } catch (err) { console.warn('[WS] Client send failed, removing:', err instanceof Error ? err.message : err); clients.delete(client); }
        }
      }
    }, throttleMs);
    return;
  }

  // Direct send for non-throttled types
  _broadcastCount++;
  const json = JSON.stringify(data);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(json); } catch (err) { console.warn('[WS] Client send failed, removing:', err instanceof Error ? err.message : err); clients.delete(client); }
    }
  }
}

// Guard against double-invocation of initWebSocket
let _wsInitialized = false;

/**
 * Initialize WebSocket connection handler on the given wss instance.
 * Must be called once after wss is created.
 * Accepts pendingProfileResolve setter so WS messages can resolve CPU profiles.
 */
// Layout snapshots from LayoutManagers (updated on reportPanels)
const layoutSnapshots = new Map<string, { panels: Array<{ id: string; component: string; config: Record<string, unknown>; name: string }>; updatedAt: number }>();

export function getLayoutSnapshot(projectId: string) {
  return layoutSnapshots.get(projectId);
}

export function getAllLayoutSnapshots() {
  const result: Record<string, any> = {};
  for (const [k, v] of layoutSnapshots) result[k] = v;
  return result;
}

// Pending navigations for panels that haven't connected yet (race condition fix)
const pendingNavigations = new Map<string, { type: string; panelId: string; sessionId: string; projectId: string }>();

export function initWebSocket(
  wss: WssType,
  getPendingProfileResolve: () => ((result: unknown) => void) | null,
) {
  if (_wsInitialized) { console.warn('[WS] initWebSocket called twice, ignoring'); return; }
  _wsInitialized = true;
  wss.on('connection', (ws: WsType) => {
    clients.add(ws);
    wsAlive.set(ws, true);
    console.log(`[WS] Client connected (${clients.size} total)`);
    ws.on('pong', () => { wsAlive.set(ws, true); });
    ws.on('close', () => { clients.delete(ws); console.log(`[WS] Client disconnected (${clients.size} remaining)`); });
    ws.on('error', (err: Error) => { console.warn('[WS] Client error:', err.message); clients.delete(ws); });

    // Register for Document Manager broadcasts
    registerWebSocketClient(ws);

    ws.on('message', (raw: Buffer) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        // ignore malformed JSON messages
        return;
      }
      try {
        if (msg.type === 'watch') {
          startWatching(msg.path);
        }
        // Frontend state reports (for Control API state queries)
        if (msg.type === 'state-report') {
          if (msg.activeProjectId) workspaceState.activeProjectId = msg.activeProjectId;
          if (msg.panels) workspaceState.panels = msg.panels;
        }
        // Panel visibility reports from CuiPanel
        if (msg.type === 'panel-visibility' && msg.panelId && msg.projectId) {
          console.log(`[Visibility] Register panel=${msg.panelId} project=${msg.projectId} session=${(msg.sessionId || '').slice(0,8) || 'none'}`);
          updatePanelVisibility({
            panelId: msg.panelId,
            projectId: msg.projectId,
            accountId: msg.accountId || '',
            sessionId: msg.sessionId || '',
            route: msg.route || '',
          });
          // Deliver pending navigation if panel just connected (race condition fix)
          const pendingNav = pendingNavigations.get(msg.panelId);
          if (pendingNav) {
            console.log(`[Navigate] Delivering pending nav to panel ${msg.panelId} -> session=${pendingNav.sessionId.slice(0,8)} (was: ${(msg.sessionId || 'none').slice(0,8)})`);
            try { ws.send(JSON.stringify(pendingNav)); } catch {}
            pendingNavigations.delete(msg.panelId);
          }
        }
        // Panel removed from layout
        if (msg.type === 'panel-removed' && msg.projectId && msg.panelId) {
          removePanelVisibility(msg.projectId, msg.panelId);
        }
        // Store layout snapshot from LayoutManager
        if (msg.type === 'state-report' && msg.panels) {
          // Find which project this WS belongs to (from last panel-visibility or workspace-state)
          const projId = msg.projectId || '';
          if (projId) {
            layoutSnapshots.set(projId, { panels: msg.panels, updatedAt: Date.now() });
          }
        }
        // Panel asks for pending navigation on connect
        if (msg.type === 'check-pending-navigate' && msg.panelId) {
          const pendingNav = pendingNavigations.get(msg.panelId);
          if (pendingNav) {
            console.log(`[Navigate] Panel ${msg.panelId} asked for pending nav -> delivering session=${pendingNav.sessionId.slice(0,8)}`);
            try { ws.send(JSON.stringify(pendingNav)); } catch {}
            pendingNavigations.delete(msg.panelId);
          }
        }
        // Navigate request from LayoutManager -> broadcast + store for late-connecting panels
        if (msg.type === 'navigate-request' && msg.panelId && msg.sessionId) {
          console.log(`[Navigate] panel=${msg.panelId} -> session=${msg.sessionId.slice(0,8)} project=${msg.projectId || '?'}`);
          const navMsg = { type: 'control:cui-navigate-conversation' as const, panelId: msg.panelId, sessionId: msg.sessionId, projectId: msg.projectId || '' };
          broadcast(navMsg);
          // Store for panels that connect after broadcast (race condition fix)
          pendingNavigations.set(msg.panelId, navMsg);
          setTimeout(() => pendingNavigations.delete(msg.panelId), 30000); // expire after 30s
        }
        // Relay control messages from frontend components to LayoutManager (and other listeners)
        if (msg.type === 'control:ensure-panel' || msg.type === 'control:select-tab'
            || msg.type === 'control:panel-add' || msg.type === 'control:panel-remove'
            || msg.type === 'control:layout-reset') {
          broadcast(msg);
        }
        // CPU profile result from renderer
        const pendingProfileResolve = getPendingProfileResolve();
        if (msg.type === 'cpu-profile-result' && pendingProfileResolve) {
          pendingProfileResolve(msg.data);
        }
      } catch (err) {
        console.warn('[WS] Message handler error:', err);
      }
    });
  });

  // WebSocket ping/pong heartbeat -- detect dead connections every 30s
  _intervals.push(setInterval(() => {
    for (const ws of clients) {
      if (!wsAlive.get(ws)) { ws.terminate(); clients.delete(ws); continue; }
      wsAlive.set(ws, false);
      try { ws.ping(); } catch (err) { console.warn('[WS] Ping failed, removing:', err instanceof Error ? err.message : err); clients.delete(ws); }
    }
  }, 30000));

}

/** Clear all module-level intervals (for graceful shutdown / tests). */
export function cleanupState() {
  _intervals.forEach(clearInterval);
  _intervals.length = 0;
}
