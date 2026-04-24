/**
 * SessionStore — Single WebSocket connection for the entire CUI app.
 *
 * Replaces 3+ separate WebSocket connections (App, LayoutManager, CuiLitePanel)
 * with one shared connection. Components subscribe to messages via addMessageHandler.
 *
 * Provides centralized state:
 * - cuiStates: per-account CUI state (idle/processing/done)
 * - sessionStates: per-session attention state (idle/working/needs_attention + reason)
 * - serverAlive: connection health
 */

import { createContext, useContext, useEffect, useRef, useState, useCallback, type ReactNode } from 'react';
import type { CuiStates } from '../types';

interface ToolInfo {
  toolName: string;
  toolDetail?: string;
  startedAt: number;
  elapsedMs?: number;
}

interface SessionStateEntry {
  state: 'idle' | 'working' | 'needs_attention';
  reason?: string;
  toolInfo?: ToolInfo;
  /** Timestamp (ms) when this state was last set/confirmed via WS */
  since?: number;
}

interface SessionStoreValue {
  cuiStates: CuiStates;
  sessionStates: Map<string, SessionStateEntry>;
  /** Increments on every sessionStates Map mutation — use as useEffect dependency */
  sessionStatesTick: number;
  serverAlive: boolean;
  /** Send a JSON message over the shared WebSocket */
  sendWs: (msg: Record<string, unknown>) => void;
  /** Subscribe to raw WS messages. Returns unsubscribe function. */
  addMessageHandler: (handler: (msg: any) => void) => () => void;
}

const SessionStoreContext = createContext<SessionStoreValue | null>(null);

export function useSessionStore(): SessionStoreValue {
  const ctx = useContext(SessionStoreContext);
  if (!ctx) throw new Error('useSessionStore must be used within SessionStoreProvider');
  return ctx;
}

/** Convenience: get cuiStates only */
function useCuiStates(): CuiStates {
  return useSessionStore().cuiStates;
}

/** Convenience: get a single session's state */
function useSessionState(sessionId: string | null): SessionStateEntry | undefined {
  const { sessionStates } = useSessionStore();
  return sessionId ? sessionStates.get(sessionId) : undefined;
}

