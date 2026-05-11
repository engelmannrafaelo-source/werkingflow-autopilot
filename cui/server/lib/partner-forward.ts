// =============================================================================
// partner-forward.ts — Shared forward-proxy primitives for partner-* routes.
// =============================================================================
// Two routes use this pattern (partner-server, partner-audit):
//   - On dev-server: forward all requests to the live partner-server CUI.
//   - On partner-server: serve natively, accepting either an admin JWT or
//     the shared internal-token from the dev forwarder.
// =============================================================================
import { Request, Response, NextFunction } from 'express';
import { requireAuth, requireRole } from '../auth/middleware.js';

export function isForwardMode(): boolean {
  return Boolean(process.env.CUI_PARTNER_FORWARD_URL && process.env.CUI_PARTNER_INTERNAL_TOKEN);
}

export function getForwardUrl(): string | null {
  return process.env.CUI_PARTNER_FORWARD_URL || null;
}

/**
 * Auth middleware: accepts EITHER a valid admin JWT OR the shared
 * internal-token header (used by the dev forward-proxy to authenticate
 * itself to the upstream partner-server).
 */
export function adminOrInternal(req: Request, res: Response, next: NextFunction): void {
  const internalToken = process.env.CUI_PARTNER_INTERNAL_TOKEN;
  const headerToken = req.header('x-cui-internal-token');
  if (internalToken && headerToken && headerToken === internalToken) {
    (req as any).user = { sub: '__internal__', name: 'Internal', role: 'admin', claudeAccountId: 'internal' };
    next();
    return;
  }
  requireAuth(req, res, () => requireRole('admin')(req, res, next));
}

/**
 * Auth middleware: accepts ANY authenticated user JWT OR the shared internal-token.
 * Use for routes that need authentication but role-gate internally (e.g. feedback,
 * where admin sees all entries and fachpartner sees only their own).
 */
export function authOrInternal(req: Request, res: Response, next: NextFunction): void {
  const internalToken = process.env.CUI_PARTNER_INTERNAL_TOKEN;
  const headerToken = req.header('x-cui-internal-token');
  if (internalToken && headerToken && headerToken === internalToken) {
    (req as any).user = { sub: '__internal__', name: 'Internal', role: 'admin', claudeAccountId: 'internal' };
    next();
    return;
  }
  requireAuth(req, res, next);
}

/**
 * Transparent forward to the upstream partner-server. Streams the response
 * body so streaming endpoints (NDJSON, SSE) work too.
 */
export async function forwardToPartner(req: Request, res: Response): Promise<void> {
  const target = process.env.CUI_PARTNER_FORWARD_URL!.replace(/\/$/, '') + req.originalUrl;
  const token = process.env.CUI_PARTNER_INTERNAL_TOKEN!;

  const headers: Record<string, string> = {
    'x-cui-internal-token': token,
    accept: req.headers.accept || '*/*',
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    headers['content-type'] = (req.headers['content-type'] as string) || 'application/json';
  }

  const body = (req.method !== 'GET' && req.method !== 'HEAD')
    ? (typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}))
    : undefined;

  const ac = new AbortController();
  // Only abort upstream when the *client response* closes — using req.on('close')
  // fires as soon as body-parser finishes reading, killing every forward instantly.
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });

  try {
    const r = await fetch(target, {
      method: req.method,
      headers,
      body,
      signal: ac.signal,
      // @ts-ignore — undici extension: keep connection open for long-running streams
      duplex: 'half',
    });
    res.status(r.status);
    const ct = r.headers.get('content-type');
    if (ct) res.setHeader('Content-Type', ct);
    const cc = r.headers.get('cache-control');
    if (cc) res.setHeader('Cache-Control', cc);
    if (!r.body) { res.end(); return; }
    const reader = r.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) res.write(Buffer.from(value));
    }
    res.end();
  } catch (err: any) {
    const cause = err?.cause?.message || err?.cause?.code || '';
    console.error('[partner-forward] forward failed:', err.message, cause ? `cause=${cause}` : '', 'target=', target);
    if (!res.headersSent) {
      res.status(502).json({ error: `Forward to partner failed: ${err.message}${cause ? ` (${cause})` : ''}`, target });
    } else {
      res.end();
    }
  }
}
