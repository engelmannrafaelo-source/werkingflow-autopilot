import React, { useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AppDetailData, ReportData } from '../types';
import { resilientFetch } from '../../../../utils/resilientFetch';

const APP_IDS = ['werking-report', 'engelmann', 'werking-energy', 'werking-safety', 'werking-noise', 'platform'];

const LAYER_NAMES: Record<number, string> = {
  0: 'L0 Contracts',
  1: 'L1 Backend',
  2: 'L2 Components',
  3: 'L3 Workflows',
  4: 'L4 Golden',
  [-1]: 'Ungrouped',
};

export default function ScoresTab() {
  const [selectedApp, setSelectedApp] = useState(APP_IDS[0]);
  const [data, setData] = useState<AppDetailData | null>(null);
  const [selectedReport, setSelectedReport] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = async (appId: string) => {
    if ((window as any).__cuiServerAlive === false) return;
    setLoading(true);
    try {
      const res = await resilientFetch(`/api/qa/app/${appId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
    } catch (err) {
      console.warn('[QAScores] fetch app data failed:', err);
      setData(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData(selectedApp);
  }, [selectedApp]);

  const fetchReport = async (reportPath: string) => {
    if ((window as any).__cuiServerAlive === false) return;
    try {
      const res = await fetch(`/api/qa/report?path=${encodeURIComponent(reportPath)}`, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setSelectedReport({ filename: reportPath, content: json.content, score: null, reasoning: json.content });
    } catch (err) {
      console.warn('[QAScores] fetch report failed:', err);
    }
  };

  const scoreColor = (score: number | null) => {
    if (score == null || score === 0) return 'var(--tn-text-muted)';
    if (score >= 8) return 'var(--tn-green)';
    if (score >= 6) return 'var(--tn-orange)';
    return 'var(--tn-red)';
  };

  const statusIcon = (status: string) => {
    switch (status) {
      case 'PASS': return '\u2705';
      case 'FAIL': return '\u274C';
      case 'PARTIAL': return '\u26A0\uFE0F';
      case 'ERROR': return '\uD83D\uDCA5';
      default: return '\u23F3';
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* App Selector */}
      <div style={{
        padding: 12, background: 'var(--tn-bg-dark)',
        borderBottom: '1px solid var(--tn-border)',
        display: 'flex', gap: 6, flexWrap: 'wrap'
      }}>
        {APP_IDS.map(appId => (
          <button key={appId} onClick={() => setSelectedApp(appId)}
            style={{
              background: selectedApp === appId ? 'var(--tn-blue)' : 'transparent',
              border: '1px solid var(--tn-border)', borderRadius: 4,
              padding: '4px 10px', fontSize: 11,
              color: selectedApp === appId ? '#fff' : 'var(--tn-text-muted)',
              cursor: 'pointer', fontWeight: 600
            }}>
            {appId}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
        {loading ? (
          <div style={{ textAlign: 'center', color: 'var(--tn-text-muted)', padding: 20 }}>Loading...</div>
        ) : !data || !data.scenarios || data.scenarios.length === 0 ? (
          <div style={{ textAlign: 'center', color: 'var(--tn-text-muted)', padding: 40 }}>
            <div style={{ fontSize: 14, marginBottom: 8 }}>
              No scenario data for <strong style={{ color: 'var(--tn-text)' }}>{selectedApp}</strong>
            </div>
            <div style={{ fontSize: 11 }}>Run scenarios to generate scores and reports.</div>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 16 }}>
            {/* Scenario Table */}
            <div style={{ flex: 1 }}>
              {/* Layer Summary */}
              {data.layers && data.layers.length > 0 && (
                <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
                  {data.layers.map(l => (
                    <div key={l.id} style={{
                      background: 'var(--tn-bg-dark)', border: '1px solid var(--tn-border)',
                      borderRadius: 6, padding: '6px 12px', fontSize: 11, textAlign: 'center'
                    }}>
                      <div style={{ fontWeight: 700, color: 'var(--tn-text)', marginBottom: 2 }}>
                        {LAYER_NAMES[l.id] || `Layer ${l.id}`}
                      </div>
                      <div style={{ color: l.avgScore >= 8 ? 'var(--tn-green)' : l.avgScore >= 6 ? 'var(--tn-orange)' : 'var(--tn-text-muted)' }}>
                        {l.passed}/{l.total} passed {l.avgScore > 0 ? `| ${l.avgScore.toFixed(1)}` : ''}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <h3 style={{ fontSize: 14, fontWeight: 700, color: 'var(--tn-text)', marginBottom: 12 }}>
                Scenarios ({data.scenarios.length}) — Avg: {data.statistics.avgScore.toFixed(1)}/10
              </h3>

              <div style={{
                background: 'var(--tn-bg-dark)', border: '1px solid var(--tn-border)',
                borderRadius: 8, overflow: 'hidden'
              }}>
                {/* Table Header */}
                <div style={{
                  display: 'grid', gridTemplateColumns: '2.5fr 1fr 0.8fr 0.8fr',
                  gap: 8, padding: '8px 12px',
                  background: 'rgba(30, 45, 74, 0.5)',
                  fontSize: 10, fontWeight: 700, color: 'var(--tn-text-muted)',
                  textTransform: 'uppercase', letterSpacing: 1,
                  borderBottom: '1px solid var(--tn-border)'
                }}>
                  <div>Scenario</div>
                  <div>Layer</div>
                  <div>Status</div>
                  <div>Score</div>
                </div>

                {/* Table Rows */}
                {data.scenarios
                  .sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
                  .map(scenario => (
                    <div
                      key={scenario.id}
                      style={{
                        display: 'grid', gridTemplateColumns: '2.5fr 1fr 0.8fr 0.8fr',
                        gap: 8, padding: '10px 12px', fontSize: 11,
                        borderBottom: '1px solid var(--tn-border)',
                        cursor: scenario.reportPath ? 'pointer' : 'default',
                        transition: 'background 0.15s'
                      }}
                      onMouseEnter={(e) => { if (scenario.reportPath) e.currentTarget.style.background = 'rgba(30, 45, 74, 0.3)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                      onClick={() => { if (scenario.reportPath) fetchReport(scenario.reportPath); }}
                    >
                      <div style={{ color: 'var(--tn-text)', fontWeight: 600, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {scenario.id}
                        {scenario.reportPath && <span style={{ fontSize: 9, color: 'var(--tn-blue)', marginLeft: 6 }}>doc</span>}
                      </div>
                      <div style={{ color: 'var(--tn-text-muted)', fontSize: 10 }}>
                        {LAYER_NAMES[scenario.layer] || `L${scenario.layer}`}
                      </div>
                      <div style={{ color: scoreColor(scenario.status === 'PASS' ? 8 : scenario.status === 'PARTIAL' ? 6 : 0) }}>
                        {statusIcon(scenario.status)} {scenario.status}
                      </div>
                      <div style={{ color: scoreColor(scenario.score), fontWeight: 700, fontSize: 13 }}>
                        {scenario.score != null && scenario.score > 0 ? scenario.score.toFixed(1) : '\u2014'}
                      </div>
                    </div>
                  ))}
              </div>

              {/* Untested Scenarios */}
              {data.statistics.untestedScenarios.length > 0 && (
                <div style={{
                  marginTop: 12, padding: 12,
                  background: 'rgba(236, 72, 153, 0.1)',
                  border: '1px solid var(--tn-red)',
                  borderRadius: 6, fontSize: 11, color: 'var(--tn-text)'
                }}>
                  <strong style={{ color: 'var(--tn-red)' }}>Pending ({data.statistics.untestedScenarios.length}):</strong>{' '}
                  {data.statistics.untestedScenarios.slice(0, 10).join(', ')}
                  {data.statistics.untestedScenarios.length > 10 && ` ... +${data.statistics.untestedScenarios.length - 10} more`}
                </div>
              )}
            </div>

            {/* Report Viewer */}
            {selectedReport && (
              <div style={{
                width: 420, background: 'var(--tn-bg-dark)',
                border: '1px solid var(--tn-border)', borderRadius: 8,
                padding: 16, overflow: 'auto', flexShrink: 0
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <h4 style={{ fontSize: 12, fontWeight: 700, color: 'var(--tn-text)' }}>Report</h4>
                  <button onClick={() => setSelectedReport(null)}
                    style={{ background: 'transparent', border: 'none', color: 'var(--tn-text-muted)', cursor: 'pointer', fontSize: 16 }}>
                    x
                  </button>
                </div>

                {selectedReport.content && (
                  <div style={{
                    fontSize: 12, color: 'var(--tn-text)', lineHeight: 1.7,
                    background: 'rgba(30, 45, 74, 0.3)', padding: 10, borderRadius: 6,
                    maxHeight: '100%', overflow: 'auto'
                  }} className="qa-report-markdown">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        h1: ({node, ...props}) => <h1 style={{fontSize: '18px', fontWeight: '700', color: 'var(--tn-text)', marginTop: '20px', marginBottom: '10px', borderBottom: '1px solid var(--tn-border)', paddingBottom: '6px'}} {...props} />,
                        h2: ({node, ...props}) => <h2 style={{fontSize: '15px', fontWeight: '600', color: 'var(--tn-text)', marginTop: '16px', marginBottom: '8px'}} {...props} />,
                        h3: ({node, ...props}) => <h3 style={{fontSize: '13px', fontWeight: '600', color: 'var(--tn-blue)', marginTop: '14px', marginBottom: '6px'}} {...props} />,
                        h4: ({node, ...props}) => <h4 style={{fontSize: '12px', fontWeight: '600', color: 'var(--tn-text-muted)', marginTop: '10px', marginBottom: '4px'}} {...props} />,
                        p: ({node, ...props}) => <p style={{marginBottom: '8px', color: 'var(--tn-text)'}} {...props} />,
                        ul: ({node, ...props}) => <ul style={{marginLeft: '16px', marginBottom: '8px', listStyleType: 'disc'}} {...props} />,
                        ol: ({node, ...props}) => <ol style={{marginLeft: '16px', marginBottom: '8px'}} {...props} />,
                        li: ({node, ...props}) => <li style={{marginBottom: '3px', color: 'var(--tn-text)'}} {...props} />,
                        code: ({node, inline, ...props}: any) => inline
                          ? <code style={{background: 'rgba(30, 45, 74, 0.5)', padding: '1px 4px', borderRadius: '3px', fontSize: '11px', fontFamily: 'monospace', color: 'var(--tn-blue)'}} {...props} />
                          : <code style={{display: 'block', background: 'rgba(30, 45, 74, 0.5)', padding: '8px', borderRadius: '4px', fontSize: '11px', fontFamily: 'monospace', overflow: 'auto', marginBottom: '8px', border: '1px solid var(--tn-border)'}} {...props} />,
                        table: ({node, ...props}) => <div style={{overflowX: 'auto', marginBottom: '12px'}}><table style={{width: '100%', borderCollapse: 'collapse', fontSize: '11px'}} {...props} /></div>,
                        thead: ({node, ...props}) => <thead style={{background: 'rgba(30, 45, 74, 0.5)', borderBottom: '2px solid var(--tn-border)'}} {...props} />,
                        th: ({node, ...props}) => <th style={{padding: '6px 8px', textAlign: 'left', fontWeight: '600', borderBottom: '1px solid var(--tn-border)', color: 'var(--tn-text)', whiteSpace: 'nowrap'}} {...props} />,
                        td: ({node, ...props}) => <td style={{padding: '5px 8px', borderBottom: '1px solid var(--tn-border)', color: 'var(--tn-text)'}} {...props} />,
                        blockquote: ({node, ...props}) => <blockquote style={{borderLeft: '3px solid var(--tn-blue)', paddingLeft: '10px', marginLeft: '0', marginBottom: '8px', color: 'var(--tn-text-muted)', fontStyle: 'italic'}} {...props} />,
                        hr: ({node, ...props}) => <hr style={{border: 'none', borderTop: '1px solid var(--tn-border)', margin: '12px 0'}} {...props} />,
                        strong: ({node, ...props}) => <strong style={{fontWeight: '700', color: 'var(--tn-text)'}} {...props} />,
                        a: ({node, ...props}) => <a style={{color: 'var(--tn-blue)', textDecoration: 'none'}} {...props} />,
                      }}
                    >
                      {selectedReport.content}
                    </ReactMarkdown>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
