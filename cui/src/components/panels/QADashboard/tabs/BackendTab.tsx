import React, { useEffect, useState, useCallback } from 'react';
import { resilientFetch } from '../../../../utils/resilientFetch';

interface BackendTest {
  id: string;
  label: string;
  status: string; // PASS, FAIL, WARN, DISCOVERED, NOT_RUN
  detail?: string;
}

interface BackendLayer {
  id: number;
  name: string;
  description: string;
  totalTests: number;
  passed: number;
  failed: number;
  pending: number;
  avgScore: number;
  status: 'passed' | 'failed' | 'partial' | 'pending' | 'not_run' | 'empty';
  tests: BackendTest[];
}

type Category = 'platform' | 'standalone' | 'external';

interface WorkflowEntry {
  id: string;
  workflowId: string;
  name: string;
  appId: string;
  category: Category;
  manifestPath: string | null;
  pipelineBasePath: string;
  engine: string | null;
  phaseCount: number;
  validationIssues: number;
  layers: BackendLayer[];
}

interface AppEntry {
  appId: string;
  displayName: string;
  category: Category;
  workflows: WorkflowEntry[];
  summary: { totalWorkflows: number; l0Passed: number; l0Partial: number; l0Failed: number };
}

const CATEGORY_META: Record<Category, { label: string; color: string; bg: string }> = {
  platform: { label: 'Workflow-Plattform', color: 'var(--tn-blue)', bg: 'rgba(122,162,247,0.15)' },
  standalone: { label: 'Single-Workflow App', color: 'var(--tn-green)', bg: 'rgba(158,206,106,0.15)' },
  external: { label: 'External Pipeline', color: 'var(--tn-orange)', bg: 'rgba(224,175,104,0.15)' },
};

interface BackendPyramidData {
  apps: AppEntry[];
  timestamp: string;
}

const statusColor = (s: string): string => {
  switch (s) {
    case 'passed':
    case 'PASS':
      return 'var(--tn-green)';
    case 'failed':
    case 'FAIL':
      return 'var(--tn-red)';
    case 'partial':
    case 'WARN':
      return 'var(--tn-orange)';
    case 'not_run':
    case 'NOT_RUN':
    case 'DISCOVERED':
    case 'pending':
      return 'var(--tn-text-muted)';
    case 'empty':
      return 'var(--tn-border)';
    default:
      return 'var(--tn-text-muted)';
  }
};

const statusBg = (s: string): string => {
  switch (s) {
    case 'passed':
      return 'rgba(158,206,106,0.15)';
    case 'failed':
      return 'rgba(247,118,142,0.15)';
    case 'partial':
      return 'rgba(224,175,104,0.15)';
    case 'not_run':
    case 'pending':
      return 'rgba(128,128,128,0.08)';
    case 'empty':
      return 'transparent';
    default:
      return 'transparent';
  }
};

