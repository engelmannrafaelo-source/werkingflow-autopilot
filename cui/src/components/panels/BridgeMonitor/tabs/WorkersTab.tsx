import { useState, useEffect, useCallback } from 'react';
import { BRIDGE_URL, bridgeJson, StatusBadge, Toolbar, ErrorBanner, LoadingSpinner, SectionFlat } from '../shared';

interface WorkerHealth {
  status: string;
  service?: string;
  worker_instance?: string;
}

interface LbStatus {
  load_balancer: string;
  workers: number;
  strategy: string;
  failover: string;
  accounts: string[];
  paused: string[];
  status: string;
}

interface RateLimitsData {
  current_worker: string;
  current_worker_rate_limited: boolean;
  all_rate_limits: Record<string, { reset_time?: string; retry_after_seconds?: number }>;
  total_workers_limited: number;
}

interface LicenseHealth {
  status: string;
  worker_id: string;
  token_preview: string;
  test_response: string;
  test_duration_seconds: number;
  message: string;
}

interface WorkerInfo {
  id: string;
  account: string;
  health: WorkerHealth | null;
  healthError: string | null;
  paused: boolean;
  rateLimited: boolean;
  retryAfter: number | null;
}

export default function WorkersTab() {
  const [workers, setWorkers] = useState<WorkerInfo[]>([]);
  const [lbStatus, setLbStatus] = useState<LbStatus | null>(null);
  const [licenseHealth, setLicenseHealth] = useState<LicenseHealth | null>(null);
  const [licenseLoading, setLicenseLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [lbRes, rlRes] = await Promise.allSettled([
        bridgeJson<LbStatus>('/lb-status'),
        bridgeJson<RateLimitsData>('/rate-limits'),
      ]);

      if (lbRes.status !== 'fulfilled') throw new Error('Load Balancer nicht erreichbar');
      const lb = lbRes.value;
      setLbStatus(lb);

      const rl = rlRes.status === 'fulfilled' ? rlRes.value : null;

      // Fetch individual worker health (via direct proxy)
      const workerCount = lb.workers;
      const healthResults = await Promise.allSettled(
        Array.from({ length: workerCount }, (_, i) =>
          fetch(`${BRIDGE_URL}/worker${i + 1}/health`, { signal: AbortSignal.timeout(5000) })
            .then(r => r.json())
            .then(d => ({ data: d as WorkerHealth, error: null }))
            .catch(e => ({ data: null, error: e.message }))
        )
      );

      const workerInfos: WorkerInfo[] = lb.accounts.map((acc, i) => {
        const hr = healthResults[i];
        const healthResult = hr?.status === 'fulfilled' ? hr.value : { data: null, error: 'Fetch failed' };
        const rlInfo = rl?.all_rate_limits?.[acc];
        const isLimited = rlInfo?.retry_after_seconds != null && rlInfo.retry_after_seconds > 0;

        return {
          id: `worker${i + 1}`,
          account: acc,
          health: healthResult.data,
          healthError: healthResult.error,
          paused: lb.paused.includes(acc),
          rateLimited: isLimited,
          retryAfter: rlInfo?.retry_after_seconds ?? null,
        };
      });

      setWorkers(workerInfos);
      setLastRefresh(new Date());
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 30000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  const handleLicenseCheck = useCallback(async () => {
    setLicenseLoading(true);
    setLicenseHealth(null);
    try {
      const data = await bridgeJson<LicenseHealth>('/license-health', { timeout: 30000 });
      setLicenseHealth(data);
    } catch (err: any) {
      setLicenseHealth({ status: 'error', worker_id: '?', token_preview: '', test_response: '', test_duration_seconds: 0, message: err.message });
    } finally {
      setLicenseLoading(false);
    }
  }, []);

  function getWorkerStatus(w: WorkerInfo): 'active' | 'paused' | 'limited' | 'dead' | 'unknown' {
    if (w.paused) return 'paused';
    if (w.rateLimited) return 'limited';
    if (w.health === null) return 'dead';
    if (w.health.status === 'healthy') return 'active';
    return 'unknown';
  }

  return (
    <div style={{ padding: 12 }}>
      <Toolbar lastRefresh={lastRefresh} loading={loading} onRefresh={fetchAll} autoRefresh={30} />
      {error && <ErrorBanner message={error} />}

      {/* Load Balancer Summary */}
      {lbStatus && (
        <div style={{
          display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap',
        }}>
          {[
            { label: 'Workers', value: String(lbStatus.workers), color: 'var(--tn-blue)' },
            { label: 'Strategie', value: lbStatus.strategy, color: 'var(--tn-text)' },
            { label: 'Failover', value: lbStatus.failover === 'enabled' ? 'AN' : 'AUS', color: lbStatus.failover === 'enabled' ? 'var(--tn-green)' : 'var(--tn-red)' },
            { label: 'LB Status', value: lbStatus.status === 'healthy' ? 'OK' : 'FEHLER', color: lbStatus.status === 'healthy' ? 'var(--tn-green)' : 'var(--tn-red)' },
          ].map((card, i) => (
            <div key={i} style={{
              background: 'var(--tn-bg-dark)', border: '1px solid var(--tn-border)', borderRadius: 6,
              padding: '8px 12px', flex: '1 1 0', minWidth: 80,
            }}>
              <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', marginBottom: 3 }}>{card.label}</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: card.color, fontFamily: 'monospace' }}>{card.value}</div>
            </div>
          ))}
        </div>
      )}

      {/* Worker Cards */}
      {workers.length > 0 && (
        <SectionFlat title="Worker-Instanzen">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {workers.map((w) => {
              const status = getWorkerStatus(w);
              return (
                <div key={w.id} style={{
                  background: 'var(--tn-bg-dark)', border: '1px solid var(--tn-border)', borderRadius: 6,
                  padding: '10px 12px',
                }}>
                  {/* Worker Header */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{
                        fontSize: 13, fontWeight: 700, color: 'var(--tn-text)',
                        fontFamily: 'monospace',
                      }}>
                        {w.id}
                      </span>
                      <span style={{ fontSize: 10, color: 'var(--tn-text-muted)' }}>
                        {w.account}
                      </span>
                    </div>
                    <StatusBadge status={status} />
                  </div>

                  {/* Worker Details Grid */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 6 }}>
                    <div>
                      <div style={{ fontSize: 9, color: 'var(--tn-text-muted)' }}>Health</div>
                      <div style={{ fontSize: 11, color: w.health ? 'var(--tn-green)' : 'var(--tn-red)', fontFamily: 'monospace' }}>
                        {w.health ? w.health.status : (w.healthError ?? 'unreachable')}
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: 9, color: 'var(--tn-text-muted)' }}>Rate-Limited</div>
                      <div style={{ fontSize: 11, color: w.rateLimited ? 'var(--tn-orange)' : 'var(--tn-green)', fontFamily: 'monospace' }}>
                        {w.rateLimited ? `Ja (${w.retryAfter}s)` : 'Nein'}
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: 9, color: 'var(--tn-text-muted)' }}>Paused</div>
                      <div style={{ fontSize: 11, color: w.paused ? 'var(--tn-orange)' : 'var(--tn-text)', fontFamily: 'monospace' }}>
                        {w.paused ? 'Ja' : 'Nein'}
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: 9, color: 'var(--tn-text-muted)' }}>Service</div>
                      <div style={{ fontSize: 11, color: 'var(--tn-text)', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {w.health?.service ?? '–'}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </SectionFlat>
      )}

      {/* License Health Check */}
      <SectionFlat title="License/Token-Validierung">
        <div style={{ background: 'var(--tn-bg-dark)', borderRadius: 6, padding: '10px 12px' }}>
          <div style={{ fontSize: 11, color: 'var(--tn-text-muted)', marginBottom: 8 }}>
            Testet die OAuth-Token-Validität mit einem minimalen API-Call.
          </div>
          <button
            onClick={handleLicenseCheck}
            disabled={licenseLoading}
            style={{
              padding: '5px 14px', borderRadius: 4, fontSize: 11, fontWeight: 600,
              cursor: licenseLoading ? 'not-allowed' : 'pointer',
              background: licenseLoading ? 'var(--tn-border)' : 'var(--tn-blue)',
              border: 'none', color: '#fff', opacity: licenseLoading ? 0.6 : 1,
            }}
          >
            {licenseLoading ? 'Teste Token...' : 'License-Check starten'}
          </button>

          {licenseHealth && (
            <div style={{
              marginTop: 10, padding: '8px 10px', borderRadius: 5,
              background: licenseHealth.status === 'healthy' ? 'rgba(158,206,106,0.07)' : 'rgba(247,118,142,0.07)',
              border: `1px solid ${licenseHealth.status === 'healthy' ? 'rgba(158,206,106,0.3)' : 'rgba(247,118,142,0.3)'}`,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <StatusBadge status={licenseHealth.status === 'healthy' ? 'ok' : 'error'} />
                <span style={{ fontSize: 10, color: 'var(--tn-text-muted)', fontFamily: 'monospace' }}>
                  {licenseHealth.test_duration_seconds.toFixed(2)}s
                </span>
              </div>
              <div style={{ fontSize: 10, color: 'var(--tn-text-muted)' }}>
                <div>Worker: <span style={{ fontFamily: 'monospace', color: 'var(--tn-text)' }}>{licenseHealth.worker_id}</span></div>
                {licenseHealth.token_preview && (
                  <div>Token: <span style={{ fontFamily: 'monospace', color: 'var(--tn-text)' }}>{licenseHealth.token_preview}</span></div>
                )}
                <div style={{ marginTop: 2, color: licenseHealth.status === 'healthy' ? 'var(--tn-green)' : 'var(--tn-red)' }}>
                  {licenseHealth.message}
                </div>
              </div>
            </div>
          )}
        </div>
      </SectionFlat>

      {loading && workers.length === 0 && <LoadingSpinner text="Lade Worker-Daten..." />}
    </div>
  );
}
