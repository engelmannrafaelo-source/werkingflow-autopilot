import { useState, useEffect, useCallback, useRef } from 'react';

interface ServiceHealth {
  name: string;
  url: string;
  status: 'ok' | 'error' | 'timeout';
  statusCode?: number;
  latencyMs?: number;
  error?: string;
}

interface HealthData {
  ok: boolean;
  checkedAt: string;
  errorCount: number;
  services: ServiceHealth[];
}

interface DeploymentInfo {
  name: string;
  state: string;
  url?: string;
  commitSha?: string;
  commitMessage?: string;
  ageMin?: number;
}

interface DeploymentsData {
  deployments: DeploymentInfo[];
  checkedAt: string;
}

const STATUS_COLOR = {
  ok: 'var(--tn-green)',
  error: 'var(--tn-red)',
  timeout: 'var(--tn-orange)',
  READY: 'var(--tn-green)',
  BUILDING: 'var(--tn-orange)',
  ERROR: 'var(--tn-red)',
  QUEUED: 'var(--tn-text-muted)',
  CANCELED: 'var(--tn-text-muted)',
};

const STATUS_DOT = ({ status }: { status: string }) => {
  const color = STATUS_COLOR[status as keyof typeof STATUS_COLOR] ?? 'var(--tn-text-muted)';
  const isOk = status === 'ok' || status === 'READY';
  return (
    <span style={{
      display: 'inline-block',
      width: 7,
      height: 7,
      borderRadius: '50%',
      background: color,
      boxShadow: isOk ? `0 0 4px ${color}` : undefined,
      flexShrink: 0,
    }} />
  );
};

export default function SystemHealth() {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [deployments, setDeployments] = useState<DeploymentsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchAll = useCallback(async () => {
    setError('');
    try {
      const [hRes, dRes] = await Promise.all([
        fetch('/api/admin/wr/system-health'),
        fetch('/api/ops/deployments'),
      ]);
      if (hRes.ok) setHealth(await hRes.json());
      else setError(`Health: HTTP ${hRes.status}`);
      if (dRes.ok) setDeployments(await dRes.json());
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  useEffect(() => {
    if (autoRefresh) {
      intervalRef.current = setInterval(fetchAll, 30000); // every 30s
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [autoRefresh, fetchAll]);

  const sectionHeader = (title: string) => (
    <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--tn-text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 6, marginTop: 14 }}>
      {title}
    </div>
  );

  return (
    <div style={{ padding: 12, height: '100%', overflowY: 'auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {health && (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: '2px 8px', borderRadius: 10, fontSize: 10, fontWeight: 600,
              background: health.ok ? 'rgba(158,206,106,0.15)' : 'rgba(247,118,142,0.15)',
              color: health.ok ? 'var(--tn-green)' : 'var(--tn-red)',
            }}>
              <STATUS_DOT status={health.ok ? 'ok' : 'error'} />
              {health.ok ? 'ALL SYSTEMS OK' : `${health.errorCount} SERVICE${health.errorCount > 1 ? 'S' : ''} DOWN`}
            </span>
          )}
        </div>
        <div style={{ flex: 1 }} />
        <button
          onClick={() => setAutoRefresh(a => !a)}
          style={{
            padding: '2px 8px', borderRadius: 3, fontSize: 9, cursor: 'pointer',
            background: autoRefresh ? 'rgba(122,162,247,0.15)' : 'var(--tn-bg)',
            border: `1px solid ${autoRefresh ? 'var(--tn-blue)' : 'var(--tn-border)'}`,
            color: autoRefresh ? 'var(--tn-blue)' : 'var(--tn-text-muted)',
          }}
        >
          {autoRefresh ? 'Auto 30s' : 'Manual'}
        </button>
        <button onClick={fetchAll} style={{ padding: '2px 8px', borderRadius: 3, fontSize: 9, cursor: 'pointer', background: 'var(--tn-bg)', border: '1px solid var(--tn-border)', color: 'var(--tn-text-muted)' }}>
          Refresh
        </button>
      </div>

      {error && <div style={{ padding: '4px 8px', fontSize: 10, color: 'var(--tn-red)', background: 'rgba(247,118,142,0.1)', borderRadius: 3, marginBottom: 8 }}>{error}</div>}
      {loading && <div style={{ padding: 20, textAlign: 'center', color: 'var(--tn-text-muted)', fontSize: 12 }}>Checking services...</div>}

      {/* Service Health */}
      {health && (
        <>
          {sectionHeader('Service Health')}
          {health.services.map(svc => (
            <div key={svc.name} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '6px 8px', borderBottom: '1px solid var(--tn-border)', fontSize: 11,
            }}>
              <STATUS_DOT status={svc.status} />
              <span style={{ flex: 1, color: 'var(--tn-text)', fontWeight: 500 }}>{svc.name}</span>
              {svc.statusCode && (
                <span style={{ fontSize: 9, color: svc.statusCode === 200 ? 'var(--tn-text-muted)' : 'var(--tn-red)' }}>
                  HTTP {svc.statusCode}
                </span>
              )}
              {svc.latencyMs !== undefined && (
                <span style={{
                  fontSize: 9, fontFamily: 'monospace', padding: '1px 6px', borderRadius: 3,
                  background: svc.latencyMs < 500 ? 'rgba(158,206,106,0.1)' : svc.latencyMs < 2000 ? 'rgba(224,175,104,0.1)' : 'rgba(247,118,142,0.1)',
                  color: svc.latencyMs < 500 ? 'var(--tn-green)' : svc.latencyMs < 2000 ? 'var(--tn-orange)' : 'var(--tn-red)',
                }}>
                  {svc.latencyMs}ms
                </span>
              )}
              {svc.error && (
                <span style={{ fontSize: 9, color: 'var(--tn-red)', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {svc.error}
                </span>
              )}
            </div>
          ))}
          {health.checkedAt && (
            <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', marginTop: 6, textAlign: 'right' }}>
              Last checked: {new Date(health.checkedAt).toLocaleTimeString('de-DE')}
            </div>
          )}
        </>
      )}

      {/* Deployments */}
      {deployments && (
        <>
          {sectionHeader('Vercel Deployments')}
          {deployments.deployments.map(dep => (
            <div key={dep.name} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '6px 8px', borderBottom: '1px solid var(--tn-border)', fontSize: 11,
            }}>
              <STATUS_DOT status={dep.state} />
              <span style={{ width: 120, color: 'var(--tn-text)', fontWeight: 500, flexShrink: 0 }}>{dep.name}</span>
              <span style={{
                fontSize: 9, fontWeight: 600, padding: '1px 5px', borderRadius: 3, flexShrink: 0,
                background: STATUS_COLOR[dep.state as keyof typeof STATUS_COLOR]
                  ? `${STATUS_COLOR[dep.state as keyof typeof STATUS_COLOR]}20`
                  : 'var(--tn-bg)',
                color: STATUS_COLOR[dep.state as keyof typeof STATUS_COLOR] ?? 'var(--tn-text-muted)',
              }}>
                {dep.state}
              </span>
              {dep.commitMessage && (
                <span style={{ flex: 1, color: 'var(--tn-text-muted)', fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {dep.commitMessage.slice(0, 60)}
                </span>
              )}
              {dep.ageMin !== undefined && (
                <span style={{ fontSize: 9, color: 'var(--tn-text-muted)', flexShrink: 0 }}>
                  {dep.ageMin < 60 ? `${dep.ageMin}m` : `${Math.floor(dep.ageMin / 60)}h`} ago
                </span>
              )}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
