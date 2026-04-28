/**
 * Express Auth Middleware — JWT verification for protected routes.
 *
 * When auth is disabled (no users.json), all requests pass through.
 * This ensures backward compatibility with the dev-server.
 */

import type { Request, Response, NextFunction } from 'express';
import { verifyJwt } from './jwt.js';
import { isAuthEnabled, findUser } from './users.js';
import type { JwtPayload } from './types.js';

/** Augment Express Request with user payload */
declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

/**
 * Auth middleware — verifies JWT from cookie or Authorization header.
 *
 * When auth is disabled (no users.json): passes all requests through.
 * When auth is enabled: requires valid JWT, rejects with 401.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  // Auth disabled → pass through (dev-server backward compat)
  if (!isAuthEnabled()) {
    next();
    return;
  }

  const token = extractToken(req);
  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const payload = verifyJwt(token);
  if (!payload) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  // Attach user to request
  req.user = payload;
  next();
}

/**
 * Optional auth — attaches user if token present, but doesn't block.
 * Useful for routes that behave differently for authenticated users.
 */
export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!isAuthEnabled()) {
    next();
    return;
  }

  const token = extractToken(req);
  if (token) {
    const payload = verifyJwt(token);
    if (payload) {
      req.user = payload;
    }
  }
  next();
}

/**
 * Role-based access control — requires specific role(s).
 * Must be used AFTER requireAuth.
 */
export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!isAuthEnabled()) {
      next();
      return;
    }

    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: 'Insufficient permissions', required: roles, actual: req.user.role });
      return;
    }

    next();
  };
}

/**
 * Panel access check — verifies user can access the given panel.
 * Returns true if allowed, false if denied.
 */
function canAccessPanel(req: Request, panelId: string): boolean {
  if (!isAuthEnabled()) return true;
  if (!req.user) return false;

  const user = findUser(req.user.sub);
  if (!user) return false;
  if (user.allowedPanels === '*') return true;

  return user.allowedPanels.includes(panelId as any);
}

/** Extract JWT token from cookie or Authorization header */
function extractToken(req: Request): string | null {
  // 1. Cookie: cui-token=xxx (manual parsing — no cookie-parser dependency)
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    const match = cookieHeader.split(';').find(c => c.trim().startsWith('cui-token='));
    if (match) {
      const val = match.split('=').slice(1).join('=').trim();
      if (val) return val;
    }
  }

  // 2. Authorization: Bearer xxx
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  return null;
}
