import React, { useState, useEffect } from 'react';

interface DocEntry {
  name: string;
  ageDays: number;
  level: 'fresh' | 'warning' | 'stale';
}

interface ClaudeMdStatus {
  ageDays: number;
  level: 'fresh' | 'warning' | 'stale';
}

const LEVEL_STYLE: Record<string, { bg: string; color: string; border: string }> = {
  fresh:   { bg: 'rgba(158,206,106,0.18)', color: '#9ece6a', border: 'rgba(158,206,106,0.4)' },
  warning: { bg: 'rgba(224,175,104,0.18)', color: '#e0af68', border: 'rgba(224,175,104,0.4)' },
  stale:   { bg: 'rgba(247,118,142,0.18)', color: '#f7768e', border: 'rgba(247,118,142,0.4)' },
};

export default function DocsTab() {
  const [refs, setRefs] = useState<DocEntry[]>([]);
  const [businessDocs, setBusinessDocs] = useState<DocEntry[]>([]);
  const [claudeMd, setClaudeMd] = useState<ClaudeMdStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [showAllBusiness, setShowAllBusiness] = useState(false);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    if ((window as any).__cuiServerAlive === false) return;
    setLoading(true);
    try {
      const res = await fetch('/api/maintenance/status', { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setRefs(data.docs?.refs ?? []);
      setBusinessDocs(data.docs?.businessDocs ?? []);
      setClaudeMd(data.docs?.claudeMd ?? null);
    } catch (err) {
      console.warn('[DocsTab] fetch failed:', err);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return <div style={{ padding: 20, color: 'var(--tn-text-muted)', fontSize: 11 }}>Loading docs status...</div>;
  }

  const staleRefs = refs.filter(r => r.level === 'stale');
  const freshRefs = refs.filter(r => r.level !== 'stale');

  const visibleBusiness = showAllBusiness ? businessDocs : businessDocs.filter(d => d.level !== 'fresh');

  return (
    <div data-ai-id="maintenance-docs-tab" style={{ padding: 12 }}>
      {/* CLAUDE.md Status */}
      {claudeMd && (
        <div style={{
          marginBottom: 16,
          padding: '10px 12px',
          background: LEVEL_STYLE[claudeMd.level].bg,
          border: `1px solid ${LEVEL_STYLE[claudeMd.level].border}`,
          borderRadius: 6,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}>
          <span style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: LEVEL_STYLE[claudeMd.level].color,
          }} />
          <span style={{ fontSize: 13, fontWeight: 700, color: '#c0caf5' }}>
            CLAUDE.md
          </span>
          <span style={{
            fontSize: 10,
            color: LEVEL_STYLE[claudeMd.level].color,
            fontWeight: 600,
            fontFamily: 'monospace',
            marginLeft: 'auto',
          }}>
            {claudeMd.ageDays}d ago
          </span>
        </div>
      )}

      {/* Refs Section */}
      <div style={{ marginBottom: 16 }}>
        <div style={{
          fontSize: 11,
          fontWeight: 700,
          color: 'var(--tn-text-muted)',
          marginBottom: 8,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}>
          refs/
          {staleRefs.length > 0 && (
            <span style={{
              fontSize: 9,
              fontWeight: 700,
              padding: '1px 5px',
              borderRadius: 3,
              background: 'rgba(247,118,142,0.25)',
              color: '#f7768e',
              border: '1px solid rgba(247,118,142,0.4)',
            }}>
              {staleRefs.length} stale
            </span>
          )}
        </div>

        <table style={{
          width: '100%',
          borderCollapse: 'collapse',
          fontSize: 11,
          fontFamily: 'monospace',
          border: '1px solid var(--tn-border)',
        }}>
          <thead>
            <tr style={{ background: 'var(--tn-bg-dark)' }}>
              <th style={{ padding: '6px 8px', textAlign: 'left', color: 'var(--tn-text-muted)', fontWeight: 600 }}>File</th>
              <th style={{ padding: '6px 8px', textAlign: 'right', color: 'var(--tn-text-muted)', fontWeight: 600, width: 60 }}>Age</th>
              <th style={{ padding: '6px 8px', textAlign: 'center', color: 'var(--tn-text-muted)', fontWeight: 600, width: 60 }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {refs.map(ref => {
              const style = LEVEL_STYLE[ref.level];
              return (
                <tr key={ref.name} style={{ background: ref.level === 'stale' ? style.bg : 'transparent' }}>
                  <td style={{ padding: '6px 8px', color: '#c0caf5' }}>{ref.name}</td>
                  <td style={{ padding: '6px 8px', textAlign: 'right', color: style.color, fontWeight: 600 }}>
                    {ref.ageDays}d
                  </td>
                  <td style={{ padding: '6px 8px', textAlign: 'center' }}>
                    <span style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: style.color,
                      display: 'inline-block',
                    }} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Business Docs Section */}
      <div>
        <div style={{
          fontSize: 11,
          fontWeight: 700,
          color: 'var(--tn-text-muted)',
          marginBottom: 8,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}>
          business/
          {businessDocs.filter(d => d.level === 'stale').length > 0 && (
            <span style={{
              fontSize: 9,
              fontWeight: 700,
              padding: '1px 5px',
              borderRadius: 3,
              background: 'rgba(247,118,142,0.25)',
              color: '#f7768e',
              border: '1px solid rgba(247,118,142,0.4)',
            }}>
              {businessDocs.filter(d => d.level === 'stale').length} stale
            </span>
          )}
          <button
            onClick={() => setShowAllBusiness(!showAllBusiness)}
            style={{
              marginLeft: 'auto',
              background: 'transparent',
              border: '1px solid var(--tn-border)',
              borderRadius: 3,
              padding: '2px 6px',
              fontSize: 9,
              color: 'var(--tn-text-muted)',
              cursor: 'pointer',
            }}
          >
            {showAllBusiness ? 'Show issues only' : `Show all (${businessDocs.length})`}
          </button>
        </div>

        {visibleBusiness.length === 0 ? (
          <div style={{ fontSize: 11, color: 'var(--tn-text-muted)', padding: '8px 0' }}>
            All business docs are fresh.
          </div>
        ) : (
          <table style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontSize: 11,
            fontFamily: 'monospace',
            border: '1px solid var(--tn-border)',
          }}>
            <thead>
              <tr style={{ background: 'var(--tn-bg-dark)' }}>
                <th style={{ padding: '6px 8px', textAlign: 'left', color: 'var(--tn-text-muted)', fontWeight: 600 }}>Document</th>
                <th style={{ padding: '6px 8px', textAlign: 'right', color: 'var(--tn-text-muted)', fontWeight: 600, width: 60 }}>Age</th>
                <th style={{ padding: '6px 8px', textAlign: 'center', color: 'var(--tn-text-muted)', fontWeight: 600, width: 60 }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {visibleBusiness.map(doc => {
                const style = LEVEL_STYLE[doc.level];
                return (
                  <tr key={doc.name} style={{ background: doc.level === 'stale' ? style.bg : 'transparent' }}>
                    <td style={{ padding: '6px 8px', color: '#c0caf5' }}>{doc.name}</td>
                    <td style={{ padding: '6px 8px', textAlign: 'right', color: style.color, fontWeight: 600 }}>
                      {doc.ageDays}d
                    </td>
                    <td style={{ padding: '6px 8px', textAlign: 'center' }}>
                      <span style={{
                        width: 6,
                        height: 6,
                        borderRadius: '50%',
                        background: style.color,
                        display: 'inline-block',
                      }} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
