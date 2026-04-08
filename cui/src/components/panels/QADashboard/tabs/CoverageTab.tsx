import React, { useState, useEffect } from 'react';

const APP_IDS = ['werking-report', 'engelmann', 'werking-energy', 'werking-safety', 'werking-noise', 'platform'];
const APP_NAMES: Record<string, string> = {
  'werking-report': 'WerkING Report',
  'engelmann': 'Engelmann AI Hub',
  'platform': 'Platform',
  'werking-energy': 'WerkING Energy',
  'werking-safety': 'WerkING Safety',
  'werking-noise': 'WerkING Noise',
};

interface GapDetail {
  endpoint?: string;
  id?: string;
  methods?: string[];
  file?: string;
  route?: string;
  element_type?: string;
  type: string; // 'untested' | 'partial' | 'skipped'
  priority?: string;
  notes?: string;
}

interface MethodGap {
  endpoint: string;
  missing_methods: string[];
  tested_methods: string[];
}

interface DimensionData {
  status: string;
  total: number;
  covered: number;
  gaps: number;
  pct: number;
  gap_details?: GapDetail[];
  method_gaps?: MethodGap[];
  gaps_by_route?: Record<string, string[]>;
  failed_elements?: Array<{ id: string; route: string; error: string }>;
}

interface CoverageData {
  app: string;
  api: DimensionData;
  ui: DimensionData;
  timestamp: string;
}

function CoverageBar({ pct, width = 120 }: { pct: number; width?: number }) {
  const color = pct >= 70 ? 'var(--tn-green)' : pct >= 40 ? 'var(--tn-orange)' : 'var(--tn-red)';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ width, height: 8, background: 'rgba(255,255,255,0.08)', borderRadius: 4, overflow: 'hidden', flexShrink: 0 }}>
        <div style={{ width: `${Math.min(pct, 100)}%`, height: '100%', background: color, borderRadius: 4, transition: 'width 0.3s' }} />
      </div>
      <span style={{ fontSize: 12, fontWeight: 700, color, minWidth: 42, textAlign: 'right' }}>
        {pct.toFixed(1)}%
      </span>
    </div>
  );
}

function PriorityBadge({ priority }: { priority: string }) {
  const colors: Record<string, { bg: string; fg: string }> = {
    critical: { bg: 'rgba(247,118,142,0.2)', fg: 'var(--tn-red)' },
    high: { bg: 'rgba(224,175,104,0.2)', fg: 'var(--tn-orange)' },
    low: { bg: 'rgba(255,255,255,0.06)', fg: 'var(--tn-text-muted)' },
  };
  const c = colors[priority] ?? colors.low;
  return (
    <span style={{ fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 3, background: c.bg, color: c.fg, textTransform: 'uppercase' }}>
      {priority}
    </span>
  );
}

