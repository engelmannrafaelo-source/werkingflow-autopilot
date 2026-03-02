import type { InfisicalData } from '../InfisicalMonitor';

interface Props {
  data: InfisicalData;
  onRefresh: () => void;
}

export default function OverviewTab({ data }: Props) {
  const { projects, syncs, health } = data;

  const succeededSyncs = syncs.filter(s => s.status === 'succeeded').length;
  const failedSyncs = syncs.filter(s => s.status === 'failed').length;
  const healthStatus = health?.status || 'unknown';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {/* Status Cards */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
        gap: '12px',
      }}>
        {/* Health Card */}
        <div style={{
          padding: '16px',
          background: 'var(--tn-surface)',
          border: '1px solid var(--tn-border)',
          borderRadius: 8,
        }}>
          <div style={{
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--tn-text-muted)',
            textTransform: 'uppercase',
            marginBottom: 8,
          }}>
            Server Status
          </div>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}>
            <span style={{ fontSize: 24 }}>
              {healthStatus === 'healthy' ? '🟢' : '🔴'}
            </span>
            <span style={{
              fontSize: 18,
              fontWeight: 600,
              color: 'var(--tn-text)',
              textTransform: 'capitalize',
            }}>
              {healthStatus}
            </span>
          </div>
        </div>

        {/* Projects Card */}
        <div style={{
          padding: '16px',
          background: 'var(--tn-surface)',
          border: '1px solid var(--tn-border)',
          borderRadius: 8,
        }}>
          <div style={{
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--tn-text-muted)',
            textTransform: 'uppercase',
            marginBottom: 8,
          }}>
            Projects
          </div>
          <div style={{
            fontSize: 32,
            fontWeight: 700,
            color: 'var(--tn-text)',
          }}>
            {projects.length}
          </div>
          <div style={{
            fontSize: 10,
            color: 'var(--tn-text-muted)',
            marginTop: 4,
          }}>
            {projects.filter(p => p.environment === 'production').length} production
          </div>
        </div>

        {/* Syncs Card */}
        <div style={{
          padding: '16px',
          background: 'var(--tn-surface)',
          border: '1px solid var(--tn-border)',
          borderRadius: 8,
        }}>
          <div style={{
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--tn-text-muted)',
            textTransform: 'uppercase',
            marginBottom: 8,
          }}>
            Auto-Syncs
          </div>
          <div style={{
            fontSize: 32,
            fontWeight: 700,
            color: 'var(--tn-text)',
          }}>
            {succeededSyncs}/{syncs.length}
          </div>
          <div style={{
            fontSize: 10,
            color: failedSyncs > 0 ? 'var(--tn-red)' : 'var(--tn-green)',
            marginTop: 4,
          }}>
            {failedSyncs > 0 ? `${failedSyncs} failed` : 'All succeeded'}
          </div>
        </div>
      </div>

      {/* Recent Syncs */}
      <div style={{
        background: 'var(--tn-surface)',
        border: '1px solid var(--tn-border)',
        borderRadius: 8,
        padding: '16px',
      }}>
        <h4 style={{
          margin: '0 0 12px 0',
          fontSize: 12,
          fontWeight: 600,
          color: 'var(--tn-text)',
        }}>
          Recent Syncs
        </h4>
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}>
          {syncs.slice(0, 5).map((sync, idx) => (
            <div
              key={idx}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '8px 12px',
                background: 'var(--tn-bg)',
                borderRadius: 4,
                fontSize: 11,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 14 }}>
                  {sync.status === 'succeeded' ? '✅' : '❌'}
                </span>
                <span style={{ fontWeight: 500, color: 'var(--tn-text)' }}>
                  {sync.project}
                </span>
                <span style={{
                  fontSize: 9,
                  padding: '2px 6px',
                  background: sync.integration === 'vercel' ? 'var(--tn-blue-bg, #e3f2fd)' : 'var(--tn-purple-bg, #f3e5f5)',
                  color: sync.integration === 'vercel' ? 'var(--tn-blue, #1976d2)' : 'var(--tn-purple, #7b1fa2)',
                  borderRadius: 3,
                  fontWeight: 600,
                  textTransform: 'uppercase',
                }}>
                  {sync.integration}
                </span>
              </div>
              <span style={{ fontSize: 10, color: 'var(--tn-text-muted)' }}>
                {new Date(sync.lastSync).toLocaleTimeString()}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Server Info */}
      {data.serverInfo && (
        <div style={{
          background: 'var(--tn-surface)',
          border: '1px solid var(--tn-border)',
          borderRadius: 8,
          padding: '16px',
        }}>
          <h4 style={{
            margin: '0 0 12px 0',
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--tn-text)',
          }}>
            Server Information
          </h4>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            gap: '8px 16px',
            fontSize: 11,
          }}>
            <span style={{ color: 'var(--tn-text-muted)', fontWeight: 500 }}>Tailscale IP:</span>
            <span style={{ color: 'var(--tn-text)', fontFamily: 'monospace' }}>{data.serverInfo.tailscaleIP}</span>

            <span style={{ color: 'var(--tn-text-muted)', fontWeight: 500 }}>Public IP:</span>
            <span style={{ color: 'var(--tn-text)', fontFamily: 'monospace' }}>{data.serverInfo.publicIP}</span>

            <span style={{ color: 'var(--tn-text-muted)', fontWeight: 500 }}>Web UI:</span>
            <a
              href={data.serverInfo.webUI}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: 'var(--tn-blue)', textDecoration: 'none' }}
            >
              {data.serverInfo.webUI}
            </a>

            <span style={{ color: 'var(--tn-text-muted)', fontWeight: 500 }}>Documentation:</span>
            <span style={{ color: 'var(--tn-text)', fontFamily: 'monospace', fontSize: 10 }}>
              {data.serverInfo.docs}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
