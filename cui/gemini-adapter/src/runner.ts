/**
 * Gemini CLI subprocess manager.
 *
 * Spawns `gemini` in headless mode with --output-format stream-json,
 * reads NDJSON from stdout, and emits events through an EventEmitter.
 *
 * Supports session resume via --resume SESSION_ID for multi-turn conversations.
 */

import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { createInterface } from 'readline';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GeminiEvent {
  type: 'init' | 'message' | 'tool_use' | 'tool_result' | 'error' | 'result' | 'closed';
  [key: string]: unknown;
}

export interface ActiveStream {
  streamingId: string;
  geminiSessionId: string | null;   // from Gemini's 'init' event
  process: ChildProcess;
  emitter: EventEmitter;
  startedAt: number;
  completed: boolean;
  lastActivity: number;
}

// ─── State ────────────────────────────────────────────────────────────────────

const activeStreams = new Map<string, ActiveStream>();

// Concurrency guard: one active subprocess per Gemini session
const busySessions = new Set<string>();

const GEMINI_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const CLEANUP_INTERVAL_MS = 60 * 1000;    // 1 minute

// ─── Cleanup stale streams ───────────────────────────────────────────────────

setInterval(() => {
  const now = Date.now();
  for (const [id, stream] of activeStreams) {
    if (stream.completed && now - stream.lastActivity > 5 * 60 * 1000) {
      activeStreams.delete(id);
    }
  }
}, CLEANUP_INTERVAL_MS);

// ─── Public API ───────────────────────────────────────────────────────────────

export function startGemini(opts: {
  workingDirectory: string;
  prompt: string;
  resumeSessionId?: string;
}): { streamingId: string; emitter: EventEmitter } {
  // Concurrency guard
  if (opts.resumeSessionId && busySessions.has(opts.resumeSessionId)) {
    throw new Error(`Session ${opts.resumeSessionId} already has an active request`);
  }

  const streamingId = randomUUID();
  const args = ['-y', '--output-format', 'stream-json'];

  if (opts.resumeSessionId) {
    args.push('--resume', opts.resumeSessionId);
  }

  args.push('-p', opts.prompt);

  console.log(`[Runner] Starting gemini (streamingId=${streamingId.slice(0, 8)}, resume=${opts.resumeSessionId?.slice(0, 8) ?? 'new'})`);

  const child = spawn('gemini', args, {
    cwd: opts.workingDirectory,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // HOME is set at process level (PM2 or manual)
    },
  });

  const emitter = new EventEmitter();
  const stream: ActiveStream = {
    streamingId,
    geminiSessionId: null,
    process: child,
    emitter,
    startedAt: Date.now(),
    completed: false,
    lastActivity: Date.now(),
  };

  activeStreams.set(streamingId, stream);

  if (opts.resumeSessionId) {
    busySessions.add(opts.resumeSessionId);
  }

  // ─── Parse NDJSON from stdout ──────────────────────────────────────────

  const rl = createInterface({ input: child.stdout! });
  rl.on('line', (line) => {
    stream.lastActivity = Date.now();
    const trimmed = line.trim();
    if (!trimmed) return;

    try {
      const event: GeminiEvent = JSON.parse(trimmed);

      // Capture session ID from init event (Gemini uses session_id with underscore)
      const sid = (event.session_id ?? event.sessionId) as string | undefined;
      if (event.type === 'init' && sid) {
        stream.geminiSessionId = sid;
        console.log(`[Runner] ${streamingId.slice(0, 8)}: Gemini session=${sid.slice(0, 8)}, model=${event.model ?? 'unknown'}`);
      }

      emitter.emit('event', event);
    } catch {
      // Non-JSON line (e.g. spinner text) — log but don't crash
      console.warn(`[Runner] ${streamingId.slice(0, 8)}: Non-JSON stdout: ${trimmed.slice(0, 100)}`);
    }
  });

  // ─── Capture stderr for debugging ──────────────────────────────────────

  const stderrChunks: string[] = [];
  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    stderrChunks.push(text);
    // Only log warnings/errors
    if (text.includes('Error') || text.includes('error') || text.includes('WARN')) {
      console.warn(`[Runner] ${streamingId.slice(0, 8)} stderr: ${text.trim().slice(0, 200)}`);
    }
  });

  // ─── Process exit ──────────────────────────────────────────────────────

  child.on('exit', (code, signal) => {
    stream.completed = true;
    stream.lastActivity = Date.now();

    if (opts.resumeSessionId) {
      busySessions.delete(opts.resumeSessionId);
    }
    if (stream.geminiSessionId) {
      busySessions.delete(stream.geminiSessionId);
    }

    console.log(`[Runner] ${streamingId.slice(0, 8)}: exited code=${code} signal=${signal}`);

    if (code !== 0 && code !== null) {
      const stderr = stderrChunks.join('').slice(-500);
      emitter.emit('event', {
        type: 'error',
        message: `Gemini CLI exited with code ${code}${stderr ? ': ' + stderr : ''}`,
      } as GeminiEvent);
    }

    // Emit stream-end marker — this is what CUI server's detectAttentionMarkers() needs
    emitter.emit('event', { type: 'closed' } as GeminiEvent);
    emitter.emit('exit', code);
  });

  child.on('error', (err) => {
    stream.completed = true;
    stream.lastActivity = Date.now();

    if (opts.resumeSessionId) {
      busySessions.delete(opts.resumeSessionId);
    }

    console.error(`[Runner] ${streamingId.slice(0, 8)}: spawn error: ${err.message}`);
    emitter.emit('event', {
      type: 'error',
      message: `Failed to spawn gemini: ${err.message}`,
    } as GeminiEvent);
    emitter.emit('event', { type: 'closed' } as GeminiEvent);
    emitter.emit('error', err);
  });

  // ─── Safety timeout ────────────────────────────────────────────────────

  setTimeout(() => {
    if (!stream.completed) {
      console.warn(`[Runner] ${streamingId.slice(0, 8)}: timeout after ${GEMINI_TIMEOUT_MS / 1000}s — killing`);
      child.kill('SIGTERM');
      // SIGTERM handler above will emit 'closed'
    }
  }, GEMINI_TIMEOUT_MS);

  return { streamingId, emitter };
}

export function stopStream(streamingId: string): boolean {
  const stream = activeStreams.get(streamingId);
  if (!stream || stream.completed) return false;

  console.log(`[Runner] Stopping stream ${streamingId.slice(0, 8)}`);
  stream.process.kill('SIGTERM');
  return true;
}

export function getStream(streamingId: string): ActiveStream | undefined {
  return activeStreams.get(streamingId);
}

export function getActiveStreamCount(): number {
  let count = 0;
  for (const s of activeStreams.values()) {
    if (!s.completed) count++;
  }
  return count;
}
