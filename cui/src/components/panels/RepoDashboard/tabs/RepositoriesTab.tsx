import React, { useState, useEffect } from 'react';

interface Repo {
  name: string;
  path: string;
  branch: string;
  uncommitted: number;
  lastCommit: {
    hash: string;
    author: string;
    message: string;
    date: string;
  };
  diskSize: {
    bytes: number;
    human: string;
  };
  lastModified: string;
  remoteUrl: string;
  status: 'clean' | 'dirty';
}

export default function RepositoriesTab() {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [loading, setLoading] = useState(true);
  const [sortBy, setSortBy] = useState<'size' | 'name' | 'modified'>('size');

  useEffect(() => {
    fetchRepos();
  }, []);

  // Age-based color heatmap (lighter for better readability)
  const getAgeColor = (lastModified: string): string => {
    const daysSince = (Date.now() - new Date(lastModified).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince < 7) return 'rgba(158, 206, 106, 0.25)';   // Fresh (< 1 week) - Green
    if (daysSince < 30) return 'rgba(224, 175, 104, 0.25)';  // Recent (< 1 month) - Yellow
    if (daysSince < 90) return 'rgba(255, 158, 100, 0.25)';  // Aging (< 3 months) - Orange
    if (daysSince < 180) return 'rgba(247, 118, 142, 0.25)'; // Stale (< 6 months) - Red
    return 'rgba(86, 95, 137, 0.25)';                         // Dead (> 6 months) - Gray
  };

  const getAgeLabel = (lastModified: string): string => {
    const daysSince = (Date.now() - new Date(lastModified).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince < 1) return 'today';
    if (daysSince < 2) return 'yesterday';
    if (daysSince < 7) return `${Math.floor(daysSince)}d ago`;
    if (daysSince < 30) return `${Math.floor(daysSince / 7)}w ago`;
    if (daysSince < 365) return `${Math.floor(daysSince / 30)}mo ago`;
    return `${Math.floor(daysSince / 365)}y ago`;
  };

  const fetchRepos = async () => {
    if ((window as any).__cuiServerAlive === false) return;
    setLoading(true);
    try {
      const res = await fetch('/api/repo-dashboard/repositories', { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setRepos(data.repos);
    } catch (err) {
      console.warn('[RepoTab] fetch repositories failed:', err);
    } finally {
      setLoading(false);
    }
  };

  const sortedRepos = [...repos].sort((a, b) => {
    switch (sortBy) {
      case 'size': return b.diskSize.bytes - a.diskSize.bytes;
      case 'name': return a.name.localeCompare(b.name);
      case 'modified': return new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime();
      default: return 0;
    }
  });

  if (loading) {
    return (
      <div style={{ padding: 20, color: 'var(--tn-text-muted)' }}>
        Loading repositories...
      </div>
    );
  }

  return (
    <div data-ai-id="repositories-tab" style={{ padding: 12 }}>
      {/* Sort Controls */}
      <div data-ai-id="repositories-sort-controls" style={{ marginBottom: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
        <span style={{ fontSize: 11, color: 'var(--tn-text-muted)' }}>Sort by:</span>
        {(['size', 'name', 'modified'] as const).map((sort) => (
          <button
            key={sort}
            data-ai-id={`repositories-sort-${sort}`}
            onClick={() => setSortBy(sort)}
            style={{
              background: sortBy === sort ? 'var(--tn-blue)' : 'transparent',
              border: '1px solid var(--tn-border)',
              color: sortBy === sort ? '#fff' : 'var(--tn-text-muted)',
              padding: '3px 8px',
              borderRadius: 3,
              fontSize: 10,
              fontWeight: 600,
              cursor: 'pointer',
              textTransform: 'capitalize',
            }}
          >
            {sort}
          </button>
        ))}
      </div>

      {/* Repositories Table */}
      <div
        data-ai-id="repositories-table-container"
        style={{
          background: 'var(--tn-bg)',
          borderRadius: 6,
          border: '1px solid var(--tn-border)',
          overflow: 'hidden',
        }}
      >
        <table
          data-ai-id="repositories-table"
          style={{
          width: '100%',
          borderCollapse: 'collapse',
          fontSize: 11,
          fontFamily: 'monospace',
        }}>
          <thead>
            <tr style={{ background: 'var(--tn-bg-dark)' }}>
              <th style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--tn-text-muted)', fontWeight: 600 }}>
                Repository
              </th>
              <th style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--tn-text-muted)', fontWeight: 600 }}>
                Branch
              </th>
              <th style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--tn-text-muted)', fontWeight: 600 }}>
                Status
              </th>
              <th style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--tn-text-muted)', fontWeight: 600 }}>
                Age
              </th>
              <th style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--tn-text-muted)', fontWeight: 600 }}>
                Last Commit
              </th>
              <th style={{ padding: '8px 12px', textAlign: 'right', color: 'var(--tn-text-muted)', fontWeight: 600 }}>
                Size
              </th>
            </tr>
          </thead>
          <tbody data-ai-id="repositories-table-body">
            {sortedRepos.map((repo) => (
              <tr
                key={repo.path}
                data-ai-id={`repo-row-${repo.name}`}
                style={{
                  borderTop: '1px solid var(--tn-border)',
                  background: getAgeColor(repo.lastModified),
                  transition: 'all 0.2s',
                }}
              >
                <td style={{ padding: '8px 12px' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <span style={{ fontWeight: 600, color: 'var(--tn-text)' }}>{repo.name}</span>
                    <span style={{ fontSize: 9, color: 'var(--tn-text-muted)' }}>{repo.path}</span>
                  </div>
                </td>
                <td style={{ padding: '8px 12px' }}>
                  <span style={{
                    background: 'rgba(122,162,247,0.15)',
                    color: 'var(--tn-blue)',
                    padding: '2px 6px',
                    borderRadius: 3,
                    fontSize: 10,
                  }}>
                    {repo.branch}
                  </span>
                </td>
                <td style={{ padding: '8px 12px' }}>
                  {repo.status === 'dirty' ? (
                    <span style={{
                      background: 'rgba(224,175,104,0.15)',
                      color: 'var(--tn-yellow)',
                      padding: '2px 6px',
                      borderRadius: 3,
                      fontSize: 10,
                    }}>
                      {repo.uncommitted} uncommitted
                    </span>
                  ) : (
                    <span style={{
                      background: 'rgba(158,206,106,0.15)',
                      color: 'var(--tn-green)',
                      padding: '2px 6px',
                      borderRadius: 3,
                      fontSize: 10,
                    }}>
                      clean
                    </span>
                  )}
                </td>
                <td style={{ padding: '8px 12px' }}>
                  <span style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: 'var(--tn-text)',
                    fontFamily: 'monospace',
                  }}>
                    {getAgeLabel(repo.lastModified)}
                  </span>
                </td>
                <td style={{ padding: '8px 12px' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <span style={{ color: 'var(--tn-text)' }}>
                      {repo.lastCommit.hash} {repo.lastCommit.message.slice(0, 50)}
                    </span>
                    <span style={{ fontSize: 9, color: 'var(--tn-text-muted)' }}>
                      {repo.lastCommit.author} • {new Date(repo.lastCommit.date).toLocaleString()}
                    </span>
                  </div>
                </td>
                <td style={{ padding: '8px 12px', textAlign: 'right' }}>
                  <span style={{
                    fontWeight: 600,
                    color: repo.diskSize.bytes > 1e9 ? 'var(--tn-red)' : 'var(--tn-text)',
                  }}>
                    {repo.diskSize.human}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Legend & Summary */}
      <div data-ai-id="repositories-legend" style={{ marginTop: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div data-ai-id="repositories-color-legend" style={{ display: 'flex', gap: 12, fontSize: 10, color: 'var(--tn-text-muted)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{ width: 12, height: 12, background: 'rgba(158, 206, 106, 0.3)', borderRadius: 2 }} />
            <span>Fresh (&lt;1w)</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{ width: 12, height: 12, background: 'rgba(224, 175, 104, 0.3)', borderRadius: 2 }} />
            <span>Recent (&lt;1mo)</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{ width: 12, height: 12, background: 'rgba(255, 158, 100, 0.3)', borderRadius: 2 }} />
            <span>Aging (&lt;3mo)</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{ width: 12, height: 12, background: 'rgba(247, 118, 142, 0.3)', borderRadius: 2 }} />
            <span>Stale (&lt;6mo)</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{ width: 12, height: 12, background: 'rgba(86, 95, 137, 0.3)', borderRadius: 2 }} />
            <span>Dead (&gt;6mo)</span>
          </div>
        </div>
        <span style={{ fontSize: 10, color: 'var(--tn-text-muted)' }}>
          Total: {repos.length} repositories
        </span>
      </div>
    </div>
  );
}
