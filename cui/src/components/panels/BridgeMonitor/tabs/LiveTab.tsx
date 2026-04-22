import { useState } from 'react';
import ErrorBoundary from '../../../ErrorBoundary';
import LogsTab from './LogsTab';
import ActivityFeedTab from './ActivityFeedTab';
import WorkersTab from './WorkersTab';
import SessionsTab from './SessionsTab';

type SubView = 'requests' | 'feed' | 'workers' | 'sessions';

const SUB_VIEWS: { key: SubView; label: string }[] = [
  { key: 'requests', label: 'Request Log' },
  { key: 'feed',     label: 'Live Feed' },
  { key: 'workers',  label: 'Workers' },
  { key: 'sessions', label: 'Sessions' },
];

export default function LiveTab() {
  const [active, setActive] = useState<SubView>('requests');

  return (
    <div data-ai-id="live-tab" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div data-ai-id="live-sub-tabs" style={{
        display: 'flex', gap: 4, padding: '8px 12px',
        borderBottom: '1px solid var(--tn-border)', flexShrink: 0,
      }}>
        {SUB_VIEWS.map(sv => (
          <button
            key={sv.key}
            data-ai-id={`live-sub-tab-${sv.key}`}
            onClick={() => setActive(sv.key)}
            style={{
              padding: '4px 12px', borderRadius: 4, fontSize: 11, fontWeight: 600,
              cursor: 'pointer', border: 'none', transition: 'all 0.15s',
              background: active === sv.key ? 'var(--tn-blue)' : 'transparent',
              color: active === sv.key ? '#fff' : 'var(--tn-text-muted)',
            }}
          >
            {sv.label}
          </button>
        ))}
      </div>

      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        <div style={{ display: active === 'requests' ? 'block' : 'none', height: '100%' }}>
          <ErrorBoundary componentName="LogsTab"><LogsTab /></ErrorBoundary>
        </div>
        <div style={{ display: active === 'feed' ? 'block' : 'none', height: '100%' }}>
          <ErrorBoundary componentName="ActivityFeedTab"><ActivityFeedTab /></ErrorBoundary>
        </div>
        <div style={{ display: active === 'workers' ? 'block' : 'none', height: '100%' }}>
          <ErrorBoundary componentName="WorkersTab"><WorkersTab /></ErrorBoundary>
        </div>
        <div style={{ display: active === 'sessions' ? 'block' : 'none', height: '100%' }}>
          <ErrorBoundary componentName="SessionsTab"><SessionsTab /></ErrorBoundary>
        </div>
      </div>
    </div>
  );
}
