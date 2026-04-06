/**
 * Minimal JWT implementation using Node's built-in crypto.
 *
 * HMAC-SHA256 signing — no external dependencies.
 * Sufficient for server-side session tokens (not distributed auth).
 */

import { createHmac, randomBytes } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import type { JwtPayload } from './types.js';

// Secret: from env, machine-id, or random (cached after first call)
let _secret: string | null = null;

function getSecret(): string {
  if (_secret) return _secret;

  // 1. Explicit env var (recommended for partner servers)
  const envSecret = process.env.CUI_JWT_SECRET;
  if (envSecret && envSecret.length >= 32) {
    _secret = envSecret;
    return _secret;
  }

  // 2. Derive from machine-id (consistent across restarts, unique per server)
  const machineIdPath = '/etc/machine-id';
  if (existsSync(machineIdPath)) {
    const machineId = readFileSync(machineIdPath, 'utf8').trim();
    _secret = createHmac('sha256', 'cui-jwt-salt').update(machineId).digest('hex');
    return _secret;
  }

  // 3. Random (tokens invalidated on restart)
  console.warn('[Auth] No CUI_JWT_SECRET and no /etc/machine-id — using random secret (tokens reset on restart)');
  _secret = randomBytes(32).toString('hex');
  return _secret;
}

function base64url(data: string | Buffer): string {
  const b64 = typeof data === 'string'
    ? Buffer.from(data).toString('base64')
    : data.toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(str: string): string {
  const padded = str + '='.repeat((4 - str.length % 4) % 4);
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

/** Sign a JWT payload, returning the compact token string */
export function signJwt(payload: Omit<JwtPayload, 'iat' | 'exp'>, expiresInDays = 7): string {
  const secret = getSecret();
  const now = Math.floor(Date.now() / 1000);

  const fullPayload: JwtPayload = {
    ...payload,
    iat: now,
    exp: now + expiresInDays * 86400,
  };

  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify(fullPayload));
  const signature = base64url(
    createHmac('sha256', secret).update(`${header}.${body}`).digest()
  );

  return `${header}.${body}.${signature}`;
}

/** Verify a JWT token, returning the payload or null */
export function verifyJwt(token: string): JwtPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [header, body, signature] = parts;
    const secret = getSecret();

    // Verify signature
    const expected = base64url(
      createHmac('sha256', secret).update(`${header}.${body}`).digest()
    );
    if (signature !== expected) return null;

    // Decode payload
    const payload: JwtPayload = JSON.parse(base64urlDecode(body));

    // Check expiry
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) return null;

    return payload;
  } catch {
    return null;
  }
}
