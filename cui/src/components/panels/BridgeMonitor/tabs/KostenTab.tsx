import { useState, useEffect, useCallback } from 'react';
import { bridgeJson, StatCard, Toolbar, ErrorBanner, LoadingSpinner, SectionFlat, formatTokens } from '../shared';

const PRICING: Record<string, { input: number; output: number; label: string }> = {
  'claude-haiku-4-5-20251001':   { input: 0.80,  output: 4.00,  label: 'Haiku 4.5' },
  'claude-sonnet-4-5-20250929':  { input: 3.00,  output: 15.00, label: 'Sonnet 4.5' },
  'claude-opus-4-6':             { input: 15.00, output: 75.00, label: 'Opus 4.6' },
  'claude-opus-4-20250514':      { input: 15.00, output: 75.00, label: 'Opus 4' },
};

const EUR_RATE = 0.92;

interface UsageRecord {
  model: string;
  input_tokens: number;
  output_tokens: number;
  requests: number;
}

interface UsageData {
  records?: UsageRecord[];
  total_input_tokens?: number;
  total_output_tokens?: number;
  total_requests?: number;
}

interface TenantUsage {
  tenant_id: string;
  current_month: {
    tokens_used: number;
    vision_calls: number;
    cost_usd: number;
  };
  limits: {
    monthly_token_limit: number;
    budget_limit_eur: number;
  };
  usage_percent: {
    tokens: number;
    budget: number;
  };
  allowed: boolean;
}

function calcCost(model: string, input: number, output: number): number {
  const p = PRICING[model];
  if (!p) return 0;
  return (input / 1_000_000) * p.input + (output / 1_000_000) * p.output;
}

function formatEur(usd: number): string {
  return `€${(usd * EUR_RATE).toFixed(2)}`;
}

