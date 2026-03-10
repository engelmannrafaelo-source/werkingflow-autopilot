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
  isVisible?: boolean;
  openInWorkspace?: string;
}

interface AllChatsViewProps {
  onNavigateToProject: (projectId: string) => void;
  isVisible?: boolean;
}

const MAX_VISIBLE_PANELS = 16;

function computeGrid(n: number): { cols: number; rows: number } {
  if (n <= 0) return { cols: 1, rows: 1 };
  if (n === 1) return { cols: 1, rows: 1 };
  if (n === 2) return { cols: 2, rows: 1 };
  if (n === 3) return { cols: 3, rows: 1 };
  if (n === 4) return { cols: 2, rows: 2 };
  if (n <= 6) return { cols: 3, rows: 2 };
  if (n <= 9) return { cols: 3, rows: 3 };
  if (n <= 12) return { cols: 4, rows: 3 };
  if (n <= 16) return { cols: 4, rows: 4 };
  // >16: still use 4 cols, scroll vertically
  const cols = 4;
  const rows = Math.ceil(n / cols);
  return { cols, rows };
}

export default function AllChatsView({ onNavigateToProject, isVisible = true }: AllChatsViewProps) {
  const [chats, setChats] = useState<ActiveChat[]>([]);
  const [failedSessions, setFailedSessions] = useState<Set<string>>(new Set());
  const [localFinished, setLocalFinished] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const prevVisibleRef = useRef(isVisible);

  const fetchChats = useCallback(async () => {
    if ((window as any).__cuiServerAlive === false) { setLoading(false); return; }
    try {
      const resp = await fetch('/api/all-active-chats', { signal: AbortSignal.timeout(20000) });
      if (!resp.ok) throw new Error('fetch failed');
      const data = await resp.json();
      setChats(data.chats || []);
      setFailedSessions(new Set());
      setLocalFinished(new Set());
    } catch (err) {
      if ((window as any).__cuiServerAlive !== false) {
        console.warn('[AllChats] Fetch error:', (err as Error).message);
      }
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchChats();
  }, [fetchChats]);

  // Refresh only on manual action (Retry/Aktualisieren button), not on visibility change

  const handleLoadFailed = useCallback((sessionId: string) => {
    setFailedSessions(prev => new Set(prev).add(sessionId));
  }, []);

  const handleLocalFinish = useCallback((sessionId: string) => {
    setLocalFinished(prev => new Set(prev).add(sessionId));
  }, []);

  const visibleChats = useMemo(
    () => chats.filter(c => !failedSessions.has(c.sessionId)),
    [chats, failedSessions]
  );

  // Pagination for >16 panels
  const totalPages = Math.ceil(visibleChats.length / MAX_VISIBLE_PANELS);
  const currentPage = Math.min(page, Math.max(0, totalPages - 1));
  const pageChats = visibleChats.length <= MAX_VISIBLE_PANELS
    ? visibleChats
    : visibleChats.slice(currentPage * MAX_VISIBLE_PANELS, (currentPage + 1) * MAX_VISIBLE_PANELS);

  const { cols, rows } = useMemo(() => computeGrid(pageChats.length), [pageChats.length]);

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--tn-text-muted)' }}>
        Loading chats...
      </div>
    );
  }

  if (visibleChats.length === 0) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--tn-text-muted)', flexDirection: 'column', gap: 8 }}>
        <span style={{ fontSize: 14 }}>Keine aktiven Chats</span>
        <button onClick={fetchChats} style={{
          marginTop: 8, padding: '6px 16px', fontSize: 12, border: '1px solid var(--tn-border)',
          borderRadius: 4, background: 'var(--tn-surface)', color: 'var(--tn-text)', cursor: 'pointer',
        }}>Retry</button>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Page tabs when >16 chats */}
      {totalPages > 1 && (
        <div style={{
          display: 'flex', gap: 2, padding: '3px 6px',
          background: 'var(--tn-bg-dark)', borderBottom: '1px solid var(--tn-border)',
          alignItems: 'center', flexShrink: 0,
        }}>
          <span style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginRight: 6 }}>
            {visibleChats.length} Chats
          </span>
          {Array.from({ length: totalPages }, (_, i) => {
            const start = i * MAX_VISIBLE_PANELS + 1;
            const end = Math.min((i + 1) * MAX_VISIBLE_PANELS, visibleChats.length);
            return (
              <button key={i} onClick={() => setPage(i)} style={{
                padding: '2px 8px', fontSize: 10, borderRadius: 3, cursor: 'pointer',
                border: currentPage === i ? '1px solid var(--tn-blue)' : '1px solid var(--tn-border)',
                background: currentPage === i ? 'rgba(59,130,246,0.15)' : 'var(--tn-surface)',
                color: currentPage === i ? 'var(--tn-blue)' : 'var(--tn-text-muted)',
                fontWeight: currentPage === i ? 700 : 400,
              }}>
                {start}-{end}
              </button>
            );
          })}
        </div>
      )}

      {/* Chat grid */}
      <div style={{
        flex: 1,
        display: 'grid',
        gridTemplateColumns: `repeat(${cols}, 1fr)`,
        gridTemplateRows: `repeat(${rows}, 1fr)`,
        gap: 3,
        padding: 3,
        background: 'var(--tn-bg)',
        minHeight: 0,
      }}>
        {pageChats.map(chat => {
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
              key={chat.sessionId}
              style={{
                border: `1px solid ${localFinished.has(chat.sessionId) ? 'rgba(239,68,68,0.3)' : attentionDot.border}`,
                borderRadius: 6, overflow: 'hidden',
                display: 'flex', flexDirection: 'column',
                background: localFinished.has(chat.sessionId) ? 'rgba(239,68,68,0.06)' : attentionDot.bg,
                opacity: localFinished.has(chat.sessionId) ? 0.4 : 1,
                transition: 'opacity 0.3s',
                pointerEvents: localFinished.has(chat.sessionId) ? 'none' : 'auto',
              }}
            >
              {/* Header strip */}
              <div style={{
                padding: '2px 8px', fontSize: 10,
                background: 'var(--tn-bg-dark)',
                borderBottom: '1px solid var(--tn-border)',
                display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
              }}>
                <span style={{ color, fontWeight: 700, fontSize: 9, letterSpacing: '0.02em' }}>
                  {shortName}
                </span>
                <span style={{ color: 'var(--tn-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                  {chat.projectName}
                </span>
                {chat.openInWorkspace && (
                  <span style={{
                    fontSize: 8, padding: '1px 4px', borderRadius: 2,
                    background: 'rgba(59,130,246,0.15)', color: 'var(--tn-blue)',
                    fontWeight: 600, letterSpacing: '0.02em',
                  }}>
                    {chat.openInWorkspace}
                  </span>
                )}
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
                    background: 'var(--tn-surface-alt)', color: 'var(--tn-blue)',
                    border: '1px solid var(--tn-border)', borderRadius: 3,
                    padding: '1px 6px', fontSize: 9, cursor: 'pointer', flexShrink: 0,
                  }}
                >Go</button>
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
                  onFinish={handleLocalFinish}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
