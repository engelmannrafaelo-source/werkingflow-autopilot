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
import InvoicesTab from './InvoicesTab';
import SystemHealthTab from './SystemHealthTab';
import { ModeProvider, usePlatformMode, type PlatformMode } from './ModeContext';

type TabKey = 'usage' | 'users' | 'tenants' | 'billing' | 'invoices' | 'activity' | 'feedback' | 'audit' | 'tokens' | 'stammdaten' | 'system';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'usage',      label: 'Usage' },
  { key: 'users',      label: 'Users' },
  { key: 'tenants',    label: 'Tenants' },
  { key: 'billing',    label: 'Billing' },
  { key: 'invoices',   label: 'Invoices' },
  { key: 'activity',   label: 'Activity' },
  { key: 'feedback',   label: 'Feedback' },
  { key: 'audit',      label: 'Audit' },
  { key: 'tokens',     label: 'API Tokens' },
  { key: 'stammdaten', label: 'Stammdaten' },
  { key: 'system',     label: 'System' },
];

const MODES: { key: PlatformMode; label: string; color: string }[] = [
  { key: 'all',     label: 'All',     color: '#6b7280' },
  { key: 'prod',    label: 'Prod',    color: 'var(--tn-red, #ef4444)' },
  { key: 'staging', label: 'Staging', color: 'var(--tn-yellow, #d97706)' },
  { key: 'local',   label: 'Local',   color: 'var(--tn-green, #16a34a)' },
];

export default function PlatformAdmin() {
  return (
    <ModeProvider>
      <PlatformAdminInner />
    </ModeProvider>
  );
}

function PlatformAdminInner() {
  const [active, setActive] = useState<TabKey>('usage');
  const { mode, setMode } = usePlatformMode();
  const activeModeColor = MODES.find((m) => m.key === mode)?.color || '#6b7280';

  return (
    <div data-ai-id="platform-admin-panel" style={style.root}>
      <header style={style.header}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
          <div>
            <div style={style.title}>
              Platform Admin
              <span
                data-ai-id={`platform-admin-mode-indicator-${mode}`}
                style={{
                  marginLeft: 10, padding: '2px 8px', borderRadius: 3,
                  fontSize: 9, fontWeight: 700, letterSpacing: '0.08em',
                  textTransform: 'uppercase', background: activeModeColor, color: '#fff',
                }}
              >
                {mode}
              </span>
            </div>
            <div style={style.subtitle}>Bridge ist Single Source of Truth — cross-app, cross-tenant.</div>
          </div>
          <div data-ai-id="platform-admin-mode-toggle" style={style.modeToggle}>
            <span style={style.modeLabel}>Mode:</span>
            {MODES.map((m) => (
              <button
                key={m.key}
                data-ai-id={`platform-admin-mode-${m.key}`}
                onClick={() => setMode(m.key)}
                style={{
                  ...style.modeBtn,
                  background: mode === m.key ? m.color : 'transparent',
                  color: mode === m.key ? '#fff' : 'var(--tn-text)',
                  borderColor: mode === m.key ? m.color : 'var(--tn-border)',
                }}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>
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
        <div style={{ display: active === 'invoices' ? 'block' : 'none', height: '100%' }}>
          <ErrorBoundary componentName="PlatformInvoicesTab"><InvoicesTab /></ErrorBoundary>
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
        <div style={{ display: active === 'system' ? 'block' : 'none', height: '100%' }}>
          <ErrorBoundary componentName="PlatformSystemTab"><SystemHealthTab /></ErrorBoundary>
        </div>
      </div>
    </div>
  );
}

const style: Record<string, React.CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--tn-bg)' },
  header: { padding: '10px 12px', borderBottom: '1px solid var(--tn-border)', flexShrink: 0 },
  title: { fontSize: 14, fontWeight: 700, color: 'var(--tn-text)', letterSpacing: '0.02em', display: 'flex', alignItems: 'center' },
  subtitle: { fontSize: 10, color: 'var(--tn-text-muted)', marginTop: 2 },
  modeToggle: { display: 'flex', alignItems: 'center', gap: 4 },
  modeLabel: { fontSize: 10, color: 'var(--tn-text-muted)', marginRight: 4, textTransform: 'uppercase', letterSpacing: '0.05em' },
  modeBtn: { padding: '3px 9px', borderRadius: 3, fontSize: 11, fontWeight: 600, border: '1px solid var(--tn-border)', cursor: 'pointer', transition: 'all 0.15s' },
  tabs: { display: 'flex', gap: 4, padding: '6px 12px', borderBottom: '1px solid var(--tn-border)', flexShrink: 0 },
  tabBtn: { padding: '4px 12px', borderRadius: 4, fontSize: 11, fontWeight: 600, border: 'none', cursor: 'pointer', transition: 'all 0.15s' },
  body: { flex: 1, overflow: 'hidden', minHeight: 0 },
};
