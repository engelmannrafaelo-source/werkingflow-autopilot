import React, { useState, useEffect, useRef } from 'react';

interface Notification {
  id: string;
  type: 'new_user' | 'failed_payment' | 'system_error' | 'approval_needed';
  title: string;
  message: string;
  timestamp: string;
  read: boolean;
  actionUrl?: string;
  metadata?: Record<string, unknown>;
}

interface NotificationBellProps {
  envMode: string;
}

export default function NotificationBell({ envMode }: NotificationBellProps) {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  // Fetch notifications
  const fetchNotifications = async () => {
    try {
      const res = await fetch('/api/admin/wr/notifications');
      if (res.ok) {
        const data = await res.json();
        setNotifications(data.notifications || []);
        setUnreadCount(data.unreadCount || 0);
      }
    } catch (err) {
      console.error('[NotificationBell] Failed to fetch notifications:', err);
    }
  };

  // Poll for new notifications every 30 seconds
  useEffect(() => {
    fetchNotifications();
    const interval = setInterval(fetchNotifications, 30000);
    return () => clearInterval(interval);
  }, [envMode]); // Refetch when env changes

  // Mark notification as read
  const markAsRead = async (id: string) => {
    try {
      await fetch(`/api/admin/wr/notifications/${id}/read`, { method: 'POST' });
      setNotifications(prev => prev.map(n => n.id === id ? { ...n, read: true } : n));
      setUnreadCount(prev => Math.max(0, prev - 1));
    } catch (err) {
      console.error('[NotificationBell] Failed to mark as read:', err);
    }
  };

  // Mark all as read
  const markAllAsRead = async () => {
    setLoading(true);
    try {
      await fetch('/api/admin/wr/notifications/read-all', { method: 'POST' });
      setNotifications(prev => prev.map(n => ({ ...n, read: true })));
      setUnreadCount(0);
    } catch (err) {
      console.error('[NotificationBell] Failed to mark all as read:', err);
    }
    setLoading(false);
  };

  // Handle notification click
  const handleNotificationClick = (notification: Notification) => {
    markAsRead(notification.id);
    if (notification.actionUrl) {
      // For now, just log the URL (could implement navigation later)
      console.log('[NotificationBell] Navigate to:', notification.actionUrl);
    }
  };

  // Get icon and color for notification type
  const getNotificationStyle = (type: Notification['type']) => {
    switch (type) {
      case 'new_user':
        return { icon: '👤', color: 'var(--tn-blue)' };
      case 'failed_payment':
        return { icon: '💳', color: 'var(--tn-red)' };
      case 'system_error':
        return { icon: '⚠️', color: 'var(--tn-orange)' };
      case 'approval_needed':
        return { icon: '✋', color: 'var(--tn-green)' };
      default:
        return { icon: '📬', color: 'var(--tn-text-muted)' };
    }
  };

  // Format relative time
  const formatRelativeTime = (timestamp: string) => {
    const now = new Date();
    const then = new Date(timestamp);
    const diffMs = now.getTime() - then.getTime();
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 1) return 'gerade eben';
    if (diffMins < 60) return `vor ${diffMins}m`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `vor ${diffHours}h`;
    const diffDays = Math.floor(diffHours / 24);
    return `vor ${diffDays}d`;
  };

  return (
    <div style={{ position: 'relative' }} ref={dropdownRef}>
      {/* Bell Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        style={{
          position: 'relative',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          padding: '4px 8px',
          color: 'var(--tn-text)',
          fontSize: 16,
          display: 'flex',
          alignItems: 'center',
          gap: 4,
        }}
        title="Benachrichtigungen"
      >
        🔔
        {unreadCount > 0 && (
          <span style={{
            position: 'absolute',
            top: 0,
            right: 0,
            background: 'var(--tn-red)',
            color: '#fff',
            fontSize: 9,
            fontWeight: 700,
            borderRadius: 8,
            padding: '1px 4px',
            minWidth: 16,
            textAlign: 'center',
            boxShadow: '0 0 4px rgba(247,118,142,0.5)',
          }}>
            {unreadCount}
          </span>
        )}
      </button>

      {/* Dropdown */}
      {isOpen && (
        <div style={{
          position: 'absolute',
          top: '100%',
          right: 0,
          marginTop: 8,
          background: 'var(--tn-bg-dark)',
          border: '1px solid var(--tn-border)',
          borderRadius: 6,
          boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
          width: 320,
          maxHeight: 400,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          zIndex: 1000,
        }}>
          {/* Header */}
          <div style={{
            padding: '8px 12px',
            borderBottom: '1px solid var(--tn-border)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--tn-text)' }}>
              BENACHRICHTIGUNGEN
            </span>
            {notifications.length > 0 && (
              <button
                onClick={markAllAsRead}
                disabled={loading || unreadCount === 0}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: unreadCount === 0 ? 'var(--tn-text-muted)' : 'var(--tn-blue)',
                  fontSize: 9,
                  fontWeight: 600,
                  cursor: loading || unreadCount === 0 ? 'not-allowed' : 'pointer',
                  padding: '2px 6px',
                  borderRadius: 3,
                  opacity: loading ? 0.5 : 1,
                }}
              >
                Alle gelesen
              </button>
            )}
          </div>

          {/* Notifications List */}
          <div style={{
            flex: 1,
            overflowY: 'auto',
            minHeight: 0,
          }}>
            {notifications.length === 0 ? (
              <div style={{
                padding: 24,
                textAlign: 'center',
                color: 'var(--tn-text-muted)',
                fontSize: 11,
              }}>
                Keine Benachrichtigungen
              </div>
            ) : (
              notifications.map(notification => {
                const style = getNotificationStyle(notification.type);
                return (
                  <div
                    key={notification.id}
                    onClick={() => handleNotificationClick(notification)}
                    style={{
                      padding: '8px 12px',
                      borderBottom: '1px solid var(--tn-border)',
                      cursor: notification.actionUrl ? 'pointer' : 'default',
                      background: notification.read ? 'transparent' : 'rgba(122,162,247,0.05)',
                      transition: 'background 0.15s',
                      display: 'flex',
                      gap: 8,
                    }}
                    onMouseEnter={(e) => {
                      if (notification.actionUrl) {
                        e.currentTarget.style.background = 'rgba(122,162,247,0.1)';
                      }
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = notification.read
                        ? 'transparent'
                        : 'rgba(122,162,247,0.05)';
                    }}
                  >
                    {/* Icon */}
                    <div style={{
                      fontSize: 16,
                      flexShrink: 0,
                    }}>
                      {style.icon}
                    </div>

                    {/* Content */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{
                        fontSize: 10,
                        fontWeight: 600,
                        color: 'var(--tn-text)',
                        marginBottom: 2,
                      }}>
                        {notification.title}
                      </div>
                      <div style={{
                        fontSize: 9,
                        color: 'var(--tn-text-muted)',
                        lineHeight: 1.4,
                        marginBottom: 4,
                      }}>
                        {notification.message}
                      </div>
                      <div style={{
                        fontSize: 8,
                        color: 'var(--tn-text-muted)',
                        opacity: 0.7,
                      }}>
                        {formatRelativeTime(notification.timestamp)}
                      </div>
                    </div>

                    {/* Unread indicator */}
                    {!notification.read && (
                      <div style={{
                        width: 6,
                        height: 6,
                        borderRadius: '50%',
                        background: style.color,
                        flexShrink: 0,
                        marginTop: 4,
                      }} />
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
