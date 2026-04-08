/**
 * Gemini CUI Adapter — Express server exposing Claude Code-compatible HTTP API.
 *
 * Port: 4010 (proxied by CUI server on 5005)
 *
 * Endpoints mirror Claude Code binary API so the CUI dashboard treats
 * Gemini as just another account — no special-casing needed.
 */

import express from 'express';
import { execSync } from 'child_process';

import { startGemini, stopStream, getStream, getActiveStreamCount, type GeminiEvent } from './runner.js';
import { geminiEventToClaude, geminiEventToSSE, getCurrentModel } from './translator.js';
import {
  createSession,
  updateSession,
  getSession,
  listSessions,
  appendMessage,
  appendUserPrompt,
  getMessages,
  sessionToConversationEntry,
} from './session-store.js';

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '4010', 10);
const DEFAULT_WORK_DIR = process.env.DEFAULT_WORK_DIR || '/root/projekte';

// ─── Preflight: verify gemini CLI is available ────────────────────────────────

try {
  const version = execSync('gemini --version 2>/dev/null || echo "not found"', { encoding: 'utf-8' }).trim();
  console.log(`[Adapter] Gemini CLI version: ${version}`);
  if (version === 'not found') {
    throw new Error('Gemini CLI not installed. Install: npm install -g @google/gemini-cli');
  }
} catch (err) {
  console.error(`[Adapter] FATAL: Gemini CLI check failed: ${err}`);
  process.exit(1);
}

// ─── Express App ──────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// CORS headers (CUI proxy adds its own, but direct access may need these)
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// ─── Map: streamingId → sessionId (for linking streams to sessions) ───────────

const streamToSession = new Map<string, string>();

// ─── POST /api/conversations/start ────────────────────────────────────────────
// Start a new conversation or resume an existing one.
// Request: { workingDirectory, initialPrompt, resumedSessionId? }
// Response: { sessionId, streamingId, status }

app.post('/api/conversations/start', (req, res) => {
  try {
    const { workingDirectory, initialPrompt, resumedSessionId } = req.body;

    if (!initialPrompt || typeof initialPrompt !== 'string') {
      res.status(400).json({ error: 'initialPrompt is required' });
      return;
    }

    const workDir = workingDirectory || DEFAULT_WORK_DIR;

    // If resuming, find the Gemini session ID
    let geminiResumeId: string | undefined;
    if (resumedSessionId) {
      const existing = getSession(resumedSessionId);
      if (existing?.geminiSessionId) {
        geminiResumeId = existing.geminiSessionId;
      }
    }

    // Start Gemini subprocess
    const { streamingId, emitter } = startGemini({
      workingDirectory: workDir,
      prompt: initialPrompt,
      resumeSessionId: geminiResumeId,
    });

    // Use existing session ID or create new one
    const sessionId = resumedSessionId || streamingId; // Use streamingId as sessionId for new conversations

    if (!resumedSessionId) {
      createSession({
        sessionId,
        workingDirectory: workDir,
        model: getCurrentModel(),
        initialPrompt,
      });
    }

    // Store the user prompt
    appendUserPrompt(sessionId, initialPrompt);

    // Link streaming ID to session
    streamToSession.set(streamingId, sessionId);

    // Wire up event handling: translate and store messages
    wireStreamEvents(emitter, sessionId, streamingId);

    res.json({
      sessionId,
      streamingId,
      status: 'ongoing',
      model: getCurrentModel(),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Adapter] /start error: ${msg}`);

    if (msg.includes('already has an active request')) {
      res.status(429).json({ error: msg, busy: true });
      return;
    }
    res.status(500).json({ error: msg });
  }
});

// ─── POST /api/conversations/:sessionId/messages ──────────────────────────────
// Send a follow-up message to an existing conversation.
// Request: { message }
// Response: { sessionId, streamingId }

app.post('/api/conversations/:sessionId/messages', (req, res) => {
  try {
    const { sessionId } = req.params;
    const { message } = req.body;

    if (!message || typeof message !== 'string') {
      res.status(400).json({ error: 'message is required' });
      return;
    }

    const session = getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: `Session ${sessionId} not found` });
      return;
    }

    if (!session.geminiSessionId) {
      res.status(400).json({ error: `Session ${sessionId} has no Gemini session ID (conversation may still be initializing)` });
      return;
    }

    // Start Gemini with --resume
    const { streamingId, emitter } = startGemini({
      workingDirectory: session.workingDirectory,
      prompt: message,
      resumeSessionId: session.geminiSessionId,
    });

    // Store user prompt
    appendUserPrompt(sessionId, message);

    // Link and wire
    streamToSession.set(streamingId, sessionId);
    wireStreamEvents(emitter, sessionId, streamingId);

    res.json({
      sessionId,
      streamingId,
      status: 'ongoing',
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Adapter] /messages error: ${msg}`);

    if (msg.includes('already has an active request')) {
      res.status(429).json({ error: msg, busy: true });
      return;
    }
    res.status(500).json({ error: msg });
  }
});

