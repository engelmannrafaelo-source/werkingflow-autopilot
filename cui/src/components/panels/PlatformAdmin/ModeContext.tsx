import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

// Mode classifies tenants into prod (paying customers), staging (demos/tests),
// local (your personal dev tenants). Bridge endpoints take ?mode= to filter.
// Persisted in localStorage so the choice survives panel re-mount.

export type PlatformMode = 'all' | 'prod' | 'staging' | 'local';

const STORAGE_KEY = 'platform-admin-mode';

function loadMode(): PlatformMode {
  if (typeof window === 'undefined') return 'all';
  const v = window.localStorage.getItem(STORAGE_KEY);
  return (v === 'prod' || v === 'staging' || v === 'local') ? v : 'all';
}

interface ModeContextValue {
  mode: PlatformMode;
  setMode: (m: PlatformMode) => void;
  /** Append &mode=X to a URL when mode is set (not 'all'). */
  withMode: (path: string) => string;
}

const ModeContext = createContext<ModeContextValue | null>(null);

export function ModeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<PlatformMode>(loadMode);

  const setMode = useCallback((m: PlatformMode) => {
    setModeState(m);
    try { window.localStorage.setItem(STORAGE_KEY, m); } catch { /* ignore quota */ }
  }, []);

  const withMode = useCallback((path: string) => {
    if (mode === 'all') return path;
    const sep = path.includes('?') ? '&' : '?';
    return `${path}${sep}mode=${mode}`;
  }, [mode]);

  return (
    <ModeContext.Provider value={{ mode, setMode, withMode }}>
      {children}
    </ModeContext.Provider>
  );
}

export function usePlatformMode(): ModeContextValue {
  const ctx = useContext(ModeContext);
  if (!ctx) {
    // Used outside provider — return safe defaults so tabs degrade gracefully.
    return {
      mode: 'all',
      setMode: () => { /* noop */ },
      withMode: (p) => p,
    };
  }
  return ctx;
}
