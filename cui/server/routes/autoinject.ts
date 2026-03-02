import { Router, Request, Response } from 'express';
import { readFileSync, existsSync, writeFileSync, appendFileSync } from 'fs';
import { join } from 'path';

// --- Type Definitions ---
type AttentionReason = 'plan' | 'question' | 'permission' | 'error' | 'done' | 'rate_limit' | 'send_failed';
type ConvAttentionState = 'working' | 'needs_attention' | 'idle';

interface SessionState {
  state: ConvAttentionState;
  reason?: AttentionReason;
  since: number;
  accountId: string;
  sessionId?: string;
}

interface AutoInjectConfig {
  accountId: string;
  sessionId: string;
  workDir: string;
  message: string;
  intervalMs: number;
  enabled: boolean;
  idleSinceMs?: number;
}

interface AutoInjectState {
  configs: Record<string, AutoInjectConfig>;
  lastInject: Record<string, string>;
}

interface CuiProxy {
  id: string;
  localPort: number;
  target: string;
}

// Dependencies injected via factory
interface AutoInjectDeps {
  cuiFetch: (proxyPort: number, path: string, options?: { method?: string; body?: string; timeoutMs?: number }) => Promise<{ data: any; ok: boolean; status: number; error?: string }>;
  sessionStates: Map<string, SessionState>;
  setSessionState: (key: string, accountId: string, state: ConvAttentionState, reason?: AttentionReason, sessionId?: string) => void;
  broadcast: (data: Record<string, unknown>) => void;
  CUI_PROXIES: CuiProxy[];
  DATA_DIR: string;
  activeStreams: Map<string, string>;
  monitorStream: (targetBase: string, streamingId: string, cuiId: string, authHeaders: Record<string, string>) => Promise<'ended' | 'error' | 'timeout'>;
  unstickConversation: (sessionId: string) => number;
}

// Module-level state (initialized by init())
let AUTOINJECT_FILE: string;
let INPUT_LOG_FILE: string;
let autoInjectTimer: ReturnType<typeof setInterval> | null = null;
let deps: AutoInjectDeps;

function getProxyPort(accountId: string): number | null {
  const proxy = deps.CUI_PROXIES.find(p => p.id === accountId);
  return proxy?.localPort ?? null;
}

function loadAutoInject(): AutoInjectState {
  if (!existsSync(AUTOINJECT_FILE)) return { configs: {}, lastInject: {} };
  try { return JSON.parse(readFileSync(AUTOINJECT_FILE, "utf8")); } catch { return { configs: {}, lastInject: {} }; }
}

function saveAutoInject(state: AutoInjectState) {
  writeFileSync(AUTOINJECT_FILE, JSON.stringify(state, null, 2));
}

async function autoInjectTick() {
  const state = loadAutoInject();
  for (const [accountId, cfg] of Object.entries(state.configs)) {
    if (!cfg.enabled) continue;
    const port = getProxyPort(accountId);
    if (!port) { console.log(`[AutoInject] No port for ${accountId}`); continue; }

    const ss = deps.sessionStates.get(accountId);

    // Skip if explicitly busy or needs attention
    if (ss?.state === "working" || ss?.state === "needs_attention") continue;
    // Skip if idle due to rate limit
    if (ss?.state === "idle" && ss?.reason === "rate_limit") continue;

    // If no session state (e.g. after server restart), probe the CUI binary
    if (!ss) {
      try {
        const probe = await deps.cuiFetch(port, "/api/conversations?limit=1", { timeoutMs: 5000 });
        if (!probe.ok) {
          console.log(`[AutoInject] ${accountId}: binary not responsive (${probe.status}), skipping`);
          continue;
        }
        // Check if there is an active streaming conversation
        const convs = probe.data?.conversations || [];
        const hasActive = convs.some((c: any) => c.streamingId && !c.isCompleted);
        if (hasActive) {
          console.log(`[AutoInject] ${accountId}: binary has active stream, initializing as working`);
          deps.setSessionState(accountId, accountId, "working", undefined, cfg.sessionId);
          continue;
        }
        // Binary is responsive and idle — initialize state
        deps.setSessionState(accountId, accountId, "idle", "done", cfg.sessionId);
        console.log(`[AutoInject] ${accountId}: no state (post-restart), binary idle -> initialized`);
        // Will be picked up on next tick (now ss exists)
        continue;
      } catch (err) {
        console.log(`[AutoInject] ${accountId}: probe error: ${err}`);
        continue;
      }
    }

    // Calculate effective idle time
    const idleMs = Date.now() - ss.since;
    const minIdle = cfg.idleSinceMs || cfg.intervalMs;
    if (idleMs < minIdle) continue;

    // Check interval since last inject
    const lastInject = state.lastInject[accountId];
    if (lastInject) {
      const sinceLast = Date.now() - new Date(lastInject).getTime();
      if (sinceLast < cfg.intervalMs) continue;
    }

    console.log(`[AutoInject] Injecting into ${accountId} (idle for ${Math.round(idleMs/1000)}s): "${cfg.message.slice(0, 50)}..."`);
    try {
      deps.unstickConversation(cfg.sessionId);
      const resp = await deps.cuiFetch(port, "/api/conversations/start", {
        method: "POST",
        timeoutMs: 60000,
        body: JSON.stringify({
          workingDirectory: cfg.workDir,
          initialPrompt: cfg.message,
          resumedSessionId: cfg.sessionId,
        }),
      });
      if (resp.ok) {
        state.lastInject[accountId] = new Date().toISOString();
        saveAutoInject(state);
        deps.setSessionState(accountId, accountId, "working", undefined, cfg.sessionId);
        deps.broadcast({ type: "cui-state", cuiId: accountId, state: "processing" });
        const sendResult = resp.data;
        if (sendResult?.streamingId) {
          // Track session->stream mapping for stop handler
          deps.activeStreams.set(cfg.sessionId, sendResult.streamingId);
          deps.monitorStream(`http://localhost:${port}`, sendResult.streamingId, accountId, {});
        }
        logUserInput({ type: "auto-inject", accountId, workDir: cfg.workDir, message: cfg.message, sessionId: cfg.sessionId, result: "ok" });
        console.log(`[AutoInject] Successfully injected into ${accountId}`);
      } else {
        console.log(`[AutoInject] Failed for ${accountId}: ${resp.error}`);
        logUserInput({ type: "auto-inject", accountId, workDir: cfg.workDir, message: cfg.message, sessionId: cfg.sessionId, result: "error", error: resp.error });
        // If start failed, set idle so we can retry next tick
        deps.setSessionState(accountId, accountId, "idle", "done", cfg.sessionId);
      }
    } catch (err) {
      console.log(`[AutoInject] Error for ${accountId}: ${err}`);
      // On error, set idle so we can retry
      deps.setSessionState(accountId, accountId, "idle", "done", cfg.sessionId);
    }
  }
}