// ─── GET /api/stream/:streamingId ─────────────────────────────────────────────
// SSE endpoint — streams Gemini events in real-time.
// CUI server's monitorStream() connects here and scans for attention markers.

app.get('/api/stream/:streamingId', (req, res) => {
  const { streamingId } = req.params;
  const stream = getStream(streamingId);

  if (!stream) {
    // Stream not found or already completed — return 204 (no content)
    // This prevents the CUI proxy's SSE reconnect loop
    res.status(204).end();
    return;
  }

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // If stream already completed, send closed marker and end
  if (stream.completed) {
    res.write(geminiEventToSSE({ type: 'closed' } as GeminiEvent));
    res.end();
    return;
  }

  // Pipe events as SSE
  const onEvent = (event: GeminiEvent) => {
    try {
      res.write(geminiEventToSSE(event));
    } catch {
      // Client disconnected
    }
  };

  const onExit = () => {
    try { res.end(); } catch { /* already closed */ }
  };

  stream.emitter.on('event', onEvent);
  stream.emitter.once('exit', onExit);

  // Heartbeat every 30s to keep connection alive
  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch { clearInterval(heartbeat); }
  }, 30_000);

  // Cleanup on client disconnect
  req.on('close', () => {
    clearInterval(heartbeat);
    stream.emitter.off('event', onEvent);
    stream.emitter.off('exit', onExit);
  });
});

// ─── GET /api/conversations ───────────────────────────────────────────────────
// List all conversations (with pagination).
// Query: ?limit=500&sortBy=updated&order=desc

app.get('/api/conversations', (_req, res) => {
  const limit = parseInt(_req.query.limit as string) || 500;
  const sortBy = (_req.query.sortBy as 'updated' | 'created') || 'updated';
  const order = (_req.query.order as 'asc' | 'desc') || 'desc';

  const { conversations, total } = listSessions({ limit, sortBy, order });

  res.json({
    conversations: conversations.map(s => sessionToConversationEntry(s)),
    total,
  });
});

// ─── GET /api/conversations/:sessionId ────────────────────────────────────────
// Get conversation detail with messages.

app.get('/api/conversations/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = getSession(sessionId);

  if (!session) {
    res.status(404).json({ error: `Session ${sessionId} not found` });
    return;
  }

  const messages = getMessages(sessionId, { tail: 500 });

  // Map to CUI-expected format
  const formattedMessages = messages.map(m => ({
    role: m.message.role,
    content: m.message.content,
    timestamp: m.timestamp,
    model: m.message.model,
    isApiErrorMessage: m.isApiErrorMessage,
    error: m.error,
  }));

  res.json({
    messages: formattedMessages,
    summary: session.summary,
    metadata: {
      status: session.status,
      streamingId: null,
    },
    status: session.status,
    projectPath: session.workingDirectory,
    permissions: [],  // Gemini in YOLO mode — no permissions needed
    totalMessages: messages.length,
    isAgentDone: session.status === 'completed',
    rateLimited: false,
    apiError: false,
  });
});

