import { useState } from 'react';
import UsersTab from './tabs/UsersTab';
import BillingTab from './tabs/BillingTab';
import UsageTab from './tabs/UsageTab';
import FeedbackTab from './tabs/FeedbackTab';

interface Tab {
  key: string;
  label: string;
  component: JSX.Element;
}

export default function WerkingReportAdmin() {
  const tabs: Tab[] = [
    { key: 'users', label: 'Users', component: <UsersTab /> },
    { key: 'billing', label: 'Billing', component: <BillingTab /> },
    { key: 'usage', label: 'Usage', component: <UsageTab /> },
    { key: 'feedback', label: 'Feedback', component: <FeedbackTab /> },
  ];

  const [activeTab, setActiveTab] = useState(tabs[0].key);

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
        borderBottom: '1px solid var(--tn-border)',
        flexShrink: 0,
      }}>
        <div style={{
          padding: '8px 12px',
          fontSize: 13,
          fontWeight: 700,
          color: 'var(--tn-text)',
        }}>
          WERKING REPORT ADMIN
        </div>

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
                background: activeTab === tab.key ? 'var(--tn-blue)' : 'transparent',
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
