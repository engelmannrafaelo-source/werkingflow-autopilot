import { useState, useEffect, useCallback } from 'react';
import { bridgeJson, StatCard, Toolbar, ErrorBanner, LoadingSpinner, SectionFlat, formatDuration } from '../shared';

const PRICING: Record<string, { input: number; output: number }> = {
  'claude-haiku-4-5-20251001':   { input: 0.80,  output: 4.00 },
  'claude-haiku-3-5-20241022':   { input: 0.80,  output: 4.00 },
  'claude-sonnet-4-5-20250929':  { input: 3.00,  output: 15.00 },
  'claude-sonnet-4-20250514':    { input: 3.00,  output: 15.00 },
  'claude-sonnet-3-7-20250219':  { input: 3.00,  output: 15.00 },
  'claude-opus-4-20250514':      { input: 15.00, output: 75.00 },
  'claude-opus-4-1-20250805':    { input: 15.00, output: 75.00 },
  'claude-opus-4-6':             { input: 15.00, output: 75.00 },
};

interface EndpointMetrics {
  count: number;
  avg_duration: number;
  min_duration: number;
  max_duration: number;
  slow_count: number;
  very_slow_count: number;
}

interface MetricsResponse {
  metrics: {
    total_requests: number;
    average_duration: number;
    slow_requests: number;
    very_slow_requests: number;
    endpoints: Record<string, EndpointMetrics>;
  };
  thresholds: {
    non_tool: { slow_request: string; very_slow_request: string };
    tool_enabled: { slow_request: string; very_slow_request: string };
  };
}

interface Model {
  id: string;
  description?: string;
  owned_by?: string;
}

