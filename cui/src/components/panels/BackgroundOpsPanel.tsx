/**
 * Background Ops Panel — Shows Peer Awareness, AutoInject, and system events.
 *
 * Polls /api/background-ops (events), /api/peer-awareness (status), /api/auto-inject (configs).
 * Auto-refreshes every 15s.
 */
import { useState, useEffect, useCallback, useRef } from 'react';

const REFRESH_MS = 15_000;

interface BgEvent {
  timestamp: string;
  source: 'peer' | 'autoinject' | 'bridge' | 'system';
  type: string;
  message: string;
  meta?: Record<string, unknown>;
}

interface BgOpsData {
  events: BgEvent[];
  eventCount: number;
  maxEvents: number;
  bridgeKeySet: boolean;
  serverUptime: number;
}

interface PeerData {
  lastTickAt: string | null;
  activeSessions: number;
  recentSessions: number;
  intervalMs: number;
}

interface AutoInjectConfig {
  accountId: string;
  sessionId: string;
  enabled: boolean;
  intervalMs: number;
  message: string;
}

interface AutoInjectData {
  configs: Record<string, AutoInjectConfig>;
  lastInject: Record<string, string>;
}

const SOURCE_COLORS: Record<string, string> = {
  peer: 'var(--tn-cyan)',
  autoinject: 'var(--tn-blue)',
  bridge: 'var(--tn-purple, #bb9af7)',
  system: 'var(--tn-text-muted)',
};

const TYPE_ICONS: Record<string, string> = {
  tick: '●',
  inject: '▶',
  skip: '○',
  error: '✗',
  degraded: '▲',
  start: '▷',
  stop: '■',
  summary: '◆',
};

function formatAge(isoDate: string | null | undefined): string {
  if (!isoDate) return 'nie';
  const age = Date.now() - new Date(isoDate).getTime();
  if (age < 0) return 'gerade';
  if (age < 60_000) return `${Math.round(age / 1000)}s`;
  if (age < 3_600_000) return `${Math.round(age / 60_000)}min`;
  if (age < 86_400_000) return `${Math.round(age / 3_600_000)}h`;
  return `${Math.round(age / 86_400_000)}d`;
}

