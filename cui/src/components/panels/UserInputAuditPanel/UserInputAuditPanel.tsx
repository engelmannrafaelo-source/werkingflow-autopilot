import React, { useState, useEffect, useCallback } from 'react';
import { shortenPath } from '../../../utils/paths';
import { validateApiResponse } from '../../../lib/validateApiResponse';

// --- Types ---

interface AuditEntry {
  sessionId: string;
  timestamp: string;
  content: string;
  ts?: string;
  type?: string;
  accountId?: string;
  workDir?: string;
  subject?: string;
  message?: string;
  result?: 'ok' | 'error';
  error?: string;
  convTitle?: string;
  convStatus?: 'ongoing' | 'finished';
  convSummary?: string;
  convMessageCount?: number;
}

interface AuditSummary {
  totalInputs: number;
  sessions: number;
  hours?: number;
  totalSessions?: number;
  byAccount?: Record<string, number>;
  byType?: Record<string, number>;
  errorCount?: number;
}

interface ConversationContext {
  sessionId: string;
  messages: Array<{ role: string; text: string; timestamp: string }>;
  title?: string;
  status?: string;
  totalMessages?: number;
}

interface InputsApiResponse {
  entries: AuditEntry[];
  total: number;
}

// --- Constants ---

const HOURS_OPTIONS = [
  { label: '1h', value: 1 },
  { label: '2h', value: 2 },
  { label: '4h', value: 4 },
  { label: '8h', value: 8 },
  { label: '24h', value: 24 },
  { label: '48h', value: 48 },
];

const TYPE_COLORS: Record<string, string> = {
  start: '#9ece6a',
  send: '#7aa2f7',
  'send-piped': '#bb9af7',
  'auto-inject': '#e0af68',
};

const ACCOUNT_COLORS: Record<string, string> = {
  rafael: '#7aa2f7',
  office: '#9ece6a',
  engelmann: '#e0af68',
};

// --- Component ---

