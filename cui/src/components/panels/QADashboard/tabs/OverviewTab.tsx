import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { OverviewData } from '../types';
import { resilientFetch } from '../../../../utils/resilientFetch';

const APP_NAMES: Record<string, string> = {
  'werking-report': 'WerkING Report',
  'engelmann': 'Engelmann AI Hub',
  'platform': 'WerkIngFlow Platform',
  'werking-energy': 'WerkING Energy',
  'werking-safety': 'WerkING Safety',
  'werking-noise': 'WerkING Noise',
};


export default function OverviewTab() {
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const retryTimer = useRef<ReturnType<typeof setTimeout>>();

  const fetchData = useCallback(async () => {
    if ((window as any).__cuiServerAlive === false) return;
    try {
      setError(null);
      const res = await resilientFetch('/api/qa/overview');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
      if (retryTimer.current) { clearTimeout(retryTimer.current); retryTimer.current = undefined; }
    } catch (err) {
      console.warn('[QAOverview] fetch failed:', err);
      setError(err instanceof Error ? err.message : 'Failed to load');
      retryTimer.current = setTimeout(fetchData, 3000);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000);
    const onReconnect = () => fetchData();
    window.addEventListener('cui-reconnected', onReconnect);
    return () => {
      clearInterval(interval);
      if (retryTimer.current) clearTimeout(retryTimer.current);
      window.removeEventListener('cui-reconnected', onReconnect);
    };
  }, [fetchData]);

  if (loading) {
    return (
      <div style={{ padding: 20, textAlign: 'center', color: 'var(--tn-text-muted)' }}>
        Loading...
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: 20, color: 'var(--tn-red)' }}>
        Error: {error}
      </div>
    );
  }

  if (!data) return null;

  const { apps, totals } = data;

  const statusColor = (status: string) => {
    switch (status) {
      case 'tested': return 'var(--tn-green)';
      case 'partial': return 'var(--tn-blue)';
      case 'failing': return 'var(--tn-red)';
      default: return 'var(--tn-text-muted)';
    }
  };

  const scoreColor = (score: number) => {
    if (score >= 8) return 'var(--tn-green)';
    if (score >= 6) return 'var(--tn-orange)';
    return 'var(--tn-red)';
  };

  return (
    <div style={{ padding: 16, overflow: 'auto' }}>
      {/* KPI Cards */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
        gap: 12,
        marginBottom: 24
      }}>
        <KPICard label="Total Scenarios" value={totals.features} color="var(--tn-blue)" />
        <KPICard label="Passed" value={totals.tested} color="var(--tn-green)" />
        <KPICard label="Coverage" value={`${totals.coverage.toFixed(1)}%`} color="var(--tn-purple)" />
        <KPICard label="Avg Score" value={totals.avgScore.toFixed(1)} color={scoreColor(totals.avgScore)} />
        <KPICard
          label="Apps with Failures"
          value={totals.appsWithIssues}
          color={totals.appsWithIssues > 0 ? 'var(--tn-red)' : 'var(--tn-text-muted)'}
        />
      </div>

      {/* App Cards */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
        gap: 12
      }}>
        {apps.map(app => (
          <div
            key={app.id}
            style={{
              background: 'var(--tn-bg-dark)',
              border: `1px solid ${statusColor(app.status)}`,
              borderRadius: 8,
              padding: 16,
              cursor: 'default',
              transition: 'transform 0.15s',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.transform = 'scale(1.02)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
          >
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <span style={{
                width: 10, height: 10, borderRadius: '50%',
                background: statusColor(app.status),
                boxShadow: `0 0 8px ${statusColor(app.status)}`,
                flexShrink: 0
              }} />
              <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--tn-text)', flex: 1 }}>
                {APP_NAMES[app.id] || app.id}
              </span>
            </div>

            {/* Score */}
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 28, fontWeight: 800, color: scoreColor(app.avgScore), marginBottom: 4 }}>
                {app.avgScore > 0 ? app.avgScore.toFixed(1) : '\u2014'}
              </div>
              <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', textTransform: 'uppercase', letterSpacing: 1 }}>
                Average Score
              </div>
            </div>

            {/* Stats */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 11, color: 'var(--tn-text-muted)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>Coverage:</span>
                <span style={{ color: 'var(--tn-text)', fontWeight: 600 }}>{app.coveragePercent.toFixed(1)}%</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>Scenarios:</span>
                <span style={{ color: 'var(--tn-text)', fontWeight: 600 }}>{app.testedScenarios} / {app.totalScenarios}</span>
              </div>
              {app.issues > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--tn-red)', fontWeight: 700 }}>
                  <span>Failed:</span>
                  <span>{app.issues}</span>
                </div>
              )}
            </div>

            {/* Layer Scores */}
            {app.layers && app.layers.length > 0 && (
              <div style={{
                display: 'flex', gap: 4, marginTop: 10, paddingTop: 10,
                borderTop: '1px solid var(--tn-border)', flexWrap: 'wrap'
              }}>
                {app.layers.map(layer => (
                  <LayerBadge key={layer.id} layer={layer} />
                ))}
              </div>
            )}

            {/* Last Tested */}
            {app.lastTested && (
              <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', marginTop: 8, fontFamily: 'monospace' }}>
                Last: {new Date(app.lastTested).toLocaleDateString()}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function KPICard({ label, value, color }: { label: string; value: string | number; color: string }) {
  return (
    <div style={{
      background: 'var(--tn-bg-dark)', border: '1px solid var(--tn-border)',
      borderRadius: 6, padding: 12, textAlign: 'center'
    }}>
      <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ fontSize: 24, fontWeight: 800, color }}>{value}</div>
    </div>
  );
}

function LayerBadge({ layer }: { layer: { id: number; name: string; passed: number; total: number; avgScore: number; status: string } }) {
  const color = layer.status === 'passed' ? 'var(--tn-green)'
    : layer.status === 'partial' ? 'var(--tn-orange)'
    : layer.status === 'failed' ? 'var(--tn-red)'
    : 'var(--tn-text-muted)';

  return (
    <div style={{
      flex: 1, minWidth: 44,
      background: 'rgba(30, 45, 74, 0.5)',
      border: `1px solid ${color}`,
      borderRadius: 4, padding: '4px 6px', textAlign: 'center'
    }}>
      <div style={{ fontSize: 8, color: 'var(--tn-text-muted)', marginBottom: 2 }}>L{layer.id}</div>
      <div style={{ fontSize: 12, fontWeight: 700, color }}>
        {layer.passed}/{layer.total}
      </div>
    </div>
  );
}

