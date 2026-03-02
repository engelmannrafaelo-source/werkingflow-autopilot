import type { HealthStatus } from '../InfisicalMonitor';

interface Props {
  health: HealthStatus | null;
  onRefresh: () => void;
}

export default function HealthTab({ health, onRefresh }: Props) {
  if (!health) {
    return (
      <div style={{
        textAlign: 'center',
        padding: '40px 20px',
        color: 'var(--tn-text-muted)',
        fontSize: 12,
      }}>
        No health data available
      </div>
    );
  }

  const isHealthy = health.status === 'healthy';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {/* Status Card */}
      <div style={{
        padding: '24px',
        background: isHealthy ? 'var(--tn-green-bg, #e8f5e9)' : 'var(--tn-red-bg, #ffebee)',
        border: `2px solid ${isHealthy ? 'var(--tn-green, #2e7d32)' : 'var(--tn-red, #c62828)'}`,
        borderRadius: 8,
        textAlign: 'center',
      }}>
        <div style={{ fontSize: 48, marginBottom: 12 }}>
          {isHealthy ? '✓' : '✗'}
        </div>
        <div style={{
          fontSize: 24,
          fontWeight: 700,
          color: isHealthy ? 'var(--tn-green, #2e7d32)' : 'var(--tn-red, #c62828)',
          textTransform: 'uppercase',
          marginBottom: 8,
        }}>
          {health.status}
        </div>
        <div style={{
          fontSize: 11,
          color: 'var(--tn-text-muted)',
          fontFamily: 'monospace',
        }}>
          {health.server}
        </div>
      </div>

      {/* Error Details (if unhealthy) */}
      {!isHealthy && health.error && (
        <div style={{
          padding: '16px',
          background: 'var(--tn-surface)',
          border: '1px solid var(--tn-red)',
          borderRadius: 8,
        }}>
          <h4 style={{
            margin: '0 0 8px 0',
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--tn-red)',
          }}>
            Error Details
          </h4>
          <pre style={{
            margin: 0,
            fontSize: 10,
            color: 'var(--tn-text)',
            fontFamily: 'monospace',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}>
            {health.error}
          </pre>
        </div>
      )}

      {/* Response Data (if healthy) */}
      {isHealthy && health.response && (
        <div style={{
          padding: '16px',
          background: 'var(--tn-surface)',
          border: '1px solid var(--tn-border)',
          borderRadius: 8,
        }}>
          <h4 style={{
            margin: '0 0 8px 0',
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--tn-text)',
          }}>
            Server Response
          </h4>
          <pre style={{
            margin: 0,
            fontSize: 10,
            color: 'var(--tn-text-muted)',
            fontFamily: 'monospace',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            maxHeight: 300,
            overflow: 'auto',
          }}>
            {JSON.stringify(health.response, null, 2)}
          </pre>
        </div>
      )}

      {/* Timestamp */}
      <div style={{
        padding: '12px 16px',
        background: 'var(--tn-surface)',
        border: '1px solid var(--tn-border)',
        borderRadius: 8,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}>
        <span style={{
          fontSize: 10,
          color: 'var(--tn-text-muted)',
          textTransform: 'uppercase',
          fontWeight: 600,
        }}>
          Last Check
        </span>
        <span style={{
          fontSize: 11,
          color: 'var(--tn-text)',
          fontFamily: 'monospace',
        }}>
          {new Date(health.timestamp).toLocaleString()}
        </span>
      </div>

      {/* Manual Refresh */}
      <button
        onClick={onRefresh}
        style={{
          padding: '12px',
          background: 'var(--tn-blue)',
          color: 'white',
          border: 'none',
          borderRadius: 6,
          cursor: 'pointer',
          fontSize: 12,
          fontWeight: 600,
          textTransform: 'uppercase',
        }}
      >
        ↻ Check Health Now
      </button>
    </div>
  );
}
