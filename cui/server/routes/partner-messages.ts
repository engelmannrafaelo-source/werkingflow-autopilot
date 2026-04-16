/**
 * Partner Messages — /api/partner/messages
 *
 * Append-only JSONL storage for admin↔partner messaging.
 * Supports announcements, direct messages, and system messages.
 * Broadcasts new messages via WebSocket.
 */

import { Router, type Request, type Response } from 'express';
import { existsSync, appendFileSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { DATA_DIR, broadcast } from './state.js';

const router = Router();

// --- Types ---

export type MessageType = 'announcement' | 'direct' | 'system';

export type MessageStatus = 'draft' | 'sent';

export interface PartnerMessage {
  id: string;
  from: string;          // userId or 'admin'
  to: string;            // userId or 'all' for announcements
  type: MessageType;
  status: MessageStatus; // draft = needs admin approval, sent = visible to partner
  subject: string;
  body: string;
  createdAt: string;     // ISO timestamp
  readAt: string | null; // ISO timestamp or null
}

// --- Storage Helpers ---

function getMessagesFile(): string {
  return join(DATA_DIR, 'partner-messages.jsonl');
}

function readAllMessages(): PartnerMessage[] {
  const file = getMessagesFile();
  if (!existsSync(file)) return [];

  const lines = readFileSync(file, 'utf8')
    .split('\n')
    .filter(line => line.trim().length > 0);

  const messages: PartnerMessage[] = [];
  for (const line of lines) {
    try {
      messages.push(JSON.parse(line) as PartnerMessage);
    } catch {
      console.error(`[PartnerMessages] Skipping malformed JSONL line: ${line.slice(0, 80)}`);
    }
  }
  return messages;
}

function appendMessage(msg: PartnerMessage): void {
  appendFileSync(getMessagesFile(), JSON.stringify(msg) + '\n', 'utf8');
}

function markAsRead(messageId: string, readAt: string): boolean {
  const file = getMessagesFile();
  if (!existsSync(file)) return false;

  const lines = readFileSync(file, 'utf8').split('\n');
  let found = false;
  const updated = lines.map(line => {
    if (!line.trim()) return line;
    try {
      const msg = JSON.parse(line) as PartnerMessage;
      if (msg.id === messageId && msg.readAt === null) {
        found = true;
        return JSON.stringify({ ...msg, readAt });
      }
    } catch { /* skip malformed */ }
    return line;
  });

  if (found) {
    writeFileSync(file, updated.join('\n'), 'utf8');
  }
  return found;
}

// --- Routes ---

/**
 * POST /api/partner/messages
 * Send a new message (admin→partner, partner→admin, or announcement).
 */
router.post('/api/partner/messages', (req: Request, res: Response) => {
  const { from, to, type, subject, body } = req.body as Partial<PartnerMessage>;

  if (!from || !to || !type || !body) {
    res.status(400).json({ error: 'Missing required fields: from, to, type, body' });
    return;
  }

  const validTypes: MessageType[] = ['announcement', 'direct', 'system'];
  if (!validTypes.includes(type)) {
    res.status(400).json({ error: `Invalid type. Must be one of: ${validTypes.join(', ')}` });
    return;
  }

  // Messages from Claude sessions or admin default to draft (review before sending).
  // Partners replying to admin go straight to sent.
  const isDraft = (req.body as Record<string, unknown>).status === 'sent' ? false
    : from === 'admin' || (req.body as Record<string, unknown>).draft === true
      ? true : false;

  const msg: PartnerMessage = {
    id: randomUUID(),
    from,
    to,
    type,
    status: isDraft ? 'draft' : 'sent',
    subject: subject?.trim() ?? '',
    body: body.trim(),
    createdAt: new Date().toISOString(),
    readAt: null,
  };

  appendMessage(msg);

  broadcast({
    type: 'partner-message-new',
    message: msg,
  });

  res.status(201).json({ ok: true, message: msg });
});

/**
 * GET /api/partner/messages?userId=X
 * Admin (userId='admin') gets all messages; partner gets own messages + announcements.
 */
router.get('/api/partner/messages', (req: Request, res: Response) => {
  const userId = req.query.userId as string | undefined;

  if (!userId) {
    res.status(400).json({ error: 'Missing required query param: userId' });
    return;
  }

  const all = readAllMessages();
  const messages = userId === 'admin'
    ? all  // Admin sees everything including drafts
    : all.filter(m =>
        (m.status ?? 'sent') === 'sent' &&  // Partners only see sent messages
        (m.to === userId || m.to === 'all' || m.from === userId),
      );

  messages.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  res.json({ messages });
});

/**
 * POST /api/partner/messages/:id/read
 * Mark a message as read.
 */
router.post('/api/partner/messages/:id/read', (req: Request, res: Response) => {
  const { id } = req.params;

  const readAt = new Date().toISOString();
  const updated = markAsRead(id, readAt);

  if (!updated) {
    res.status(404).json({ error: 'Message not found or already read' });
    return;
  }

  broadcast({
    type: 'partner-message-read',
    messageId: id,
    readAt,
  });

  res.json({ ok: true, messageId: id, readAt });
});

/**
 * POST /api/partner/messages/:id/approve
 * Approve a draft message — changes status from 'draft' to 'sent'.
 * Optionally update subject/body before sending.
 */
router.post('/api/partner/messages/:id/approve', (req: Request, res: Response) => {
  const { id } = req.params;
  const { subject: newSubject, body: newBody } = req.body as { subject?: string; body?: string };
  const file = getMessagesFile();
  if (!existsSync(file)) { res.status(404).json({ error: 'No messages file' }); return; }

  const lines = readFileSync(file, 'utf8').split('\n');
  let found = false;
  let approvedMsg: PartnerMessage | null = null;

  const updated = lines.map(line => {
    if (!line.trim()) return line;
    try {
      const msg = JSON.parse(line) as PartnerMessage;
      if (msg.id === id && (msg.status ?? 'sent') === 'draft') {
        found = true;
        approvedMsg = {
          ...msg,
          status: 'sent',
          subject: newSubject?.trim() ?? msg.subject,
          body: newBody?.trim() ?? msg.body,
        };
        return JSON.stringify(approvedMsg);
      }
    } catch { /* skip */ }
    return line;
  });

  if (!found) {
    res.status(404).json({ error: 'Draft not found' });
    return;
  }

  writeFileSync(file, updated.join('\n'), 'utf8');

  broadcast({
    type: 'partner-message-approved',
    message: approvedMsg,
  });

  res.json({ ok: true, message: approvedMsg });
});

/**
 * DELETE /api/partner/messages/:id
 * Delete a draft message (reject/discard). Only drafts can be deleted.
 */
router.delete('/api/partner/messages/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  const file = getMessagesFile();
  if (!existsSync(file)) { res.status(404).json({ error: 'No messages file' }); return; }

  const lines = readFileSync(file, 'utf8').split('\n');
  let found = false;

  const updated = lines.filter(line => {
    if (!line.trim()) return true;
    try {
      const msg = JSON.parse(line) as PartnerMessage;
      if (msg.id === id && (msg.status ?? 'sent') === 'draft') {
        found = true;
        return false; // Remove this line
      }
    } catch { /* keep malformed */ }
    return true;
  });

  if (!found) {
    res.status(404).json({ error: 'Draft not found or already sent' });
    return;
  }

  writeFileSync(file, updated.join('\n'), 'utf8');

  broadcast({
    type: 'partner-message-deleted',
    messageId: id,
  });

  res.json({ ok: true, messageId: id });
});

/**
 * GET /api/partner/messages/unread-count?userId=X
 * Returns count of unread messages for a user.
 */
router.get('/api/partner/messages/unread-count', (req: Request, res: Response) => {
  const userId = req.query.userId as string | undefined;

  if (!userId) {
    res.status(400).json({ error: 'Missing required query param: userId' });
    return;
  }

  const all = readAllMessages();
  const unread = userId === 'admin'
    ? all.filter(m => m.readAt === null && m.from !== 'admin' && (m.status ?? 'sent') === 'sent').length
    : all.filter(m =>
        (m.status ?? 'sent') === 'sent' &&
        m.readAt === null &&
        m.from !== userId &&
        (m.to === userId || m.to === 'all'),
      ).length;

  res.json({ unread });
});

export default router;
