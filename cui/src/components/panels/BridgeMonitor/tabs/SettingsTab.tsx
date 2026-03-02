import { useState, useEffect, useCallback } from 'react';
import { bridgeJson, StatusBadge, Row, Section, Toolbar, ErrorBanner, LoadingSpinner, SectionFlat } from '../shared';

interface BridgeConfig {
  api_key_required: boolean;
  api_key_source: string;
  version: string;
  load_balancer: string;
  workers: number;
  strategy: string;
  failover: string;
  privacy_enabled: boolean;
  privacy_language: string;
}

interface WorkerConfig {
  worker_id: string;
  status: 'active' | 'paused' | 'error';
  rate_limited: boolean;
  retry_after: number | null;
}

export default function SettingsTab() {
  const [config, setConfig] = useState<BridgeConfig | null>(null);
  const [workers, setWorkers] = useState<WorkerConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [authRes, lbRes, privRes, rlRes] = await Promise.allSettled([
        bridgeJson<{ server_info: { api_key_required: boolean; api_key_source: string; version: string } }>('/v1/auth/status'),
        bridgeJson<{ load_balancer: string; workers: number; strategy: string; failover: string; paused: string[] }>('/lb-status'),
        bridgeJson<{ privacy: { enabled: boolean; language: string } }>('/v1/privacy/status'),
        bridgeJson<{ all_rate_limits: Record<string, { reset_time?: string; retry_after_seconds?: number }> }>('/rate-limits'),
      ]);

      if (authRes.status === 'fulfilled' && lbRes.status === 'fulfilled') {
        const auth = authRes.value.server_info;
        const lb = lbRes.value;
        const priv = privRes.status === 'fulfilled' ? privRes.value.privacy : null;

        setConfig({
          api_key_required: auth.api_key_required,
          api_key_source: auth.api_key_source,
          version: auth.version,
          load_balancer: lb.load_balancer,
          workers: lb.workers,
          strategy: lb.strategy,
          failover: lb.failover,
          privacy_enabled: priv?.enabled ?? false,
          privacy_language: priv?.language ?? 'en',
        });

        // Build workers list
        if (rlRes.status === 'fulfilled') {
          const rateLimits = rlRes.value.all_rate_limits ?? {};
          const pausedSet = new Set(lb.paused ?? []);

          const workerList: WorkerConfig[] = Object.keys(rateLimits).map(workerId => ({
            worker_id: workerId,
            status: pausedSet.has(workerId) ? 'paused' : 'active',
            rate_limited: !!rateLimits[workerId]?.retry_after_seconds,
            retry_after: rateLimits[workerId]?.retry_after_seconds ?? null,
          }));

          setWorkers(workerList);
        }
      } else {
        throw new Error('Failed to load configuration');
      }

      setLastRefresh(new Date());
    } catch (err: any) {
      setError(err.message || 'Failed to load settings');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 30000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  if (loading) return <LoadingSpinner />;
  if (error) return <ErrorBanner message={error} onRetry={fetchAll} />;
  if (!config) return <ErrorBanner message="No configuration data available" onRetry={fetchAll} />;

  return (
    <div data-ai-id="settings-tab-content" style={{ padding: '16px 12px', overflowY: 'auto', height: '100%' }}>
      <Toolbar onRefresh={fetchAll} lastRefresh={lastRefresh} />

      <div data-ai-id="settings-bridge-config">
        <Section title="Bridge Configuration">
        <Row label="Version" value={config.version} />
        <Row label="API Key Required" value={config.api_key_required ? 'Yes' : 'No'} />
        <Row label="API Key Source" value={config.api_key_source} />
        <Row label="Load Balancer" value={config.load_balancer} />
        <Row label="Strategy" value={config.strategy} />
        <Row label="Failover" value={config.failover} />
        </Section>
      </div>

      <div data-ai-id="settings-privacy">
        <Section title="Privacy Settings">
        <Row label="Privacy Enabled" value={config.privacy_enabled ? 'Yes' : 'No'} />
        <Row label="Language" value={config.privacy_language.toUpperCase()} />
        </Section>
      </div>

      <div data-ai-id="settings-workers">
        <SectionFlat title={`Workers (${config.workers} total)`}>
        {workers.length === 0 ? (
          <div style={{
            padding: '24px',
            textAlign: 'center',
            color: 'var(--tn-text-dim)',
            fontSize: 13,
          }}>
            No worker details available
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: 'var(--tn-bg-dark)', textAlign: 'left' }}>
                <th style={{ padding: '8px 12px', fontWeight: 600, color: 'var(--tn-text-dim)' }}>Worker ID</th>
                <th style={{ padding: '8px 12px', fontWeight: 600, color: 'var(--tn-text-dim)' }}>Status</th>
                <th style={{ padding: '8px 12px', fontWeight: 600, color: 'var(--tn-text-dim)' }}>Rate Limited</th>
                <th style={{ padding: '8px 12px', fontWeight: 600, color: 'var(--tn-text-dim)' }}>Retry After</th>
              </tr>
            </thead>
            <tbody>
              {workers.map((w, idx) => (
                <tr
                  key={w.worker_id}
                  style={{
                    background: idx % 2 === 0 ? 'var(--tn-surface)' : 'var(--tn-bg)',
                    borderBottom: '1px solid var(--tn-border)',
                  }}
                >
                  <td style={{ padding: '8px 12px', color: 'var(--tn-text)', fontFamily: 'monospace', fontSize: 11 }}>
                    {w.worker_id}
                  </td>
                  <td style={{ padding: '8px 12px' }}>
                    <StatusBadge
                      status={w.status === 'active' ? 'ok' : w.status === 'paused' ? 'warn' : 'error'}
                      label={w.status}
                    />
                  </td>
                  <td style={{ padding: '8px 12px', color: 'var(--tn-text)' }}>
                    {w.rate_limited ? 'Yes' : 'No'}
                  </td>
                  <td style={{ padding: '8px 12px', color: 'var(--tn-text)', fontFamily: 'monospace' }}>
                    {w.retry_after ? `${w.retry_after}s` : '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        </SectionFlat>
      </div>

      <div style={{ marginTop: 12, padding: 12, background: 'var(--tn-bg-dark)', borderRadius: 4, fontSize: 11, color: 'var(--tn-text-dim)' }}>
        <strong>Note:</strong> Settings are read-only. Configuration changes must be made on the Bridge server.
      </div>
    </div>
  );
}
