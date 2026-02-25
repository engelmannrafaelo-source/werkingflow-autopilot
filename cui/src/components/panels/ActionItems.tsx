import type { ActionItem } from './VirtualOffice';

interface ActionItemsProps {
  items: ActionItem[];
  onItemClick: (item: ActionItem) => void;
  onRefresh: () => void;
}

function getPriorityColor(priority: string): string {
  switch (priority) {
    case 'urgent': return 'var(--tn-red)';
    case 'normal': return 'var(--tn-orange)';
    case 'low': return 'var(--tn-blue)';
    default: return 'var(--tn-text-muted)';
  }
}

function getPriorityIcon(priority: string): string {
  switch (priority) {
    case 'urgent': return '🔴';
    case 'normal': return '🟡';
    case 'low': return '🔵';
    default: return '⚪';
  }
}

function getTypeLabel(type: string): string {
  switch (type) {
    case 'approval': return 'Approval';
    case 'review': return 'Review';
    case 'decision': return 'Decision';
    case 'suggestion': return 'Suggestion';
    default: return 'Task';
  }
}

export default function ActionItems({ items, onItemClick, onRefresh }: ActionItemsProps) {
  // Group items by priority
  const urgent = items.filter(i => i.priority === 'urgent');
  const normal = items.filter(i => i.priority === 'normal');
  const low = items.filter(i => i.priority === 'low');

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
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        background: 'var(--tn-surface)'
      }}>
        <div>
          <div style={{
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--tn-text)',
            marginBottom: 4
          }}>
            📋 Action Items
          </div>
          <div style={{
            fontSize: 10,
            color: 'var(--tn-text-muted)'
          }}>
            {items.length} items need attention
          </div>
        </div>
        <button
          onClick={onRefresh}
          style={{
            padding: '4px 8px',
            background: 'var(--tn-surface-alt)',
            border: '1px solid var(--tn-border)',
            borderRadius: 4,
            color: 'var(--tn-text-muted)',
            fontSize: 10,
            cursor: 'pointer',
            transition: 'all 0.2s ease'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--tn-surface-hover)';
            e.currentTarget.style.borderColor = 'var(--tn-border-hover)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'var(--tn-surface-alt)';
            e.currentTarget.style.borderColor = 'var(--tn-border)';
          }}
        >
          🔄 Refresh
        </button>
      </div>

      {/* Action Items List */}
      <div style={{
        flex: 1,
        overflow: 'auto',
        padding: '8px 0'
      }}>
        {items.length === 0 ? (
          <div style={{
            padding: '24px 16px',
            textAlign: 'center',
            color: 'var(--tn-text-muted)',
            fontSize: 11
          }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>✓</div>
            <div>All caught up!</div>
          </div>
        ) : (
          <>
            {/* URGENT Section */}
            {urgent.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <div style={{
                  padding: '8px 16px',
                  fontSize: 10,
                  fontWeight: 600,
                  color: 'var(--tn-red)',
                  background: 'rgba(255, 59, 48, 0.1)',
                  borderLeft: `3px solid var(--tn-red)`
                }}>
                  🔴 URGENT ({urgent.length})
                </div>
                {urgent.map((item) => (
                  <ActionItemCard key={item.id} item={item} onClick={() => onItemClick(item)} />
                ))}
              </div>
            )}

            {/* NORMAL/PENDING Section */}
            {normal.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <div style={{
                  padding: '8px 16px',
                  fontSize: 10,
                  fontWeight: 600,
                  color: 'var(--tn-orange)',
                  background: 'rgba(255, 149, 0, 0.1)',
                  borderLeft: `3px solid var(--tn-orange)`
                }}>
                  🟡 PENDING ({normal.length})
                </div>
                {normal.map((item) => (
                  <ActionItemCard key={item.id} item={item} onClick={() => onItemClick(item)} />
                ))}
              </div>
            )}

            {/* SUGGESTIONS Section */}
            {low.length > 0 && (
              <div>
                <div style={{
                  padding: '8px 16px',
                  fontSize: 10,
                  fontWeight: 600,
                  color: 'var(--tn-blue)',
                  background: 'rgba(0, 122, 255, 0.1)',
                  borderLeft: `3px solid var(--tn-blue)`
                }}>
                  🔔 NEXT UP ({low.length})
                </div>
                {low.map((item) => (
                  <ActionItemCard key={item.id} item={item} onClick={() => onItemClick(item)} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

interface ActionItemCardProps {
  item: ActionItem;
  onClick: () => void;
}

function ActionItemCard({ item, onClick }: ActionItemCardProps) {
  return (
    <div
      onClick={onClick}
      style={{
        padding: '12px 16px',
        borderBottom: '1px solid var(--tn-border-subtle)',
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
      {/* Type + Age */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 6
      }}>
        <div style={{
          fontSize: 9,
          fontWeight: 600,
          color: getPriorityColor(item.priority),
          textTransform: 'uppercase',
          letterSpacing: 0.5
        }}>
          {getTypeLabel(item.type)}
        </div>
        {typeof item.age === 'number' && (
          <div style={{
            fontSize: 9,
            color: item.age > 3 ? 'var(--tn-red)' : 'var(--tn-text-muted)',
            fontWeight: item.age > 3 ? 600 : 400
          }}>
            {item.age}d old
          </div>
        )}
      </div>

      {/* Title */}
      <div style={{
        fontSize: 11,
        fontWeight: 600,
        color: 'var(--tn-text)',
        marginBottom: 4,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap'
      }}>
        {item.title}
      </div>

      {/* Description */}
      <div style={{
        fontSize: 10,
        color: 'var(--tn-text-muted)',
        lineHeight: 1.4,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        display: '-webkit-box',
        WebkitLineClamp: 2,
        WebkitBoxOrient: 'vertical',
        marginBottom: 6
      }}>
        {item.description}
      </div>

      {/* Metadata (Persona, Blocking) */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        fontSize: 9,
        color: 'var(--tn-text-muted)'
      }}>
        {item.personaName && (
          <div style={{
            padding: '2px 6px',
            background: 'var(--tn-surface-alt)',
            borderRadius: 3
          }}>
            👤 {item.personaName}
          </div>
        )}
        {item.blocking && (
          <div style={{
            padding: '2px 6px',
            background: 'rgba(255, 59, 48, 0.1)',
            color: 'var(--tn-red)',
            borderRadius: 3,
            fontWeight: 600
          }}>
            ⚠️ Blocks work
          </div>
        )}
      </div>
    </div>
  );
}
