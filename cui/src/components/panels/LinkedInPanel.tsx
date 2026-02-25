import { useState, useEffect } from 'react';

const API = '/api';
const LINKEDIN_FILE = '/root/orchestrator/workspaces/team/linkedin-marketing-app.html';

export default function LinkedInPanel() {
  const [html, setHtml] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(`${API}/file?path=${encodeURIComponent(LINKEDIN_FILE)}`)
      .then(r => r.json())
      .then(data => {
        if (data.error) throw new Error(data.error);
        setHtml(data.content);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
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
