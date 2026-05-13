import { useState } from 'react';
import ErrorBoundary from '../../ErrorBoundary';
import UsageTab from './UsageTab';
import UsersTab from './UsersTab';
import TenantsTab from './TenantsTab';
import ActivityTab from './ActivityTab';
import BillingTab from './BillingTab';
import FeedbackTab from './FeedbackTab';
import AuditTab from './AuditTab';
import ApiTokensTab from './ApiTokensTab';
import StammdatenTab from './StammdatenTab';

// Central admin panel for the WerkingFlow platform.
//
// All data comes from the Bridge (Single Source of Truth) — apps are not
// queried directly. The Bridge's /v1/* endpoints back each tab.
//
// Today only the Usage tab is live (against Hetzner /v1/metrics/usage-breakdown).
// Users / Tenants / Billing / Activity / Feedback wait for their Bridge endpoints
// to ship — they render a clear "what's coming" placeholder until then so the
// shape of the future panel is visible from day one.

type TabKey = 'usage' | 'users' | 'tenants' | 'billing' | 'activity' | 'feedback' | 'audit' | 'tokens' | 'stammdaten';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'usage',      label: 'Usage' },
  { key: 'users',      label: 'Users' },
  { key: 'tenants',    label: 'Tenants' },
  { key: 'billing',    label: 'Billing' },
  { key: 'activity',   label: 'Activity' },
  { key: 'feedback',   label: 'Feedback' },
  { key: 'audit',      label: 'Audit' },
  { key: 'tokens',     label: 'API Tokens' },
  { key: 'stammdaten', label: 'Stammdaten' },
];

export default function PlatformAdmin() {
  const [active, setActive] = useState<TabKey>('usage');

  return (
    <div data-ai-id="platform-admin-panel" style={style.root}>
      <header style={style.header}>
        <div style={style.title}>Platform Admin</div>
        <div style={style.subtitle}>Bridge ist Single Source of Truth — cross-app, cross-tenant.</div>
      </header>

      <nav data-ai-id="platform-admin-tabs" style={style.tabs}>
        {TABS.map((t) => (
          <button
            key={t.key}
            data-ai-id={`platform-admin-tab-${t.key}`}
            onClick={() => setActive(t.key)}
            style={{
              ...style.tabBtn,
              background: active === t.key ? 'var(--tn-blue)' : 'transparent',
              color: active === t.key ? '#fff' : 'var(--tn-text-muted)',
            }}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div style={style.body}>
        <div style={{ display: active === 'usage' ? 'block' : 'none', height: '100%' }}>
          <ErrorBoundary componentName="PlatformUsageTab"><UsageTab /></ErrorBoundary>
        </div>
        <div style={{ display: active === 'users' ? 'block' : 'none', height: '100%' }}>
          <ErrorBoundary componentName="PlatformUsersTab"><UsersTab /></ErrorBoundary>
        </div>
        <div style={{ display: active === 'tenants' ? 'block' : 'none', height: '100%' }}>
          <ErrorBoundary componentName="PlatformTenantsTab"><TenantsTab /></ErrorBoundary>
        </div>
        <div style={{ display: active === 'billing' ? 'block' : 'none', height: '100%' }}>
          <ErrorBoundary componentName="PlatformBillingTab"><BillingTab /></ErrorBoundary>
        </div>
        <div style={{ display: active === 'activity' ? 'block' : 'none', height: '100%' }}>
          <ErrorBoundary componentName="PlatformActivityTab"><ActivityTab /></ErrorBoundary>
        </div>
        <div style={{ display: active === 'feedback' ? 'block' : 'none', height: '100%' }}>
          <ErrorBoundary componentName="PlatformFeedbackTab"><FeedbackTab /></ErrorBoundary>
        </div>
        <div style={{ display: active === 'audit' ? 'block' : 'none', height: '100%' }}>
          <ErrorBoundary componentName="PlatformAuditTab"><AuditTab /></ErrorBoundary>
        </div>
        <div style={{ display: active === 'tokens' ? 'block' : 'none', height: '100%' }}>
          <ErrorBoundary componentName="PlatformApiTokensTab"><ApiTokensTab /></ErrorBoundary>
        </div>
        <div style={{ display: active === 'stammdaten' ? 'block' : 'none', height: '100%' }}>
          <ErrorBoundary componentName="PlatformStammdatenTab"><StammdatenTab /></ErrorBoundary>
        </div>
      </div>
    </div>
  );
}

const style: Record<string, React.CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--tn-bg)' },
  header: { padding: '10px 12px', borderBottom: '1px solid var(--tn-border)', flexShrink: 0 },
  title: { fontSize: 14, fontWeight: 700, color: 'var(--tn-text)', letterSpacing: '0.02em' },
  subtitle: { fontSize: 10, color: 'var(--tn-text-muted)', marginTop: 2 },
  tabs: { display: 'flex', gap: 4, padding: '6px 12px', borderBottom: '1px solid var(--tn-border)', flexShrink: 0 },
  tabBtn: { padding: '4px 12px', borderRadius: 4, fontSize: 11, fontWeight: 600, border: 'none', cursor: 'pointer', transition: 'all 0.15s' },
  body: { flex: 1, overflow: 'hidden', minHeight: 0 },
};
