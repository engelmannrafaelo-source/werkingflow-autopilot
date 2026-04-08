import { useState, useEffect, useRef } from 'react';

interface ActivityEvent {
  timestamp: string;
  action: string;
  actor: string;
  resource: string;
  details?: any;
  type?: 'keepalive'; // Internal keep-alive message
}

interface ActivityFeedProps {
  envMode?: string;
}

export default function ActivityFeed({ envMode }: ActivityFeedProps) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [isPaused, setIsPaused] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState('');
  const eventSourceRef = useRef<EventSource | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new event arrives (unless paused)
  useEffect(() => {
    if (!isPaused && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [events, isPaused]);

  // Connect to SSE stream
  useEffect(() => {
    const connectSSE = () => {
      try {
        // Close existing connection
        if (eventSourceRef.current) {
          eventSourceRef.current.close();
        }

        setError('');
        const es = new EventSource('/api/admin/wr/activity-stream');

        es.onopen = () => {
          console.log('[Activity Feed] Connected to activity stream');
          setIsConnected(true);
          setError('');
        };

        es.onmessage = (e) => {
          try {
            const event: ActivityEvent = JSON.parse(e.data);

            // Skip keep-alive messages
            if (event.type === 'keepalive') {
              return;
            }

            // Add new event (keep last 50)
            setEvents((prev) => {
              const updated = [...prev, event];
              return updated.slice(-50); // Keep only last 50 events
            });
          } catch (parseError) {
            console.error('[Activity Feed] Failed to parse event:', parseError);
          }
        };

        es.onerror = (err) => {
          console.error('[Activity Feed] SSE error:', err);
          setIsConnected(false);
          setError('Connection lost. Reconnecting...');
          es.close();

          // Retry connection after 5 seconds
          setTimeout(() => {
            console.log('[Activity Feed] Attempting to reconnect...');
            connectSSE();
          }, 5000);
        };

        eventSourceRef.current = es;
      } catch (err: any) {
        console.error('[Activity Feed] Failed to connect:', err);
        setError('Failed to connect to activity stream');
        setIsConnected(false);
      }
    };

    connectSSE();

    // Cleanup on unmount
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, [envMode]); // Reconnect when env mode changes

  // Clear all events
  const handleClear = () => {
    setEvents([]);
  };

  // Toggle pause
  const handleTogglePause = () => {
    setIsPaused((prev) => !prev);
  };

  // Get icon for action type
  const getActionIcon = (action: string): string => {
    if (action.includes('delete') || action.includes('remove')) return '🗑️';
    if (action.includes('create') || action.includes('add')) return '✨';
    if (action.includes('update') || action.includes('edit')) return '✏️';
    if (action.includes('login') || action.includes('auth')) return '🔑';
    if (action.includes('approve')) return '✅';
    if (action.includes('verify')) return '☑️';
    return '📝';
  };

  // Get color for action type
  const getActionColor = (action: string): string => {
    if (action.includes('delete') || action.includes('remove')) return 'var(--tn-red)';
    if (action.includes('create') || action.includes('add')) return 'var(--tn-green)';
    if (action.includes('update') || action.includes('edit')) return 'var(--tn-blue)';
    if (action.includes('login') || action.includes('auth')) return 'var(--tn-orange)';
    return 'var(--tn-text-muted)';
  };

  // Format relative time
  const getRelativeTime = (timestamp: string): string => {
    const now = Date.now();
    const then = new Date(timestamp).getTime();
    const diff = now - then;

    if (diff < 60000) return 'just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return `${Math.floor(diff / 86400000)}d ago`;
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: 'var(--tn-bg-dark)',
        borderRadius: 4,
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '8px 12px',
          borderBottom: '1px solid var(--tn-border)',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--tn-text)', flex: 1 }}>
          Activity Feed
        </span>

        {/* Connection Status */}
        <div
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: isConnected ? 'var(--tn-green)' : 'var(--tn-red)',
            boxShadow: isConnected
              ? '0 0 6px rgba(158,206,106,0.6)'
              : '0 0 6px rgba(247,118,142,0.6)',
          }}
          title={isConnected ? 'Connected' : 'Disconnected'}
        />

        {/* Pause/Resume Button */}
        <button
          onClick={handleTogglePause}
          style={{
            padding: '2px 6px',
            borderRadius: 3,
            fontSize: 9,
            fontWeight: 600,
            cursor: 'pointer',
            background: isPaused ? 'var(--tn-orange)' : 'var(--tn-green)',
            border: 'none',
            color: '#fff',
          }}
          title={isPaused ? 'Resume auto-scroll' : 'Pause auto-scroll'}
        >
          {isPaused ? '▶' : '⏸'}
        </button>

        {/* Clear Button */}
        <button
          onClick={handleClear}
          disabled={events.length === 0}
          style={{
            padding: '2px 6px',
            borderRadius: 3,
            fontSize: 9,
            fontWeight: 600,
            cursor: events.length === 0 ? 'not-allowed' : 'pointer',
            background: 'transparent',
            border: '1px solid var(--tn-border)',
            color: 'var(--tn-text-muted)',
            opacity: events.length === 0 ? 0.5 : 1,
          }}
        >
          Clear
        </button>
      </div>

      {/* Error Message */}
      {error && (
        <div
          style={{
            padding: '6px 10px',
            fontSize: 10,
            color: 'var(--tn-red)',
            background: 'rgba(247,118,142,0.1)',
            borderBottom: '1px solid var(--tn-border)',
          }}
        >
          {error}
        </div>
      )}

      {/* Events List */}
      <div
        ref={containerRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: 8,
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          minHeight: 0,
        }}
      >
        {events.length === 0 && (
          <div
            style={{
              padding: 20,
              textAlign: 'center',
              color: 'var(--tn-text-muted)',
              fontSize: 10,
            }}
          >
            {isConnected ? 'Waiting for activity...' : 'Connecting...'}
          </div>
        )}

        {events.map((event, idx) => (
          <div
            key={idx}
            style={{
              padding: '6px 8px',
              background: 'var(--tn-bg)',
              borderRadius: 3,
              borderLeft: `3px solid ${getActionColor(event.action)}`,
              fontSize: 10,
              display: 'flex',
              alignItems: 'flex-start',
              gap: 6,
            }}
          >
            {/* Icon */}
            <div style={{ fontSize: 12, flexShrink: 0 }}>{getActionIcon(event.action)}</div>

            {/* Content */}
            <div style={{ flex: 1, minWidth: 0 }}>
              {/* Action Description */}
              <div style={{ color: 'var(--tn-text)', lineHeight: 1.4 }}>
                <strong style={{ color: getActionColor(event.action) }}>{event.actor}</strong>
                {' '}
                <span style={{ color: 'var(--tn-text-muted)' }}>
                  {event.action.replace('.', ' ')}
                </span>
                {' '}
                <span
                  style={{
                    fontFamily: 'monospace',
                    fontSize: 9,
                    color: 'var(--tn-text-muted)',
                  }}
                >
                  {event.resource}
                </span>
              </div>

              {/* Timestamp */}
              <div
                style={{
                  fontSize: 9,
                  color: 'var(--tn-text-muted)',
                  marginTop: 2,
                }}
              >
                {getRelativeTime(event.timestamp)}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Footer - Event Count */}
      {events.length > 0 && (
        <div
          style={{
            padding: '4px 12px',
            borderTop: '1px solid var(--tn-border)',
            fontSize: 9,
            color: 'var(--tn-text-muted)',
            textAlign: 'center',
            flexShrink: 0,
          }}
        >
          {events.length} event{events.length !== 1 ? 's' : ''} (last 50)
        </div>
      )}
    </div>
  );
}
