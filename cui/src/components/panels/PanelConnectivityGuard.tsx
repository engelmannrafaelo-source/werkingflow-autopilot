import { useState, useEffect, ReactNode } from 'react';

interface PanelConnectivityGuardProps {
  children: ReactNode;
  panelName: string;
  checkUrl: string;
  port: number;
  startCommand: string;
}

export default function PanelConnectivityGuard({
  children,
  panelName,
  checkUrl,
  port,
  startCommand
}: PanelConnectivityGuardProps) {
  const [isOnline, setIsOnline] = useState<boolean | null>(null); // null = checking
  const [lastCheck, setLastCheck] = useState<Date>(new Date());

  useEffect(() => {
    let cancelled = false;

    const checkConnectivity = async () => {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);

        const response = await fetch(checkUrl, {
          method: 'HEAD',
          signal: controller.signal,
          cache: 'no-store'
        });

        clearTimeout(timeoutId);

        if (!cancelled) {
          setIsOnline(response.ok);
          setLastCheck(new Date());
        }
      } catch (err) {
        if (!cancelled) {
          setIsOnline(false);
          setLastCheck(new Date());
        }
      }
    };

    // Initial check
    checkConnectivity();

    // Re-check every 10 seconds
    const interval = setInterval(checkConnectivity, 10000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [checkUrl]);

  // Loading state
  if (isOnline === null) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        background: 'var(--tn-bg)',
        color: 'var(--tn-text-muted)',
        flexDirection: 'column',
        gap: 12
      }}>
        <div style={{ fontSize: 14 }}>Checking {panelName} connectivity...</div>
        <div style={{ fontSize: 11, opacity: 0.6 }}>Port {port}</div>
      </div>
    );
  }

  // Offline state - BLOCKED with clear error
  if (!isOnline) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        background: 'var(--tn-bg)',
        flexDirection: 'column',
        gap: 16,
        padding: 40
      }}>
        <div style={{
          fontSize: 48,
          color: '#EF4444',
          marginBottom: 8
        }}>⚠</div>

        <div style={{
          fontSize: 16,
          fontWeight: 600,
          color: 'var(--tn-text)',
          textAlign: 'center'
        }}>
          {panelName} Backend Offline
        </div>

        <div style={{
          fontSize: 12,
          color: 'var(--tn-text-muted)',
          textAlign: 'center',
          maxWidth: 400,
          lineHeight: 1.5
        }}>
          The {panelName} backend service is not running on port {port}.
          This panel cannot display data without an active backend connection.
        </div>

        <div style={{
          background: 'var(--tn-surface)',
          border: '1px solid var(--tn-border)',
          borderRadius: 8,
          padding: 16,
          marginTop: 8,
          maxWidth: 500,
          width: '100%'
        }}>
          <div style={{
            fontSize: 11,
            color: 'var(--tn-text-muted)',
            marginBottom: 8,
            textTransform: 'uppercase',
            letterSpacing: 1
          }}>
            Start Backend:
          </div>
          <div style={{
            fontFamily: 'monospace',
            fontSize: 11,
            background: 'var(--tn-bg-dark)',
            padding: 12,
            borderRadius: 4,
            color: 'var(--tn-text)',
            overflowX: 'auto',
            whiteSpace: 'pre'
          }}>
            {startCommand}
          </div>
        </div>

        <button
          onClick={() => {
            setIsOnline(null);
            setLastCheck(new Date());
          }}
          style={{
            marginTop: 16,
            padding: '8px 20px',
            background: 'var(--tn-blue)',
            color: 'white',
            border: 'none',
            borderRadius: 6,
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer'
          }}
        >
          Retry Connection
        </button>

        <div style={{
          fontSize: 10,
          color: 'var(--tn-text-muted)',
          marginTop: 16,
          opacity: 0.6
        }}>
          Last check: {lastCheck.toLocaleTimeString()}
        </div>
      </div>
    );
  }

  // Online - render children
  return <>{children}</>;
}
