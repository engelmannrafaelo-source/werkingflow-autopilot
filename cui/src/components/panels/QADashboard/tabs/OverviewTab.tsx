import React, { useState, useEffect } from 'react';
import type { OverviewData } from '../types';

const APP_NAMES: Record<string, string> = {
  'werking-report': 'WerkING Report',
  'engelmann': 'Engelmann AI Hub',
  'platform': 'WerkIngFlow Platform',
  'werking-energy': 'WerkING Energy',
  'werking-safety': 'WerkING Safety',
  'werking-noise': 'WerkING Noise',
  'cui': 'CUI System',
  'energy-report': 'Energy Report'
};

export default function OverviewTab() {
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = async () => {
    try {
      setError(null);
      const res = await fetch('/api/qa/overview');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000); // 30s
    return () => clearInterval(interval);
  }, []);

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

  // Status-Farbe
  const statusColor = (status: string) => {
    switch (status) {
      case 'tested': return 'var(--tn-green)';
      case 'partial': return 'var(--tn-blue)';
      case 'failing': return 'var(--tn-red)';
      default: return 'var(--tn-text-muted)';
    }
  };

  // Score-Farbe
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
        <KPICard
          label="Total Features"
          value={totals.features}
          color="var(--tn-blue)"
        />
        <KPICard
          label="Tested"
          value={totals.tested}
          color="var(--tn-green)"
        />
        <KPICard
          label="Coverage"
          value={`${totals.coverage.toFixed(1)}%`}
          color="var(--tn-purple)"
        />
        <KPICard
          label="Avg Score"
          value={totals.avgScore.toFixed(1)}
          color={scoreColor(totals.avgScore)}
        />
        <KPICard
          label="Apps with Issues"
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
                width: 10,
                height: 10,
                borderRadius: '50%',
                background: statusColor(app.status),
                boxShadow: `0 0 8px ${statusColor(app.status)}`,
                flexShrink: 0
              }} />
              <span style={{
                fontSize: 14,
                fontWeight: 700,
                color: 'var(--tn-text)',
                flex: 1
              }}>
                {APP_NAMES[app.id] || app.id}
              </span>
            </div>

            {/* Scores */}
            <div style={{ marginBottom: 12 }}>
              <div style={{
                fontSize: 28,
                fontWeight: 800,
                color: scoreColor(app.avgScore),
                marginBottom: 4
              }}>
                {app.avgScore > 0 ? app.avgScore.toFixed(1) : '—'}
              </div>
              <div style={{
                fontSize: 10,
                color: 'var(--tn-text-muted)',
                textTransform: 'uppercase',
                letterSpacing: 1
              }}>
                Average Score
              </div>
            </div>

            {/* Stats */}
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              fontSize: 11,
              color: 'var(--tn-text-muted)'
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>Coverage:</span>
                <span style={{ color: 'var(--tn-text)', fontWeight: 600 }}>
                  {app.coveragePercent.toFixed(1)}%
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>Features:</span>
                <span style={{ color: 'var(--tn-text)', fontWeight: 600 }}>
                  {app.testedFeatures} / {app.totalFeatures}
                </span>
              </div>
              {app.issues > 0 && (
                <div style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  color: 'var(--tn-red)',
                  fontWeight: 700
                }}>
                  <span>⚠️ Issues:</span>
                  <span>{app.issues}</span>
                </div>
              )}
            </div>

            {/* Mode Scores */}
            <div style={{
              display: 'flex',
              gap: 6,
              marginTop: 10,
              paddingTop: 10,
              borderTop: '1px solid var(--tn-border)'
            }}>
              {app.scores.backend != null && (
                <ModeBadge label="BE" score={app.scores.backend} />
              )}
              {app.scores.frontend != null && (
                <ModeBadge label="FE" score={app.scores.frontend} />
              )}
              {app.scores.visual != null && (
                <ModeBadge label="VIS" score={app.scores.visual} />
              )}
            </div>

            {/* Last Tested */}
            {app.lastTested && (
              <div style={{
                fontSize: 9,
                color: 'var(--tn-text-muted)',
                marginTop: 8,
                fontFamily: 'monospace'
              }}>
                Last: {new Date(app.lastTested).toLocaleDateString()}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// Helper Components
function KPICard({ label, value, color }: { label: string; value: string | number; color: string }) {
  return (
    <div style={{
      background: 'var(--tn-bg-dark)',
      border: '1px solid var(--tn-border)',
      borderRadius: 6,
      padding: 12,
      textAlign: 'center'
    }}>
      <div style={{
        fontSize: 9,
        color: 'var(--tn-text-muted)',
        textTransform: 'uppercase',
        letterSpacing: 1,
        marginBottom: 6
      }}>
        {label}
      </div>
      <div style={{
        fontSize: 24,
        fontWeight: 800,
        color
      }}>
        {value}
      </div>
    </div>
  );
}

function ModeBadge({ label, score }: { label: string; score: number }) {
  const color = score >= 8 ? 'var(--tn-green)' : score >= 6 ? 'var(--tn-orange)' : 'var(--tn-red)';
  return (
    <div style={{
      flex: 1,
      background: 'rgba(30, 45, 74, 0.5)',
      border: `1px solid ${color}`,
      borderRadius: 4,
      padding: '4px 6px',
      textAlign: 'center'
    }}>
      <div style={{
        fontSize: 8,
        color: 'var(--tn-text-muted)',
        marginBottom: 2
      }}>
        {label}
      </div>
      <div style={{
        fontSize: 12,
        fontWeight: 700,
        color
      }}>
        {score.toFixed(1)}
      </div>
    </div>
  );
}