export default function CoverageTab() {
  const [selectedApp, setSelectedApp] = useState(APP_IDS[0]);
  const [data, setData] = useState<CoverageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedSection, setExpandedSection] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    setExpandedSection(null);

    fetch(`/api/qa/coverage-gaps/${selectedApp}`, { signal: AbortSignal.timeout(15000) })
      .then(r => {
        if (r.status === 404) throw new Error('no_data');
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(d => { setData(d); setLoading(false); })
      .catch(err => {
        setData(null);
        setError(err.message === 'no_data' ? null : err.message);
        setLoading(false);
      });
  }, [selectedApp]);

  const relativeTime = (iso: string) => {
    try {
      const ms = Date.now() - new Date(iso).getTime();
      const hours = ms / 3600000;
      if (hours < 1) return '<1h ago';
      if (hours < 24) return `${Math.floor(hours)}h ago`;
      return `${Math.floor(hours / 24)}d ago`;
    } catch { return iso; }
  };

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
              cursor: 'pointer', fontWeight: 600,
            }}>
            {APP_NAMES[appId] ?? appId}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
        {loading ? (
          <div style={{ textAlign: 'center', color: 'var(--tn-text-muted)', padding: 40 }}>Loading...</div>
        ) : error ? (
          <div style={{ textAlign: 'center', color: 'var(--tn-red)', padding: 40 }}>Error: {error}</div>
        ) : !data ? (
          <div style={{ textAlign: 'center', color: 'var(--tn-text-muted)', padding: 40 }}>
            <div style={{ fontSize: 13, marginBottom: 8 }}>No coverage gap data for {APP_NAMES[selectedApp] ?? selectedApp}</div>
            <div style={{ fontSize: 11 }}>Run tests to generate: <code style={{ background: 'rgba(30,45,74,0.5)', padding: '2px 6px', borderRadius: 3, fontSize: 10 }}>python3 run_autonomous.py --app {selectedApp}</code></div>
          </div>
        ) : (
          <>
            {/* Summary Cards */}
            <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
              <SummaryCard title="API Endpoints" dim={data.api} />
              <SummaryCard title="UI Elements" dim={data.ui} />
              <div style={{
                flex: 1, background: 'var(--tn-bg-dark)', borderRadius: 8, padding: 14,
                border: '1px solid var(--tn-border)',
              }}>
                <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', textTransform: 'uppercase', fontWeight: 700, letterSpacing: 1 }}>Last Analysis</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--tn-text)', marginTop: 4 }}>{relativeTime(data.timestamp)}</div>
                <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginTop: 4, fontFamily: 'monospace' }}>{data.timestamp.split('T')[0]}</div>
              </div>
            </div>

            {/* API Gaps Section */}
            {data.api.status === 'ok' && (
              <GapSection
                title="API Endpoint Gaps"
                dimension={data.api}
                isExpanded={expandedSection === 'api'}
                onToggle={() => setExpandedSection(expandedSection === 'api' ? null : 'api')}
                renderGaps={() => <ApiGapDetails api={data.api} />}
              />
            )}

            {/* UI Gaps Section */}
            {data.ui.status === 'ok' && (
              <GapSection
                title="UI Element Gaps"
                dimension={data.ui}
                isExpanded={expandedSection === 'ui'}
                onToggle={() => setExpandedSection(expandedSection === 'ui' ? null : 'ui')}
                renderGaps={() => <UiGapDetails ui={data.ui} />}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function SummaryCard({ title, dim }: { title: string; dim: DimensionData }) {
  if (dim.status !== 'ok') {
    return (
      <div style={{ flex: 1, background: 'var(--tn-bg-dark)', borderRadius: 8, padding: 14, border: '1px solid var(--tn-border)', opacity: 0.5 }}>
        <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', textTransform: 'uppercase', fontWeight: 700, letterSpacing: 1 }}>{title}</div>
        <div style={{ fontSize: 12, color: 'var(--tn-text-muted)', marginTop: 8 }}>No data</div>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, background: 'var(--tn-bg-dark)', borderRadius: 8, padding: 14, border: '1px solid var(--tn-border)' }}>
      <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', textTransform: 'uppercase', fontWeight: 700, letterSpacing: 1 }}>{title}</div>
      <div style={{ marginTop: 8 }}>
        <CoverageBar pct={dim.pct} />
      </div>
      <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
        <span style={{ fontSize: 10, color: 'var(--tn-text-muted)' }}>{dim.covered}/{dim.total} covered</span>
        <span style={{ fontSize: 10, color: dim.gaps > 0 ? 'var(--tn-orange)' : 'var(--tn-green)' }}>{dim.gaps} gaps</span>
      </div>
    </div>
  );
}

function GapSection({ title, dimension, isExpanded, onToggle, renderGaps }: {
  title: string; dimension: DimensionData; isExpanded: boolean;
  onToggle: () => void; renderGaps: () => React.ReactElement;
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <button onClick={onToggle} style={{
        width: '100%', textAlign: 'left', background: 'var(--tn-bg-dark)', border: '1px solid var(--tn-border)',
        borderRadius: isExpanded ? '8px 8px 0 0' : 8, padding: '10px 14px', cursor: 'pointer',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--tn-text)' }}>{title}</span>
          <span style={{ fontSize: 10, color: dimension.gaps > 0 ? 'var(--tn-orange)' : 'var(--tn-green)' }}>
            {dimension.gaps} untested
          </span>
        </div>
        <span style={{ fontSize: 11, color: 'var(--tn-text-muted)', transform: isExpanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>
          ▶
        </span>
      </button>
      {isExpanded && (
        <div style={{
          background: 'var(--tn-bg-dark)', border: '1px solid var(--tn-border)', borderTop: 'none',
          borderRadius: '0 0 8px 8px', padding: 14, maxHeight: 400, overflow: 'auto',
        }}>
          {renderGaps()}
        </div>
      )}
    </div>
  );
}

function ApiGapDetails({ api }: { api: DimensionData }) {
  const details = api.gap_details ?? [];
  const methodGaps = api.method_gaps ?? [];

  if (details.length === 0 && methodGaps.length === 0) {
    return <div style={{ color: 'var(--tn-green)', fontSize: 12 }}>All API endpoints covered.</div>;
  }

  const byPriority: Record<string, GapDetail[]> = {};
  for (const g of details) {
    const p = g.priority ?? 'high';
    (byPriority[p] ??= []).push(g);
  }

  return (
    <>
      {['critical', 'high', 'low'].map(priority => {
        const gaps = byPriority[priority];
        if (!gaps?.length) return null;
        return (
          <div key={priority} style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
              <PriorityBadge priority={priority} />
              <span style={{ fontSize: 10, color: 'var(--tn-text-muted)' }}>{gaps.length} endpoints</span>
            </div>
            {gaps.slice(0, 20).map((g, i) => (
              <div key={i} style={{ fontSize: 11, padding: '3px 0', fontFamily: 'monospace', color: 'var(--tn-text)', display: 'flex', gap: 8 }}>
                <span style={{ color: 'var(--tn-text-muted)', minWidth: 70, fontSize: 10 }}>{g.methods?.join(', ')}</span>
                <span>{g.endpoint}</span>
              </div>
            ))}
            {gaps.length > 20 && <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginTop: 4 }}>... and {gaps.length - 20} more</div>}
          </div>
        );
      })}

      {methodGaps.length > 0 && (
        <div style={{ marginTop: 12, borderTop: '1px solid var(--tn-border)', paddingTop: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--tn-orange)', marginBottom: 6 }}>
            Partially Tested ({methodGaps.length})
          </div>
          {methodGaps.slice(0, 10).map((g, i) => (
            <div key={i} style={{ fontSize: 11, padding: '3px 0', fontFamily: 'monospace', color: 'var(--tn-text)' }}>
              <span>{g.endpoint}</span>
              <span style={{ color: 'var(--tn-green)', fontSize: 10, marginLeft: 8 }}>tested: {g.tested_methods.join(', ')}</span>
              <span style={{ color: 'var(--tn-red)', fontSize: 10, marginLeft: 8 }}>missing: {g.missing_methods.join(', ')}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function UiGapDetails({ ui }: { ui: DimensionData }) {
  const byRoute = ui.gaps_by_route ?? {};
  const routes = Object.entries(byRoute).sort((a, b) => b[1].length - a[1].length);
  const failedElements = ui.failed_elements ?? [];

  if (routes.length === 0 && failedElements.length === 0) {
    return <div style={{ color: 'var(--tn-green)', fontSize: 12 }}>All UI elements covered.</div>;
  }

  return (
    <>
      {routes.slice(0, 15).map(([route, ids]) => (
        <div key={route} style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--tn-blue)', marginBottom: 3 }}>
            {route} <span style={{ color: 'var(--tn-text-muted)', fontWeight: 400 }}>({ids.length} untested)</span>
          </div>
          <div style={{ paddingLeft: 12 }}>
            {ids.slice(0, 8).map(id => (
              <div key={id} style={{ fontSize: 10, fontFamily: 'monospace', color: 'var(--tn-text-muted)', padding: '1px 0' }}>{id}</div>
            ))}
            {ids.length > 8 && <div style={{ fontSize: 10, color: 'var(--tn-text-muted)' }}>... +{ids.length - 8} more</div>}
          </div>
        </div>
      ))}
      {routes.length > 15 && <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginTop: 4 }}>... and {routes.length - 15} more routes</div>}

      {failedElements.length > 0 && (
        <div style={{ marginTop: 12, borderTop: '1px solid var(--tn-border)', paddingTop: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--tn-red)', marginBottom: 6 }}>
            Failed Elements ({failedElements.length})
          </div>
          {failedElements.slice(0, 10).map((e, i) => (
            <div key={i} style={{ fontSize: 10, fontFamily: 'monospace', padding: '2px 0', color: 'var(--tn-text)' }}>
              <span style={{ color: 'var(--tn-red)' }}>{e.id}</span>
              <span style={{ color: 'var(--tn-text-muted)', marginLeft: 8 }}>{e.route}</span>
              <span style={{ color: 'var(--tn-text-muted)', marginLeft: 8, fontSize: 9 }}>{e.error?.slice(0, 50)}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
