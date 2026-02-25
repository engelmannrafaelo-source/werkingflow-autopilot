import { useState, useCallback, useEffect, useRef, memo } from 'react';
import { type Project } from '../types';

interface ProjectTabsProps {
  projects: Project[];
  activeId: string;
  attention?: Set<string>;
  onSelect: (id: string) => void;
  onNew: () => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  missionActive?: boolean;
  onMissionClick?: () => void;
}

type SyncState = 'idle' | 'syncing' | 'done' | 'error';

// --- Syncthing Toggle ---
function SyncthingToggle() {
  const [paused, setPaused] = useState<boolean | null>(null); // null = loading/unknown
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval>>(null);

  const fetchStatus = useCallback(() => {
    fetch('/api/syncthing/status')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data) return;
        setPaused(data.paused);
        if (data.lastSyncAt) setLastSync(data.lastSyncAt);
      })
      .catch(() => setPaused(null));
  }, []);

  useEffect(() => {
    fetchStatus();
    pollRef.current = setInterval(fetchStatus, 30000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetchStatus]);

  const toggle = useCallback(async () => {
    if (toggling || paused === null) return;
    setToggling(true);
    try {
      const endpoint = paused ? '/api/syncthing/resume' : '/api/syncthing/pause';
      const res = await fetch(endpoint, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        setPaused(data.paused);
      }
    } catch {}
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

export default memo(function ProjectTabs({ projects, activeId, attention, onSelect, onNew, onEdit, onDelete, missionActive, onMissionClick }: ProjectTabsProps) {
  const [syncState, setSyncState] = useState<SyncState>('idle');
  const [syncDetail, setSyncDetail] = useState('');
  const [pendingCount, setPendingCount] = useState(0);
  const [allLive, setAllLive] = useState(false);
  const [panelHealth, setPanelHealth] = useState<{ running: number; total: number; missing: string[] } | null>(null);

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
    // Also check on mount
    fetch('/api/cui-sync/pending').then(r => r.json()).then(d => {
      if (d.count > 0) setPendingCount(d.count);
    }).catch(() => {});
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const handleSync = useCallback(async () => {
    if (syncState === 'syncing') return;
    setSyncState('syncing');
    setSyncDetail('Building...');
    try {
      const resp = await fetch('/api/cui-sync', { method: 'POST' });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Sync failed');
      setSyncState('done');
      setSyncDetail(data.build || 'ok');
      setPendingCount(0);
      setTimeout(() => window.location.reload(), 3000);
    } catch (err: any) {
      setSyncState('error');
      setSyncDetail(err.message.slice(0, 60));
      setTimeout(() => { setSyncState('idle'); setSyncDetail(''); }, 5000);
    }
  }, [syncState]);

  const checkPanelHealth = useCallback(async () => {
    try {
      const resp = await fetch('/api/panel-health');
      const data = await resp.json();
      setPanelHealth({
        running: data.running,
        total: data.total,
        missing: data.panels.filter((p: any) => !p.running).map((p: any) => p.name)
      });
    } catch {
      setPanelHealth(null);
    }
  }, []);

  const handleStartPanels = useCallback(async () => {
    if (syncState === 'syncing') return;
    setSyncState('syncing');
    setSyncDetail('Starting panels...');
    try {
      const resp = await fetch('/api/start-all-panels', { method: 'POST' });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Failed to start panels');
      setSyncState('done');
      setSyncDetail(data.message || 'Panels starting');
      // Re-check health after 10s
      setTimeout(() => {
        checkPanelHealth();
        setSyncState('idle');
        setSyncDetail('');
      }, 10000);
    } catch (err: any) {
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

  const handleRebuild = useCallback(async () => {
    if (syncState === 'syncing') return;
    setSyncState('syncing');
    setSyncDetail('Rebuilding frontend...');
    try {
      const resp = await fetch('/api/rebuild-frontend', { method: 'POST' });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Rebuild failed');
      setSyncState('done');
      setSyncDetail(data.detail || 'ok');
      setTimeout(() => window.location.reload(), 2000);
    } catch (err: any) {
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

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        padding: '0 8px 0 80px',
        background: 'var(--tn-bg-dark)',
        borderBottom: '1px solid var(--tn-border)',
        height: 36,
        flexShrink: 0,
        WebkitAppRegion: 'drag',
      } as React.CSSProperties}
    >
      <span
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: 'var(--tn-blue)',
          marginRight: 12,
          whiteSpace: 'nowrap',
        }}
      >
        CUI Workspace
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
              padding: '6px 12px',
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

      <div style={{ width: 1, height: 16, background: 'var(--tn-border)', marginRight: 4, opacity: 0.4 }} />

      {projects.map((p, idx) => (
        <div
          key={p.id}
          style={{
            display: 'flex',
            alignItems: 'center',
            background: p.id === activeId ? 'var(--tn-surface)' : 'transparent',
            borderBottom: p.id === activeId ? '2px solid var(--tn-blue)' : '2px solid transparent',
            borderRadius: '4px 4px 0 0',
            transition: 'all 0.15s',
          }}
        >
          <button
            onClick={() => onSelect(p.id)}
            onDoubleClick={(e) => { e.preventDefault(); onEdit(p.id); }}
            title={`${p.name} — ${p.workDir}\nDoppelklick zum Bearbeiten${idx < 9 ? `\nCmd+${idx + 1}` : ''}`}
            style={{
              background: 'none',
              color: p.id === activeId ? 'var(--tn-text)' : 'var(--tn-text-muted)',
              border: 'none',
              padding: '6px 10px 6px 14px',
              fontSize: 12,
              cursor: 'pointer',
              WebkitAppRegion: 'no-drag',
            } as React.CSSProperties}
          >
            {attention?.has(p.id) && p.id !== activeId && (
              <span style={{
                width: 6, height: 6, borderRadius: '50%',
                background: '#e0af68',
                display: 'inline-block', marginRight: 5, flexShrink: 0,
              }} />
            )}
            {idx < 9 && (
              <span style={{ fontSize: 9, opacity: 0.4, marginRight: 4, fontFamily: 'monospace' }}>
                {idx + 1}
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
                padding: '4px 6px 4px 0',
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
      ))}

      <button
        onClick={onNew}
        title="Neues Projekt (Cmd+N)"
        style={{
          background: 'none',
          border: '1px dashed var(--tn-border)',
          color: 'var(--tn-text-muted)',
          padding: '4px 10px',
          fontSize: 11,
          cursor: 'pointer',
          borderRadius: 4,
          marginLeft: 4,
          WebkitAppRegion: 'no-drag',
        } as React.CSSProperties}
      >
        + Projekt
      </button>

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Syncthing toggle */}
      <SyncthingToggle />

      {/* All Live toggle - switches all visible chats to 2s polling */}
      <button
        onClick={() => {
          const newState = !allLive;
          setAllLive(newState);
          window.dispatchEvent(new CustomEvent('cui-all-live', { detail: { live: newState } }));
        }}
        title={allLive ? 'Live-Modus fuer alle Chats aus (zurueck zu 15s)' : 'Live-Modus fuer alle Chats an (2s Polling)'}
        style={{
          background: allLive ? 'rgba(239,68,68,0.15)' : 'none',
          border: `1px solid ${allLive ? '#EF4444' : 'var(--tn-border)'}`,
          color: allLive ? '#EF4444' : 'var(--tn-text-muted)',
          padding: '3px 10px',
          fontSize: 10,
          fontWeight: allLive ? 700 : 400,
          cursor: 'pointer',
          borderRadius: 4,
          WebkitAppRegion: 'no-drag',
          whiteSpace: 'nowrap',
          transition: 'all 0.2s',
          marginRight: 6,
        } as React.CSSProperties}
      >
        {allLive ? '● Live' : '○ Live'}
      </button>

      {/* Panel Health Indicator + Start Button */}
      {panelHealth && panelHealth.missing.length > 0 && (
        <>
          <button
            onClick={handleStartPanels}
            disabled={syncState === 'syncing'}
            title={`${panelHealth.missing.length} panel(s) offline:\n${panelHealth.missing.join('\n')}\n\nClick to start all missing panels`}
            style={{
              background: 'rgba(239,68,68,0.15)',
              border: '1px solid #EF4444',
              color: '#EF4444',
              padding: '3px 10px',
              fontSize: 10,
              fontWeight: 600,
              cursor: syncState === 'syncing' ? 'wait' : 'pointer',
              borderRadius: 4,
              WebkitAppRegion: 'no-drag',
              whiteSpace: 'nowrap',
              transition: 'all 0.2s',
              marginRight: 6,
            } as React.CSSProperties}
          >
            ▶ Start {panelHealth.missing.length} Panel{panelHealth.missing.length > 1 ? 's' : ''}
          </button>
          <div
            style={{
              fontSize: 10,
              color: 'var(--tn-text-muted)',
              marginRight: 6,
              opacity: 0.6
            }}
          >
            ({panelHealth.running}/{panelHealth.total} online)
          </div>
        </>
      )}

      {/* Rebuild button - triggers frontend rebuild only */}
      <button
        onClick={handleRebuild}
        disabled={syncState === 'syncing'}
        title="Rebuild CUI frontend (npm run build + restart server)\n\nNote: This only rebuilds CUI, not panel backends"
        style={{
          background: 'none',
          border: '1px solid var(--tn-border)',
          color: 'var(--tn-text-muted)',
          padding: '3px 10px',
          fontSize: 10,
          fontWeight: 600,
          cursor: syncState === 'syncing' ? 'wait' : 'pointer',
          borderRadius: 4,
          WebkitAppRegion: 'no-drag',
          whiteSpace: 'nowrap',
          transition: 'all 0.2s',
          marginRight: 6,
        } as React.CSSProperties}
      >
        🔨 Rebuild
      </button>

      {/* Nuclear cache refresh - clears all browser caches and reloads everything */}
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
          padding: '3px 10px',
          fontSize: 10,
          fontWeight: 600,
          cursor: 'pointer',
          borderRadius: 4,
          WebkitAppRegion: 'no-drag',
          whiteSpace: 'nowrap',
          transition: 'all 0.2s',
          marginRight: 6,
        } as React.CSSProperties}
      >
        ☢ Cache
      </button>

      {/* Sync button - shows update badge when changes detected */}
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
          padding: '3px 10px',
          fontSize: 10,
          fontWeight: 600,
          cursor: syncState === 'syncing' ? 'wait' : 'pointer',
          borderRadius: 4,
          WebkitAppRegion: 'no-drag',
          whiteSpace: 'nowrap',
          transition: 'all 0.2s',
          position: 'relative',
        } as React.CSSProperties}
      >
        {syncState === 'idle' && !hasPending && 'Sync'}
        {syncState === 'idle' && hasPending && `Update (${pendingCount})`}
        {syncState === 'syncing' && 'Syncing...'}
        {syncState === 'done' && 'Reloading...'}
        {syncState === 'error' && 'Sync Error'}
      </button>

      {/* Sync detail tooltip */}
      {syncDetail && syncState !== 'idle' && (
        <span style={{
          fontSize: 9, color: syncColors[syncState], maxWidth: 150,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {syncDetail}
        </span>
      )}
    </div>
  );
});
