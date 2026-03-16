import React, { useState, useEffect } from 'react';
import ErrorBoundary from '../../ErrorBoundary';
import TeamTab from './tabs/TeamTab';
import DocsTab from './tabs/DocsTab';
import ReposTab from './tabs/ReposTab';

interface Tab {
  key: string;
  label: string;
  component: React.ReactElement;
}

interface OverallStatus {
  level: 'green' | 'yellow' | 'red';
  issues: number;
}

const LEVEL_COLOR: Record<string, string> = {
  green: '#9ece6a',
  yellow: '#e0af68',
  red: '#f7768e',
};

export default function MaintenancePanel() {
  const [activeTab, setActiveTab] = useState('team');
  const [overall, setOverall] = useState<OverallStatus | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastChecked, setLastChecked] = useState<string | null>(null);

  // Poll overall status
  useEffect(() => {
    async function fetchOverall() {
      if ((window as any).__cuiServerAlive === false) return;
      try {
        const res = await fetch('/api/maintenance/status', { signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setOverall(data.overall);
        setLastChecked(data.checkedAt);
      } catch (err) {
        console.warn('[MaintenancePanel] fetch failed:', err);
      }
    }
    fetchOverall();
    const interval = setInterval(fetchOverall, 60000);
    return () => clearInterval(interval);
  }, []);

  const handleRefresh = async () => {
    if ((window as any).__cuiServerAlive === false) return;
    setRefreshing(true);
    try {
      await fetch('/api/maintenance/refresh', { method: 'POST', signal: AbortSignal.timeout(5000) });
      const res = await fetch('/api/maintenance/status', { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setOverall(data.overall);
      setLastChecked(data.checkedAt);
    } catch (err) {
      console.warn('[MaintenancePanel] refresh failed:', err);
    } finally {
      setRefreshing(false);
    }
  };

  const tabs: Tab[] = [
    { key: 'team', label: 'Team', component: <ErrorBoundary componentName="TeamTab"><TeamTab /></ErrorBoundary> },
    { key: 'docs', label: 'Docs & Refs', component: <ErrorBoundary componentName="DocsTab"><DocsTab /></ErrorBoundary> },
    { key: 'repos', label: 'Repos', component: <ErrorBoundary componentName="ReposTab"><ReposTab /></ErrorBoundary> },
  ];

  return (
    <div
      data-ai-id="maintenance-panel"
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
          <span style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: overall ? LEVEL_COLOR[overall.level] : 'var(--tn-text-muted)',
            flexShrink: 0,
          }} />

          <span style={{
            fontSize: 13,
            fontWeight: 700,
            color: 'var(--tn-text)',
            flex: 1,
          }}>
            MAINTENANCE
          </span>

          {/* Issue count badge */}
          {overall && overall.issues > 0 && (
            <span style={{
              fontSize: 9,
              fontWeight: 700,
              padding: '2px 6px',
              borderRadius: 3,
              background: overall.level === 'red' ? 'rgba(247,118,142,0.25)' : 'rgba(224,175,104,0.25)',
              color: overall.level === 'red' ? '#f7768e' : '#e0af68',
              border: `1px solid ${overall.level === 'red' ? 'rgba(247,118,142,0.5)' : 'rgba(224,175,104,0.5)'}`,
              fontFamily: 'monospace',
            }}>
              {overall.issues} issues
            </span>
          )}

          {overall && overall.issues === 0 && (
            <span style={{
              fontSize: 9,
              fontWeight: 700,
              padding: '2px 6px',
              borderRadius: 3,
              background: 'rgba(158,206,106,0.25)',
              color: '#9ece6a',
              border: '1px solid rgba(158,206,106,0.5)',
              fontFamily: 'monospace',
            }}>
              all good
            </span>
          )}

          {/* Last checked */}
          {lastChecked && (
            <span style={{
              fontSize: 9,
              color: 'var(--tn-text-muted)',
              fontFamily: 'monospace',
            }}>
              {new Date(lastChecked).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}

          {/* Refresh button */}
          <button
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
              opacity: refreshing ? 0.5 : 1,
            }}
          >
            {refreshing ? '...' : 'Refresh'}
          </button>
        </div>

        {/* Tabs */}
        <div style={{
          display: 'flex',
          gap: 4,
          padding: '0 12px 8px',
          overflowX: 'auto',
        }}>
          {tabs.map(tab => (
            <button
              key={tab.key}
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
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0, position: 'relative' }}>
        {tabs.map(tab => (
          <div
            key={tab.key}
            style={{
              display: activeTab === tab.key ? 'block' : 'none',
              height: '100%',
              overflow: 'auto',
            }}
          >
            {tab.component}
          </div>
        ))}
      </div>
    </div>
  );
}
