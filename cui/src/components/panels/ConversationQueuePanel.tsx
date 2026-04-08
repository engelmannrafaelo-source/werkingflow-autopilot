import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useSessionStore } from '../../contexts/SessionStore';
import { ACCOUNTS } from '../../types';

const API = '/api';

interface Conversation {
  sessionId: string;
  accountId: string;
  accountLabel: string;
  accountColor: string;
  projectPath: string;
  projectName: string;
  summary: string;
  customName: string;
  status: 'ongoing' | 'completed';
  streamingId: string | null;
  model: string;
  messageCount: number;
  updatedAt: string;
  createdAt: string;
  lastPromptAt?: string;
  attentionState?: 'working' | 'needs_attention' | 'idle';
  attentionReason?: string;
  toolInfo?: { toolName: string; toolDetail?: string; startedAt: number };
  isVisible?: boolean;
  manualFinished?: boolean;
}

interface ProjectInfo { id: string; name: string; workDir: string; }
type TimeFilter = 'today' | 'yesterday' | 'week' | 'all';
type StatusFilter = 'all' | 'working' | 'needs_input' | 'idle';

const KNOWN_PROJECTS = new Set([
  'ADMINISTRATION', 'Business', 'DIVERSE', 'Engelmann - AI HUB',
  'RLB CAMPUS', 'Team', 'Werking Energy', 'Werking Report', 'WerkingSafety',
]);

function isToday(d: Date): boolean {
  const n = new Date(); return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}
function isYesterday(d: Date): boolean {
  const y = new Date(); y.setDate(y.getDate() - 1); return d.getFullYear() === y.getFullYear() && d.getMonth() === y.getMonth() && d.getDate() === y.getDate();
}
function isThisWeek(d: Date): boolean { return d >= new Date(Date.now() - 7 * 86400000); }

function timeAgo(dateStr: string): string {
  if (!dateStr) return '';
  const mins = Math.floor((Date.now() - new Date(dateStr).getTime()) / 60000);
  if (mins < 1) return 'jetzt';
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((b: any) => b.type === 'text' && b.text).map((b: any) => b.text).join('\n');
  return '';
}

// --- Color scheme per state ---
const STATE_COLORS = {
  working:    { bg: 'rgba(59, 130, 246, 0.15)',  border: '#3B82F6', text: '#93C5FD', label: 'ARBEITET',  labelBg: 'rgba(59,130,246,0.3)' },
  needs_input:{ bg: 'rgba(245, 158, 11, 0.18)',  border: '#F59E0B', text: '#FCD34D', label: 'INPUT',     labelBg: 'rgba(245,158,11,0.3)' },
  rate_limit: { bg: 'rgba(239, 68, 68, 0.15)',   border: '#EF4444', text: '#FCA5A5', label: 'LIMIT',     labelBg: 'rgba(239,68,68,0.3)' },
  idle:       { bg: 'rgba(16, 185, 129, 0.08)',   border: '#10B981', text: '#6EE7B7', label: 'IDLE',      labelBg: 'rgba(16,185,129,0.2)' },
  unknown:    { bg: 'rgba(86, 90, 110, 0.08)',    border: '#565a6e', text: '#8b90a0', label: '',          labelBg: 'transparent' },
  finished:   { bg: 'transparent',                border: '#2a2a3e', text: '#565a6e', label: 'FERTIG',    labelBg: 'rgba(86,90,110,0.15)' },
} as const;

const REASON_LABELS: Record<string, string> = {
  plan: 'PLAN', question: 'FRAGE', permission: 'ERLAUBNIS', error: 'FEHLER',
  rate_limit: 'RATE LIMIT', context_overflow: 'KONTEXT VOLL',
};

function getConvColor(conv: Conversation): typeof STATE_COLORS[keyof typeof STATE_COLORS] {
  if (conv.manualFinished || conv.status === 'completed') return STATE_COLORS.finished;
  if (conv.attentionState === 'needs_attention' && conv.attentionReason !== 'done') {
    if (conv.attentionReason === 'rate_limit') return STATE_COLORS.rate_limit;
    return STATE_COLORS.needs_input;
  }
  if (conv.attentionReason === 'rate_limit') return STATE_COLORS.rate_limit;
  if (conv.attentionState === 'working' || conv.streamingId) return STATE_COLORS.working;
  if (conv.attentionState === 'idle') return STATE_COLORS.idle;
  return STATE_COLORS.unknown;
}

