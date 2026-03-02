import React, { useState, useEffect } from 'react';

interface FolderItem {
  name: string;
  path: string;
  isGit: boolean;
  diskSize: {
    bytes: number;
    human: string;
  };
  lastModified: string;
}

export default function DiskUsageTab() {
  const [structure, setStructure] = useState<FolderItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchStructure();
  }, []);

  const fetchStructure = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/repo-dashboard/structure');
      const data = await res.json();
      setStructure(data.structure);
    } catch (err) {
      console.error('[DiskUsageTab] Fetch error:', err);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div style={{ padding: 20, color: 'var(--tn-text-muted)' }}>
        Loading disk usage...
      </div>
    );
  }

  const totalBytes = structure.reduce((sum, item) => sum + item.diskSize.bytes, 0);
  const totalGB = (totalBytes / 1024 / 1024 / 1024).toFixed(2);

  return (
    <div style={{ padding: 12 }}>
      {/* Summary */}
      <div style={{
        background: 'var(--tn-bg)',
        borderRadius: 6,
        border: '1px solid var(--tn-border)',
        padding: 12,
        marginBottom: 16,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}>
        <div>
          <div style={{ fontSize: 11, color: 'var(--tn-text-muted)', marginBottom: 4 }}>
            Total Disk Usage
          </div>
          <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--tn-text)', fontFamily: 'monospace' }}>
            {totalGB} GB
          </div>
        </div>
        <div>
          <div style={{ fontSize: 11, color: 'var(--tn-text-muted)', marginBottom: 4 }}>
            Total Folders
          </div>
          <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--tn-text)', fontFamily: 'monospace' }}>
            {structure.length}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 11, color: 'var(--tn-text-muted)', marginBottom: 4 }}>
            Git Repositories
          </div>
          <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--tn-text)', fontFamily: 'monospace' }}>
            {structure.filter(i => i.isGit).length}
          </div>
        </div>
      </div>

      {/* Disk Usage Bars */}
      <div style={{
        background: 'var(--tn-bg)',
        borderRadius: 6,
        border: '1px solid var(--tn-border)',
        overflow: 'hidden',
      }}>
        {structure.map((item) => {
          const percent = (item.diskSize.bytes / totalBytes) * 100;
          return (
            <div
              key={item.path}
              style={{
                borderBottom: '1px solid var(--tn-border)',
                padding: 12,
              }}
            >
              <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 6,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: 'var(--tn-text)',
                    fontFamily: 'monospace',
                  }}>
                    {item.name}
                  </span>
                  {item.isGit && (
                    <span style={{
                      fontSize: 9,
                      background: 'rgba(122,162,247,0.15)',
                      color: 'var(--tn-blue)',
                      padding: '2px 6px',
                      borderRadius: 3,
                      fontWeight: 600,
                    }}>
                      GIT
                    </span>
                  )}
                </div>
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  fontSize: 11,
                  fontFamily: 'monospace',
                }}>
                  <span style={{ color: 'var(--tn-text-muted)' }}>
                    {percent.toFixed(1)}%
                  </span>
                  <span style={{
                    fontWeight: 600,
                    color: item.diskSize.bytes > 1e10 ? 'var(--tn-red)' : 'var(--tn-text)',
                  }}>
                    {item.diskSize.human}
                  </span>
                </div>
              </div>

              {/* Progress Bar */}
              <div style={{
                width: '100%',
                height: 8,
                background: 'var(--tn-bg-dark)',
                borderRadius: 4,
                overflow: 'hidden',
              }}>
                <div style={{
                  width: `${percent}%`,
                  height: '100%',
                  background: item.diskSize.bytes > 1e10
                    ? 'var(--tn-red)'
                    : item.diskSize.bytes > 5e9
                    ? 'var(--tn-yellow)'
                    : 'var(--tn-green)',
                  transition: 'width 0.3s',
                }} />
              </div>

              <div style={{
                fontSize: 9,
                color: 'var(--tn-text-muted)',
                marginTop: 4,
                fontFamily: 'monospace',
              }}>
                {item.path} • Modified: {new Date(item.lastModified).toLocaleString()}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
