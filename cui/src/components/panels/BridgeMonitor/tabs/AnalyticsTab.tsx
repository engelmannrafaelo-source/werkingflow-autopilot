import { useState } from 'react';
import ErrorBoundary from '../../../ErrorBoundary';
import DashboardTab from './DashboardTab';
import MetrikenTab from './MetrikenTab';
import PromptPerformanceTab from './PromptPerformanceTab';
import ForecastTab from './ForecastTab';
import UsageAnalyticsTab from './UsageAnalyticsTab';
import CCUsageTab from './CCUsageTab';

type SubView = 'overview' | 'metriken' | 'agents' | 'throughput' | 'usage' | 'accounts';

const SUB_VIEWS: { key: SubView; label: string }[] = [
  { key: 'overview',   label: 'Overview' },
  { key: 'metriken',   label: 'Metriken' },
  { key: 'agents',     label: 'Agents' },
  { key: 'throughput', label: 'Throughput' },
  { key: 'usage',      label: 'Usage' },
  { key: 'accounts',   label: 'Accounts' },
];

export default function AnalyticsTab() {
  const [active, setActive] = useState<SubView>('overview');

  return (
    <div data-ai-id="analytics-tab" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div data-ai-id="analytics-sub-tabs" style={{
        display: 'flex', gap: 4, padding: '8px 12px',
        borderBottom: '1px solid var(--tn-border)', flexShrink: 0,
      }}>
        {SUB_VIEWS.map(sv => (
          <button
            key={sv.key}
            data-ai-id={`analytics-sub-tab-${sv.key}`}
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
        <div style={{ display: active === 'overview' ? 'block' : 'none', height: '100%' }}>
          <ErrorBoundary componentName="DashboardTab"><DashboardTab /></ErrorBoundary>
        </div>
        <div style={{ display: active === 'metriken' ? 'block' : 'none', height: '100%' }}>
          <ErrorBoundary componentName="MetrikenTab"><MetrikenTab /></ErrorBoundary>
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
        <div style={{ display: active === 'accounts' ? 'block' : 'none', height: '100%' }}>
          <ErrorBoundary componentName="CCUsageTab"><CCUsageTab /></ErrorBoundary>
        </div>
      </div>
    </div>
  );
}
