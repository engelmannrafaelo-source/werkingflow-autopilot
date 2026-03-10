import { useState, useCallback, useEffect, useRef, lazy, Suspense } from 'react';
import ProjectTabs from './components/ProjectTabs';
import LayoutManager from './components/LayoutManager';
const MissionControl = lazy(() => import('./components/panels/MissionControl'));
const SyncPanel = lazy(() => import('./components/panels/SyncPanel').then(m => ({ default: m.SyncPanel })));
const MobileLayout = lazy(() => import('./components/MobileLayout'));
import AllChatsView from './components/AllChatsView';
import type { Project } from './types';
import { useSessionStore } from './contexts/SessionStore';

const API = '/api';
const IS_LOCAL = new URLSearchParams(window.location.search).get('mode') === 'local';
const IS_TOUCH_DEVICE = typeof window !== "undefined" && "ontouchstart" in window && window.innerWidth < 1200;
const IS_MOBILE = new URLSearchParams(window.location.search).has("mobile") || new URLSearchParams(window.location.search).get("mode") === "mobile";

// Auto-redirect touch devices to mobile mode (unless explicitly opted out with ?desktop)
if (IS_TOUCH_DEVICE && !IS_MOBILE && !new URLSearchParams(window.location.search).has("desktop")) {
  const url = new URL(window.location.href);
  url.searchParams.set("mobile", "");
  window.location.replace(url.toString());
}

const DEFAULT_PROJECTS: Project[] = [];

