import type { ActivityEvent } from './VirtualOffice';

interface ActivityStreamProps {
  activities: ActivityEvent[];
}

function formatTimeAgo(timestamp: string): string {
  const diffMs = Date.now() - new Date(timestamp).getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMs / 3600000);

  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

function getActionIcon(action: string): string {
  switch (action) {
    case 'started': return '▶️';
    case 'completed': return '✅';
    case 'error': return '❌';
    case 'wrote': return '📝';
    case 'messaged': return '💬';
    case 'approved': return '✓';
    case 'rejected': return '✗';
    default: return '•';
  }
}

function getActionColor(action: string): string {
  switch (action) {
    case 'started': return 'var(--tn-blue)';
    case 'completed': return 'var(--tn-green)';
    case 'error': return 'var(--tn-red)';
    case 'wrote': return 'var(--tn-purple)';
    case 'messaged': return 'var(--tn-cyan)';
    case 'approved': return 'var(--tn-green)';
    case 'rejected': return 'var(--tn-orange)';
    default: return 'var(--tn-text-muted)';
  }
}

export default function ActivityStream({ activities }: ActivityStreamProps) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      overflow: 'hidden'
    }}>
      {/* Header */}
      <div style={{
        padding: '12px 16px',
        borderBottom: '1px solid var(--tn-border)',
        background: 'var(--tn-surface)'
      }}>
        <div style={{
          fontSize: 12,
          fontWeight: 600,
          color: 'var(--tn-text)',
          marginBottom: 4
        }}>
          ⚡ Live Activity
        </div>
        <div style={{
          fontSize: 10,
          color: 'var(--tn-text-muted)'
        }}>
          Real-time agent updates
        </div>
      </div>

      {/* Activity List */}
      <div style={{
        flex: 1,
        overflow: 'auto',
        padding: '8px 0'
      }}>
        {activities.length === 0 ? (
          <div style={{
            padding: '24px 16px',
            textAlign: 'center',
            color: 'var(--tn-text-muted)',
            fontSize: 11
          }}>
            No recent activity
          </div>
        ) : (
          activities.map((activity, index) => (
            <div
              key={`${activity.timestamp}-${index}`}
              style={{
                padding: '10px 16px',
                borderBottom: index < activities.length - 1 ? '1px solid var(--tn-border-subtle)' : 'none',
                cursor: 'pointer',
                transition: 'background 0.15s ease'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--tn-surface-hover)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent';
              }}
            >
              {/* Time */}
              <div style={{
                fontSize: 10,
                color: 'var(--tn-text-muted)',
                marginBottom: 4
              }}>
                {formatTimeAgo(activity.timestamp)}
              </div>

              {/* Agent + Action */}
              <div style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 8,
                marginBottom: 6
              }}>
                <span style={{
                  fontSize: 14,
                  color: getActionColor(activity.action)
                }}>
                  {getActionIcon(activity.action)}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: 'var(--tn-text)',
                    marginBottom: 2
                  }}>
                    {activity.personaName}
                  </div>
                  <div style={{
                    fontSize: 10,
                    color: 'var(--tn-text-muted)',
                    lineHeight: 1.4,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical'
                  }}>
                    {activity.description}
                  </div>
                </div>
              </div>

              {/* Progress Bar (if present) */}
              {typeof activity.progress === 'number' && (
                <div style={{
                  marginTop: 6,
                  height: 3,
                  background: 'var(--tn-border)',
                  borderRadius: 2,
                  overflow: 'hidden'
                }}>
                  <div style={{
                    width: `${activity.progress}%`,
                    height: '100%',
                    background: getActionColor(activity.action),
                    transition: 'width 0.3s ease'
                  }} />
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
