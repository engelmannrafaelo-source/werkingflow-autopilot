import React, { useState, useEffect, useCallback } from 'react';
import ErrorBoundary from '../../ErrorBoundary';
import DashboardTab from './tabs/DashboardTab';
import UsersTab from './tabs/UsersTab';
import TenantsTab from './tabs/TenantsTab';
import BillingTab from './tabs/BillingTab';
import UsageTab from './tabs/UsageTab';
import TokensTab from './tabs/TokensTab';
import AuditTab from './tabs/AuditTab';
import DeploymentsTab from './tabs/DeploymentsTab';
import ConfigTab from './tabs/ConfigTab';
import FeedbackTab from './tabs/FeedbackTab';
import PipelineTab from './tabs/PipelineTab';
import ImpersonationTab from './tabs/ImpersonationTab';
import SystemHealthTab from './tabs/SystemHealthTab';
import { BuildInfo } from '../../BuildInfo';

type EnvMode = 'production' | 'staging' | 'local';

interface Tab {
  key: string;
  label: string;
  component: React.ReactElement;
  group: 'core' | 'ops' | 'data';
  badge?: number; // Optional badge count (e.g., for alerts)
}

export default function WerkingReportAdmin() {
  const [envMode, setEnvMode] = useState<EnvMode>('production');
  const [envLoading, setEnvLoading] = useState(false);
  const [envUrl, setEnvUrl] = useState('');
  const [healthErrorCount, setHealthErrorCount] = useState(0);

  // Load current env mode from server on mount + listen for real-time changes via WebSocket
  useEffect(() => {
    const loadEnv = () => {
      fetch('/api/admin/wr/env')
        .then(r => r.json())
        .then(d => {
          if (d.mode) setEnvMode(d.mode);
          if (d.urls) setEnvUrl(d.mode === 'staging' ? d.urls.staging : d.urls.production);
        })
        .catch(() => {});
    };

    // Initial load
    loadEnv();

    // Listen for env changes via WebSocket (broadcasted from server on POST /api/admin/wr/env)
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${protocol}://${window.location.host}/ws`);
    let fallbackInterval: NodeJS.Timeout | null = null;

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'wr-env-changed' && msg.mode) {
          console.log('[WR Admin] Env changed via WebSocket:', msg.mode);
          setEnvMode(msg.mode);
          // Refetch to get updated URL
          loadEnv();
        }
      } catch (err) {
        console.warn('[WR Admin] Failed to parse WebSocket message:', err);
      }
    };

    ws.onerror = (err) => {
      console.warn('[WR Admin] WebSocket error, falling back to polling:', err);
      // Fallback to polling if WebSocket fails (30s instead of 5s to reduce load)
      if (!fallbackInterval) {
        fallbackInterval = setInterval(loadEnv, 30000);
      }
    };

    return () => {
      ws.close();
      if (fallbackInterval) clearInterval(fallbackInterval);
    };
  }, []);

  // Poll system health for badge count every 30s
  useEffect(() => {
    const checkHealth = () => {
      fetch('/api/admin/wr/system-health')
        .then(r => r.json())
        .then(d => {
          setHealthErrorCount(d.errorCount || 0);
        })
        .catch(() => {});
    };
    checkHealth();
    const interval = setInterval(checkHealth, 30000);
    return () => clearInterval(interval);
  }, []);

  const switchEnv = useCallback(async (mode: EnvMode) => {
    setEnvLoading(true);
    try {
      const res = await fetch('/api/admin/wr/env', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      const data = await res.json();
      if (data.mode) setEnvMode(data.mode);
      if (data.url) setEnvUrl(data.url);
    } catch { /* ignore */ }
    setEnvLoading(false);
  }, []);

  // Pass envMode to tabs so they refetch when env changes
  const tabs: Tab[] = [
    { key: 'dashboard', label: 'Dashboard', component: <ErrorBoundary componentName="DashboardTab"><DashboardTab envMode={envMode} /></ErrorBoundary>, group: 'core' },
    { key: 'users', label: 'Users', component: <ErrorBoundary componentName="UsersTab"><UsersTab envMode={envMode} /></ErrorBoundary>, group: 'core' },
    { key: 'impersonation', label: 'Impersonation', component: <ErrorBoundary componentName="ImpersonationTab"><ImpersonationTab envMode={envMode} /></ErrorBoundary>, group: 'core' },
    { key: 'tenants', label: 'Tenants', component: <ErrorBoundary componentName="TenantsTab"><TenantsTab envMode={envMode} /></ErrorBoundary>, group: 'core' },
    { key: 'billing', label: 'Billing', component: <ErrorBoundary componentName="BillingTab"><BillingTab envMode={envMode} /></ErrorBoundary>, group: 'data' },
    { key: 'usage', label: 'Usage', component: <ErrorBoundary componentName="UsageTab"><UsageTab envMode={envMode} /></ErrorBoundary>, group: 'data' },
    { key: 'tokens', label: 'API Tokens', component: <ErrorBoundary componentName="TokensTab"><TokensTab envMode={envMode} /></ErrorBoundary>, group: 'ops' },
    { key: 'audit', label: 'Audit', component: <ErrorBoundary componentName="AuditTab"><AuditTab envMode={envMode} /></ErrorBoundary>, group: 'data' },
    { key: 'pipeline', label: 'Pipeline', component: <ErrorBoundary componentName="PipelineTab"><PipelineTab envMode={envMode} /></ErrorBoundary>, group: 'ops' },
    { key: 'deployments', label: 'Deploy', component: <ErrorBoundary componentName="DeploymentsTab"><DeploymentsTab envMode={envMode} /></ErrorBoundary>, group: 'ops' },
    { key: 'system-health', label: 'System Health', component: <ErrorBoundary componentName="SystemHealthTab"><SystemHealthTab envMode={envMode} /></ErrorBoundary>, group: 'ops', badge: healthErrorCount },
    { key: 'config', label: 'Config', component: <ErrorBoundary componentName="ConfigTab"><ConfigTab envMode={envMode} /></ErrorBoundary>, group: 'ops' },
    { key: 'feedback', label: 'Feedback', component: <ErrorBoundary componentName="FeedbackTab"><FeedbackTab envMode={envMode} /></ErrorBoundary>, group: 'data' },
  ];

  const [activeTab, setActiveTab] = useState(tabs[0].key);

  const isStaging = envMode === 'staging';

  const tabGroupColors: Record<string, string> = {
    core: 'var(--tn-blue)',
    ops: 'var(--tn-orange)',
    data: 'var(--tn-green)',
  };

  return (
    <div data-panel="admin-wr" data-ai-id="panel-wr-admin" style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      background: 'var(--tn-surface)',
    }}>
      {/* Header */}
      <div data-ai-id="wr-header" style={{
        background: 'var(--tn-bg-dark)',
        borderBottom: `2px solid ${isStaging ? 'var(--tn-orange)' : 'var(--tn-border)'}`,
        flexShrink: 0,
      }}>
        <div data-ai-id="wr-header-content" style={{
          padding: '8px 12px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}>
          <span data-ai-id="wr-title" style={{ fontSize: 13, fontWeight: 700, color: 'var(--tn-text)', flex: 1 }}>
            WERKING REPORT ADMIN
          </span>
          <BuildInfo />

          {/* Env Toggle */}
          <div data-ai-id="wr-env-toggle-container" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div data-ai-id="wr-env-toggle" style={{ display: 'flex', border: `1px solid ${isStaging ? 'var(--tn-orange)' : envMode === 'local' ? 'var(--tn-green)' : 'var(--tn-border)'}`, borderRadius: 4, overflow: 'hidden' }}>
              {(['production', 'staging', 'local'] as EnvMode[]).map((mode, idx, arr) => (
                <button
                  key={mode}
                  data-ai-id={`wr-env-btn-${mode}`}
                  data-env-mode={mode}
                  data-active={envMode === mode}
                  onClick={() => { if (!envLoading && envMode !== mode) switchEnv(mode); }}
                  disabled={envLoading}
                  title={mode === 'production' ? 'Live production (main branch)' : mode === 'staging' ? 'Staging preview (develop branch)' : 'Local development (localhost:3008)'}
                  style={{
                    padding: '3px 8px',
                    fontSize: 10,
                    fontWeight: 600,
                    cursor: envLoading ? 'not-allowed' : envMode === mode ? 'default' : 'pointer',
                    background: envMode === mode
                      ? (mode === 'staging' ? 'rgba(224,175,104,0.25)' : mode === 'local' ? 'rgba(158,206,106,0.25)' : 'rgba(122,162,247,0.25)')
                      : 'transparent',
                    border: 'none',
                    color: envMode === mode
                      ? (mode === 'staging' ? 'var(--tn-orange)' : mode === 'local' ? 'var(--tn-green)' : 'var(--tn-blue)')
                      : 'var(--tn-text-muted)',
                    borderRight: idx < arr.length - 1 ? '1px solid var(--tn-border)' : 'none',
                    transition: 'all 0.15s',
                    opacity: envLoading ? 0.5 : 1,
                  }}
                >
                  {mode === 'production' ? 'PROD' : mode === 'staging' ? 'STAGING' : 'LOCAL'}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Env URL hint */}
        {envUrl && (
          <div data-ai-id="wr-env-url" style={{ padding: '0 12px 4px', fontSize: 9, color: 'var(--tn-text-muted)', fontFamily: 'monospace', opacity: 0.7 }}>
            {envUrl.replace('https://', '')}
          </div>
        )}

        {/* Tabs - grouped with subtle separators */}
        <div data-ai-id="wr-tabs" style={{
          display: 'flex',
          gap: 3,
          padding: '0 12px 8px',
          flexWrap: 'wrap',
          alignItems: 'center',
        }}>
          {tabs.map((tab, i) => {
            const prevGroup = i > 0 ? tabs[i - 1].group : null;
            const showSep = prevGroup && prevGroup !== tab.group;
            return (
              <React.Fragment key={tab.key}>
                {showSep && (
                  <div data-ai-id={`wr-tab-separator-${tab.key}`} style={{
                    width: 1, height: 16, background: 'var(--tn-border)', margin: '0 3px',
                  }} />
                )}
                <button
                  data-ai-id={`wr-tab-${tab.key}`}
                  data-tab-group={tab.group}
                  data-active={activeTab === tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  style={{
                    background: activeTab === tab.key
                      ? (isStaging ? 'var(--tn-orange)' : tabGroupColors[tab.group])
                      : 'transparent',
                    border: 'none',
                    color: activeTab === tab.key ? '#fff' : 'var(--tn-text-muted)',
                    padding: '4px 10px',
                    borderRadius: 4,
                    fontSize: 10,
                    fontWeight: 600,
                    cursor: 'pointer',
                    transition: 'all 0.15s',
                    position: 'relative',
                  }}
                >
                  {tab.label}
                  {tab.badge != null && tab.badge > 0 && (
                    <span data-ai-id={`wr-badge-${tab.key}`} style={{
                      position: 'absolute',
                      top: -4,
                      right: -4,
                      background: 'var(--tn-red)',
                      color: '#fff',
                      fontSize: 8,
                      fontWeight: 700,
                      borderRadius: 8,
                      padding: '1px 4px',
                      minWidth: 14,
                      textAlign: 'center',
                      boxShadow: '0 0 4px rgba(247,118,142,0.5)',
                    }}>
                      {tab.badge}
                    </span>
                  )}
                </button>
              </React.Fragment>
            );
          })}
        </div>
      </div>

      {/* Tab Content */}
      <div data-ai-id={`wr-tab-content-${activeTab}`} style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        {tabs.find((t) => t.key === activeTab)?.component}
      </div>
    </div>
  );
}
