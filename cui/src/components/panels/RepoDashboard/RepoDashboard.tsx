import React, { useState, useEffect } from 'react';
import RepositoriesTab from './tabs/RepositoriesTab';
import PipelineTab from './tabs/PipelineTab';
import DiskUsageTab from './tabs/DiskUsageTab';
import HierarchyTab from './tabs/HierarchyTab';
import { BuildInfo } from '../../BuildInfo';

interface Tab {
  key: string;
  label: string;
  component: React.ReactElement;
}

interface QuickStats {
  totalRepos: number;
  dirtyRepos: number;
  totalSize: string;
}

export default function RepoDashboard() {
  const tabs: Tab[] = [
    { key: 'repos', label: 'Repositories', component: <RepositoriesTab /> },
    { key: 'hierarchy', label: 'Hierarchy (Sankey)', component: <HierarchyTab /> },
    { key: 'pipeline', label: 'Pipeline', component: <PipelineTab /> },
    { key: 'disk', label: 'Disk Usage', component: <DiskUsageTab /> },
  ];

  const [activeTab, setActiveTab] = useState(tabs[0].key);
  const [quickStats, setQuickStats] = useState<QuickStats | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Quick stats poll
  useEffect(() => {
    async function fetchQuick() {
      try {
        const res = await fetch('/api/repo-dashboard/repositories');
        const data = await res.json();

        const totalSize = data.repos.reduce((sum: number, r: any) => sum + r.diskSize.bytes, 0);
        const sizeGB = (totalSize / 1024 / 1024 / 1024).toFixed(1);

        setQuickStats({
          totalRepos: data.count,
          dirtyRepos: data.repos.filter((r: any) => r.status === 'dirty').length,
          totalSize: `${sizeGB}GB`,
        });
      } catch (err) {
        console.error('[RepoDashboard] Quick stats error:', err);
        setQuickStats({ totalRepos: 0, dirtyRepos: 0, totalSize: '0GB' });
      }
    }
    fetchQuick();
    const interval = setInterval(fetchQuick, 60000); // Every minute
    return () => clearInterval(interval);
  }, []);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await fetch('/api/repo-dashboard/refresh', { method: 'POST' });
      // Re-trigger stats fetch
      const res = await fetch('/api/repo-dashboard/repositories');
      const data = await res.json();
      const totalSize = data.repos.reduce((sum: number, r: any) => sum + r.diskSize.bytes, 0);
      const sizeGB = (totalSize / 1024 / 1024 / 1024).toFixed(1);
      setQuickStats({
        totalRepos: data.count,
        dirtyRepos: data.repos.filter((r: any) => r.status === 'dirty').length,
        totalSize: `${sizeGB}GB`,
      });
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div
      data-ai-id="repo-dashboard-panel"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: 'var(--tn-surface)',
      }}
    >
      {/* Header */}
      <div style={{
        background: 'var(--tn-bg-dark)',
        borderBottom: '2px solid var(--tn-border)',
        flexShrink: 0,
      }}>
        <div style={{
          padding: '8px 12px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}>
          {/* Status dot */}
          <span
            data-ai-id="repo-dashboard-status-dot"
            style={{
              width: 8, height: 8, borderRadius: '50%',
              background: quickStats?.dirtyRepos === 0 ? 'var(--tn-green)' : 'var(--tn-yellow)',
              flexShrink: 0,
            }}
          />

          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--tn-text)', flex: 1 }}>
            GIT & PIPELINE MONITOR
          </span>
          <BuildInfo />

          {/* Quick stats badges */}
          {quickStats && (
            <div data-ai-id="repo-dashboard-quick-stats" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              {quickStats.dirtyRepos > 0 && (
                <span
                  data-ai-id="repo-dashboard-dirty-repos-badge"
                  style={{
                  fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 3,
                  background: 'rgba(224,175,104,0.15)', color: 'var(--tn-yellow)',
                  fontFamily: 'monospace',
                }}>
                  {quickStats.dirtyRepos} uncommitted
                </span>
              )}
              <span
                data-ai-id="repo-dashboard-total-repos-badge"
                style={{
                  fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 3,
                  background: 'rgba(122,162,247,0.15)', color: 'var(--tn-blue)',
                  fontFamily: 'monospace',
                }}
              >
                {quickStats.totalRepos} repos
              </span>
              <span
                data-ai-id="repo-dashboard-total-size-badge"
                style={{
                fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 3,
                background: 'rgba(158,206,106,0.1)', color: 'var(--tn-text-muted)',
                fontFamily: 'monospace',
              }}>
                {quickStats.totalSize}
              </span>
            </div>
          )}

          {/* Refresh Button */}
          <button
            data-ai-id="repo-dashboard-refresh-button"
            onClick={handleRefresh}
            disabled={refreshing}
            style={{
              background: refreshing ? 'transparent' : 'rgba(122,162,247,0.15)',
              border: '1px solid rgba(122,162,247,0.3)',
              borderRadius: 3,
              padding: '2px 8px',
              fontSize: 9,
              fontWeight: 700,
              color: 'var(--tn-blue)',
              cursor: refreshing ? 'not-allowed' : 'pointer',
              fontFamily: 'monospace',
              opacity: refreshing ? 0.5 : 1,
            }}
          >
            {refreshing ? 'Refreshing...' : 'Refresh'}
          </button>

          <span style={{
            fontSize: 9, fontWeight: 700, letterSpacing: '0.05em',
            background: 'rgba(122,162,247,0.15)', color: 'var(--tn-blue)',
            border: '1px solid rgba(122,162,247,0.3)', borderRadius: 3,
            padding: '2px 6px', fontFamily: 'monospace',
          }}>
            /root/projekte
          </span>
        </div>

        {/* Sub-Tabs */}
        <div
          data-ai-id="repo-dashboard-tabs"
          style={{
            display: 'flex',
            gap: 4,
            padding: '0 12px 8px',
            overflowX: 'auto',
          }}
        >
          {tabs.map((tab) => (
            <button
              key={tab.key}
              data-ai-id={`repo-dashboard-tab-${tab.key}`}
              onClick={() => setActiveTab(tab.key)}
              style={{
                background: activeTab === tab.key ? 'var(--tn-blue)' : 'transparent',
                border: 'none',
                color: activeTab === tab.key ? '#fff' : 'var(--tn-text-muted)',
                padding: '4px 12px',
                borderRadius: 4,
                fontSize: 11,
                fontWeight: 600,
                cursor: 'pointer',
                transition: 'all 0.15s',
                whiteSpace: 'nowrap',
                flexShrink: 0,
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab Content */}
      <div
        data-ai-id={`repo-dashboard-content-${activeTab}`}
        style={{ flex: 1, overflow: 'auto', minHeight: 0 }}
      >
        {tabs.find((t) => t.key === activeTab)?.component}
      </div>
    </div>
  );
}
