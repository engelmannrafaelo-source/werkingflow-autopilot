import React, { useState, useEffect, useCallback } from 'react';
import UsersTab from './tabs/UsersTab';
import BillingTab from './tabs/BillingTab';
import UsageTab from './tabs/UsageTab';
import FeedbackTab from './tabs/FeedbackTab';

type EnvMode = 'production' | 'staging';

interface Tab {
  key: string;
  label: string;
  component: React.ReactElement;
}

export default function WerkingReportAdmin() {
  const [envMode, setEnvMode] = useState<EnvMode>('production');
  const [envLoading, setEnvLoading] = useState(false);
  const [envUrl, setEnvUrl] = useState('');

  // Load current env mode from server on mount
  useEffect(() => {
    fetch('/api/admin/wr/env')
      .then(r => r.json())
      .then(d => {
        if (d.mode) setEnvMode(d.mode);
        if (d.urls) setEnvUrl(d.mode === 'staging' ? d.urls.staging : d.urls.production);
      })
      .catch(() => {});
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
    { key: 'users', label: 'Users', component: <UsersTab envMode={envMode} /> },
    { key: 'billing', label: 'Billing', component: <BillingTab envMode={envMode} /> },
    { key: 'usage', label: 'Usage', component: <UsageTab envMode={envMode} /> },
    { key: 'feedback', label: 'Feedback', component: <FeedbackTab envMode={envMode} /> },
  ];

  const [activeTab, setActiveTab] = useState(tabs[0].key);

  const isStaging = envMode === 'staging';

  return (
    <div data-panel="admin-wr" style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      background: 'var(--tn-surface)',
    }}>
      {/* Header */}
      <div style={{
        background: 'var(--tn-bg-dark)',
        borderBottom: `2px solid ${isStaging ? 'var(--tn-orange)' : 'var(--tn-border)'}`,
        flexShrink: 0,
      }}>
        <div style={{
          padding: '8px 12px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--tn-text)', flex: 1 }}>
            WERKING REPORT ADMIN
          </span>

          {/* Env Toggle */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            {/* Toggle buttons */}
            <div style={{ display: 'flex', border: `1px solid ${isStaging ? 'var(--tn-orange)' : 'var(--tn-border)'}`, borderRadius: 4, overflow: 'hidden' }}>
              {(['production', 'staging'] as EnvMode[]).map(mode => (
                <button
                  key={mode}
                  onClick={() => { if (!envLoading && envMode !== mode) switchEnv(mode); }}
                  disabled={envLoading}
                  title={mode === 'production' ? 'Live production (main branch)' : 'Staging preview (develop branch)'}
                  style={{
                    padding: '3px 8px',
                    fontSize: 10,
                    fontWeight: 600,
                    cursor: envLoading ? 'not-allowed' : envMode === mode ? 'default' : 'pointer',
                    background: envMode === mode
                      ? (mode === 'staging' ? 'rgba(224,175,104,0.25)' : 'rgba(122,162,247,0.25)')
                      : 'transparent',
                    border: 'none',
                    color: envMode === mode
                      ? (mode === 'staging' ? 'var(--tn-orange)' : 'var(--tn-blue)')
                      : 'var(--tn-text-muted)',
                    borderRight: mode === 'production' ? '1px solid var(--tn-border)' : 'none',
                    transition: 'all 0.15s',
                    opacity: envLoading ? 0.5 : 1,
                  }}
                >
                  {mode === 'production' ? 'PROD' : 'STAGING'}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Env URL hint */}
        {envUrl && (
          <div style={{ padding: '0 12px 4px', fontSize: 9, color: 'var(--tn-text-muted)', fontFamily: 'monospace', opacity: 0.7 }}>
            {envUrl.replace('https://', '')}
          </div>
        )}

        {/* Tabs */}
        <div style={{
          display: 'flex',
          gap: 4,
          padding: '0 12px 8px',
        }}>
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              style={{
                background: activeTab === tab.key
                  ? (isStaging ? 'var(--tn-orange)' : 'var(--tn-blue)')
                  : 'transparent',
                border: 'none',
                color: activeTab === tab.key ? '#fff' : 'var(--tn-text-muted)',
                padding: '4px 12px',
                borderRadius: 4,
                fontSize: 11,
                fontWeight: 600,
                cursor: 'pointer',
                transition: 'all 0.15s',
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
