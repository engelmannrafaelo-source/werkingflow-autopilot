import React, { useState, useEffect } from 'react';

interface PipelineStatus {
  status: string;
  branch?: string;
  unpushed?: number;
  uncommitted?: number;
  main_behind?: number;
  hook?: boolean;
  issues?: string;
}

export default function PipelineTab() {
  const [pipeline, setPipeline] = useState<Record<string, PipelineStatus>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchPipeline();
  }, []);

  const fetchPipeline = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/repo-dashboard/pipeline');
      const data = await res.json();
      setPipeline(data.pipeline);
    } catch (err) {
      console.error('[PipelineTab] Fetch error:', err);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div style={{ padding: 20, color: 'var(--tn-text-muted)' }}>
        Loading pipeline status...
      </div>
    );
  }

  const apps = Object.entries(pipeline);

  if (apps.length === 0) {
    return (
      <div style={{ padding: 20, color: 'var(--tn-text-muted)' }}>
        No pipeline data available. Run <code>pipeline-check</code> manually.
      </div>
    );
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'OK': return 'var(--tn-green)';
      case 'WARN': return 'var(--tn-yellow)';
      case 'ERROR': return 'var(--tn-red)';
      default: return 'var(--tn-text-muted)';
    }
  };

  return (
    <div data-ai-id="pipeline-tab" style={{ padding: 12 }}>
      {/* Pipeline Diagram */}
      <div
        data-ai-id="pipeline-diagram"
        style={{
        background: 'var(--tn-bg)',
        borderRadius: 6,
        border: '1px solid var(--tn-border)',
        padding: 16,
        marginBottom: 16,
      }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--tn-text)', marginBottom: 12 }}>
          Pipeline Flow
        </div>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          fontSize: 11,
          fontFamily: 'monospace',
          color: 'var(--tn-text-muted)',
        }}>
          <span style={{
            background: 'rgba(122,162,247,0.15)',
            color: 'var(--tn-blue)',
            padding: '4px 10px',
            borderRadius: 4,
            fontWeight: 600,
          }}>
            develop
          </span>
          <span>→</span>
          <span style={{
            background: 'rgba(158,206,106,0.15)',
            color: 'var(--tn-green)',
            padding: '4px 10px',
            borderRadius: 4,
            fontWeight: 600,
          }}>
            main
          </span>
          <span>→</span>
          <span style={{
            background: 'rgba(224,175,104,0.15)',
            color: 'var(--tn-yellow)',
            padding: '4px 10px',
            borderRadius: 4,
            fontWeight: 600,
          }}>
            Vercel/Railway
          </span>
        </div>
      </div>

      {/* App Status Table */}
      <div
        data-ai-id="pipeline-table-container"
        style={{
          background: 'var(--tn-bg)',
          borderRadius: 6,
          border: '1px solid var(--tn-border)',
          overflow: 'hidden',
        }}
      >
        <table
          data-ai-id="pipeline-table"
          style={{
          width: '100%',
          borderCollapse: 'collapse',
          fontSize: 11,
          fontFamily: 'monospace',
        }}>
          <thead>
            <tr style={{ background: 'var(--tn-bg-dark)' }}>
              <th style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--tn-text-muted)', fontWeight: 600 }}>
                App
              </th>
              <th style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--tn-text-muted)', fontWeight: 600 }}>
                Status
              </th>
              <th style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--tn-text-muted)', fontWeight: 600 }}>
                Branch
              </th>
              <th style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--tn-text-muted)', fontWeight: 600 }}>
                Issues
              </th>
              <th style={{ padding: '8px 12px', textAlign: 'center', color: 'var(--tn-text-muted)', fontWeight: 600 }}>
                Hook
              </th>
            </tr>
          </thead>
          <tbody data-ai-id="pipeline-table-body">
            {apps.map(([app, status]) => (
              <tr
                key={app}
                data-ai-id={`pipeline-row-${app}`}
                style={{ borderTop: '1px solid var(--tn-border)' }}
              >
                <td style={{ padding: '8px 12px', fontWeight: 600, color: 'var(--tn-text)' }}>
                  {app}
                </td>
                <td style={{ padding: '8px 12px' }}>
                  <span style={{
                    background: `${getStatusColor(status.status)}22`,
                    color: getStatusColor(status.status),
                    padding: '2px 8px',
                    borderRadius: 3,
                    fontSize: 10,
                    fontWeight: 600,
                  }}>
                    {status.status}
                  </span>
                </td>
                <td style={{ padding: '8px 12px' }}>
                  <span style={{
                    background: 'rgba(122,162,247,0.15)',
                    color: 'var(--tn-blue)',
                    padding: '2px 6px',
                    borderRadius: 3,
                    fontSize: 10,
                  }}>
                    {status.branch || '-'}
                  </span>
                </td>
                <td style={{ padding: '8px 12px', color: 'var(--tn-text)' }}>
                  {status.issues || 'clean'}
                </td>
                <td style={{ padding: '8px 12px', textAlign: 'center' }}>
                  {status.hook ? (
                    <span style={{ color: 'var(--tn-green)' }}>✓</span>
                  ) : (
                    <span style={{ color: 'var(--tn-red)' }}>✗</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div
        data-ai-id="pipeline-legend"
        style={{ marginTop: 16, padding: 12, background: 'var(--tn-bg)', borderRadius: 6, border: '1px solid var(--tn-border)' }}
      >
        <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--tn-text-muted)', marginBottom: 8 }}>
          Legend
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10, color: 'var(--tn-text-muted)' }}>
          <div><span style={{ color: 'var(--tn-green)' }}>●</span> OK — Clean, ready to deploy</div>
          <div><span style={{ color: 'var(--tn-yellow)' }}>●</span> WARN — Uncommitted changes or wrong branch</div>
          <div><span style={{ color: 'var(--tn-red)' }}>●</span> ERROR — Unpushed commits</div>
        </div>
      </div>
    </div>
  );
}
