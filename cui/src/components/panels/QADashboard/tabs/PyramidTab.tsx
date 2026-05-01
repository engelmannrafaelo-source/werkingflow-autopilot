import React, { useState, useEffect, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { validateApiResponse } from '../../../../lib/validateApiResponse';
import { resilientFetch } from '../../../../utils/resilientFetch';
import type { JourneyData, JourneyStep } from '../types';

const APP_IDS = ['werking-report', 'engelmann', 'werking-energy', 'werking-safety', 'werking-noise', 'platform', 'acro-community', 'cui'];
const APP_NAMES: Record<string, string> = {
  'werking-report': 'WerkING Report',
  'engelmann': 'Engelmann AI Hub',
  'platform': 'Platform',
  'werking-energy': 'WerkING Energy',
  'werking-safety': 'WerkING Safety',
  'werking-noise': 'WerkING Noise',
  'acro-community': 'Acro Community',
  'cui': 'CUI Workspace',
};

interface PyramidTest {
  id: string;
  status: string; // PASS, FAIL, PARTIAL, PENDING, NOT_RUN
  score?: number | null;
  lastRun?: string | null;
  reportPath?: string | null;
  detail?: string; // e.g. "57/60 routes OK" or "343 endpoint snapshots"
  description?: string | null;
  stepsPreview?: string | null;
  criteriaPreview?: string | null;
  reviewExcerpt?: string | null;
  scenarioJson?: any | null; // Full scenario definition
  outputQualityScore?: number | null; // Persona's subjective output review 0-10
  group?: 'core' | 'llm_enhanced'; // Layer 0 sub-grouping
  tooltip?: string; // LLM test: what it does
  outputs?: string; // LLM test: expected outputs
}


interface PyramidLayer {
  id: number; // -1 = ungrouped, 0.5 = LLM-Enhanced
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

interface CoverageSummary {
  api: { pct: number; total: number; covered: number };
  ui: { pct: number; total: number; covered: number };
  combined: number;
  timestamp?: string | null;
}

interface PyramidData {
  app: string;
  layers: PyramidLayer[];
  timestamp?: string;
  coverage?: CoverageSummary | null;
}

// Staleness types
interface StaleScenario {
  scenario_id: string;
  layer: number | null;
  status: string;
  score: number | null;
  tested_at: string | null;
  latest_change: string | null;
  staleness_reason: string;
  reasons: string[];
  changed_files: string[];
}

interface StalenessData {
  stale_scenarios?: StaleScenario[];
  per_layer?: Record<number, StaleScenario[]>;
  summary?: { total_stale: number; total_scenarios: number; stale_by_layer: Record<number, number> };
  changed_files_count?: number;
  head_commit?: string | null;
  timestamp?: string;
}

const coverageColor = (pct: number) => {
  if (pct >= 70) return 'var(--tn-green)';
  if (pct >= 40) return 'var(--tn-orange)';
  return 'var(--tn-red)';
};

const scoreColor = (score: number | null) => {
  if (score == null || score === 0) return 'var(--tn-text-muted)';
  if (score >= 8) return 'var(--tn-green)';
  if (score >= 6) return 'var(--tn-orange)';
  return 'var(--tn-red)';
};

/** Compute days since a date string (YYYY-MM-DD or ISO). Returns null if no date. */
const daysAgo = (dateStr: string | null | undefined): number | null => {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
};

/** Human-readable relative age */
const formatAge = (days: number | null): string => {
  if (days == null) return 'never';
  if (days === 0) return 'today';
  if (days === 1) return '1d ago';
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
};

/** Bar opacity based on test age: fresh=1.0, fading with age */
const ageOpacity = (dateStr: string | null | undefined): number => {
  const days = daysAgo(dateStr);
  if (days == null) return 0.25; // never run → very faded
  if (days <= 1) return 1.0;
  if (days <= 3) return 0.85;
  if (days <= 7) return 0.65;
  if (days <= 14) return 0.45;
  return 0.3; // > 2 weeks
};

/** Color tint for age: green=fresh, orange=aging, red=old */
const ageColor = (dateStr: string | null | undefined): string => {
  const days = daysAgo(dateStr);
  if (days == null) return 'var(--tn-text-muted)';
  if (days <= 1) return 'var(--tn-green)';
  if (days <= 3) return 'var(--tn-text-muted)';
  if (days <= 7) return '#ffaa00';
  return 'var(--tn-red)';
};

/** Color tint for age from days number directly */
const ageColorFromDays = (days: number | null): string => {
  if (days == null) return 'var(--tn-text-muted)';
  if (days <= 1) return 'var(--tn-green)';
  if (days <= 3) return 'var(--tn-text-muted)';
  if (days <= 7) return '#ffaa00';
  return 'var(--tn-red)';
};

/** Compute oldest and newest lastRun for a layer's tests */
const layerAgeStats = (tests: PyramidTest[]): { oldest: number | null; newest: number | null; neverRun: number } => {
  let oldest: number | null = null;
  let newest: number | null = null;
  let neverRun = 0;
  for (const t of tests) {
    const d = daysAgo(t.lastRun);
    if (d == null) { neverRun++; continue; }
    if (oldest == null || d > oldest) oldest = d;
    if (newest == null || d < newest) newest = d;
  }
  return { oldest, newest, neverRun };
};

// layerCoverage removed — coverage is app-wide and shown in the KPI header only

// Slide-in sidebar for test detail — split view: Review (top) + Scenario JSON (bottom)
function TestDetailSidebar({ test, onClose }: {
  test: PyramidTest;
  onClose: () => void;
}) {
  const [activePane, setActivePane] = useState<'review' | 'scenario' | 'journey'>('review');
  const statusLabel = (test.score ?? 0) >= 8 ? 'PASS' : (test.score ?? 0) >= 5 ? 'PARTIAL' : (test.score ?? 0) > 0 ? 'FAIL' : 'PENDING';
  const color = scoreColor(test.score ?? 0);

  // Format scenario JSON for display (exclude large fields)
  const formatScenario = (json: any) => {
    if (!json) return 'No scenario data available';
    const display = { ...json };
    // Remove conversation field if present (too large)
    delete display.conversation;
    return JSON.stringify(display, null, 2);
  };

  return (
    <div style={{
      width: 480, flexShrink: 0, borderLeft: '1px solid var(--tn-border, #333)',
      background: 'var(--tn-bg-surface, #1a1a2e)', display: 'flex', flexDirection: 'column',
      animation: 'slideInRight 0.15s ease-out',
    }}>
      {/* Sticky header */}
      <div style={{
        padding: '10px 12px', borderBottom: '1px solid var(--tn-border, #333)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8,
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 12, color: 'var(--tn-text)', wordBreak: 'break-word' }}>{test.id}</div>
          {test.description && (
            <div style={{ color: 'var(--tn-text-muted)', fontSize: 10, marginTop: 2, fontStyle: 'italic' }}>{test.description}</div>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <span style={{
            fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 4,
            background: color + '22', color,
          }}>
            {test.score != null ? `${test.score.toFixed(1)} ${statusLabel}` : statusLabel}
          </span>
          <button
            onClick={onClose}
            style={{
              background: 'none', border: 'none', color: 'var(--tn-text-muted)', cursor: 'pointer',
              fontSize: 16, lineHeight: 1, padding: '2px 4px',
            }}
            title="Close"
          >&times;</button>
        </div>
      </div>

      {/* Tab switcher: Review | Scenario */}
      <div style={{
        display: 'flex', borderBottom: '1px solid var(--tn-border, #333)',
        padding: '0 12px', gap: 0,
      }}>
        {(['review', 'scenario', 'journey'] as const).map(pane => (
          <button
            key={pane}
            onClick={() => setActivePane(pane)}
            style={{
              background: 'none', border: 'none', borderBottom: activePane === pane ? '2px solid var(--tn-accent, #6366f1)' : '2px solid transparent',
              color: activePane === pane ? 'var(--tn-text)' : 'var(--tn-text-muted)',
              padding: '6px 12px', fontSize: 10, fontWeight: 600, cursor: 'pointer',
              textTransform: 'uppercase', letterSpacing: 0.5,
            }}
          >
            {pane === 'review' ? 'Review' : pane === 'scenario' ? 'Scenario' : 'Journey'}
          </button>
        ))}
      </div>

      {/* Scrollable content — full height, no truncation */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '10px 12px', fontSize: 11, lineHeight: 1.5 }}>
        {activePane === 'review' ? (
          <>
            {/* Review pane */}
            {test.reviewExcerpt && (
              <Section title="Review">
                <pre style={preStyle}>{test.reviewExcerpt}</pre>
              </Section>
            )}

            {test.stepsPreview && (
              <Section title="Steps">
                <pre style={preStyle}>{test.stepsPreview}</pre>
              </Section>
            )}

            {test.criteriaPreview && (
              <Section title="Criteria">
                <pre style={preStyle}>{test.criteriaPreview}</pre>
              </Section>
            )}

            {test.outputQualityScore != null && test.outputQualityScore > 0 && (
              <Section title="Output Quality (Persona Review)">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{
                    fontSize: 16, fontWeight: 700,
                    color: scoreColor(test.outputQualityScore),
                  }}>
                    {test.outputQualityScore.toFixed(1)}/10
                  </span>
                  <span style={{ fontSize: 10, color: 'var(--tn-text-muted)' }}>
                    subjective persona review
                  </span>
                </div>
              </Section>
            )}

            {/* Dependencies from scenario JSON */}
            {test.scenarioJson?.dependencies?.requires_scenarios?.length > 0 && (
              <Section title="Dependencies">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {test.scenarioJson.dependencies.requires_scenarios.map((dep: string | { id: string }, i: number) => (
                    <div key={i} style={{
                      fontSize: 10, padding: '2px 6px', borderRadius: 3,
                      background: 'var(--tn-bg-hover, #252540)', color: 'var(--tn-text-muted)',
                      fontFamily: 'monospace',
                    }}>
                      {typeof dep === 'string' ? dep : dep.id}
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {/* Meta footer */}
            <div style={{ marginTop: 12, paddingTop: 8, borderTop: '1px solid var(--tn-border, #333)', fontSize: 9, color: 'var(--tn-text-muted)', opacity: 0.6 }}>
              {test.lastRun && <div>Tested: {test.lastRun}</div>}
              {test.detail && <div>{test.detail}</div>}
              {test.reportPath && <div style={{ wordBreak: 'break-all', marginTop: 2 }}>{test.reportPath.split('/').pop()}</div>}
            </div>
          </>
        ) : activePane === 'scenario' ? (
          <>
            {/* Scenario JSON pane */}
            <Section title="Scenario Definition">
              <pre style={{
                ...preStyle, fontSize: 10, background: 'var(--tn-bg-hover, #252540)',
                padding: 8, borderRadius: 4, maxHeight: 'none', overflow: 'visible',
              }}>
                {formatScenario(test.scenarioJson)}
              </pre>
            </Section>
          </>
        ) : (
          <JourneyPane scenarioId={test.id} persona={test.id} />
        )}
      </div>
    </div>
  );
}

// Reusable section block for sidebar
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--tn-text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>{title}</div>
      {children}
    </div>
  );
}

const preStyle: React.CSSProperties = {
  margin: 0, whiteSpace: 'pre-wrap', fontSize: 10.5, color: 'var(--tn-text)',
  opacity: 0.9, fontFamily: 'inherit', lineHeight: 1.5,
};

// --- Journey Pane (inline in sidebar) ---

function JourneyPane({ scenarioId, persona }: { scenarioId: string; persona: string }) {
  const [journeyData, setJourneyData] = useState<JourneyData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    resilientFetch(`/api/qa/journey?scenario=${encodeURIComponent(persona)}&latest=true`)
      .then(res => res.ok ? res.json() : null)
      .then(data => { if (data) setJourneyData(data); })
      .catch(() => {}) // silent-ok: journey fetch failure shows 'No journey data' message to user
      .finally(() => setLoading(false));
  }, [persona]);

  if (loading) {
    return <div style={{ padding: 16, textAlign: 'center', color: 'var(--tn-text-muted)', fontSize: 10 }}>Loading journey...</div>;
  }

  const journey = journeyData?.journeys?.[0];
  if (!journey || journey.steps.length === 0) {
    return (
      <div style={{ padding: 16, textAlign: 'center', color: 'var(--tn-text-muted)', fontSize: 10 }}>
        <div style={{ marginBottom: 4 }}>No journey data for this scenario.</div>
        <div style={{ fontSize: 9 }}>Journey logs are created during Playwright tests (Layer 2+).</div>
      </div>
    );
  }

  return (
    <div>
      {/* Journey meta */}
      <div style={{ marginBottom: 10, fontSize: 9, color: 'var(--tn-text-muted)', display: 'flex', gap: 12 }}>
        <span>{journey.totalSteps} steps</span>
        <span>{Math.round(journey.duration)}s</span>
        <span>{new Date(journey.startedAt).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
      </div>

      {/* Timeline */}
      <div style={{ position: 'relative', paddingLeft: 18 }}>
        {/* Vertical line */}
        <div style={{
          position: 'absolute', left: 5, top: 0, bottom: 0, width: 2,
          background: 'var(--tn-border, #333)',
        }} />

        {journey.steps.map((step, idx) => (
          <JourneyStepCard key={step.nr} step={step} isLast={idx === journey.steps.length - 1} />
        ))}
      </div>
    </div>
  );
}

function JourneyStepCard({ step, isLast }: { step: JourneyStep; isLast: boolean }) {
  const [imgSrc, setImgSrc] = useState<string | null>(null);
  const [imgLoading, setImgLoading] = useState(false);

  useEffect(() => {
    if (!step.screenshotExists) return;
    setImgLoading(true);
    resilientFetch(`/api/qa/file-preview?path=${encodeURIComponent(step.screenshotPath)}`)
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data?.type === 'image' && data.base64) {
          setImgSrc(`data:${data.mimeType ?? 'image/png'};base64,${data.base64}`);
        }
      })
      .catch(() => {}) // silent-ok: screenshot fetch failure shows step without image
      .finally(() => setImgLoading(false));
  }, [step.screenshotPath, step.screenshotExists]);

  const actionColor = step.action === 'navigate' ? '#7aa2f7'
    : step.action === 'click' ? '#9ece6a'
    : '#565f89';

  const time = step.timestamp ? new Date(step.timestamp).toLocaleTimeString('de-DE', {
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }) : '';

  return (
    <div style={{ position: 'relative', marginBottom: isLast ? 0 : 12 }}>
      {/* Dot */}
      <div style={{
        position: 'absolute', left: -18, top: 2, width: 12, height: 12,
        borderRadius: '50%', background: actionColor,
        border: '2px solid var(--tn-bg-surface, #1a1a2e)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 6, color: '#fff', fontWeight: 700, zIndex: 1,
      }}>
        {step.nr}
      </div>

      {/* Card */}
      <div style={{
        background: 'var(--tn-bg-hover, #252540)',
        border: '1px solid var(--tn-border, #333)',
        borderRadius: 6, overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{ padding: '5px 8px', display: 'flex', alignItems: 'center', gap: 6, borderBottom: '1px solid var(--tn-border, #333)' }}>
          <span style={{
            fontSize: 7, fontWeight: 700, padding: '1px 4px', borderRadius: 2,
            background: actionColor + '33', color: actionColor,
            textTransform: 'uppercase', letterSpacing: 0.3,
          }}>
            {step.action}
          </span>
          <span style={{
            flex: 1, fontSize: 9, fontFamily: 'monospace', color: 'var(--tn-text)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {step.command}
          </span>
          <span style={{ fontSize: 8, color: 'var(--tn-text-muted)', whiteSpace: 'nowrap' }}>{time}</span>
        </div>

        {/* URL */}
        {step.url && (
          <div style={{
            padding: '2px 8px', fontSize: 8, fontFamily: 'monospace',
            color: '#7aa2f7', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {step.url}
          </div>
        )}

        {/* AI Note */}
        {step.note && (
          <div style={{
            padding: '2px 8px', fontSize: 8, color: '#565f89',
            fontStyle: 'italic', lineHeight: 1.3,
          }}>
            {step.note}
          </div>
        )}

        {/* Screenshot */}
        {step.screenshotExists && (
          <div style={{ padding: 4 }}>
            {imgLoading && (
              <div style={{ padding: 8, textAlign: 'center', color: 'var(--tn-text-muted)', fontSize: 8 }}>Loading...</div>
            )}
            {imgSrc && (
              <img src={imgSrc} alt={`Step ${step.nr}`} style={{
                width: '100%', borderRadius: 3, border: '1px solid var(--tn-border, #333)',
              }} />
            )}
          </div>
        )}
      </div>

      {/* Arrow */}
      {!isLast && (
        <div style={{
          position: 'absolute', left: -15, bottom: -10,
          fontSize: 8, color: 'var(--tn-text-muted)',
        }}>
          ▼
        </div>
      )}
    </div>
  );
}

function CoverageKPIHeader({ coverage, appId, onRefreshed }: {
  coverage: CoverageSummary;
  appId: string;
  onRefreshed: (cov: CoverageSummary) => void;
}) {
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const res = await fetch(`/api/qa/coverage-gaps/${appId}/refresh`, {
        method: 'POST',
        signal: AbortSignal.timeout(90000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      onRefreshed({
        api: { pct: data.api?.pct ?? 0, total: data.api?.total ?? 0, covered: data.api?.covered ?? 0 },
        ui: { pct: data.ui?.pct ?? 0, total: data.ui?.total ?? 0, covered: data.ui?.covered ?? 0 },
        combined: data.api?.status === 'ok' && data.ui?.status === 'ok'
          ? Math.round(((data.api.pct + data.ui.pct) / 2) * 10) / 10
          : Math.round((data.api?.pct ?? data.ui?.pct ?? 0) * 10) / 10,
        timestamp: data.timestamp ?? null,
      });
    } catch (err) {
      console.error('Coverage refresh failed:', err);
    } finally {
      setRefreshing(false);
    }
  };

  const items = [
    { label: 'API', pct: coverage.api.pct, detail: `${coverage.api.covered}/${coverage.api.total}` },
    { label: 'UI', pct: coverage.ui.pct, detail: `${coverage.ui.covered}/${coverage.ui.total}` },
    { label: 'Combined', pct: coverage.combined, detail: null },
  ];

  return (
    <div style={{ display: 'flex', gap: 8, marginBottom: 14, alignItems: 'stretch' }}>
      {items.map(item => {
        const color = coverageColor(item.pct);
        return (
          <div key={item.label} style={{
            flex: 1, background: 'var(--tn-bg-dark)', borderRadius: 6, padding: '8px 12px',
            border: '1px solid var(--tn-border)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--tn-text-muted)', textTransform: 'uppercase', letterSpacing: 1 }}>
                {item.label}
              </span>
              <span style={{ fontSize: 12, fontWeight: 700, color }}>
                {item.pct.toFixed(1)}%
              </span>
            </div>
            <div style={{ height: 4, background: 'rgba(255,255,255,0.08)', borderRadius: 2, overflow: 'hidden' }}>
              <div style={{ width: `${Math.min(item.pct, 100)}%`, height: '100%', background: color, borderRadius: 2, transition: 'width 0.3s' }} />
            </div>
            {item.detail && (
              <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', marginTop: 3 }}>{item.detail} covered</div>
            )}
          </div>
        );
      })}
      <button
        onClick={handleRefresh}
        disabled={refreshing}
        title="Re-scan codebase and update coverage gaps"
        style={{
          background: 'var(--tn-bg-dark)', border: '1px solid var(--tn-border)', borderRadius: 6,
          padding: '8px 12px', cursor: refreshing ? 'wait' : 'pointer',
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          minWidth: 56, opacity: refreshing ? 0.5 : 1, transition: 'opacity 0.2s',
        }}
      >
        <span style={{ fontSize: 16, lineHeight: 1, animation: refreshing ? 'spin 1s linear infinite' : 'none' }}>
          {refreshing ? '...' : '\u21BB'}
        </span>
        <span style={{ fontSize: 8, color: 'var(--tn-text-muted)', marginTop: 2, fontWeight: 600 }}>
          {refreshing ? 'SCANNING' : 'RESCAN'}
        </span>
      </button>
    </div>
  );
}

// MiniCoverageBar removed — coverage is app-wide, shown in KPI header only

function GenerateCoverageButton({ appId, onGenerated }: { appId: string; onGenerated: (cov: CoverageSummary) => void }) {
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleGenerate = async () => {
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch(`/api/qa/coverage-gaps/${appId}/refresh`, {
        method: 'POST',
        signal: AbortSignal.timeout(90000),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})); // silent-ok: error response parse failure falls back to empty object; HTTP status used for error
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      onGenerated({
        api: { pct: data.api?.pct ?? 0, total: data.api?.total ?? 0, covered: data.api?.covered ?? 0 },
        ui: { pct: data.ui?.pct ?? 0, total: data.ui?.total ?? 0, covered: data.ui?.covered ?? 0 },
        combined: data.api?.status === 'ok' && data.ui?.status === 'ok'
          ? Math.round(((data.api.pct + data.ui.pct) / 2) * 10) / 10
          : Math.round((data.api?.pct ?? data.ui?.pct ?? 0) * 10) / 10,
        timestamp: data.timestamp ?? null,
      });
    } catch (err: any) {
      setError(err.message?.slice(0, 100) || 'Failed');
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, padding: '8px 12px',
      background: 'var(--tn-bg-dark)', border: '1px solid var(--tn-border)', borderRadius: 6,
    }}>
      <span style={{ fontSize: 11, color: 'var(--tn-text-muted)', flex: 1 }}>
        No coverage data yet
      </span>
      <button
        onClick={handleGenerate}
        disabled={generating}
        style={{
          background: 'var(--tn-blue)', border: 'none', borderRadius: 4, padding: '4px 12px',
          fontSize: 10, fontWeight: 700, color: '#fff', cursor: generating ? 'wait' : 'pointer',
          opacity: generating ? 0.6 : 1,
        }}
      >
        {generating ? 'Scanning...' : 'Scan Coverage'}
      </button>
      {error && <span style={{ fontSize: 9, color: 'var(--tn-red)' }}>{error}</span>}
    </div>
  );
}

// ========================================
// Staleness KPI Header
// ========================================
function StalenessKPIHeader({ staleness, appId, onRefreshed, onRetestLayer }: {
  staleness: StalenessData;
  appId: string;
  onRefreshed: (data: StalenessData) => void;
  onRetestLayer: (layer: number) => void;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const totalStale = staleness.summary?.total_stale ?? 0;
  const totalScenarios = staleness.summary?.total_scenarios ?? 0;
  const freshPct = totalScenarios > 0 ? ((totalScenarios - totalStale) / totalScenarios) * 100 : 100;
  const freshColor = freshPct >= 80 ? 'var(--tn-green)' : freshPct >= 50 ? 'var(--tn-orange)' : 'var(--tn-red)';

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const res = await fetch(`/api/qa/staleness/${appId}/refresh`, {
        method: 'POST',
        signal: AbortSignal.timeout(130000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      onRefreshed(data);
    } catch (err) {
      console.error('Staleness refresh failed:', err);
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div style={{
      display: 'flex', gap: 8, marginBottom: 10, alignItems: 'stretch',
    }}>
      {/* Freshness KPI */}
      <div style={{
        flex: 1, background: 'var(--tn-bg-dark)', borderRadius: 6, padding: '8px 12px',
        border: `1px solid ${totalStale > 0 ? 'var(--tn-orange)' : 'var(--tn-border)'}`,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--tn-text-muted)', textTransform: 'uppercase', letterSpacing: 1 }}>
            Freshness
          </span>
          <span style={{ fontSize: 12, fontWeight: 700, color: freshColor }}>
            {freshPct.toFixed(0)}%
          </span>
        </div>
        <div style={{ height: 4, background: 'rgba(255,255,255,0.08)', borderRadius: 2, overflow: 'hidden' }}>
          <div style={{ width: `${Math.min(freshPct, 100)}%`, height: '100%', background: freshColor, borderRadius: 2, transition: 'width 0.3s' }} />
        </div>
        <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', marginTop: 3 }}>
          {totalScenarios - totalStale}/{totalScenarios} up to date
        </div>
      </div>

      {/* Stale Count */}
      <div style={{
        flex: 1, background: 'var(--tn-bg-dark)', borderRadius: 6, padding: '8px 12px',
        border: `1px solid ${totalStale > 0 ? 'var(--tn-orange)' : 'var(--tn-border)'}`,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--tn-text-muted)', textTransform: 'uppercase', letterSpacing: 1 }}>
            Stale
          </span>
          <span style={{ fontSize: 12, fontWeight: 700, color: totalStale > 0 ? 'var(--tn-orange)' : 'var(--tn-green)' }}>
            {totalStale}
          </span>
        </div>
        <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', marginTop: 2 }}>
          {staleness.changed_files_count ?? 0} files changed
        </div>
        {(staleness.head_commit ?? '') && (
          <div style={{ fontSize: 8, color: 'var(--tn-text-muted)', marginTop: 1, fontFamily: 'monospace' }}>
            HEAD: {staleness.head_commit ?? ''}
          </div>
        )}
      </div>

      {/* Scan Button */}
      <button
        onClick={handleRefresh}
        disabled={refreshing}
        title="Re-scan git changes and detect stale tests"
        style={{
          background: 'var(--tn-bg-dark)', border: '1px solid var(--tn-border)', borderRadius: 6,
          padding: '8px 12px', cursor: refreshing ? 'wait' : 'pointer',
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          minWidth: 56, opacity: refreshing ? 0.5 : 1, transition: 'opacity 0.2s',
        }}
      >
        <span style={{ fontSize: 14, lineHeight: 1, animation: refreshing ? 'spin 1s linear infinite' : 'none' }}>
          {refreshing ? '...' : '\u26A1'}
        </span>
        <span style={{ fontSize: 8, color: 'var(--tn-text-muted)', marginTop: 2, fontWeight: 600 }}>
          {refreshing ? 'SCANNING' : 'GIT SCAN'}
        </span>
      </button>
    </div>
  );
}

// Extracted test row component for reuse in grouped/ungrouped rendering
function TestRow({ test, staleIds, staleMap, retesting, onLoadReport, onRetest, statusColor, scoreColor, onSelectTest, sidebarTestId, isLlm }: {
  test: PyramidTest;
  staleIds: Set<string>;
  staleMap: Map<string, StaleScenario>;
  retesting: string | null;
  onLoadReport: (path: string, title: string) => void;
  onRetest: (scenarioId?: string, layer?: number) => void;
  statusColor: (s: string) => string;
  scoreColor: (s: number | null) => string;
  onSelectTest: (t: PyramidTest | null) => void;
  sidebarTestId: string | null;
  isLlm?: boolean;
}) {
  const testId = test.id;
  const testStatus = test.status;
  const isStale = staleIds.has(testId);
  const staleInfo = staleMap.get(testId);
  const isThisRetesting = retesting === testId;
  const notRun = testStatus === 'PENDING' || testStatus === 'NOT_RUN';

  const isPending = testStatus === 'PENDING' || testStatus === 'NOT_RUN';
  const isSidebarSelected = sidebarTestId === testId;

  return (
    <div
      onClick={() => {
        if (test.reportPath) onLoadReport(test.reportPath, testId);
        onSelectTest(isSidebarSelected ? null : test);
      }}
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 12px', fontSize: 11,
        borderBottom: '1px solid var(--tn-border)',
        cursor: 'pointer',
        transition: 'background 0.1s',
        background: isSidebarSelected ? 'rgba(99,102,241,0.12)' : isLlm ? 'rgba(147,130,255,0.02)' : isStale ? 'rgba(255, 170, 0, 0.04)' : 'transparent',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = isSidebarSelected ? 'rgba(99,102,241,0.15)' : isLlm ? 'rgba(147,130,255,0.08)' : isStale ? 'rgba(255, 170, 0, 0.08)' : 'rgba(30,45,74,0.3)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = isSidebarSelected ? 'rgba(99,102,241,0.12)' : isLlm ? 'rgba(147,130,255,0.02)' : isStale ? 'rgba(255, 170, 0, 0.04)' : 'transparent'; }}
    >
      {/* Status dot */}
      <span style={{
        width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
        background: notRun ? 'rgba(147,130,255,0.3)' : statusColor(testStatus),
        boxShadow: isStale ? '0 0 0 2px #ffaa00' : 'none',
      }} />
      {/* Test ID + detail */}
      <span style={{ flex: 1, fontFamily: 'monospace', color: notRun ? 'var(--tn-text-muted)' : 'var(--tn-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {testId}
        {test.detail && (
          <span style={{ fontSize: 9, color: 'var(--tn-text-muted)', marginLeft: 6, fontFamily: 'inherit' }}>
            ({test.detail})
          </span>
        )}
      </span>
      {/* Not-run label for LLM tests */}
      {notRun && (
        <span style={{
          fontSize: 8, fontWeight: 700, padding: '1px 5px', borderRadius: 2,
          background: 'rgba(147,130,255,0.15)', color: 'rgb(167,150,255)',
          textTransform: 'uppercase', letterSpacing: 0.5, flexShrink: 0,
        }}>
          Not run
        </span>
      )}
      {/* Stale indicator */}
      {isStale && staleInfo && (
        <span
          title={staleInfo.reasons.join('\n')}
          style={{
            fontSize: 8, fontWeight: 700, padding: '1px 5px', borderRadius: 2,
            background: 'rgba(255, 170, 0, 0.2)', color: '#ffaa00',
            textTransform: 'uppercase', letterSpacing: 0.5, flexShrink: 0,
          }}
        >
          STALE
        </span>
      )}
      {/* Run button for PENDING tests */}
      {isPending && !isStale && (
        <button
          onClick={(e) => { e.stopPropagation(); onRetest(testId); }}
          disabled={isThisRetesting}
          title="Run this test"
          style={{
            background: 'rgba(99, 102, 241, 0.15)', border: '1px solid rgba(99, 102, 241, 0.3)',
            borderRadius: 3, padding: '1px 6px',
            fontSize: 8, fontWeight: 700, color: 'rgb(139, 142, 255)',
            cursor: isThisRetesting ? 'wait' : 'pointer',
            opacity: isThisRetesting ? 0.5 : 1, flexShrink: 0,
          }}
        >
          {isThisRetesting ? '...' : 'Run'}
        </button>
      )}
      {/* Re-test button for STALE tests */}
      {isStale && (
        <button
          onClick={(e) => { e.stopPropagation(); onRetest(testId); }}
          disabled={isThisRetesting}
          title="Re-run this test"
          style={{
            background: 'rgba(255, 170, 0, 0.15)', border: '1px solid rgba(255, 170, 0, 0.3)',
            borderRadius: 3, padding: '1px 6px',
            fontSize: 8, fontWeight: 700, color: '#ffaa00',
            cursor: isThisRetesting ? 'wait' : 'pointer',
            opacity: isThisRetesting ? 0.5 : 1, flexShrink: 0,
          }}
        >
          {isThisRetesting ? '...' : 'Re-Test'}
        </button>
      )}
      {/* Score */}
      {test.score != null && test.score > 0 && !notRun && (
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
      {/* Report link */}
      {test.reportPath && (
        <span style={{ fontSize: 10, color: 'var(--tn-blue)' }} title="Has report">
          doc
        </span>
      )}
    </div>
  );
}

export default function PyramidTab() {
  const [selectedApp, setSelectedApp] = useState(APP_IDS[0]);
  const [pyramid, setPyramid] = useState<PyramidData | null>(null);
  const [expandedLayer, setExpandedLayer] = useState<number | null>(null);
  const [reportContent, setReportContent] = useState<string | null>(null);
  const [reportTitle, setReportTitle] = useState('');
  const [loading, setLoading] = useState(true);
  const [coverageOverride, setCoverageOverride] = useState<CoverageSummary | null>(null);

  // Staleness state
  const [staleness, setStaleness] = useState<StalenessData | null>(null);
  const [retesting, setRetesting] = useState<string | null>(null); // scenario ID or "layer-N" being retested

  // Sidebar state for test detail (click to open)
  const [sidebarTest, setSidebarTest] = useState<PyramidTest | null>(null);

  // Build a Set of stale scenario IDs for quick lookup
  const staleIds = new Set<string>(staleness?.stale_scenarios?.map(s => s.scenario_id) ?? []);
  const staleMap = new Map<string, StaleScenario>();
  if (staleness?.stale_scenarios) {
    for (const s of staleness.stale_scenarios) {
      staleMap.set(s.scenario_id, s);
    }
  }

  useEffect(() => {
    setLoading(true);
    setExpandedLayer(null);
    setReportContent(null);
    setCoverageOverride(null);
    setStaleness(null);

    // Fetch pyramid data and staleness data in parallel
    const pyramidFetch = fetch(`/api/qa/pyramid/${selectedApp}`, { signal: AbortSignal.timeout(20000) })
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(raw => validateApiResponse<PyramidData>(raw, `/api/qa/pyramid/${selectedApp}`, {
        app: 'string',
        layers: 'array',
      }))
      .catch(() => null); // silent-ok: pyramid data fetch failure returns null; loading shows empty state

    const stalenessFetch = fetch(`/api/qa/staleness/${selectedApp}`, { signal: AbortSignal.timeout(20000) })
      .then(r => r.ok ? r.json() : null)
      .catch(() => null); // silent-ok: staleness data fetch failure returns null; staleness indicator hidden

    Promise.all([pyramidFetch, stalenessFetch]).then(([pyramidData, stalenessData]) => {
      setPyramid(pyramidData);
      setStaleness(stalenessData);
      setLoading(false);
    });
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

  const triggerRetest = async (scenarioId?: string, layer?: number) => {
    const key = scenarioId || `layer-${layer}`;
    setRetesting(key);
    try {
      const res = await fetch(`/api/qa/staleness/${selectedApp}/retest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(scenarioId ? { scenarioId } : { layer }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      console.log('[QA] Re-test triggered:', data);
    } catch (err) {
      console.error('Re-test trigger failed:', err);
    } finally {
      // Keep retesting indicator for a moment
      setTimeout(() => setRetesting(null), 2000);
    }
  };

  const statusColor = (status: string) => {
    switch (status) {
      case 'passed': case 'PASS': return 'var(--tn-green)';
      case 'partial': case 'PARTIAL': return 'var(--tn-orange)';
      case 'failed': case 'FAIL': return 'var(--tn-red)';
      case 'pending': case 'PENDING': return 'var(--tn-text-muted)';
      case 'not_run': case 'NOT_RUN': return 'rgba(147,130,255,0.5)';
      case 'SKIP': return 'rgba(255,255,255,0.2)';
      default: return 'var(--tn-text-muted)';
    }
  };



  if (loading) {
    return <div style={{ padding: 20, textAlign: 'center', color: 'var(--tn-text-muted)' }}>Loading...</div>;
  }

  // Sort layers: 4 on top (narrowest), 0 on bottom (widest) = true pyramid.
  // Layer 0 (Architecture) sources its counts from arch-test, not pyramid_status.py
  // — so totalTests can be 0 even with 70+ PASS tests. Derive counts from the
  // tests[] array as a fallback so the header counts match the bars.
  const sortedLayers = pyramid ? [...pyramid.layers].filter(l => l.id >= 0).sort((a, b) => b.id - a.id).map(l => {
    if (l.totalTests > 0 || !l.tests?.length) return l;
    const passed = l.tests.filter(t => t.status === 'PASS').length;
    const failed = l.tests.filter(t => t.status === 'FAIL').length;
    const pending = l.tests.filter(t => t.status === 'PENDING' || t.status === 'NOT_RUN' || t.status === 'BRIDGE_FAILURE').length;
    return { ...l, totalTests: l.tests.length, passed, failed, pending };
  }) : [];
  const ungrouped = pyramid?.layers.find(l => l.id === -1);
  const coverage = coverageOverride ?? pyramid?.coverage ?? null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', position: 'relative' }}>
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
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <h3 style={{ fontSize: 13, fontWeight: 700, color: 'var(--tn-text)', margin: 0 }}>
                  Testing Pyramid — {APP_NAMES[selectedApp] || selectedApp}
                </h3>
                {/* Compact legend */}
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 9, color: 'var(--tn-text-muted)' }}>
                  {[
                    { color: 'var(--tn-green)', label: 'PASS', desc: '≥8' },
                    { color: 'var(--tn-orange)', label: 'PARTIAL', desc: '5–7.9' },
                    { color: 'var(--tn-red)', label: 'FAIL', desc: '<5' },
                    { color: 'var(--tn-text-muted)', label: 'PENDING', desc: 'untested' },
                  ].map(item => (
                    <span key={item.label} style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: item.color, flexShrink: 0 }} />
                      <span style={{ fontWeight: 600 }}>{item.label}</span>
                      <span style={{ opacity: 0.6 }}>{item.desc}</span>
                    </span>
                  ))}
                  <span style={{ opacity: 0.4 }}>|</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#ffaa00', flexShrink: 0, animation: 'pulse-stale 2s ease-in-out infinite' }} />
                    <span style={{ fontWeight: 600, color: '#ffaa00' }}>STALE</span>
                    <span style={{ opacity: 0.6 }}>code changed</span>
                  </span>
                </div>
              </div>

              {/* Coverage KPI Header or Generate Button */}
              {coverage ? (
                <CoverageKPIHeader coverage={coverage} appId={selectedApp} onRefreshed={setCoverageOverride} />
              ) : (
                <GenerateCoverageButton appId={selectedApp} onGenerated={setCoverageOverride} />
              )}

              {/* Staleness KPI Header */}
              {staleness && (
                <StalenessKPIHeader
                  staleness={staleness}
                  appId={selectedApp}
                  onRefreshed={setStaleness}
                  onRetestLayer={(layer) => triggerRetest(undefined, layer)}
                />
              )}

              {/* Pyramid */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 700 }}>
                {sortedLayers.map((layer, i) => {
                  const isExpanded = expandedLayer === layer.id;
                  const widthPercent = 35 + (i * (65 / Math.max(sortedLayers.length - 1, 1)));
                  const isLlmLayer = layer.id === 0.5;
                  // Layer 0.5 always uses purple, others use status color
                  const color = isLlmLayer ? 'rgb(147,130,255)' : statusColor(layer.status);
                  // Coverage shown in KPI header only (app-wide metric)

                  // Staleness info for this layer
                  const layerStaleCount = staleness?.summary?.stale_by_layer?.[layer.id] ?? 0;
                  const isLayerRetesting = retesting === `layer-${layer.id}`;
                  const ageStats = layerAgeStats(layer.tests);

                  return (
                    <div key={layer.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                      <button
                        onClick={() => setExpandedLayer(isExpanded ? null : layer.id)}
                        title={isLlmLayer ? 'KI-gestützte Analysen via AI-Bridge — optional, blockieren die Pyramide nicht' : undefined}
                        style={{
                          width: `${widthPercent}%`, minWidth: 220,
                          background: isLlmLayer
                            ? `linear-gradient(135deg, rgba(147,130,255,0.12), rgba(147,130,255,0.05))`
                            : `linear-gradient(135deg, ${color}22, ${color}11)`,
                          border: `2px ${isLlmLayer ? 'dashed' : 'solid'} ${color}`, borderRadius: 6,
                          padding: '10px 16px', cursor: 'pointer', textAlign: 'left',
                          transition: 'all 0.15s',
                          outline: isExpanded ? `2px solid ${color}` : 'none', outlineOffset: 2,
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <div>
                            <div style={{
                              fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1,
                              color: isLlmLayer ? 'rgb(167,150,255)' : 'var(--tn-text-muted)',
                            }}>
                              {isLlmLayer ? 'Layer 0.5 — Optional' : `Layer ${layer.id}`}
                            </div>
                            <div style={{
                              fontSize: 13, fontWeight: 700, marginTop: 2,
                              color: isLlmLayer ? 'rgb(187,170,255)' : 'var(--tn-text)',
                            }}>
                              {layer.name}
                            </div>
                            <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginTop: 2 }}>
                              {layer.description}
                            </div>
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                            {/* Standard pass/fail/total counts for all layers */}
                            <div style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
                              {layer.id === 0.5 ? (
                                /* Layer 0.5 (LLM): special count display */
                                <>
                                  <span style={{ fontSize: 10, fontWeight: 700, color: 'rgb(167,150,255)' }}>
                                    {layer.passed}/{layer.totalTests}
                                  </span>
                                  <span style={{ fontSize: 8, color: 'rgb(167,150,255)', opacity: 0.7, fontWeight: 600 }}>run</span>
                                </>
                              ) : (
                                <>
                                  <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--tn-green)' }}>{layer.passed}</span>
                                  <span style={{ fontSize: 7, color: 'var(--tn-green)', opacity: 0.7, fontWeight: 600 }}>P</span>
                                  <span style={{ fontSize: 10, color: 'var(--tn-text-muted)', opacity: 0.4 }}>/</span>
                                  <span style={{ fontSize: 10, fontWeight: 700, color: layer.failed > 0 ? 'var(--tn-red)' : 'var(--tn-text-muted)' }}>{layer.failed}</span>
                                  <span style={{ fontSize: 7, color: layer.failed > 0 ? 'var(--tn-red)' : 'var(--tn-text-muted)', opacity: 0.7, fontWeight: 600 }}>F</span>
                                  {layer.pending > 0 && (<>
                                    <span style={{ fontSize: 10, color: 'var(--tn-text-muted)', opacity: 0.4 }}>/</span>
                                    <span style={{ fontSize: 10, color: 'var(--tn-text-muted)' }}>{layer.pending}</span>
                                    <span style={{ fontSize: 7, color: 'var(--tn-text-muted)', opacity: 0.7, fontWeight: 600 }}>U</span>
                                  </>)}
                                  <span style={{ fontSize: 8, color: 'var(--tn-text-muted)', opacity: 0.4, marginLeft: 2 }}>/ {layer.totalTests}</span>
                                </>
                              )}
                            </div>
                            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                              <span style={{
                                fontSize: 9, fontWeight: 700, padding: '2px 8px', borderRadius: 3,
                                background: `${color}33`, color, textTransform: 'uppercase',
                              }}>
                                {layer.status}
                              </span>
                              {/* STALE badge on layer */}
                              {layerStaleCount > 0 && (
                                <span
                                  title={`${layerStaleCount} test${layerStaleCount > 1 ? 's' : ''} need re-run (code changed)`}
                                  style={{
                                    fontSize: 9, fontWeight: 700, padding: '2px 8px', borderRadius: 3,
                                    background: 'rgba(255, 170, 0, 0.2)',
                                    color: '#ffaa00',
                                    textTransform: 'uppercase',
                                    animation: 'pulse-stale 2s ease-in-out infinite',
                                  }}
                                >
                                  {layerStaleCount} STALE
                                </span>
                              )}
                              {/* Age badge: oldest test age */}
                              {layer.tests.length > 0 && (
                                <span
                                  title={`Oldest: ${formatAge(ageStats.oldest)}${ageStats.newest != null && ageStats.newest !== ageStats.oldest ? ` · Newest: ${formatAge(ageStats.newest)}` : ''}${ageStats.neverRun > 0 ? ` · ${ageStats.neverRun} never run` : ''}`}
                                  style={{
                                    fontSize: 8, fontWeight: 600, padding: '2px 6px', borderRadius: 3,
                                    background: `${ageColorFromDays(ageStats.oldest)}18`,
                                    color: ageColorFromDays(ageStats.oldest),
                                  }}
                                >
                                  {ageStats.oldest != null ? `oldest: ${formatAge(ageStats.oldest)}` : `${ageStats.neverRun} untested`}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>

                        {/* Per-test mini score bars with reference lines */}
                        {layer.tests.length > 0 && (
                          <div style={{ marginTop: 8, position: 'relative', height: 32 }}>
                            {/* Reference lines at score 5 (PASS threshold) and 8 (good) */}
                            <div style={{ position: 'absolute', bottom: '50%', left: 0, right: 40, height: 1, background: 'rgba(255,170,0,0.25)', zIndex: 1 }} title="Score 5 — PARTIAL threshold" />
                            <div style={{ position: 'absolute', bottom: '80%', left: 0, right: 40, height: 1, background: 'rgba(100,255,100,0.2)', zIndex: 1 }} title="Score 8 — PASS threshold" />
                            {/* Scale labels */}
                            <span style={{ position: 'absolute', right: 42, bottom: '50%', transform: 'translateY(50%)', fontSize: 7, color: 'rgba(255,170,0,0.5)', fontWeight: 600 }}>5</span>
                            <span style={{ position: 'absolute', right: 42, bottom: '80%', transform: 'translateY(50%)', fontSize: 7, color: 'rgba(100,255,100,0.4)', fontWeight: 600 }}>8</span>
                            {/* Bars */}
                            <div style={{ display: 'flex', gap: 2, alignItems: 'flex-end', height: '100%', paddingRight: 40 }}>
                              {layer.tests.map(t => {
                                const s = t.score ?? 0;
                                const h = s > 0 ? Math.max((s / 10) * 100, 10) : 5;
                                const bg = s > 0 ? scoreColor(s) : 'rgba(255,255,255,0.08)';
                                const isSelected = sidebarTest?.id === t.id;
                                const barAge = ageOpacity(t.lastRun);
                                const ageDays = daysAgo(t.lastRun);
                                return (
                                  <div
                                    key={t.id}
                                    title={`${t.id}${s > 0 ? ': ' + s.toFixed(1) : ''} · ${formatAge(ageDays)} — click for details`}
                                    onClick={(e) => { e.stopPropagation(); setSidebarTest(prev => prev?.id === t.id ? null : t); }}
                                    style={{
                                      flex: 1, maxWidth: 24, minWidth: 3,
                                      height: `${h}%`, background: bg, borderRadius: 2,
                                      transition: 'height 0.3s, opacity 0.15s',
                                      cursor: 'pointer',
                                      opacity: isSelected ? 1 : barAge,
                                      outline: isSelected ? `2px solid ${bg}` : 'none',
                                      outlineOffset: 1,
                                    }}
                                  />
                                );
                              })}
                            </div>
                            {/* Avg score */}
                            <span style={{ position: 'absolute', right: 0, bottom: 0, fontSize: 11, fontWeight: 700, color: scoreColor(layer.avgScore), whiteSpace: 'nowrap' }}>
                              {layer.avgScore.toFixed(1)}
                            </span>
                          </div>
                        )}

                        {/* Coverage shown in KPI header (app-wide) */}
                      </button>

                      {/* Expanded: Test List */}
                      {isExpanded && (
                        <div style={{
                          width: `${widthPercent}%`, minWidth: 220, padding: 0,
                          background: 'var(--tn-bg-dark)', border: `1px solid ${color}44`,
                          borderRadius: '0 0 6px 6px', borderTop: 'none', marginTop: -2,
                          overflow: 'hidden',
                        }}>
                          {/* Re-Test Layer button if stale scenarios exist */}
                          {layerStaleCount > 0 && (
                            <div style={{
                              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                              padding: '6px 12px', borderBottom: '1px solid var(--tn-border)',
                              background: 'rgba(255, 170, 0, 0.05)',
                            }}>
                              <span style={{ fontSize: 10, color: '#ffaa00', fontWeight: 600 }}>
                                {layerStaleCount} stale — code changed since last test
                              </span>
                              <button
                                onClick={(e) => { e.stopPropagation(); triggerRetest(undefined, layer.id); }}
                                disabled={isLayerRetesting}
                                style={{
                                  background: '#ffaa00', border: 'none', borderRadius: 3, padding: '3px 10px',
                                  fontSize: 9, fontWeight: 700, color: '#000', cursor: isLayerRetesting ? 'wait' : 'pointer',
                                  opacity: isLayerRetesting ? 0.5 : 1,
                                }}
                              >
                                {isLayerRetesting ? 'Starting...' : 'Re-Test Stale'}
                              </button>
                            </div>
                          )}

                          {/* Layer 0.5 (LLM): Render with tooltip cards showing what each test does */}
                          {isLlmLayer ? layer.tests.map(test => {
                            const tId = test.id;
                            const tStatus = test.status;
                            const notRun = tStatus === 'PENDING' || tStatus === 'NOT_RUN';
                            const isSkipped = tStatus === 'SKIP';
                            const isInactive = notRun || isSkipped;
                            return (
                              <div
                                key={tId}
                                style={{
                                  padding: '8px 12px',
                                  borderBottom: '1px solid var(--tn-border)',
                                  background: isSkipped ? 'rgba(255,255,255,0.01)' : 'rgba(147,130,255,0.03)',
                                  cursor: test.reportPath ? 'pointer' : 'default',
                                  opacity: isSkipped ? 0.5 : 1,
                                }}
                                onClick={() => test.reportPath && loadReport(test.reportPath, tId)}
                                onMouseEnter={(e) => { e.currentTarget.style.background = isSkipped ? 'rgba(255,255,255,0.04)' : 'rgba(147,130,255,0.08)'; }}
                                onMouseLeave={(e) => { e.currentTarget.style.background = isSkipped ? 'rgba(255,255,255,0.01)' : 'rgba(147,130,255,0.03)'; }}
                              >
                                {/* Header row: status dot + name + score */}
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                                  <span style={{
                                    width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                                    background: isSkipped ? 'rgba(255,255,255,0.15)' : notRun ? 'rgba(147,130,255,0.3)' : statusColor(tStatus),
                                  }} />
                                  <span style={{
                                    flex: 1, fontFamily: 'monospace', fontSize: 11,
                                    color: isInactive ? 'var(--tn-text-muted)' : 'var(--tn-text)',
                                    fontWeight: 600,
                                    textDecoration: isSkipped ? 'line-through' : 'none',
                                  }}>
                                    {tId.split('.').pop()?.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) || tId}
                                  </span>
                                  {isSkipped && (
                                    <span style={{
                                      fontSize: 8, fontWeight: 700, padding: '1px 5px', borderRadius: 2,
                                      background: 'rgba(255,255,255,0.08)', color: 'var(--tn-text-muted)',
                                      textTransform: 'uppercase', letterSpacing: 0.5,
                                    }}>N/A</span>
                                  )}
                                  {notRun && !isSkipped && (
                                    <span style={{
                                      fontSize: 8, fontWeight: 700, padding: '1px 5px', borderRadius: 2,
                                      background: 'rgba(147,130,255,0.15)', color: 'rgb(167,150,255)',
                                      textTransform: 'uppercase', letterSpacing: 0.5,
                                    }}>Not run</span>
                                  )}
                                  {!isInactive && test.score != null && test.score > 0 && (
                                    <span style={{ fontWeight: 700, color: scoreColor(test.score), fontSize: 12 }}>
                                      {test.score.toFixed(1)}
                                    </span>
                                  )}
                                  {/* Show WARN metric as badge for completed LLM tests */}
                                  {!isInactive && test.detail && (
                                    <span style={{
                                      fontSize: 8, fontWeight: 600, padding: '1px 5px', borderRadius: 2,
                                      background: 'rgba(255,170,0,0.15)', color: '#ffaa00',
                                    }}>
                                      {test.detail.split(':').pop()?.trim() || test.detail}
                                    </span>
                                  )}
                                  {test.lastRun && (
                                    <span style={{ fontSize: 9, color: 'var(--tn-text-muted)' }}>{test.lastRun}</span>
                                  )}
                                </div>
                                {/* Description: what the test does */}
                                {test.tooltip && (
                                  <div style={{
                                    fontSize: 10, color: 'var(--tn-text-muted)', lineHeight: 1.4,
                                    paddingLeft: 16, marginBottom: 3,
                                  }}>
                                    {test.tooltip}
                                  </div>
                                )}
                                {/* Outputs: what it produces */}
                                {test.outputs && (
                                  <div style={{
                                    fontSize: 9, color: 'rgb(147,130,255)', lineHeight: 1.4,
                                    paddingLeft: 16, opacity: 0.8,
                                  }}>
                                    Output: {test.outputs}
                                  </div>
                                )}
                              </div>
                            );
                          }) : (
                            /* Standard test rendering for Layer 0-4 */
                            layer.tests.map(test => (
                              <TestRow key={test.id} test={test} staleIds={staleIds} staleMap={staleMap}
                                retesting={retesting} onLoadReport={loadReport} onRetest={triggerRetest}
                                statusColor={statusColor} scoreColor={scoreColor} onSelectTest={setSidebarTest}
                                sidebarTestId={sidebarTest?.id ?? null} />
                            ))
                          )}
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
                    onClick={() => {
                      if (test.reportPath) loadReport(test.reportPath, test.id);
                      setSidebarTest(prev => prev?.id === test.id ? null : test);
                    }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '6px 12px', fontSize: 11,
                      borderBottom: '1px solid var(--tn-border)',
                      cursor: 'pointer',
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(30,45,74,0.3)'; }}
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

      {/* Test Detail Sidebar (absolute right overlay, click to open) */}
      {sidebarTest && (
        <div style={{
          position: 'absolute', top: 0, right: 0, bottom: 0, width: 500,
          zIndex: 100, display: 'flex',
        }}>
          <TestDetailSidebar test={sidebarTest} onClose={() => setSidebarTest(null)} />
        </div>
      )}

      {/* CSS for animations */}
      <style>{`
        @keyframes pulse-stale {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.6; }
        }
        @keyframes slideInRight {
          from { transform: translateX(20px); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
        }
      `}</style>
    </div>
  );
}
