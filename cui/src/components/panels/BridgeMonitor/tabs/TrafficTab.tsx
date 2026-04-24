import { useState } from 'react';
import ErrorBoundary from '../../../ErrorBoundary';
import LogsTab from './LogsTab';
import ActivityFeedTab from './ActivityFeedTab';
import PromptPerformanceTab from './PromptPerformanceTab';
import ForecastTab from './ForecastTab';
import UsageAnalyticsTab from './UsageAnalyticsTab';
import MetrikenTab from './MetrikenTab';

type SubView = 'logs' | 'live' | 'agents' | 'throughput' | 'usage' | 'metriken';

const SUB_VIEWS: { key: SubView; label: string }[] = [
  { key: 'logs', label: 'Request Log' },
  { key: 'live', label: 'Live Feed' },
  { key: 'agents', label: 'Agents' },
  { key: 'throughput', label: 'Throughput' },
  { key: 'usage', label: 'Usage' },
  { key: 'metriken', label: 'Metriken' },
];

export default function TrafficTab() {
  const [active, setActive] = useState<SubView>('logs');

  return (
    <div data-ai-id="traffic-tab" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Sub-view toggle */}
      <div data-ai-id="traffic-sub-tabs" style={{
        display: 'flex', gap: 4, padding: '8px 12px',
        borderBottom: '1px solid var(--tn-border)', flexShrink: 0,
      }}>
        {SUB_VIEWS.map(sv => (
          <button
            key={sv.key}
            data-ai-id={`traffic-sub-tab-${sv.key}`}
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

      {/* Sub-view content */}
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        <div style={{ display: active === 'logs' ? 'block' : 'none', height: '100%' }}>
          <ErrorBoundary componentName="LogsTab"><LogsTab /></ErrorBoundary>
        </div>
        <div style={{ display: active === 'live' ? 'block' : 'none', height: '100%' }}>
          <ErrorBoundary componentName="ActivityFeedTab"><ActivityFeedTab /></ErrorBoundary>
        </div>
        <div style={{ display: active === 'agents' ? 'block' : 'none', height: '100%' }}>
          <ErrorBoundary componentName="PromptPerformanceTab"><PromptPerformanceTab /></ErrorBoundary>
        </div>
        <div style={{ display: active === 'throughput' ? 'block' : 'none', height: '100%' }}>
          <ErrorBoundary componentName="ForecastTab"><ForecastTab /></ErrorBoundary>
        </div>
        <div style={{ display: active === 'usage' ? 'block' : 'none', height: '100%' }}>
          <ErrorBoundary componentName="UsageAnalyticsTab"><UsageAnalyticsTab /></ErrorBoundary>
        </div>
        <div style={{ display: active === 'metriken' ? 'block' : 'none', height: '100%' }}>
          <ErrorBoundary componentName="MetrikenTab"><MetrikenTab /></ErrorBoundary>
        </div>
      </div>
    </div>
  );
}