function startAutoInjectTimer() {
  if (autoInjectTimer) clearInterval(autoInjectTimer);
  autoInjectTimer = setInterval(autoInjectTick, 30_000);
  console.log("[AutoInject] Timer started (30s check interval)");
}

// --- User Input Log ---
// Persistent log of all user inputs (subject + message) from Queue/Commander
function logUserInput(entry: { type: string; accountId: string; workDir?: string; subject?: string; message: string; sessionId?: string; result: 'ok' | 'error'; error?: string }) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  try { appendFileSync(INPUT_LOG_FILE, line + '\n'); } catch { /* ignore write errors */ }
}

export default function createAutoInjectRouter(injectedDeps: AutoInjectDeps): Router {
  deps = injectedDeps;
  AUTOINJECT_FILE = join(deps.DATA_DIR, "auto-inject.json");
  INPUT_LOG_FILE = join(deps.DATA_DIR, 'input-log.jsonl');

  const router = Router();

  // --- Auto-Inject API ---
  router.get("/api/auto-inject", (_req: Request, res: Response) => {
    const state = loadAutoInject();
    res.json(state);
  });

  router.post("/api/auto-inject", (req: Request, res: Response) => {
    const { accountId, sessionId, workDir, message, intervalMs, enabled, idleSinceMs } = req.body;
    if (!accountId) return res.status(400).json({ error: "accountId is required" });
    const state = loadAutoInject();
    const existing = state.configs[accountId];
    state.configs[accountId] = {
      accountId,
      sessionId: sessionId || existing?.sessionId || "",
      workDir: workDir || existing?.workDir || "",
      message: message || existing?.message || "Schau dir die aktuellen Test-Logs an und entscheide selbst: Wenn Probleme sichtbar sind, behebe sie (defensive coding, fail fast) und committe. Wenn Tests noch laufen oder alles passt, sage kurz Bescheid und warte.",
      intervalMs: typeof intervalMs === "number" ? intervalMs : (existing?.intervalMs || 300000),
      enabled: typeof enabled === "boolean" ? enabled : (existing?.enabled ?? true),
      idleSinceMs: typeof idleSinceMs === "number" ? idleSinceMs : (existing?.idleSinceMs || undefined),
    };
    saveAutoInject(state);
    console.log(`[AutoInject] Config updated for ${accountId}: enabled=${state.configs[accountId].enabled}, interval=${state.configs[accountId].intervalMs}ms`);
    res.json({ config: state.configs[accountId] });
  });

  router.delete("/api/auto-inject/:accountId", (req: Request, res: Response) => {
    const state = loadAutoInject();
    if (!state.configs[req.params.accountId]) return res.status(404).json({ error: "No config for this account" });
    delete state.configs[req.params.accountId];
    delete state.lastInject[req.params.accountId];
    saveAutoInject(state);
    console.log(`[AutoInject] Config removed for ${req.params.accountId}`);
    res.json({ ok: true });
  });

  return router;
}

export { startAutoInjectTimer, logUserInput };
export type { AutoInjectConfig, AutoInjectState };
