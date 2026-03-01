import { useState, useEffect } from 'react';

const API = '/api';

interface AppStatus {
  name: string;
  port: number;
  test_port: number | null;
  status: 'up' | 'down' | 'degraded' | 'restarting';
  test_status: 'up' | 'down' | 'degraded' | 'restarting' | null;
  http_code: number | null;
  test_http_code: number | null;
  restart_count: number;
  test_restart_count: number;
  pid: number | null;
  test_pid: number | null;
  user_scripts?: {
    start?: string;
    build?: string;
  };
  test_scripts?: {
    start?: string;
    build?: string;
  };
}

interface WatchdogStatus {
  started_at: string;
  last_check: string;
  apps: Record<string, AppStatus>;
}

function getStatusIcon(status: string | null, httpCode: number | null): string {
  if (status === 'up' && httpCode === 200) return '🟢';
  if (status === 'degraded') return '🟡';
  if (status === 'restarting') return '🔄';
  if (status === 'down') return '🔴';
  return '⚫';
}

function formatUptime(startedAt: string): string {
  const diff = Date.now() - new Date(startedAt).getTime();
  const hours = Math.floor(diff / 3600000);
  const mins = Math.floor((diff % 3600000) / 60000);
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

export default function InfrastructurePanel() {
  const [status, setStatus] = useState<WatchdogStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 5000); // Poll every 5s
    return () => clearInterval(interval);
  }, []);

  async function fetchStatus() {
    try {
      const res = await fetch(`${API}/infrastructure/status`);
      if (!res.ok) throw new Error(`Watchdog unavailable (${res.status})`);
      const data = await res.json();
      setStatus(data);
      setError(null);
      setLoading(false);
    } catch (err: any) {
      setError(err.message);
      setLoading(false);
    }
  }

  async function handleRestart(appId: string, portType: 'user' | 'test') {
    const key = `${appId}-${portType}`;
    setRestarting(prev => new Set(prev).add(key));

    try {
      const endpoint = portType === 'user'
        ? `${API}/infrastructure/app/${appId}/restart`
        : `${API}/infrastructure/app/${appId}/test/restart`;

      const res = await fetch(endpoint, { method: 'POST' });
      if (!res.ok) throw new Error(`Restart failed (${res.status})`);

      // Keep restarting indicator for 3s
      setTimeout(() => {
        setRestarting(prev => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }, 3000);

      // Force immediate status refresh
      setTimeout(fetchStatus, 1000);
    } catch (err: any) {
      console.error('Restart failed:', err);
      setRestarting(prev => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }

  if (loading) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        color: 'var(--tn-text-muted)',
        fontSize: 12
      }}>
        Loading infrastructure status...
      </div>
    );
  }

  if (error || !status) {
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        gap: '1rem',
        padding: '1rem'
      }}>
        <div style={{ color: 'var(--tn-red)', fontSize: 14 }}>
          Error: {error || 'No status data'}
        </div>
        <button
          onClick={fetchStatus}
          style={{
            padding: '6px 12px',
            background: 'var(--tn-blue)',
            color: 'white',
            border: 'none',
            borderRadius: 4,
            cursor: 'pointer',
            fontSize: 12
          }}
        >
          Retry
        </button>
      </div>
    );
  }

  // Filter to only show dual-port apps
  const dualPortApps = Object.entries(status.apps)
    .filter(([_, app]) => app.test_port !== null)
    .sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className="infrastructure-panel" style={{
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      background: 'var(--tn-bg)',
      overflow: 'hidden'
    }}>
      {/* Header */}
      <div style={{
        padding: '12px 16px',
        borderBottom: '1px solid var(--tn-border)',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        background: 'var(--tn-surface)'
      }}>
        <div>
          <h3 style={{
            margin: 0,
            fontSize: 14,
            fontWeight: 600,
            color: 'var(--tn-text)'
          }}>
            Infrastructure Monitoring
          </h3>
          <div style={{
            fontSize: 10,
            color: 'var(--tn-text-muted)',
            marginTop: 2
          }}>
            Uptime: {formatUptime(status.started_at)} • Last check: {new Date(status.last_check).toLocaleTimeString()}
          </div>
        </div>
        <button
          onClick={fetchStatus}
          style={{
            padding: '4px 8px',
            background: 'var(--tn-surface-alt)',
            color: 'var(--tn-text-muted)',
            border: '1px solid var(--tn-border)',
            borderRadius: 4,
            cursor: 'pointer',
            fontSize: 11,
            fontWeight: 500
          }}
        >
          ↻ Refresh
        </button>
      </div>

      {/* Table */}
      <div style={{
        flex: 1,
        overflow: 'auto',
        padding: '16px'
      }}>
        <table style={{
          width: '100%',
          borderCollapse: 'collapse',
          fontSize: 12
        }}>
          <thead>
            <tr style={{
              borderBottom: '2px solid var(--tn-border)',
              background: 'var(--tn-surface-alt)'
            }}>
              <th style={{
                padding: '8px 12px',
                textAlign: 'left',
                fontWeight: 600,
                color: 'var(--tn-text)',
                fontSize: 11
              }}>
                App
              </th>
              <th style={{
                padding: '8px 12px',
                textAlign: 'left',
                fontWeight: 600,
                color: 'var(--tn-text)',
                fontSize: 11,
                minWidth: 120
              }}>
                User Port
              </th>
              <th style={{
                padding: '8px 12px',
                textAlign: 'left',
                fontWeight: 600,
                color: 'var(--tn-text)',
                fontSize: 11,
                minWidth: 120
              }}>
                Test Port
              </th>
              <th style={{
                padding: '8px 12px',
                textAlign: 'center',
                fontWeight: 600,
                color: 'var(--tn-text)',
                fontSize: 11,
                minWidth: 140
              }}>
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {dualPortApps.map(([id, app]) => {
              const userRestartKey = `${id}-user`;
              const testRestartKey = `${id}-test`;
              const isUserRestarting = restarting.has(userRestartKey) || app.status === 'restarting';
              const isTestRestarting = restarting.has(testRestartKey) || app.test_status === 'restarting';

              return (
                <tr
                  key={id}
                  style={{
                    borderBottom: '1px solid var(--tn-border)',
                    transition: 'background 0.2s ease'
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
                      fontWeight: 600,
                      color: 'var(--tn-text)',
                      marginBottom: 2
                    }}>
                      {app.name}
                    </div>
                    <div style={{
                      fontSize: 10,
                      color: 'var(--tn-text-muted)',
                      fontFamily: 'monospace'
                    }}>
                      {id}
                    </div>
                  </td>
                  <td style={{ padding: '12px' }}>
                    <div style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      marginBottom: 4
                    }}>
                      <span style={{ fontSize: 14 }}>
                        {getStatusIcon(app.status, app.http_code)}
                      </span>
                      <span style={{
                        fontWeight: 500,
                        color: 'var(--tn-text)'
                      }}>
                        {app.port}
                      </span>
                      {app.http_code && (
                        <span style={{
                          fontSize: 10,
                          color: app.http_code === 200 ? 'var(--tn-green)' : 'var(--tn-red)',
                          fontFamily: 'monospace'
                        }}>
                          ({app.http_code})
                        </span>
                      )}
                    </div>
                    <div style={{
                      fontSize: 10,
                      color: 'var(--tn-text-muted)'
                    }}>
                      ↻ {app.restart_count} restarts
                      {app.pid && (
                        <span style={{ marginLeft: 8 }}>
                          PID: {app.pid}
                        </span>
                      )}
                    </div>
                  </td>
                  <td style={{ padding: '12px' }}>
                    {app.test_port && (
                      <>
                        <div style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          marginBottom: 4
                        }}>
                          <span style={{ fontSize: 14 }}>
                            {getStatusIcon(app.test_status, app.test_http_code)}
                          </span>
                          <span style={{
                            fontWeight: 500,
                            color: 'var(--tn-text)'
                          }}>
                            {app.test_port}
                          </span>
                          {app.test_http_code && (
                            <span style={{
                              fontSize: 10,
                              color: app.test_http_code === 200 ? 'var(--tn-green)' : 'var(--tn-red)',
                              fontFamily: 'monospace'
                            }}>
                              ({app.test_http_code})
                            </span>
                          )}
                        </div>
                        <div style={{
                          fontSize: 10,
                          color: 'var(--tn-text-muted)'
                        }}>
                          ↻ {app.test_restart_count} restarts
                          {app.test_pid && (
                            <span style={{ marginLeft: 8 }}>
                              PID: {app.test_pid}
                            </span>
                          )}
                        </div>
                      </>
                    )}
                  </td>
                  <td style={{ padding: '12px' }}>
                    <div style={{
                      display: 'flex',
                      gap: 6,
                      justifyContent: 'center',
                      flexWrap: 'wrap'
                    }}>
                      <button
                        onClick={() => handleRestart(id, 'user')}
                        disabled={isUserRestarting}
                        style={{
                          padding: '4px 8px',
                          background: isUserRestarting ? 'var(--tn-surface-alt)' : 'var(--tn-blue)',
                          color: isUserRestarting ? 'var(--tn-text-muted)' : 'white',
                          border: 'none',
                          borderRadius: 3,
                          cursor: isUserRestarting ? 'not-allowed' : 'pointer',
                          fontSize: 10,
                          fontWeight: 600,
                          opacity: isUserRestarting ? 0.6 : 1
                        }}
                        title="Restart user port"
                      >
                        {isUserRestarting ? '⏳ User' : '⟳ User'}
                      </button>
                      <button
                        onClick={() => handleRestart(id, 'test')}
                        disabled={isTestRestarting}
                        style={{
                          padding: '4px 8px',
                          background: isTestRestarting ? 'var(--tn-surface-alt)' : 'var(--tn-orange)',
                          color: isTestRestarting ? 'var(--tn-text-muted)' : 'white',
                          border: 'none',
                          borderRadius: 3,
                          cursor: isTestRestarting ? 'not-allowed' : 'pointer',
                          fontSize: 10,
                          fontWeight: 600,
                          opacity: isTestRestarting ? 0.6 : 1
                        }}
                        title="Restart test port"
                      >
                        {isTestRestarting ? '⏳ Test' : '⟳ Test'}
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {dualPortApps.length === 0 && (
          <div style={{
            textAlign: 'center',
            padding: '40px 20px',
            color: 'var(--tn-text-muted)',
            fontSize: 12
          }}>
            No dual-port apps found
          </div>
        )}
      </div>

      {/* Footer / Legend */}
      <div style={{
        padding: '8px 16px',
        borderTop: '1px solid var(--tn-border)',
        fontSize: 10,
        color: 'var(--tn-text-muted)',
        background: 'var(--tn-surface)'
      }}>
        Legend: 🟢 UP (200) • 🟡 DEGRADED • 🔄 RESTARTING • 🔴 DOWN • ⚫ UNKNOWN
      </div>
    </div>
  );
}