function formatUptime(seconds: number): string {
  if (seconds < 3600) return `${Math.round(seconds / 60)}min`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}min`;
  return `${Math.round(seconds / 86400)}d`;
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return iso;
  }
}

export default function BackgroundOpsPanel() {
  const [opsData, setOpsData] = useState<BgOpsData | null>(null);
  const [peerData, setPeerData] = useState<PeerData | null>(null);
  const [injectData, setInjectData] = useState<AutoInjectData | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchAll = useCallback(async () => {
    if ((window as unknown as Record<string, unknown>).__cuiServerAlive === false) return;
    try {
      const [opsRes, peerRes, injectRes] = await Promise.all([
        fetch('/api/background-ops', { signal: AbortSignal.timeout(5000) }),
        fetch('/api/peer-awareness', { signal: AbortSignal.timeout(5000) }),
        fetch('/api/auto-inject', { signal: AbortSignal.timeout(5000) }),
      ]);
      if (opsRes.ok) setOpsData(await opsRes.json());
      if (peerRes.ok) setPeerData(await peerRes.json());
      if (injectRes.ok) setInjectData(await injectRes.json());
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
    timerRef.current = setInterval(fetchAll, REFRESH_MS);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [fetchAll]);

  if (loading) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--tn-text-muted)', fontSize: 11 }}>
        Loading background ops...
      </div>
    );
  }

  const bridgeOk = opsData?.bridgeKeySet ?? false;
  const peerAge = formatAge(peerData?.lastTickAt);
  const nextTickIn = peerData?.lastTickAt
    ? Math.max(0, (peerData.intervalMs - (Date.now() - new Date(peerData.lastTickAt).getTime())) / 60_000)
    : null;

  const enabledInjects = injectData
    ? Object.values(injectData.configs).filter(c => c.enabled).length
    : 0;
  const totalInjects = injectData
    ? Object.keys(injectData.configs).length
    : 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--tn-bg)' }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px',
        background: 'var(--tn-bg-dark)', borderBottom: '1px solid var(--tn-border)',
        height: 30, flexShrink: 0, fontSize: 11,
      }}>
        <span style={{ fontWeight: 600, color: 'var(--tn-cyan)', fontSize: 12 }}>
          BACKGROUND OPS
        </span>
        <span style={{
          display: 'inline-block', width: 6, height: 6, borderRadius: '50%',
          background: bridgeOk ? 'var(--tn-green)' : 'var(--tn-orange)',
        }} />
        <span style={{ color: 'var(--tn-text-muted)' }}>
          Bridge: {bridgeOk ? 'connected' : 'missing key'}
        </span>
        {opsData && (
          <span style={{ color: 'var(--tn-text-muted)', marginLeft: 'auto' }}>
            up {formatUptime(opsData.serverUptime)}
          </span>
        )}
      </div>

      {/* Error */}
      {error && (
        <div style={{
          padding: '4px 8px', fontSize: 11, background: 'rgba(247, 118, 142, 0.1)',
          borderBottom: '1px solid rgba(247, 118, 142, 0.3)', color: '#f7768e',
        }}>
          {error}
        </div>
      )}

      {/* Scrollable Content */}
      <div style={{ flex: 1, overflow: 'auto', fontSize: 11 }}>
        {/* Peer Awareness Section */}
        <div style={{ padding: '6px 10px', borderBottom: '1px solid var(--tn-border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <span style={{ fontWeight: 600, color: 'var(--tn-cyan)', fontSize: 11 }}>PEER AWARENESS</span>
            <span style={{
              display: 'inline-block', width: 5, height: 5, borderRadius: '50%',
              background: bridgeOk ? 'var(--tn-green)' : 'var(--tn-orange)',
            }} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px 12px', color: 'var(--tn-text)' }}>
            <span>Sessions: <strong>{peerData?.activeSessions ?? 0}</strong> aktiv{(peerData?.recentSessions ?? 0) > 0 && `, ${peerData?.recentSessions} recent`}</span>
            <span>Last tick: <strong style={{ color: peerAge === 'nie' ? 'var(--tn-orange)' : 'var(--tn-text)' }}>{peerAge}</strong></span>
            <span>Interval: {(peerData?.intervalMs ?? 300_000) / 1000}s</span>
            <span>Next: ~{nextTickIn !== null ? `${Math.round(nextTickIn)}min` : '?'}</span>
          </div>
        </div>

        {/* AutoInject Section */}
        <div style={{ padding: '6px 10px', borderBottom: '1px solid var(--tn-border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <span style={{ fontWeight: 600, color: 'var(--tn-blue)', fontSize: 11 }}>AUTOINJECT</span>
            <span style={{ color: 'var(--tn-text-muted)' }}>{enabledInjects}/{totalInjects} enabled</span>
          </div>
          {injectData && Object.entries(injectData.configs).length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {Object.entries(injectData.configs).map(([id, cfg]) => (
                <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--tn-text)' }}>
                  <span style={{
                    display: 'inline-block', width: 5, height: 5, borderRadius: '50%',
                    background: cfg.enabled ? 'var(--tn-green)' : 'var(--tn-red)',
                  }} />
                  <span style={{ fontWeight: 500, minWidth: 70 }}>{id}</span>
                  <span style={{ color: cfg.enabled ? 'var(--tn-green)' : 'var(--tn-text-muted)' }}>
                    {cfg.enabled ? 'enabled' : 'disabled'}
                  </span>
                  <span style={{ color: 'var(--tn-text-muted)', marginLeft: 'auto' }}>
                    last: {formatAge(injectData.lastInject[id])}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <span style={{ color: 'var(--tn-text-muted)', fontStyle: 'italic' }}>Keine Configs</span>
          )}
        </div>

        {/* Event Log */}
        <div style={{ padding: '6px 10px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <span style={{ fontWeight: 600, color: 'var(--tn-text)', fontSize: 11 }}>EVENT LOG</span>
            <span style={{ color: 'var(--tn-text-muted)' }}>
              {opsData?.eventCount ?? 0}/{opsData?.maxEvents ?? 100}
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {opsData && opsData.events.length > 0 ? (
              [...opsData.events].reverse().map((ev, i) => (
                <div key={i} style={{
                  display: 'flex', alignItems: 'flex-start', gap: 6,
                  padding: '1px 0',
                  opacity: i > 20 ? 0.5 : 1,
                }}>
                  <span style={{ color: 'var(--tn-text-muted)', minWidth: 55, flexShrink: 0 }}>
                    {formatTime(ev.timestamp)}
                  </span>
                  <span style={{
                    color: ev.type === 'error' ? 'var(--tn-red)' : ev.type === 'degraded' ? 'var(--tn-orange)' : SOURCE_COLORS[ev.source] || 'var(--tn-text)',
                    minWidth: 10,
                  }}>
                    {TYPE_ICONS[ev.type] || '·'}
                  </span>
                  <span style={{
                    color: SOURCE_COLORS[ev.source] || 'var(--tn-text-muted)',
                    minWidth: 55, flexShrink: 0,
                    fontWeight: 500,
                  }}>
                    [{ev.source}]
                  </span>
                  <span style={{
                    color: ev.type === 'error' ? 'var(--tn-red)' : ev.type === 'degraded' ? 'var(--tn-orange)' : 'var(--tn-text)',
                    wordBreak: 'break-word',
                  }}>
                    {ev.message}
                  </span>
                </div>
              ))
            ) : (
              <span style={{ color: 'var(--tn-text-muted)', fontStyle: 'italic' }}>
                Noch keine Events. Erster Peer-Tick nach ~30s.
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Footer */}
      <div style={{
        padding: '2px 8px', fontSize: 10, color: 'var(--tn-text-muted)',
        borderTop: '1px solid var(--tn-border)', background: 'var(--tn-bg-dark)',
        display: 'flex', gap: 8,
      }}>
        <span>Poll: {REFRESH_MS / 1000}s</span>
        <span>Events: {opsData?.eventCount ?? 0}/{opsData?.maxEvents ?? 100}</span>
        {opsData && <span style={{ marginLeft: 'auto' }}>Uptime: {formatUptime(opsData.serverUptime)}</span>}
      </div>
    </div>
  );
}