function LayerBar({ layer, expanded, onToggle }: { layer: BackendLayer; expanded: boolean; onToggle: () => void }) {
  const pct = layer.totalTests > 0 ? (layer.passed / layer.totalTests) * 100 : 0;
  return (
    <div
      data-ai-id={`backend-layer-${layer.id}`}
      style={{
        marginBottom: 6,
        border: '1px solid var(--tn-border)',
        borderRadius: 4,
        background: statusBg(layer.status),
      }}
    >
      <button
        onClick={onToggle}
        data-ai-id={`backend-layer-${layer.id}-toggle`}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 10px',
          background: 'transparent',
          border: 'none',
          color: 'var(--tn-text)',
          cursor: 'pointer',
          textAlign: 'left',
          fontSize: 11,
        }}
      >
        <span style={{ width: 22, fontWeight: 700, color: statusColor(layer.status), fontFamily: 'monospace' }}>
          L{layer.id}
        </span>
        <span style={{ flex: 1, fontWeight: 600 }}>{layer.name}</span>
        <span style={{ fontSize: 10, color: 'var(--tn-text-muted)', fontFamily: 'monospace' }}>
          {layer.passed}/{layer.totalTests}
        </span>
        <span
          style={{
            minWidth: 60,
            height: 6,
            background: 'var(--tn-border)',
            borderRadius: 3,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${pct}%`,
              height: '100%',
              background: statusColor(layer.status),
              transition: 'width 0.2s',
            }}
          />
        </span>
        <span
          style={{
            fontSize: 9,
            padding: '1px 6px',
            borderRadius: 3,
            background: statusColor(layer.status),
            color: '#000',
            fontWeight: 700,
            letterSpacing: '0.03em',
            minWidth: 52,
            textAlign: 'center',
          }}
        >
          {layer.status.toUpperCase()}
        </span>
        <span style={{ color: 'var(--tn-text-muted)', fontSize: 10 }}>{expanded ? '▾' : '▸'}</span>
      </button>

      {expanded && (
        <div style={{ padding: '4px 10px 10px 40px', fontSize: 10 }}>
          <div style={{ color: 'var(--tn-text-muted)', marginBottom: 6, fontSize: 10 }}>
            {layer.description}
          </div>
          {layer.tests.length === 0 ? (
            <div style={{ color: 'var(--tn-text-muted)', fontStyle: 'italic' }}>
              Keine Tests.
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10 }}>
              <tbody>
                {layer.tests.map(t => (
                  <tr key={t.id} style={{ borderBottom: '1px solid var(--tn-border)' }}>
                    <td style={{ padding: '3px 4px', color: 'var(--tn-text)' }}>{t.label}</td>
                    <td style={{ padding: '3px 4px', width: 70 }}>
                      <span
                        style={{
                          fontSize: 9,
                          padding: '1px 5px',
                          borderRadius: 3,
                          background: statusColor(t.status),
                          color: '#000',
                          fontWeight: 700,
                        }}
                      >
                        {t.status}
                      </span>
                    </td>
                    <td style={{ padding: '3px 4px', color: 'var(--tn-text-muted)', fontFamily: 'monospace', fontSize: 9 }}>
                      {t.detail ?? ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

function WorkflowCard({ workflow }: { workflow: WorkflowEntry }) {
  const [expandedLayers, setExpandedLayers] = useState<Set<number>>(new Set());
  const toggle = (id: number) => {
    setExpandedLayers(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  return (
    <div
      data-ai-id={`backend-workflow-${workflow.id}`}
      style={{
        marginBottom: 14,
        padding: 10,
        border: '1px solid var(--tn-border)',
        borderRadius: 6,
        background: 'var(--tn-bg-dark)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--tn-text)', flex: 1 }}>
          {workflow.name}
        </span>
        {workflow.engine && (
          <span style={{
            fontSize: 9,
            padding: '2px 6px',
            borderRadius: 3,
            background: 'rgba(122,162,247,0.15)',
            color: 'var(--tn-blue)',
            border: '1px solid rgba(122,162,247,0.3)',
            fontFamily: 'monospace',
            fontWeight: 700,
          }}>
            {workflow.engine}
          </span>
        )}
        {workflow.phaseCount > 0 && (
          <span style={{ fontSize: 9, color: 'var(--tn-text-muted)', fontFamily: 'monospace' }}>
            {workflow.phaseCount} phases
          </span>
        )}
        {workflow.manifestPath && (
          <span style={{ fontSize: 9, color: 'var(--tn-green)', fontFamily: 'monospace' }}
                title={workflow.manifestPath}>
            manifest ✓
          </span>
        )}
        {workflow.validationIssues > 0 && (
          <span style={{ fontSize: 9, color: 'var(--tn-orange)', fontFamily: 'monospace' }}
                title="pipeline-scanner validation issues">
            {workflow.validationIssues} issues
          </span>
        )}
        <span style={{ fontSize: 9, color: 'var(--tn-text-muted)', fontFamily: 'monospace' }}>
          {workflow.id}
        </span>
      </div>

      {workflow.layers.map(layer => (
        <LayerBar
          key={layer.id}
          layer={layer}
          expanded={expandedLayers.has(layer.id)}
          onToggle={() => toggle(layer.id)}
        />
      ))}
    </div>
  );
}

export default function BackendTab() {
  const [data, setData] = useState<BackendPyramidData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedApp, setSelectedApp] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await resilientFetch('/api/qa/backend-pyramid');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
      if (!selectedApp && json.apps?.length > 0) {
        const firstWithWorkflows = json.apps.find((a: AppEntry) => a.workflows.length > 0);
        setSelectedApp(firstWithWorkflows?.appId ?? json.apps[0].appId);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [selectedApp]);

  useEffect(() => {
    fetchData();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading && !data) {
    return (
      <div style={{ padding: 20, color: 'var(--tn-text-muted)', fontSize: 11 }}>
        Lade Backend-Pyramide…
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: 20, color: 'var(--tn-red)', fontSize: 11 }}>
        Fehler: {error}
        <button onClick={fetchData} style={{ marginLeft: 10, padding: '2px 8px', fontSize: 10 }}>
          Retry
        </button>
      </div>
    );
  }

  if (!data || data.apps.length === 0) {
    return (
      <div style={{ padding: 20, color: 'var(--tn-text-muted)', fontSize: 11 }}>
        Keine Backend-Workflows gefunden.
      </div>
    );
  }

  const activeApp = data.apps.find(a => a.appId === selectedApp) ?? data.apps[0];

  return (
    <div data-ai-id="qa-backend-tab" style={{ padding: 12, color: 'var(--tn-text)' }}>
      {/* App selector */}
      <div
        data-ai-id="backend-app-selector"
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 6,
          marginBottom: 14,
          paddingBottom: 10,
          borderBottom: '1px solid var(--tn-border)',
        }}
      >
        {data.apps.map(app => {
          const active = app.appId === activeApp.appId;
          const bad = app.summary.l0Failed > 0;
          const warn = !bad && app.summary.l0Partial > 0;
          const catMeta = CATEGORY_META[app.category];
          return (
            <button
              key={app.appId}
              data-ai-id={`backend-app-tab-${app.appId}`}
              onClick={() => setSelectedApp(app.appId)}
              style={{
                background: active ? 'var(--tn-blue)' : 'transparent',
                border: `1px solid ${active ? 'var(--tn-blue)' : 'var(--tn-border)'}`,
                color: active ? '#fff' : 'var(--tn-text)',
                padding: '4px 10px',
                borderRadius: 4,
                fontSize: 11,
                fontWeight: 600,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
              title={catMeta.label}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: catMeta.color,
                  flexShrink: 0,
                }}
              />
              <span>{app.displayName}</span>
              <span
                style={{
                  fontSize: 9,
                  padding: '1px 5px',
                  borderRadius: 3,
                  background: bad ? 'var(--tn-red)' : warn ? 'var(--tn-orange)' : 'rgba(0,0,0,0.25)',
                  color: bad || warn ? '#000' : '#fff',
                  fontFamily: 'monospace',
                  fontWeight: 700,
                }}
              >
                {app.summary.totalWorkflows}
              </span>
            </button>
          );
        })}
        <div style={{ flex: 1 }} />
        <button
          onClick={fetchData}
          data-ai-id="backend-refresh"
          style={{
            background: 'transparent',
            border: '1px solid var(--tn-border)',
            color: 'var(--tn-text-muted)',
            padding: '4px 10px',
            borderRadius: 4,
            fontSize: 10,
            cursor: 'pointer',
          }}
        >
          ↻ Refresh
        </button>
      </div>

      {/* Active App Header */}
      <div
        style={{
          fontSize: 11,
          color: 'var(--tn-text)',
          marginBottom: 10,
          padding: '8px 10px',
          background: CATEGORY_META[activeApp.category].bg,
          border: `1px solid ${CATEGORY_META[activeApp.category].color}`,
          borderRadius: 4,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          lineHeight: 1.5,
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 700 }}>{activeApp.displayName}</span>
        <span style={{
          fontSize: 9,
          padding: '2px 7px',
          borderRadius: 3,
          background: CATEGORY_META[activeApp.category].color,
          color: '#000',
          fontWeight: 700,
          letterSpacing: '0.03em',
        }}>
          {CATEGORY_META[activeApp.category].label.toUpperCase()}
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 10, color: 'var(--tn-text-muted)', fontFamily: 'monospace' }}>
          {activeApp.summary.totalWorkflows} workflow{activeApp.summary.totalWorkflows !== 1 ? 's' : ''}
          {' · '}L0: {activeApp.summary.l0Passed} passed
          {activeApp.summary.l0Partial > 0 ? `, ${activeApp.summary.l0Partial} partial` : ''}
          {activeApp.summary.l0Failed > 0 ? `, ${activeApp.summary.l0Failed} failed` : ''}
        </span>
      </div>

      {/* Legend */}
      <div
        style={{
          fontSize: 10,
          color: 'var(--tn-text-muted)',
          marginBottom: 12,
          padding: '6px 10px',
          background: 'var(--tn-bg-dark)',
          border: '1px solid var(--tn-border)',
          borderRadius: 4,
          fontFamily: 'monospace',
          lineHeight: 1.6,
        }}
      >
        <strong style={{ color: 'var(--tn-text)' }}>Backend-Pyramide:</strong>{' '}
        L0 Contracts (category-adaptive, live) · L1 pytest (discovered) · L2-L4 10-Stars (strukturell, not_run)
      </div>

      {/* Workflows */}
      {activeApp.workflows.length === 0 ? (
        <div style={{ padding: 20, color: 'var(--tn-text-muted)', fontSize: 11, fontStyle: 'italic' }}>
          Keine Workflows fuer {activeApp.displayName}.
        </div>
      ) : (
        activeApp.workflows.map(wf => <WorkflowCard key={wf.id} workflow={wf} />)
      )}
    </div>
  );
}