export default function MetrikenTab() {
  const [metrics, setMetrics] = useState<MetricsResponse | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [metricsRes, modelsRes] = await Promise.allSettled([
        bridgeJson<MetricsResponse>('/v1/metrics'),
        bridgeJson<{ data: Model[] }>('/v1/models'),
      ]);

      if (metricsRes.status === 'fulfilled') setMetrics(metricsRes.value);
      else setError('Metrics-Endpoint nicht erreichbar');

      if (modelsRes.status === 'fulfilled') {
        setModels(modelsRes.value.data ?? []);
      }

      setLastRefresh(new Date());
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const m = metrics?.metrics;
  const endpoints = m?.endpoints ?? {};
  const endpointEntries = Object.entries(endpoints).sort((a, b) => b[1].count - a[1].count);

  return (
    <div style={{ padding: 12 }}>
      <Toolbar lastRefresh={lastRefresh} loading={loading} onRefresh={fetchAll} />
      {error && <ErrorBanner message={error} />}

      {!loading && m && (
        <>
          {/* Performance KPIs */}
          <SectionFlat title="Performance (seit Worker-Start)">
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
              <StatCard label="Requests gesamt" value={String(m.total_requests)} />
              <StatCard
                label="Ø Dauer"
                value={m.average_duration > 0 ? formatDuration(m.average_duration) : '–'}
              />
              <StatCard
                label="Langsam"
                value={String(m.slow_requests)}
                sub={`Threshold: ${metrics!.thresholds.non_tool.slow_request}`}
                color={m.slow_requests > 0 ? 'var(--tn-orange)' : 'var(--tn-text-muted)'}
              />
              <StatCard
                label="Sehr langsam"
                value={String(m.very_slow_requests)}
                sub={`Threshold: ${metrics!.thresholds.non_tool.very_slow_request}`}
                color={m.very_slow_requests > 0 ? 'var(--tn-red)' : 'var(--tn-text-muted)'}
              />
            </div>
            <div style={{ background: 'var(--tn-bg-dark)', borderRadius: 5, padding: '6px 10px' }}>
              <div style={{ display: 'flex', gap: 16, fontSize: 10, color: 'var(--tn-text-muted)' }}>
                <span>Tool-Thresholds: langsam {metrics!.thresholds.tool_enabled.slow_request} / sehr langsam {metrics!.thresholds.tool_enabled.very_slow_request}</span>
              </div>
            </div>
          </SectionFlat>

          {/* Endpoint Breakdown */}
          {endpointEntries.length > 0 && (
            <SectionFlat title={`Endpoint-Breakdown (${endpointEntries.length})`}>
              <div style={{ background: 'var(--tn-bg-dark)', borderRadius: 5, overflow: 'hidden' }}>
                {/* Header */}
                <div style={{
                  display: 'grid', gridTemplateColumns: '1fr 55px 65px 65px 65px 45px',
                  gap: 4, padding: '5px 10px', fontSize: 9, fontWeight: 700,
                  color: 'var(--tn-text-muted)', borderBottom: '1px solid var(--tn-border)',
                  textTransform: 'uppercase', letterSpacing: '0.05em',
                }}>
                  <div>Endpoint</div>
                  <div style={{ textAlign: 'right' }}>Requests</div>
                  <div style={{ textAlign: 'right' }}>Ø Dauer</div>
                  <div style={{ textAlign: 'right' }}>Min</div>
                  <div style={{ textAlign: 'right' }}>Max</div>
                  <div style={{ textAlign: 'right' }}>Slow</div>
                </div>
                {endpointEntries.map(([path, ep]) => (
                  <div key={path} style={{
                    display: 'grid', gridTemplateColumns: '1fr 55px 65px 65px 65px 45px',
                    gap: 4, padding: '6px 10px', fontSize: 10,
                    borderBottom: '1px solid var(--tn-border)', alignItems: 'center',
                  }}>
                    <div style={{ fontFamily: 'monospace', color: 'var(--tn-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 9 }}>
                      {path}
                    </div>
                    <div style={{ textAlign: 'right', fontFamily: 'monospace', color: 'var(--tn-text)' }}>{ep.count}</div>
                    <div style={{ textAlign: 'right', fontFamily: 'monospace', color: 'var(--tn-text-muted)', fontSize: 9 }}>{formatDuration(ep.avg_duration)}</div>
                    <div style={{ textAlign: 'right', fontFamily: 'monospace', color: 'var(--tn-text-muted)', fontSize: 9 }}>{formatDuration(ep.min_duration)}</div>
                    <div style={{ textAlign: 'right', fontFamily: 'monospace', color: 'var(--tn-text-muted)', fontSize: 9 }}>{formatDuration(ep.max_duration)}</div>
                    <div style={{
                      textAlign: 'right', fontFamily: 'monospace', fontSize: 9,
                      color: (ep.slow_count + ep.very_slow_count) > 0 ? 'var(--tn-orange)' : 'var(--tn-text-muted)',
                    }}>
                      {ep.slow_count + ep.very_slow_count}
                    </div>
                  </div>
                ))}
              </div>
            </SectionFlat>
          )}
        </>
      )}

      {/* Verfügbare Modelle */}
      {!loading && models.length > 0 && (
        <SectionFlat title={`Verfügbare Modelle (${models.length})`}>
          <div style={{ background: 'var(--tn-bg-dark)', borderRadius: 5, overflow: 'hidden' }}>
            {models.map((model, i) => {
              const price = PRICING[model.id];
              return (
                <div key={i} style={{
                  display: 'grid', gridTemplateColumns: '1fr auto',
                  gap: 8, padding: '7px 10px',
                  borderBottom: '1px solid var(--tn-border)',
                  alignItems: 'center',
                }}>
                  <div>
                    <div style={{ fontSize: 11, color: 'var(--tn-text)', fontFamily: 'monospace' }}>{model.id}</div>
                    {model.description && (
                      <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', marginTop: 2 }}>{model.description}</div>
                    )}
                  </div>
                  {price && (
                    <div style={{ textAlign: 'right', fontSize: 9, color: 'var(--tn-text-muted)', whiteSpace: 'nowrap' }}>
                      <span style={{ fontFamily: 'monospace' }}>${price.input}/${price.output}</span>
                      <span style={{ marginLeft: 4 }}>pro 1M</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </SectionFlat>
      )}

      {/* Hinweis */}
      <div style={{
        padding: '8px 10px', borderRadius: 5, fontSize: 10,
        background: 'rgba(122,162,247,0.08)', border: '1px solid rgba(122,162,247,0.2)',
        color: 'var(--tn-text-muted)', lineHeight: 1.5,
      }}>
        <strong style={{ color: 'var(--tn-blue)' }}>Hinweis:</strong> Metriken sind In-Memory pro Worker-Instanz. Nach Worker-Restart werden sie zurückgesetzt.
        Für persistente Zahlen siehe CLI-Sessions (Gesamt: über alle Restarts hinweg persistent).
      </div>

      {loading && <LoadingSpinner text="Lade Metrik-Daten..." />}
    </div>
  );
}