export default function KostenTab() {
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [tenantUsage, setTenantUsage] = useState<TenantUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const fetchUsage = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [metricsRes, tenantRes] = await Promise.allSettled([
        bridgeJson<UsageData>('/v1/metrics'),
        bridgeJson<TenantUsage>('/v1/usage/status'),
      ]);

      if (metricsRes.status === 'fulfilled') setUsage(metricsRes.value);
      else setError('Metrics nicht erreichbar');

      if (tenantRes.status === 'fulfilled') setTenantUsage(tenantRes.value);

      setLastRefresh(new Date());
    } catch (err: any) {
      setError(`Fehler: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchUsage();
  }, [fetchUsage]);

  const totalCostUsd = usage?.records
    ? usage.records.reduce((sum, r) => sum + calcCost(r.model, r.input_tokens, r.output_tokens), 0)
    : 0;

  const totalInputTokens = usage?.total_input_tokens ?? usage?.records?.reduce((s, r) => s + r.input_tokens, 0) ?? 0;
  const totalOutputTokens = usage?.total_output_tokens ?? usage?.records?.reduce((s, r) => s + r.output_tokens, 0) ?? 0;
  const totalRequests = usage?.total_requests ?? usage?.records?.reduce((s, r) => s + r.requests, 0) ?? 0;

  return (
    <div style={{ padding: 12 }}>
      <Toolbar lastRefresh={lastRefresh} loading={loading} onRefresh={fetchUsage} />
      {error && <ErrorBanner message={error} />}

      {!loading && usage && (
        <>
          {/* Tenant Usage (if available) */}
          {tenantUsage && (
            <SectionFlat title="Tenant-Usage (aktueller Monat)">
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
                <StatCard
                  label="Kosten"
                  value={formatEur(tenantUsage.current_month.cost_usd)}
                  sub={`≈ $${(tenantUsage.current_month.cost_usd ?? 0).toFixed(2)} USD`}
                  color="var(--tn-orange)"
                />
                <StatCard
                  label="Token-Usage"
                  value={`${(tenantUsage.usage_percent.tokens ?? 0).toFixed(1)}%`}
                  sub={formatTokens(tenantUsage.current_month.tokens_used)}
                  color={(tenantUsage.usage_percent.tokens ?? 0) > 80 ? 'var(--tn-red)' : 'var(--tn-blue)'}
                />
                <StatCard
                  label="Budget"
                  value={`${(tenantUsage.usage_percent.budget ?? 0).toFixed(1)}%`}
                  sub={`Limit: €${tenantUsage.limits.budget_limit_eur ?? 0}`}
                  color={(tenantUsage.usage_percent.budget ?? 0) > 80 ? 'var(--tn-red)' : 'var(--tn-green)'}
                />
                <StatCard
                  label="Erlaubt"
                  value={tenantUsage.allowed ? 'Ja' : 'Nein'}
                  color={tenantUsage.allowed ? 'var(--tn-green)' : 'var(--tn-red)'}
                />
              </div>
            </SectionFlat>
          )}

          {/* Geschätzte Kosten (from metrics) */}
          <SectionFlat title="Geschätzte Kosten (Worker-Instanz)">
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
              <StatCard
                label="Gesamtkosten"
                value={formatEur(totalCostUsd)}
                sub={`≈ $${(totalCostUsd ?? 0).toFixed(2)} USD`}
                color="var(--tn-orange)"
              />
              <StatCard label="Input-Tokens" value={formatTokens(totalInputTokens)} sub="prompt" />
              <StatCard label="Output-Tokens" value={formatTokens(totalOutputTokens)} sub="completion" />
              <StatCard label="Requests" value={String(totalRequests)} />
            </div>
          </SectionFlat>

          {/* Pro Modell */}
          {usage.records && usage.records.length > 0 && (
            <SectionFlat title="Kosten pro Modell">
              <div style={{ background: 'var(--tn-bg-dark)', borderRadius: 5, overflow: 'hidden' }}>
                <div style={{
                  display: 'grid', gridTemplateColumns: '1fr 70px 70px 70px 80px',
                  gap: 8, padding: '6px 10px', fontSize: 9, fontWeight: 700,
                  color: 'var(--tn-text-muted)', borderBottom: '1px solid var(--tn-border)',
                  textTransform: 'uppercase', letterSpacing: '0.05em',
                }}>
                  <div>Modell</div>
                  <div style={{ textAlign: 'right' }}>In-Tok.</div>
                  <div style={{ textAlign: 'right' }}>Out-Tok.</div>
                  <div style={{ textAlign: 'right' }}>Reqs</div>
                  <div style={{ textAlign: 'right' }}>Kosten</div>
                </div>
                {usage.records.map((r, i) => {
                  const cost = calcCost(r.model, r.input_tokens, r.output_tokens);
                  const label = PRICING[r.model]?.label ?? r.model.slice(0, 20);
                  return (
                    <div key={i} style={{
                      display: 'grid', gridTemplateColumns: '1fr 70px 70px 70px 80px',
                      gap: 8, padding: '7px 10px', fontSize: 11,
                      borderBottom: '1px solid var(--tn-border)', alignItems: 'center',
                    }}>
                      <div style={{ color: 'var(--tn-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</div>
                      <div style={{ textAlign: 'right', color: 'var(--tn-text-muted)', fontFamily: 'monospace', fontSize: 10 }}>{formatTokens(r.input_tokens)}</div>
                      <div style={{ textAlign: 'right', color: 'var(--tn-text-muted)', fontFamily: 'monospace', fontSize: 10 }}>{formatTokens(r.output_tokens)}</div>
                      <div style={{ textAlign: 'right', color: 'var(--tn-text-muted)', fontSize: 10 }}>{r.requests}</div>
                      <div style={{ textAlign: 'right', color: 'var(--tn-orange)', fontWeight: 600, fontFamily: 'monospace' }}>{formatEur(cost)}</div>
                    </div>
                  );
                })}
              </div>
            </SectionFlat>
          )}

          {/* Pricing Reference */}
          <SectionFlat title="Preisreferenz (Anthropic, Feb 2026)">
            <div style={{ background: 'var(--tn-bg-dark)', borderRadius: 5, overflow: 'hidden' }}>
              <div style={{
                display: 'grid', gridTemplateColumns: '1fr 100px 100px',
                gap: 8, padding: '6px 10px', fontSize: 9, fontWeight: 700,
                color: 'var(--tn-text-muted)', borderBottom: '1px solid var(--tn-border)',
                textTransform: 'uppercase', letterSpacing: '0.05em',
              }}>
                <div>Modell</div>
                <div style={{ textAlign: 'right' }}>Input / 1M</div>
                <div style={{ textAlign: 'right' }}>Output / 1M</div>
              </div>
              {Object.entries(PRICING).map(([key, p]) => (
                <div key={key} style={{
                  display: 'grid', gridTemplateColumns: '1fr 100px 100px',
                  gap: 8, padding: '6px 10px', fontSize: 10,
                  borderBottom: '1px solid var(--tn-border)', alignItems: 'center',
                }}>
                  <div style={{ color: 'var(--tn-text)' }}>{p.label}</div>
                  <div style={{ textAlign: 'right', color: 'var(--tn-text-muted)', fontFamily: 'monospace' }}>${(p.input ?? 0).toFixed(2)}</div>
                  <div style={{ textAlign: 'right', color: 'var(--tn-text-muted)', fontFamily: 'monospace' }}>${(p.output ?? 0).toFixed(2)}</div>
                </div>
              ))}
            </div>
          </SectionFlat>
        </>
      )}

      {!loading && !usage && !error && (
        <div style={{ padding: 30, textAlign: 'center', color: 'var(--tn-text-muted)', fontSize: 12 }}>
          Keine Kostendaten verfügbar.
        </div>
      )}

      {loading && <LoadingSpinner text="Lade Kostendaten..." />}
    </div>
  );
}