// ─── POST /api/conversations/:streamingId/stop ────────────────────────────────
// Stop a running Gemini subprocess.

app.post('/api/conversations/:streamingId/stop', (req, res) => {
  const { streamingId } = req.params;
  const stopped = stopStream(streamingId);
  res.json({ ok: stopped, stopped });
});

// ─── GET /api/health ──────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    provider: 'gemini',
    model: getCurrentModel(),
    activeStreams: getActiveStreamCount(),
    uptime: process.uptime(),
  });
});

// ─── Helper: Wire stream events to session store ──────────────────────────────

function wireStreamEvents(emitter: import('events').EventEmitter, sessionId: string, streamingId: string): void {
  // Collect all assistant content for this invocation to avoid duplicate storage
  // (Gemini may emit multiple 'message' events that are just chunks of one response)
  let assistantBuffer = '';
  let lastToolUseId: string | null = null;

  emitter.on('event', (event: GeminiEvent) => {
    // Update Gemini session ID when init arrives (Gemini uses session_id with underscore)
    const sid = (event.session_id ?? event.sessionId) as string | undefined;
    if (event.type === 'init' && sid) {
      updateSession(sessionId, { geminiSessionId: sid });
    }

    // Translate and store
    const claudeMsg = geminiEventToClaude(event);
    if (claudeMsg) {
      // Buffer assistant text delta chunks to combine into one message
      if (event.type === 'message' && claudeMsg.message.role === 'assistant') {
        const textBlock = claudeMsg.message.content[0];
        if (textBlock && textBlock.type === 'text') {
          assistantBuffer += textBlock.text;
        }
        return; // Don't store individual chunks
      }

      // Tool use/result events — store immediately
      if (event.type === 'tool_use') {
        flushAssistantBuffer();
        const toolBlock = claudeMsg.message.content[0];
        if (toolBlock && toolBlock.type === 'tool_use') {
          lastToolUseId = toolBlock.id;
        }
      }

      if (event.type === 'tool_result') {
        if (lastToolUseId) {
          const resultBlock = claudeMsg.message.content[0];
          if (resultBlock && resultBlock.type === 'tool_result' && !resultBlock.tool_use_id) {
            resultBlock.tool_use_id = lastToolUseId;
          }
          lastToolUseId = null;
        }
      }

      appendMessage(sessionId, claudeMsg);
    }

    // On 'result' event (final stats), just flush the assistant buffer
    // Gemini v0.32.1 result event has stats only, no response text
    if (event.type === 'result') {
      flushAssistantBuffer();
    }

    // Error events
    if (event.type === 'error' && claudeMsg) {
      flushAssistantBuffer();
      appendMessage(sessionId, claudeMsg);
    }
  });

  // On stream end, flush remaining buffer and mark session completed
  emitter.once('exit', () => {
    flushAssistantBuffer();
    updateSession(sessionId, { status: 'completed' });
    // Cleanup link after 5 minutes
    setTimeout(() => streamToSession.delete(streamingId), 5 * 60 * 1000);
  });

  function flushAssistantBuffer(): void {
    if (!assistantBuffer) return;
    appendMessage(sessionId, {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: assistantBuffer }],
        model: getCurrentModel(),
      },
      timestamp: new Date().toISOString(),
    });
    assistantBuffer = '';
  }
}

// ─── Start Server ─────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Adapter] Gemini CUI Adapter listening on 0.0.0.0:${PORT}`);
  console.log(`[Adapter] Model: ${getCurrentModel()}`);
  console.log(`[Adapter] Default workdir: ${DEFAULT_WORK_DIR}`);
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────

process.on('SIGTERM', () => {
  console.log('[Adapter] SIGTERM received — shutting down');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[Adapter] SIGINT received — shutting down');
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  console.error('[Adapter] Uncaught exception:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('[Adapter] Unhandled rejection:', err);
});
