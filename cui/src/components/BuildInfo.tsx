import { useEffect, useState } from 'react';

declare const __BUILD_TIME__: string;

interface BuildInfoData {
  buildTime: string | null;
  distExists: boolean;
}

export function BuildInfo() {
  const [buildInfo, setBuildInfo] = useState<BuildInfoData | null>(null);

  useEffect(() => {
    if ((window as any).__cuiServerAlive === false) return;
    (async () => {
      try {
        const res = await fetch('/api/build-info', { signal: AbortSignal.timeout(8000) });
        if (!res.ok) throw new Error(`[BuildInfo] fetch failed: HTTP ${res.status}`);
        const data = await res.json();
        setBuildInfo(data);
      } catch (err) {
        console.warn('[BuildInfo] fetch build info error:', err);
      }
    })();
  }, []);

  // Use __BUILD_TIME__ from Vite define as fallback
  const displayTime = buildInfo?.buildTime ?? __BUILD_TIME__;

  if (!displayTime) return null;

  const date = new Date(displayTime);
  const formatted = date.toLocaleDateString('de-DE', {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div className="text-xs text-gray-400 flex items-center gap-1">
      <span className="opacity-60">Built:</span>
      <span className="font-mono">{formatted}</span>
    </div>
  );
}
