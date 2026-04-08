/**
 * Peer Awareness Panel — Shows what parallel Claude sessions are working on.
 *
 * Reads from /api/peer-awareness (which serves active-work.md).
 * Auto-refreshes every 60s, manual refresh via button.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const API = '/api';
const AUTO_REFRESH_MS = 60_000; // 1 minute frontend refresh

interface PeerData {
  content: string;
  filePath: string;
  lastTickAt: string | null;
  activeSessions: number;
  recentSessions: number;
  intervalMs: number;
}

export default function PeerAwarenessPanel() {
  const [data, setData] = useState<PeerData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchData = useCallback(async () => {
    if ((window as unknown as Record<string, unknown>).__cuiServerAlive === false) return;
    try {
      const res = await fetch(`${API}/peer-awareness`, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
      setError('');
    } catch (err) {
      console.warn('[PeerAwareness] fetch failed:', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load + auto-refresh
  useEffect(() => {
    fetchData();
    timerRef.current = setInterval(fetchData, AUTO_REFRESH_MS);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [fetchData]);

  // Manual refresh (triggers server-side Bridge call)
  const handleRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const res = await fetch(`${API}/peer-awareness/refresh`, {
        method: 'POST',
        signal: AbortSignal.timeout(45000), // Bridge can take up to 30s
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData({
        content: json.content,
        filePath: data?.filePath || '',
        lastTickAt: json.lastTickAt,
        activeSessions: json.activeSessions,
        recentSessions: json.recentSessions,
        intervalMs: data?.intervalMs || 300000,
      });
      setError('');
    } catch (err) {
      console.warn('[PeerAwareness] refresh failed:', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  }, [refreshing, data]);

  const formatAge = (isoDate: string | null): string => {
    if (!isoDate) return 'nie';
    const age = Date.now() - new Date(isoDate).getTime();
    if (age < 60000) return 'gerade eben';
    if (age < 3600000) return `vor ${Math.round(age / 60000)}min`;
    return `vor ${Math.round(age / 3600000)}h`;
  };

  if (loading) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--tn-text-muted)', fontSize: 11 }}>
        Loading peer awareness...
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--tn-bg)' }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px',
        background: 'var(--tn-bg-dark)', borderBottom: '1px solid var(--tn-border)',
        height: 30, flexShrink: 0, fontSize: 11,
      }}>
        <span style={{ fontWeight: 600, color: 'var(--tn-cyan)', fontSize: 12 }}>
          PEER AWARENESS
        </span>
        <span style={{ color: 'var(--tn-text-muted)' }}>
          {data?.activeSessions ?? 0} aktiv
          {(data?.recentSessions ?? 0) > 0 && ` + ${data?.recentSessions} recent`}
        </span>
        <span style={{ color: 'var(--tn-text-muted)', marginLeft: 'auto' }}>
          {formatAge(data?.lastTickAt ?? null)}
        </span>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          style={{
            background: refreshing ? 'var(--tn-bg-highlight)' : 'var(--tn-surface)',
            color: refreshing ? 'var(--tn-text-muted)' : 'var(--tn-blue)',
            border: '1px solid var(--tn-border)',
            borderRadius: 3, padding: '1px 8px', fontSize: 11, cursor: refreshing ? 'wait' : 'pointer',
          }}
        >
          {refreshing ? 'Updating...' : 'Refresh'}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div style={{
          padding: '4px 8px', fontSize: 11, background: 'rgba(247, 118, 142, 0.1)',
          borderBottom: '1px solid rgba(247, 118, 142, 0.3)', color: '#f7768e',
        }}>
          Error: {error}
        </div>
      )}

      {/* Content */}
      <div style={{
        flex: 1, overflow: 'auto', padding: '8px 12px',
        fontSize: 12, lineHeight: 1.5, color: 'var(--tn-text)',
      }}>
        {data?.content ? (
          <div className="peer-awareness-md">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                h1: ({node, ...props}) => <h1 style={{ fontSize: 18, fontWeight: 700, color: 'var(--tn-text)', marginTop: 16, marginBottom: 8, borderBottom: '1px solid var(--tn-border)', paddingBottom: 4 }} {...props} />,
                h2: ({node, ...props}) => <h2 style={{ fontSize: 14, fontWeight: 600, color: 'var(--tn-cyan)', marginTop: 12, marginBottom: 6 }} {...props} />,
                h3: ({node, ...props}) => <h3 style={{ fontSize: 12, fontWeight: 600, color: 'var(--tn-blue)', marginTop: 8, marginBottom: 4 }} {...props} />,
                p: ({node, ...props}) => <p style={{ margin: '4px 0', fontSize: 12 }} {...props} />,
                table: ({node, ...props}) => <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, margin: '8px 0' }} {...props} />,
                th: ({node, ...props}) => <th style={{ textAlign: 'left', padding: '4px 8px', borderBottom: '2px solid var(--tn-border)', color: 'var(--tn-text)', fontWeight: 600, background: 'var(--tn-bg-dark)' }} {...props} />,
                td: ({node, ...props}) => <td style={{ padding: '3px 8px', borderBottom: '1px solid var(--tn-border)', color: 'var(--tn-text-subtle)' }} {...props} />,
                code: ({node, ...props}) => <code style={{ background: 'var(--tn-bg-highlight)', padding: '1px 4px', borderRadius: 3, fontSize: 11, color: 'var(--tn-orange)' }} {...props} />,
                strong: ({node, ...props}) => <strong style={{ fontWeight: 600, color: 'var(--tn-text)' }} {...props} />,
                em: ({node, ...props}) => <em style={{ color: 'var(--tn-text-muted)' }} {...props} />,
                li: ({node, ...props}) => <li style={{ margin: '2px 0', fontSize: 12 }} {...props} />,
                ul: ({node, ...props}) => <ul style={{ margin: '4px 0', paddingLeft: 20 }} {...props} />,
                ol: ({node, ...props}) => <ol style={{ margin: '4px 0', paddingLeft: 20 }} {...props} />,
              }}
            >
              {data.content}
            </ReactMarkdown>
          </div>
        ) : (
          <p style={{ color: 'var(--tn-text-muted)', fontStyle: 'italic' }}>
            Noch keine Daten. Erstes Update kommt 30s nach Serverstart.
          </p>
        )}
      </div>

      {/* Footer */}
      <div style={{
        padding: '2px 8px', fontSize: 10, color: 'var(--tn-text-muted)',
        borderTop: '1px solid var(--tn-border)', background: 'var(--tn-bg-dark)',
        display: 'flex', gap: 8,
      }}>
        <span>Auto-Update: {(data?.intervalMs ?? 300000) / 1000}s (Server) / {AUTO_REFRESH_MS / 1000}s (Panel)</span>
        {data?.filePath && <span style={{ marginLeft: 'auto' }}>{data.filePath}</span>}
      </div>
    </div>
  );
}
