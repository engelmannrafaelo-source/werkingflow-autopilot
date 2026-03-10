import { Router, Request, Response } from 'express';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

import type { AttentionReason, ConvAttentionState, SessionState } from './shared/types.js';
import { logUserInput as sharedLogUserInput, atomicWriteFileSync } from './shared/utils.js';
import * as claudeCli from './claude-cli.js';
import { unstickConversation } from './shared/jsonl.js';
import { logBackgroundEvent } from './background-ops.js';

// --- Type Definitions ---
// Configs are keyed by sessionId (not accountId) — supports multi-session per account
interface AutoInjectConfig {
  sessionId: string;
  accountId: string;
  workDir: string;
  message: string;
  intervalMs: number;
  enabled: boolean;
  idleSinceMs?: number;
}

interface AutoInjectState {
  configs: Record<string, AutoInjectConfig>;  // Key: sessionId
  lastInject: Record<string, string>;         // Key: sessionId
}

interface AutoInjectDeps {
  sessionStates: Map<string, SessionState>;
  setSessionState: (key: string, accountId: string, state: ConvAttentionState, reason?: AttentionReason, sessionId?: string) => void;
  broadcast: (data: Record<string, unknown>) => void;
  DATA_DIR: string;
}

// --- Constants ---
const AUTOINJECT_TICK_MS = 30_000;
const MIN_INJECT_INTERVAL_MS = 30_000;
const DEFAULT_MESSAGE = "Weiter. Falls idle: prüfe aktuellen Stand und arbeite weiter.";
const MAX_LOOPS_PER_ACCOUNT = 5;

// Module-level state
let AUTOINJECT_FILE: string;
let INPUT_LOG_FILE: string;
let autoInjectTimer: ReturnType<typeof setInterval> | null = null;
let deps: AutoInjectDeps;
let tickRunning = false;
let _tickCount = 0;

function loadAutoInject(): AutoInjectState {
  if (!existsSync(AUTOINJECT_FILE)) return { configs: {}, lastInject: {} };
  try {
    const raw = JSON.parse(readFileSync(AUTOINJECT_FILE, "utf8"));
    const migrated: AutoInjectState = { configs: {}, lastInject: raw.lastInject || {} };

    for (const [key, cfg] of Object.entries(raw.configs || {})) {
      const c = cfg as AutoInjectConfig;
      // Migration: old format used accountId as key, new format uses sessionId
      if (c.sessionId && key !== c.sessionId && !key.includes('-')) {
        // Old accountId-keyed config → migrate to sessionId key
        migrated.configs[c.sessionId] = { ...c };
        if (migrated.lastInject[key]) {
          migrated.lastInject[c.sessionId] = migrated.lastInject[key];
          delete migrated.lastInject[key];
        }
        console.log(`[AutoInject] Migrated config: ${key} → ${c.sessionId.slice(0, 8)}`);
      } else {
        migrated.configs[key] = c;
      }
    }
    return migrated;
  } catch (err) {
    console.warn('[AutoInject] Failed to load config:', err instanceof Error ? err.message : err);
    return { configs: {}, lastInject: {} };
  }
}

function saveAutoInject(state: AutoInjectState) {
  atomicWriteFileSync(AUTOINJECT_FILE, JSON.stringify(state, null, 2));
}

// --- Public: Migrate autoinject config when session changes (resume failed → new sessionId) ---
function updateAutoInjectSession(oldSessionId: string, newSessionId: string): void {
  const state = loadAutoInject();
  const cfg = state.configs[oldSessionId];
  if (!cfg) return;

  state.configs[newSessionId] = { ...cfg, sessionId: newSessionId };
  delete state.configs[oldSessionId];
  if (state.lastInject[oldSessionId]) {
    state.lastInject[newSessionId] = state.lastInject[oldSessionId];
    delete state.lastInject[oldSessionId];
  }
  saveAutoInject(state);
  console.log(`[AutoInject] Config migrated: ${oldSessionId.slice(0, 8)} → ${newSessionId.slice(0, 8)}`);
}

async function autoInjectTick() {
  if (tickRunning) {
    console.log('[AutoInject] Tick skipped — previous tick still running');
    return;
  }
  tickRunning = true;
  _tickCount++;
  try {
    await _autoInjectTickInner();
  } finally {
    tickRunning = false;
  }
}

