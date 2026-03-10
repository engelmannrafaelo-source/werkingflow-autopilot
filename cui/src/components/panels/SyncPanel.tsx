import React, { useState, useEffect, useCallback, useRef } from 'react';

interface ConvSnapshot {
  sessionId: string;
  accountId: string;
  title: string;
  workDir: string;
  summary: string;
  filesEdited: string[];
}

interface SyncCluster {
  id: string;
  label: string;
  conversations: ConvSnapshot[];
}

interface SyncFeedback {
  sessionId: string;
  accountId: string;
  feedbackPrompt: string;
  conflicts: string[];
}

type SyncPhase = 'idle' | 'discovering' | 'clustering' | 'stopping' | 'analyzing' | 'injecting' | 'complete' | 'error' | 'aborted';

interface SyncState {
  phase: SyncPhase;
  message: string;
  startedAt?: number;
  completedAt?: number;
  snapshots: ConvSnapshot[];
  clusters: SyncCluster[];
  feedback: SyncFeedback[];
  error?: string;
  stoppedSessions: string[];
  resumedSessions: string[];
}

const PHASES: SyncPhase[] = ['discovering', 'clustering', 'stopping', 'analyzing', 'injecting', 'complete'];
const PHASE_LABELS: Record<string, string> = {
  discovering: 'Discover',
  clustering: 'Cluster',
  stopping: 'Stop',
  analyzing: 'Analyze',
  injecting: 'Resume',
  complete: 'Done',
};