export default function UserInputAuditPanel() {
  const [hours, setHours] = useState(2);
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [summary, setSummary] = useState<AuditSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [contextData, setContextData] = useState<ConversationContext | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [total, setTotal] = useState(0);

  const fetchData = useCallback(async () => {
    if ((window as any).__cuiServerAlive === false) return;
    setLoading(true);
    try {
      const inputsEndpoint = `/api/audit/inputs?hours=${hours}`;
      const summaryEndpoint = `/api/audit/summary?hours=${hours}`;
      const [inputsRes, summaryRes] = await Promise.all([
        fetch(inputsEndpoint, { signal: AbortSignal.timeout(15000) }),
        fetch(summaryEndpoint, { signal: AbortSignal.timeout(15000) }),
      ]);
      if (inputsRes.ok) {
        const raw = await inputsRes.json();
        const validated = validateApiResponse<InputsApiResponse>(raw, inputsEndpoint, {
          entries: 'array',
          total: 'number',
        });
        setEntries(validated.entries);
        setTotal(validated.total);
      }
      if (summaryRes.ok) {
        const rawSummary = await summaryRes.json();
        const validatedSummary = validateApiResponse<AuditSummary>(rawSummary, summaryEndpoint, {
          totalInputs: 'number',
          sessions: 'number',
        });
        setSummary(validatedSummary);
      }
    } catch (err) {
      console.warn('[UserInputAudit] fetch failed:', err);
    } finally {
      setLoading(false);
    }
  }, [hours]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const loadContext = async (sessionId: string) => {
    if (expandedId === sessionId) {
      setExpandedId(null);
      setContextData(null);
      return;
    }
    setExpandedId(sessionId);
    setContextLoading(true);
    try {
      const endpoint = `/api/audit/inputs/${sessionId}/context?tail=10`;
      const res = await fetch(endpoint, { signal: AbortSignal.timeout(15000) });
      if (res.ok) {
        const raw = await res.json();
        const validated = validateApiResponse<ConversationContext>(raw, endpoint, {
          sessionId: 'string',
          messages: 'array',
        });
        setContextData(validated);
      }
    } catch (err) {
      console.warn('[UserInputAudit] context fetch failed:', err);
    } finally {
      setContextLoading(false);
    }
  };

  const formatTime = (ts: string) => {
    const d = new Date(ts);
    return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  };

  const formatDate = (ts: string) => {
    const d = new Date(ts);
    return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
  };

  // Show full message — no truncation

  return (
    <div
      data-ai-id="user-input-audit-panel"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: 'var(--tn-surface)',
      }}
    >
      {/* Header */}
      <div style={{
        background: 'var(--tn-bg-dark)',
        borderBottom: '2px solid var(--tn-border)',
        flexShrink: 0,
      }}>
        <div style={{
          padding: '8px 12px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}>
          <span style={{
            fontSize: 13,
            fontWeight: 700,
            color: 'var(--tn-text)',
            flex: 1,
          }}>
            INPUT AUDIT
          </span>

          {/* Summary badge */}
          {summary && (
            <span style={{
              fontSize: 9,
              fontWeight: 700,
              padding: '2px 6px',
              borderRadius: 3,
              background: (summary.errorCount ?? 0) > 0 ? 'rgba(247,118,142,0.25)' : 'rgba(122,162,247,0.15)',
              color: (summary.errorCount ?? 0) > 0 ? '#f7768e' : '#7aa2f7',
              border: `1px solid ${(summary.errorCount ?? 0) > 0 ? 'rgba(247,118,142,0.5)' : 'rgba(122,162,247,0.3)'}`,
              fontFamily: 'monospace',
            }}>
              {total} inputs / {summary.sessions} sessions
            </span>
          )}

          {/* Refresh */}
          <button
            onClick={fetchData}
            disabled={loading}
            style={{
              background: loading ? 'transparent' : 'rgba(122,162,247,0.15)',
              border: '1px solid rgba(122,162,247,0.3)',
              borderRadius: 3,
              padding: '2px 8px',
              fontSize: 9,
              fontWeight: 700,
              color: 'var(--tn-blue)',
              cursor: loading ? 'not-allowed' : 'pointer',
              opacity: loading ? 0.5 : 1,
            }}
          >
            {loading ? '...' : 'Refresh'}
          </button>
        </div>

        {/* Time filter buttons */}
        <div style={{
          display: 'flex',
          gap: 4,
          padding: '0 12px 8px',
        }}>
          {HOURS_OPTIONS.map(opt => (
            <button
              key={opt.value}
              onClick={() => setHours(opt.value)}
              style={{
                background: hours === opt.value ? 'var(--tn-blue)' : 'transparent',
                border: 'none',
                color: hours === opt.value ? '#fff' : 'var(--tn-text-muted)',
                padding: '4px 12px',
                borderRadius: 4,
                fontSize: 11,
                fontWeight: 600,
                cursor: 'pointer',
                transition: 'all 0.15s',
                whiteSpace: 'nowrap',
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Entry List */}
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        {loading && entries.length === 0 ? (
          <div style={{ padding: 20, textAlign: 'center', color: 'var(--tn-text-muted)', fontSize: 12 }}>
            Loading...
          </div>
        ) : entries.length === 0 ? (
          <div style={{ padding: 20, textAlign: 'center', color: 'var(--tn-text-muted)', fontSize: 12 }}>
            Keine Inputs im Zeitraum gefunden
          </div>
        ) : (
          entries.map((entry, idx) => {
            const entryKey = `${entry.ts ?? ''}-${idx}`;
            const isExpanded = expandedId === entry.sessionId;

            return (
              <div key={entryKey}>
                {/* Entry Row */}
                <div
                  style={{
                    padding: '8px 12px',
                    borderBottom: '1px solid var(--tn-border)',
                    cursor: entry.sessionId ? 'pointer' : 'default',
                    background: isExpanded ? 'rgba(122,162,247,0.08)' : 'transparent',
                    transition: 'background 0.15s',
                  }}
                  onClick={() => entry.sessionId && loadContext(entry.sessionId)}
                >
                  {/* Top row: time, type badge, account, status */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                    {/* Timestamp */}
                    <span style={{
                      fontSize: 10,
                      fontFamily: 'monospace',
                      color: 'var(--tn-text-muted)',
                      minWidth: 70,
                    }}>
                      {formatDate(entry.ts ?? '')} {formatTime(entry.ts ?? '')}
                    </span>

                    {/* Type badge */}
                    <span style={{
                      fontSize: 8,
                      fontWeight: 700,
                      padding: '1px 5px',
                      borderRadius: 3,
                      background: `${TYPE_COLORS[entry.type ?? ''] || '#565f89'}22`,
                      color: TYPE_COLORS[entry.type ?? ''] || '#565f89',
                      border: `1px solid ${TYPE_COLORS[entry.type ?? ''] || '#565f89'}44`,
                      fontFamily: 'monospace',
                      textTransform: 'uppercase',
                    }}>
                      {entry.type ?? ''}
                    </span>

                    {/* Account badge */}
                    <span style={{
                      fontSize: 8,
                      fontWeight: 700,
                      padding: '1px 5px',
                      borderRadius: 3,
                      background: `${ACCOUNT_COLORS[entry.accountId ?? ''] || '#565f89'}22`,
                      color: ACCOUNT_COLORS[entry.accountId ?? ''] || '#565f89',
                      fontFamily: 'monospace',
                    }}>
                      {entry.accountId ?? ''}
                    </span>

                    {/* Result */}
                    {(entry.result ?? 'ok') === 'error' && (
                      <span style={{
                        fontSize: 8,
                        fontWeight: 700,
                        padding: '1px 5px',
                        borderRadius: 3,
                        background: 'rgba(247,118,142,0.2)',
                        color: '#f7768e',
                        fontFamily: 'monospace',
                      }}>
                        ERROR
                      </span>
                    )}

                    {/* Conv status */}
                    {entry.convStatus && (
                      <span style={{
                        fontSize: 8,
                        color: entry.convStatus === 'finished' ? '#565f89' : '#9ece6a',
                        fontFamily: 'monospace',
                      }}>
                        {entry.convStatus === 'finished' ? 'done' : 'active'}
                      </span>
                    )}

                    {/* Conv message count */}
                    {entry.convMessageCount != null && (
                      <span style={{
                        fontSize: 8,
                        color: 'var(--tn-text-muted)',
                        fontFamily: 'monospace',
                        marginLeft: 'auto',
                      }}>
                        {entry.convMessageCount} msgs
                      </span>
                    )}
                  </div>

                  {/* Subject / Title */}
                  {(entry.subject || entry.convTitle) && (
                    <div style={{
                      fontSize: 11,
                      fontWeight: 600,
                      color: 'var(--tn-text)',
                      marginBottom: 2,
                    }}>
                      {entry.subject || entry.convTitle}
                    </div>
                  )}

                  {/* Message preview */}
                  <div style={{
                    fontSize: 11,
                    color: 'var(--tn-text-muted)',
                    lineHeight: 1.4,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}>
                    {entry.message ?? ''}
                  </div>

                  {/* WorkDir */}
                  {entry.workDir && (
                    <div style={{
                      fontSize: 9,
                      color: '#565f89',
                      fontFamily: 'monospace',
                      marginTop: 2,
                    }}>
                      {shortenPath(entry.workDir)}
                    </div>
                  )}
                </div>

                {/* Expanded Context */}
                {isExpanded && entry.sessionId && (
                  <div style={{
                    padding: '8px 12px 12px 24px',
                    background: 'rgba(122,162,247,0.04)',
                    borderBottom: '2px solid var(--tn-border)',
                  }}>
                    {contextLoading ? (
                      <div style={{ fontSize: 11, color: 'var(--tn-text-muted)' }}>Loading context...</div>
                    ) : contextData ? (
                      <>
                        <div style={{
                          fontSize: 10,
                          fontWeight: 700,
                          color: 'var(--tn-text)',
                          marginBottom: 6,
                        }}>
                          Conversation: {contextData.title ?? ''} ({contextData.totalMessages ?? 0} messages, {contextData.status ?? 'unknown'})
                        </div>
                        {contextData.messages.map((msg, mi) => (
                          <div key={mi} style={{
                            padding: '4px 8px',
                            marginBottom: 4,
                            borderLeft: `2px solid ${msg.role === 'user' ? '#7aa2f7' : '#9ece6a'}`,
                            background: msg.role === 'user' ? 'rgba(122,162,247,0.06)' : 'rgba(158,206,106,0.06)',
                          }}>
                            <div style={{
                              fontSize: 9,
                              fontWeight: 700,
                              color: msg.role === 'user' ? '#7aa2f7' : '#9ece6a',
                              marginBottom: 2,
                            }}>
                              {msg.role.toUpperCase()} {formatTime(msg.timestamp)}
                            </div>
                            <div style={{
                              fontSize: 10,
                              color: 'var(--tn-text)',
                              lineHeight: 1.4,
                              whiteSpace: 'pre-wrap',
                              wordBreak: 'break-word',
                              maxHeight: 200,
                              overflow: 'auto',
                            }}>
                              {msg.text}
                            </div>
                          </div>
                        ))}
                      </>
                    ) : (
                      <div style={{ fontSize: 11, color: '#f7768e' }}>Context not available</div>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Footer summary */}
      {summary && (
        <div style={{
          padding: '6px 12px',
          borderTop: '1px solid var(--tn-border)',
          background: 'var(--tn-bg-dark)',
          display: 'flex',
          gap: 12,
          flexWrap: 'wrap',
          flexShrink: 0,
        }}>
          {Object.entries(summary.byAccount ?? {}).map(([acc, count]) => (
            <span key={acc} style={{
              fontSize: 9,
              fontFamily: 'monospace',
              color: ACCOUNT_COLORS[acc] || 'var(--tn-text-muted)',
            }}>
              {acc}: {count}
            </span>
          ))}
          {Object.entries(summary.byType ?? {}).map(([type, count]) => (
            <span key={type} style={{
              fontSize: 9,
              fontFamily: 'monospace',
              color: TYPE_COLORS[type] || 'var(--tn-text-muted)',
            }}>
              {type}: {count}
            </span>
          ))}
          {(summary.errorCount ?? 0) > 0 && (
            <span style={{ fontSize: 9, fontFamily: 'monospace', color: '#f7768e' }}>
              errors: {summary.errorCount ?? 0}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
