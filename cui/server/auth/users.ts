/**
 * User Management — loads users.json, validates credentials, provides lookups.
 *
 * Password storage: plain text for now (dev/internal use).
 * For production: switch to bcrypt hashes (prefix '$2' detection is built in).
 */

import { readFileSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import { PATHS } from '../config/paths.js';
import type { CuiUser, UsersConfig } from './types.js';

let _users: CuiUser[] | null = null;
let _usersPath: string | null = null;

/** Get the users.json path */
function getUsersPath(): string {
  if (_usersPath) return _usersPath;
  _usersPath = process.env.CUI_USERS_FILE || join(PATHS.dataDir, 'users.json');
  return _usersPath;
}

/** Load users from disk (cached, call reloadUsers() to refresh) */
export function getUsers(): CuiUser[] {
  if (_users) return _users;
  return reloadUsers();
}

/** Force-reload users from disk */
function reloadUsers(): CuiUser[] {
  const path = getUsersPath();

  if (!existsSync(path)) {
    console.warn(`[Auth] No users.json at ${path} — auth disabled (all requests pass through)`);
    _users = [];
    return _users;
  }

  try {
    const raw = readFileSync(path, 'utf8');
    const config: UsersConfig = JSON.parse(raw);

    if (config.version !== '1.0') {
      throw new Error(`Unsupported users.json version: ${config.version}`);
    }

    _users = config.users.filter(u => u.active);
    console.log(`[Auth] Loaded ${_users.length} active users from ${path}`);
    return _users;
  } catch (err) {
    console.error(`[Auth] Failed to load users.json:`, err);
    _users = [];
    return _users;
  }
}

/** Find a user by ID */
export function findUser(id: string): CuiUser | undefined {
  return getUsers().find(u => u.id === id);
}

/** Find a user by email (case-insensitive) */
export function findUserByEmail(email: string): CuiUser | undefined {
  const lower = email.toLowerCase();
  return getUsers().find(u => u.email.toLowerCase() === lower);
}

/** Verify password against stored hash/plain */
export function verifyPassword(user: CuiUser, password: string): boolean {
  // SHA-256 hash comparison (prefix 'sha256:')
  if (user.passwordHash.startsWith('sha256:')) {
    const hash = createHash('sha256').update(password).digest('hex');
    return user.passwordHash === `sha256:${hash}`;
  }

  // bcrypt prefix — not implemented (no dependency)
  if (user.passwordHash.startsWith('$2')) {
    console.warn(`[Auth] bcrypt not supported for user ${user.id} — use sha256: hashes`);
    return false;
  }

  // Plain text comparison (dev/internal use only)
  return user.passwordHash === password;
}

/** Check if auth is enabled (users.json exists and has users) */
export function isAuthEnabled(): boolean {
  return getUsers().length > 0;
}
