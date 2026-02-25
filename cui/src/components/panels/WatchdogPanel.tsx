import { memo } from 'react';

/** Dev Server Watchdog — proxied through CUI server (/watchdog → remote:9090) */
export default memo(function WatchdogPanel() {
  return (
    <iframe
      src="/watchdog/"
      style={{ width: '100%', height: '100%', border: 'none', background: '#0d1117' }}
      title="Dev Server Watchdog"
    />
  );
});
