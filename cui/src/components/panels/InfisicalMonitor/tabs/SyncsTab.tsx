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
      <div style={{
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {/* Summary Cards */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
        gap: '12px',
      }}>
        <div style={{
          padding: '12px',
          background: 'var(--tn-surface)',
          border: '1px solid var(--tn-border)',
          borderRadius: 6,
        }}>
          <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginBottom: 4 }}>
            Succeeded
          </div>
          <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--tn-green)' }}>
            {succeededSyncs.length}
          </div>
        </div>

        <div style={{
          padding: '12px',
          background: 'var(--tn-surface)',
          border: '1px solid var(--tn-border)',
          borderRadius: 6,
        }}>
          <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginBottom: 4 }}>
            Failed
          </div>
          <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--tn-red)' }}>
            {failedSyncs.length}
          </div>
        </div>

        <div style={{
          padding: '12px',
          background: 'var(--tn-surface)',
          border: '1px solid var(--tn-border)',
          borderRadius: 6,
        }}>
          <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginBottom: 4 }}>
            Pending
          </div>
          <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--tn-orange)' }}>
            {pendingSyncs.length}
          </div>
        </div>
      </div>

      {/* Syncs Table */}
      <div style={{
        background: 'var(--tn-surface)',
        border: '1px solid var(--tn-border)',
        borderRadius: 8,
        overflow: 'hidden',
      }}>
        <table style={{
          width: '100%',
          borderCollapse: 'collapse',
          fontSize: 11,
        }}>
          <thead>
            <tr style={{
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
                  <div style={{
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
                    <span style={{ fontSize: 12 }}>
                      {sync.status === 'succeeded' ? '✓' :
                       sync.status === 'failed' ? '✗' : '⏳'}
                    </span>
                    {sync.status.toUpperCase()}
                  </div>
                </td>
                <td style={{ padding: '12px' }}>
                  <span style={{ fontWeight: 500, color: 'var(--tn-text)' }}>
                    {sync.project}
                  </span>
                </td>
                <td style={{ padding: '12px' }}>
                  <div style={{
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
                  <span style={{ color: 'var(--tn-text-muted)', fontSize: 10 }}>
                    {new Date(sync.lastSync).toLocaleString()}
                  </span>
                </td>
                <td style={{ padding: '12px', textAlign: 'center' }}>
                  <span style={{ fontSize: 14 }}>
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
