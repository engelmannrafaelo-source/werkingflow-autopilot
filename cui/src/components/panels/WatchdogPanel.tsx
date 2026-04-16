import { memo, useState, useEffect, useCallback, useRef } from 'react';
import { validateApiResponse } from '../../lib/validateApiResponse';

// ---------- System Health types (formerly SystemHealth panel) ----------
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
  errorCount?: number;
  services?: ServiceHealth[];
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
  checkedAt?: string;
}

const STATUS_COLOR: Record<string, string> = {
  ok: 'var(--tn-green)',
  error: 'var(--tn-red)',
  timeout: 'var(--tn-orange)',
  READY: 'var(--tn-green)',
  BUILDING: 'var(--tn-orange)',
  ERROR: 'var(--tn-red)',
  QUEUED: 'var(--tn-text-muted)',
  CANCELED: 'var(--tn-text-muted)',
};

function StatusDot({ status }: { status: string }) {
  const color = STATUS_COLOR[status] ?? 'var(--tn-text-muted)';
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
}

// ---------- System Health View ----------
function SystemHealthView() {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [deployments, setDeployments] = useState<DeploymentsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchAll = useCallback(async () => {
    if ((window as unknown as Record<string, unknown>).__cuiServerAlive === false) return;
    setError('');
    try {
      const healthEndpoint = '/api/admin/wr/system-health';
      const deploymentsEndpoint = '/api/ops/deployments';
      const [hRes, dRes] = await Promise.all([
        fetch(healthEndpoint, { signal: AbortSignal.timeout(20000) }),
        fetch(deploymentsEndpoint, { signal: AbortSignal.timeout(20000) }),
      ]);
      if (!hRes.ok) {
        setError(`[SystemHealth] Health: HTTP ${hRes.status}`);
      } else {
        const rawHealth = await hRes.json();
        const validatedHealth = validateApiResponse<HealthData>(rawHealth, healthEndpoint, {
          ok: 'boolean',
          checkedAt: 'string',
          errorCount: { type: 'number', optional: true },
          services: { type: 'array', optional: true },
        });
        setHealth(validatedHealth);
      }
      if (!dRes.ok) {
        console.warn(`[SystemHealth] deployments failed: HTTP ${dRes.status}`);
      } else {
        const rawDeploy = await dRes.json();
        const validatedDeploy = validateApiResponse<DeploymentsData>(rawDeploy, deploymentsEndpoint, {
          deployments: 'array',
          checkedAt: { type: 'string', optional: true },
        });
        setDeployments(validatedDeploy);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[SystemHealth] fetch error:', err);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  useEffect(() => {
    if (autoRefresh) {
      intervalRef.current = setInterval(fetchAll, 30000);
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {health && (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: '2px 8px', borderRadius: 10, fontSize: 10, fontWeight: 600,
              background: health.ok ? 'rgba(158,206,106,0.15)' : 'rgba(247,118,142,0.15)',
              color: health.ok ? 'var(--tn-green)' : 'var(--tn-red)',
            }}>
              <StatusDot status={health.ok ? 'ok' : 'error'} />
              {health.ok ? 'ALL SYSTEMS OK' : `${health.errorCount ?? 0} SERVICE${(health.errorCount ?? 0) > 1 ? 'S' : ''} DOWN`}
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

      {health && (
        <>
          {sectionHeader('Service Health')}
          {(health.services ?? []).map(svc => (
            <div key={svc.name} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '6px 8px', borderBottom: '1px solid var(--tn-border)', fontSize: 11,
            }}>
              <StatusDot status={svc.status} />
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
          <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', marginTop: 6, textAlign: 'right' }}>
            Last checked: {new Date(health.checkedAt).toLocaleTimeString('de-DE')}
          </div>
        </>
      )}

      {deployments && (
        <>
          {sectionHeader('Vercel Deployments')}
          {deployments.deployments.map(dep => (
            <div key={dep.name} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '6px 8px', borderBottom: '1px solid var(--tn-border)', fontSize: 11,
            }}>
              <StatusDot status={dep.state} />
              <span style={{ width: 120, color: 'var(--tn-text)', fontWeight: 500, flexShrink: 0 }}>{dep.name}</span>
              <span style={{
                fontSize: 9, fontWeight: 600, padding: '1px 5px', borderRadius: 3, flexShrink: 0,
                background: STATUS_COLOR[dep.state]
                  ? `${STATUS_COLOR[dep.state]}20`
                  : 'var(--tn-bg)',
                color: STATUS_COLOR[dep.state] ?? 'var(--tn-text-muted)',
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

// ---------- WatchdogPanel with Tabs ----------
type WatchdogTab = 'processes' | 'health';

/** Dev Server Watchdog — Processes iframe + System Health tabs */
export default memo(function WatchdogPanel() {
  const [tab, setTab] = useState<WatchdogTab>('processes');

  const tabButton = (id: WatchdogTab, label: string) => (
    <button
      onClick={() => setTab(id)}
      style={{
        padding: '4px 12px',
        fontSize: 11,
        fontWeight: 500,
        cursor: 'pointer',
        background: tab === id ? 'var(--tn-bg-highlight)' : 'transparent',
        border: 'none',
        borderBottom: tab === id ? '2px solid var(--tn-blue)' : '2px solid transparent',
        color: tab === id ? 'var(--tn-text)' : 'var(--tn-text-muted)',
      }}
    >
      {label}
    </button>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#0d1117' }}>
      <div style={{
        display: 'flex',
        gap: 2,
        padding: '2px 8px 0',
        background: 'var(--tn-bg-dark)',
        borderBottom: '1px solid var(--tn-border)',
        flexShrink: 0,
      }}>
        {tabButton('processes', 'Processes & Ports')}
        {tabButton('health', 'System Health')}
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {tab === 'processes' ? (
          <iframe
            src="/watchdog/"
            style={{ width: '100%', height: '100%', border: 'none', background: '#0d1117' }}
            title="Dev Server Watchdog"
          />
        ) : (
          <SystemHealthView />
        )}
      </div>
    </div>
  );
});
