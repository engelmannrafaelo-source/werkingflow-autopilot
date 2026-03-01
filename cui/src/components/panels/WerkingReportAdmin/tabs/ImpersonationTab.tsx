import { useState, useEffect, useCallback } from 'react';

interface ImpersonationSession {
  id: string;
  adminId: string;
  adminEmail: string;
  targetUserId: string;
  targetEmail: string;
  tenantId: string;
  startedAt: string;
  expiresAt: string;
  ipAddress: string;
  userAgent: string;
}

export default function ImpersonationTab({ envMode }: { envMode?: string }) {
  const [sessions, setSessions] = useState<ImpersonationSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [processingIds, setProcessingIds] = useState<Set<string>>(new Set());

  const fetchSessions = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/admin/wr/impersonation');
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setSessions(data.sessions || []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSessions();
    // Auto-refresh every 10s
    const interval = setInterval(fetchSessions, 10000);
    return () => clearInterval(interval);
  }, [fetchSessions, envMode]);

  const handleEndSession = async (session: ImpersonationSession) => {
    if (!confirm(`End impersonation session for ${session.adminEmail} → ${session.targetEmail}?`)) return;
    const sessionId = session.id;
    setProcessingIds(prev => new Set(prev).add(sessionId));
    try {
      const res = await fetch(`/api/admin/wr/impersonation/${sessionId}/end`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      await fetchSessions();
    } catch (err: any) {
      alert(`Failed to end session: ${err.message}`);
    } finally {
      setProcessingIds(prev => { const next = new Set(prev); next.delete(sessionId); return next; });
    }
  };

  return (
    <div data-ai-id="wr-impersonation-tab" style={{ padding: 12 }}>
      {/* Header Bar */}
      <div data-ai-id="wr-impersonation-header" style={{ display: 'flex', gap: 6, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <span data-ai-id="wr-impersonation-title" style={{ fontSize: 11, color: 'var(--tn-text-muted)', fontWeight: 600 }}>
          Active Impersonation Sessions
        </span>
        <div style={{ flex: 1 }} />
        <button data-ai-id="wr-impersonation-refresh-btn" onClick={fetchSessions} style={{
          padding: '3px 10px', borderRadius: 3, fontSize: 10, cursor: 'pointer',
          background: 'var(--tn-bg)', border: '1px solid var(--tn-border)', color: 'var(--tn-text-muted)',
        }}>Refresh</button>
      </div>

      {/* Error */}
      {error && (
        <div data-ai-id="wr-impersonation-error" style={{ padding: '4px 8px', fontSize: 11, color: 'var(--tn-red)', background: 'rgba(247,118,142,0.1)', borderRadius: 3, marginBottom: 8 }}>
          {error}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div data-ai-id="wr-impersonation-loading" style={{ padding: 20, textAlign: 'center', color: 'var(--tn-text-muted)', fontSize: 12 }}>Loading...</div>
      )}

      {/* Session Count */}
      {!loading && (
        <div data-ai-id="wr-impersonation-count" style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginBottom: 6 }}>
          {sessions.length} active session(s)
        </div>
      )}

      {/* Empty State */}
      {!loading && sessions.length === 0 && (
        <div data-ai-id="wr-impersonation-empty" style={{
          padding: 40,
          textAlign: 'center',
          color: 'var(--tn-text-muted)',
          fontSize: 12,
          background: 'var(--tn-bg-dark)',
          borderRadius: 6,
          border: '1px dashed var(--tn-border)',
        }}>
          No active impersonation sessions
        </div>
      )}

      {/* Session List */}
      {!loading && sessions.length > 0 && (
        <div data-ai-id="wr-impersonation-table">
          {/* Table Header */}
          <div data-ai-id="wr-impersonation-table-header" style={{
            display: 'grid', gridTemplateColumns: '1fr 1fr 200px 120px',
            gap: 8, padding: '6px 10px', background: 'var(--tn-bg-dark)', borderRadius: 4,
            fontSize: 10, fontWeight: 600, color: 'var(--tn-text-muted)', marginBottom: 4,
          }}>
            <div>Admin (Impersonating)</div>
            <div>Target User</div>
            <div>Started At</div>
            <div>Actions</div>
          </div>

          {/* Table Rows */}
          {sessions.map(session => {
            const isProcessing = processingIds.has(session.id);
            return (
              <div key={session.id} data-ai-id={`wr-impersonation-row-${session.id}`} style={{
                display: 'grid', gridTemplateColumns: '1fr 1fr 200px 120px',
                gap: 8, padding: '8px 10px', borderBottom: '1px solid var(--tn-border)',
                fontSize: 11, alignItems: 'center', opacity: isProcessing ? 0.5 : 1,
              }}>
                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  <span style={{ color: 'var(--tn-blue)', fontWeight: 600 }}>{session.adminEmail}</span>
                </div>
                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  <span style={{ color: 'var(--tn-text)' }}>{session.targetEmail}</span>
                </div>
                <div style={{ color: 'var(--tn-text-muted)', fontSize: 10 }}>
                  {new Date(session.startedAt).toLocaleString('de-DE', {
                    dateStyle: 'short',
                    timeStyle: 'medium'
                  })}
                </div>
                <div data-ai-id={`wr-impersonation-actions-${session.id}`}>
                  <button
                    data-ai-id={`wr-impersonation-end-${session.id}`}
                    onClick={() => handleEndSession(session)}
                    disabled={isProcessing}
                    style={{
                      padding: '3px 8px',
                      borderRadius: 3,
                      fontSize: 9,
                      cursor: isProcessing ? 'not-allowed' : 'pointer',
                      background: 'var(--tn-red)',
                      border: 'none',
                      color: '#fff',
                      fontWeight: 600,
                      opacity: isProcessing ? 0.5 : 1,
                    }}
                  >
                    {isProcessing ? '...' : 'End Session'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
