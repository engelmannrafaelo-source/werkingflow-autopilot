import { useState, useEffect, useCallback } from 'react';
import { bridgeJson, bridgeFetch, StatusBadge, StatCard, Toolbar, ErrorBanner, LoadingSpinner, SectionFlat, timeAgo, formatDuration } from '../shared';

interface CliSessionStats {
  total: number;
  running: number;
  completed: number;
  cancelled: number;
  failed: number;
}

interface CliSession {
  session_id: string;
  status: 'running' | 'completed' | 'cancelled' | 'failed';
  model?: string;
  query?: string;
  created_at?: string;
  completed_at?: string;
  duration_seconds?: number;
  output_file?: string;
}

interface SessionStats {
  active_sessions: number;
  expired_sessions: number;
  total_messages: number;
}

interface ConvSession {
  session_id: string;
  message_count: number;
  created_at?: string;
  last_activity?: string;
}

export default function SessionsTab() {
  const [cliStats, setCliStats] = useState<CliSessionStats | null>(null);
  const [cliSessions, setCliSessions] = useState<CliSession[]>([]);
  const [sessionStats, setSessionStats] = useState<SessionStats | null>(null);
  const [convSessions, setConvSessions] = useState<ConvSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [filter, setFilter] = useState<'all' | 'running' | 'completed' | 'failed'>('all');

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [cliStatsRes, cliListRes, sessStatsRes, sessListRes] = await Promise.allSettled([
        bridgeJson<{ cli_session_stats: CliSessionStats }>('/v1/cli-sessions/stats'),
        bridgeJson<{ sessions: CliSession[] }>(`/v1/cli-sessions${filter !== 'all' ? `?status=${filter}` : ''}`, { timeout: 15000 }),
        bridgeJson<{ session_stats: SessionStats }>('/v1/sessions/stats'),
        bridgeJson<{ sessions: ConvSession[] }>('/v1/sessions', { timeout: 10000 }),
      ]);

      if (cliStatsRes.status === 'fulfilled') setCliStats(cliStatsRes.value.cli_session_stats);
      if (cliListRes.status === 'fulfilled') setCliSessions(cliListRes.value.sessions ?? []);
      if (sessStatsRes.status === 'fulfilled') setSessionStats(sessStatsRes.value.session_stats);
      if (sessListRes.status === 'fulfilled') setConvSessions(sessListRes.value.sessions ?? []);

      setLastRefresh(new Date());
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 15000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  const handleCancel = useCallback(async (sessionId: string) => {
    try {
      await bridgeFetch(`/v1/cli-sessions/${sessionId}`, { method: 'DELETE' });
      fetchAll();
    } catch (err: any) {
      setError(`Cancel fehlgeschlagen: ${err.message}`);
    }
  }, [fetchAll]);

  return (
    <div style={{ padding: 12 }}>
      <Toolbar lastRefresh={lastRefresh} loading={loading} onRefresh={fetchAll} autoRefresh={15} />
      {error && <ErrorBanner message={error} />}

      {/* CLI Session Stats */}
      {cliStats && (
        <SectionFlat title="CLI-Sessions (Research-Tasks)">
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
            <StatCard label="Gesamt" value={String(cliStats.total)} />
            <StatCard label="Laufend" value={String(cliStats.running)} color={cliStats.running > 0 ? 'var(--tn-blue)' : 'var(--tn-text-muted)'} />
            <StatCard label="Abgeschlossen" value={String(cliStats.completed)} color="var(--tn-green)" />
            <StatCard label="Fehlgeschlagen" value={String(cliStats.failed)} color={cliStats.failed > 0 ? 'var(--tn-red)' : 'var(--tn-text-muted)'} />
          </div>

          {/* Filter */}
          <div style={{ display: 'flex', gap: 4, marginBottom: 10 }}>
            {(['all', 'running', 'completed', 'failed'] as const).map(f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                style={{
                  padding: '3px 10px', borderRadius: 3, fontSize: 10, fontWeight: 600,
                  cursor: 'pointer', border: 'none',
                  background: filter === f ? 'var(--tn-blue)' : 'var(--tn-bg-dark)',
                  color: filter === f ? '#fff' : 'var(--tn-text-muted)',
                }}
              >
                {{ all: 'Alle', running: 'Laufend', completed: 'Fertig', failed: 'Fehler' }[f]}
              </button>
            ))}
          </div>

          {/* CLI Session List */}
          {cliSessions.length > 0 ? (
            <div style={{ background: 'var(--tn-bg-dark)', borderRadius: 5, overflow: 'hidden' }}>
              {/* Header */}
              <div style={{
                display: 'grid', gridTemplateColumns: '80px 1fr 90px 70px 70px',
                gap: 6, padding: '5px 10px', fontSize: 9, fontWeight: 700,
                color: 'var(--tn-text-muted)', borderBottom: '1px solid var(--tn-border)',
                textTransform: 'uppercase', letterSpacing: '0.05em',
              }}>
                <div>ID</div>
                <div>Query/Modell</div>
                <div>Erstellt</div>
                <div>Dauer</div>
                <div style={{ textAlign: 'right' }}>Status</div>
              </div>
              {cliSessions.slice(0, 50).map((s, i) => (
                <div key={i} style={{
                  display: 'grid', gridTemplateColumns: '80px 1fr 90px 70px 70px',
                  gap: 6, padding: '6px 10px', fontSize: 10,
                  borderBottom: '1px solid var(--tn-border)', alignItems: 'center',
                }}>
                  <div style={{ fontFamily: 'monospace', color: 'var(--tn-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {s.session_id.slice(0, 8)}
                  </div>
                  <div style={{ color: 'var(--tn-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {s.query ?? s.model ?? '–'}
                  </div>
                  <div style={{ fontSize: 9, color: 'var(--tn-text-muted)' }}>
                    {s.created_at ? timeAgo(s.created_at) : '–'}
                  </div>
                  <div style={{ fontSize: 9, fontFamily: 'monospace', color: 'var(--tn-text-muted)' }}>
                    {s.duration_seconds != null ? formatDuration(s.duration_seconds) : '–'}
                  </div>
                  <div style={{ textAlign: 'right', display: 'flex', justifyContent: 'flex-end', gap: 4, alignItems: 'center' }}>
                    {s.status === 'running' && (
                      <button
                        onClick={() => handleCancel(s.session_id)}
                        style={{
                          padding: '2px 6px', borderRadius: 3, fontSize: 8, fontWeight: 700,
                          cursor: 'pointer', border: 'none',
                          background: 'rgba(247,118,142,0.15)', color: 'var(--tn-red)',
                        }}
                      >
                        STOP
                      </button>
                    )}
                    <StatusBadge status={s.status} />
                  </div>
                </div>
              ))}
              {cliSessions.length > 50 && (
                <div style={{ padding: '6px 10px', fontSize: 10, color: 'var(--tn-text-muted)', textAlign: 'center' }}>
                  ... und {cliSessions.length - 50} weitere
                </div>
              )}
            </div>
          ) : (
            <div style={{ padding: '12px', fontSize: 11, color: 'var(--tn-text-muted)', background: 'var(--tn-bg-dark)', borderRadius: 5, textAlign: 'center' }}>
              Keine CLI-Sessions {filter !== 'all' ? `mit Status "${filter}"` : ''}
            </div>
          )}
        </SectionFlat>
      )}

      {/* Conversation Sessions */}
      {sessionStats && (
        <SectionFlat title="Conversation-Sessions">
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
            <StatCard label="Aktiv" value={String(sessionStats.active_sessions)} color="var(--tn-green)" />
            <StatCard label="Abgelaufen" value={String(sessionStats.expired_sessions)} color="var(--tn-text-muted)" />
            <StatCard label="Nachrichten" value={String(sessionStats.total_messages)} />
          </div>

          {convSessions.length > 0 && (
            <div style={{ background: 'var(--tn-bg-dark)', borderRadius: 5, overflow: 'hidden' }}>
              <div style={{
                display: 'grid', gridTemplateColumns: '120px 1fr 90px',
                gap: 8, padding: '5px 10px', fontSize: 9, fontWeight: 700,
                color: 'var(--tn-text-muted)', borderBottom: '1px solid var(--tn-border)',
                textTransform: 'uppercase',
              }}>
                <div>Session-ID</div>
                <div>Nachrichten</div>
                <div>Letzte Aktivität</div>
              </div>
              {convSessions.slice(0, 20).map((s, i) => (
                <div key={i} style={{
                  display: 'grid', gridTemplateColumns: '120px 1fr 90px',
                  gap: 8, padding: '6px 10px', fontSize: 10,
                  borderBottom: '1px solid var(--tn-border)', alignItems: 'center',
                }}>
                  <div style={{ fontFamily: 'monospace', color: 'var(--tn-text)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {s.session_id.slice(0, 12)}...
                  </div>
                  <div style={{ color: 'var(--tn-text-muted)' }}>{s.message_count}</div>
                  <div style={{ fontSize: 9, color: 'var(--tn-text-muted)' }}>
                    {s.last_activity ? timeAgo(s.last_activity) : '–'}
                  </div>
                </div>
              ))}
            </div>
          )}
        </SectionFlat>
      )}

      {loading && !cliStats && <LoadingSpinner text="Lade Session-Daten..." />}
    </div>
  );
}
