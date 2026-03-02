import { useState, useEffect } from 'react';

const API = '/api';
const LINKEDIN_FILE = '/root/orchestrator/workspaces/team/linkedin-marketing-app.html';

export default function LinkedInPanel() {
  const [html, setHtml] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if ((window as any).__cuiServerAlive === false) return;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await fetch(`${API}/file?path=${encodeURIComponent(LINKEDIN_FILE)}`, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) throw new Error(`[LinkedInPanel] load file failed: HTTP ${res.status}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        setHtml(data.content);
      } catch (err: any) {
        console.warn('[LinkedInPanel] load error:', err);
        setError(err.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--tn-text-muted)', fontSize: 14 }}>
        LinkedIn Marketing wird geladen...
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: 20, color: '#E53E3E', fontSize: 14 }}>
        Fehler: {error}
      </div>
    );
  }

  return (
    <iframe
      srcDoc={html}
      style={{ flex: 1, border: 'none', width: '100%', height: '100%' }}
      sandbox="allow-scripts"
    />
  );
}
