/**
 * Mail API — IONOS IMAP (read) + SMTP (send) + local draft queue.
 *
 * Drafts werden lokal gespeichert (Approve-before-Send). Senden nur aus Draft.
 *
 * GET    /api/mail/config              — status + account info (no secrets)
 * GET    /api/mail/folders             — list IMAP folders
 * GET    /api/mail/messages            — list messages (?folder=INBOX&limit=50)
 * GET    /api/mail/messages/:uid       — read one message (?folder=INBOX)
 * GET    /api/mail/drafts              — list local drafts
 * POST   /api/mail/drafts              — create draft
 * PUT    /api/mail/drafts/:id          — update draft
 * DELETE /api/mail/drafts/:id          — delete draft
 * POST   /api/mail/drafts/:id/send     — send draft via SMTP (+ append to Sent)
 *
 * Env vars (from Infisical dev-server or manual):
 *   IONOS_EMAIL, IONOS_PASSWORD
 *   IONOS_IMAP_HOST (default imap.ionos.de), IONOS_IMAP_PORT (993)
 *   IONOS_SMTP_HOST (default smtp.ionos.de), IONOS_SMTP_PORT (465)
 *   IONOS_FROM_NAME (optional display name)
 */

import { Router, Request, Response } from 'express';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { randomUUID } from 'crypto';
import { ImapFlow } from 'imapflow';
import nodemailer, { Transporter } from 'nodemailer';
import { simpleParser } from 'mailparser';

const DRAFTS_PATH = '/root/projekte/local-storage/privat/mail-drafts.json';

// ── Types ────────────────────────────────────────────────────────────────────

interface Draft {
  id: string;
  createdAt: string;
  updatedAt: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  status: 'draft' | 'sent' | 'failed';
  sentAt: string | null;
  error: string | null;
  messageId: string | null;
}

interface DraftsFile {
  drafts: Draft[];
}

interface MailConfig {
  email: string;
  password: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  fromName: string;
}

// ── Config ───────────────────────────────────────────────────────────────────

function getConfig(): MailConfig | null {
  const email = process.env.IONOS_EMAIL;
  const password = process.env.IONOS_PASSWORD;
  if (!email || !password) return null;
  return {
    email,
    password,
    imapHost: process.env.IONOS_IMAP_HOST || 'imap.ionos.de',
    imapPort: parseInt(process.env.IONOS_IMAP_PORT || '993', 10),
    smtpHost: process.env.IONOS_SMTP_HOST || 'smtp.ionos.de',
    smtpPort: parseInt(process.env.IONOS_SMTP_PORT || '465', 10),
    fromName: process.env.IONOS_FROM_NAME || '',
  };
}

function requireConfig(res: Response): MailConfig | null {
  const cfg = getConfig();
  if (!cfg) {
    res.status(503).json({
      error: 'Mail not configured',
      hint: 'Set IONOS_EMAIL and IONOS_PASSWORD in environment (via Infisical dev-server project).',
    });
    return null;
  }
  return cfg;
}

// ── Drafts Storage ───────────────────────────────────────────────────────────

