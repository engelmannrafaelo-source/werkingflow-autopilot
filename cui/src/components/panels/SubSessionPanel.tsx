import { useState, useEffect, useCallback, useRef } from 'react';

interface SubSession {
  sessionId: string;
  subject: string;
  parentSessionId?: string;
  parentSubject?: string;
  accountId: string;
  workDir: string;
  attentionState?: string;
  attentionReason?: string;
  lastSnippet?: string;
  updatedAt?: string;
}

interface SubSessionPanelProps {
  workDir?: string;
  isVisible?: boolean;
  onOpenSession?: (sessionId: string) => void;
}

const STATE_COLORS: Record<string, string> = {
  working: '#3b82f6',
  needs_attention: '#f59e0b',
  idle: '#6b7280',
};

const STATE_LABELS: Record<string, string> = {
  working: 'Arbeitet',
  needs_attention: 'Wartet',
  idle: 'Idle',
};

export default function SubSessionPanel({ workDir, isVisible = true, onOpenSession }: SubSessionPanelProps) {
  const [sessions, setSessions] = useState<SubSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchSessions = useCallback(async () => {
    if ((window as any).__cuiServerAlive === false) { setLoading(false); return; }
    try {
      const params = workDir ? `?workDir=${encodeURIComponent(workDir)}` : '';
      const resp = await fetch(`/api/mission/sub-sessions${params}`, { signal: AbortSignal.timeout(10000) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      setSessions(data.sessions || []);
      setError('');
    } catch (err) {
      setError((err as Error).message);
    }
    setLoading(false);
  }, [workDir]);

  useEffect(() => {
    if (!isVisible) return;
    fetchSessions();
    intervalRef.current = setInterval(fetchSessions, 10_000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [fetchSessions, isVisible]);

  if (loading) {
    return <div style={{ padding: 16, color: '#9ca3af' }}>Lade Sub-Sessions...</div>;
  }

  if (error) {
    return (
      <div style={{ padding: 16 }}>
        <div style={{ color: '#ef4444', marginBottom: 8 }}>Fehler: {error}</div>
        <button onClick={fetchSessions} style={btnStyle}>Retry</button>
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div style={{ padding: 16, color: '#6b7280', fontSize: 13 }}>
        Keine aktiven Sub-Sessions{workDir ? ' in diesem Workspace' : ''}.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: '#0f1117' }}>
      <div style={{ padding: '8px 12px', borderBottom: '1px solid #1e2130', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: '#e5e7eb' }}>
          Sub-Sessions ({sessions.length})
        </span>
        <button onClick={fetchSessions} style={btnStyle} title="Aktualisieren">↻</button>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: 4 }}>
        {sessions.map(s => (
          <SubSessionCard key={s.sessionId} session={s} onOpen={onOpenSession} />
        ))}
      </div>
    </div>
  );
}

function SubSessionCard({ session, onOpen }: { session: SubSession; onOpen?: (sid: string) => void }) {
  const stateColor = STATE_COLORS[session.attentionState || 'idle'] || '#6b7280';
  const stateLabel = STATE_LABELS[session.attentionState || 'idle'] || session.attentionState || 'unknown';
  const shortId = session.sessionId.slice(0, 8);
  const subject = session.subject?.replace(/^\[Sub\]\s*/, '').replace(/^[^-]+ - /, '') || shortId;

  return (
    <div
      style={{
        margin: '4px 8px',
        padding: '8px 10px',
        background: '#161926',
        borderRadius: 6,
        borderLeft: `3px solid ${stateColor}`,
        cursor: onOpen ? 'pointer' : 'default',
      }}
      onClick={() => onOpen?.(session.sessionId)}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: '#e5e7eb', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {subject}
        </span>
        <span style={{
          fontSize: 10,
          padding: '1px 6px',
          borderRadius: 8,
          background: stateColor + '22',
          color: stateColor,
          fontWeight: 500,
          marginLeft: 8,
          flexShrink: 0,
        }}>
          {stateLabel}
        </span>
      </div>
      {session.parentSubject && (
        <div style={{ fontSize: 10, color: '#6b7280', marginBottom: 3 }}>
          Parent: {session.parentSubject}
        </div>
      )}
      {session.lastSnippet && (
        <div style={{ fontSize: 11, color: '#9ca3af', lineHeight: 1.3, maxHeight: 40, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {session.lastSnippet}
        </div>
      )}
      <div style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>
        {shortId} · {session.accountId}
        {session.updatedAt && ` · ${new Date(session.updatedAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`}
      </div>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  background: '#1e2130',
  border: '1px solid #2d3148',
  borderRadius: 4,
  color: '#9ca3af',
  cursor: 'pointer',
  fontSize: 12,
  padding: '2px 8px',
};
