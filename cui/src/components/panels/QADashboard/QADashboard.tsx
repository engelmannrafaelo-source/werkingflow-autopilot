import React, { useState, useEffect, useCallback } from 'react';
import ErrorBoundary from '../../ErrorBoundary';
import OverviewTab from './tabs/OverviewTab';
import PyramidTab from './tabs/PyramidTab';
import ScoresTab from './tabs/ScoresTab';
import TestRunsTab from './tabs/TestRunsTab';
import ScenariosTab from './tabs/ScenariosTab';
import CoverageTab from './tabs/CoverageTab';
import { resilientFetch } from '../../../utils/resilientFetch';

interface Tab {
  key: string;
  label: string;
  component: React.ReactElement;
  group?: 'monitoring' | 'quality';
  badge?: number;
}

export default function QADashboard() {
  const [activeTab, setActiveTab] = useState('overview');
  const [runningCount, setRunningCount] = useState(0);

  // Lightweight poll für Running Tests Badge
  const fetchRunningCount = useCallback(async () => {
    if ((window as any).__cuiServerAlive === false) return;
    try {
      const res = await resilientFetch('/api/qa/runs');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setRunningCount(data.running?.length ?? 0);
    } catch (err) {
      console.warn('[QADashboard] fetch running count failed:', err);
    }
  }, []);

  useEffect(() => {
    fetchRunningCount();
    const interval = setInterval(fetchRunningCount, 15000);
    const onReconnect = () => fetchRunningCount();
    window.addEventListener('cui-reconnected', onReconnect);
    return () => { clearInterval(interval); window.removeEventListener('cui-reconnected', onReconnect); };
  }, [fetchRunningCount]);

  const tabs: Tab[] = [
    {
      key: 'overview',
      label: 'Overview',
      component: <ErrorBoundary componentName="OverviewTab"><OverviewTab /></ErrorBoundary>,
      group: 'monitoring'
    },
    {
      key: 'pyramid',
      label: 'Pyramid',
      component: <ErrorBoundary componentName="PyramidTab"><PyramidTab /></ErrorBoundary>,
      group: 'quality'
    },
    {
      key: 'scores',
      label: 'Scores & Reports',
      component: <ErrorBoundary componentName="ScoresTab"><ScoresTab /></ErrorBoundary>,
      group: 'quality'
    },
    {
      key: 'test-runs',
      label: 'Test Runs',
      component: <ErrorBoundary componentName="TestRunsTab"><TestRunsTab /></ErrorBoundary>,
      group: 'monitoring',
      badge: runningCount
    },
    {
      key: 'coverage',
      label: 'Coverage Gaps',
      component: <ErrorBoundary componentName="CoverageTab"><CoverageTab /></ErrorBoundary>,
      group: 'quality'
    },
    {
      key: 'scenarios',
      label: 'Scenarios',
      component: <ErrorBoundary componentName="ScenariosTab"><ScenariosTab /></ErrorBoundary>,
      group: 'quality'
    }
  ];

  return (
    <div
      data-ai-id="qa-dashboard-panel"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: 'var(--tn-surface)'
      }}
    >
      {/* Header */}
      <div style={{
        background: 'var(--tn-bg-dark)',
        borderBottom: '2px solid var(--tn-border)',
        flexShrink: 0
      }}>
        <div style={{
          padding: '8px 12px',
          display: 'flex',
          alignItems: 'center',
          gap: 8
        }}>
          <span style={{
            fontSize: 13,
            fontWeight: 700,
            color: 'var(--tn-text)',
            flex: 1
          }}>
            📊 QA DASHBOARD
          </span>

          <span style={{
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: '0.05em',
            background: 'rgba(122,162,247,0.15)',
            color: 'var(--tn-blue)',
            border: '1px solid rgba(122,162,247,0.3)',
            borderRadius: 3,
            padding: '2px 6px',
            fontFamily: 'monospace'
          }}>
            Unified-Tester
          </span>
        </div>

        {/* Tabs */}
        <div
          data-ai-id="qa-dashboard-tabs"
          style={{
            display: 'flex',
            gap: 4,
            padding: '0 12px 8px',
            overflowX: 'auto'
          }}
        >
          {tabs.map(tab => (
            <button
              key={tab.key}
              data-ai-id={`qa-dashboard-tab-${tab.key}`}
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
                position: 'relative'
              }}
            >
              {tab.label}
              {tab.badge != null && tab.badge > 0 && (
                <span style={{
                  position: 'absolute',
                  top: -6,
                  right: -6,
                  width: 16,
                  height: 16,
                  background: 'var(--tn-red)',
                  color: '#fff',
                  fontSize: 9,
                  fontWeight: 700,
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center'
                }}>
                  {tab.badge}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Tab Content - Defensive: Keep all mounted, toggle visibility */}
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0, position: 'relative' }}>
        {tabs.map((tab) => (
          <div
            key={tab.key}
            data-ai-id={`qa-dashboard-content-${tab.key}`}
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
