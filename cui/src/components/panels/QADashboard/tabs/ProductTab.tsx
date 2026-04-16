import React, { useState, useEffect } from 'react';
import { resilientFetch } from '../../../../utils/resilientFetch';
import { validateApiResponse } from '../../../../lib/validateApiResponse';

const APP_IDS = ['werking-report', 'engelmann', 'werking-energy', 'werking-safety', 'acro-community'];
const APP_NAMES: Record<string, string> = {
  'werking-report': 'WerkING Report',
  'engelmann': 'Engelmann AI Hub',
  'werking-energy': 'WerkING Energy',
  'werking-safety': 'WerkING Safety',
  'acro-community': 'Acro Community',
};

interface ProductData {
  appId: string;
  displayName?: string;
  content?: string;
  modified?: string;
  wordCount?: number;
}

interface AppInfo {
  appId: string;
  displayName?: string;
  exists?: boolean;
  modified?: string | null;
  wordCount?: number;
}

interface AppListResponse {
  apps: AppInfo[];
}

function renderMarkdown(md: string): string {
  return md
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>[\s\S]*?<\/li>)(?=\s*(?:<li>|$))/g, (match) => {
      // Only wrap consecutive li elements not already in ul
      return match;
    })
    .replace(/((?:<li>[^]*?<\/li>\s*)+)/g, '<ul>$1</ul>')
    .replace(/^---$/gm, '<hr/>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\n\n/g, '<br/><br/>');
}

