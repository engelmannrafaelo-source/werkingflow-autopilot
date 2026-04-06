/**
 * Auth Routes — Login, logout, session info.
 */

import { Router } from 'express';
import { signJwt } from '../auth/jwt.js';
import { findUserByEmail, isAuthEnabled, findUser } from '../auth/users.js';
import { verifyPassword } from '../auth/users.js';
import { requireAuth } from '../auth/middleware.js';
import type { CuiUser } from '../auth/types.js';

const router = Router();

/** POST /api/auth/login — Authenticate and return JWT */
router.post('/login', (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    res.status(400).json({ error: 'User and password required' });
    return;
  }

  // Accept user ID or email
  const user = findUser(email) || findUserByEmail(email);
  if (!user) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  if (!verifyPassword(user, password)) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const token = signJwt({
    sub: user.id,
    name: user.name,
    role: user.role,
    claudeAccountId: user.claudeAccountId,
  });

  // Set as httpOnly cookie (7 days)
  res.cookie('cui-token', token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  });

  res.json({
    token,
    user: sanitizeUser(user),
  });
});

/** POST /api/auth/logout — Clear auth cookie */
router.post('/logout', (_req, res) => {
  res.clearCookie('cui-token', { path: '/' });
  res.json({ ok: true });
});

/** GET /api/auth/me — Return current user info (requires auth) */
router.get('/me', requireAuth, (req, res) => {
  if (!req.user) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const user = findUser(req.user.sub);
  if (!user) {
    res.status(401).json({ error: 'User not found' });
    return;
  }

  res.json({ user: sanitizeUser(user) });
});

/** GET /api/auth/status — Auth system status (public) */
router.get('/status', (_req, res) => {
  res.json({
    authEnabled: isAuthEnabled(),
  });
});

/** Strip sensitive fields from user object */
function sanitizeUser(user: CuiUser) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    claudeAccountId: user.claudeAccountId,
    allowedPanels: user.allowedPanels,
    allowedWorkspaces: user.allowedWorkspaces,
    canGitPush: user.canGitPush,
    canApproveEdits: user.canApproveEdits,
  };
}

export default router;
