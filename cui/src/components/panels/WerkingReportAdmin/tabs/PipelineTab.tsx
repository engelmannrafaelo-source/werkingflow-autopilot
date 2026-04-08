import React, { useState, useEffect, useCallback } from 'react';

interface EnvironmentHealth {
  name: string;
  url: string;
  status: 'healthy' | 'degraded' | 'down' | 'checking';
  branch?: string;
  lastDeploy?: string;
  version?: string;
}

export default function PipelineTab({ envMode }: { envMode?: string }) {
  const [loading, setLoading] = useState(true);
  const [environments, setEnvironments] = useState<EnvironmentHealth[]>([]);
  const [error, setError] = useState('');

  const fetchAll = useCallback(async () => {
    if ((window as any).__cuiServerAlive === false) return;
    setLoading(true);
    setError('');

    try {
      // Use server-side proxy to avoid CORS issues.
      // The CUI server checks each environment's /api/version endpoint
      // and returns the aggregated results.
      const res = await fetch('/api/admin/wr/pipeline-health', {
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) {
        throw new Error(`Health check failed: HTTP ${res.status}`);
      }
      const data = await res.json();
      setEnvironments(data.environments || []);
    } catch (err: any) {
      console.warn('[WRPipeline] fetchAll:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll, envMode]);

  const statusColors = {
    healthy: 'var(--tn-green)',
    degraded: 'var(--tn-orange)',
    down: 'var(--tn-red)',
    checking: 'var(--tn-text-muted)',
  };

  const statusDot = (status: EnvironmentHealth['status']) => (
    <span style={{
      display: 'inline-block',
      width: 10,
      height: 10,
      borderRadius: '50%',
      background: statusColors[status],
      marginRight: 8,
      boxShadow: `0 0 6px ${statusColors[status]}`,
    }} />
  );

  return (
    <div data-ai-id="wr-pipeline-tab" style={{ padding: 12 }}>
      <div data-ai-id="wr-pipeline-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div data-ai-id="wr-pipeline-title" style={{ fontSize: 12, fontWeight: 700, color: 'var(--tn-text)' }}>
          Deployment Pipeline
        </div>
        <button data-ai-id="wr-pipeline-refresh-btn" onClick={fetchAll} style={{
          padding: '3px 10px', borderRadius: 3, fontSize: 10, cursor: 'pointer',
          background: 'var(--tn-bg)', border: '1px solid var(--tn-border)', color: 'var(--tn-text-muted)',
        }}>Refresh</button>
      </div>

      {error && <div data-ai-id="wr-pipeline-error" style={{ padding: '4px 8px', fontSize: 11, color: 'var(--tn-red)', background: 'rgba(247,118,142,0.1)', borderRadius: 3, marginBottom: 8 }}>{error}</div>}
      {loading && <div data-ai-id="wr-pipeline-loading" style={{ padding: 20, textAlign: 'center', color: 'var(--tn-text-muted)', fontSize: 12 }}>Checking environments...</div>}

      {!loading && (
        <div data-ai-id="wr-pipeline-envs" style={{ display: 'flex', gap: 16, alignItems: 'center', justifyContent: 'center', marginTop: 40 }}>
          {environments.map((env, idx) => (
            <React.Fragment key={env.name}>
              {/* Environment Card */}
              <div data-ai-id={`wr-pipeline-env-${env.name.toLowerCase()}`} data-status={env.status} style={{
                background: 'var(--tn-bg-dark)',
                border: `2px solid ${statusColors[env.status]}`,
                borderRadius: 8,
                padding: 16,
                minWidth: 180,
                textAlign: 'center',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 8 }}>
                  {statusDot(env.status)}
                  <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--tn-text)' }}>
                    {env.name}
                  </span>
                </div>

                <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', marginBottom: 4, fontFamily: 'monospace' }}>
                  {env.branch || '-'}
                </div>

                <div style={{
                  padding: '4px 8px',
                  borderRadius: 3,
                  fontSize: 9,
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  background: env.status === 'healthy'
                    ? 'rgba(158,206,106,0.2)'
                    : env.status === 'down'
                    ? 'rgba(247,118,142,0.2)'
                    : 'rgba(224,175,104,0.2)',
                  color: statusColors[env.status],
                  marginBottom: 8,
                }}>
                  {env.status}
                </div>

                {env.lastDeploy && (
                  <div style={{ fontSize: 9, color: 'var(--tn-text-muted)' }}>
                    {new Date(env.lastDeploy).toLocaleString('de-DE', {
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit'
                    })}
                  </div>
                )}

                {env.version && (
                  <div style={{ fontSize: 8, color: 'var(--tn-text-subtle)', marginTop: 4, fontFamily: 'monospace' }}>
                    {env.version.slice(0, 7)}
                  </div>
                )}
              </div>

              {/* Arrow */}
              {idx < environments.length - 1 && (
                <div style={{ color: 'var(--tn-text-muted)', fontSize: 20, fontWeight: 300 }}>
                  →
                </div>
              )}
            </React.Fragment>
          ))}
        </div>
      )}

      {/* Pipeline Info */}
      {!loading && (
        <div data-ai-id="wr-pipeline-info" style={{
          marginTop: 40,
          padding: 16,
          background: 'var(--tn-bg-dark)',
          border: '1px solid var(--tn-border)',
          borderRadius: 6,
        }}>
          <div data-ai-id="wr-pipeline-info-title" style={{ fontSize: 10, fontWeight: 600, color: 'var(--tn-text-muted)', marginBottom: 8, textTransform: 'uppercase' }}>
            Pipeline Flow
          </div>
          <div style={{ fontSize: 11, color: 'var(--tn-text)', lineHeight: 1.6 }}>
            <div><strong>1. Local Development</strong> → Develop on localhost:3008</div>
            <div><strong>2. Push to develop</strong> → Auto-deploy to Staging (Vercel develop branch)</div>
            <div><strong>3. Merge to main</strong> → Auto-deploy to Production (Vercel main branch)</div>
          </div>
        </div>
      )}
    </div>
  );
}
