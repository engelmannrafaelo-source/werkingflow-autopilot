import { useState, useEffect } from 'react';
import { bridgeJson, Row, Section, StatusBadge } from '../shared';

interface ProviderTier {
  name: string;
  model: string;
  pricing?: string;
  dsgvo_compliant?: boolean;
}

interface HelpData {
  version?: string;
  auth_method?: string;
  privacy_enabled?: boolean;
  privacy_language?: string;
  privacy_entities?: string[];
  providers?: ProviderTier[];
}

const PRICING: Array<{ model: string; label: string; input: number; output: number }> = [
  { model: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', input: 0.80, output: 4.00 },
  { model: 'claude-sonnet-4-5-20250929', label: 'Sonnet 4.5', input: 3.00, output: 15.00 },
  { model: 'claude-opus-4-6', label: 'Opus 4.6', input: 15.00, output: 75.00 },
  { model: 'claude-opus-4-20250514', label: 'Opus 4', input: 15.00, output: 75.00 },
];

export default function HelpModal({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<HelpData>({});

  useEffect(() => {
    async function load() {
      const [authRes, privRes, provRes] = await Promise.allSettled([
        bridgeJson<{ server_info: { version: string }; auth_method?: string }>('/v1/auth/status', { timeout: 5000 }),
        bridgeJson<{ privacy: { enabled: boolean; language: string; entities?: string[] } }>('/v1/privacy/status', { timeout: 5000 }),
        bridgeJson<{ tiers?: ProviderTier[] }>('/v1/providers', { timeout: 5000 }),
      ]);

      setData({
        version: authRes.status === 'fulfilled' ? authRes.value.server_info?.version : undefined,
        auth_method: authRes.status === 'fulfilled' ? authRes.value.auth_method : undefined,
        privacy_enabled: privRes.status === 'fulfilled' ? privRes.value.privacy?.enabled : undefined,
        privacy_language: privRes.status === 'fulfilled' ? privRes.value.privacy?.language : undefined,
        privacy_entities: privRes.status === 'fulfilled' ? privRes.value.privacy?.entities : undefined,
        providers: provRes.status === 'fulfilled' ? provRes.value.tiers : undefined,
      });
    }
    load();
  }, []);

  return (
    <div
      data-ai-id="bridge-help-overlay"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'absolute', inset: 0, zIndex: 100,
        background: 'rgba(0,0,0,0.6)', display: 'flex',
        alignItems: 'flex-start', justifyContent: 'center', paddingTop: 40,
        overflow: 'auto',
      }}
    >
      <div style={{
        background: 'var(--tn-surface)', border: '1px solid var(--tn-border)',
        borderRadius: 8, width: '90%', maxWidth: 500, padding: 16,
        maxHeight: 'calc(100vh - 100px)', overflow: 'auto',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ fontSize: 14, fontWeight: 700, margin: 0, color: 'var(--tn-text)' }}>Bridge Info</h3>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', color: 'var(--tn-text-muted)',
            fontSize: 16, cursor: 'pointer', padding: '2px 6px',
          }}>X</button>
        </div>

        {/* Config */}
        <Section title="Bridge Configuration">
          <Row label="Version" value={data.version ?? '...'} mono />
          <Row label="Auth" value={data.auth_method ?? '...'} />
        </Section>

        {/* Privacy */}
        <Section title="Privacy (Presidio)">
          <Row label="Enabled" value={
            data.privacy_enabled != null
              ? <StatusBadge status={data.privacy_enabled ? 'ok' : 'error'} label={data.privacy_enabled ? 'ON' : 'OFF'} />
              : '...'
          } />
          <Row label="Language" value={data.privacy_language ?? '...'} />
          {data.privacy_entities && data.privacy_entities.length > 0 && (
            <div style={{ padding: '6px 0' }}>
              <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginBottom: 4 }}>Protected Entities</div>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {data.privacy_entities.map(e => (
                  <span key={e} style={{
                    fontSize: 8, padding: '1px 5px', borderRadius: 2,
                    background: 'rgba(158,206,106,0.15)', color: 'var(--tn-green)',
                    fontFamily: 'monospace',
                  }}>{e}</span>
                ))}
              </div>
            </div>
          )}
        </Section>

        {/* Provider Tiers */}
        {data.providers && data.providers.length > 0 && (
          <Section title="Provider Tiers">
            {data.providers.map((p, i) => (
              <div key={i} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '5px 0', borderBottom: '1px solid var(--tn-border)',
              }}>
                <div>
                  <span style={{ fontSize: 11, color: 'var(--tn-text)', fontWeight: 500 }}>{p.name}</span>
                  <span style={{ fontSize: 9, color: 'var(--tn-text-muted)', marginLeft: 6 }}>{p.model}</span>
                </div>
                {p.dsgvo_compliant && (
                  <StatusBadge status="ok" label="DSGVO" />
                )}
              </div>
            ))}
          </Section>
        )}

        {/* Pricing Reference */}
        <Section title="Pricing Reference (per 1M tokens)">
          {PRICING.map(p => (
            <div key={p.model} style={{
              display: 'grid', gridTemplateColumns: '1fr 80px 80px',
              padding: '4px 0', borderBottom: '1px solid var(--tn-border)', fontSize: 10,
            }}>
              <span style={{ color: 'var(--tn-text)' }}>{p.label}</span>
              <span style={{ textAlign: 'right', color: 'var(--tn-text-muted)', fontFamily: 'monospace' }}>${p.input.toFixed(2)} in</span>
              <span style={{ textAlign: 'right', color: 'var(--tn-text-muted)', fontFamily: 'monospace' }}>${p.output.toFixed(2)} out</span>
            </div>
          ))}
        </Section>
      </div>
    </div>
  );
}
