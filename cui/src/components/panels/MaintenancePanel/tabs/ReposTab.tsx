import React, { useState, useEffect } from 'react';

interface RepoStatus {
  name: string;
  path: string;
  status: {
    branch: string;
    dirty: number;
    unpushed: number;
  };
}

export default function ReposTab() {
  const [repos, setRepos] = useState<RepoStatus[]>([]);
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
      setRepos(data.repos ?? []);
    } catch (err) {
      console.warn('[ReposTab] fetch failed:', err);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return <div style={{ padding: 20, color: 'var(--tn-text-muted)', fontSize: 11 }}>Loading repos status...</div>;
  }

  return (
    <div data-ai-id="maintenance-repos-tab" style={{ padding: 12 }}>
      <div style={{
        fontSize: 11,
        fontWeight: 700,
        color: 'var(--tn-text-muted)',
        marginBottom: 8,
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
      }}>
        Git Repositories
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {repos.map(repo => {
          const isClean = repo.status.dirty === 0 && repo.status.unpushed === 0;
          const isMissing = repo.status.dirty === -1;

          return (
            <div
              key={repo.name}
              style={{
                background: isMissing
                  ? 'rgba(247,118,142,0.18)'
                  : isClean
                    ? 'rgba(158,206,106,0.12)'
                    : 'rgba(224,175,104,0.12)',
                border: `1px solid ${
                  isMissing ? 'rgba(247,118,142,0.4)'
                  : isClean ? 'rgba(158,206,106,0.35)'
                  : 'rgba(224,175,104,0.35)'
                }`,
                borderRadius: 6,
                padding: '10px 12px',
              }}
            >
              {/* Repo name + branch */}
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginBottom: 6,
              }}>
                <span style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: isMissing ? '#f7768e' : isClean ? '#9ece6a' : '#e0af68',
                  flexShrink: 0,
                }} />
                <span style={{
                  fontSize: 13,
                  fontWeight: 700,
                  color: '#c0caf5',
                }}>
                  {repo.name}
                </span>
                <span style={{
                  fontSize: 10,
                  fontWeight: 700,
                  padding: '2px 8px',
                  borderRadius: 3,
                  background: 'rgba(122,162,247,0.25)',
                  color: '#7aa2f7',
                  fontFamily: 'monospace',
                  marginLeft: 'auto',
                  border: '1px solid rgba(122,162,247,0.4)',
                }}>
                  {repo.status.branch}
                </span>
              </div>

              {/* Status badges */}
              <div style={{
                display: 'flex',
                gap: 6,
                flexWrap: 'wrap',
              }}>
                {isMissing ? (
                  <span style={{
                    fontSize: 10,
                    fontWeight: 700,
                    padding: '3px 8px',
                    borderRadius: 3,
                    background: 'rgba(247,118,142,0.25)',
                    color: '#f7768e',
                    fontFamily: 'monospace',
                    border: '1px solid rgba(247,118,142,0.4)',
                  }}>
                    path not found
                  </span>
                ) : (
                  <>
                    {repo.status.dirty > 0 && (
                      <span style={{
                        fontSize: 10,
                        fontWeight: 700,
                        padding: '3px 8px',
                        borderRadius: 3,
                        background: 'rgba(224,175,104,0.25)',
                        color: '#e0af68',
                        fontFamily: 'monospace',
                        border: '1px solid rgba(224,175,104,0.4)',
                      }}>
                        {repo.status.dirty} uncommitted
                      </span>
                    )}
                    {repo.status.unpushed > 0 && (
                      <span style={{
                        fontSize: 10,
                        fontWeight: 700,
                        padding: '3px 8px',
                        borderRadius: 3,
                        background: 'rgba(255,158,100,0.25)',
                        color: '#ff9e64',
                        fontFamily: 'monospace',
                        border: '1px solid rgba(255,158,100,0.4)',
                      }}>
                        {repo.status.unpushed} unpushed
                      </span>
                    )}
                    {isClean && (
                      <span style={{
                        fontSize: 10,
                        fontWeight: 700,
                        padding: '3px 8px',
                        borderRadius: 3,
                        background: 'rgba(158,206,106,0.25)',
                        color: '#9ece6a',
                        fontFamily: 'monospace',
                        border: '1px solid rgba(158,206,106,0.4)',
                      }}>
                        clean
                      </span>
                    )}
                  </>
                )}
              </div>

              {/* Path */}
              <div style={{
                fontSize: 10,
                color: '#565f89',
                marginTop: 6,
                fontFamily: 'monospace',
              }}>
                {repo.path}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
