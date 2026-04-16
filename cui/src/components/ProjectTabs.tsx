import { useState, useCallback, useEffect, useRef, memo, useMemo } from 'react';
import { type Project, ACCOUNTS } from '../types';
import { useAuth } from '../contexts/AuthContext';

interface ProjectTabsProps {
  projects: Project[];
  activeId: string;
  attention?: Record<string, 'working' | 'needs_attention' | 'idle'>;
  missingSessions?: number;
  onSelect: (id: string) => void;
  onNew: () => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  missionActive?: boolean;
  onMissionClick?: () => void;
  allChatsActive?: boolean;
  onAllChatsClick?: () => void;
  isMobile?: boolean;
}

type SyncState = 'idle' | 'syncing' | 'done' | 'error';

// --- Mode Detection (from Electron preload or URL param) ---
type CuiMode = 'remote' | 'local' | 'dev';
const MODE_COLORS: Record<CuiMode, string> = {
  remote: '#e0af68',  // orange — remote server
  local: '#9ece6a',   // green — local copy
  dev: '#bb9af7',     // purple — development
};
function detectCuiMode(): CuiMode {
  // URL param set by main.cjs is most reliable (preload may not get argv in sandbox)
  const fromUrl = new URLSearchParams(window.location.search).get('mode');
  if (fromUrl === 'local' || fromUrl === 'dev' || fromUrl === 'remote') return fromUrl;
  const fromElectron = (window as any).electronAPI?.mode;
  if (fromElectron) return fromElectron as CuiMode;
  return 'remote';
}
const CUI_MODE = detectCuiMode();

// --- Account Usage Types ---
interface UsageAccount {
  accountId: string;
  accountName: string;
  status: 'safe' | 'warning' | 'critical';
  scraped: {
    currentSession: { percent: number; resetIn: string };
    weeklyAllModels: { percent: number; resetDate: string };
    weeklySonnet: { percent: number; resetDate: string };
    extraUsage: { percent: number; spent: string; limit: string; balance: string };
  } | null;
}

function usagePctColor(pct: number): string {
  if (pct >= 80) return 'var(--tn-red)';
  if (pct >= 50) return 'var(--tn-orange)';
  return 'var(--tn-green)';
}

// Shorten reset strings: "Zurücksetzung in 1 Std. 59 Min." → "1h59m", "Zurücksetzung Sa., 09:00" → "Sa 09:00"
// Also handles English: "Resets in 5 hr 59 min" → "5h59m", "Resets Tue 9:59 AM" → "Tue 9:59"
function shortenReset(raw: string): string {
  if (!raw) return '';
  // "in X Std. Y Min." or "in X hr Y min"
  const durMatch = raw.match(/(\d+)\s*(?:Std\.|hr)\s*(\d+)\s*(?:Min\.|min)/);
  if (durMatch) return `${durMatch[1]}h${durMatch[2]}m`;
  // "in Y Min." or "in Y min"
  const minOnly = raw.match(/in\s*(\d+)\s*(?:Min\.|min)/);
  if (minOnly) return `${minOnly[1]}m`;
  // Weekday + time: "Sa., 09:00" or "Tue 9:59 AM"
  const dayMatch = raw.match(/(Mo|Di|Mi|Do|Fr|Sa|So|Mon|Tue|Wed|Thu|Fri|Sat|Sun)\.?,?\s*([\d:]+)/i);
  if (dayMatch) return `${dayMatch[1]} ${dayMatch[2]}`;
  return raw.replace(/^(Zurücksetzung|Resets?)\s*/i, '').trim();
}