async function fetchProjects(): Promise<Project[]> {
  const res = await fetch(`${API}/projects`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error('Failed to load projects');
  const projects = await res.json();
  return projects.length > 0 ? projects : DEFAULT_PROJECTS;
}

async function saveProject(project: Project): Promise<void> {
  if ((window as any).__cuiServerAlive === false) return;
  try {
    await fetch(`${API}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(project),
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    console.warn('[App] saveProject failed:', err);
  }
}

async function deleteProject(id: string): Promise<void> {
  if ((window as any).__cuiServerAlive === false) return;
  try {
    await fetch(`${API}/projects/${id}`, { method: 'DELETE', signal: AbortSignal.timeout(20000) });
  } catch (err) {
    console.warn('[App] deleteProject failed:', err);
  }
}

// --- Project Dialog (create + edit) ---
interface ProjectDialogProps {
  mode: 'create' | 'edit';
  initialName?: string;
  initialWorkDir?: string;
  onSubmit: (name: string, workDir: string) => void;
  onClose: () => void;
}

function ProjectDialog({ mode, initialName = '', initialWorkDir = '', onSubmit, onClose }: ProjectDialogProps) {
  const [name, setName] = useState(initialName);
  const [workDir, setWorkDir] = useState(initialWorkDir);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => { nameRef.current?.focus(); nameRef.current?.select(); }, []);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    // Local mode: user provides workDir; Remote: server auto-creates workspace
    onSubmit(name.trim(), (mode === 'edit' || IS_LOCAL) ? workDir.trim() : '');
  }

  const isEdit = mode === 'edit';
  const title = isEdit ? 'Projekt bearbeiten' : 'Neues Projekt';
  const submitLabel = isEdit ? 'Speichern' : 'Erstellen';

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 2000,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--tn-surface)', border: '1px solid var(--tn-border)',
          borderRadius: 8, padding: 20, width: 380,
          boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--tn-text)', marginBottom: 16 }}>
          {title}
        </div>

        <label style={{ fontSize: 11, color: 'var(--tn-text-muted)', display: 'block', marginBottom: 4 }}>
          Projektname
        </label>
        <input
          ref={nameRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="z.B. RLB Campus"
          style={{
            width: '100%', padding: '6px 10px', fontSize: 12,
            background: 'var(--tn-bg)', color: 'var(--tn-text)',
            border: '1px solid var(--tn-border)', borderRadius: 4,
            marginBottom: 12, boxSizing: 'border-box',
          }}
        />

        {(isEdit || IS_LOCAL) && (
          <>
            <label style={{ fontSize: 11, color: 'var(--tn-text-muted)', display: 'block', marginBottom: 4 }}>
              Arbeitsverzeichnis (absoluter Pfad)
            </label>
            <input
              value={workDir}
              onChange={(e) => setWorkDir(e.target.value)}
              placeholder={IS_LOCAL ? '/Users/rafael/Documents/...' : '/root/projekte/...'}
              style={{
                width: '100%', padding: '6px 10px', fontSize: 12,
                background: 'var(--tn-bg)', color: 'var(--tn-text)',
                border: '1px solid var(--tn-border)', borderRadius: 4,
                marginBottom: 16, boxSizing: 'border-box',
              }}
            />
          </>
        )}
        {!isEdit && !IS_LOCAL && (
          <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginBottom: 16, opacity: 0.7 }}>
            Workspace wird automatisch erstellt
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: '6px 14px', borderRadius: 5, fontSize: 12, cursor: 'pointer',
              background: 'var(--tn-bg)', border: '1px solid var(--tn-border)', color: 'var(--tn-text-muted)',
            }}
          >
            Abbrechen
          </button>
          <button
            type="submit"
            disabled={!name.trim()}
            style={{
              padding: '6px 16px', borderRadius: 5, fontSize: 12, cursor: 'pointer', fontWeight: 600,
              background: name.trim() ? 'var(--tn-blue)' : 'var(--tn-border)',
              border: 'none', color: '#fff',
              opacity: name.trim() ? 1 : 0.5,
            }}
          >
            {submitLabel}
          </button>
        </div>
      </form>
    </div>
  );
}

// --- Delete Confirm Dialog ---
function DeleteDialog({ projectName, onConfirm, onClose }: { projectName: string; onConfirm: () => void; onClose: () => void }) {
  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 2000,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: 'var(--tn-surface)', border: '1px solid var(--tn-border)',
        borderRadius: 8, padding: 20, width: 320,
        boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
      }}>
        <div style={{ fontSize: 13, color: 'var(--tn-text)', marginBottom: 16 }}>
          Projekt <strong>{projectName}</strong> wirklich loeschen?
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            onClick={onClose}
            style={{
              padding: '6px 14px', borderRadius: 5, fontSize: 12, cursor: 'pointer',
              background: 'var(--tn-bg)', border: '1px solid var(--tn-border)', color: 'var(--tn-text-muted)',
            }}
          >
            Abbrechen
          </button>
          <button
            onClick={onConfirm}
            style={{
              padding: '6px 16px', borderRadius: 5, fontSize: 12, cursor: 'pointer', fontWeight: 600,
              background: 'var(--tn-red)', border: 'none', color: '#fff',
            }}
          >
            Loeschen
          </button>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeId, _setActiveId] = useState(() => {
    try { return localStorage.getItem('cui-active-project') || ''; } catch (err) { console.warn('[App] localStorage activeId read failed:', err); return ''; }
  });
  const setActiveId = useCallback((id: string) => {
    _setActiveId(id);
    try { localStorage.setItem('cui-active-project', id); } catch (err) { console.warn('[App] localStorage setActiveId write failed:', err); }
  }, []);
  const [loaded, setLoaded] = useState(false);
  const [mounted, setMounted] = useState<Set<string>>(new Set());
  const [dialogMode, setDialogMode] = useState<'create' | 'edit' | null>(null);
  const [editTarget, setEditTarget] = useState<Project | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  // cuiStates + serverAlive from shared SessionStore (single WS)
  const { sendWs, addMessageHandler } = useSessionStore();
  const [projectAttention, setProjectAttention] = useState<Record<string, 'working' | 'needs_attention'>>({}); // projectId → state
  const [showMission, setShowMission] = useState(false);
  const [showAllChats, setShowAllChats] = useState(false);
  const [showSync, setShowSync] = useState(false);
  const [pendingActivation, setPendingActivation] = useState<Array<{ projectId: string; conversations: Array<{ sessionId: string; accountId: string }> }> | null>(null);

  // Auto-reload when bundle changes (detects Syncthing-triggered rebuilds)
  const currentBundleRef = useRef(
    document.querySelector('script[src*="/assets/index-"]')?.getAttribute('src') || ''
  );
  const checkForUpdate = useCallback(async () => {
    try {
      const resp = await fetch('/?_v=' + Date.now(), { headers: { 'Accept': 'text/html' }, signal: AbortSignal.timeout(20000) });
      if (!resp.ok) return;
      const html = await resp.text();
      const match = html.match(/src="(\/assets\/index-[^"]+)"/);
      if (match && match[1] && match[1] !== currentBundleRef.current) {
        console.log(`[AutoReload] Bundle changed: ${currentBundleRef.current} → ${match[1]}`);
        window.location.reload();
      }
    } catch (err) {
      console.warn('[App] checkForUpdate failed:', err);
    }
  }, []);

  // Control API message handler (via shared SessionStore WebSocket)
  useEffect(() => {
    return addMessageHandler((msg: any) => {
      // Control API: switch project
      if (msg.type === 'control:project-switch' && msg.projectId) {
        setActiveId(msg.projectId);
      }
      // Activation: switch to target project, hide MC, pass plan as prop
      if (msg.type === 'control:activate-conversations' && msg.plan?.length > 0) {
        const firstProjectId = msg.plan[0].projectId;
        if (firstProjectId) {
          setPendingActivation(msg.plan);
          setActiveId(firstProjectId);
          setShowMission(false);
        }
      }
      // Forward sync-related messages to ProjectTabs via window.postMessage
      if (msg.type === 'cui-update-available' || (msg.type === 'cui-sync' && msg.auto)) {
        window.postMessage(JSON.stringify(msg), '*');
        if (msg.type === 'cui-update-available') {
          setTimeout(checkForUpdate, 8000);
        }
      }
      // Snapshot request
      if (msg.type === 'control:snapshot-request' && msg.panel) {
        (async () => {
          try {
            const panelRes = await fetch(`/api/admin/wr/${msg.panel}`, { signal: AbortSignal.timeout(20000) });
            if (!panelRes.ok) throw new Error(`Panel fetch failed: ${panelRes.status}`);
            const panelData = await panelRes.json();
            await fetch(`/api/snapshot/${msg.panel}`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(panelData), signal: AbortSignal.timeout(20000),
            });
          } catch (err) { console.warn('[Snapshot] Failed:', msg.panel, err); }
        })();
      }
      // Screenshot request
      if (msg.type === 'control:screenshot-request' && msg.panel) {
        (async () => {
          try {
            const panelId: string = msg.panel;
            let target: HTMLElement | null = null;
            let matchedVia = '';
            const findTarget = (): { el: HTMLElement | null; via: string } => {
              if (panelId === 'full') return { el: document.getElementById('root'), via: 'root' };
              let el = document.querySelector<HTMLElement>(`[data-node-id="${panelId}"]`);
              if (el) return { el, via: 'data-node-id-exact' };
              const allNodes = document.querySelectorAll<HTMLElement>('[data-node-id]');
              for (const node of allNodes) {
                const nid = node.getAttribute('data-node-id') || '';
                if (nid.startsWith(panelId)) return { el: node, via: `data-node-id-partial:${nid}` };
              }
              el = document.querySelector<HTMLElement>(`[data-panel="${panelId}"]`);
              if (el) return { el, via: 'data-panel' };
              const candidates = document.querySelectorAll<HTMLElement>('.flexlayout__tab');
              for (const tab of candidates) {
                if (tab.querySelector(`[data-panel="${panelId}"]`)) return { el: tab, via: 'flexlayout-tab-child' };
              }
              return { el: null, via: '' };
            };
            let found = findTarget();
            target = found.el;
            matchedVia = found.via;
            const isHidden = target && (target.getBoundingClientRect().width === 0 || target.getBoundingClientRect().height === 0);
            if (!target || isHidden) {
              sendWs({ type: 'control:ensure-panel', component: panelId });
              sendWs({ type: 'control:select-tab', target: panelId });
              await new Promise(r => setTimeout(r, 1500));
              found = findTarget();
              target = found.el;
              matchedVia = found.via ? `auto-activated:${found.via}` : '';
            }
            if (!target) {
              const existingIds = Array.from(document.querySelectorAll<HTMLElement>('[data-node-id]'))
                .map(el => el.getAttribute('data-node-id'));
              throw new Error(`Panel "${panelId}" not found. Available: [${existingIds.join(', ')}]`);
            }
            const rect = target.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) {
              throw new Error(`Panel "${panelId}" hidden (${rect.width}x${rect.height})`);
            }
            const contentWait = msg.contentWait ?? 2000;
            if (contentWait > 0) await new Promise(r => setTimeout(r, contentWait));
            const html2canvas = (await import('html2canvas')).default;
            const canvas = await html2canvas(target, {
              backgroundColor: '#1a1b26', scale: 1, useCORS: true, logging: false, allowTaint: true,
            });
            const dataUrl = canvas.toDataURL('image/png');
            await fetch(`/api/screenshot/${panelId}`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ dataUrl, width: canvas.width, height: canvas.height }),
              signal: AbortSignal.timeout(20000),
            });
            console.log(`[Screenshot] Captured ${panelId} via ${matchedVia} (${canvas.width}x${canvas.height})`);
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error('[Screenshot] Failed:', msg.panel, errMsg);
            fetch(`/api/screenshot/${msg.panel}/error`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ error: errMsg }), signal: AbortSignal.timeout(20000),
            }).catch(() => {});
          }
        })();
      }
      // DOM introspection
      if (msg.type === 'control:list-panels') {
        const panels = Array.from(document.querySelectorAll<HTMLElement>('[data-node-id]')).map(el => {
          const rect = el.getBoundingClientRect();
          return { nodeId: el.getAttribute('data-node-id'), visible: rect.width > 0 && rect.height > 0, size: `${Math.round(rect.width)}x${Math.round(rect.height)}` };
        });
        fetch('/api/screenshot/panels', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ panels, timestamp: new Date().toISOString() }),
          signal: AbortSignal.timeout(20000),
        }).catch(() => {});
      }
      // CPU Profile
      if (msg.type === 'control:cpu-profile' && window.electronAPI?.cpuProfile) {
        (async () => {
          try {
            const result = await window.electronAPI!.cpuProfile();
            sendWs({ type: 'cpu-profile-result', data: result });
          } catch (err) {
            sendWs({ type: 'cpu-profile-result', data: { error: String(err) } });
          }
        })();
      }
    });
  }, [addMessageHandler, sendWs, checkForUpdate]);

  const handleAttentionChange = useCallback((projectId: string, needsAttention: boolean, state?: 'working' | 'needs_attention') => {
    setProjectAttention(prev => {
      if (needsAttention && state) {
        if (prev[projectId] === state) return prev;
        return { ...prev, [projectId]: state };
      }
      if (!needsAttention) {
        if (!(projectId in prev)) return prev;
        const next = { ...prev };
        delete next[projectId];
        return next;
      }
      return prev;
    });
  }, []);

  // cuiState reset not needed — SessionStore tracks from WS events

  const handleActivationProcessed = useCallback((processedProjectId?: string) => {
    if (!processedProjectId) {
      setPendingActivation(null);
      return;
    }
    setPendingActivation(prev => {
      if (!prev) return null;
      const remaining = prev.filter(p => p.projectId !== processedProjectId);
      return remaining.length > 0 ? remaining : null;
    });
  }, []);

  // Load projects: localStorage cache → instant, server → background update
  useEffect(() => {
    const CACHE_KEY = 'cui-projects-cache';

    // 1. Load from cache immediately (no "Loading workspace..." wait)
    try {
      const cached = localStorage.getItem(CACHE_KEY);
      if (cached) {
        const cachedProjects = JSON.parse(cached) as Project[];
        if (cachedProjects.length > 0) {
          setProjects(cachedProjects);
          const savedId = activeId || '';
          const validId = cachedProjects.find(p => p.id === savedId) ? savedId : (cachedProjects[0]?.id ?? '');
          if (validId !== activeId) setActiveId(validId);
          setLoaded(true);
        }
      }
    } catch (err) {
      console.warn('[App] localStorage project cache read failed:', err);
    }

    // 2. Fetch from server in background (updates cache)
    fetchProjects().then((serverProjects) => {
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(serverProjects)); } catch (err) { console.warn('[App] localStorage project cache write failed:', err); }
      setProjects(serverProjects);
      const savedId = activeId || '';
      const validId = serverProjects.find(p => p.id === savedId) ? savedId : (serverProjects[0]?.id ?? '');
      if (validId !== activeId) setActiveId(validId);
      setLoaded(true);
      for (const p of serverProjects) saveProject(p);
    }).catch((err) => {
      console.warn('[App] fetchProjects failed, using fallback:', err);
      // Server down — if cache was empty, use defaults
      setLoaded(prev => {
        if (prev) return prev; // Already loaded from cache
        setProjects(DEFAULT_PROJECTS);
        if (!activeId && DEFAULT_PROJECTS.length > 0) setActiveId(DEFAULT_PROJECTS[0].id);
        return true;
      });
    });
  }, []);

  // Report active project to server (for Control API state queries)
  useEffect(() => {
    if (activeId) {
      sendWs({ type: 'state-report', activeProjectId: activeId });
    }
  }, [activeId]);

  // Lazy-mount: only render LayoutManagers for projects that have been opened
  useEffect(() => {
    if (activeId) {
      setMounted(prev => {
        if (prev.has(activeId)) return prev;
        return new Set(prev).add(activeId);
      });
    }
  }, [activeId]);

  // Keyboard shortcuts: Cmd+1-9 switch projects, Cmd+N new project
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (!e.metaKey && !e.ctrlKey) return;

      // Cmd+N: new project
      if (e.key === 'n' && !e.shiftKey) {
        e.preventDefault();
        setDialogMode('create');
        setEditTarget(null);
        return;
      }

      // Cmd+0: toggle Mission Control
      if (e.key === '0') {
        e.preventDefault();
        setShowMission(prev => { if (!prev) { setShowAllChats(false); setShowSync(false); } return !prev; });
        return;
      }

      // Cmd+`: toggle All Chats
      if (e.key === '`') {
        e.preventDefault();
        setShowAllChats(prev => { if (!prev) { setShowMission(false); setShowSync(false); } return !prev; });
        return;
      }

      // Cmd+1-9: switch to project by index
      const num = parseInt(e.key);
      if (num >= 1 && num <= 9 && projects.length > 0) {
        const idx = num - 1;
        if (idx < projects.length) {
          e.preventDefault();
          setActiveId(projects[idx].id);
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [projects]);

  const handleSelect = useCallback((id: string) => {
    setActiveId(id);
  }, []);

  const handleNew = useCallback(() => {
    setDialogMode('create');
    setEditTarget(null);
  }, []);

  const handleEdit = useCallback((id: string) => {
    const project = projects.find(p => p.id === id);
    if (!project) return;
    setEditTarget(project);
    setDialogMode('edit');
  }, [projects]);

  const handleDialogSubmit = useCallback(async (name: string, workDir: string) => {
    try {
      if (dialogMode === 'create') {
        const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const newProject: Project = { id, name, workDir, lastOpened: new Date().toISOString() };
        setProjects(prev => [...prev, newProject]);
        setActiveId(id);
        // Save to server (auto-generates workDir for remote workspace), then re-fetch to get it
        await saveProject(newProject);
        const updated = await fetchProjects();
        setProjects(updated);
      } else if (dialogMode === 'edit' && editTarget) {
        const updated: Project = { ...editTarget, name, workDir, lastOpened: new Date().toISOString() };
        setProjects(prev => prev.map(p => p.id === editTarget.id ? updated : p));
        saveProject(updated);
      }
    } catch (err) {
      console.warn('[App] handleDialogSubmit failed:', err);
    }
    setDialogMode(null);
    setEditTarget(null);
  }, [dialogMode, editTarget]);

  const handleDelete = useCallback((id: string) => {
    setDeleteTarget(id);
  }, []);

  const handleDeleteConfirm = useCallback(() => {
    if (!deleteTarget) return;
    setProjects(prev => {
      const updated = prev.filter(p => p.id !== deleteTarget);
      if (deleteTarget === activeId && updated.length > 0) {
        setActiveId(updated[0].id);
      }
      return updated;
    });
    deleteProject(deleteTarget);
    setDeleteTarget(null);
  }, [deleteTarget, activeId]);

  if (!loaded) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: 'var(--tn-text-muted)' }}>
        Loading workspace...
      </div>
    );
  }

  const deleteProjectName = deleteTarget ? projects.find(p => p.id === deleteTarget)?.name ?? deleteTarget : '';

  return (
    <div className={IS_MOBILE ? 'mobile-mode' : ''} style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <ProjectTabs
        projects={projects}
        activeId={activeId}
        attention={projectAttention}
        onSelect={(id) => { setShowMission(false); setShowAllChats(false); setShowSync(false); handleSelect(id); }}
        onNew={handleNew}
        onEdit={handleEdit}
        onDelete={handleDelete}
        missionActive={showMission}
        onMissionClick={() => setShowMission(prev => { if (!prev) { setShowAllChats(false); setShowSync(false); } return !prev; })}
        allChatsActive={showAllChats}
        onAllChatsClick={() => setShowAllChats(prev => { if (!prev) { setShowMission(false); setShowSync(false); } return !prev; })}
        syncPanelActive={showSync}
        onSyncPanelClick={() => setShowSync(prev => { if (!prev) { setShowMission(false); setShowAllChats(false); } return !prev; })}
        isMobile={IS_MOBILE}
      />
      <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
        {/* Mission Control - global view */}
        {!IS_MOBILE && showMission && (
          <div style={{
            position: 'absolute', inset: 0, zIndex: 2,
            display: 'flex', flexDirection: 'column',
          }}>
            <Suspense fallback={<div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--tn-text-muted)' }}>Loading Mission Control...</div>}>
              <MissionControl />
            </Suspense>
          </div>
        )}
        {/* All Chats - consolidated view of all active conversations */}
        {!IS_MOBILE && showAllChats && (
          <div style={{
            position: 'absolute', inset: 0, zIndex: 2,
            display: 'flex', flexDirection: 'column',
          }}>
            <AllChatsView
              onNavigateToProject={(projectId) => {
                setShowAllChats(false);
                setActiveId(projectId);
              }}
              isVisible={showAllChats}
            />
          </div>
        )}
        {/* Synchronise Panel */}
        {!IS_MOBILE && showSync && (
          <div style={{
            position: 'absolute', inset: 0, zIndex: 2,
            display: 'flex', flexDirection: 'column',
          }}>
            <Suspense fallback={<div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--tn-text-muted)' }}>Loading Sync Panel...</div>}>
              <SyncPanel onClose={() => setShowSync(false)} />
            </Suspense>
          </div>
        )}
        {projects.filter(p => mounted.has(p.id)).map((p) => (
          <div
            key={p.id}
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: p.id === activeId ? 1 : -1,
              display: p.id === activeId ? 'flex' : 'none',
              flexDirection: 'column',
            }}
          >
            {IS_MOBILE ? (
              <Suspense fallback={<div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--tn-text-muted)' }}>Loading Mobile...</div>}>
                <MobileLayout
                  projectId={p.id}
                  workDir={p.workDir}
                />
              </Suspense>
            ) : (
              <LayoutManager
                projectId={p.id}
                workDir={p.workDir}
                onAttentionChange={(needs, state) => handleAttentionChange(p.id, needs, state)}
                pendingActivation={pendingActivation}
                onActivationProcessed={handleActivationProcessed}
              />
            )}
          </div>
        ))}
      </div>

      {dialogMode && (
        <ProjectDialog
          mode={dialogMode}
          initialName={editTarget?.name}
          initialWorkDir={editTarget?.workDir}
          onSubmit={handleDialogSubmit}
          onClose={() => { setDialogMode(null); setEditTarget(null); }}
        />
      )}

      {deleteTarget && (
        <DeleteDialog
          projectName={deleteProjectName}
          onConfirm={handleDeleteConfirm}
          onClose={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}
