import React, { useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const APP_IDS = ['werking-report', 'engelmann', 'werking-energy', 'werking-safety', 'werking-noise', 'platform'];
const APP_NAMES: Record<string, string> = {
  'werking-report': 'WerkING Report',
  'engelmann': 'Engelmann AI Hub',
  'platform': 'Platform',
  'werking-energy': 'WerkING Energy',
  'werking-safety': 'WerkING Safety',
  'werking-noise': 'WerkING Noise',
};

interface PyramidTest {
  id: string;
  status: string; // PASS, FAIL, PARTIAL, PENDING
  score: number | null;
  lastRun: string | null;
  reportPath: string | null;
  detail?: string; // e.g. "57/60 routes OK" or "343 endpoint snapshots"
}

interface PyramidLayer {
  id: number; // -1 = ungrouped
  name: string;
  description: string;
  totalTests: number;
  passed: number;
  failed: number;
  pending: number;
  avgScore: number;
  status: string;
  tests: PyramidTest[];
}

interface PyramidData {
  app: string;
  layers: PyramidLayer[];
  timestamp: string;
}

export default function PyramidTab() {
  const [selectedApp, setSelectedApp] = useState(APP_IDS[0]);
  const [pyramid, setPyramid] = useState<PyramidData | null>(null);
  const [expandedLayer, setExpandedLayer] = useState<number | null>(null);
  const [reportContent, setReportContent] = useState<string | null>(null);
  const [reportTitle, setReportTitle] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    setExpandedLayer(null);
    setReportContent(null);

    fetch(`/api/qa/pyramid/${selectedApp}`, { signal: AbortSignal.timeout(20000) })
      .then(r => r.ok ? r.json() : null)
      .then(data => { setPyramid(data); setLoading(false); })
      .catch(() => { setPyramid(null); setLoading(false); });
  }, [selectedApp]);

  const loadReport = async (reportPath: string, title: string) => {
    if (!reportPath) return;
    try {
      const res = await fetch(`/api/qa/report?path=${encodeURIComponent(reportPath)}`, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setReportContent(data.content);
      setReportTitle(title);
    } catch {
      setReportContent('Failed to load report');
      setReportTitle(title);
    }
  };

  const statusColor = (status: string) => {
    switch (status) {
      case 'passed': case 'PASS': return 'var(--tn-green)';
      case 'partial': case 'PARTIAL': return 'var(--tn-orange)';
      case 'failed': case 'FAIL': return 'var(--tn-red)';
      case 'pending': case 'PENDING': return 'var(--tn-text-muted)';
      default: return 'var(--tn-text-muted)';
    }
  };

  const scoreColor = (score: number | null) => {
    if (score == null || score === 0) return 'var(--tn-text-muted)';
    if (score >= 8) return 'var(--tn-green)';
    if (score >= 6) return 'var(--tn-orange)';
    return 'var(--tn-red)';
  };

  if (loading) {
    return <div style={{ padding: 20, textAlign: 'center', color: 'var(--tn-text-muted)' }}>Loading...</div>;
  }

  // Sort layers: 4 on top (narrowest), 0 on bottom (widest) = true pyramid
  const sortedLayers = pyramid ? [...pyramid.layers].filter(l => l.id >= 0).sort((a, b) => b.id - a.id) : [];
  const ungrouped = pyramid?.layers.find(l => l.id === -1);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* App Selector */}
      <div style={{ padding: 12, background: 'var(--tn-bg-dark)', borderBottom: '1px solid var(--tn-border)', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {APP_IDS.map(appId => (
          <button key={appId} onClick={() => setSelectedApp(appId)}
            style={{
              background: selectedApp === appId ? 'var(--tn-blue)' : 'transparent',
              border: '1px solid var(--tn-border)', borderRadius: 4, padding: '4px 10px',
              fontSize: 11, color: selectedApp === appId ? '#fff' : 'var(--tn-text-muted)',
              cursor: 'pointer', fontWeight: 600
            }}>
            {APP_NAMES[appId] || appId}
          </button>
        ))}
      </div>

      {/* Main Content */}
      <div style={{ flex: 1, overflow: 'auto', display: 'flex', gap: 0 }}>
        {/* Left: Pyramid + Tests */}
        <div style={{ flex: 1, overflow: 'auto', padding: 16, minWidth: 0 }}>
          {!pyramid || sortedLayers.length === 0 ? (
            <div style={{ textAlign: 'center', color: 'var(--tn-text-muted)', padding: 40 }}>
              {ungrouped
                ? <span>No layer structure yet — {ungrouped.totalTests} flat scenarios found</span>
                : <span>No test scenarios found for {APP_NAMES[selectedApp] || selectedApp}</span>}
            </div>
          ) : (
            <div style={{ marginBottom: 24 }}>
              <h3 style={{ fontSize: 13, fontWeight: 700, color: 'var(--tn-text)', marginBottom: 16 }}>
                Testing Pyramid — {APP_NAMES[selectedApp] || selectedApp}
              </h3>

              {/* Pyramid */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 700 }}>
                {sortedLayers.map((layer, i) => {
                  const isExpanded = expandedLayer === layer.id;
                  const widthPercent = 35 + (i * (65 / Math.max(sortedLayers.length - 1, 1)));
                  const color = statusColor(layer.status);

                  return (
                    <div key={layer.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                      <button
                        onClick={() => setExpandedLayer(isExpanded ? null : layer.id)}
                        style={{
                          width: `${widthPercent}%`, minWidth: 220,
                          background: `linear-gradient(135deg, ${color}22, ${color}11)`,
                          border: `2px solid ${color}`, borderRadius: 6,
                          padding: '10px 16px', cursor: 'pointer', textAlign: 'left',
                          transition: 'all 0.15s',
                          outline: isExpanded ? `2px solid ${color}` : 'none', outlineOffset: 2,
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <div>
                            <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--tn-text-muted)', textTransform: 'uppercase', letterSpacing: 1 }}>
                              Layer {layer.id}
                            </div>
                            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--tn-text)', marginTop: 2 }}>
                              {layer.name}
                            </div>
                            <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginTop: 2 }}>
                              {layer.description}
                            </div>
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                            {/* Pass/Fail counts */}
                            <div style={{ display: 'flex', gap: 4 }}>
                              <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--tn-green)' }}>
                                {layer.passed}
                              </span>
                              <span style={{ fontSize: 10, color: 'var(--tn-text-muted)' }}>/</span>
                              <span style={{ fontSize: 10, fontWeight: 700, color: layer.failed > 0 ? 'var(--tn-red)' : 'var(--tn-text-muted)' }}>
                                {layer.failed}
                              </span>
                              <span style={{ fontSize: 10, color: 'var(--tn-text-muted)' }}>/</span>
                              <span style={{ fontSize: 10, color: 'var(--tn-text-muted)' }}>
                                {layer.totalTests}
                              </span>
                            </div>
                            <span style={{
                              fontSize: 9, fontWeight: 700, padding: '2px 8px', borderRadius: 3,
                              background: `${color}33`, color, textTransform: 'uppercase',
                            }}>
                              {layer.status}
                            </span>
                          </div>
                        </div>

                        {/* Score bar */}
                        {layer.avgScore > 0 && (
                          <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
                            <div style={{ flex: 1, height: 6, background: 'rgba(255,255,255,0.1)', borderRadius: 3, overflow: 'hidden' }}>
                              <div style={{
                                width: `${(layer.avgScore / 10) * 100}%`, height: '100%',
                                background: scoreColor(layer.avgScore), borderRadius: 3,
                              }} />
                            </div>
                            <span style={{ fontSize: 12, fontWeight: 700, color: scoreColor(layer.avgScore) }}>
                              {layer.avgScore.toFixed(1)}/10
                            </span>
                          </div>
                        )}
                      </button>

                      {/* Expanded: Test List */}
                      {isExpanded && (
                        <div style={{
                          width: `${widthPercent}%`, minWidth: 220, padding: 0,
                          background: 'var(--tn-bg-dark)', border: `1px solid ${color}44`,
                          borderRadius: '0 0 6px 6px', borderTop: 'none', marginTop: -2,
                          overflow: 'hidden',
                        }}>
                          {layer.tests.map(test => (
                            <div key={test.id}
                              onClick={() => test.reportPath && loadReport(test.reportPath, test.id)}
                              style={{
                                display: 'flex', alignItems: 'center', gap: 8,
                                padding: '6px 12px', fontSize: 11,
                                borderBottom: '1px solid var(--tn-border)',
                                cursor: test.reportPath ? 'pointer' : 'default',
                                transition: 'background 0.1s',
                              }}
                              onMouseEnter={(e) => { if (test.reportPath) e.currentTarget.style.background = 'rgba(30,45,74,0.3)'; }}
                              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                            >
                              {/* Status dot */}
                              <span style={{
                                width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                                background: statusColor(test.status),
                              }} />
                              {/* Test ID + detail */}
                              <span style={{ flex: 1, fontFamily: 'monospace', color: 'var(--tn-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {test.id}
                                {test.detail && (
                                  <span style={{ fontSize: 9, color: 'var(--tn-text-muted)', marginLeft: 6, fontFamily: 'inherit' }}>
                                    ({test.detail})
                                  </span>
                                )}
                              </span>
                              {/* Score */}
                              {test.score != null && test.score > 0 && (
                                <span style={{ fontWeight: 700, color: scoreColor(test.score), fontSize: 12 }}>
                                  {test.score.toFixed(1)}
                                </span>
                              )}
                              {/* Last run */}
                              {test.lastRun && (
                                <span style={{ fontSize: 9, color: 'var(--tn-text-muted)' }}>
                                  {test.lastRun}
                                </span>
                              )}
                              {/* Report link indicator */}
                              {test.reportPath && (
                                <span style={{ fontSize: 10, color: 'var(--tn-blue)' }} title="Has report">
                                  doc
                                </span>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Ungrouped Scenarios (flat, not in layers) */}
          {ungrouped && ungrouped.tests.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <h3 style={{ fontSize: 13, fontWeight: 700, color: 'var(--tn-text)', marginBottom: 12 }}>
                Flat Scenarios ({ungrouped.totalTests}) — not yet in layers
              </h3>
              <div style={{ background: 'var(--tn-bg-dark)', border: '1px solid var(--tn-border)', borderRadius: 8, overflow: 'hidden' }}>
                {ungrouped.tests.map(test => (
                  <div key={test.id}
                    onClick={() => test.reportPath && loadReport(test.reportPath, test.id)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '6px 12px', fontSize: 11,
                      borderBottom: '1px solid var(--tn-border)',
                      cursor: test.reportPath ? 'pointer' : 'default',
                    }}
                    onMouseEnter={(e) => { if (test.reportPath) e.currentTarget.style.background = 'rgba(30,45,74,0.3)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: statusColor(test.status) }} />
                    <span style={{ flex: 1, fontFamily: 'monospace', color: 'var(--tn-text)' }}>{test.id}</span>
                    {test.score != null && test.score > 0 && (
                      <span style={{ fontWeight: 700, color: scoreColor(test.score), fontSize: 12 }}>{test.score.toFixed(1)}</span>
                    )}
                    {test.reportPath && <span style={{ fontSize: 10, color: 'var(--tn-blue)' }}>doc</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right: Report Viewer */}
        {reportContent && (
          <div style={{
            width: 420, borderLeft: '1px solid var(--tn-border)',
            background: 'var(--tn-bg-dark)', display: 'flex', flexDirection: 'column', flexShrink: 0,
          }}>
            <div style={{
              padding: '10px 14px', borderBottom: '1px solid var(--tn-border)',
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--tn-text)' }}>{reportTitle}</span>
              <button onClick={() => { setReportContent(null); setReportTitle(''); }}
                style={{ background: 'none', border: 'none', color: 'var(--tn-text-muted)', cursor: 'pointer', fontSize: 16 }}>
                x
              </button>
            </div>
            <div style={{
              flex: 1, overflow: 'auto', padding: 14,
              fontSize: 12, lineHeight: 1.7, color: 'var(--tn-text)',
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
                {reportContent}
              </ReactMarkdown>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
