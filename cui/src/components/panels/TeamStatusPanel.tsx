import { useState, useEffect, useCallback, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// ─── Types ───────────────────────────────────────────────────────────────────

interface TeamSection {
  key: string;
  label: string;
  content: string;
}

interface TeamStatusResponse {
  app: string | null;
  sections: TeamSection[];
  fetchedAt: string;
}

const API = '/api/partner';
const AUTO_REFRESH_MS = 5 * 60 * 1000; // 5 minutes

// ─── Panel ───────────────────────────────────────────────────────────────────

export default function TeamStatusPanel() {
  const [data, setData] = useState<TeamStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeSection, setActiveSection] = useState<string>('max');
  const [app, setApp] = useState('');
  const [inputApp, setInputApp] = useState('');
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = useCallback(async (appFilter?: string) => {
    if ((window as unknown as Record<string, unknown>).__cuiServerAlive === false) return;
    try {
      const params = new URLSearchParams();
      if (appFilter) params.set('app', appFilter);
      const res = await fetch(`${API}/team-status?${params}`, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: TeamStatusResponse = await res.json();
      setData(json);
      setError('');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[TeamStatusPanel] fetch failed:', msg);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load + auto-refresh
  useEffect(() => {
    fetchStatus(app || undefined);
    timerRef.current = setInterval(() => fetchStatus(app || undefined), AUTO_REFRESH_MS);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [fetchStatus, app]);

  const handleApplyFilter = useCallback(() => {
    setApp(inputApp.trim());
    setLoading(true);
  }, [inputApp]);

  const handleClearFilter = useCallback(() => {
    setInputApp('');
    setApp('');
    setLoading(true);
  }, []);

  const formatAge = (isoDate: string): string => {
    const age = Date.now() - new Date(isoDate).getTime();
    if (age < 60_000) return 'gerade eben';
    if (age < 3_600_000) return `vor ${Math.round(age / 60_000)} Min`;
    return `vor ${Math.round(age / 3_600_000)} Std`;
  };

  const activeContent = data?.sections.find(s => s.key === activeSection)?.content ?? '';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--tn-bg)' }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '4px 10px',
        background: 'var(--tn-bg-dark)', borderBottom: '1px solid var(--tn-border)',
        height: 34, flexShrink: 0,
      }}>
        <span style={{ fontWeight: 700, fontSize: 12, color: 'var(--tn-cyan)' }}>TEAM STATUS</span>
        {data && (
          <span style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginLeft: 4 }}>
            {formatAge(data.fetchedAt)}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button
          onClick={() => { setLoading(true); fetchStatus(app || undefined); }}
          disabled={loading}
          style={{
            background: 'transparent', color: loading ? 'var(--tn-text-muted)' : 'var(--tn-blue)',
            border: '1px solid var(--tn-border)', borderRadius: 4,
            padding: '2px 8px', fontSize: 11, cursor: loading ? 'wait' : 'pointer',
          }}
        >
          {loading ? '...' : '↺'}
        </button>
      </div>

      {/* App Filter */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px',
        borderBottom: '1px solid var(--tn-border)', flexShrink: 0,
        background: 'var(--tn-surface)',
      }}>
        <span style={{ fontSize: 11, color: 'var(--tn-text-muted)', flexShrink: 0 }}>App-Filter:</span>
        <input
          type="text"
          placeholder="z.B. werking-energy"
          value={inputApp}
          onChange={e => setInputApp(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleApplyFilter()}
          style={{
            flex: 1, background: 'var(--tn-bg)', color: 'var(--tn-text)',
            border: '1px solid var(--tn-border)', borderRadius: 3,
            padding: '3px 6px', fontSize: 11, outline: 'none',
          }}
        />
        <button onClick={handleApplyFilter} style={filterBtnStyle}>Filtern</button>
        {app && (
          <button onClick={handleClearFilter} style={{ ...filterBtnStyle, color: 'var(--tn-text-muted)' }}>
            ✕
          </button>
        )}
        {app && (
          <span style={{
            fontSize: 10, fontWeight: 600, padding: '2px 6px', borderRadius: 3,
            background: 'rgba(122,162,247,0.15)', color: 'var(--tn-blue)',
          }}>
            {app}
          </span>
        )}
      </div>

      {/* Section Tabs */}
      {data && (
        <div style={{
          display: 'flex', gap: 4, padding: '6px 10px 0',
          borderBottom: '1px solid var(--tn-border)', flexShrink: 0,
          background: 'var(--tn-bg-dark)',
        }}>
          {data.sections.map(section => (
            <button
              key={section.key}
              onClick={() => setActiveSection(section.key)}
              style={{
                background: activeSection === section.key ? 'var(--tn-blue)' : 'transparent',
                color: activeSection === section.key ? '#fff' : 'var(--tn-text-muted)',
                border: 'none', borderRadius: '4px 4px 0 0',
                padding: '5px 14px', fontSize: 11, fontWeight: 600,
                cursor: 'pointer', transition: 'all 0.15s',
              }}
            >
              {section.label.split(' — ')[0]}
            </button>
          ))}
        </div>
      )}

      {/* Error */}
      {error && (
        <div style={{ padding: '6px 10px', fontSize: 11, color: '#f7768e', background: 'rgba(247,118,142,0.08)' }}>
          Fehler: {error}
        </div>
      )}

      {/* Content */}
      <div style={{ flex: 1, overflow: 'auto', padding: '10px 12px' }}>
        {loading ? (
          <div style={{ textAlign: 'center', color: 'var(--tn-text-muted)', fontSize: 12, marginTop: 20 }}>
            Lädt Team-Status...
          </div>
        ) : data ? (
          <div style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--tn-text)' }} className="markdown-body">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {activeContent}
            </ReactMarkdown>
          </div>
        ) : null}
      </div>

      {/* Footer */}
      {data && (
        <div style={{
          padding: '3px 10px', fontSize: 10, color: 'var(--tn-text-muted)',
          borderTop: '1px solid var(--tn-border)', flexShrink: 0,
        }}>
          Auto-Refresh alle {AUTO_REFRESH_MS / 60_000} Min
          {app && <span style={{ marginLeft: 8 }}>· Filter: {app}</span>}
        </div>
      )}
    </div>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const filterBtnStyle: React.CSSProperties = {
  background: 'var(--tn-surface)', color: 'var(--tn-blue)',
  border: '1px solid var(--tn-border)', borderRadius: 3,
  padding: '2px 8px', fontSize: 11, cursor: 'pointer',
};
