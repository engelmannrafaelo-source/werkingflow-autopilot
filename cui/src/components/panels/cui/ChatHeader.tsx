import { ACCOUNTS } from '../../../types';

const SWITCHABLE_ACCOUNTS = ACCOUNTS.filter(a => a.id !== 'local');

interface ChatHeaderProps {
  selectedId: string;
  onAccountChange: (newAcct: string) => void;
  attention: 'idle' | 'working' | 'needs_attention';
  attentionReason?: string;
  isAgentDone: boolean;
  convStatus: 'ongoing' | 'completed';
  sessionId: string | null;
  onBack: () => void;
  onRefresh: () => void;
  accountColor: string;
  convName?: string;
  toolInfo?: { toolName: string; toolDetail?: string } | null;
}

export default function ChatHeader({
  selectedId, onAccountChange, attention, attentionReason,
  isAgentDone, convStatus, sessionId, onBack, onRefresh, accountColor, convName, toolInfo,
}: ChatHeaderProps) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px',
      background: 'var(--tn-bg-dark)', borderBottom: '1px solid var(--tn-border)',
      height: 30, flexShrink: 0,
    }}>
      <div style={{
        width: 8, height: 8, borderRadius: '50%',
        background: attention === 'working' ? '#3B82F6'
          : attention === 'needs_attention' ? '#F59E0B'
          : (isAgentDone && attentionReason === 'done') ? '#9ece6a'
          : convStatus === 'ongoing' ? '#9ece6a'
          : accountColor,
        animation: attention === 'working' ? 'q-pulse 2s ease-in-out infinite' : undefined,
      }} />
      <select
        value={selectedId}
        onChange={(e) => onAccountChange(e.target.value)}
        style={{
          background: 'var(--tn-bg)', color: 'var(--tn-text)',
          border: '1px solid var(--tn-border)', borderRadius: 4,
          padding: '2px 6px', fontSize: 11, cursor: 'pointer',
        }}
      >
        {SWITCHABLE_ACCOUNTS.map((a) => (
          <option key={a.id} value={a.id}>{a.label}</option>
        ))}
      </select>

      {/* Status badge */}
      {attention === 'working' && sessionId && (
        <span style={{ fontSize: 9, color: '#3B82F6', fontWeight: 600, opacity: 0.8, display: 'flex', alignItems: 'center', gap: 3, overflow: 'hidden', maxWidth: 200 }}>
          <span style={{ display: 'inline-block', width: 5, height: 5, borderRadius: '50%', background: '#3B82F6', animation: 'q-pulse 1s ease-in-out infinite', flexShrink: 0 }} />
          {toolInfo ? (
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {toolInfo.toolName}{toolInfo.toolDetail ? `: ${toolInfo.toolDetail}` : ''}
            </span>
          ) : 'arbeitet'}
        </span>
      )}
      {attention === 'idle' && isAgentDone && sessionId && attentionReason === 'done' && (
        <span style={{ fontSize: 9, color: '#9ece6a', fontWeight: 600 }}>Fertig</span>
      )}
      {attention === 'needs_attention' && sessionId && (
        <span style={{ fontSize: 9, color: '#F59E0B', fontWeight: 600 }}>
          {attentionReason === 'plan' ? 'Plan' : attentionReason === 'question' ? 'Frage' : attentionReason === 'context_overflow' ? 'Zu lang' : attentionReason === 'rate_limit' ? 'Rate Limit' : attentionReason === 'error' || attentionReason === 'send_failed' ? 'Fehler' : attentionReason === 'done' ? 'Fertig' : 'Aktion'}
        </span>
      )}

      {/* Back to queue */}
      {sessionId && (
        <button onClick={onBack} title="Zurueck zur Konversationsliste" style={{
          background: 'var(--tn-bg)', color: 'var(--tn-text)',
          border: '1px solid var(--tn-border)', borderRadius: 4,
          padding: '1px 6px', fontSize: 12, cursor: 'pointer', fontWeight: 600,
        }}>
          &larr;
        </button>
      )}

      {/* Conversation title */}
      {sessionId && convName && (
        <span style={{
          flex: 1, fontSize: 11, color: 'var(--tn-text-muted)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          fontWeight: 500, paddingLeft: 4,
        }}>
          {convName}
        </span>
      )}
      {!(sessionId && convName) && <span style={{ flex: 1 }} />}

      {/* Manual refresh */}
      {sessionId && (
        <button onClick={onRefresh} style={{
          background: 'var(--tn-bg)', color: 'var(--tn-text-muted)',
          border: '1px solid var(--tn-border)', borderRadius: 4,
          padding: '1px 8px', fontSize: 10, cursor: 'pointer',
        }}>
          Refresh
        </button>
      )}

      <span style={{ fontSize: 8, color: 'var(--tn-text-muted)', opacity: 0.5 }}>LITE</span>
    </div>
  );
}
