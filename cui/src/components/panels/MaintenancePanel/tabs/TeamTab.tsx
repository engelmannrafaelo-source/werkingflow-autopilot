import React, { useState, useEffect } from 'react';

interface WorklistEntry {
  name: string;
  ageDays: number;
  level: 'fresh' | 'warning' | 'stale';
}

const LEVEL_STYLE: Record<string, { bg: string; color: string; border: string; label: string }> = {
  fresh:   { bg: 'rgba(158,206,106,0.18)', color: '#9ece6a', border: 'rgba(158,206,106,0.4)',  label: 'fresh' },
  warning: { bg: 'rgba(224,175,104,0.18)', color: '#e0af68', border: 'rgba(224,175,104,0.4)', label: 'warning' },
  stale:   { bg: 'rgba(247,118,142,0.18)', color: '#f7768e', border: 'rgba(247,118,142,0.4)', label: 'stale' },
};

const LEADERS = ['max', 'herbert', 'vera', 'finn', 'felix'];
const LEADER_ROLES: Record<string, string> = {
  max: 'CTO',
  herbert: 'CSO',
  vera: 'CCO',
  finn: 'CFO',
  felix: 'CIO',
};

export default function TeamTab() {
  const [worklists, setWorklists] = useState<WorklistEntry[]>([]);
  const [loading, setLoading] = useState(true);

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
      setWorklists(data.team?.worklists ?? []);
    } catch (err) {
      console.warn('[TeamTab] fetch failed:', err);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return <div style={{ padding: 20, color: 'var(--tn-text-muted)', fontSize: 11 }}>Loading team status...</div>;
  }

  // Split into leaders vs other worklists
  const leaderWorklists = worklists.filter(w => LEADERS.includes(w.name.replace('.md', '')));
  const otherWorklists = worklists.filter(w => !LEADERS.includes(w.name.replace('.md', '')));

  return (
    <div data-ai-id="maintenance-team-tab" style={{ padding: 12 }}>
      {/* Leader Grid */}
      <div style={{ marginBottom: 16 }}>
        <div style={{
          fontSize: 11,
          fontWeight: 700,
          color: 'var(--tn-text-muted)',
          marginBottom: 8,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
        }}>
          Team Leaders
        </div>

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
          gap: 8,
        }}>
          {LEADERS.map(leader => {
            const wl = leaderWorklists.find(w => w.name.replace('.md', '') === leader);
            const style = LEVEL_STYLE[wl?.level ?? 'stale'];
            const days = wl?.ageDays ?? -1;

            return (
              <div
                key={leader}
                style={{
                  background: style.bg,
                  border: `1px solid ${style.border}`,
                  borderRadius: 6,
                  padding: '10px 12px',
                }}
              >
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  marginBottom: 4,
                }}>
                  <span style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: style.color,
                    flexShrink: 0,
                  }} />
                  <span style={{
                    fontSize: 12,
                    fontWeight: 700,
                    color: '#c0caf5',
                    textTransform: 'capitalize',
                  }}>
                    {leader}
                  </span>
                  <span style={{
                    fontSize: 9,
                    color: '#565f89',
                    marginLeft: 'auto',
                    fontWeight: 600,
                  }}>
                    {LEADER_ROLES[leader]}
                  </span>
                </div>

                <div style={{
                  fontSize: 10,
                  color: style.color,
                  fontWeight: 600,
                  fontFamily: 'monospace',
                }}>
                  {days >= 0 ? `${days}d ago` : 'unknown'}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Other Worklists */}
      {otherWorklists.length > 0 && (
        <div>
          <div style={{
            fontSize: 11,
            fontWeight: 700,
            color: 'var(--tn-text-muted)',
            marginBottom: 8,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}>
            Other Worklists
          </div>

          <table style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontSize: 11,
            fontFamily: 'monospace',
          }}>
            <tbody>
              {otherWorklists.map(wl => {
                const style = LEVEL_STYLE[wl.level];
                return (
                  <tr key={wl.name} style={{ borderBottom: '1px solid var(--tn-border)' }}>
                    <td style={{ padding: '6px 8px', color: '#c0caf5' }}>
                      {wl.name}
                    </td>
                    <td style={{ padding: '6px 8px', textAlign: 'right' }}>
                      <span style={{
                        fontSize: 10,
                        fontWeight: 700,
                        padding: '2px 8px',
                        borderRadius: 3,
                        background: style.bg,
                        color: style.color,
                        border: `1px solid ${style.border}`,
                      }}>
                        {wl.ageDays}d
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
