import React, { useState, useEffect } from 'react';
import type { AppDetailData, ReportData } from '../types';

const APP_IDS = ['werking-report', 'engelmann', 'platform', 'werking-energy', 'werking-safety', 'werking-noise', 'cui', 'energy-report'];

export default function ScoresTab() {
  const [selectedApp, setSelectedApp] = useState(APP_IDS[0]);
  const [data, setData] = useState<AppDetailData | null>(null);
  const [selectedReport, setSelectedReport] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = async (appId: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/qa/app/${appId}`);
      if (res.ok) {
        const json = await res.json();
        setData(json);
      } else {
        setData(null);
      }
    } catch (err) {
      console.error('[QA] Failed to fetch app data:', err);
      setData(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData(selectedApp);
  }, [selectedApp]);

  const fetchReport = async (filename: string) => {
    try {
      const res = await fetch(`/api/qa/report/${filename}`);
      if (res.ok) {
        const json = await res.json();
        setSelectedReport(json);
      }
    } catch (err) {
      console.error('[QA] Failed to fetch report:', err);
    }
  };

  const scoreColor = (score: number | null) => {
    if (score == null) return 'var(--tn-text-muted)';
    if (score >= 8) return 'var(--tn-green)';
    if (score >= 6) return 'var(--tn-orange)';
    return 'var(--tn-red)';
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* App Selector */}
      <div style={{
        padding: 12,
        background: 'var(--tn-bg-dark)',
        borderBottom: '1px solid var(--tn-border)',
        display: 'flex',
        gap: 6,
        flexWrap: 'wrap'
      }}>
        {APP_IDS.map(appId => (
          <button
            key={appId}
            onClick={() => setSelectedApp(appId)}
            style={{
              background: selectedApp === appId ? 'var(--tn-blue)' : 'transparent',
              border: '1px solid var(--tn-border)',
              borderRadius: 4,
              padding: '4px 10px',
              fontSize: 11,
              color: selectedApp === appId ? '#fff' : 'var(--tn-text-muted)',
              cursor: 'pointer',
              fontWeight: 600
            }}
          >
            {appId}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
        {loading ? (
          <div style={{ textAlign: 'center', color: 'var(--tn-text-muted)', padding: 20 }}>
            Loading...
          </div>
        ) : !data ? (
          <div style={{ textAlign: 'center', color: 'var(--tn-red)', padding: 20 }}>
            No data for {selectedApp}
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 16 }}>
            {/* Features Table */}
            <div style={{ flex: 1 }}>
              <h3 style={{
                fontSize: 14,
                fontWeight: 700,
                color: 'var(--tn-text)',
                marginBottom: 12
              }}>
                Features ({data.features.length})
              </h3>

              <div style={{
                background: 'var(--tn-bg-dark)',
                border: '1px solid var(--tn-border)',
                borderRadius: 8,
                overflow: 'hidden'
              }}>
                {/* Table Header */}
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr',
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
                  <div>Feature</div>
                  <div>Backend</div>
                  <div>Frontend</div>
                  <div>Visual</div>
                  <div>Score</div>
                </div>

                {/* Table Rows */}
                {data.features
                  .sort((a, b) => (b.combinedScore ?? -1) - (a.combinedScore ?? -1))
                  .map(feature => {
                    const be = feature.tests?.local?.backend;
                    const fe = feature.tests?.local?.frontend;
                    const vis = feature.tests?.local?.visual;

                    return (
                      <div
                        key={feature.id}
                        style={{
                          display: 'grid',
                          gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr',
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
                          // Wenn Report vorhanden, lade ihn
                          if (be?.report) {
                            const filename = be.report.split('/').pop();
                            if (filename) fetchReport(filename);
                          } else if (fe?.report) {
                            const filename = fe.report.split('/').pop();
                            if (filename) fetchReport(filename);
                          }
                        }}
                      >
                        <div style={{
                          color: 'var(--tn-text)',
                          fontWeight: 600,
                          fontFamily: 'monospace'
                        }}>
                          {feature.name}
                        </div>
                        <ScoreCell score={be?.score ?? null} />
                        <ScoreCell score={fe?.score ?? null} />
                        <ScoreCell score={vis?.score ?? null} />
                        <div style={{
                          color: scoreColor(feature.combinedScore),
                          fontWeight: 700,
                          fontSize: 13
                        }}>
                          {feature.combinedScore != null ? feature.combinedScore.toFixed(1) : '—'}
                        </div>
                      </div>
                    );
                  })}
              </div>

              {/* Untested Features Warning */}
              {data.statistics.untestedFeatures.length > 0 && (
                <div style={{
                  marginTop: 12,
                  padding: 12,
                  background: 'rgba(236, 72, 153, 0.1)',
                  border: '1px solid var(--tn-red)',
                  borderRadius: 6,
                  fontSize: 11,
                  color: 'var(--tn-text)'
                }}>
                  <strong style={{ color: 'var(--tn-red)' }}>⚠️ Untested Features:</strong>{' '}
                  {data.statistics.untestedFeatures.join(', ')}
                </div>
              )}
            </div>

            {/* Report Viewer */}
            {selectedReport && (
              <div style={{
                width: 400,
                background: 'var(--tn-bg-dark)',
                border: '1px solid var(--tn-border)',
                borderRadius: 8,
                padding: 16,
                overflow: 'auto'
              }}>
                <div style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: 12
                }}>
                  <h4 style={{
                    fontSize: 12,
                    fontWeight: 700,
                    color: 'var(--tn-text)'
                  }}>
                    Report
                  </h4>
                  <button
                    onClick={() => setSelectedReport(null)}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      color: 'var(--tn-text-muted)',
                      cursor: 'pointer',
                      fontSize: 16
                    }}
                  >
                    ✕
                  </button>
                </div>

                {selectedReport.score != null && (
                  <div style={{
                    fontSize: 24,
                    fontWeight: 800,
                    color: scoreColor(selectedReport.score),
                    marginBottom: 12
                  }}>
                    Score: {selectedReport.score.toFixed(1)}
                  </div>
                )}

                {selectedReport.reasoning && (
                  <div>
                    <div style={{
                      fontSize: 10,
                      fontWeight: 700,
                      color: 'var(--tn-text-muted)',
                      textTransform: 'uppercase',
                      letterSpacing: 1,
                      marginBottom: 8
                    }}>
                      Begründung
                    </div>
                    <div style={{
                      fontSize: 11,
                      color: 'var(--tn-text)',
                      lineHeight: 1.6,
                      whiteSpace: 'pre-wrap',
                      fontFamily: 'monospace',
                      background: 'rgba(30, 45, 74, 0.3)',
                      padding: 10,
                      borderRadius: 6
                    }}>
                      {selectedReport.reasoning}
                    </div>
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

function ScoreCell({ score }: { score: number | null }) {
  const color = score == null ? 'var(--tn-text-muted)' :
    score >= 8 ? 'var(--tn-green)' :
    score >= 6 ? 'var(--tn-orange)' :
    'var(--tn-red)';

  return (
    <div style={{
      color,
      fontWeight: 700,
      fontSize: 12
    }}>
      {score != null ? score.toFixed(1) : '—'}
    </div>
  );
}