function readDrafts(): DraftsFile {
  if (!existsSync(DRAFTS_PATH)) {
    const empty: DraftsFile = { drafts: [] };
    const dir = dirname(DRAFTS_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(DRAFTS_PATH, JSON.stringify(empty, null, 2), 'utf-8');
    return empty;
  }
  const raw = readFileSync(DRAFTS_PATH, 'utf-8');
  const parsed = JSON.parse(raw) as DraftsFile;
  if (!Array.isArray(parsed.drafts)) {
    throw new Error('Invalid mail-drafts.json: missing drafts array');
  }
  return parsed;
}

function writeDrafts(data: DraftsFile): void {
  const dir = dirname(DRAFTS_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(DRAFTS_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

function makeDraft(body: Partial<Draft>): Draft {
  const now = new Date().toISOString();
  return {
    id: body.id || randomUUID(),
    createdAt: body.createdAt || now,
    updatedAt: now,
    to: (body.to || '').trim(),
    cc: (body.cc || '').trim(),
    bcc: (body.bcc || '').trim(),
    subject: (body.subject || '').trim(),
    body: body.body || '',
    status: body.status || 'draft',
    sentAt: body.sentAt || null,
    error: body.error || null,
    messageId: body.messageId || null,
  };
}

// ── IMAP Client ──────────────────────────────────────────────────────────────

function makeImapClient(cfg: MailConfig): ImapFlow {
  return new ImapFlow({
    host: cfg.imapHost,
    port: cfg.imapPort,
    secure: true,
    auth: { user: cfg.email, pass: cfg.password },
    logger: false,
  });
}

async function withImap<T>(cfg: MailConfig, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  const client = makeImapClient(cfg);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    try { await client.logout(); } catch { /* ignore close errors */ }
  }
}

// ── SMTP Transport ───────────────────────────────────────────────────────────

function makeSmtpTransport(cfg: MailConfig): Transporter {
  return nodemailer.createTransport({
    host: cfg.smtpHost,
    port: cfg.smtpPort,
    secure: cfg.smtpPort === 465,
    auth: { user: cfg.email, pass: cfg.password },
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseAddressList(s: string): string[] {
  if (!s) return [];
  return s.split(/[,;]/).map(x => x.trim()).filter(Boolean);
}

function formatAddress(a: unknown): string {
  if (!a) return '';
  if (typeof a === 'string') return a;
  const addr = a as { name?: string; address?: string };
  if (addr.name && addr.address) return `${addr.name} <${addr.address}>`;
  return addr.address || '';
}

function formatAddressList(list: unknown): string {
  if (!list) return '';
  if (Array.isArray(list)) return list.map(formatAddress).join(', ');
  const obj = list as { value?: unknown[] };
  if (obj.value && Array.isArray(obj.value)) return obj.value.map(formatAddress).join(', ');
  return formatAddress(list);
}

// ── Router ───────────────────────────────────────────────────────────────────

export function createMailRouter(): Router {
  const router = Router();

  // GET /api/mail/config
  router.get('/api/mail/config', (_req: Request, res: Response) => {
    const cfg = getConfig();
    if (!cfg) {
      res.json({
        configured: false,
        hint: 'Set IONOS_EMAIL and IONOS_PASSWORD in environment.',
      });
      return;
    }
    res.json({
      configured: true,
      email: cfg.email,
      fromName: cfg.fromName,
      imap: { host: cfg.imapHost, port: cfg.imapPort },
      smtp: { host: cfg.smtpHost, port: cfg.smtpPort },
    });
  });

  // GET /api/mail/folders
  router.get('/api/mail/folders', async (_req: Request, res: Response) => {
    const cfg = requireConfig(res);
    if (!cfg) return;
    try {
      const folders = await withImap(cfg, async c => {
        const list = await c.list();
        return list.map(f => ({
          path: f.path,
          name: f.name,
          specialUse: f.specialUse || null,
          flags: Array.from(f.flags || []),
        }));
      });
      res.json({ folders });
    } catch (e) {
      res.status(500).json({ error: `IMAP folders failed: ${(e as Error).message}` });
    }
  });

  // GET /api/mail/messages?folder=INBOX&limit=50
  router.get('/api/mail/messages', async (req: Request, res: Response) => {
    const cfg = requireConfig(res);
    if (!cfg) return;
    const folder = (req.query.folder as string) || 'INBOX';
    const limit = Math.min(parseInt((req.query.limit as string) || '50', 10), 200);

    try {
      const messages = await withImap(cfg, async c => {
        const lock = await c.getMailboxLock(folder);
        try {
          const mbox = c.mailbox as { exists: number } | boolean;
          const exists = typeof mbox === 'object' ? mbox.exists : 0;
          if (!exists) return [];
          const from = Math.max(1, exists - limit + 1);
          const range = `${from}:*`;
          const out: Array<Record<string, unknown>> = [];
          for await (const msg of c.fetch(range, {
            uid: true,
            envelope: true,
            flags: true,
            internalDate: true,
            size: true,
            bodyStructure: true,
          })) {
            out.push({
              uid: msg.uid,
              from: formatAddressList(msg.envelope?.from),
              to: formatAddressList(msg.envelope?.to),
              subject: msg.envelope?.subject || '',
              date: msg.envelope?.date || msg.internalDate,
              flags: Array.from(msg.flags || []),
              seen: (msg.flags || new Set()).has('\\Seen'),
              size: msg.size,
            });
          }
          out.sort((a, b) => {
            const da = new Date(a.date as string).getTime();
            const db = new Date(b.date as string).getTime();
            return db - da;
          });
          return out;
        } finally {
          lock.release();
        }
      });
      res.json({ folder, messages });
    } catch (e) {
      res.status(500).json({ error: `IMAP fetch failed: ${(e as Error).message}` });
    }
  });

  // GET /api/mail/messages/:uid?folder=INBOX
  router.get('/api/mail/messages/:uid', async (req: Request, res: Response) => {
    const cfg = requireConfig(res);
    if (!cfg) return;
    const uid = parseInt(String(req.params.uid), 10);
    const folder = (req.query.folder as string) || 'INBOX';
    if (!Number.isFinite(uid) || uid <= 0) {
      res.status(400).json({ error: 'Invalid uid' });
      return;
    }

    try {
      const message = await withImap(cfg, async c => {
        const lock = await c.getMailboxLock(folder);
        try {
          const raw = await c.download(String(uid), undefined, { uid: true });
          if (!raw) return null;
          const chunks: Buffer[] = [];
          for await (const chunk of raw.content) chunks.push(chunk as Buffer);
          const buf = Buffer.concat(chunks);
          const parsed = await simpleParser(buf);
          await c.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true }).catch(() => { /* ignore */ });
          return {
            uid,
            from: formatAddressList(parsed.from),
            to: formatAddressList(parsed.to),
            cc: formatAddressList(parsed.cc),
            subject: parsed.subject || '',
            date: parsed.date?.toISOString() || null,
            text: parsed.text || '',
            html: parsed.html || null,
            attachments: (parsed.attachments || []).map(a => ({
              filename: a.filename || 'attachment',
              size: a.size,
              contentType: a.contentType,
            })),
          };
        } finally {
          lock.release();
        }
      });
      if (!message) {
        res.status(404).json({ error: `Message not found: ${uid}` });
        return;
      }
      res.json({ message });
    } catch (e) {
      res.status(500).json({ error: `IMAP read failed: ${(e as Error).message}` });
    }
  });

  // GET /api/mail/drafts
  router.get('/api/mail/drafts', (_req: Request, res: Response) => {
    const data = readDrafts();
    const sorted = [...data.drafts].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    res.json({ drafts: sorted });
  });

  // POST /api/mail/drafts
  router.post('/api/mail/drafts', (req: Request, res: Response) => {
    const draft = makeDraft(req.body as Partial<Draft>);
    const data = readDrafts();
    data.drafts.push(draft);
    writeDrafts(data);
    res.status(201).json({ draft });
  });

  // PUT /api/mail/drafts/:id
  router.put('/api/mail/drafts/:id', (req: Request, res: Response) => {
    const { id } = req.params;
    const data = readDrafts();
    const idx = data.drafts.findIndex(d => d.id === id);
    if (idx === -1) {
      res.status(404).json({ error: `Draft not found: ${id}` });
      return;
    }
    if (data.drafts[idx].status === 'sent') {
      res.status(409).json({ error: 'Cannot edit a sent message' });
      return;
    }
    const updated = makeDraft({ ...data.drafts[idx], ...(req.body as Partial<Draft>), id: String(id) });
    data.drafts[idx] = updated;
    writeDrafts(data);
    res.json({ draft: updated });
  });

  // DELETE /api/mail/drafts/:id
  router.delete('/api/mail/drafts/:id', (req: Request, res: Response) => {
    const { id } = req.params;
    const data = readDrafts();
    const idx = data.drafts.findIndex(d => d.id === id);
    if (idx === -1) {
      res.status(404).json({ error: `Draft not found: ${id}` });
      return;
    }
    data.drafts.splice(idx, 1);
    writeDrafts(data);
    res.json({ ok: true });
  });

  // POST /api/mail/drafts/:id/send
  router.post('/api/mail/drafts/:id/send', async (req: Request, res: Response) => {
    const cfg = requireConfig(res);
    if (!cfg) return;
    const { id } = req.params;
    const data = readDrafts();
    const idx = data.drafts.findIndex(d => d.id === id);
    if (idx === -1) {
      res.status(404).json({ error: `Draft not found: ${id}` });
      return;
    }
    const draft = data.drafts[idx];
    if (draft.status === 'sent') {
      res.status(409).json({ error: 'Draft already sent' });
      return;
    }
    const toList = parseAddressList(draft.to);
    if (toList.length === 0) {
      res.status(400).json({ error: 'Draft has no recipient (To is empty)' });
      return;
    }

    const fromAddr = cfg.fromName ? `"${cfg.fromName}" <${cfg.email}>` : cfg.email;
    const transport = makeSmtpTransport(cfg);

    try {
      const info = await transport.sendMail({
        from: fromAddr,
        to: toList,
        cc: parseAddressList(draft.cc),
        bcc: parseAddressList(draft.bcc),
        subject: draft.subject,
        text: draft.body,
      });

      // Append to Sent folder (best-effort — don't fail send on this).
      const raw = (info as { message?: Buffer | string }).message;
      if (raw) {
        try {
          await withImap(cfg, async c => {
            const list = await c.list();
            const sent = list.find(f => f.specialUse === '\\Sent')
              || list.find(f => /^(sent|gesendet)/i.test(f.name))
              || null;
            if (sent) {
              await c.append(sent.path, raw, ['\\Seen']);
            }
          });
        } catch { /* Sent-folder append is best-effort */ }
      }

      draft.status = 'sent';
      draft.sentAt = new Date().toISOString();
      draft.error = null;
      draft.messageId = info.messageId || null;
      draft.updatedAt = draft.sentAt;
      data.drafts[idx] = draft;
      writeDrafts(data);

      res.json({ draft, info: { messageId: info.messageId, accepted: info.accepted, rejected: info.rejected } });
    } catch (e) {
      const err = (e as Error).message;
      draft.status = 'failed';
      draft.error = err;
      draft.updatedAt = new Date().toISOString();
      data.drafts[idx] = draft;
      writeDrafts(data);
      res.status(500).json({ error: `SMTP send failed: ${err}`, draft });
    } finally {
      try { transport.close(); } catch { /* ignore */ }
    }
  });

  return router;
}
