/**
 * Error Monitor Routes
 *
 * Empfängt Error-Events von Production Apps (via Sentry Webhooks oder direkt
 * vom Shared Error-Reporter Package). Speichert in JSONL, gruppiert nach
 * Fingerprint, streamt Live-Updates via SSE ans CUI Panel.
 *
 * Endpoints:
 *   POST /api/errors/sentry-webhook   — Sentry Issue Alert Webhook
 *   POST /api/errors/report           — Direct Error Report (Fallback)
 *   GET  /api/errors                  — Liste (gruppiert, filterbar)
 *   GET  /api/errors/stream           — SSE Live Feed
 *   GET  /api/errors/:id              — Details
 *   PATCH /api/errors/:id             — resolve/unresolve/notes
 *   POST /api/errors/:id/spawn-fix    — Sub-Session spawnen mit Error-Context
 *   DELETE /api/errors/:id            — Löschen
 */
import { Router, Request, Response } from 'express';
import {
  appendFileSync, readFileSync, existsSync, mkdirSync, writeFileSync, renameSync,
} from 'fs';
import { join, dirname } from 'path';
import { createHash } from 'crypto';
import { PATHS } from '../config/paths.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type ErrorLevel = 'info' | 'warning' | 'error' | 'fatal';

export interface ErrorBreadcrumb {
  timestamp: string;
  category: string;
  message?: string;
  level?: ErrorLevel;
  data?: Record<string, unknown>;
}

export interface ErrorEvent {
  id: string;
  fingerprint: string;

  // Identification
  app: string;
  environment: 'development' | 'preview' | 'production';
  level: ErrorLevel;

  // Error Details
  message: string;
  type?: string;
  stack?: string;
  filename?: string;
  lineno?: number;
  colno?: number;

  // Request Context
  url?: string;
  method?: string;
  userAgent?: string;
  userId?: string;
  userEmail?: string;

  // Breadcrumbs
  breadcrumbs?: ErrorBreadcrumb[];

  // Release/Deploy
  release?: string;
  runtime?: 'browser' | 'node' | 'edge';

  // Aggregation (rolled up per fingerprint)
  count: number;
  firstSeen: string;
  lastSeen: string;

  // Sentry Integration (optional)
  sentryIssueId?: string;
  sentryEventId?: string;
  sentryUrl?: string;

  // State
  resolved: boolean;
  resolvedAt?: string;
  resolvedBy?: string;
  notes?: string;

  // Raw (for debugging)
  raw?: Record<string, unknown>;
}

// ─── Storage ────────────────────────────────────────────────────────────────

const ERRORS_FILE = join(PATHS.dataDir, 'errors.jsonl');

