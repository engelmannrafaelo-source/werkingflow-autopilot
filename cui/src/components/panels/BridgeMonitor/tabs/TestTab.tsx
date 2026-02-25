import { useState, useCallback } from 'react';
import { BRIDGE_URL, authHeaders, StatusBadge, ActionButton, Section, Toolbar, ErrorBanner } from '../shared';

interface PingResult {
  ok: boolean;
  latency: number;
  status?: string;
  worker?: string;
  error?: string;
}

interface MessageResult {
  ok: boolean;
  latency: number;
  response?: string;
  model?: string;
  tokens?: { input: number; output: number };
  error?: string;
}

function ResultBox({ ok, latency, children }: { ok: boolean; latency?: number; children: React.ReactNode }) {
  return (
    <div style={{
      marginTop: 8, padding: '8px 10px', borderRadius: 5,
      background: ok ? 'rgba(158,206,106,0.07)' : 'rgba(247,118,142,0.07)',
      border: `1px solid ${ok ? 'rgba(158,206,106,0.3)' : 'rgba(247,118,142,0.3)'}`,
      fontSize: 11,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
        <StatusBadge status={ok ? 'ok' : 'error'} />
        {latency != null && (
          <span style={{ fontSize: 10, color: 'var(--tn-text-muted)', fontFamily: 'monospace' }}>{latency}ms</span>
        )}
      </div>
      {children}
    </div>
  );
}

export default function TestTab() {
  const [pingLoading, setPingLoading] = useState(false);
  const [pingResult, setPingResult] = useState<PingResult | null>(null);

  const [msgLoading, setMsgLoading] = useState(false);
  const [msgResult, setMsgResult] = useState<MessageResult | null>(null);
  const [msgText, setMsgText] = useState('Sage kurz Hallo und bestätige dass du erreichbar bist.');

  const [model, setModel] = useState('claude-haiku-4-5-20251001');

  const handlePing = useCallback(async () => {
    setPingLoading(true);
    setPingResult(null);
    const t0 = Date.now();
    try {
      const res = await fetch(`${BRIDGE_URL}/health`);
      const data = await res.json();
      const latency = Date.now() - t0;
      setPingResult({
        ok: res.ok && data.status === 'healthy',
        latency,
        status: data.status,
        worker: data.worker_instance,
      });
    } catch (err: any) {
      setPingResult({ ok: false, latency: Date.now() - t0, error: err.message });
    } finally {
      setPingLoading(false);
    }
  }, []);

  const handleSendMessage = useCallback(async () => {
    if (!msgText.trim()) return;
    setMsgLoading(true);
    setMsgResult(null);
    const t0 = Date.now();
    try {
      const res = await fetch(`${BRIDGE_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders(),
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: msgText }],
          max_tokens: 100,
        }),
      });
      const latency = Date.now() - t0;
      if (!res.ok) {
        const text = await res.text();
        setMsgResult({ ok: false, latency, error: text });
        return;
      }
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content ?? '(keine Antwort)';
      setMsgResult({
        ok: true,
        latency,
        response: content,
        model: data.model,
        tokens: data.usage ? { input: data.usage.prompt_tokens, output: data.usage.completion_tokens } : undefined,
      });
    } catch (err: any) {
      setMsgResult({ ok: false, latency: Date.now() - t0, error: err.message });
    } finally {
      setMsgLoading(false);
    }
  }, [msgText, model]);

  const handlePrivacyCheck = useCallback(async () => {
    setPingLoading(true);
    setPingResult(null);
    const t0 = Date.now();
    try {
      const res = await fetch(`${BRIDGE_URL}/v1/privacy/status`);
      const data = await res.json();
      const latency = Date.now() - t0;
      const priv = data.privacy;
      setPingResult({
        ok: res.ok && priv?.enabled,
        latency,
        status: priv ? `Presidio ${priv.enabled ? 'aktiv' : 'inaktiv'} (${priv.language}) · ${priv.supported_entities?.length ?? 0} Entities` : JSON.stringify(data).slice(0, 120),
      });
    } catch (err: any) {
      setPingResult({ ok: false, latency: Date.now() - t0, error: err.message });
    } finally {
      setPingLoading(false);
    }
  }, []);

  const handleLbCheck = useCallback(async () => {
    setPingLoading(true);
    setPingResult(null);
    const t0 = Date.now();
    try {
      const res = await fetch(`${BRIDGE_URL}/lb-status`);
      const data = await res.json();
      const latency = Date.now() - t0;
      setPingResult({
        ok: res.ok && data.status === 'healthy',
        latency,
        status: `${data.workers} Workers · ${data.strategy} · Failover: ${data.failover} · Paused: ${data.paused?.length ?? 0}`,
      });
    } catch (err: any) {
      setPingResult({ ok: false, latency: Date.now() - t0, error: err.message });
    } finally {
      setPingLoading(false);
    }
  }, []);

  return (
    <div style={{ padding: 12 }}>
      {/* Ping */}
      <Section title="Erreichbarkeit">
        <div style={{ fontSize: 11, color: 'var(--tn-text-muted)', marginBottom: 10 }}>
          Schnelle Tests der Bridge-Endpoints.
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <ActionButton label="Health-Ping" loading={pingLoading} onClick={handlePing} color="var(--tn-blue)" />
          <ActionButton label="LB-Status" loading={pingLoading} onClick={handleLbCheck} color="var(--tn-blue)" />
          <ActionButton label="Presidio-Check" loading={pingLoading} onClick={handlePrivacyCheck} color="var(--tn-purple, #9d7cd8)" />
        </div>
        {pingResult && (
          <ResultBox ok={pingResult.ok} latency={pingResult.latency}>
            {pingResult.status && <div style={{ color: 'var(--tn-text)', fontFamily: 'monospace', wordBreak: 'break-all', fontSize: 10 }}>{pingResult.status}</div>}
            {pingResult.worker && <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', marginTop: 2 }}>Worker: {pingResult.worker}</div>}
            {pingResult.error && <div style={{ color: 'var(--tn-red)', fontFamily: 'monospace' }}>{pingResult.error}</div>}
          </ResultBox>
        )}
      </Section>

      {/* Test Message */}
      <Section title="Test-Nachricht senden">
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginBottom: 4 }}>Modell</div>
          <select
            value={model}
            onChange={e => setModel(e.target.value)}
            style={{
              background: 'var(--tn-bg)', color: 'var(--tn-text)',
              border: '1px solid var(--tn-border)', borderRadius: 4,
              padding: '4px 8px', fontSize: 11, width: '100%', cursor: 'pointer',
            }}
          >
            <option value="claude-haiku-4-5-20251001">Haiku 4.5 (schnell, günstig)</option>
            <option value="claude-sonnet-4-5-20250929">Sonnet 4.5 (Standard)</option>
            <option value="claude-opus-4-6">Opus 4.6 (Premium)</option>
          </select>
        </div>
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginBottom: 4 }}>Nachricht</div>
          <textarea
            value={msgText}
            onChange={e => setMsgText(e.target.value)}
            rows={3}
            style={{
              width: '100%', background: 'var(--tn-bg)', color: 'var(--tn-text)',
              border: '1px solid var(--tn-border)', borderRadius: 4,
              padding: '6px 8px', fontSize: 11, resize: 'vertical',
              fontFamily: 'inherit', boxSizing: 'border-box',
            }}
          />
        </div>
        <ActionButton label="Senden" loading={msgLoading} onClick={handleSendMessage} color="var(--tn-green)" />

        {msgResult && (
          <ResultBox ok={msgResult.ok} latency={msgResult.latency}>
            {msgResult.response && (
              <div style={{ color: 'var(--tn-text)', marginBottom: 4, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {msgResult.response}
              </div>
            )}
            {msgResult.model && (
              <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', fontFamily: 'monospace', marginTop: 4 }}>
                Modell: {msgResult.model}
                {msgResult.tokens && ` · ${msgResult.tokens.input} in / ${msgResult.tokens.output} out Tokens`}
              </div>
            )}
            {msgResult.error && (
              <div style={{ color: 'var(--tn-red)', fontFamily: 'monospace', fontSize: 10, whiteSpace: 'pre-wrap' }}>{msgResult.error}</div>
            )}
          </ResultBox>
        )}
      </Section>
    </div>
  );
}
