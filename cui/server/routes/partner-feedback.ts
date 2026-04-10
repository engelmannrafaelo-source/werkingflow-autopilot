import { Router, Request, Response } from 'express';
import { appendFileSync, readFileSync, existsSync, mkdirSync, writeFileSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { PATHS } from '../config/paths.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface FeedbackEntry {
  id: string;
  from: string;
  type: 'bug' | 'feature' | 'ux' | 'fachlich';
  title: string;
  description: string;
  screenshot?: string;
  appContext?: string;
  status: 'new' | 'acknowledged' | 'in-progress' | 'resolved';
  createdAt: string;
  response?: string;
}

// ─── Storage ─────────────────────────────────────────────────────────────────

const FEEDBACK_FILE = join(PATHS.dataDir, 'partner-feedback.jsonl');

function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function readAllFeedbacks(): FeedbackEntry[] {
  if (!existsSync(FEEDBACK_FILE)) return [];
  const lines = readFileSync(FEEDBACK_FILE, 'utf-8').split('\n').filter(Boolean);
  const entries: FeedbackEntry[] = [];
  for (const line of lines) {
    try { entries.push(JSON.parse(line)); } catch { /* skip malformed line */ }
  }
  return entries;
}

function appendFeedback(entry: FeedbackEntry): void {
  ensureDir(FEEDBACK_FILE);
  appendFileSync(FEEDBACK_FILE, JSON.stringify(entry) + '\n');
}

function rewriteFeedbacks(entries: FeedbackEntry[]): void {
  ensureDir(FEEDBACK_FILE);
  const content = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  const tmpFile = FEEDBACK_FILE + '.tmp';
  writeFileSync(tmpFile, content);
  renameSync(tmpFile, FEEDBACK_FILE);
}

// ─── Router ──────────────────────────────────────────────────────────────────

export default function createPartnerFeedbackRouter(): Router {
  const router = Router();

  // POST /api/partner/feedback — Submit feedback
  router.post('/feedback', (req: Request, res: Response) => {
    const { from, type, title, description, screenshot, appContext } = req.body;

    if (!from || !type || !title || !description) {
      return res.status(400).json({ error: 'from, type, title, description are required' });
    }

    const validTypes = ['bug', 'feature', 'ux', 'fachlich'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({ error: `type must be one of: ${validTypes.join(', ')}` });
    }

    const entry: FeedbackEntry = {
      id: `fb-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      from,
      type,
      title: title.trim(),
      description: description.trim(),
      ...(screenshot ? { screenshot } : {}),
      ...(appContext ? { appContext } : {}),
      status: 'new',
      createdAt: new Date().toISOString(),
    };

    try {
      appendFeedback(entry);
      console.log(`[PartnerFeedback] New feedback from ${from}: "${title}" (${type})`);
      res.status(201).json(entry);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[PartnerFeedback] Failed to persist:', msg);
      res.status(500).json({ error: 'Failed to save feedback' });
    }
  });

  // GET /api/partner/feedback?userId=X — Retrieve feedbacks
  router.get('/feedback', (req: Request, res: Response) => {
    const { userId } = req.query;

    try {
      let entries = readAllFeedbacks();

      // Check role from auth context if available
      const user = (req as Request & { user?: { role?: string; id?: string } }).user;
      const isAdmin = !user || user.role === 'admin' || user.role === 'product-owner';

      if (!isAdmin) {
        // fachpartner: only their own feedbacks
        const effectiveUserId = (userId as string) || user?.id;
        if (!effectiveUserId) {
          return res.status(400).json({ error: 'userId required for non-admin' });
        }
        entries = entries.filter(e => e.from === effectiveUserId);
      } else if (userId) {
        entries = entries.filter(e => e.from === userId as string);
      }

      // Newest first
      entries.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      res.json(entries);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[PartnerFeedback] Failed to read:', msg);
      res.status(500).json({ error: 'Failed to read feedbacks' });
    }
  });

  // PATCH /api/partner/feedback/:id/status — Update status + optional response (admin only)
  router.patch('/feedback/:id/status', (req: Request, res: Response) => {
    const { id } = req.params;
    const { status, response } = req.body;

    const validStatuses = ['new', 'acknowledged', 'in-progress', 'resolved'];
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${validStatuses.join(', ')}` });
    }

    try {
      const entries = readAllFeedbacks();
      const idx = entries.findIndex(e => e.id === id);
      if (idx === -1) return res.status(404).json({ error: 'Feedback not found' });

      entries[idx].status = status;
      if (response !== undefined) entries[idx].response = response;

      rewriteFeedbacks(entries);

      console.log(`[PartnerFeedback] Status updated: ${id} → ${status}`);
      res.json(entries[idx]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[PartnerFeedback] Failed to update:', msg);
      res.status(500).json({ error: 'Failed to update feedback' });
    }
  });

  return router;
}
