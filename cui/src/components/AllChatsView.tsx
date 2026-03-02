import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import CuiLitePanel from './panels/CuiLitePanel';
import { ACCOUNTS } from '../types';

interface ActiveChat {
  projectId: string;
  projectName: string;
  workDir: string;
  panelId: string;
  accountId: string;
  sessionId: string;
  attentionState?: string;
  attentionReason?: string;
}

interface AllChatsViewProps {
  onNavigateToProject: (projectId: string) => void;
  isVisible?: boolean;
}

function computeGrid(n: number): { cols: number; rows: number } {
  if (n <= 0) return { cols: 1, rows: 1 };
  if (n === 1) return { cols: 1, rows: 1 };
  if (n === 2) return { cols: 2, rows: 1 };
  if (n === 3) return { cols: 3, rows: 1 };
  if (n === 4) return { cols: 2, rows: 2 };
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  return { cols, rows };
}

export default function AllChatsView({ onNavigateToProject, isVisible = true }: AllChatsViewProps) {
  const [chats, setChats] = useState<ActiveChat[]>([]);
  const [failedSessions, setFailedSessions] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const prevVisibleRef = useRef(isVisible);

  const fetchChats = useCallback(async () => {
    try {
      const resp = await fetch('/api/all-active-chats');
      if (!resp.ok) throw new Error('fetch failed');
      const data = await resp.json();
      setChats(data.chats || []);
      // Reset failed sessions on fresh fetch — give panels a new chance
      setFailedSessions(new Set());
    } catch (err) {
      console.error('[AllChats] Fetch error:', err);
    }
    setLoading(false);
  }, []);

  // Refresh on mount + every 30s
  useEffect(() => {
    fetchChats();
    const timer = setInterval(fetchChats, 30000);
    return () => clearInterval(timer);
  }, [fetchChats]);

  // Refresh when AC tab becomes visible (user clicks AC)
  useEffect(() => {
    if (isVisible && !prevVisibleRef.current) {
      fetchChats();
    }
    prevVisibleRef.current = isVisible;
  }, [isVisible, fetchChats]);

  const handleLoadFailed = useCallback((sessionId: string) => {
    setFailedSessions(prev => new Set(prev).add(sessionId));
  }, []);

  // Filter out failed panels
  const visibleChats = useMemo(
    () => chats.filter(c => !failedSessions.has(c.sessionId)),
    [chats, failedSessions]
  );

  const { cols, rows } = useMemo(() => computeGrid(visibleChats.length), [visibleChats.length]);

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--tn-text-muted)' }}>
        Loading active chats...
      </div>
    );
  }

  if (visibleChats.length === 0) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--tn-text-muted)', flexDirection: 'column', gap: 8 }}>
        <span style={{ fontSize: 32, opacity: 0.3 }}>&#x1f4ac;</span>
        <span style={{ fontSize: 14 }}>Keine aktiven Chats</span>
        <span style={{ fontSize: 11, opacity: 0.5 }}>
          {chats.length > 0
            ? `${chats.length} Panel(s) konnten nicht geladen werden`
            : 'Chats werden automatisch erkannt, wenn sie in Workspaces geöffnet sind'}
        </span>
        {chats.length > 0 && (
          <button
            onClick={fetchChats}
            style={{
              marginTop: 8, padding: '6px 16px', fontSize: 12, border: '1px solid var(--tn-border)',
              borderRadius: 4, background: 'var(--tn-surface)', color: 'var(--tn-text)', cursor: 'pointer',
            }}
          >
            Retry
          </button>
        )}
      </div>
    );
  }

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: `repeat(${cols}, 1fr)`,
      gridTemplateRows: `repeat(${rows}, 1fr)`,
      gap: 3,
      height: '100%',
      padding: 3,
      background: 'var(--tn-bg)',
    }}>
      {visibleChats.map(chat => {
        const account = ACCOUNTS.find(a => a.id === chat.accountId);
        const color = account?.color || 'var(--tn-text-muted)';
        const shortName = (chat.accountId || 'UNK').slice(0, 3).toUpperCase();
        const attentionDot = chat.attentionState === 'needs_attention'
          ? { bg: 'rgba(247,118,142,0.15)', border: 'rgba(247,118,142,0.5)' }
          : chat.attentionState === 'working'
            ? { bg: 'rgba(158,206,106,0.1)', border: 'rgba(158,206,106,0.4)' }
            : { bg: 'transparent', border: 'var(--tn-border)' };

        return (
          <div
            key={`${chat.projectId}-${chat.panelId}-${chat.sessionId}`}
            style={{
              border: `1px solid ${attentionDot.border}`,
              borderRadius: 6,
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
              background: attentionDot.bg,
            }}
          >
            {/* Header strip */}
            <div style={{
              padding: '2px 8px',
              fontSize: 10,
              background: 'var(--tn-bg-dark)',
              borderBottom: '1px solid var(--tn-border)',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              flexShrink: 0,
            }}>
              <span style={{ color, fontWeight: 700, fontSize: 9, letterSpacing: '0.02em' }}>
                {shortName}
              </span>
              <span style={{ color: 'var(--tn-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                {chat.projectName}
              </span>
              {chat.attentionState === 'needs_attention' && (
                <span style={{ fontSize: 9, color: 'var(--tn-red)', fontWeight: 600 }}>
                  {chat.attentionReason || 'AKTION'}
                </span>
              )}
              {chat.attentionState === 'working' && (
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--tn-green)', flexShrink: 0 }} />
              )}
              <button
                onClick={() => onNavigateToProject(chat.projectId)}
                title="Zum Workspace wechseln"
                style={{
                  background: 'var(--tn-surface-alt)',
                  color: 'var(--tn-blue)',
                  border: '1px solid var(--tn-border)',
                  borderRadius: 3,
                  padding: '1px 6px',
                  fontSize: 9,
                  cursor: 'pointer',
                  flexShrink: 0,
                }}
              >
                Go
              </button>
            </div>
            {/* Chat panel */}
            <div style={{ flex: 1, minHeight: 0 }}>
              <CuiLitePanel
                accountId={chat.accountId}
                projectId={chat.projectId}
                workDir={chat.workDir}
                panelId={`allchats-${chat.panelId}`}
                isTabVisible={true}
                initialSessionId={chat.sessionId}
                onLoadFailed={handleLoadFailed}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