// --- Styles ---
const STYLE_ID = 'cq-styles';
function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = `
    @keyframes cq-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }
    .cq-row:hover { filter: brightness(1.15); }
    .cq-row:hover .cq-actions { opacity: 1 !important; }
  `;
  document.head.appendChild(s);
}

// ============================================================
// MAIN
// ============================================================
export default function ConversationQueuePanel({ projectId: _projectId }: { projectId: string }) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [visibleSessionIds, setVisibleSessionIds] = useState<Set<string>>(new Set());
  const [panelMap, setPanelMap] = useState<Map<string, string>>(new Map());
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [timeFilter, setTimeFilter] = useState<TimeFilter>('today');
  const [accountFilter, setAccountFilter] = useState<string>('all');
  const [projectFilter, setProjectFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [snippets, setSnippets] = useState<Map<string, string>>(new Map());
  const [feedback, setFeedback] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval>>(null);
  const { sessionStates, addMessageHandler } = useSessionStore();

  useEffect(() => { ensureStyles(); }, []);

  useEffect(() => {
    fetch(`${API}/projects`, { signal: AbortSignal.timeout(5000) })
      .then(r => r.json()).then(d => setProjects(Array.isArray(d) ? d : [])).catch(() => {});
  }, []);

  const showFeedback = (msg: string) => { setFeedback(msg); setTimeout(() => setFeedback(null), 2500); };

  const fetchData = useCallback(async () => {
    try {
      const [convRes, visRes] = await Promise.all([
        fetch(`${API}/mission/conversations`, { signal: AbortSignal.timeout(10000) }),
        fetch(`${API}/mission/visibility`, { signal: AbortSignal.timeout(5000) }).catch(() => null),
      ]);
      if (convRes.ok) setConversations((await convRes.json()).conversations || []);
      if (visRes?.ok) {
        const v = await visRes.json();
        setVisibleSessionIds(new Set(v.visibleSessionIds || []));
        const pm = new Map<string, string>();
        for (const p of (v.panels || [])) if (p.sessionId) pm.set(p.sessionId, p.projectId || 'Panel');
        setPanelMap(pm);
      }
    } catch {} finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchData(); pollRef.current = setInterval(fetchData, 5000); return () => { if (pollRef.current) clearInterval(pollRef.current); }; }, [fetchData]);

  useEffect(() => addMessageHandler((msg: any) => {
    if (msg.type === 'conv-attention' || msg.type === 'visibility-update' || msg.type === 'control:conversation-finished') fetchData();
  }), [addMessageHandler, fetchData]);

  const fetchSnippet = useCallback((conv: Conversation) => {
    if (snippets.has(conv.sessionId)) return;
    fetch(`${API}/mission/conversation/${conv.accountId}/${conv.sessionId}?tail=5`, { signal: AbortSignal.timeout(6000) })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data?.messages) return;
        const lines: string[] = [];
        for (const msg of data.messages) {
          const text = extractText(msg.content);
          if (!text) continue;
          const prefix = msg.role === 'user' ? '> ' : '';
          const msgLines = text.split('\n').filter((l: string) => l.trim());
          lines.push(...msgLines.slice(-4).map((l: string) => prefix + l));
        }
        setSnippets(prev => new Map(prev).set(conv.sessionId, lines.slice(-12).join('\n').slice(-600)));
      })
      .catch(() => setSnippets(prev => new Map(prev).set(conv.sessionId, '(Fehler beim Laden)')));
  }, [snippets]);

  // Enrich with live WebSocket states
  const enriched = useMemo(() => conversations.map(c => {
    const ss = sessionStates.get(c.sessionId);
    if (!ss) return c;
    return { ...c, attentionState: ss.state as Conversation['attentionState'], attentionReason: ss.reason || c.attentionReason, toolInfo: ss.toolInfo || c.toolInfo };
  }), [conversations, sessionStates]);

  // Filter
  const filtered = useMemo(() => enriched.filter(c => {
    const d = new Date(c.updatedAt);
    if (timeFilter === 'today' && !isToday(d)) return false;
    if (timeFilter === 'yesterday' && !isYesterday(d)) return false;
    if (timeFilter === 'week' && !isThisWeek(d)) return false;
    if (accountFilter !== 'all' && c.accountId !== accountFilter) return false;
    if (projectFilter !== 'all' && c.projectName !== projectFilter) return false;
    if (statusFilter !== 'all') {
      const isActive = !c.manualFinished && c.status === 'ongoing';
      if (!isActive) return false;
      if (statusFilter === 'working' && c.attentionState !== 'working' && !c.streamingId) return false;
      if (statusFilter === 'needs_input' && c.attentionState !== 'needs_attention') return false;
      if (statusFilter === 'idle' && c.attentionState !== 'idle') return false;
    }
    return true;
  }), [enriched, timeFilter, accountFilter, projectFilter, statusFilter]);

  // Sort: needs_attention > rate_limit > working > unknown > idle
  const sortP = (list: Conversation[]) => [...list].sort((a, b) => {
    const s = (c: Conversation) => {
      if (c.attentionState === 'needs_attention' && c.attentionReason !== 'done') return 5;
      if (c.attentionReason === 'rate_limit') return 4;
      if (c.streamingId || c.attentionState === 'working') return 3;
      if (c.attentionState === 'idle') return 1;
      return 2;
    };
    const d = s(b) - s(a);
    return d !== 0 ? d : new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });

  const ongoing = useMemo(() => sortP(filtered.filter(c => c.status === 'ongoing' && !c.manualFinished)), [filtered]);
  const completed = useMemo(() => filtered.filter(c => c.status === 'completed' || c.manualFinished).sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()), [filtered]);
  const projectNames = useMemo(() => [...new Set(enriched.map(c => c.projectName))].sort(), [enriched]);

  // Stats
  const stats = useMemo(() => {
    const active = enriched.filter(c => c.status === 'ongoing' && !c.manualFinished);
    return {
      working: active.filter(c => c.attentionState === 'working' || !!c.streamingId).length,
      needsInput: active.filter(c => c.attentionState === 'needs_attention' && c.attentionReason !== 'done' && c.attentionReason !== 'rate_limit').length,
      rateLimited: active.filter(c => c.attentionReason === 'rate_limit').length,
      idle: active.filter(c => c.attentionState === 'idle').length,
      unknown: active.filter(c => !c.attentionState && !c.streamingId).length,
      finished: enriched.filter(c => c.status === 'completed' || c.manualFinished).length,
    };
  }, [enriched]);

  // Actions
  const doFinish = useCallback(async (sid: string, finished = true) => {
    await fetch(`${API}/mission/conversation/${sid}/finish`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ finished }), signal: AbortSignal.timeout(10000) }).catch(() => {});
    showFeedback(finished ? 'Beendet' : 'Wiederhergestellt'); fetchData();
  }, [fetchData]);

  const doDelete = useCallback(async (conv: Conversation) => {
    if (!confirm(`"${conv.customName || conv.summary?.slice(0, 40) || conv.sessionId}" löschen?`)) return;
    await fetch(`${API}/mission/conversation/${conv.sessionId}`, { method: 'DELETE', signal: AbortSignal.timeout(10000) }).catch(() => {});
    showFeedback('Gelöscht'); fetchData();
  }, [fetchData]);

  const doActivate = useCallback(async (conv: Conversation, targetProject: string) => {
    await fetch(`${API}/mission/activate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversations: [{ sessionId: conv.sessionId, accountId: conv.accountId, projectName: targetProject }] }),
      signal: AbortSignal.timeout(10000),
    }).catch(() => {});
    showFeedback(`Geöffnet in ${targetProject}`);
  }, []);

  const doBulkFinish = useCallback(async () => {
    const t = ongoing.filter(c => selected.has(c.sessionId));
    if (!t.length) return;
    await Promise.all(t.map(c => fetch(`${API}/mission/conversation/${c.sessionId}/finish`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ finished: true }), signal: AbortSignal.timeout(10000) }).catch(() => {})));
    setSelected(new Set()); showFeedback(`${t.length} beendet`); fetchData();
  }, [ongoing, selected, fetchData]);

  const toggleSelect = (sid: string) => setSelected(p => { const n = new Set(p); n.has(sid) ? n.delete(sid) : n.add(sid); return n; });
  const toggleExpand = (conv: Conversation) => {
    if (expandedId === conv.sessionId) { setExpandedId(null); return; }
    setExpandedId(conv.sessionId);
    fetchSnippet(conv);
  };

  if (loading) return <div style={{ display: 'flex', height: '100%', justifyContent: 'center', alignItems: 'center', background: 'var(--tn-surface)', color: 'var(--tn-text-secondary)' }}>Lade...</div>;

  const sel: React.CSSProperties = { background: 'var(--tn-surface-raised, #2a2a3e)', color: 'var(--tn-text)', border: '1px solid var(--tn-border)', borderRadius: 4, padding: '2px 4px', fontSize: 11, cursor: 'pointer' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--tn-surface)', color: 'var(--tn-text)', fontSize: 13 }}>
      {/* Header */}
      <div style={{ flexShrink: 0, padding: '8px 12px', borderBottom: '1px solid var(--tn-border)', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 700, fontSize: 14 }}>Queue</span>
          <select style={sel} value={timeFilter} onChange={e => setTimeFilter(e.target.value as TimeFilter)}>
            <option value="today">Heute</option><option value="yesterday">Gestern</option><option value="week">7 Tage</option><option value="all">Alle</option>
          </select>
          <select style={sel} value={accountFilter} onChange={e => setAccountFilter(e.target.value)}>
            <option value="all">Alle Accounts</option>
            {ACCOUNTS.filter(a => a.id !== 'local' && a.id !== 'gemini').map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
          </select>
          <select style={sel} value={projectFilter} onChange={e => setProjectFilter(e.target.value)}>
            <option value="all">Alle Projekte</option>
            {projectNames.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
          <select style={sel} value={statusFilter} onChange={e => setStatusFilter(e.target.value as StatusFilter)}>
            <option value="all">Alle Status</option>
            <option value="working">Arbeitet</option>
            <option value="needs_input">Braucht Input</option>
            <option value="idle">Idle</option>
          </select>
        </div>
        {/* Big colored stat blocks */}
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {stats.working > 0 && <StatBlock count={stats.working} label="arbeiten" color={STATE_COLORS.working} />}
          {stats.needsInput > 0 && <StatBlock count={stats.needsInput} label="Input" color={STATE_COLORS.needs_input} />}
          {stats.rateLimited > 0 && <StatBlock count={stats.rateLimited} label="Limit" color={STATE_COLORS.rate_limit} />}
          {stats.idle > 0 && <StatBlock count={stats.idle} label="idle" color={STATE_COLORS.idle} />}
          {stats.unknown > 0 && <StatBlock count={stats.unknown} label="?" color={STATE_COLORS.unknown} />}
          <StatBlock count={stats.finished} label="fertig" color={STATE_COLORS.finished} />
          {selected.size > 0 && (
            <button onClick={doBulkFinish}
              style={{ marginLeft: 'auto', background: 'rgba(16,185,129,0.2)', border: '1px solid #10B981', color: '#10B981', borderRadius: 4, padding: '2px 10px', fontSize: 11, cursor: 'pointer', fontWeight: 600 }}>
              {selected.size} beenden
            </button>
          )}
        </div>
      </div>

      {/* List */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        {ongoing.length > 0 && ongoing.map(c => (
          <ConvRow key={c.sessionId} conv={c} expanded={expandedId === c.sessionId} snippet={snippets.get(c.sessionId)}
            isVisible={visibleSessionIds.has(c.sessionId)} isWrong={!KNOWN_PROJECTS.has(c.projectName)}
            isSelected={selected.has(c.sessionId)} projects={projects}
            onToggleSelect={() => toggleSelect(c.sessionId)} onClick={() => toggleExpand(c)}
            onActivate={(t) => doActivate(c, t)} onFinish={() => doFinish(c.sessionId)} onDelete={() => doDelete(c)} />
        ))}
        {completed.length > 0 && (
          <>
            <div style={{ padding: '8px 12px 4px', fontSize: 10, fontWeight: 700, color: 'var(--tn-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Fertig ({completed.length})</div>
            {completed.map(c => (
              <ConvRow key={c.sessionId} conv={c} expanded={expandedId === c.sessionId} snippet={snippets.get(c.sessionId)}
                isVisible={visibleSessionIds.has(c.sessionId)} isWrong={!KNOWN_PROJECTS.has(c.projectName)}
                isSelected={selected.has(c.sessionId)} projects={projects} isCompleted
                onToggleSelect={() => toggleSelect(c.sessionId)} onClick={() => toggleExpand(c)}
                onActivate={(t) => doActivate(c, t)} onFinish={() => doFinish(c.sessionId, false)} onDelete={() => doDelete(c)} />
            ))}
          </>
        )}
        {filtered.length === 0 && <div style={{ padding: 24, textAlign: 'center', color: 'var(--tn-text-secondary)' }}>Keine Konversationen</div>}
      </div>

      {feedback && <div style={{ position: 'absolute', bottom: 12, right: 12, background: '#2a2a3e', color: '#9ece6a', padding: '5px 12px', borderRadius: 5, fontSize: 11, zIndex: 9999, border: '1px solid #9ece6a', pointerEvents: 'none' }}>{feedback}</div>}
    </div>
  );
}

// --- Stat block in header ---
function StatBlock({ count, label, color }: { count: number; label: string; color: { bg: string; border: string; text: string } }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 4,
      background: color.bg, border: `1px solid ${color.border}`, borderRadius: 4,
      padding: '2px 8px', fontSize: 11,
    }}>
      <span style={{ fontWeight: 700, fontSize: 13, color: color.text }}>{count}</span>
      <span style={{ color: color.text, opacity: 0.8 }}>{label}</span>
    </div>
  );
}

// --- Conversation Row ---
function ConvRow({ conv, expanded, snippet, isVisible, isWrong, isSelected, isCompleted, projects, onToggleSelect, onClick, onActivate, onFinish, onDelete }: {
  conv: Conversation; expanded: boolean; snippet?: string;
  isVisible: boolean; isWrong: boolean; isSelected: boolean; isCompleted?: boolean;
  projects: ProjectInfo[];
  onToggleSelect: () => void; onClick: () => void; onActivate: (target: string) => void; onFinish: () => void; onDelete: () => void;
}) {
  const [openMenu, setOpenMenu] = useState<null | 'move'>(null);
  const account = ACCOUNTS.find(a => a.id === conv.accountId);
  const displayName = conv.customName || (conv.summary?.split('\n')[0] || '').slice(0, 70) || 'Neue Konversation';
  const colors = getConvColor(conv);
  const reasonLabel = conv.attentionReason ? REASON_LABELS[conv.attentionReason] || conv.attentionReason : '';
  const isWorking = conv.attentionState === 'working' || !!conv.streamingId;
  const isNeedsInput = conv.attentionState === 'needs_attention' && conv.attentionReason !== 'done';

  useEffect(() => {
    if (!openMenu) return;
    const h = () => setOpenMenu(null);
    document.addEventListener('click', h); return () => document.removeEventListener('click', h);
  }, [openMenu]);

  return (
    <div className="cq-row" style={{
      background: colors.bg,
      borderLeft: `5px solid ${colors.border}`,
      borderBottom: '1px solid rgba(255,255,255,0.04)',
      transition: 'all 0.15s',
      cursor: 'pointer',
    }}>
      {/* Main row */}
      <div onClick={onClick} style={{ display: 'flex', alignItems: 'center', padding: '8px 12px 6px 8px', gap: 8 }}>
        <input type="checkbox" checked={isSelected} onChange={e => { e.stopPropagation(); onToggleSelect(); }}
          style={{ width: 14, height: 14, cursor: 'pointer', flexShrink: 0, accentColor: colors.border }} />

        {/* Status badge — big and obvious */}
        {!isCompleted && colors.label && (
          <span style={{
            fontSize: 9, fontWeight: 700, letterSpacing: '0.04em',
            padding: '2px 6px', borderRadius: 3, flexShrink: 0,
            background: colors.labelBg, color: colors.text,
            border: `1px solid ${colors.border}55`,
            animation: (isNeedsInput || conv.attentionReason === 'rate_limit') ? 'cq-pulse 1s ease-in-out infinite' : undefined,
            whiteSpace: 'nowrap',
          }}>
            {reasonLabel || colors.label}
            {isWorking && conv.toolInfo?.toolName ? ` · ${conv.toolInfo.toolName}` : ''}
          </span>
        )}
        {isCompleted && (
          <span style={{ fontSize: 9, fontWeight: 600, padding: '2px 6px', borderRadius: 3, flexShrink: 0, background: 'rgba(86,90,110,0.15)', color: '#565a6e' }}>FERTIG</span>
        )}

        {/* Content */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ fontWeight: 600, fontSize: 12, color: colors.text }}>{conv.projectName}</span>
            {isWrong && <span style={{ fontSize: 8, padding: '0 3px', borderRadius: 2, background: '#e0af68', color: '#1a1b26', fontWeight: 700 }}>?</span>}
            <span style={{ fontSize: 9, padding: '0 4px', borderRadius: 3, background: account?.color || '#565a6e', color: '#1a1b26', fontWeight: 600 }}>{account?.label || conv.accountId}</span>
            {isVisible && <span style={{ fontSize: 8, padding: '0 4px', borderRadius: 3, background: 'rgba(16,185,129,0.2)', color: '#10B981', fontWeight: 600 }}>Panel</span>}
            <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--tn-text-secondary)', whiteSpace: 'nowrap' }}>
              {conv.messageCount} msgs · {timeAgo(conv.lastPromptAt || conv.updatedAt)}
            </span>
          </div>
          <div style={{ fontSize: 11, color: isCompleted ? '#565a6e' : 'var(--tn-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1 }}>{displayName}</div>
        </div>

        {/* Actions */}
        <div className="cq-actions" style={{ display: 'flex', gap: 3, opacity: 0.4, transition: 'opacity 0.15s', flexShrink: 0 }} onClick={e => e.stopPropagation()}>
          <div style={{ position: 'relative' }}>
            <button onClick={(e) => { e.stopPropagation(); setOpenMenu(openMenu === 'move' ? null : 'move'); }}
              style={{ background: 'rgba(139,92,246,0.15)', border: '1px solid rgba(139,92,246,0.4)', color: '#A78BFA', cursor: 'pointer', fontSize: 10, padding: '2px 8px', borderRadius: 3, fontWeight: 600 }}>
              Öffnen
            </button>
            {openMenu === 'move' && (
              <div onClick={e => e.stopPropagation()} style={{
                position: 'absolute', right: 0, top: '100%', marginTop: 2, zIndex: 200,
                background: 'var(--tn-surface)', border: '1px solid var(--tn-border)', borderRadius: 5,
                boxShadow: '0 4px 16px rgba(0,0,0,0.5)', minWidth: 180, padding: '4px 0', maxHeight: 300, overflow: 'auto',
              }}>
                <div style={{ padding: '4px 10px', fontSize: 9, color: 'var(--tn-text-secondary)', fontWeight: 700, textTransform: 'uppercase' }}>Workspace wählen</div>
                {projects.filter(p => p.name === conv.projectName).map(p => (
                  <div key={p.id} onClick={() => { onActivate(p.name); setOpenMenu(null); }}
                    style={{ padding: '5px 10px', fontSize: 11, cursor: 'pointer', color: '#10B981', fontWeight: 600 }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.06)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                    {p.name} <span style={{ fontSize: 8, opacity: 0.6 }}>(aktuell)</span>
                  </div>
                ))}
                {projects.filter(p => p.name !== conv.projectName).map(p => (
                  <div key={p.id} onClick={() => { onActivate(p.name); setOpenMenu(null); }}
                    style={{ padding: '5px 10px', fontSize: 11, cursor: 'pointer', color: 'var(--tn-text)' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.06)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                    {p.name}
                  </div>
                ))}
              </div>
            )}
          </div>
          <button onClick={onFinish}
            style={{ background: isCompleted ? 'rgba(245,158,11,0.15)' : 'rgba(16,185,129,0.15)', border: `1px solid ${isCompleted ? 'rgba(245,158,11,0.4)' : 'rgba(16,185,129,0.4)'}`, color: isCompleted ? '#F59E0B' : '#10B981', cursor: 'pointer', fontSize: 10, padding: '2px 8px', borderRadius: 3, fontWeight: 600 }}>
            {isCompleted ? 'Restore' : 'Finish'}
          </button>
          <button onClick={onDelete}
            style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#EF4444', cursor: 'pointer', fontSize: 10, padding: '2px 8px', borderRadius: 3 }}>
            Del
          </button>
        </div>
      </div>

      {/* Expanded snippet */}
      {expanded && (
        <div style={{ padding: '0 12px 8px 38px' }}>
          <div style={{
            padding: '6px 10px', borderRadius: 4, background: 'rgba(0,0,0,0.3)',
            borderLeft: `3px solid ${colors.border}44`,
            fontFamily: 'ui-monospace, "SF Mono", Monaco, Menlo, monospace',
            fontSize: 11, lineHeight: '15px', color: '#c0caf5',
            whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 160, overflow: 'auto',
          }}>
            {snippet || <span style={{ color: 'var(--tn-text-muted)', fontStyle: 'italic' }}>Lade...</span>}
          </div>
          <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', marginTop: 3 }}>
            {conv.model && <span>{conv.model.split('-').slice(0, 3).join('-')} · </span>}
            {conv.sessionId.slice(0, 12)}
          </div>
        </div>
      )}
    </div>
  );
}
