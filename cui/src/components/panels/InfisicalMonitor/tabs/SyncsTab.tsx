import type { Sync } from '../InfisicalMonitor';

interface Props {
  syncs: Sync[];
  onRefresh: () => void;
}

export default function SyncsTab({ syncs }: Props) {
  const succeededSyncs = syncs.filter(s => s.status === 'succeeded');
  const failedSyncs = syncs.filter(s => s.status === 'failed');
  const pendingSyncs = syncs.filter(s => s.status === 'pending');

  if (syncs.length === 0) {
    return (
      <div data-ai-id="syncs-tab-empty-state" style={{
        textAlign: 'center',
        padding: '40px 20px',
        color: 'var(--tn-text-muted)',
        fontSize: 12,
      }}>
        No sync data available
      </div>
    );
  }

  return (
    <div data-ai-id="syncs-tab-container" data-syncs-total={syncs.length} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {/* Summary Cards */}
      <div data-ai-id="syncs-tab-summary-cards" style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
        gap: '12px',
      }}>
        <div data-ai-id="syncs-tab-summary-succeeded" data-count={succeededSyncs.length} style={{
          padding: '12px',
          background: 'var(--tn-surface)',
          border: '1px solid var(--tn-border)',
          borderRadius: 6,
        }}>
          <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginBottom: 4 }}>
            Succeeded
          </div>
          <div data-ai-id="syncs-tab-succeeded-count" style={{ fontSize: 24, fontWeight: 700, color: 'var(--tn-green)' }}>
            {succeededSyncs.length}
          </div>
        </div>

        <div data-ai-id="syncs-tab-summary-failed" data-count={failedSyncs.length} style={{
          padding: '12px',
          background: 'var(--tn-surface)',
          border: '1px solid var(--tn-border)',
          borderRadius: 6,
        }}>
          <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginBottom: 4 }}>
            Failed
          </div>
          <div data-ai-id="syncs-tab-failed-count" style={{ fontSize: 24, fontWeight: 700, color: 'var(--tn-red)' }}>
            {failedSyncs.length}
          </div>
        </div>

        <div data-ai-id="syncs-tab-summary-pending" data-count={pendingSyncs.length} style={{
          padding: '12px',
          background: 'var(--tn-surface)',
          border: '1px solid var(--tn-border)',
          borderRadius: 6,
        }}>
          <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginBottom: 4 }}>
            Pending
          </div>
          <div data-ai-id="syncs-tab-pending-count" style={{ fontSize: 24, fontWeight: 700, color: 'var(--tn-orange)' }}>
            {pendingSyncs.length}
          </div>
        </div>
      </div>

      {/* Syncs Table */}
      <div data-ai-id="syncs-tab-table-container" style={{
        background: 'var(--tn-surface)',
        border: '1px solid var(--tn-border)',
        borderRadius: 8,
        overflow: 'hidden',
      }}>
        <table data-ai-id="syncs-tab-table" style={{
          width: '100%',
          borderCollapse: 'collapse',
          fontSize: 11,
        }}>
          <thead>
            <tr data-ai-id="syncs-tab-table-header" style={{
              background: 'var(--tn-surface-alt)',
              borderBottom: '1px solid var(--tn-border)',
            }}>
              <th style={{
                padding: '10px 12px',
                textAlign: 'left',
                fontWeight: 600,
                color: 'var(--tn-text)',
                fontSize: 10,
                textTransform: 'uppercase',
              }}>
                Status
              </th>
              <th style={{
                padding: '10px 12px',
                textAlign: 'left',
                fontWeight: 600,
                color: 'var(--tn-text)',
                fontSize: 10,
                textTransform: 'uppercase',
              }}>
                Project
              </th>
              <th style={{
                padding: '10px 12px',
                textAlign: 'left',
                fontWeight: 600,
                color: 'var(--tn-text)',
                fontSize: 10,
                textTransform: 'uppercase',
              }}>
                Integration
              </th>
              <th style={{
                padding: '10px 12px',
                textAlign: 'left',
                fontWeight: 600,
                color: 'var(--tn-text)',
                fontSize: 10,
                textTransform: 'uppercase',
              }}>
                Last Sync
              </th>
              <th style={{
                padding: '10px 12px',
                textAlign: 'center',
                fontWeight: 600,
                color: 'var(--tn-text)',
                fontSize: 10,
                textTransform: 'uppercase',
              }}>
                Auto-Sync
              </th>
            </tr>
          </thead>
          <tbody>
            {syncs.map((sync, idx) => (
              <tr
                key={idx}
                data-ai-id={`syncs-tab-table-row-${idx}`}
                data-sync-project={sync.project}
                data-sync-status={sync.status}
                data-sync-integration={sync.integration}
                style={{
                  borderBottom: '1px solid var(--tn-border)',
                  transition: 'background 0.2s ease',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'var(--tn-surface-hover)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent';
                }}
              >
                <td style={{ padding: '12px' }}>
                  <div data-ai-id={`syncs-tab-sync-status-badge-${idx}`} style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '4px 8px',
                    background: sync.status === 'succeeded' ? 'var(--tn-green-bg, #e8f5e9)' :
                                sync.status === 'failed' ? 'var(--tn-red-bg, #ffebee)' :
                                'var(--tn-orange-bg, #fff3e0)',
                    color: sync.status === 'succeeded' ? 'var(--tn-green, #2e7d32)' :
                           sync.status === 'failed' ? 'var(--tn-red, #c62828)' :
                           'var(--tn-orange, #ef6c00)',
                    borderRadius: 4,
                    fontSize: 10,
                    fontWeight: 600,
                  }}>
                    <span data-ai-id={`syncs-tab-sync-status-icon-${idx}`} style={{ fontSize: 12 }}>
                      {sync.status === 'succeeded' ? '✓' :
                       sync.status === 'failed' ? '✗' : '⏳'}
                    </span>
                    {sync.status.toUpperCase()}
                  </div>
                </td>
                <td style={{ padding: '12px' }}>
                  <span data-ai-id={`syncs-tab-sync-project-${idx}`} style={{ fontWeight: 500, color: 'var(--tn-text)' }}>
                    {sync.project}
                  </span>
                </td>
                <td style={{ padding: '12px' }}>
                  <div data-ai-id={`syncs-tab-sync-integration-badge-${idx}`} style={{
                    display: 'inline-flex',
                    padding: '4px 8px',
                    background: sync.integration === 'vercel' ? 'var(--tn-blue-bg, #e3f2fd)' : 'var(--tn-purple-bg, #f3e5f5)',
                    color: sync.integration === 'vercel' ? 'var(--tn-blue, #1976d2)' : 'var(--tn-purple, #7b1fa2)',
                    borderRadius: 4,
                    fontSize: 10,
                    fontWeight: 600,
                    textTransform: 'uppercase',
                  }}>
                    {sync.integration}
                  </div>
                </td>
                <td style={{ padding: '12px' }}>
                  <span data-ai-id={`syncs-tab-sync-last-sync-${idx}`} style={{ color: 'var(--tn-text-muted)', fontSize: 10 }}>
                    {new Date(sync.lastSync).toLocaleString()}
                  </span>
                </td>
                <td style={{ padding: '12px', textAlign: 'center' }}>
                  <span data-ai-id={`syncs-tab-sync-auto-sync-${idx}`} style={{ fontSize: 14 }}>
                    {sync.autoSync ? '✓' : '✗'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
