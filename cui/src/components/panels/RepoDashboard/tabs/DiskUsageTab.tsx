import React, { useState, useEffect } from 'react';
import { Treemap, ResponsiveContainer, Tooltip } from 'recharts';

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

interface TreemapNode {
  name: string;
  size: number;
  path: string;
  isGit: boolean;
  ageColor: string;
  ageLabel: string;
  sizeHuman: string;
}

export default function DiskUsageTab() {
  const [structure, setStructure] = useState<FolderItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<'treemap' | 'bars'>('treemap');

  useEffect(() => {
    fetchStructure();
  }, []);

  // Age-based color heatmap (same as RepositoriesTab)
  const getAgeColor = (lastModified: string): string => {
    const daysSince = (Date.now() - new Date(lastModified).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince < 7) return '#9ece6a';   // Fresh (< 1 week) - Green
    if (daysSince < 30) return '#e0af68';  // Recent (< 1 month) - Yellow
    if (daysSince < 90) return '#ff9e64';  // Aging (< 3 months) - Orange
    if (daysSince < 180) return '#f7768e'; // Stale (< 6 months) - Red
    return '#565f89';                       // Dead (> 6 months) - Gray
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

  const fetchStructure = async () => {
    if ((window as any).__cuiServerAlive === false) return;
    setLoading(true);
    try {
      const res = await fetch('/api/repo-dashboard/structure', { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setStructure(data.structure);
    } catch (err) {
      console.warn('[DiskUsageTab] fetch structure failed:', err);
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

  // Transform data for Treemap
  const treemapData: TreemapNode[] = structure.map(item => ({
    name: item.name,
    size: item.diskSize.bytes,
    path: item.path,
    isGit: item.isGit,
    ageColor: getAgeColor(item.lastModified),
    ageLabel: getAgeLabel(item.lastModified),
    sizeHuman: item.diskSize.human,
  }));

  // Custom Treemap Cell Content
  const CustomTreemapContent = (props: any) => {
    const { x, y, width, height, name, size, ageColor, ageLabel, sizeHuman, isGit } = props;

    // Only show label if box is big enough
    const showLabel = width > 60 && height > 40;
    const showDetails = width > 100 && height > 60;

    return (
      <g>
        <rect
          x={x}
          y={y}
          width={width}
          height={height}
          style={{
            fill: ageColor,
            stroke: 'var(--tn-border)',
            strokeWidth: 2,
            cursor: 'pointer',
          }}
        />
        {showLabel && (
          <>
            <text
              x={x + width / 2}
              y={y + height / 2 - (showDetails ? 15 : 5)}
              textAnchor="middle"
              fill="var(--tn-text)"
              fontSize={width > 150 ? 14 : 11}
              fontWeight="600"
              fontFamily="monospace"
            >
              {name.length > 15 ? name.slice(0, 12) + '...' : name}
            </text>
            {showDetails && (
              <>
                <text
                  x={x + width / 2}
                  y={y + height / 2 + 5}
                  textAnchor="middle"
                  fill="var(--tn-text-muted)"
                  fontSize={10}
                  fontFamily="monospace"
                >
                  {sizeHuman}
                </text>
                <text
                  x={x + width / 2}
                  y={y + height / 2 + 20}
                  textAnchor="middle"
                  fill="var(--tn-text-muted)"
                  fontSize={9}
                  fontFamily="monospace"
                >
                  {ageLabel} {isGit ? '📦' : ''}
                </text>
              </>
            )}
          </>
        )}
      </g>
    );
  };

  return (
    <div data-ai-id="disk-usage-tab" style={{ padding: 12 }}>
      {/* Summary & View Toggle */}
      <div
        data-ai-id="disk-usage-summary"
        style={{
        background: 'var(--tn-bg)',
        borderRadius: 6,
        border: '1px solid var(--tn-border)',
        padding: 12,
        marginBottom: 16,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}>
        <div style={{ display: 'flex', gap: 24 }}>
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

        {/* View Mode Toggle */}
        <div data-ai-id="disk-usage-view-toggle" style={{ display: 'flex', gap: 4 }}>
          <button
            data-ai-id="disk-usage-view-treemap"
            onClick={() => setViewMode('treemap')}
            style={{
              background: viewMode === 'treemap' ? 'var(--tn-blue)' : 'transparent',
              border: '1px solid var(--tn-border)',
              color: viewMode === 'treemap' ? '#fff' : 'var(--tn-text-muted)',
              padding: '4px 12px',
              borderRadius: 3,
              fontSize: 10,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Treemap
          </button>
          <button
            data-ai-id="disk-usage-view-bars"
            onClick={() => setViewMode('bars')}
            style={{
              background: viewMode === 'bars' ? 'var(--tn-blue)' : 'transparent',
              border: '1px solid var(--tn-border)',
              color: viewMode === 'bars' ? '#fff' : 'var(--tn-text-muted)',
              padding: '4px 12px',
              borderRadius: 3,
              fontSize: 10,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Bars
          </button>
        </div>
      </div>

      {/* Treemap View */}
      {viewMode === 'treemap' && (
        <>
          <div
            data-ai-id="disk-usage-treemap-container"
            style={{
              background: 'var(--tn-bg)',
              borderRadius: 6,
              border: '1px solid var(--tn-border)',
              padding: 12,
              marginBottom: 16,
              height: 500,
            }}
          >
            <ResponsiveContainer width="100%" height="100%">
              <Treemap
                data-ai-id="disk-usage-treemap"
                data={treemapData}
                dataKey="size"
                stroke="var(--tn-border)"
                content={<CustomTreemapContent />}
              />
            </ResponsiveContainer>
          </div>

          {/* Legend */}
          <div
            data-ai-id="disk-usage-treemap-legend"
            style={{
              background: 'var(--tn-bg)',
              borderRadius: 6,
              border: '1px solid var(--tn-border)',
              padding: 12,
            }}
          >
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--tn-text)', marginBottom: 8 }}>
              Color Legend (Last Modified)
            </div>
            <div data-ai-id="disk-usage-color-legend" style={{ display: 'flex', gap: 16, fontSize: 10, color: 'var(--tn-text-muted)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ width: 16, height: 16, background: '#9ece6a', borderRadius: 2 }} />
                <span>Fresh (&lt;1w)</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ width: 16, height: 16, background: '#e0af68', borderRadius: 2 }} />
                <span>Recent (&lt;1mo)</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ width: 16, height: 16, background: '#ff9e64', borderRadius: 2 }} />
                <span>Aging (&lt;3mo)</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ width: 16, height: 16, background: '#f7768e', borderRadius: 2 }} />
                <span>Stale (&lt;6mo)</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ width: 16, height: 16, background: '#565f89', borderRadius: 2 }} />
                <span>Dead (&gt;6mo)</span>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Disk Usage Bars */}
      {viewMode === 'bars' && (
        <div
          data-ai-id="disk-usage-bars-container"
          style={{
            background: 'var(--tn-bg)',
            borderRadius: 6,
            border: '1px solid var(--tn-border)',
            overflow: 'hidden',
          }}
        >
        {structure.map((item) => {
          const percent = (item.diskSize.bytes / totalBytes) * 100;
          return (
            <div
              key={item.path}
              data-ai-id={`disk-usage-bar-${item.name}`}
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
      )}
    </div>
  );
}