export function SessionStoreProvider({ children }: { children: ReactNode }) {
  const wsRef = useRef<WebSocket | null>(null);
  const [serverAlive, setServerAlive] = useState(false);
  const [cuiStates, setCuiStates] = useState<CuiStates>({});
  const sessionStatesRef = useRef(new Map<string, SessionStateEntry>());
  // Trigger re-render when sessionStates change (consumers read from ref via context)
  const [sessionStatesTick, setSessionStatesTick] = useState(0);
  const handlersRef = useRef(new Set<(msg: any) => void>());

  const addMessageHandler = useCallback((handler: (msg: any) => void) => {
    handlersRef.current.add(handler);
    return () => { handlersRef.current.delete(handler); };
  }, []);

  const sendWs = useCallback((msg: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let backoff = 1000;

    const connect = () => {
      if (disposed) return;
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${protocol}://${window.location.host}/ws`);
      ws.onerror = () => {};

      ws.onopen = () => {
        const wasDown = !serverAlive && (window as any).__cuiServerAlive === false;
        (window as any).__cuiServerAlive = true;
        setServerAlive(true);
        backoff = 1000;
        console.log('[SessionStore] WS connected');
        if (wasDown) window.dispatchEvent(new CustomEvent('cui-reconnected'));

        // Pre-populate session states from server on connect
        fetch('/api/mission/conversations', { signal: AbortSignal.timeout(5000) })
          .then(r => r.json())
          .then(data => {
            const convs = Array.isArray(data) ? data : data?.conversations || [];
            let changed = false;
            for (const c of convs) {
              if (!c.sessionId || c.status !== 'ongoing') continue;
              if (!sessionStatesRef.current.has(c.sessionId)) {
                const state = c.attentionState || 'idle';
                const reason = c.attentionReason;
                sessionStatesRef.current.set(c.sessionId, { state: state as any, reason, since: Date.now() });
                changed = true;
              }
            }
            if (changed) setSessionStatesTick(t => t + 1);
          })
          .catch(() => {}); // silent-ok: initial session state fetch is non-critical; WS events populate state
      };

      ws.onclose = () => {
        (window as any).__cuiServerAlive = false;
        setServerAlive(false);
        wsRef.current = null;
        if (!disposed) {
          if (backoff <= 1000) console.log('[SessionStore] WS disconnected, reconnecting...');
          reconnectTimer = setTimeout(() => {
            backoff = Math.min(backoff * 2, 10000);
            connect();
          }, backoff);
        }
      };

      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);

          // Centralized state tracking
          if (msg.type === 'cui-state' && msg.cuiId && msg.state) {
            setCuiStates(prev => prev[msg.cuiId] === msg.state ? prev : { ...prev, [msg.cuiId]: msg.state });
            // Also track sessionStates from cui-state
            if (msg.sessionId) {
              const mapped = msg.state === 'processing' ? 'working' : msg.state === 'done' ? 'idle' : msg.state;
              const prev = sessionStatesRef.current.get(msg.sessionId);
              if (!prev || prev.state !== mapped) {
                sessionStatesRef.current.set(msg.sessionId, { state: mapped as any, reason: prev?.reason, since: Date.now() });
                setSessionStatesTick(t => t + 1);
              }
            }
          }

          if (msg.type === 'conv-attention' && msg.sessionId) {
            const prev = sessionStatesRef.current.get(msg.sessionId);
            const newState = msg.state || 'idle';
            const newReason = msg.reason;
            const newToolInfo = msg.toolInfo || undefined;
            if (!prev || prev.state !== newState || prev.reason !== newReason || prev.toolInfo?.toolName !== newToolInfo?.toolName) {
              sessionStatesRef.current.set(msg.sessionId, { state: newState, reason: newReason, toolInfo: newToolInfo, since: Date.now() });
              setSessionStatesTick(t => t + 1);
            }
          }

          // Tool execution tracking
          if (msg.type === 'tool-executing' && msg.sessionId) {
            const prev = sessionStatesRef.current.get(msg.sessionId);
            sessionStatesRef.current.set(msg.sessionId, {
              state: prev?.state || 'working',
              reason: prev?.reason,
              toolInfo: { toolName: msg.toolName, toolDetail: msg.toolDetail, startedAt: msg.startedAt },
              since: Date.now(),
            });
            setSessionStatesTick(t => t + 1);
          }
          if (msg.type === 'tool-done' && msg.sessionId) {
            const prev = sessionStatesRef.current.get(msg.sessionId);
            if (prev?.toolInfo) {
              sessionStatesRef.current.set(msg.sessionId, { state: prev.state, reason: prev.reason, since: Date.now() });
              setSessionStatesTick(t => t + 1);
            }
          }
          if (msg.type === 'tool-heartbeat' && msg.sessionId) {
            const prev = sessionStatesRef.current.get(msg.sessionId);
            if (prev) {
              sessionStatesRef.current.set(msg.sessionId, {
                ...prev,
                toolInfo: { toolName: msg.toolName, toolDetail: msg.toolDetail, startedAt: prev.toolInfo?.startedAt || Date.now(), elapsedMs: msg.elapsedMs },
                since: Date.now(),
              });
              setSessionStatesTick(t => t + 1);
            }
          }

          // Bulk session state init (sent on WS connect for state recovery)
          if (msg.type === "session-states-init" && msg.states) {
            const states = msg.states as Record<string, { state: string; reason?: string; sessionId?: string }>;
            let changed = false;
            for (const [key, val] of Object.entries(states)) {
              const sid = val.sessionId || key;
              const prev = sessionStatesRef.current.get(sid);
              if (!prev || prev.state !== val.state || prev.reason !== val.reason) {
                sessionStatesRef.current.set(sid, { state: val.state as any, reason: val.reason as any, since: Date.now() });
                changed = true;
              }
            }
            if (changed) setSessionStatesTick(t => t + 1);
          }

          // Dispatch to all subscribers
          for (const handler of handlersRef.current) {
            try { handler(msg); } catch (err) {
              console.warn('[SessionStore] Handler error:', err);
            }
          }
        } catch (err) {
          console.warn('[SessionStore] WS parse error:', err);
        }
      };

      wsRef.current = ws;
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Context value — changes when cuiStates or sessionStatesTick changes
  const value: SessionStoreValue = {
    cuiStates,
    sessionStates: sessionStatesRef.current,
    sessionStatesTick,
    serverAlive,
    sendWs,
    addMessageHandler,
  };

  return (
    <SessionStoreContext.Provider value={value}>
      {children}
    </SessionStoreContext.Provider>
  );
}
