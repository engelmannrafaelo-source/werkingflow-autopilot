import React, { useState, useEffect } from 'react';
import { BRIDGE_URL, bridgeJson } from './shared';
import StatusTab from './tabs/StatusTab';
import WorkersTab from './tabs/WorkersTab';
import AuslastungTab from './tabs/AuslastungTab';
import SessionsTab from './tabs/SessionsTab';
import TestTab from './tabs/TestTab';
import MetrikenTab from './tabs/MetrikenTab';
import KostenTab from './tabs/KostenTab';
import CCUsageTab from './tabs/CCUsageTab';

interface Tab {
  key: string;
  label: string;
  component: React.ReactElement;
}

interface QuickStatus {
  healthy: boolean;
  workers: number;
  activeWorkers: number;
  cliRunning: number;
}

export default function BridgeMonitor() {
  const tabs: Tab[] = [
    { key: 'status',     label: 'Status',      component: <StatusTab /> },
    { key: 'workers',    label: 'Workers',      component: <WorkersTab /> },
    { key: 'auslastung', label: 'Auslastung',   component: <AuslastungTab /> },
    { key: 'sessions',   label: 'Sessions',     component: <SessionsTab /> },
    { key: 'test',       label: 'Test',         component: <TestTab /> },
    { key: 'metriken',   label: 'Metriken',     component: <MetrikenTab /> },
    { key: 'kosten',     label: 'Kosten',       component: <KostenTab /> },
    { key: 'cc-usage',   label: 'CC-Usage',     component: <CCUsageTab /> },
  ];

  const [activeTab, setActiveTab] = useState(tabs[0].key);
  const [quickStatus, setQuickStatus] = useState<QuickStatus | null>(null);

  // Lightweight status poll for header badge
  useEffect(() => {
    async function fetchQuick() {
      try {
        const [healthRes, lbRes, cliRes] = await Promise.allSettled([
          bridgeJson<{ status: string }>('/health', { timeout: 5000 }),
          bridgeJson<{ workers: number; paused: string[] }>('/lb-status', { timeout: 5000 }),
          bridgeJson<{ cli_session_stats: { running: number } }>('/v1/cli-sessions/stats', { timeout: 5000 }),
        ]);

        const healthy = healthRes.status === 'fulfilled' && healthRes.value.status === 'healthy';
        const lb = lbRes.status === 'fulfilled' ? lbRes.value : null;
        const cli = cliRes.status === 'fulfilled' ? cliRes.value.cli_session_stats : null;

        setQuickStatus({
          healthy,
          workers: lb?.workers ?? 0,
          activeWorkers: lb ? lb.workers - (lb.paused?.length ?? 0) : 0,
          cliRunning: cli?.running ?? 0,
        });
      } catch {
        setQuickStatus({ healthy: false, workers: 0, activeWorkers: 0, cliRunning: 0 });
      }
    }
    fetchQuick();
    const interval = setInterval(fetchQuick, 30000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      background: 'var(--tn-surface)',
    }}>
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
            width: 8, height: 8, borderRadius: '50%',
            background: quickStatus?.healthy ? 'var(--tn-green)' : 'var(--tn-red)',
            flexShrink: 0,
          }} />

          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--tn-text)', flex: 1 }}>
            BRIDGE MONITOR
          </span>

          {/* Quick stats badges */}
          {quickStatus && (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              {quickStatus.cliRunning > 0 && (
                <span style={{
                  fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 3,
                  background: 'rgba(122,162,247,0.15)', color: 'var(--tn-blue)',
                  fontFamily: 'monospace',
                }}>
                  {quickStatus.cliRunning} running
                </span>
              )}
              <span style={{
                fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 3,
                background: 'rgba(158,206,106,0.1)', color: 'var(--tn-text-muted)',
                fontFamily: 'monospace',
              }}>
                {quickStatus.activeWorkers}/{quickStatus.workers} workers
              </span>
            </div>
          )}

          <span style={{
            fontSize: 9, fontWeight: 700, letterSpacing: '0.05em',
            background: 'rgba(122,162,247,0.15)', color: 'var(--tn-blue)',
            border: '1px solid rgba(122,162,247,0.3)', borderRadius: 3,
            padding: '2px 6px', fontFamily: 'monospace',
          }}>
            49.12.72.66:8000
          </span>
        </div>

        {/* Sub-Tabs */}
        <div style={{
          display: 'flex',
          gap: 4,
          padding: '0 12px 8px',
          overflowX: 'auto',
        }}>
          {tabs.map((tab) => (
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
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        {tabs.find((t) => t.key === activeTab)?.component}
      </div>
    </div>
  );
}
