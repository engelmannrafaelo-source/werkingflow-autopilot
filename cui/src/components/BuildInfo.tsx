import { useEffect, useState } from 'react';

declare const __BUILD_TIME__: string;

interface BuildInfoData {
  buildTime: string | null;
  distExists: boolean;
}

export function BuildInfo() {
  const [buildInfo, setBuildInfo] = useState<BuildInfoData | null>(null);

  useEffect(() => {
    fetch('/api/build-info')
      .then(res => res.json())
      .then(data => setBuildInfo(data))
      .catch(err => console.error('[BuildInfo] Failed to fetch build info:', err));
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
