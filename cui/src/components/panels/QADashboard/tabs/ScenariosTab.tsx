import React, { useState, useEffect, useCallback } from 'react';
import type { ScenariosData } from '../types';
import { resilientFetch } from '../../../../utils/resilientFetch';

export default function ScenariosTab() {
  const [data, setData] = useState<ScenariosData | null>(null);
  const [loading, setLoading] = useState(true);
  const [filterApp, setFilterApp] = useState<string>('all');

  const fetchData = useCallback(async () => {
    if ((window as any).__cuiServerAlive === false) return;
    try {
      const res = await resilientFetch('/api/qa/scenarios');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
    } catch (err) {
      console.warn('[QAScenarios] fetch failed:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const onReconnect = () => fetchData();
    window.addEventListener('cui-reconnected', onReconnect);
    return () => window.removeEventListener('cui-reconnected', onReconnect);
  }, [fetchData]);

  if (loading) {
    return (
      <div style={{ padding: 20, textAlign: 'center', color: 'var(--tn-text-muted)' }}>
        Loading...
      </div>
    );
  }

  if (!data) return null;

  const apps = Array.from(new Set(data.scenarios.map(s => s.app))).sort();
  const filteredScenarios = filterApp === 'all'
    ? data.scenarios
    : data.scenarios.filter(s => s.app === filterApp);

  return (
    <div style={{ padding: 16, overflow: 'auto' }}>
      {/* Filter */}
      <div style={{
        marginBottom: 16,
        display: 'flex',
        gap: 6,
        flexWrap: 'wrap',
        alignItems: 'center'
      }}>
        <span style={{
          fontSize: 11,
          fontWeight: 700,
          color: 'var(--tn-text-muted)',
          textTransform: 'uppercase',
          letterSpacing: 1
        }}>
          Filter:
        </span>
        <button
          onClick={() => setFilterApp('all')}
          style={{
            background: filterApp === 'all' ? 'var(--tn-blue)' : 'transparent',
            border: '1px solid var(--tn-border)',
            borderRadius: 4,
            padding: '4px 10px',
            fontSize: 11,
            color: filterApp === 'all' ? '#fff' : 'var(--tn-text-muted)',
            cursor: 'pointer',
            fontWeight: 600
          }}
        >
          All ({data.scenarios.length})
        </button>
        {apps.map(app => (
          <button
            key={app}
            onClick={() => setFilterApp(app)}
            style={{
              background: filterApp === app ? 'var(--tn-blue)' : 'transparent',
              border: '1px solid var(--tn-border)',
              borderRadius: 4,
              padding: '4px 10px',
              fontSize: 11,
              color: filterApp === app ? '#fff' : 'var(--tn-text-muted)',
              cursor: 'pointer',
              fontWeight: 600
            }}
          >
            {app} ({data.scenarios.filter(s => s.app === app).length})
          </button>
        ))}
      </div>

      {/* Scenarios Grid */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
        gap: 12
      }}>
        {filteredScenarios.map(scenario => (
          <div
            key={`${scenario.app}-${scenario.id}`}
            style={{
              background: 'var(--tn-bg-dark)',
              border: '1px solid var(--tn-border)',
              borderRadius: 8,
              padding: 14,
              transition: 'transform 0.15s, border-color 0.15s',
              cursor: 'default'
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = 'scale(1.02)';
              e.currentTarget.style.borderColor = 'var(--tn-blue)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = 'scale(1)';
              e.currentTarget.style.borderColor = 'var(--tn-border)';
            }}
          >
            {/* Header */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              marginBottom: 10
            }}>
              <StatusBadge status={scenario.status} />
              <div style={{ flex: 1 }}>
                <div style={{
                  fontSize: 13,
                  fontWeight: 700,
                  color: 'var(--tn-text)',
                  marginBottom: 2,
                  fontFamily: 'monospace'
                }}>
                  {scenario.name}
                </div>
                <div style={{
                  fontSize: 9,
                  color: 'var(--tn-text-muted)',
                  textTransform: 'uppercase',
                  letterSpacing: 1
                }}>
                  {scenario.app}
                </div>
              </div>
            </div>

            {/* Details */}
            <div style={{
              fontSize: 10,
              color: 'var(--tn-text-muted)',
              marginBottom: 10
            }}>
              <div>ID: <code style={{ fontFamily: 'monospace', color: 'var(--tn-text)' }}>{scenario.id}</code></div>
              {scenario.lastRun && (
                <div>Last Run: {new Date(scenario.lastRun).toLocaleDateString()}</div>
              )}
            </div>

            {/* File Path */}
            <div style={{
              fontSize: 9,
              color: 'var(--tn-text-muted)',
              fontFamily: 'monospace',
              background: 'rgba(30, 45, 74, 0.3)',
              padding: 6,
              borderRadius: 4,
              marginTop: 8
            }}>
              scenarios/{scenario.app}/{scenario.id}.json
            </div>
          </div>
        ))}
      </div>

      {/* Empty State */}
      {filteredScenarios.length === 0 && (
        <div style={{
          padding: 40,
          textAlign: 'center',
          color: 'var(--tn-text-muted)',
          fontSize: 11
        }}>
          No scenarios found for filter: {filterApp}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, { bg: string; text: string; label: string }> = {
    passed: { bg: 'rgba(158, 206, 106, 0.15)', text: 'var(--tn-green)', label: '✓' },
    failed: { bg: 'rgba(236, 72, 153, 0.15)', text: 'var(--tn-red)', label: '✗' },
    running: { bg: 'rgba(122, 162, 247, 0.15)', text: 'var(--tn-blue)', label: '↻' },
    'never-run': { bg: 'rgba(150, 150, 150, 0.15)', text: 'var(--tn-text-muted)', label: '—' },
    unknown: { bg: 'rgba(150, 150, 150, 0.15)', text: 'var(--tn-text-muted)', label: '?' }
  };

  const style = colors[status] || colors.unknown;

  return (
    <span style={{
      fontSize: 11,
      fontWeight: 700,
      background: style.bg,
      color: style.text,
      padding: '4px 8px',
      borderRadius: 4,
      fontFamily: 'monospace'
    }}>
      {style.label}
    </span>
  );
}
