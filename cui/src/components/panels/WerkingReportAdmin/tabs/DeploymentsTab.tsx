import { useState, useEffect, useCallback } from 'react';

interface Deployment {
  name: string;
  state: string;
  url?: string;
  commitSha?: string;
  commitMessage?: string;
  ageMin?: number;
  error?: string;
}

interface AiBridgeHealth {
  status?: string;
  version?: string;
  uptime?: number;
  presidio?: boolean;
  [key: string]: unknown;
}

export default function DeploymentsTab({ envMode }: { envMode?: string }) {
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [bridgeHealth, setBridgeHealth] = useState<AiBridgeHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [deploying, setDeploying] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [depsRes, bridgeRes] = await Promise.all([
        fetch('/api/ops/deployments').catch(() => null),
        fetch('/api/admin/wr/health').catch(() => null),
      ]);
      if (depsRes?.ok) {
        const data = await depsRes.json();
        setDeployments(data.deployments || []);
      }
      if (bridgeRes?.ok) {
        setBridgeHealth(await bridgeRes.json());
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll, envMode]);

  const handleDeploy = async (projectName: string) => {
    if (!confirm(`Trigger production deployment for "${projectName}"?`)) return;
    setDeploying(projectName);
    try {
      const res = await fetch('/api/admin/wr/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: projectName }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      alert(data.message || 'Deploy triggered!');
      setTimeout(fetchAll, 3000);
    } catch (err: any) {
      alert(`Deploy failed: ${err.message}`);
    } finally {
      setDeploying(null);
    }
  };

  const handleHetznerRestart = async () => {
    if (!confirm('Restart AI-Bridge containers on Hetzner?')) return;
    setRestarting(true);
    try {
      const res = await fetch('/api/admin/wr/hetzner/restart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      alert(data.message || 'Restart triggered!');
      setTimeout(fetchAll, 5000);
    } catch (err: any) {
      alert(`Restart failed: ${err.message}`);
    } finally {
      setRestarting(false);
    }
  };

  const stateColor = (state: string) => {
    const s = state?.toUpperCase();
    if (s === 'READY' || s === 'ACTIVE') return 'var(--tn-green)';
    if (s === 'BUILDING' || s === 'DEPLOYING' || s === 'INITIALIZING') return 'var(--tn-orange)';
    if (s === 'ERROR' || s === 'CANCELED') return 'var(--tn-red)';
    return 'var(--tn-text-muted)';
  };

  const formatAge = (min?: number) => {
    if (min == null) return '—';
    if (min < 60) return `${min}m ago`;
    if (min < 1440) return `${Math.round(min / 60)}h ago`;
    return `${Math.round(min / 1440)}d ago`;
  };

  return (
    <div style={{ padding: 12 }}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, alignItems: 'center' }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--tn-text)', flex: 1 }}>Deployments & Infrastructure</span>
        <button onClick={fetchAll} style={{
          padding: '3px 10px', borderRadius: 3, fontSize: 10, cursor: 'pointer',
          background: 'var(--tn-bg)', border: '1px solid var(--tn-border)', color: 'var(--tn-text-muted)',
        }}>Refresh</button>
      </div>

      {error && <div style={{ padding: '4px 8px', fontSize: 11, color: 'var(--tn-red)', background: 'rgba(247,118,142,0.1)', borderRadius: 3, marginBottom: 8 }}>{error}</div>}
      {loading && <div style={{ padding: 20, textAlign: 'center', color: 'var(--tn-text-muted)', fontSize: 12 }}>Loading...</div>}

      {!loading && (
        <>
          {/* Vercel Deployments */}
          <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginBottom: 6, fontWeight: 600, textTransform: 'uppercase' }}>Vercel Apps</div>
          <div style={{ marginBottom: 16 }}>
            {deployments.length === 0 ? (
              <div style={{ padding: 12, textAlign: 'center', color: 'var(--tn-text-muted)', fontSize: 11, background: 'var(--tn-bg-dark)', borderRadius: 6 }}>
                No deployment data (VERCEL_TOKEN not set?)
              </div>
            ) : (
              deployments.map(dep => (
                <div key={dep.name} style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
                  background: 'var(--tn-bg-dark)', border: '1px solid var(--tn-border)',
                  borderRadius: 6, marginBottom: 6,
                }}>
                  {/* Status Dot */}
                  <span style={{
                    width: 10, height: 10, borderRadius: '50%', background: stateColor(dep.state),
                    boxShadow: `0 0 6px ${stateColor(dep.state)}`, flexShrink: 0,
                  }} />

                  {/* Info */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--tn-text)' }}>{dep.name}</div>
                    <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', display: 'flex', gap: 8, marginTop: 2, flexWrap: 'wrap' }}>
                      {dep.commitSha && <span><code style={{ color: 'var(--tn-blue)' }}>{dep.commitSha}</code></span>}
                      {dep.commitMessage && <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 }}>{dep.commitMessage}</span>}
                    </div>
                  </div>

                  {/* State Badge */}
                  <span style={{
                    padding: '3px 8px', borderRadius: 3, fontSize: 9, fontWeight: 600, textTransform: 'uppercase',
                    background: `${stateColor(dep.state)}20`, color: stateColor(dep.state),
                  }}>{dep.state}</span>

                  {/* Age */}
                  <span style={{ fontSize: 10, color: 'var(--tn-text-muted)', minWidth: 50, textAlign: 'right' }}>
                    {formatAge(dep.ageMin)}
                  </span>

                  {/* Deploy Button */}
                  <button
                    onClick={() => handleDeploy(dep.name)}
                    disabled={deploying === dep.name}
                    style={{
                      padding: '4px 10px', borderRadius: 3, fontSize: 9, fontWeight: 600,
                      cursor: deploying === dep.name ? 'not-allowed' : 'pointer',
                      background: 'rgba(122,162,247,0.15)', border: '1px solid rgba(122,162,247,0.3)',
                      color: 'var(--tn-blue)', opacity: deploying === dep.name ? 0.5 : 1,
                    }}
                  >
                    {deploying === dep.name ? 'Deploying...' : 'Deploy'}
                  </button>
                </div>
              ))
            )}
          </div>

          {/* AI-Bridge / Hetzner */}
          <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginBottom: 6, fontWeight: 600, textTransform: 'uppercase' }}>AI-Bridge (Hetzner)</div>
          <div style={{
            padding: 12, background: 'var(--tn-bg-dark)', border: '1px solid var(--tn-border)',
            borderRadius: 6, marginBottom: 16,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{
                width: 10, height: 10, borderRadius: '50%',
                background: bridgeHealth?.status === 'ok' || bridgeHealth?.status === 'healthy' ? 'var(--tn-green)' : 'var(--tn-red)',
                boxShadow: `0 0 6px ${bridgeHealth?.status === 'ok' || bridgeHealth?.status === 'healthy' ? 'var(--tn-green)' : 'var(--tn-red)'}`,
              }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--tn-text)' }}>
                  AI-Bridge Server
                  <span style={{ fontSize: 9, color: 'var(--tn-text-muted)', marginLeft: 8, fontFamily: 'monospace' }}>49.12.72.66:8000</span>
                </div>
                <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', marginTop: 2, display: 'flex', gap: 10 }}>
                  {bridgeHealth?.version && <span>v{bridgeHealth.version}</span>}
                  {bridgeHealth?.presidio != null && <span>Presidio: {bridgeHealth.presidio ? 'Active' : 'Inactive'}</span>}
                  {bridgeHealth?.uptime != null && <span>Uptime: {Math.round(bridgeHealth.uptime / 3600)}h</span>}
                </div>
              </div>
              <button onClick={handleHetznerRestart} disabled={restarting} style={{
                padding: '5px 12px', borderRadius: 3, fontSize: 10, fontWeight: 600,
                cursor: restarting ? 'not-allowed' : 'pointer',
                background: 'rgba(224,175,104,0.15)', border: '1px solid rgba(224,175,104,0.3)',
                color: 'var(--tn-orange)', opacity: restarting ? 0.5 : 1,
              }}>
                {restarting ? 'Restarting...' : 'Restart Containers'}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
