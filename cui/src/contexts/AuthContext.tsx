/**
 * Auth Context — manages login state, token storage, and user info.
 *
 * When auth is disabled (server has no users.json), everything passes through.
 */

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';

interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'product-owner' | 'fachpartner';
  claudeAccountId: string;
  allowedPanels: string[] | '*';
  allowedWorkspaces: string[] | '*';
  canGitPush: boolean;
  canApproveEdits: boolean;
}

interface AuthState {
  /** null = loading, true = logged in, false = not logged in */
  authenticated: boolean | null;
  /** Current user info (null if not authenticated) */
  user: AuthUser | null;
  /** Is auth enabled on the server? */
  authEnabled: boolean | null;
  /** Partner-CUI deployment (scoped UI — hides admin/dev-only panels) */
  partnerCui: boolean;
  /** Login with email/password */
  login: (email: string, password: string) => Promise<{ ok: boolean; error?: string }>;
  /** Logout */
  logout: () => Promise<void>;
  /** Check if user can access a specific panel */
  canAccessPanel: (panelId: string) => boolean;
  /** Check if user can access a specific workspace */
  canAccessWorkspace: (workspaceId: string) => boolean;
}

// Panels that are hidden on Partner-CUI deployments even from admin users.
const PARTNER_HIDDEN_PANELS = new Set<string>([
  'report-builder',
]);

// API paths that may legitimately return 401 without meaning the session expired.
// The login endpoint returns 401 for wrong password — that's not session-stale.
// /auth/me + /auth/status are read by AuthContext itself; they manage their own state.
const UNAUTH_OK_PATHS = ['/api/auth/login', '/api/auth/me', '/api/auth/status', '/api/auth/logout'];

let interceptorInstalled = false;
function install401Interceptor(onUnauthorized: () => void) {
  if (interceptorInstalled) return;
  interceptorInstalled = true;
  const origFetch = window.fetch.bind(window);
  window.fetch = async (...args: Parameters<typeof fetch>) => {
    const res = await origFetch(...args);
    if (res.status === 401) {
      const url = typeof args[0] === 'string' ? args[0] : args[0] instanceof URL ? args[0].href : (args[0] as Request).url;
      const path = (() => { try { return new URL(url, window.location.href).pathname; } catch { return url; } })();
      const isApi = path.startsWith('/api/');
      const isExempt = UNAUTH_OK_PATHS.some(p => path.startsWith(p));
      if (isApi && !isExempt) onUnauthorized();
    }
    return res;
  };
}

const AuthContext = createContext<AuthState>({
  authenticated: null,
  user: null,
  authEnabled: null,
  partnerCui: false,
  login: async () => ({ ok: false, error: 'Not initialized' }),
  logout: async () => {},
  canAccessPanel: () => true,
  canAccessWorkspace: () => true,
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authEnabled, setAuthEnabled] = useState<boolean | null>(null);
  const [partnerCui, setPartnerCui] = useState<boolean>(false);

  // Check auth status on mount + install global 401 interceptor for stale cookies.
  useEffect(() => {
    checkAuth();
    install401Interceptor(() => {
      // Stale cookie / session expired during use — drop client state so
      // LoginPage shows on next render. Don't re-call /logout (cookie already
      // invalid, would just 401 again).
      setUser(null);
      setAuthenticated(false);
    });
  }, []);

  async function checkAuth() {
    try {
      // First check if auth is even enabled
      const statusRes = await fetch('/api/auth/status', { signal: AbortSignal.timeout(5000) });
      if (statusRes.ok) {
        const status = await statusRes.json();
        setAuthEnabled(status.authEnabled);
        setPartnerCui(status.partnerCui === true);

        if (!status.authEnabled) {
          // Auth disabled — everyone is authenticated
          setAuthenticated(true);
          setUser(null);
          return;
        }
      }

      // Auth is enabled — check if we have a valid session
      const meRes = await fetch('/api/auth/me', { signal: AbortSignal.timeout(5000) });
      if (meRes.ok) {
        const data = await meRes.json();
        setUser(data.user);
        setAuthenticated(true);
      } else {
        setAuthenticated(false);
        setUser(null);
      }
    } catch {
      // Server unreachable — assume auth disabled (dev fallback)
      setAuthEnabled(false);
      setAuthenticated(true);
    }
  }

  const login = useCallback(async (email: string, password: string) => {
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
        signal: AbortSignal.timeout(10000),
      });

      if (res.ok) {
        const data = await res.json();
        setUser(data.user);
        setAuthenticated(true);
        return { ok: true };
      }

      const err = await res.json().catch(() => ({ error: 'Login failed' }));
      return { ok: false, error: err.error || 'Login failed' };
    } catch (e: any) {
      console.error('[Auth] login error:', e);
      return { ok: false, error: e.message || 'Network error' };
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST', signal: AbortSignal.timeout(5000) });
    } catch { /* best effort */ }
    setUser(null);
    setAuthenticated(false);
  }, []);

  const canAccessPanel = useCallback((panelId: string): boolean => {
    if (partnerCui && PARTNER_HIDDEN_PANELS.has(panelId)) return false;
    if (!authEnabled) return true;
    if (!user) return false;
    if (user.allowedPanels === '*') return true;
    return user.allowedPanels.includes(panelId);
  }, [authEnabled, user, partnerCui]);

  const canAccessWorkspace = useCallback((workspaceId: string): boolean => {
    if (!authEnabled) return true;
    if (!user) return false;
    if (user.allowedWorkspaces === '*') return true;
    return user.allowedWorkspaces.includes(workspaceId);
  }, [authEnabled, user]);

  return (
    <AuthContext.Provider value={{ authenticated, user, authEnabled, partnerCui, login, logout, canAccessPanel, canAccessWorkspace }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
