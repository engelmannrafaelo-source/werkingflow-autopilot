import { useState, useEffect, useCallback } from 'react';
import { bridgeJson, StatusBadge, Row, Section, Toolbar, ErrorBanner, LoadingSpinner } from '../shared';

interface HealthData {
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

interface PrivacyData {
  enabled: boolean;
  available: boolean;
  language: string;
  supported_entities: string[];
}

interface RateLimitsData {
  current_worker: string;
  current_worker_rate_limited: boolean;
  current_worker_retry_after: number | null;
  all_rate_limits: Record<string, { reset_time?: string; retry_after_seconds?: number }>;
  total_workers_limited: number;
}

interface AuthStatusData {
  claude_code_auth: {
    method: string;
    status: { valid: boolean; errors: string[] };
  };
  backends: Record<string, { available: boolean; method?: string; region?: string; errors?: string[] }>;
  server_info: { api_key_required: boolean; api_key_source: string; version: string };
}

interface ProviderTier {
  tier_id: string;
  name: string;
  model: string;
  dsgvo_compliant: boolean;
  pricing: { input_per_1m: number; output_per_1m: number };
  available: boolean;
  description: string;
}

export default function StatusTab() {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [lbStatus, setLbStatus] = useState<LbStatus | null>(null);
  const [privacy, setPrivacy] = useState<PrivacyData | null>(null);
  const [rateLimits, setRateLimits] = useState<RateLimitsData | null>(null);
  const [authStatus, setAuthStatus] = useState<AuthStatusData | null>(null);
  const [providers, setProviders] = useState<ProviderTier[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [healthRes, lbRes, privRes, rlRes, authRes, provRes] = await Promise.allSettled([
        bridgeJson<HealthData>('/health'),
        bridgeJson<LbStatus>('/lb-status'),
        bridgeJson<{ privacy: PrivacyData }>('/v1/privacy/status'),
        bridgeJson<RateLimitsData>('/rate-limits'),
        bridgeJson<AuthStatusData>('/v1/auth/status'),
        bridgeJson<{ providers: ProviderTier[] }>('/v1/providers'),
      ]);

      if (healthRes.status === 'fulfilled') setHealth(healthRes.value);
      else throw new Error('Bridge nicht erreichbar');

      if (lbRes.status === 'fulfilled') setLbStatus(lbRes.value);
      if (privRes.status === 'fulfilled') setPrivacy(privRes.value?.privacy ?? null);
      if (rlRes.status === 'fulfilled') setRateLimits(rlRes.value);
      if (authRes.status === 'fulfilled') setAuthStatus(authRes.value);
      if (provRes.status === 'fulfilled') setProviders(provRes.value?.providers ?? []);

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

  const workers = lbStatus
    ? lbStatus.accounts.map(acc => ({
        account: acc,
        status: lbStatus.paused.includes(acc) ? 'paused' as const : 'active' as const,
      }))
    : [];

  const activeCount = workers.filter(w => w.status === 'active').length;
  const pausedCount = workers.filter(w => w.status === 'paused').length;

  return (
    <div style={{ padding: 12 }}>
      <Toolbar lastRefresh={lastRefresh} loading={loading} onRefresh={fetchAll} autoRefresh={30} />
      {error && <ErrorBanner message={error} />}

      {!loading && health && (
        <>
          {/* Bridge Status */}
          <Section title="Bridge Status">
            <Row label="Status" value={<StatusBadge status={health.status === 'healthy' ? 'ok' : 'error'} />} />
            <Row label="Service" value={health.service ?? '–'} mono />
            <Row label="Worker (aktuell)" value={health.worker_instance ?? '–'} mono />
            <Row label="Version" value={authStatus?.server_info?.version ?? '–'} mono />
          </Section>

          {/* Load Balancer + Workers */}
          {lbStatus && (
            <Section title={`Worker-Accounts (${activeCount} aktiv / ${pausedCount} pausiert / ${workers.length} gesamt)`}>
              <Row label="Load Balancer" value={lbStatus.load_balancer} mono />
              <Row label="Strategie" value={lbStatus.strategy} />
              <Row label="Failover" value={lbStatus.failover === 'enabled' ? 'Aktiviert' : 'Deaktiviert'} />
              {rateLimits && (
                <Row
                  label="Rate-Limited Workers"
                  value={
                    rateLimits.total_workers_limited > 0
                      ? <StatusBadge status="limited" />
                      : <span style={{ fontSize: 11, color: 'var(--tn-green)' }}>0 / {workers.length}</span>
                  }
                />
              )}
              {workers.map((w, i) => {
                const rl = rateLimits?.all_rate_limits?.[w.account];
                const isLimited = rl?.retry_after_seconds != null && rl.retry_after_seconds > 0;
                return (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--tn-border)', gap: 8 }}>
                    <span style={{ fontSize: 11, color: 'var(--tn-text)', fontFamily: 'monospace', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{w.account}</span>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      {isLimited && (
                        <span style={{ fontSize: 9, color: 'var(--tn-orange)', fontFamily: 'monospace' }}>
                          Reset: {rl!.retry_after_seconds}s
                        </span>
                      )}
                      <StatusBadge status={isLimited ? 'limited' : w.status} />
                    </div>
                  </div>
                );
              })}
              {workers.length === 0 && (
                <div style={{ padding: '8px 0', fontSize: 11, color: 'var(--tn-text-muted)' }}>Keine Account-Daten</div>
              )}
            </Section>
          )}

          {/* Auth & Backends */}
          {authStatus && (
            <Section title="Authentifizierung & Backends">
              <Row
                label="Auth-Methode"
                value={authStatus.claude_code_auth.method}
                mono
              />
              <Row
                label="Auth-Status"
                value={<StatusBadge status={authStatus.claude_code_auth.status.valid ? 'ok' : 'error'} />}
              />
              {Object.entries(authStatus.backends).map(([name, backend]) => (
                <Row
                  key={name}
                  label={`Backend: ${name}`}
                  value={
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      {backend.region && <span style={{ fontSize: 9, color: 'var(--tn-text-muted)', fontFamily: 'monospace' }}>{backend.region}</span>}
                      <StatusBadge status={backend.available ? 'ok' : 'error'} />
                    </div>
                  }
                />
              ))}
            </Section>
          )}

          {/* Provider Tiers */}
          {providers.length > 0 && (
            <Section title={`Provider-Tiers (${providers.length})`}>
              {providers.map((p, i) => (
                <div key={i} style={{ padding: '6px 0', borderBottom: '1px solid var(--tn-border)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
                    <span style={{ fontSize: 11, color: 'var(--tn-text)', fontWeight: 600 }}>{p.name}</span>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      {p.dsgvo_compliant && (
                        <span style={{ fontSize: 8, fontWeight: 700, padding: '1px 5px', borderRadius: 2, background: 'rgba(158,206,106,0.15)', color: 'var(--tn-green)' }}>
                          DSGVO
                        </span>
                      )}
                      <StatusBadge status={p.available ? 'active' : 'paused'} />
                    </div>
                  </div>
                  <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', display: 'flex', gap: 12 }}>
                    <span style={{ fontFamily: 'monospace' }}>{p.model}</span>
                    <span>${p.pricing.input_per_1m}/{p.pricing.output_per_1m} /1M</span>
                  </div>
                </div>
              ))}
            </Section>
          )}

          {/* Presidio */}
          <Section title="Presidio (DSGVO-Anonymisierung)">
            {privacy ? (
              <>
                <Row label="Status" value={<StatusBadge status={privacy.enabled && privacy.available ? 'ok' : 'error'} />} />
                <Row label="Aktiv" value={privacy.enabled ? 'Ja' : 'Nein'} />
                <Row label="Verfügbar" value={privacy.available ? 'Ja' : 'Nein'} />
                <Row label="Sprache" value={privacy.language.toUpperCase()} mono />
                <Row label="Entities" value={`${privacy.supported_entities?.length ?? 0} konfiguriert`} />
                {privacy.supported_entities?.length > 0 && (
                  <div style={{ padding: '6px 0', display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {privacy.supported_entities.map((e, i) => (
                      <span key={i} style={{
                        fontSize: 8, fontWeight: 600, padding: '2px 5px', borderRadius: 2,
                        background: 'rgba(122,162,247,0.12)', color: 'var(--tn-blue)', fontFamily: 'monospace',
                      }}>
                        {e}
                      </span>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div style={{ padding: '8px 0', fontSize: 11, color: 'var(--tn-text-muted)' }}>Nicht erreichbar</div>
            )}
          </Section>
        </>
      )}

      {loading && !health && <LoadingSpinner text="Verbinde mit Bridge..." />}
    </div>
  );
}
