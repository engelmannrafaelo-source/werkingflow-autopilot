// CUI WebSocket / panel lifecycle telemetry.
//
// Events are written to two places:
//  1. window.__cuiTelemetry — in-memory ringbuffer (last 500), available in DevTools
//     for ad-hoc inspection: copy(JSON.stringify(window.__cuiTelemetry, null, 2))
//  2. POST /api/telemetry/cui-ws — server appends to <DATA_DIR>/cui-ws-telemetry.jsonl
//     so we (the assistant) can read it from disk without asking the user to dump
//     the buffer manually.
//
// The flusher runs once per page (single setInterval started lazily on first log).

export interface TelEvent {
  ts: number;
  kind: string;
  [key: string]: unknown;
}

interface TelGlobal {
  __cuiTelemetry?: TelEvent[];
  __cuiTelemetryQueue?: TelEvent[];
  __cuiTelemetryFlusherStarted?: boolean;
}

const tel = window as unknown as TelGlobal;

const RINGBUFFER_CAP = 500;
const FLUSH_INTERVAL_MS = 3000;
const MAX_BATCH = 200;

export function logCuiTelemetry(event: TelEvent): void {
  if (!tel.__cuiTelemetry) tel.__cuiTelemetry = [];
  if (!tel.__cuiTelemetryQueue) tel.__cuiTelemetryQueue = [];

  tel.__cuiTelemetry.push(event);
  tel.__cuiTelemetryQueue.push(event);

  if (tel.__cuiTelemetry.length > RINGBUFFER_CAP) {
    tel.__cuiTelemetry.splice(0, tel.__cuiTelemetry.length - RINGBUFFER_CAP);
  }
  startFlusherIfNeeded();
}

function startFlusherIfNeeded(): void {
  if (tel.__cuiTelemetryFlusherStarted) return;
  tel.__cuiTelemetryFlusherStarted = true;

  setInterval(() => { void flush(); }, FLUSH_INTERVAL_MS);

  window.addEventListener('beforeunload', () => {
    const q = tel.__cuiTelemetryQueue;
    if (!q || q.length === 0) return;
    try {
      const batch = q.splice(0);
      navigator.sendBeacon(
        '/api/mission/telemetry/cui-ws',
        new Blob([JSON.stringify({ events: batch })], { type: 'application/json' })
      );
    } catch { /* ignore — best effort on unload */ }
  });
}

async function flush(): Promise<void> {
  const q = tel.__cuiTelemetryQueue;
  if (!q || q.length === 0) return;
  const batch = q.splice(0, MAX_BATCH);
  try {
    const res = await fetch('/api/mission/telemetry/cui-ws', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: batch }),
      // keepalive helps if a flush races with navigation
      keepalive: true,
    });
    if (!res.ok) {
      // Server failure → requeue at front so we retry next cycle.
      q.unshift(...batch);
    }
  } catch {
    q.unshift(...batch);
  }
}
