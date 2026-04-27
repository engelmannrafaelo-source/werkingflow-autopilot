/**
 * Auth-Port — nginx auth_request endpoint for subdomain-based dev-port proxy.
 *
 * Used by `<port>.partner.werking.tools` nginx server block: nginx subrequests
 * GET /internal/auth-port?port=<dev-port> with the original Cookie header. We
 * validate the JWT and the per-user devPortRange. 200 = allow, 401 = no auth,
 * 403 = port not in user's range. nginx maps these to redirect/forbidden pages.
 */

import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { findUser } from '../auth/users.js';
import { isPortAllowed } from './app-proxy.js';

export default function createAuthPortRouter(): Router {
  const router = Router();

  router.get('/internal/auth-port', requireAuth, (req, res) => {
    const port = parseInt(String(req.query.port ?? ''), 10);
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      res.status(400).json({ error: 'Invalid port' });
      return;
    }

    if (!isPortAllowed(port, req.user?.sub)) {
      const user = req.user?.sub ? findUser(req.user.sub) : undefined;
      res.status(403).json({
        error: `Port ${port} not allowed`,
        yourDevRange: user?.devPortRange ?? null,
      });
      return;
    }

    res.status(200).json({ ok: true });
  });

  return router;
}
