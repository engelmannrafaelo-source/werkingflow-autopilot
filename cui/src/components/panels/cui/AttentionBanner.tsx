import type { Permission } from './types';

interface AttentionBannerProps {
  attention: 'idle' | 'working' | 'needs_attention';
  attentionReason?: string;
  sessionId: string | null;
  selectedId: string;
  convName: string;
  permissions: Permission[];
  rateLimitMessage: string | null;
  onRefresh: () => void;
  onPermission: (permId: string, action: 'approve' | 'deny') => void;
}

export default function AttentionBanner({
  attention, attentionReason, sessionId, selectedId,
  convName, permissions, rateLimitMessage, onRefresh, onPermission,
}: AttentionBannerProps) {
  return (
    <>
      {/* Conversation Title Bar */}
      {sessionId && convName && (
        <div style={{
          padding: '4px 16px 6px',
          borderBottom: '1px solid var(--tn-border)',
          flexShrink: 0,
          overflow: 'hidden',
        }}>
          <div style={{
            fontSize: 13, fontWeight: 600, color: 'var(--tn-text)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            lineHeight: 1.3,
          }}>
            {convName}
          </div>
        </div>
      )}

      {/* Attention Banner */}
      {attention === 'needs_attention' && sessionId && attentionReason !== 'done' && (
        <div style={{
          padding: '6px 16px',
          background: attentionReason === 'plan' ? 'rgba(245,158,11,0.12)'
            : attentionReason === 'question' ? 'rgba(59,130,246,0.12)'
            : attentionReason === 'rate_limit' ? 'rgba(239,68,68,0.08)'
            : attentionReason === 'context_overflow' ? 'rgba(224,175,104,0.12)'
            : 'rgba(239,68,68,0.12)',
          borderBottom: '1px solid var(--tn-border)',
          display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0,
        }}>
          <span style={{
            fontSize: 12, fontWeight: 700,
            color: attentionReason === 'plan' ? '#F59E0B'
              : attentionReason === 'question' ? '#3B82F6'
              : attentionReason === 'context_overflow' ? '#e0af68'
              : attentionReason === 'rate_limit' ? '#EF4444'
              : '#EF4444',
          }}>
            {attentionReason === 'plan' ? 'Plan wartet auf Freigabe'
              : attentionReason === 'question' ? `${selectedId === 'gemini' ? 'Gemini' : 'Claude'} hat eine Frage`
              : attentionReason === 'context_overflow' ? 'Kontext zu lang — Nachricht erneut senden, wird automatisch kompaktiert.'
              : attentionReason === 'rate_limit' ? 'Rate Limit — Account hat das Nutzungslimit erreicht. Anderen Account verwenden!'
              : (attentionReason === 'error' || attentionReason === 'send_failed') ? (rateLimitMessage || 'Nachricht konnte nicht zugestellt werden. Bitte erneut versuchen.')
              : 'Aktion erforderlich'}
          </span>
          <span style={{ flex: 1 }} />
          <button onClick={onRefresh} style={{
            padding: '2px 10px', fontSize: 11, borderRadius: 3, cursor: 'pointer',
            background: 'var(--tn-bg)', border: '1px solid var(--tn-border)', color: 'var(--tn-text)',
          }}>
            Aktualisieren
          </button>
        </div>
      )}

      {/* Permission Bar */}
      {permissions.length > 0 && sessionId && (
        <div style={{
          padding: '6px 16px',
          background: 'rgba(245,158,11,0.08)',
          borderBottom: '1px solid var(--tn-border)',
          flexShrink: 0,
          maxHeight: '60vh', overflow: 'auto',
        }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#F59E0B', marginBottom: 4 }}>
            Genehmigungen ({permissions.length})
          </div>
          {permissions.map(perm => {
            const planText = perm.toolInput?.plan as string | undefined;
            const isPlanMode = perm.toolName === 'ExitPlanMode' || perm.toolName === 'EnterPlanMode';
            return (
              <div key={perm.id} style={{ marginBottom: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 12, color: 'var(--tn-text)', flex: 1 }}>
                    {perm.toolName || perm.type}: {perm.title || perm.id.slice(0, 8)}
                  </span>
                  <button onClick={() => onPermission(perm.id, 'approve')} style={{
                    padding: '3px 10px', fontSize: 11, borderRadius: 3, cursor: 'pointer',
                    background: '#10B981', border: 'none', color: '#fff', fontWeight: 600,
                  }}>OK</button>
                  <button onClick={() => onPermission(perm.id, 'deny')} style={{
                    padding: '3px 10px', fontSize: 11, borderRadius: 3, cursor: 'pointer',
                    background: '#EF4444', border: 'none', color: '#fff', fontWeight: 600,
                  }}>X</button>
                </div>
                {isPlanMode && planText && (
                  <details style={{ marginTop: 4 }}>
                    <summary style={{ fontSize: 11, color: '#F59E0B', cursor: 'pointer' }}>
                      Plan anzeigen ({planText.length > 1000 ? `${Math.round(planText.length / 1000)}k Zeichen` : `${planText.length} Zeichen`})
                    </summary>
                    <div style={{
                      marginTop: 4, padding: 8, borderRadius: 4,
                      background: 'var(--tn-bg)', border: '1px solid var(--tn-border)',
                      fontSize: 11, lineHeight: 1.5, whiteSpace: 'pre-wrap',
                      maxHeight: 300, overflow: 'auto', color: 'var(--tn-text)',
                    }}>
                      {planText}
                    </div>
                  </details>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