export default function ProductTab() {
  const [selectedApp, setSelectedApp] = useState(APP_IDS[0]);
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [data, setData] = useState<ProductData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [regenResult, setRegenResult] = useState<{ message: string; logFile?: string } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const handleRegenerate = async () => {
    setRegenerating(true);
    setRegenResult(null);
    try {
      const res = await resilientFetch(`/api/qa/product-docs/${selectedApp}/regenerate`, { method: 'POST' });
      const json = await res.json();
      if (!res.ok) {
        setRegenResult({ message: `Fehler: ${json.error || 'Unbekannt'}` });
        return;
      }
      setRegenResult({ message: json.message, logFile: json.logFile });
      // Poll for completion: check every 5s if PRODUCT.md was updated
      const checkInterval = setInterval(async () => {
        try {
          const check = await resilientFetch(`/api/qa/product-docs/${selectedApp}`);
          if (check.ok) {
            const doc = await check.json();
            const modTime = new Date(doc.modified).getTime();
            if (modTime > Date.now() - 10000) {
              clearInterval(checkInterval);
              setRegenerating(false);
              setRegenResult(null);
              setReloadKey(k => k + 1);
            }
          }
        } catch {}
      }, 5000);
      // Stop polling after 5 minutes max
      setTimeout(() => {
        clearInterval(checkInterval);
        setRegenerating(false);
      }, 300000);
    } catch (err: any) {
      setRegenResult({ message: `Fehler: ${err.message}` });
      setRegenerating(false);
    }
  };

  // Load app list
  useEffect(() => {
    (async () => {
      try {
        const res = await resilientFetch('/api/qa/product-docs');
        if (!res.ok) return;
        const raw = await res.json();
        const json = validateApiResponse<AppListResponse>(raw, '/api/qa/product-docs', {
          apps: 'array',
        });
        setApps(json.apps);
      } catch {}
    })();
  }, []);

  // Load product doc for selected app
  useEffect(() => {
    setLoading(true);
    setError(null);
    setData(null);

    (async () => {
      try {
        const res = await resilientFetch(`/api/qa/product-docs/${selectedApp}`);
        if (!res.ok) {
          const json = await res.json().catch(() => ({}));
          setError(json.hint || `PRODUCT.md nicht gefunden fuer ${selectedApp}`);
          return;
        }
        const raw = await res.json();
        const validated = validateApiResponse<ProductData>(raw, `/api/qa/product-docs/${selectedApp}`, {
          appId: 'string',
        });
        setData(validated);
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [selectedApp, reloadKey]);

  // Reload app list when reloadKey changes
  useEffect(() => {
    if (reloadKey === 0) return;
    (async () => {
      try {
        const res = await resilientFetch('/api/qa/product-docs');
        if (!res.ok) return;
        const raw = await res.json();
        const json = validateApiResponse<AppListResponse>(raw, '/api/qa/product-docs', {
          apps: 'array',
        });
        setApps(json.apps);
      } catch {}
    })();
  }, [reloadKey]);

  const appInfo = apps.find(a => a.appId === selectedApp);

  return (
    <div data-ai-id="qa-product-tab" style={{ padding: 12, height: '100%', display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
        <select
          data-ai-id="qa-product-app-selector"
          value={selectedApp}
          onChange={e => setSelectedApp(e.target.value)}
          style={{
            background: 'var(--tn-bg-dark)',
            color: 'var(--tn-text)',
            border: '1px solid var(--tn-border)',
            padding: '6px 10px',
            borderRadius: 4,
            fontSize: 12,
          }}
        >
          {APP_IDS.map(id => (
            <option key={id} value={id}>{APP_NAMES[id] || id}</option>
          ))}
        </select>

        {/* Status badges */}
        {apps.map(a => (
          <span
            key={a.appId}
            onClick={() => setSelectedApp(a.appId)}
            style={{
              fontSize: 10,
              fontWeight: 600,
              padding: '2px 8px',
              borderRadius: 3,
              cursor: 'pointer',
              background: (a.exists ?? false)
                ? (a.appId) === selectedApp ? 'rgba(158,206,106,0.25)' : 'rgba(158,206,106,0.1)'
                : 'rgba(247,118,142,0.1)',
              color: (a.exists ?? false) ? 'var(--tn-green)' : 'var(--tn-red)',
              border: (a.appId) === selectedApp ? '1px solid var(--tn-green)' : '1px solid transparent',
            }}
          >
            {a.displayName?.split(' ').pop() || (a.appId)}
            {(a.exists ?? false) && ` (${a.wordCount ?? 0}w)`}
          </span>
        ))}

        {/* Regenerate button */}
        <button
          data-ai-id="qa-product-regenerate"
          onClick={handleRegenerate}
          disabled={regenerating}
          style={{
            marginLeft: 'auto',
            background: regenerating ? 'rgba(255,158,100,0.15)' : 'rgba(255,158,100,0.1)',
            color: regenerating ? 'var(--tn-text-muted)' : 'var(--tn-orange)',
            border: '1px solid var(--tn-orange)',
            padding: '4px 12px',
            borderRadius: 4,
            fontSize: 11,
            fontWeight: 600,
            cursor: regenerating ? 'not-allowed' : 'pointer',
            opacity: regenerating ? 0.6 : 1,
          }}
        >
          {regenerating ? 'Generiert...' : 'Neu generieren'}
        </button>
      </div>

      {/* Regeneration status */}
      {regenResult && (
        <div style={{ fontSize: 11, padding: '4px 8px', borderRadius: 4, background: 'rgba(255,158,100,0.08)', color: 'var(--tn-orange)', flexShrink: 0 }}>
          {regenResult.message}
          {regenResult.logFile && <span style={{ marginLeft: 8, color: 'var(--tn-text-muted)', fontSize: 10 }}>Log: {regenResult.logFile}</span>}
        </div>
      )}

      {/* Meta info */}
      {data && (
        <div style={{ display: 'flex', gap: 16, fontSize: 11, color: 'var(--tn-text-muted)', flexShrink: 0 }}>
          <span><strong style={{ color: 'var(--tn-blue)' }}>{data.wordCount ?? 0}</strong> Woerter</span>
          <span>Aktualisiert: {new Date(data.modified ?? '').toLocaleString('de-AT')}</span>
        </div>
      )}

      {/* Content */}
      <div style={{
        flex: 1,
        overflow: 'auto',
        background: 'var(--tn-bg-dark)',
        borderRadius: 6,
        border: '1px solid var(--tn-border)',
      }}>
        {loading && (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--tn-text-muted)' }}>
            Lade Produktbeschreibung...
          </div>
        )}

        {error && (
          <div style={{ padding: 40, textAlign: 'center' }}>
            <div style={{ color: 'var(--tn-orange)', marginBottom: 12 }}>{error}</div>
            <code style={{
              fontSize: 11,
              background: 'rgba(255,255,255,0.05)',
              padding: '4px 10px',
              borderRadius: 4,
              color: 'var(--tn-text-muted)',
            }}>
              python3 tools/generate_product_docs.py --app {selectedApp}
            </code>
          </div>
        )}

        {data && !loading && (
          <div
            data-ai-id="qa-product-content"
            style={{ padding: '20px 24px', lineHeight: 1.7, fontSize: 13 }}
            dangerouslySetInnerHTML={{ __html: renderMarkdown(data.content ?? '') }}
          />
        )}
      </div>

      <style>{`
        [data-ai-id="qa-product-content"] h1 {
          color: var(--tn-orange);
          font-size: 18px;
          margin: 0 0 8px 0;
          padding-bottom: 8px;
          border-bottom: 1px solid var(--tn-border);
        }
        [data-ai-id="qa-product-content"] h2 {
          color: var(--tn-blue);
          font-size: 15px;
          margin: 20px 0 8px 0;
        }
        [data-ai-id="qa-product-content"] h3 {
          color: var(--tn-purple);
          font-size: 13px;
          margin: 16px 0 6px 0;
        }
        [data-ai-id="qa-product-content"] ul {
          padding-left: 20px;
          margin: 8px 0;
        }
        [data-ai-id="qa-product-content"] li {
          color: var(--tn-text);
          margin-bottom: 3px;
        }
        [data-ai-id="qa-product-content"] li::marker {
          color: var(--tn-orange);
        }
        [data-ai-id="qa-product-content"] strong {
          color: var(--tn-text);
        }
        [data-ai-id="qa-product-content"] code {
          background: rgba(255,255,255,0.06);
          padding: 1px 5px;
          border-radius: 3px;
          font-size: 12px;
        }
        [data-ai-id="qa-product-content"] hr {
          border: none;
          border-top: 1px solid var(--tn-border);
          margin: 16px 0;
        }
      `}</style>
    </div>
  );
}