async function _autoInjectTickInner() {
  const state = loadAutoInject();
  const sessionIds = Object.keys(state.configs);
  if (sessionIds.length === 0) {
    if (!(_tickCount % 60)) console.log('[AutoInject] No configs defined');
    return;
  }

  for (const [sessionId, cfg] of Object.entries(state.configs)) {
    if (!cfg.enabled) {
      if (!(_tickCount % 20)) console.log(`[AutoInject] ${cfg.accountId}/${sessionId.slice(0, 8)}: DISABLED`);
      continue;
    }
    if (!claudeCli.getAccountConfig(cfg.accountId)) {
      console.log(`[AutoInject] Unknown account ${cfg.accountId}, skipping`);
      continue;
    }

    const ss = deps.sessionStates.get(sessionId);

    // Skip if busy or needs attention
    if (ss?.state === "working" || ss?.state === "needs_attention") {
      console.log(`[AutoInject] ${cfg.accountId}/${sessionId.slice(0, 8)}: SKIP (state=${ss.state}, reason=${ss.reason || '-'})`);
      continue;
    }
    if (ss?.state === "idle" && ss?.reason === "rate_limit") {
      console.log(`[AutoInject] ${cfg.accountId}/${sessionId.slice(0, 8)}: SKIP (rate_limit)`);
      continue;
    }

    // No state yet (post-restart) → initialize and wait for next tick
    if (!ss) {
      if (claudeCli.isActive(sessionId)) {
        deps.setSessionState(sessionId, cfg.accountId, "working", undefined, sessionId);
        console.log(`[AutoInject] ${cfg.accountId}/${sessionId.slice(0, 8)}: active process, set working`);
      } else {
        deps.setSessionState(sessionId, cfg.accountId, "idle", "done", sessionId);
        console.log(`[AutoInject] ${cfg.accountId}/${sessionId.slice(0, 8)}: no process, set idle`);
      }
      continue;
    }

    // Idle time check
    const idleMs = Date.now() - ss.since;
    const minIdle = cfg.idleSinceMs || cfg.intervalMs;
    if (idleMs < minIdle) {
      console.log(`[AutoInject] ${cfg.accountId}/${sessionId.slice(0, 8)}: WAITING (idle ${Math.round(idleMs / 1000)}s < ${Math.round(minIdle / 1000)}s)`);
      continue;
    }

    // Interval since last inject
    const lastInject = state.lastInject[sessionId];
    if (lastInject) {
      const sinceLast = Date.now() - new Date(lastInject).getTime();
      if (sinceLast < cfg.intervalMs) continue;
    }

    console.log(`[AutoInject] Injecting into ${cfg.accountId}/${sessionId.slice(0, 8)} (idle ${Math.round(idleMs / 1000)}s): "${cfg.message.slice(0, 50)}..."`);
    try {
      let result: { ok: boolean; sessionId: string; error?: string };
      if (claudeCli.isActive(sessionId)) {
        const piped = claudeCli.sendMessage(sessionId, cfg.message);
        result = piped ? { ok: true, sessionId } : { ok: false, sessionId: '', error: 'stdin pipe failed' };
        if (!piped) {
          console.log(`[AutoInject] stdin pipe failed, respawning ${cfg.accountId}/${sessionId.slice(0, 8)}`);
          unstickConversation(sessionId);
          result = await claudeCli.startConversation(cfg.accountId, cfg.message, cfg.workDir, sessionId);
        }
      } else {
        unstickConversation(sessionId);
        result = await claudeCli.startConversation(cfg.accountId, cfg.message, cfg.workDir, sessionId);
      }

      if (result.ok) {
        // Session migration: if startConversation returned a different sessionId (resume failed)
        if (result.sessionId && result.sessionId !== sessionId) {
          console.log(`[AutoInject] Session changed: ${sessionId.slice(0, 8)} → ${result.sessionId.slice(0, 8)}`);
          state.configs[result.sessionId] = { ...cfg, sessionId: result.sessionId };
          delete state.configs[sessionId];
          state.lastInject[result.sessionId] = new Date().toISOString();
          delete state.lastInject[sessionId];
        } else {
          state.lastInject[sessionId] = new Date().toISOString();
        }
        saveAutoInject(state);
        logUserInput({ type: "auto-inject", accountId: cfg.accountId, workDir: cfg.workDir, message: cfg.message, sessionId: result.sessionId || sessionId, result: "ok" });
        logBackgroundEvent('autoinject', 'inject', `Injected into ${cfg.accountId}/${(result.sessionId || sessionId).slice(0, 8)}`, { accountId: cfg.accountId, sessionId: result.sessionId || sessionId });
        console.log(`[AutoInject] OK: ${cfg.accountId}/${(result.sessionId || sessionId).slice(0, 8)}`);
      } else {
        logBackgroundEvent('autoinject', 'error', `Failed: ${cfg.accountId}/${sessionId.slice(0, 8)}: ${result.error}`, { accountId: cfg.accountId });
        console.log(`[AutoInject] FAIL: ${cfg.accountId}/${sessionId.slice(0, 8)}: ${result.error}`);
        logUserInput({ type: "auto-inject", accountId: cfg.accountId, workDir: cfg.workDir, message: cfg.message, sessionId, result: "error", error: result.error });
        deps.setSessionState(sessionId, cfg.accountId, "idle", "done", sessionId);
      }
    } catch (err) {
      logBackgroundEvent('autoinject', 'error', `Error: ${cfg.accountId}/${sessionId.slice(0, 8)}: ${err}`, { accountId: cfg.accountId });
      console.log(`[AutoInject] ERROR: ${cfg.accountId}/${sessionId.slice(0, 8)}: ${err}`);
      deps.setSessionState(sessionId, cfg.accountId, "idle", "done", sessionId);
    }
  }
}