// --- Usage Pill (single account) ---
function UsagePill({ account }: { account: UsageAccount }) {
  const accountDef = ACCOUNTS.find(a => a.id === account.accountId);
  const color = accountDef?.color || 'var(--tn-text-muted)';
  const s = account.scraped;
  const shortName = account.accountName.slice(0, 3).toUpperCase();
  const weeklyPct = s?.weeklyAllModels.percent ?? 0;
  const sessionPct = s?.currentSession.percent ?? 0;
  const weeklyColor = usagePctColor(weeklyPct);
  const sessionColor = usagePctColor(sessionPct);

  const weeklyReset = s ? shortenReset(s.weeklyAllModels.resetDate) : '';
  const sessionReset = s ? shortenReset(s.currentSession.resetIn) : '';

  const tooltip = s
    ? [
        account.accountName,
        `Sitzung: ${sessionPct}% ${s.currentSession.resetIn || ''}`,
        `Weekly: ${weeklyPct}% ${s.weeklyAllModels.resetDate || ''}`,
        `Sonnet: ${s.weeklySonnet.percent}% ${s.weeklySonnet.resetDate || ''}`,
        s.extraUsage.percent > 0 ? `Extra: ${s.extraUsage.spent} / ${s.extraUsage.limit}` : null,
      ].filter(Boolean).join('\n')
    : `${account.accountName}: Keine Daten`;

  return (
    <div
      title={tooltip}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 3,
        padding: '2px 5px',
        borderRadius: 4,
        background: account.status === 'critical'
          ? 'rgba(247,118,142,0.12)'
          : account.status === 'warning'
            ? 'rgba(224,175,104,0.08)'
            : 'rgba(255,255,255,0.03)',
        border: `1px solid ${account.status === 'critical' ? 'rgba(247,118,142,0.4)' : 'rgba(255,255,255,0.06)'}`,
        cursor: 'default', flexShrink: 0,
        WebkitAppRegion: 'no-drag',
      } as React.CSSProperties}
    >
      <span style={{ fontSize: 9, fontWeight: 700, color, letterSpacing: '0.02em', lineHeight: 1 }}>
        {shortName}
      </span>
      {s ? (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1, width: 36 }}>
            <div style={{ height: 3, background: 'rgba(255,255,255,0.08)', borderRadius: 1.5, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${Math.min(100, weeklyPct)}%`, background: weeklyColor, borderRadius: 1.5, transition: 'width 0.5s ease' }} />
            </div>
            <div style={{ height: 2, background: 'rgba(255,255,255,0.06)', borderRadius: 1, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${Math.min(100, sessionPct)}%`, background: sessionColor, borderRadius: 1, transition: 'width 0.5s ease' }} />
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 0, lineHeight: 1 }}>
            <span style={{ fontSize: 8, fontWeight: 600, fontFamily: 'monospace', color: weeklyColor, whiteSpace: 'nowrap' }}>
              {weeklyPct}% <span style={{ opacity: 0.6, fontWeight: 400 }}>{weeklyReset}</span>
            </span>
            <span style={{ fontSize: 7, fontFamily: 'monospace', color: sessionColor, opacity: 0.7, whiteSpace: 'nowrap' }}>
              {sessionPct}% <span style={{ fontWeight: 400 }}>{sessionReset}</span>
            </span>
          </div>
        </>
      ) : (
        <span style={{ fontSize: 8, color: 'var(--tn-text-muted)', opacity: 0.5 }}>?</span>
      )}
    </div>
  );
}

// --- Usage Bars (all accounts) ---
const USAGE_CACHE_KEY = 'cui-usage-accounts';

function loadCachedAccounts(): UsageAccount[] {
  try {
    const raw = localStorage.getItem(USAGE_CACHE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function UsageBars() {
  const [accounts, setAccounts] = useState<UsageAccount[]>(loadCachedAccounts);
  const pollRef = useRef<ReturnType<typeof setInterval>>(null);

  const fetchUsage = useCallback(() => {
    if ((window as any).__cuiServerAlive !== true) return;
    fetch('/api/claude-code/stats-v2', { signal: AbortSignal.timeout(12000) })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data?.accounts) return;
        const filtered = data.accounts.filter((a: UsageAccount) => a.accountId !== 'local');
        setAccounts(filtered);
        try { localStorage.setItem(USAGE_CACHE_KEY, JSON.stringify(filtered)); } catch { /* quota */ }
      })
      .catch(() => { /* server not ready or timeout — cached data stays visible */ });
  }, []);

  useEffect(() => {
    fetchUsage();
    pollRef.current = setInterval(fetchUsage, 120_000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetchUsage]);

  if (accounts.length === 0) return null;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginRight: 8, flexShrink: 0 }}>
      {accounts.map(acc => <UsagePill key={acc.accountId} account={acc} />)}
    </div>
  );
}

