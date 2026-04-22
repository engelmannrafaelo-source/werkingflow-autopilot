import React, { useState, useEffect } from 'react';
import { bridgeJson } from './shared';
import ErrorBoundary from '../../ErrorBoundary';
import StatusTab from './tabs/StatusTab';
import LiveTab from './tabs/LiveTab';
import AnalyticsTab from './tabs/AnalyticsTab';
import ErrorsTab from './tabs/ErrorsTab';
import HelpModal from './tabs/HelpModal';
import { BuildInfo } from '../../BuildInfo';

interface Tab {
  key: string;
  label: string;
  component: React.ReactElement;
}

interface GuardSlot {
  active: number;
  max: number;
  available: number;
}

interface GuardStatus {
  running: boolean;
  slots?: Record<string, GuardSlot>;
  queueLength?: number;
}

interface QuickStatus {
  healthy: boolean;
  workers: number;
  activeWorkers: number;
  guard: GuardStatus;
  cliRunning: number;
}

export default function BridgeMonitor() {
  const tabs: Tab[] = [
    { key: 'status',    label: 'Status',    component: <ErrorBoundary componentName="StatusTab"><StatusTab /></ErrorBoundary> },
    { key: 'live',      label: 'Live',      component: <ErrorBoundary componentName="LiveTab"><LiveTab /></ErrorBoundary> },
    { key: 'analytics', label: 'Analytics', component: <ErrorBoundary componentName="AnalyticsTab"><AnalyticsTab /></ErrorBoundary> },
    { key: 'errors',    label: 'Errors',    component: <ErrorBoundary componentName="ErrorsTab"><ErrorsTab /></ErrorBoundary> },
  ];

  const [activeTab, setActiveTab] = useState(tabs[0].key);
  const [quickStatus, setQuickStatus] = useState<QuickStatus | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);

  // Lightweight status poll for header badge
  useEffect(() => {
    async function fetchQuick() {
      try {
        const [healthRes, lbRes, cliRes, guardRes] = await Promise.allSettled([
          bridgeJson<{ status: string }>('/health', { timeout: 5000 }),
          bridgeJson<{
            workers?: { total?: number; up?: number; down?: number } | number;
            paused?: string[];
          }>('/lb-status', { timeout: 5000 }),
          bridgeJson<{ cli_session_stats: { running: number } }>('/v1/cli-sessions/stats', { timeout: 5000 }),
          fetch('/api/bridge/guard/status', { signal: AbortSignal.timeout(3000) }).then(r => r.json()),
        ]);

        const healthy = healthRes.status === 'fulfilled' && healthRes.value.status === 'healthy';
        const lb = lbRes.status === 'fulfilled' ? lbRes.value : null;
        const cli = cliRes.status === 'fulfilled' ? cliRes.value.cli_session_stats : null;
        const guard = guardRes.status === 'fulfilled' ? guardRes.value : { running: false };

        let workers = 0;
        let activeWorkers = 0;
        if (lb?.workers && typeof lb.workers === 'object') {
          workers = lb.workers.total ?? 0;
          activeWorkers = lb.workers.up ?? 0;
        } else if (typeof lb?.workers === 'number') {
          workers = lb.workers;
          activeWorkers = workers - (lb.paused?.length ?? 0);
        } else {
          workers = healthy ? 4 : 0;
          activeWorkers = workers;
        }

        setQuickStatus({
          healthy,
          workers,
          activeWorkers,
          cliRunning: cli?.running ?? 0,
          guard,
        });
      } catch {
        setQuickStatus({ healthy: false, workers: 0, activeWorkers: 0, cliRunning: 0, guard: { running: false } });
      }
    }
    fetchQuick();
    const interval = setInterval(fetchQuick, 30000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div
      data-ai-id="bridge-monitor-panel"
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
            width: 8, height: 8, borderRadius: '50%',
            background: quickStatus?.healthy ? 'var(--tn-green)' : 'var(--tn-red)',
            flexShrink: 0,
          }} />

          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--tn-text)', flex: 1 }}>
            BRIDGE MONITOR
          </span>
          <BuildInfo />

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
              {quickStatus.guard?.running ? (
                <span style={{
                  fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 3,
                  background: quickStatus.guard.queueLength && quickStatus.guard.queueLength > 0
                    ? 'rgba(224,175,104,0.15)' : 'rgba(158,206,106,0.15)',
                  color: quickStatus.guard.queueLength && quickStatus.guard.queueLength > 0
                    ? 'var(--tn-orange)' : 'var(--tn-green)',
                  fontFamily: 'monospace',
                }}>
                  Guard {quickStatus.guard.queueLength ? `Q:${quickStatus.guard.queueLength}` : 'OK'}
                </span>
              ) : (
                <span style={{
                  fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 3,
                  background: 'rgba(247,118,142,0.15)', color: 'var(--tn-red)',
                  fontFamily: 'monospace',
                }}>
                  Guard OFF
                </span>
              )}
            </div>
          )}

          {/* Help button */}
          <button
            data-ai-id="bridge-help-btn"
            onClick={() => setHelpOpen(true)}
            style={{
              background: 'none', border: '1px solid var(--tn-border)',
              color: 'var(--tn-text-muted)', borderRadius: 4,
              fontSize: 11, fontWeight: 700, padding: '2px 8px',
              cursor: 'pointer',
            }}
          >
            ?
          </button>

          <span style={{
            fontSize: 9, fontWeight: 700, letterSpacing: '0.05em',
            background: 'rgba(122,162,247,0.15)', color: 'var(--tn-blue)',
            border: '1px solid rgba(122,162,247,0.3)', borderRadius: 3,
            padding: '2px 6px', fontFamily: 'monospace',
          }}>
            Bridge API
          </span>
        </div>

        {/* Tabs */}
        <div
          data-ai-id="bridge-monitor-tabs"
          style={{
            display: 'flex',
            gap: 4,
            padding: '0 12px 8px',
          }}
        >
          {tabs.map((tab) => (
            <button
              key={tab.key}
              data-ai-id={`bridge-monitor-tab-${tab.key}`}
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
        {tabs.map((tab) => (
          <div
            key={tab.key}
            data-ai-id={`bridge-monitor-content-${tab.key}`}
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

      {/* Help Modal */}
      {helpOpen && <HelpModal onClose={() => setHelpOpen(false)} />}
    </div>
  );
}
