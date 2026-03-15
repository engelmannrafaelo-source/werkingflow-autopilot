import React, { useState, useEffect, useCallback } from 'react';
import type { TestRunsData } from '../types';
import { resilientFetch } from '../../../../utils/resilientFetch';

export default function TestRunsTab() {
  const [data, setData] = useState<TestRunsData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    if ((window as any).__cuiServerAlive === false) return;
    try {
      const res = await resilientFetch('/api/qa/runs');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
    } catch (err) {
      console.warn('[QATestRuns] fetch runs failed:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 10000);
    const onReconnect = () => fetchData();
    window.addEventListener('cui-reconnected', onReconnect);
    return () => { clearInterval(interval); window.removeEventListener('cui-reconnected', onReconnect); };
  }, [fetchData]);

  if (loading) {
    return (
      <div style={{ padding: 20, textAlign: 'center', color: 'var(--tn-text-muted)' }}>
        Loading...
      </div>
    );
  }

  if (!data) return null;

  // Defensive: API may not return all fields
  const running = data.running ?? [];
  const checkpoints = data.checkpoints ?? [];
  const recentRuns = data.recentRuns ?? [];

  return (
    <div style={{ padding: 16, overflow: 'auto' }}>
      {/* Running Tests */}
      <Section title={`🟢 Running Tests (${running.length})`}>
        {running.length === 0 ? (
          <EmptyState>No tests currently running</EmptyState>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {running.map(test => (
              <div
                key={test.pid}
                style={{
                  background: 'var(--tn-bg-dark)',
                  border: '1px solid var(--tn-green)',
                  borderRadius: 8,
                  padding: 14,
                  position: 'relative',
                  overflow: 'hidden'
                }}
              >
                {/* Pulse Animation */}
                <div style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: 4,
                  background: 'var(--tn-green)',
                  animation: 'pulse 2s ease-in-out infinite'
                }} />

                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{
                    width: 10,
                    height: 10,
                    borderRadius: '50%',
                    background: 'var(--tn-green)',
                    boxShadow: '0 0 8px var(--tn-green)',
                    flexShrink: 0
                  }} />
                  <div style={{ flex: 1 }}>
                    <div style={{
                      fontSize: 13,
                      fontWeight: 700,
                      color: 'var(--tn-text)',
                      marginBottom: 4,
                      fontFamily: 'monospace'
                    }}>
                      {test.scenario}
                    </div>
                    <div style={{
                      fontSize: 10,
                      color: 'var(--tn-text-muted)',
                      display: 'flex',
                      gap: 12
                    }}>
                      <span>PID: {test.pid}</span>
                      <span>Started: {test.startedAt}</span>
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(`tail -f ${test.logFile}`);
                    }}
                    style={{
                      background: 'rgba(122, 162, 247, 0.15)',
                      border: '1px solid var(--tn-blue)',
                      borderRadius: 4,
                      padding: '4px 10px',
                      fontSize: 10,
                      color: 'var(--tn-blue)',
                      cursor: 'pointer',
                      fontWeight: 600
                    }}
                  >
                    📋 Copy Log Command
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* Checkpoints */}
      <Section title={`💾 Checkpoints (${checkpoints.length})`}>
        {checkpoints.length === 0 ? (
          <EmptyState>No checkpoints available</EmptyState>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 10 }}>
            {checkpoints.map(cp => (
              <div
                key={cp.scenario}
                style={{
                  background: 'var(--tn-bg-dark)',
                  border: '1px solid var(--tn-border)',
                  borderRadius: 8,
                  padding: 12
                }}
              >
                <div style={{
                  fontSize: 12,
                  fontWeight: 700,
                  color: 'var(--tn-text)',
                  marginBottom: 6,
                  fontFamily: 'monospace'
                }}>
                  {cp.scenario}
                </div>
                <div style={{
                  fontSize: 10,
                  color: 'var(--tn-text-muted)',
                  marginBottom: 8
                }}>
                  Turn {cp.turnNumber} • {cp.savedAt ? new Date(cp.savedAt).toLocaleString() : 'N/A'}
                </div>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(`./test-runner.sh resume ${cp.scenario}`);
                  }}
                  style={{
                    background: 'rgba(158, 206, 106, 0.15)',
                    border: '1px solid var(--tn-green)',
                    borderRadius: 4,
                    padding: '4px 10px',
                    fontSize: 10,
                    color: 'var(--tn-green)',
                    cursor: 'pointer',
                    fontWeight: 600,
                    width: '100%'
                  }}
                >
                  📋 Copy Resume Command
                </button>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* Recent Reports */}
      <Section title={`📋 Recent Reports (${recentRuns.length})`}>
        {recentRuns.length === 0 ? (
          <EmptyState>No recent reports</EmptyState>
        ) : (
          <div style={{
            background: 'var(--tn-bg-dark)',
            border: '1px solid var(--tn-border)',
            borderRadius: 8,
            overflow: 'hidden'
          }}>
            {/* Table Header */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: '150px 120px 120px 100px 80px',
              gap: 8,
              padding: '8px 12px',
              background: 'rgba(30, 45, 74, 0.5)',
              fontSize: 10,
              fontWeight: 700,
              color: 'var(--tn-text-muted)',
              textTransform: 'uppercase',
              letterSpacing: 1,
              borderBottom: '1px solid var(--tn-border)'
            }}>
              <div>Persona</div>
              <div>App</div>
              <div>Mode</div>
              <div>Date</div>
              <div>Status</div>
            </div>

            {/* Table Rows */}
            <div style={{ maxHeight: 400, overflow: 'auto' }}>
              {recentRuns.map((run, idx) => (
                <div
                  key={idx}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '150px 120px 120px 100px 80px',
                    gap: 8,
                    padding: '10px 12px',
                    fontSize: 11,
                    borderBottom: '1px solid var(--tn-border)',
                    cursor: 'pointer',
                    transition: 'background 0.15s'
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'rgba(30, 45, 74, 0.3)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent';
                  }}
                  onClick={() => {
                    navigator.clipboard.writeText(run.path);
                  }}
                  title="Click to copy path"
                >
                  <div style={{ color: 'var(--tn-text)', fontFamily: 'monospace' }}>
                    {run.persona}
                  </div>
                  <div style={{ color: 'var(--tn-text-muted)' }}>
                    {run.app}
                  </div>
                  <div style={{ color: 'var(--tn-text-muted)' }}>
                    {run.mode}
                  </div>
                  <div style={{ color: 'var(--tn-text-muted)', fontSize: 10 }}>
                    {run.timestamp || 'N/A'}
                  </div>
                  <div>
                    <span style={{
                      fontSize: 8,
                      background: 'rgba(158, 206, 106, 0.15)',
                      color: 'var(--tn-green)',
                      padding: '2px 6px',
                      borderRadius: 3,
                      fontWeight: 700
                    }}>
                      ✓
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </Section>

      {/* CSS Animation */}
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
      `}</style>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <h3 style={{
        fontSize: 14,
        fontWeight: 700,
        color: 'var(--tn-text)',
        marginBottom: 12
      }}>
        {title}
      </h3>
      {children}
    </div>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      padding: 20,
      textAlign: 'center',
      color: 'var(--tn-text-muted)',
      fontSize: 11,
      background: 'var(--tn-bg-dark)',
      border: '1px solid var(--tn-border)',
      borderRadius: 8
    }}>
      {children}
    </div>
  );
}