// --- Syncthing Toggle ---
function SyncthingToggle() {
  const [paused, setPaused] = useState<boolean | null>(null); // null = loading/unknown
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval>>(null);

  const syncUnavailableRef = useRef(false);
  const fetchStatus = useCallback(() => {
    if ((window as any).__cuiServerAlive !== true) return;
    if (syncUnavailableRef.current) return; // Syncthing not running — stop polling
    fetch('/api/syncthing/status', { signal: AbortSignal.timeout(10000) })
      .then(r => {
        if (r.status === 502) { syncUnavailableRef.current = true; return null; } // Syncthing offline (evening-only)
        if (!r.ok) return null;
        return r.json();
      })
      .then(data => {
        if (!data) return;
        setPaused(data.paused);
        if (data.lastSyncAt) setLastSync(data.lastSyncAt);
      })
      .catch(() => { /* timeout on slow connections */ });
  }, []);

  useEffect(() => {
    fetchStatus();
    pollRef.current = setInterval(fetchStatus, 30000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetchStatus]);

  const toggle = useCallback(async () => {
    if ((window as any).__cuiServerAlive === false) return;
    if (toggling || paused === null) return;
    setToggling(true);
    try {
      const endpoint = paused ? '/api/syncthing/resume' : '/api/syncthing/pause';
      const res = await fetch(endpoint, { method: 'POST', signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`syncthing toggle ${res.status}`);
      const data = await res.json();
      setPaused(data.paused);
    } catch (err) {
      console.warn('[ProjectTabs] syncthingToggle:', err);
    }
    setToggling(false);
  }, [paused, toggling]);

  // Format last sync time as relative
  const lastSyncLabel = lastSync ? (() => {
    const diff = Date.now() - new Date(lastSync).getTime();
    if (diff < 60000) return 'gerade';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
    return `${Math.floor(diff / 86400000)}d`;
  })() : null;

  if (paused === null) return null; // Don't render until status known

  const color = paused ? '#EF4444' : '#10B981';

  return (
    <button
      onClick={toggle}
      disabled={toggling}
      title={paused
        ? `Syncthing PAUSIERT${lastSyncLabel ? ` — Letzter Sync: vor ${lastSyncLabel}` : ''}\nKlick zum Fortsetzen`
        : `Syncthing AKTIV${lastSyncLabel ? ` — Letzter Sync: vor ${lastSyncLabel}` : ''}\nKlick zum Pausieren`
      }
      style={{
        background: paused ? 'rgba(239,68,68,0.1)' : 'none',
        border: `1px solid ${color}`,
        color,
        padding: '3px 8px',
        fontSize: 10,
        fontWeight: 600,
        cursor: toggling ? 'wait' : 'pointer',
        borderRadius: 4,
        marginRight: 6,
        whiteSpace: 'nowrap',
        transition: 'all 0.2s',
        opacity: toggling ? 0.5 : 1,
        WebkitAppRegion: 'no-drag',
      } as React.CSSProperties}
    >
      {paused ? 'ST paused' : 'ST'}{lastSyncLabel ? ` (${lastSyncLabel})` : ''}
    </button>
  );
}

// --- Workspace Category Navigation ---
interface WorkspaceCategory {
  id: string;
  label: string;
  icon: string;
  order: number;
}

const FALLBACK_CATEGORIES: WorkspaceCategory[] = [
  { id: 'apps', label: 'Apps', icon: '🚀', order: 1 },
  { id: 'sessions', label: 'Sessions', icon: '🎛', order: 2 },
  { id: 'devops', label: 'DevOps', icon: '🔧', order: 3 },
  { id: 'partner', label: 'Partner', icon: '🤝', order: 4 },
  { id: 'business', label: 'Business', icon: '📊', order: 5 },
  { id: 'maintenance', label: 'Maintenance', icon: '🛠', order: 6 },
  { id: 'stage', label: 'Stage', icon: '📁', order: 7 },
];

function getProjectCategory(project: Project): string {
  return (project as any).category || 'stage';
}

export default memo(function ProjectTabs({ projects, activeId, attention, missingSessions = 0, onSelect, onNew, onEdit, onDelete, missionActive, onMissionClick, allChatsActive, onAllChatsClick, isMobile }: ProjectTabsProps) {
  const [syncState, setSyncState] = useState<SyncState>('idle');
  const [syncDetail, setSyncDetail] = useState('');
  const [pendingCount, setPendingCount] = useState(0);
  const [allLive, setAllLive] = useState(false);
  const [panelHealth, setPanelHealth] = useState<{ running: number; total: number; missing: string[] } | null>(null);
  const [showSubSessions, setShowSubSessions] = useState<boolean>(() => {
    try { return localStorage.getItem('cui-show-sub-sessions') === 'true'; } catch { return false; }
  });
  const { user, authEnabled, logout, canAccessWorkspace } = useAuth();

  // --- Category Navigation state ---
  const [categories, setCategories] = useState<WorkspaceCategory[]>(FALLBACK_CATEGORIES);
  const [lastWorkspacePerCat, _setLastWorkspacePerCat] = useState<Record<string, string>>(() => {
    try {
      const raw = localStorage.getItem('cui-last-workspace-per-category');
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  });

  const persistLastWorkspace = useCallback((catId: string, wsId: string) => {
    _setLastWorkspacePerCat(prev => {
      const next = { ...prev, [catId]: wsId };
      try { localStorage.setItem('cui-last-workspace-per-category', JSON.stringify(next)); } catch {}
      return next;
    });
  }, []);

  // Listen for update-available notifications via WebSocket (forwarded by App.tsx)
  useEffect(() => {
    function handleMessage(e: MessageEvent) {
      try {
        const msg = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
        if (msg.type === 'cui-update-available') {
          setPendingCount(msg.count || 0);
        }
      } catch { /* ignore */ }
    }
    window.addEventListener('message', handleMessage);
    // Also check on mount (delayed to allow WS to connect first)
    setTimeout(() => {
      if ((window as any).__cuiServerAlive === false) return;
      fetch('/api/cui-sync/pending', { signal: AbortSignal.timeout(10000) })
        .then(r => { if (!r.ok) throw new Error(`cui-sync/pending ${r.status}`); return r.json(); })
        .then(d => { if (d?.count > 0) setPendingCount(d.count); })
        .catch((err) => { console.warn('[ProjectTabs] fetchPending:', err); });
    }, 2000);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const handleSync = useCallback(async () => {
    if ((window as any).__cuiServerAlive === false) return;
    if (syncState === 'syncing') return;
    setSyncState('syncing');
    setSyncDetail('Building...');
    try {
      const resp = await fetch('/api/cui-sync', { method: 'POST', signal: AbortSignal.timeout(15000) });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `cui-sync ${resp.status}`);
      setSyncState('done');
      setSyncDetail(data.build || 'ok');
      setPendingCount(0);
      setTimeout(() => window.location.reload(), 3000);
    } catch (err: any) {
      console.warn('[ProjectTabs] handleSync:', err);
      setSyncState('error');
      setSyncDetail(err.message.slice(0, 60));
      setTimeout(() => { setSyncState('idle'); setSyncDetail(''); }, 5000);
    }
  }, [syncState]);

  const checkPanelHealth = useCallback(async () => {
    if ((window as any).__cuiServerAlive !== true) return;
    try {
      const resp = await fetch('/api/panel-health', { signal: AbortSignal.timeout(12000) });
      if (!resp.ok) return;
      const data = await resp.json();
      setPanelHealth({
        running: data.running,
        total: data.total,
        missing: data.panels.filter((p: any) => !p.running).map((p: any) => p.name)
      });
    } catch { /* timeout on slow connections */ }
  }, []);

  const handleStartPanels = useCallback(async () => {
    if ((window as any).__cuiServerAlive === false) return;
    if (syncState === 'syncing') return;
    setSyncState('syncing');
    setSyncDetail('Starting panels...');
    try {
      const resp = await fetch('/api/start-all-panels', { method: 'POST', signal: AbortSignal.timeout(15000) });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `start-all-panels ${resp.status}`);
      setSyncState('done');
      setSyncDetail(data.message || 'Panels starting');
      // Re-check health after 10s
      setTimeout(() => {
        checkPanelHealth();
        setSyncState('idle');
        setSyncDetail('');
      }, 10000);
    } catch (err: any) {
      console.warn('[ProjectTabs] handleStartPanels:', err);
      setSyncState('error');
      setSyncDetail(err.message.slice(0, 60));
      setTimeout(() => { setSyncState('idle'); setSyncDetail(''); }, 5000);
    }
  }, [syncState, checkPanelHealth]);

  // Check panel health on mount
  useEffect(() => {
    checkPanelHealth();
    const interval = setInterval(checkPanelHealth, 30000); // Check every 30s
    return () => clearInterval(interval);
  }, [checkPanelHealth]);

  // Fetch categories from API; fall back to FALLBACK_CATEGORIES on 404 or error
  useEffect(() => {
    fetch('/api/workspace-categories', { signal: AbortSignal.timeout(5000) })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.categories?.length > 0) {
          setCategories([...data.categories].sort((a: WorkspaceCategory, b: WorkspaceCategory) => a.order - b.order));
        }
      })
      .catch(() => { /* keep FALLBACK_CATEGORIES */ });
  }, []);

  // Filter projects by allowedWorkspaces, then sort: needs_attention first, working, idle, no status
  // MUST be declared before any hook that depends on it (projectsByCategory, …)
  // to avoid TDZ errors at render time.
  const sortedProjects = useMemo(() => {
    const scoreFn = (p: Project) => {
      const state = attention?.[p.id];
      if (state === 'needs_attention') return 0;
      if (state === 'working') return 1;
      if (state === 'idle') return 2;
      return 3;
    };
    return [...projects]
      .filter(p => canAccessWorkspace(p.id))
      .sort((a, b) => scoreFn(a) - scoreFn(b));
  }, [projects, attention, canAccessWorkspace]);

  // Group projects by category for multi-row rendering
  const projectsByCategory = useMemo(() => {
    const map: Record<string, Project[]> = {};
    for (const p of sortedProjects) {
      const cat = getProjectCategory(p);
      if (!map[cat]) map[cat] = [];
      map[cat].push(p);
    }
    return map;
  }, [sortedProjects]);

  // Click on a workspace tab: persist last-workspace-per-category then delegate to onSelect
  const handleWorkspaceSelect = useCallback((wsId: string) => {
    const proj = sortedProjects.find(p => p.id === wsId);
    if (proj) persistLastWorkspace(getProjectCategory(proj), wsId);
    onSelect(wsId);
  }, [sortedProjects, onSelect, persistLastWorkspace]);

  const handleRebuild = useCallback(async () => {
    if ((window as any).__cuiServerAlive === false) return;
    if (syncState === 'syncing') return;
    setSyncState('syncing');
    setSyncDetail('Rebuilding frontend...');
    try {
      // SECURITY: Include auth token (Herbert's Recommendation #2)
      const rebuildToken = (window as any).CUI_REBUILD_TOKEN || '';
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (rebuildToken) {
        headers['Authorization'] = `Bearer ${rebuildToken}`;
      }

      const resp = await fetch('/api/rebuild-frontend', {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(15000)
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `rebuild-frontend ${resp.status}`);
      setSyncState('done');
      setSyncDetail(data.detail || 'ok');
      setTimeout(() => window.location.reload(), 2000);
    } catch (err: any) {
      console.warn('[ProjectTabs] handleRebuild:', err);
      setSyncState('error');
      setSyncDetail(err.message.slice(0, 60));
      setTimeout(() => { setSyncState('idle'); setSyncDetail(''); }, 5000);
    }
  }, [syncState]);

  const syncColors: Record<SyncState, string> = {
    idle: 'var(--tn-text-muted)',
    syncing: '#3B82F6',
    done: '#10B981',
    error: '#EF4444',
  };

  const hasPending = pendingCount > 0 && syncState === 'idle';

  // --- Mobile: compact header with project dropdown ---
  if (isMobile) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 12px',
          background: 'var(--tn-bg-dark)',
          borderBottom: '1px solid var(--tn-border)',
          minHeight: 40,
          flexShrink: 0,
        }}
      >
        <img src="/werking-logo.png" alt="W" style={{ width: 22, height: 22, borderRadius: 4, marginRight: 4 }} />
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--tn-blue)' }}>WerkING Partner</span>
        <span
          style={{
            fontSize: 8,
            fontWeight: 700,
            color: '#1a1b26',
            background: MODE_COLORS[CUI_MODE],
            padding: '1px 5px',
            borderRadius: 3,
            textTransform: 'uppercase',
            letterSpacing: '0.5px',
          }}
        >
          {CUI_MODE}
        </span>
        <select
          value={activeId}
          onChange={(e) => onSelect(e.target.value)}
          style={{
            flex: 1,
            background: 'var(--tn-surface)',
            color: 'var(--tn-text)',
            border: '1px solid var(--tn-border)',
            borderRadius: 6,
            padding: '5px 8px',
            fontSize: 13,
            minHeight: 32,
          }}
        >
          {projects.filter(p => canAccessWorkspace(p.id)).map(p => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        {onMissionClick && (
          <button
            onClick={onMissionClick}
            style={{
              background: missionActive ? 'rgba(122,162,247,0.15)' : 'var(--tn-surface)',
              color: missionActive ? 'var(--tn-blue)' : 'var(--tn-text-muted)',
              border: `1px solid ${missionActive ? 'var(--tn-blue)' : 'var(--tn-border)'}`,
              borderRadius: 6,
              padding: '5px 10px',
              fontSize: 12,
              fontWeight: missionActive ? 700 : 500,
              cursor: 'pointer',
              minHeight: 32,
              whiteSpace: 'nowrap',
            }}
          >
            {missionActive ? 'X' : 'MC'}
          </button>
        )}
        {onAllChatsClick && (
          <button
            onClick={onAllChatsClick}
            style={{
              background: allChatsActive ? 'rgba(122,162,247,0.15)' : 'var(--tn-surface)',
              color: allChatsActive ? 'var(--tn-blue)' : 'var(--tn-text-muted)',
              border: `1px solid ${allChatsActive ? 'var(--tn-blue)' : 'var(--tn-border)'}`,
              borderRadius: 6,
              padding: '5px 10px',
              fontSize: 12,
              fontWeight: allChatsActive ? 700 : 500,
              cursor: 'pointer',
              minHeight: 32,
              whiteSpace: 'nowrap',
            }}
          >
            {allChatsActive ? 'X' : 'AC'}
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--tn-bg-dark)',
        borderTop: `2px solid ${MODE_COLORS[CUI_MODE]}`,
        borderBottom: '1px solid var(--tn-border)',
        flexShrink: 0,
      } as React.CSSProperties}
    >
    {/* Row 1: Drag bar with logo + MC + AC */}
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        padding: '2px 8px 2px 80px',
        minHeight: 28,
        WebkitAppRegion: 'drag',
      } as React.CSSProperties}
    >
      <img src="/werking-logo.png" alt="W" style={{ width: 20, height: 20, borderRadius: 4, marginRight: 4 }} />
      <span
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: 'var(--tn-blue)',
          marginRight: 4,
          whiteSpace: 'nowrap',
        }}
      >
        WerkING Partner
      </span>
      <span
        title={CUI_MODE === 'local'
          ? 'LOCAL MODE\n\nProjekte: ~/.cui/local-data/projects/\nLayouts: ~/.cui/local-data/layouts/\nWorkspaces: ~/Projects/{id}\nChats: Remote (CUI Binary)'
          : 'REMOTE MODE\n\nProjekte: data/projects/\nLayouts: data/layouts/\nWorkspaces: /root/orchestrator/workspaces/\nChats: /home/claude-user/.cui-account{1-4}/'}
        style={{
          fontSize: 10,
          fontWeight: 700,
          color: '#1a1b26',
          background: MODE_COLORS[CUI_MODE],
          padding: '1px 6px',
          borderRadius: 4,
          marginRight: 12,
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
          whiteSpace: 'nowrap',
          cursor: 'help',
        }}
      >
        {CUI_MODE}
      </span>

      {/* Mission Control - permanent tab */}
      {onMissionClick && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            background: missionActive ? 'var(--tn-surface)' : 'transparent',
            borderBottom: missionActive ? '2px solid #e0af68' : '2px solid transparent',
            borderRadius: '4px 4px 0 0',
            marginRight: 4,
          }}
        >
          <button
            onClick={onMissionClick}
            title="Mission Control (Cmd+0)"
            style={{
              background: 'none',
              color: missionActive ? '#e0af68' : 'var(--tn-text-muted)',
              border: 'none',
              padding: '4px 12px',
              fontSize: 12,
              cursor: 'pointer',
              fontWeight: missionActive ? 700 : 400,
              WebkitAppRegion: 'no-drag',
            } as React.CSSProperties}
          >
            MC
          </button>
        </div>
      )}

      {/* All Chats - permanent tab */}
      {onAllChatsClick && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            background: allChatsActive ? 'var(--tn-surface)' : 'transparent',
            borderBottom: allChatsActive ? '2px solid #7aa2f7' : '2px solid transparent',
            borderRadius: '4px 4px 0 0',
            marginRight: 4,
          }}
        >
          <button
            onClick={onAllChatsClick}
            title="All Chats (Cmd+`)"
            style={{
              background: 'none',
              color: allChatsActive ? '#7aa2f7' : 'var(--tn-text-muted)',
              border: 'none',
              padding: '4px 12px',
              fontSize: 12,
              cursor: 'pointer',
              fontWeight: allChatsActive ? 700 : 400,
              WebkitAppRegion: 'no-drag',
            } as React.CSSProperties}
          >
            AC
          </button>
        </div>
      )}

      <div style={{ flex: 1 }} />
    </div>{/* end Row 1 */}

    {/* Row 2..N: One row per category, each with all its workspaces (1-click) */}
    {categories.map((cat, catIdx) => {
      const catProjects = projectsByCategory[cat.id] || [];
      const isLastCategory = catIdx === categories.length - 1;
      // Hide empty categories except the last (so + Projekt button always has a home)
      if (catProjects.length === 0 && !isLastCategory) return null;
      return (
        <div
          key={cat.id}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            padding: '1px 8px',
            borderTop: '1px solid rgba(255,255,255,0.04)',
            minHeight: 22,
            WebkitAppRegion: 'no-drag',
          } as React.CSSProperties}
        >
          {/* Category label (left, fixed width) */}
          <div
            title={cat.label}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              minWidth: 110,
              maxWidth: 110,
              fontSize: 10,
              fontWeight: 600,
              color: 'var(--tn-text-muted)',
              opacity: 0.7,
              padding: '2px 4px',
              borderRight: '1px solid rgba(255,255,255,0.06)',
              flexShrink: 0,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            <span style={{ fontSize: 12 }}>{cat.icon}</span>
            <span>{cat.label}</span>
          </div>

          {/* Workspaces in this category (right, flex-wrap) */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', flex: 1, minWidth: 0 }}>
            {catProjects.map((p) => {
              const origIdx = projects.indexOf(p);
              return (
                <div
                  key={p.id}
                  ref={p.id === activeId ? (el) => { el?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } : undefined}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    background: attention?.[p.id] === 'needs_attention'
                      ? 'rgba(255, 158, 100, 0.25)'
                      : attention?.[p.id] === 'working'
                        ? 'rgba(158, 206, 106, 0.18)'
                        : p.id === activeId ? 'var(--tn-surface)' : 'transparent',
                    borderBottom: attention?.[p.id] === 'needs_attention'
                      ? '3px solid #ff9e64'
                      : attention?.[p.id] === 'working'
                        ? '3px solid #9ece6a'
                        : p.id === activeId ? '2px solid var(--tn-blue)' : '2px solid transparent',
                    borderRadius: '4px 4px 0 0',
                    transition: 'all 0.15s',
                    flexShrink: 0,
                  }}
                >
                  <button
                    onClick={() => handleWorkspaceSelect(p.id)}
                    onDoubleClick={(e) => { e.preventDefault(); onEdit(p.id); }}
                    title={`${p.name} — ${p.workDir}\nDoppelklick zum Bearbeiten${origIdx < 9 ? `\nCmd+${origIdx + 1}` : ''}`}
                    style={{
                      background: 'none',
                      color: p.id === activeId ? 'var(--tn-text)' : 'var(--tn-text-muted)',
                      border: 'none',
                      padding: '2px 8px 2px 10px',
                      fontSize: 11,
                      cursor: 'pointer',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      WebkitAppRegion: 'no-drag',
                    } as React.CSSProperties}
                  >
                    {attention?.[p.id] && (
                      <span style={{
                        width: 7, height: 7, borderRadius: '50%',
                        background: attention[p.id] === 'needs_attention' ? '#ff9e64'
                          : attention[p.id] === 'working' ? '#9ece6a'
                          : '#565f89',
                        boxShadow: attention[p.id] === 'needs_attention'
                          ? '0 0 8px #ff9e64aa, 0 0 3px #ff9e64'
                          : attention[p.id] === 'working'
                          ? '0 0 6px #9ece6a88'
                          : 'none',
                        display: 'inline-block', marginRight: 5, flexShrink: 0,
                        animation: attention[p.id] === 'needs_attention' ? 'pulse-attention 0.8s ease-in-out infinite'
                          : attention[p.id] === 'working' ? 'pulse 1.5s ease-in-out infinite'
                          : 'none',
                      }} />
                    )}
                    {origIdx < 9 && (
                      <span style={{ fontSize: 9, opacity: 0.4, marginRight: 4, fontFamily: 'monospace' }}>
                        {origIdx + 1}
                      </span>
                    )}
                    {p.name}
                  </button>
                  {projects.length > 1 && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete(p.id);
                      }}
                      title={`Delete ${p.name}`}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: 'var(--tn-text-muted)',
                        cursor: 'pointer',
                        fontSize: 10,
                        padding: '2px 6px 2px 0',
                        opacity: 0.5,
                        transition: 'opacity 0.15s',
                        WebkitAppRegion: 'no-drag',
                      } as React.CSSProperties}
                      onMouseEnter={(e) => { (e.target as HTMLElement).style.opacity = '1'; (e.target as HTMLElement).style.color = 'var(--tn-red)'; }}
                      onMouseLeave={(e) => { (e.target as HTMLElement).style.opacity = '0.5'; (e.target as HTMLElement).style.color = 'var(--tn-text-muted)'; }}
                    >
                      ✕
                    </button>
                  )}
                </div>
              );
            })}

            {/* + Projekt button only on the last visible category row */}
            {isLastCategory && (
              <button
                onClick={onNew}
                title="Neues Projekt (Cmd+N)"
                style={{
                  background: 'none',
                  border: '1px dashed var(--tn-border)',
                  color: 'var(--tn-text-muted)',
                  padding: '2px 8px',
                  fontSize: 10,
                  cursor: 'pointer',
                  borderRadius: 3,
                  marginLeft: 4,
                  flexShrink: 0,
                  WebkitAppRegion: 'no-drag',
                } as React.CSSProperties}
              >
                + Projekt
              </button>
            )}
          </div>
        </div>
      );
    })}

    {/* Row 2: Account usage pills + toolbar */}
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 8px',
        borderTop: '1px solid rgba(255,255,255,0.04)',
        flexWrap: 'wrap',
        WebkitAppRegion: 'no-drag',
      } as React.CSSProperties}
    >
      {/* Account Usage Bars — always first, always visible */}
      <UsageBars />

      {/* Divider */}
      <div style={{ width: 1, height: 14, background: 'var(--tn-border)', opacity: 0.3 }} />

      {/* Toolbar buttons */}
      <SyncthingToggle />

      <button
        onClick={() => {
          const newState = !allLive;
          setAllLive(newState);
          window.dispatchEvent(new CustomEvent('cui-all-live', { detail: { live: newState } }));
        }}
        title={allLive ? 'Live-Modus aus (Static: WS Events only)' : 'Live-Modus fuer alle Chats (Echtzeit-Streaming)'}
        style={{
          background: allLive ? 'rgba(168,85,247,0.15)' : 'none',
          border: `1px solid ${allLive ? '#A855F7' : 'var(--tn-border)'}`,
          color: allLive ? '#A855F7' : 'var(--tn-text-muted)',
          padding: '2px 6px',
          fontSize: 9,
          fontWeight: allLive ? 700 : 400,
          cursor: 'pointer',
          borderRadius: 3,
          whiteSpace: 'nowrap',
        } as React.CSSProperties}
      >
        {allLive ? '\u25CF Live' : '\u23F8 Static'}
      </button>

      {panelHealth && panelHealth.missing.length > 0 && (
        <button
          onClick={handleStartPanels}
          disabled={syncState === 'syncing'}
          title={`${panelHealth.missing.length} panel(s) offline:\n${panelHealth.missing.join('\n')}\n\nClick to start all missing panels`}
          style={{
            background: 'rgba(239,68,68,0.15)',
            border: '1px solid #EF4444',
            color: '#EF4444',
            padding: '2px 6px',
            fontSize: 9,
            fontWeight: 600,
            cursor: syncState === 'syncing' ? 'wait' : 'pointer',
            borderRadius: 3,
            whiteSpace: 'nowrap',
          } as React.CSSProperties}
        >
          {panelHealth.missing.length}P offline
        </button>
      )}

      <button
        onClick={handleRebuild}
        disabled={syncState === 'syncing'}
        title="Rebuild CUI frontend (npm run build + restart server)"
        style={{
          background: 'none',
          border: '1px solid var(--tn-border)',
          color: 'var(--tn-text-muted)',
          padding: '2px 6px',
          fontSize: 9,
          fontWeight: 600,
          cursor: syncState === 'syncing' ? 'wait' : 'pointer',
          borderRadius: 3,
          whiteSpace: 'nowrap',
        } as React.CSSProperties}
      >
        Rebuild
      </button>

      <button
        onClick={async () => {
          if ('serviceWorker' in navigator) {
            const regs = await navigator.serviceWorker.getRegistrations();
            await Promise.all(regs.map(r => r.unregister()));
          }
          if ('caches' in window) {
            const keys = await caches.keys();
            await Promise.all(keys.map(k => caches.delete(k)));
          }
          window.dispatchEvent(new CustomEvent('nuclear-refresh'));
          const keep = ['flexlayout', 'cui-workspace-'];
          Object.keys(localStorage).forEach(k => {
            if (!keep.some(prefix => k.startsWith(prefix))) localStorage.removeItem(k);
          });
          setTimeout(() => {
            window.location.href = window.location.pathname + '?_cb=' + Date.now();
          }, 200);
        }}
        title="Nuclear Refresh: Service Workers + Cache + alle Panels neu laden"
        style={{
          background: 'none',
          border: '1px solid var(--tn-border)',
          color: 'var(--tn-text-muted)',
          padding: '2px 6px',
          fontSize: 9,
          fontWeight: 600,
          cursor: 'pointer',
          borderRadius: 3,
          whiteSpace: 'nowrap',
        } as React.CSSProperties}
      >
        Cache
      </button>

      <button
        onClick={handleSync}
        disabled={syncState === 'syncing'}
        title={
          hasPending
            ? `${pendingCount} Datei${pendingCount > 1 ? 'en' : ''} geaendert — Klick zum Updaten`
            : syncState === 'idle' ? 'Build + Restart (keine Aenderungen)'
            : syncDetail
        }
        style={{
          background: hasPending ? 'rgba(224,175,104,0.15)' : syncState === 'syncing' ? 'rgba(59,130,246,0.15)' : 'none',
          border: `1px solid ${hasPending ? '#e0af68' : syncState === 'idle' ? 'var(--tn-border)' : syncColors[syncState]}`,
          color: hasPending ? '#e0af68' : syncColors[syncState],
          padding: '2px 6px',
          fontSize: 9,
          fontWeight: 600,
          cursor: syncState === 'syncing' ? 'wait' : 'pointer',
          borderRadius: 3,
          whiteSpace: 'nowrap',
        } as React.CSSProperties}
      >
        {syncState === 'idle' && !hasPending && 'Sync'}
        {syncState === 'idle' && hasPending && `Update (${pendingCount})`}
        {syncState === 'syncing' && 'Syncing...'}
        {syncState === 'done' && 'Reloading...'}
        {syncState === 'error' && 'Sync Error'}
      </button>

      {syncDetail && syncState !== 'idle' && (
        <span style={{ fontSize: 8, color: syncColors[syncState] }}>{syncDetail}</span>
      )}

      <button
        onClick={() => {
          // Clear flexlayout cache for active project so auto-layout starts fresh
          Object.keys(localStorage).forEach(k => {
            if (k.startsWith('cui-layout-')) localStorage.removeItem(k);
          });
          // Dispatch manual auto-layout trigger to LayoutManager
          window.dispatchEvent(new CustomEvent('cui-auto-layout', { detail: { projectId: activeId } }));
        }}
        title={missingSessions > 0
          ? `Layout anordnen — ${missingSessions} Session${missingSessions > 1 ? 's' : ''} nicht sichtbar`
          : 'Layout automatisch anordnen (löscht Layout-Cache + ordnet Panels neu an)'}
        style={{
          background: missingSessions > 0 ? 'rgba(224,175,104,0.15)' : 'none',
          border: `1px solid ${missingSessions > 0 ? '#e0af68' : 'var(--tn-border)'}`,
          color: missingSessions > 0 ? '#e0af68' : 'var(--tn-text-muted)',
          padding: '2px 6px',
          fontSize: 9,
          fontWeight: 600,
          cursor: 'pointer',
          borderRadius: 3,
          whiteSpace: 'nowrap',
        } as React.CSSProperties}
      >
        Layout{missingSessions > 0 ? ` (${missingSessions})` : ''}
      </button>

      <button
        onClick={() => {
          const next = !showSubSessions;
          setShowSubSessions(next);
          try { localStorage.setItem('cui-show-sub-sessions', String(next)); } catch {}
          // Trigger immediate layout sync in active LayoutManager
          window.dispatchEvent(new CustomEvent('cui-auto-layout', { detail: { projectId: activeId } }));
        }}
        title={showSubSessions ? 'Sub-Sessions ausblenden' : 'Sub-Sessions einblenden'}
        style={{
          background: showSubSessions ? 'rgba(122,162,247,0.15)' : 'none',
          border: `1px solid ${showSubSessions ? '#7aa2f7' : 'var(--tn-border)'}`,
          color: showSubSessions ? '#7aa2f7' : 'var(--tn-text-muted)',
          padding: '2px 6px',
          fontSize: 9,
          fontWeight: 600,
          cursor: 'pointer',
          borderRadius: 3,
          whiteSpace: 'nowrap',
        } as React.CSSProperties}
      >
        Sub
      </button>

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* User badge + logout (only when auth enabled) */}
      {authEnabled && user && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '2px 6px',
          background: 'rgba(122,162,247,0.1)',
          border: '1px solid rgba(122,162,247,0.3)',
          borderRadius: 3,
          fontSize: 9,
          color: '#7aa2f7',
          whiteSpace: 'nowrap',
        }}>
          <span style={{ fontWeight: 600 }}>{user.name}</span>
          <button
            onClick={() => logout()}
            title="Abmelden"
            style={{
              background: 'none',
              border: 'none',
              color: '#f7768e',
              cursor: 'pointer',
              padding: '0 2px',
              fontSize: 9,
              fontWeight: 600,
              lineHeight: 1,
            }}
          >
            X
          </button>
        </div>
      )}
    </div>
    </div>
  );
});