function startAutoInjectTimer() {
  if (autoInjectTimer) clearInterval(autoInjectTimer);
  autoInjectTimer = setInterval(autoInjectTick, AUTOINJECT_TICK_MS);
  console.log(`[AutoInject] Timer started (${AUTOINJECT_TICK_MS / 1000}s check interval)`);
}

function stopAutoInjectTimer() {
  if (autoInjectTimer) { clearInterval(autoInjectTimer); autoInjectTimer = null; }
}

function logUserInput(entry: { type: string; accountId: string; workDir?: string; subject?: string; message: string; sessionId?: string; result: 'ok' | 'error'; error?: string }) {
  sharedLogUserInput(INPUT_LOG_FILE, entry);
}

export default function createAutoInjectRouter(injectedDeps: AutoInjectDeps): Router {
  deps = injectedDeps;
  AUTOINJECT_FILE = join(deps.DATA_DIR, "auto-inject.json");
  INPUT_LOG_FILE = join(deps.DATA_DIR, 'input-log.jsonl');

  const router = Router();

  // GET all configs
  router.get("/api/auto-inject", (_req: Request, res: Response) => {
    const state = loadAutoInject();
    res.json(state);
  });

  // GET config for specific session
  router.get("/api/auto-inject/session/:sessionId", (req: Request, res: Response) => {
    const state = loadAutoInject();
    const cfg = state.configs[req.params.sessionId];
    res.json({ config: cfg || null, lastInject: state.lastInject[req.params.sessionId] || null });
  });

  // POST create/update config (keyed by sessionId)
  router.post("/api/auto-inject", (req: Request, res: Response) => {
    const { accountId, sessionId, workDir, message, intervalMs, enabled, idleSinceMs } = req.body;
    if (!sessionId) return res.status(400).json({ error: "sessionId is required" });
    if (!accountId) return res.status(400).json({ error: "accountId is required" });

    const state = loadAutoInject();

    // Per-account limit check
    if (!state.configs[sessionId]) {
      const accountLoops = Object.values(state.configs).filter(c => c.accountId === accountId && c.enabled).length;
      if (accountLoops >= MAX_LOOPS_PER_ACCOUNT) {
        return res.status(429).json({ error: `Max ${MAX_LOOPS_PER_ACCOUNT} active loops per account` });
      }
    }

    const existing = state.configs[sessionId];
    state.configs[sessionId] = {
      sessionId,
      accountId,
      workDir: workDir || existing?.workDir || "",
      message: message || existing?.message || DEFAULT_MESSAGE,
      intervalMs: Math.max(typeof intervalMs === 'number' ? intervalMs : (existing?.intervalMs || 300000), MIN_INJECT_INTERVAL_MS),
      enabled: typeof enabled === "boolean" ? enabled : (existing?.enabled ?? true),
      idleSinceMs: typeof idleSinceMs === "number" ? idleSinceMs : (existing?.idleSinceMs || undefined),
    };
    saveAutoInject(state);
    console.log(`[AutoInject] Config set: ${accountId}/${sessionId.slice(0, 8)} enabled=${state.configs[sessionId].enabled} interval=${state.configs[sessionId].intervalMs}ms`);
    res.json({ config: state.configs[sessionId] });
  });

  // DELETE config by sessionId
  router.delete("/api/auto-inject/:sessionId", (req: Request, res: Response) => {
    const sessionId = req.params.sessionId;
    const state = loadAutoInject();
    if (!state.configs[sessionId]) return res.status(404).json({ error: "No config for this session" });
    delete state.configs[sessionId];
    delete state.lastInject[sessionId];
    saveAutoInject(state);
    console.log(`[AutoInject] Config removed: ${sessionId.slice(0, 8)}`);
    res.json({ ok: true });
  });

  return router;
}

export { startAutoInjectTimer, stopAutoInjectTimer, logUserInput, updateAutoInjectSession };
export type { AutoInjectConfig, AutoInjectState };