export function SyncPanel({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<SyncState | null>(null);
  const [loading, setLoading] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const r = await fetch('/api/sync/status', { signal: AbortSignal.timeout(5000) });
      if (r.ok) setState(await r.json());
    } catch { /* ignore */ }
  }, []);

  // Poll while running
  useEffect(() => {
    fetchStatus();
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetchStatus]);

  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    const isRunning = state && !['idle', 'complete', 'error', 'aborted'].includes(state.phase);
    if (isRunning) {
      pollRef.current = setInterval(fetchStatus, 2000);
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [state?.phase, fetchStatus]);

  // WebSocket listener for real-time updates
  useEffect(() => {
    const handleMsg = (e: MessageEvent) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'sync-state' && msg.state) setState(msg.state);
      } catch { /* ignore */ }
    };
    // Find existing WebSocket (SessionStore broadcasts on window)
    const handler = (e: any) => {
      if (e.detail?.type === 'sync-state' && e.detail?.state) setState(e.detail.state);
    };
    window.addEventListener('cui-ws-message', handler);
    return () => window.removeEventListener('cui-ws-message', handler);
  }, []);

  const startSync = async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/sync/start', { method: 'POST' });
      const d = await r.json();
      if (d.ok) fetchStatus();
    } catch { /* ignore */ }
    setLoading(false);
  };

  const abortSync = async () => {
    try {
      await fetch('/api/sync/abort', { method: 'POST' });
      fetchStatus();
    } catch { /* ignore */ }
  };

  const phase = state?.phase || 'idle';
  const isRunning = !['idle', 'complete', 'error', 'aborted'].includes(phase);
  const phaseIdx = PHASES.indexOf(phase as SyncPhase);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--tn-bg)', color: 'var(--tn-text)' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid var(--tn-border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 16, fontWeight: 700, color: '#bb9af7' }}>Synchronise</span>
          {isRunning && <span style={{ fontSize: 11, color: 'var(--tn-text-muted)', animation: 'pulse 2s infinite' }}>{state?.message}</span>}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {isRunning && (
            <button onClick={abortSync} style={{ ...btnStyle, background: '#f7768e22', color: '#f7768e', border: '1px solid #f7768e44' }}>
              Abort
            </button>
          )}
          <button onClick={onClose} style={{ ...btnStyle, color: 'var(--tn-text-muted)' }}>X</button>
        </div>
      </div>

      {/* Progress Bar */}
      {(isRunning || phase === 'complete') && (
        <div style={{ display: 'flex', padding: '8px 16px', gap: 4, borderBottom: '1px solid var(--tn-border)' }}>
          {PHASES.map((p, i) => {
            const isCurrent = phase === p;
            const isDone = phaseIdx > i || phase === 'complete';
            return (
              <div key={p} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                <div style={{
                  height: 4, width: '100%', borderRadius: 2,
                  background: isDone ? '#9ece6a' : isCurrent ? '#bb9af7' : 'var(--tn-border)',
                  transition: 'background 0.3s',
                }} />
                <span style={{ fontSize: 10, color: isCurrent ? '#bb9af7' : isDone ? '#9ece6a' : 'var(--tn-text-muted)' }}>
                  {PHASE_LABELS[p]}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Content */}
      <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
        {/* Idle State */}
        {phase === 'idle' && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 16 }}>
            <div style={{ fontSize: 14, color: 'var(--tn-text-muted)', textAlign: 'center', maxWidth: 400 }}>
              Synchronise analysiert alle aktiven Conversations, gruppiert sie thematisch, und prueft auf Konflikte und Inkonsistenzen.
            </div>
            <button onClick={startSync} disabled={loading} style={{
              ...btnStyle, padding: '12px 32px', fontSize: 14, fontWeight: 700,
              background: '#bb9af722', color: '#bb9af7', border: '1px solid #bb9af744',
              cursor: loading ? 'wait' : 'pointer',
            }}>
              {loading ? 'Starte...' : 'Sync starten'}
            </button>
          </div>
        )}

        {/* Error State */}
        {phase === 'error' && (
          <div style={{ padding: 16 }}>
            <div style={{ padding: 12, background: '#f7768e11', border: '1px solid #f7768e33', borderRadius: 6, marginBottom: 16 }}>
              <div style={{ color: '#f7768e', fontWeight: 600, marginBottom: 4 }}>Fehler</div>
              <div style={{ color: 'var(--tn-text-muted)', fontSize: 13 }}>{state?.error || state?.message}</div>
            </div>
            <button onClick={startSync} style={{ ...btnStyle, background: '#bb9af722', color: '#bb9af7', border: '1px solid #bb9af744' }}>
              Erneut starten
            </button>
          </div>
        )}

        {/* Aborted State */}
        {phase === 'aborted' && (
          <div style={{ padding: 16 }}>
            <div style={{ padding: 12, background: '#e0af6811', border: '1px solid #e0af6833', borderRadius: 6, marginBottom: 16 }}>
              <div style={{ color: '#e0af68', fontWeight: 600 }}>Abgebrochen</div>
              <div style={{ color: 'var(--tn-text-muted)', fontSize: 13, marginTop: 4 }}>{state?.message}</div>
            </div>
            <button onClick={startSync} style={{ ...btnStyle, background: '#bb9af722', color: '#bb9af7', border: '1px solid #bb9af744' }}>
              Neu starten
            </button>
          </div>
        )}

        {/* Running: Show snapshots during discover */}
        {phase === 'discovering' && state?.snapshots && state.snapshots.length > 0 && (
          <div>
            <div style={{ fontSize: 12, color: 'var(--tn-text-muted)', marginBottom: 8 }}>{state.snapshots.length} Conversations analysiert</div>
            {state.snapshots.map(s => (
              <div key={s.sessionId} style={{ ...cardStyle, marginBottom: 4 }}>
                <span style={{ fontWeight: 600, fontSize: 12 }}>{s.title}</span>
                <span style={{ fontSize: 11, color: 'var(--tn-text-muted)', marginLeft: 8 }}>{s.workDir}</span>
              </div>
            ))}
          </div>
        )}

        {/* Clusters view */}
        {(phase === 'clustering' || phase === 'stopping' || phase === 'analyzing' || phase === 'injecting' || phase === 'complete') && state?.clusters && state.clusters.length > 0 && (
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12, color: '#bb9af7' }}>
              {state.clusters.length} Cluster
            </div>
            {state.clusters.map(cluster => (
              <div key={cluster.id} style={{ ...cardStyle, marginBottom: 12, padding: 12 }}>
                <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8, color: '#bb9af7' }}>
                  {cluster.label}
                  <span style={{ fontWeight: 400, color: 'var(--tn-text-muted)', marginLeft: 8, fontSize: 11 }}>
                    {cluster.conversations.length} Conversations
                  </span>
                </div>
                {cluster.conversations.map(conv => {
                  const fb = state.feedback?.find(f => f.sessionId === conv.sessionId);
                  const hasConflicts = fb && fb.conflicts.length > 0;
                  const wasResumed = state.resumedSessions?.includes(conv.sessionId);
                  return (
                    <div key={conv.sessionId} style={{
                      padding: '6px 8px', marginBottom: 4, borderRadius: 4, fontSize: 12,
                      background: hasConflicts ? '#f7768e08' : 'var(--tn-surface)',
                      borderLeft: hasConflicts ? '3px solid #f7768e' : wasResumed ? '3px solid #9ece6a' : '3px solid transparent',
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontWeight: 600 }}>{conv.title}</span>
                        <span style={{ fontSize: 10, color: 'var(--tn-text-muted)' }}>
                          {conv.sessionId.slice(0, 8)}
                          {wasResumed && <span style={{ color: '#9ece6a', marginLeft: 4 }}>resumed</span>}
                        </span>
                      </div>
                      {conv.filesEdited.length > 0 && (
                        <div style={{ fontSize: 11, color: 'var(--tn-text-muted)', marginTop: 2 }}>
                          Files: {conv.filesEdited.slice(0, 3).map(f => f.split('/').pop()).join(', ')}
                          {conv.filesEdited.length > 3 && ` +${conv.filesEdited.length - 3}`}
                        </div>
                      )}
                      {fb && (
                        <div style={{ marginTop: 4 }}>
                          <div style={{ fontSize: 11, color: hasConflicts ? '#f7768e' : '#9ece6a' }}>
                            {fb.feedbackPrompt.replace(/^\[Sync[^\]]*\]\s*/, '')}
                          </div>
                          {fb.conflicts.map((c, i) => (
                            <div key={i} style={{ fontSize: 11, color: '#f7768e', marginTop: 2, paddingLeft: 8 }}>
                              - {c}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}

        {/* Complete summary */}
        {phase === 'complete' && state && (
          <div style={{ marginTop: 16, padding: 12, background: '#9ece6a11', border: '1px solid #9ece6a33', borderRadius: 6 }}>
            <div style={{ color: '#9ece6a', fontWeight: 700, marginBottom: 4 }}>Sync abgeschlossen</div>
            <div style={{ fontSize: 12, color: 'var(--tn-text-muted)' }}>
              {state.clusters.length} Cluster | {state.feedback.length} Feedback |{' '}
              {state.feedback.reduce((s, f) => s + f.conflicts.length, 0)} Konflikte |{' '}
              {state.resumedSessions?.length || 0} resumed
            </div>
            <div style={{ marginTop: 8 }}>
              <button onClick={startSync} style={{ ...btnStyle, fontSize: 12, background: '#bb9af722', color: '#bb9af7', border: '1px solid #bb9af744' }}>
                Erneut synchronisieren
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  padding: '6px 12px',
  borderRadius: 4,
  border: '1px solid var(--tn-border)',
  background: 'transparent',
  cursor: 'pointer',
  fontSize: 12,
  fontFamily: 'inherit',
};

const cardStyle: React.CSSProperties = {
  padding: '8px 10px',
  borderRadius: 6,
  border: '1px solid var(--tn-border)',
  background: 'var(--tn-surface)',
};
