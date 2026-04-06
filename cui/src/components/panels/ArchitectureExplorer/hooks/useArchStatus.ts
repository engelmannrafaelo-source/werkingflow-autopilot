import { useState, useEffect, useCallback, useRef } from 'react';

interface PortStatus {
  status: 'online' | 'offline';
  port: number;
  latency_ms: number | null;
  isBackend: boolean;
}

interface ArchStatusResult {
  timestamp: string;
  healthy: number;
  total: number;
  ports: Record<string, PortStatus>;
}

interface UseArchStatusReturn {
  status: ArchStatusResult | null;
  loading: boolean;
  isOnline: (appId: string) => boolean | null;
  getLatency: (appId: string) => number | null;
  refetch: () => void;
}

export function useArchStatus(pollIntervalMs = 30000): UseArchStatusReturn {
  const [status, setStatus] = useState<ArchStatusResult | null>(null);
  const [loading, setLoading] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const doFetch = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/architecture/status');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setStatus(data);
    } catch (err) {
      console.warn('[useArchStatus] fetch error:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    doFetch();
    timerRef.current = setInterval(doFetch, pollIntervalMs);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [doFetch, pollIntervalMs]);

  const isOnline = useCallback((appId: string): boolean | null => {
    if (!status?.ports) return null;
    const entry = status.ports[appId];
    return entry ? entry.status === 'online' : null;
  }, [status]);

  const getLatency = useCallback((appId: string): number | null => {
    return status?.ports?.[appId]?.latency_ms ?? null;
  }, [status]);

  return { status, loading, isOnline, getLatency, refetch: doFetch };
}