function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function readAll(): ErrorEvent[] {
  if (!existsSync(ERRORS_FILE)) return [];
  const lines = readFileSync(ERRORS_FILE, 'utf-8').split('\n').filter(Boolean);
  const entries: ErrorEvent[] = [];
  for (const line of lines) {
    try { entries.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  return entries;
}

function rewriteAll(entries: ErrorEvent[]): void {
  ensureDir(ERRORS_FILE);
  const content = entries.length ? entries.map(e => JSON.stringify(e)).join('\n') + '\n' : '';
  const tmp = ERRORS_FILE + '.tmp';
  writeFileSync(tmp, content);
  renameSync(tmp, ERRORS_FILE);
}

function appendLine(entry: ErrorEvent): void {
  ensureDir(ERRORS_FILE);
  appendFileSync(ERRORS_FILE, JSON.stringify(entry) + '\n');
}

// ─── Fingerprinting ─────────────────────────────────────────────────────────

function computeFingerprint(input: {
  app: string;
  message: string;
  type?: string;
  stackTop?: string;
}): string {
  const top = (input.stackTop || '').split('\n').slice(0, 2).join('|');
  const raw = `${input.app}::${input.type || ''}::${input.message}::${top}`;
  return createHash('sha1').update(raw).digest('hex').slice(0, 16);
}

// ─── PII Scrubbing ──────────────────────────────────────────────────────────

const PII_KEYS = /^(password|token|secret|apikey|api_key|authorization|cookie|session)$/i;

function scrubObject<T>(input: T): T {
  if (input === null || typeof input !== 'object') return input;
  if (Array.isArray(input)) {
    return input.map(scrubObject) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (PII_KEYS.test(k)) {
      out[k] = '[REDACTED]';
    } else if (typeof v === 'string' && v.length > 2000) {
      out[k] = v.slice(0, 2000) + '…[truncated]';
    } else {
      out[k] = scrubObject(v);
    }
  }
  return out as T;
}

// ─── SSE Broadcasting ───────────────────────────────────────────────────────

type SseClient = Response;
const sseClients = new Set<SseClient>();

function broadcast(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch { /* client disconnected */ }
  }
}

// ─── Upsert Logic ───────────────────────────────────────────────────────────

function upsertError(incoming: Omit<ErrorEvent, 'id' | 'count' | 'firstSeen' | 'lastSeen' | 'resolved'>): ErrorEvent {
  const entries = readAll();
  const now = new Date().toISOString();
  const existingIdx = entries.findIndex(e => e.fingerprint === incoming.fingerprint && !e.resolved);

  if (existingIdx !== -1) {
    const existing = entries[existingIdx];
    existing.count += 1;
    existing.lastSeen = now;
    // Update latest context (user, url, etc.) — keep first-seen context in history
    if (incoming.url) existing.url = incoming.url;
    if (incoming.userId) existing.userId = incoming.userId;
    if (incoming.userEmail) existing.userEmail = incoming.userEmail;
    if (incoming.sentryIssueId && !existing.sentryIssueId) existing.sentryIssueId = incoming.sentryIssueId;
    if (incoming.sentryUrl && !existing.sentryUrl) existing.sentryUrl = incoming.sentryUrl;
    rewriteAll(entries);
    broadcast('error.updated', existing);
    return existing;
  }

  const id = `err-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const entry: ErrorEvent = {
    id,
    count: 1,
    firstSeen: now,
    lastSeen: now,
    resolved: false,
    ...incoming,
  };
  appendLine(entry);
  broadcast('error.new', entry);
  return entry;
}

// ─── Sentry Webhook Parsing ─────────────────────────────────────────────────

interface SentryIssue {
  id?: string;
  title?: string;
  culprit?: string;
  level?: string;
  metadata?: { type?: string; value?: string; filename?: string };
  project?: { slug?: string; name?: string };
  permalink?: string;
  firstSeen?: string;
  lastSeen?: string;
}

interface SentryEvent {
  event_id?: string;
  environment?: string;
  release?: string;
  platform?: string;
  exception?: {
    values?: Array<{
      type?: string;
      value?: string;
      stacktrace?: {
        frames?: Array<{
          filename?: string;
          function?: string;
          lineno?: number;
          colno?: number;
        }>;
      };
    }>;
  };
  request?: {
    url?: string;
    method?: string;
    headers?: Record<string, string>;
  };
  user?: {
    id?: string;
    email?: string;
  };
  breadcrumbs?: {
    values?: Array<{
      timestamp?: number;
      category?: string;
      message?: string;
      level?: string;
      data?: Record<string, unknown>;
    }>;
  };
  tags?: Array<[string, string]>;
}

// Modern Sentry Internal-Integration format: { action, data: { issue, event } }
// Legacy Webhooks plugin format (flat):
//   { id, project_slug, project_name, message, culprit, level, url, event, triggering_rules }
interface SentryWebhookPayload {
  action?: string;
  data?: {
    issue?: SentryIssue;
    event?: SentryEvent;
  };
  // Legacy Webhooks plugin fields
  id?: string;
  project?: string;
  project_name?: string;
  project_slug?: string;
  message?: string;
  culprit?: string;
  level?: string;
  url?: string;
  logger?: string;
  event?: SentryEvent & { issue_id?: string; issue_url?: string };
  triggering_rules?: string[];
}

function parseSentryPayload(payload: SentryWebhookPayload): Omit<ErrorEvent, 'id' | 'count' | 'firstSeen' | 'lastSeen' | 'resolved'> | null {
  // Modern Internal-Integration shape: { data: { issue, event } }
  // Legacy Webhooks plugin shape: { project_slug, message, level, url, event, ... }
  const isLegacy = !payload.data?.issue && (!!payload.project_slug || !!payload.event);
  const issue: SentryIssue | undefined = isLegacy
    ? {
        id: payload.event?.issue_id ?? payload.id,
        title: payload.message,
        culprit: payload.culprit,
        level: payload.level,
        project: { slug: payload.project_slug, name: payload.project_name },
        permalink: payload.event?.issue_url ?? payload.url,
      }
    : payload.data?.issue;
  const event: SentryEvent | undefined = isLegacy ? payload.event : payload.data?.event;
  if (!issue && !event) return null;

  const app = issue?.project?.slug || issue?.project?.name || payload.project_slug || payload.project || 'unknown';
  const type = issue?.metadata?.type || event?.exception?.values?.[0]?.type || 'Error';
  const message = issue?.metadata?.value || issue?.title || payload.message || event?.exception?.values?.[0]?.value || 'Unknown error';
  const level = ((issue?.level || payload.level) as ErrorLevel) || 'error';
  const environment = (event?.environment as ErrorEvent['environment']) || 'production';

  const firstFrame = event?.exception?.values?.[0]?.stacktrace?.frames?.slice(-1)[0];
  const stackFrames = event?.exception?.values?.[0]?.stacktrace?.frames || [];
  const stack = stackFrames
    .slice(-20)
    .reverse()
    .map(f => `  at ${f.function || '<anonymous>'} (${f.filename || '?'}:${f.lineno || 0}:${f.colno || 0})`)
    .join('\n');

  const fingerprint = computeFingerprint({ app, message, type, stackTop: stack });

  const breadcrumbs: ErrorBreadcrumb[] | undefined = event?.breadcrumbs?.values?.slice(-10).map(bc => ({
    timestamp: bc.timestamp ? new Date(bc.timestamp * 1000).toISOString() : new Date().toISOString(),
    category: bc.category || 'default',
    ...(bc.message ? { message: bc.message } : {}),
    ...(bc.level ? { level: bc.level as ErrorLevel } : {}),
    ...(bc.data ? { data: scrubObject(bc.data) } : {}),
  }));

  return {
    fingerprint,
    app,
    environment,
    level,
    message,
    type,
    stack: stack || undefined,
    filename: firstFrame?.filename,
    lineno: firstFrame?.lineno,
    colno: firstFrame?.colno,
    url: event?.request?.url,
    method: event?.request?.method,
    userId: event?.user?.id,
    userEmail: event?.user?.email,
    release: event?.release,
    runtime: event?.platform === 'node' ? 'node' : event?.platform === 'edge' ? 'edge' : 'browser',
    breadcrumbs,
    sentryIssueId: issue?.id,
    sentryEventId: event?.event_id,
    sentryUrl: issue?.permalink,
  };
}

// ─── Public Router (Webhook only — no CUI auth, but requires shared secret) ──

/**
 * Public webhook router for external services (Sentry).
 * Must be mounted BEFORE the /api auth middleware.
 * Protected via ERROR_WEBHOOK_SECRET env var (shared secret between Sentry and CUI).
 */
export function createPublicErrorsRouter(): Router {
  const router = Router();

  const requireWebhookSecret = (req: Request, res: Response, next: () => void) => {
    const secret = process.env.ERROR_WEBHOOK_SECRET;
    if (!secret) return next(); // No secret configured → allow (dev mode)
    const provided = req.header('Authorization')?.replace(/^Bearer\s+/i, '')
      || req.header('X-Sentry-Token')
      || req.query.token;
    if (provided !== secret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  };

  // POST /errors/sentry-webhook — Sentry Issue Alert
  // Sentry sends on: issue.created, issue.resolved, issue.assigned
  router.post('/errors/sentry-webhook', requireWebhookSecret, (req: Request, res: Response) => {
    handleSentryWebhook(req, res);
  });

  // POST /errors/report — Direct report from error-reporter package
  router.post('/errors/report', requireWebhookSecret, (req: Request, res: Response) => {
    handleDirectReport(req, res);
  });

  return router;
}

function handleSentryWebhook(req: Request, res: Response): void {
  try {
    const payload = req.body as SentryWebhookPayload;
    const parsed = parseSentryPayload(payload);
    if (!parsed) {
      res.status(400).json({ error: 'Invalid Sentry payload — missing issue' });
      return;
    }

    if (payload.action === 'resolved' && parsed.sentryIssueId) {
      const entries = readAll();
      const idx = entries.findIndex(e => e.sentryIssueId === parsed.sentryIssueId);
      if (idx !== -1) {
        entries[idx].resolved = true;
        entries[idx].resolvedAt = new Date().toISOString();
        entries[idx].resolvedBy = 'sentry';
        rewriteAll(entries);
        broadcast('error.resolved', entries[idx]);
      }
      res.json({ ok: true, action: 'resolved' });
      return;
    }

    const entry = upsertError(parsed);
    console.log(`[Errors] Sentry webhook: ${entry.app} — ${entry.message.slice(0, 80)}`);
    res.json({ ok: true, id: entry.id, count: entry.count });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[Errors] Sentry webhook failed:', msg);
    res.status(500).json({ error: 'Webhook processing failed', detail: msg });
  }
}

function handleDirectReport(req: Request, res: Response): void {
  try {
    const body = req.body as Partial<ErrorEvent> & { app: string; message: string };
    if (!body.app || !body.message) {
      res.status(400).json({ error: 'app and message required' });
      return;
    }

    const app = body.app;
    const type = body.type || 'Error';
    const message = body.message;
    const stack = body.stack;
    const fingerprint = body.fingerprint || computeFingerprint({ app, message, type, stackTop: stack });

    const parsed: Omit<ErrorEvent, 'id' | 'count' | 'firstSeen' | 'lastSeen' | 'resolved'> = {
      fingerprint,
      app,
      environment: body.environment || 'production',
      level: body.level || 'error',
      message,
      type,
      ...(stack ? { stack } : {}),
      ...(body.filename ? { filename: body.filename } : {}),
      ...(body.lineno ? { lineno: body.lineno } : {}),
      ...(body.colno ? { colno: body.colno } : {}),
      ...(body.url ? { url: body.url } : {}),
      ...(body.userAgent ? { userAgent: body.userAgent } : {}),
      ...(body.userId ? { userId: body.userId } : {}),
      ...(body.userEmail ? { userEmail: body.userEmail } : {}),
      ...(body.release ? { release: body.release } : {}),
      ...(body.runtime ? { runtime: body.runtime } : {}),
      ...(body.breadcrumbs ? { breadcrumbs: scrubObject(body.breadcrumbs) } : {}),
    };

    const entry = upsertError(parsed);
    console.log(`[Errors] Direct report: ${entry.app} — ${entry.message.slice(0, 80)}`);
    res.json({ ok: true, id: entry.id, count: entry.count });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[Errors] Direct report failed:', msg);
    res.status(500).json({ error: 'Report failed', detail: msg });
  }
}

// ─── Protected Router (CUI Panel - mounted under /api/errors, gated by requireAuth) ──

export default function createErrorsRouter(): Router {
  const router = Router();

  // GET /api/errors — List (with filters)
  router.get('/', (req: Request, res: Response) => {
    try {
      const { app, level, resolved, limit = '200' } = req.query;
      let entries = readAll();

      if (app) entries = entries.filter(e => e.app === app);
      if (level) entries = entries.filter(e => e.level === level);
      if (resolved === 'true') entries = entries.filter(e => e.resolved);
      else if (resolved === 'false') entries = entries.filter(e => !e.resolved);

      // Sort: unresolved first, then newest lastSeen
      entries.sort((a, b) => {
        if (a.resolved !== b.resolved) return a.resolved ? 1 : -1;
        return new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime();
      });

      const lim = Math.min(parseInt(String(limit), 10) || 200, 1000);
      res.json({
        total: entries.length,
        unresolved: entries.filter(e => !e.resolved).length,
        entries: entries.slice(0, lim),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: 'Read failed', detail: msg });
    }
  });

  // GET /api/errors/stream — SSE Live Feed
  router.get('/stream', (req: Request, res: Response) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: connected\ndata: ${JSON.stringify({ t: Date.now() })}\n\n`);

    sseClients.add(res);

    const keepAlive = setInterval(() => {
      try { res.write(`: keepalive\n\n`); } catch { /* ignore */ }
    }, 25000);

    req.on('close', () => {
      clearInterval(keepAlive);
      sseClients.delete(res);
    });
  });

  // GET /api/errors/:id — Details
  router.get('/:id', (req: Request, res: Response) => {
    const entries = readAll();
    const entry = entries.find(e => e.id === req.params.id);
    if (!entry) return res.status(404).json({ error: 'Not found' });
    res.json(entry);
  });

  // PATCH /api/errors/:id — resolve/unresolve/notes
  router.patch('/:id', (req: Request, res: Response) => {
    const { resolved, notes, resolvedBy } = req.body as { resolved?: boolean; notes?: string; resolvedBy?: string };
    const entries = readAll();
    const idx = entries.findIndex(e => e.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });

    const entry = entries[idx];
    if (resolved !== undefined) {
      entry.resolved = resolved;
      if (resolved) {
        entry.resolvedAt = new Date().toISOString();
        entry.resolvedBy = resolvedBy || 'rafael';
      } else {
        delete entry.resolvedAt;
        delete entry.resolvedBy;
      }
    }
    if (notes !== undefined) entry.notes = notes;

    rewriteAll(entries);
    broadcast('error.updated', entry);
    res.json(entry);
  });

  // DELETE /api/errors/:id
  router.delete('/:id', (req: Request, res: Response) => {
    const entries = readAll();
    const filtered = entries.filter(e => e.id !== req.params.id);
    if (filtered.length === entries.length) return res.status(404).json({ error: 'Not found' });
    rewriteAll(filtered);
    broadcast('error.deleted', { id: req.params.id });
    res.json({ ok: true });
  });

  // POST /api/errors/:id/spawn-fix — Spawn Mission Sub-Session to fix this error
  router.post('/:id/spawn-fix', async (req: Request, res: Response) => {
    try {
      const entries = readAll();
      const entry = entries.find(e => e.id === req.params.id);
      if (!entry) return res.status(404).json({ error: 'Not found' });

      // Build prompt for sub-session
      const prompt = [
        `# Production Error — Fix Auftrag`,
        ``,
        `**App:** ${entry.app}`,
        `**Env:** ${entry.environment}`,
        `**Level:** ${entry.level}`,
        `**Count:** ${entry.count}x (erstes Auftreten: ${entry.firstSeen})`,
        ``,
        `## Fehler`,
        `**Type:** ${entry.type || 'Error'}`,
        `**Message:** ${entry.message}`,
        ``,
        entry.stack ? `## Stack Trace\n\`\`\`\n${entry.stack}\n\`\`\`` : '',
        entry.url ? `**URL:** ${entry.url}` : '',
        entry.userEmail ? `**User:** ${entry.userEmail}` : '',
        entry.sentryUrl ? `**Sentry:** ${entry.sentryUrl}` : '',
        entry.release ? `**Release:** ${entry.release}` : '',
        ``,
        `## Auftrag`,
        `1. Root Cause im Code finden (App-Pfad: apps/${entry.app})`,
        `2. Fix implementieren`,
        `3. Committen auf develop`,
        `4. Nach Fix: Error in CUI als resolved markieren (PATCH /api/errors/${entry.id})`,
      ].filter(Boolean).join('\n');

      const missionPayload = {
        accountId: req.body.accountId || 'default',
        workDir: `/root/projekte/werkingflow-production/apps/${entry.app}`,
        subject: `[Fix] ${entry.app}: ${entry.message.slice(0, 60)}`,
        message: prompt,
        model: 'sonnet',
        parentSessionId: req.body.parentSessionId,
      };

      // Hit local Mission API
      const response = await fetch('http://localhost:4005/api/mission/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(missionPayload),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Mission start failed: ${response.status} ${text}`);
      }

      const missionResult = await response.json();
      console.log(`[Errors] Spawned fix session for ${entry.id}`);
      res.json({ ok: true, mission: missionResult });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[Errors] spawn-fix failed:', msg);
      res.status(500).json({ error: 'Spawn failed', detail: msg });
    }
  });

  return router;
}
