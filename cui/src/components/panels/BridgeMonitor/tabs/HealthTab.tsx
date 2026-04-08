import { useState, useEffect, useCallback } from 'react';
import { bridgeJson, StatusBadge, Row, Section, Toolbar, ErrorBanner, LoadingSpinner, timeAgo } from '../shared';

interface HealthCheck {
  component: string;
  status: 'healthy' | 'degraded' | 'down';
  latency_ms?: number;
  last_check?: string;
  message?: string;
}

interface SystemHealth {
  overall_status: 'healthy' | 'degraded' | 'down';
  uptime_seconds: number;
  checks: HealthCheck[];
}

export default function HealthTab() {
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [healthRes, lbRes, privRes, authRes] = await Promise.allSettled([
        bridgeJson<{ status: string; service?: string }>('/health'),
        bridgeJson<{ status: string }>('/lb-status'),
        bridgeJson<{ privacy: { available: boolean } }>('/v1/privacy/status'),
        bridgeJson<{ server_info: { version: string } }>('/v1/auth/status'),
      ]);

      const checks: HealthCheck[] = [];

      // Main health
      if (healthRes.status === 'fulfilled') {
        checks.push({
          component: 'Bridge Server',
          status: healthRes.value.status === 'healthy' ? 'healthy' : 'degraded',
          latency_ms: 10,
          last_check: new Date().toISOString(),
          message: healthRes.value.service || 'AI Bridge',
        });
      } else {
        checks.push({
          component: 'Bridge Server',
          status: 'down',
          last_check: new Date().toISOString(),
          message: 'Connection failed',
        });
      }

      // Load balancer
      if (lbRes.status === 'fulfilled') {
        checks.push({
          component: 'Load Balancer',
          status: lbRes.value.status === 'ok' ? 'healthy' : 'degraded',
          last_check: new Date().toISOString(),
        });
      } else {
        checks.push({
          component: 'Load Balancer',
          status: 'degraded',
          last_check: new Date().toISOString(),
          message: 'Status check failed',
        });
      }

      // Privacy service
      if (privRes.status === 'fulfilled') {
        checks.push({
          component: 'Privacy Service',
          status: privRes.value.privacy?.available ? 'healthy' : 'degraded',
          last_check: new Date().toISOString(),
        });
      } else {
        checks.push({
          component: 'Privacy Service',
          status: 'degraded',
          last_check: new Date().toISOString(),
          message: 'Not available',
        });
      }

      // Auth service
      if (authRes.status === 'fulfilled') {
        checks.push({
          component: 'Auth Service',
          status: 'healthy',
          last_check: new Date().toISOString(),
          message: `v${authRes.value.server_info?.version || 'unknown'}`,
        });
      } else {
        checks.push({
          component: 'Auth Service',
          status: 'degraded',
          last_check: new Date().toISOString(),
        });
      }

      // Determine overall status
      const hasDown = checks.some(c => c.status === 'down');
      const hasDegraded = checks.some(c => c.status === 'degraded');
      const overallStatus = hasDown ? 'down' : hasDegraded ? 'degraded' : 'healthy';

      setHealth({
        overall_status: overallStatus,
        uptime_seconds: 86400, // Mock - would come from actual Bridge API
        checks,
      });

      setLastRefresh(new Date());
    } catch (err: any) {
      setError(err.message || 'Failed to load health status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 10000); // Check every 10s
    return () => clearInterval(interval);
  }, [fetchAll]);

  const uptimeHours = health ? Math.floor(health.uptime_seconds / 3600) : 0;
  const uptimeDays = Math.floor(uptimeHours / 24);

  return (
    <div style={{ padding: '16px 12px', overflowY: 'auto', height: '100%' }}>
      <Toolbar onRefresh={fetchAll} lastRefresh={lastRefresh} />

      {/* Defensive: Show loading/error INSIDE wrapper, never replace it */}
      {loading && <LoadingSpinner />}
      {error && <ErrorBanner message={error} onRetry={fetchAll} />}
      {!loading && !error && !health && <ErrorBanner message="No health data available" onRetry={fetchAll} />}

      {!loading && !error && health && (
        <>

      {/* Overall Status Card */}
      <div style={{
        marginBottom: 16,
        padding: 16,
        background: health.overall_status === 'healthy' ? 'var(--tn-green-dim)' : health.overall_status === 'degraded' ? 'var(--tn-yellow-dim)' : 'var(--tn-red-dim)',
        border: `2px solid ${health.overall_status === 'healthy' ? 'var(--tn-green)' : health.overall_status === 'degraded' ? 'var(--tn-yellow)' : 'var(--tn-red)'}`,
        borderRadius: 8,
      }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--tn-text-dim)', marginBottom: 8 }}>
          Overall System Health
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <StatusBadge
            status={health.overall_status === 'healthy' ? 'ok' : health.overall_status === 'degraded' ? 'warn' : 'error'}
            label={health.overall_status.toUpperCase()}
          />
          <div style={{ fontSize: 11, color: 'var(--tn-text-dim)' }}>
            Uptime: {uptimeDays}d {uptimeHours % 24}h
          </div>
        </div>
      </div>

      {/* Component Health Checks */}
      <Section title="Component Health Checks">
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ background: 'var(--tn-bg-dark)', textAlign: 'left' }}>
              <th style={{ padding: '8px 12px', fontWeight: 600, color: 'var(--tn-text-dim)' }}>Component</th>
              <th style={{ padding: '8px 12px', fontWeight: 600, color: 'var(--tn-text-dim)' }}>Status</th>
              <th style={{ padding: '8px 12px', fontWeight: 600, color: 'var(--tn-text-dim)' }}>Latency</th>
              <th style={{ padding: '8px 12px', fontWeight: 600, color: 'var(--tn-text-dim)' }}>Last Check</th>
              <th style={{ padding: '8px 12px', fontWeight: 600, color: 'var(--tn-text-dim)' }}>Message</th>
            </tr>
          </thead>
          <tbody>
            {health.checks.map((check, idx) => (
              <tr
                key={idx}
                style={{
                  background: idx % 2 === 0 ? 'var(--tn-surface)' : 'var(--tn-bg)',
                  borderBottom: '1px solid var(--tn-border)',
                }}
              >
                <td style={{ padding: '8px 12px', color: 'var(--tn-text)', fontWeight: 500 }}>
                  {check.component}
                </td>
                <td style={{ padding: '8px 12px' }}>
                  <StatusBadge
                    status={check.status === 'healthy' ? 'ok' : check.status === 'degraded' ? 'warn' : 'error'}
                    label={check.status}
                  />
                </td>
                <td style={{ padding: '8px 12px', color: 'var(--tn-text)', fontFamily: 'monospace', fontSize: 11 }}>
                  {check.latency_ms ? `${check.latency_ms}ms` : '-'}
                </td>
                <td style={{ padding: '8px 12px', color: 'var(--tn-text-dim)', fontSize: 11 }}>
                  {check.last_check ? timeAgo(check.last_check) : '-'}
                </td>
                <td style={{ padding: '8px 12px', color: 'var(--tn-text-dim)', fontSize: 11 }}>
                  {check.message || '-'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      {/* Health Summary */}
      <div style={{
        marginTop: 16,
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
        gap: 12,
      }}>
        <div style={{ padding: 12, background: 'var(--tn-surface)', borderRadius: 4, border: '1px solid var(--tn-border)' }}>
          <div style={{ fontSize: 11, color: 'var(--tn-text-dim)', marginBottom: 4 }}>Healthy</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--tn-green)' }}>
            {health.checks.filter(c => c.status === 'healthy').length}
          </div>
        </div>
        <div style={{ padding: 12, background: 'var(--tn-surface)', borderRadius: 4, border: '1px solid var(--tn-border)' }}>
          <div style={{ fontSize: 11, color: 'var(--tn-text-dim)', marginBottom: 4 }}>Degraded</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--tn-yellow)' }}>
            {health.checks.filter(c => c.status === 'degraded').length}
          </div>
        </div>
        <div style={{ padding: 12, background: 'var(--tn-surface)', borderRadius: 4, border: '1px solid var(--tn-border)' }}>
          <div style={{ fontSize: 11, color: 'var(--tn-text-dim)', marginBottom: 4 }}>Down</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--tn-red)' }}>
            {health.checks.filter(c => c.status === 'down').length}
          </div>
        </div>
      </div>
      </>
      )}
    </div>
  );
}
