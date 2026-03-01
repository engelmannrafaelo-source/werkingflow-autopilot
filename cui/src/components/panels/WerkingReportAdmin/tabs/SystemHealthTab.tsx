import { useState, useEffect, useCallback, useRef } from 'react';

interface ServiceHealth {
  name: string;
  url: string;
  status: 'ok' | 'error' | 'timeout';
  statusCode?: number;
  latencyMs?: number;
  error?: string;
}

interface SystemHealthResponse {
  ok: boolean;
  checkedAt: string;
  errorCount: number;
  services: ServiceHealth[];
}

interface HealthHistory {
  timestamp: string;
  ok: boolean;
  latencyMs?: number;
}

const HISTORY_KEY = 'cui-system-health-history';
const MAX_HISTORY = 10;
const AUTO_REFRESH_INTERVAL = 30000; // 30 seconds

export default function SystemHealthTab({ envMode }: { envMode?: string }) {
  const [health, setHealth] = useState<SystemHealthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lastCheck, setLastCheck] = useState<Date | null>(null);
  const [history, setHistory] = useState<Map<string, HealthHistory[]>>(new Map());
  const [selectedService, setSelectedService] = useState<string | null>(null);
  const autoRefreshTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load history from localStorage
  useEffect(() => {
    try {
      const stored = localStorage.getItem(HISTORY_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        setHistory(new Map(Object.entries(parsed)));
      }
    } catch (err) {
      console.error('Failed to load health history:', err);
    }
  }, []);

  // Save history to localStorage
  const saveHistory = useCallback((serviceName: string, entry: HealthHistory) => {
    setHistory((prev) => {
      const newHistory = new Map(prev);
      const serviceHistory = newHistory.get(serviceName) || [];
      serviceHistory.unshift(entry);
      if (serviceHistory.length > MAX_HISTORY) serviceHistory.pop();
      newHistory.set(serviceName, serviceHistory);

      // Persist to localStorage
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(Object.fromEntries(newHistory)));
      } catch (err) {
        console.error('Failed to save health history:', err);
      }

      return newHistory;
    });
  }, []);

  const fetchHealth = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/admin/wr/system-health');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: SystemHealthResponse = await res.json();
      setHealth(data);
      setLastCheck(new Date());

      // Save each service's result to history
      data.services.forEach((svc) => {
        saveHistory(svc.name, {
          timestamp: data.checkedAt,
          ok: svc.status === 'ok',
          latencyMs: svc.latencyMs,
        });
      });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [saveHistory]);

  // Auto-refresh on mount and when envMode changes
  useEffect(() => {
    fetchHealth();
  }, [fetchHealth, envMode]);

  // Auto-refresh every 30 seconds
  useEffect(() => {
    if (autoRefreshTimer.current) clearInterval(autoRefreshTimer.current);
    autoRefreshTimer.current = setInterval(() => {
      fetchHealth();
    }, AUTO_REFRESH_INTERVAL);

    return () => {
      if (autoRefreshTimer.current) clearInterval(autoRefreshTimer.current);
    };
  }, [fetchHealth]);

  const statusIcon = (status: 'ok' | 'error' | 'timeout') => {
    const icons = { ok: '🟢', error: '🔴', timeout: '🟡' };
    return icons[status];
  };

  const statusColor = (status: 'ok' | 'error' | 'timeout') => {
    const colors = { ok: 'var(--tn-green)', error: 'var(--tn-red)', timeout: 'var(--tn-orange)' };
    return colors[status];
  };

  const calculateUptime = (serviceName: string): string => {
    const serviceHistory = history.get(serviceName) || [];
    if (serviceHistory.length === 0) return '—';
    const okCount = serviceHistory.filter((h) => h.ok).length;
    const pct = (okCount / serviceHistory.length) * 100;
    return `${pct.toFixed(1)}%`;
  };

  const getAverageLatency = (serviceName: string): string => {
    const serviceHistory = history.get(serviceName) || [];
    const withLatency = serviceHistory.filter((h) => h.latencyMs != null);
    if (withLatency.length === 0) return '—';
    const avg = withLatency.reduce((sum, h) => sum + (h.latencyMs || 0), 0) / withLatency.length;
    return `${avg.toFixed(0)}ms`;
  };

  const serviceCard = (svc: ServiceHealth) => (
    <div
      key={svc.name}
      onClick={() => setSelectedService(svc.name)}
      style={{
        background: 'var(--tn-bg-dark)',
        border: `2px solid ${statusColor(svc.status)}`,
        borderRadius: 8,
        padding: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        cursor: 'pointer',
        transition: 'transform 0.15s, box-shadow 0.15s',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = 'translateY(-2px)';
        e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,0,0,0.2)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = 'translateY(0)';
        e.currentTarget.style.boxShadow = 'none';
      }}
    >
      {/* Service Name + Status */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 16 }}>{statusIcon(svc.status)}</span>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--tn-text)' }}>{svc.name}</span>
        </div>
        <span
          style={{
            fontSize: 9,
            fontWeight: 700,
            textTransform: 'uppercase',
            padding: '2px 6px',
            borderRadius: 3,
            background: svc.status === 'ok' ? 'rgba(158,206,106,0.15)' : 'rgba(247,118,142,0.15)',
            color: statusColor(svc.status),
          }}
        >
          {svc.status}
        </span>
      </div>

      {/* URL */}
      <div
        style={{
          fontSize: 9,
          fontFamily: 'monospace',
          color: 'var(--tn-text-muted)',
          wordBreak: 'break-all',
        }}
      >
        {svc.url.replace('https://', '').replace('http://', '')}
      </div>

      {/* Metrics */}
      <div style={{ display: 'flex', gap: 12, fontSize: 10 }}>
        <div style={{ flex: 1 }}>
          <div style={{ color: 'var(--tn-text-muted)', marginBottom: 2 }}>Response</div>
          <div style={{ fontWeight: 700, color: 'var(--tn-text)' }}>
            {svc.latencyMs != null ? `${svc.latencyMs}ms` : '—'}
          </div>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ color: 'var(--tn-text-muted)', marginBottom: 2 }}>Avg (10)</div>
          <div style={{ fontWeight: 700, color: 'var(--tn-text)' }}>{getAverageLatency(svc.name)}</div>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ color: 'var(--tn-text-muted)', marginBottom: 2 }}>Uptime</div>
          <div style={{ fontWeight: 700, color: 'var(--tn-text)' }}>{calculateUptime(svc.name)}</div>
        </div>
      </div>

      {/* Error Message */}
      {svc.error && (
        <div
          style={{
            fontSize: 9,
            color: 'var(--tn-red)',
            background: 'rgba(247,118,142,0.1)',
            padding: '4px 6px',
            borderRadius: 3,
            fontFamily: 'monospace',
          }}
        >
          {svc.error}
        </div>
      )}

      {/* Status Code */}
      {svc.statusCode && (
        <div style={{ fontSize: 9, color: 'var(--tn-text-muted)' }}>
          HTTP {svc.statusCode}
        </div>
      )}
    </div>
  );

  return (
    <div data-ai-id="wr-system-health-tab" style={{ padding: 12 }}>
      {/* Header + Actions */}
      <div
        data-ai-id="wr-system-health-header"
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 12,
        }}
      >
        <div>
          <div data-ai-id="wr-system-health-title" style={{ fontSize: 12, fontWeight: 700, color: 'var(--tn-text)' }}>
            System Health Monitor
          </div>
          {lastCheck && (
            <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', marginTop: 2 }}>
              Last checked: {lastCheck.toLocaleTimeString()} (auto-refresh every 30s)
            </div>
          )}
        </div>
        <button
          data-ai-id="wr-system-health-check-btn"
          onClick={fetchHealth}
          disabled={loading}
          style={{
            padding: '4px 12px',
            borderRadius: 4,
            fontSize: 10,
            fontWeight: 600,
            cursor: loading ? 'not-allowed' : 'pointer',
            background: 'var(--tn-blue)',
            border: 'none',
            color: '#fff',
            opacity: loading ? 0.5 : 1,
          }}
        >
          {loading ? 'Checking...' : 'Check Now'}
        </button>
      </div>

      {/* Error Alert */}
      {error && (
        <div
          data-ai-id="wr-system-health-error"
          style={{
            padding: '6px 10px',
            fontSize: 11,
            color: 'var(--tn-red)',
            background: 'rgba(247,118,142,0.1)',
            borderRadius: 4,
            marginBottom: 12,
          }}
        >
          ⚠️ {error}
        </div>
      )}

      {/* Overall Status */}
      {health && (
        <div
          data-ai-id="wr-system-health-overall"
          data-status={health.ok ? 'ok' : 'error'}
          style={{
            padding: 12,
            background: health.ok ? 'rgba(158,206,106,0.1)' : 'rgba(247,118,142,0.1)',
            border: `2px solid ${health.ok ? 'var(--tn-green)' : 'var(--tn-red)'}`,
            borderRadius: 8,
            marginBottom: 16,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 20 }}>{health.ok ? '✅' : '❌'}</span>
            <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--tn-text)' }}>
              {health.ok ? 'All Systems Operational' : `${health.errorCount} Service(s) Down`}
            </span>
          </div>
          <div style={{ fontSize: 9, color: 'var(--tn-text-muted)' }}>
            {health.services.length} services monitored
          </div>
        </div>
      )}

      {/* Service Grid */}
      {!loading && health && (
        <div
          data-ai-id="wr-system-health-services"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
            gap: 12,
          }}
        >
          {health.services.map(serviceCard)}
        </div>
      )}

      {/* Loading State */}
      {loading && !health && (
        <div
          data-ai-id="wr-system-health-loading"
          style={{
            padding: 40,
            textAlign: 'center',
            color: 'var(--tn-text-muted)',
            fontSize: 12,
          }}
        >
          Loading system health...
        </div>
      )}

      {/* Service Detail Modal */}
      {selectedService && health && (() => {
        const service = health.services.find((s) => s.name === selectedService);
        if (!service) return null;

        const serviceHistory = history.get(selectedService) || [];
        const uptime = calculateUptime(selectedService);
        const avgLatency = getAverageLatency(selectedService);

        return (
          <div
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              background: 'rgba(0,0,0,0.7)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 9999,
            }}
            onClick={() => setSelectedService(null)}
          >
            <div
              style={{
                background: 'var(--tn-surface)',
                border: `3px solid ${statusColor(service.status)}`,
                borderRadius: 12,
                width: '90%',
                maxWidth: 700,
                maxHeight: '80vh',
                overflow: 'auto',
                boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
              }}
              onClick={(e) => e.stopPropagation()}
            >
              {/* Modal Header */}
              <div
                style={{
                  padding: 16,
                  borderBottom: '2px solid var(--tn-border)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  background: 'var(--tn-bg-dark)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 20 }}>{statusIcon(service.status)}</span>
                  <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--tn-text)' }}>
                    {service.name}
                  </span>
                </div>
                <button
                  onClick={() => setSelectedService(null)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--tn-text-muted)',
                    fontSize: 20,
                    cursor: 'pointer',
                    padding: '0 8px',
                  }}
                >
                  ✕
                </button>
              </div>

              {/* Modal Body */}
              <div style={{ padding: 16 }}>
                {/* Current Status Section */}
                <div style={{ marginBottom: 20 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--tn-text)', marginBottom: 8 }}>
                    Current Status
                  </div>
                  <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                    <div style={{ flex: 1, minWidth: 150 }}>
                      <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', marginBottom: 4 }}>
                        Status
                      </div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: statusColor(service.status) }}>
                        {service.status.toUpperCase()}
                      </div>
                    </div>
                    <div style={{ flex: 1, minWidth: 150 }}>
                      <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', marginBottom: 4 }}>
                        Response Time
                      </div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--tn-text)' }}>
                        {service.latencyMs != null ? `${service.latencyMs}ms` : '—'}
                      </div>
                    </div>
                    {service.statusCode && (
                      <div style={{ flex: 1, minWidth: 150 }}>
                        <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', marginBottom: 4 }}>
                          HTTP Status
                        </div>
                        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--tn-text)' }}>
                          {service.statusCode}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Error Message */}
                  {service.error && (
                    <div
                      style={{
                        marginTop: 8,
                        padding: '8px 10px',
                        background: 'rgba(247,118,142,0.1)',
                        border: '1px solid var(--tn-red)',
                        borderRadius: 4,
                        fontSize: 10,
                        color: 'var(--tn-red)',
                        fontFamily: 'monospace',
                      }}
                    >
                      <strong>Error:</strong> {service.error}
                    </div>
                  )}

                  {/* URL */}
                  <div style={{ marginTop: 8 }}>
                    <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', marginBottom: 4 }}>
                      Endpoint
                    </div>
                    <div
                      style={{
                        fontSize: 10,
                        fontFamily: 'monospace',
                        color: 'var(--tn-blue)',
                        background: 'rgba(122,162,247,0.1)',
                        padding: '4px 8px',
                        borderRadius: 3,
                        wordBreak: 'break-all',
                      }}
                    >
                      {service.url}
                    </div>
                  </div>
                </div>

                {/* Metrics Section */}
                <div style={{ marginBottom: 20 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--tn-text)', marginBottom: 8 }}>
                    Metrics (Last 10 Checks)
                  </div>
                  <div style={{ display: 'flex', gap: 16 }}>
                    <div
                      style={{
                        flex: 1,
                        background: 'var(--tn-bg-dark)',
                        padding: 12,
                        borderRadius: 6,
                        border: '1px solid var(--tn-border)',
                      }}
                    >
                      <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', marginBottom: 4 }}>
                        Uptime
                      </div>
                      <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--tn-green)' }}>
                        {uptime}
                      </div>
                    </div>
                    <div
                      style={{
                        flex: 1,
                        background: 'var(--tn-bg-dark)',
                        padding: 12,
                        borderRadius: 6,
                        border: '1px solid var(--tn-border)',
                      }}
                    >
                      <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', marginBottom: 4 }}>
                        Avg Latency
                      </div>
                      <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--tn-blue)' }}>
                        {avgLatency}
                      </div>
                    </div>
                  </div>
                </div>

                {/* History Section */}
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--tn-text)', marginBottom: 8 }}>
                    Health Check History
                  </div>
                  {serviceHistory.length === 0 ? (
                    <div
                      style={{
                        padding: 16,
                        textAlign: 'center',
                        color: 'var(--tn-text-muted)',
                        fontSize: 11,
                      }}
                    >
                      No history available yet
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {serviceHistory.map((entry, idx) => (
                        <div
                          key={idx}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            padding: '6px 10px',
                            background: entry.ok ? 'rgba(158,206,106,0.05)' : 'rgba(247,118,142,0.05)',
                            border: `1px solid ${entry.ok ? 'rgba(158,206,106,0.2)' : 'rgba(247,118,142,0.2)'}`,
                            borderRadius: 4,
                            fontSize: 10,
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span>{entry.ok ? '🟢' : '🔴'}</span>
                            <span style={{ fontFamily: 'monospace', color: 'var(--tn-text-muted)' }}>
                              {new Date(entry.timestamp).toLocaleString()}
                            </span>
                          </div>
                          <div style={{ fontWeight: 600, color: 'var(--tn-text)' }}>
                            {entry.latencyMs != null ? `${entry.latencyMs}ms` : '—'}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
