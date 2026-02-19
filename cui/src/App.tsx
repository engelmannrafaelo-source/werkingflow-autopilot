import { useState, useCallback, useEffect, useRef } from 'react';
import ProjectTabs from './components/ProjectTabs';
import LayoutManager from './components/LayoutManager';
import MissionControl from './components/panels/MissionControl';
import type { Project, CuiStates } from './types';

const API = '/api';

const DEFAULT_PROJECTS: Project[] = [
  {
    id: 'rlb-campus',
    name: 'RLB Campus',
    workDir: '/Users/rafael/Desktop/5B-FLAG/B-0070_RLB_nachfolgeprojekt',
    lastOpened: new Date().toISOString(),
  },
  {
    id: 'general',
    name: 'General',
    workDir: '~',
    lastOpened: new Date().toISOString(),
  },
];

async function fetchProjects(): Promise<Project[]> {
  const res = await fetch(`${API}/projects`);
  if (!res.ok) throw new Error('Failed to load projects');
  const projects = await res.json();
  return projects.length > 0 ? projects : DEFAULT_PROJECTS;
}

async function saveProject(project: Project): Promise<void> {
  await fetch(`${API}/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(project),
  });
}

async function deleteProject(id: string): Promise<void> {
  await fetch(`${API}/projects/${id}`, { method: 'DELETE' });
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
    // For new projects: server auto-creates /root/orchestrator/workspaces/{id}
    onSubmit(name.trim(), mode === 'edit' ? workDir.trim() : '');
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

        {isEdit && (
          <>
            <label style={{ fontSize: 11, color: 'var(--tn-text-muted)', display: 'block', marginBottom: 4 }}>
              Arbeitsverzeichnis (absoluter Pfad)
            </label>
            <input
              value={workDir}
              onChange={(e) => setWorkDir(e.target.value)}
              placeholder="/Users/..."
              style={{
                width: '100%', padding: '6px 10px', fontSize: 12,
                background: 'var(--tn-bg)', color: 'var(--tn-text)',
                border: '1px solid var(--tn-border)', borderRadius: 4,
                marginBottom: 16, boxSizing: 'border-box',
              }}
            />
          </>
        )}
        {!isEdit && (
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
    try { return localStorage.getItem('cui-active-project') || ''; } catch { return ''; }
  });
  const setActiveId = useCallback((id: string) => {
    _setActiveId(id);
    try { localStorage.setItem('cui-active-project', id); } catch {}
  }, []);
  const [loaded, setLoaded] = useState(false);
  const [mounted, setMounted] = useState<Set<string>>(new Set());
  const [dialogMode, setDialogMode] = useState<'create' | 'edit' | null>(null);
  const [editTarget, setEditTarget] = useState<Project | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [cuiStates, setCuiStates] = useState<CuiStates>({});
  const [projectAttention, setProjectAttention] = useState<Set<string>>(new Set());
  const [showMission, setShowMission] = useState(false);

  // Global WebSocket for CUI state tracking + Control API
  const wsRef = useRef<WebSocket | null>(null);
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${protocol}://${window.location.host}/ws`);
    wsRef.current = ws;
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'cui-state' && msg.cuiId && msg.state) {
          setCuiStates(prev => ({ ...prev, [msg.cuiId]: msg.state }));
        }
        // Control API: switch project
        if (msg.type === 'control:project-switch' && msg.projectId) {
          setActiveId(msg.projectId);
        }
        // Forward sync-related messages to ProjectTabs via window.postMessage
        if (msg.type === 'cui-update-available' || (msg.type === 'cui-sync' && msg.auto)) {
          window.postMessage(e.data, '*');
        }
        // Snapshot request: fetch panel data and POST back to server
        if (msg.type === 'control:snapshot-request' && msg.panel) {
          (async () => {
            try {
              const panelRes = await fetch(`/api/admin/wr/${msg.panel}`);
              const panelData = await panelRes.json();
              await fetch(`/api/snapshot/${msg.panel}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(panelData),
              });
            } catch (err) {
              console.warn('[Snapshot] Failed to capture panel:', msg.panel, err);
            }
          })();
        }
      } catch { /* ignore */ }
    };
    return () => ws.close();
  }, []);

  const handleAttentionChange = useCallback((projectId: string, needsAttention: boolean) => {
    setProjectAttention(prev => {
      const next = new Set(prev);
      if (needsAttention) next.add(projectId);
      else next.delete(projectId);
      return next;
    });
  }, []);

  const handleCuiStateReset = useCallback((cuiId: string) => {
    setCuiStates(prev => ({ ...prev, [cuiId]: 'idle' }));
  }, []);

  // Load projects from server on mount
  useEffect(() => {
    fetchProjects().then((loadedProjects) => {
      setProjects(loadedProjects);
      // Restore last active project from localStorage, fall back to first
      const savedId = activeId || '';
      const validId = loadedProjects.find(p => p.id === savedId) ? savedId : (loadedProjects[0]?.id ?? '');
      if (validId !== activeId) setActiveId(validId);
      setLoaded(true);
      for (const p of loadedProjects) saveProject(p);
    });
  }, []);

  // Report active project to server (for Control API state queries)
  useEffect(() => {
    if (activeId && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'state-report', activeProjectId: activeId }));
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
        setShowMission(prev => !prev);
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
    <>
      <ProjectTabs
        projects={projects}
        activeId={activeId}
        attention={projectAttention}
        onSelect={(id) => { setShowMission(false); handleSelect(id); }}
        onNew={handleNew}
        onEdit={handleEdit}
        onDelete={handleDelete}
        missionActive={showMission}
        onMissionClick={() => setShowMission(prev => !prev)}
      />
      <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
        {/* Mission Control - global view */}
        {showMission && (
          <div style={{
            position: 'absolute', inset: 0, zIndex: 2,
            display: 'flex', flexDirection: 'column',
          }}>
            <MissionControl />
          </div>
        )}
        {projects.filter(p => p.id === activeId).map((p) => (
          <div
            key={p.id}
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: 1,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <LayoutManager
              projectId={p.id}
              workDir={p.workDir}
              cuiStates={cuiStates}
              onAttentionChange={(needs) => handleAttentionChange(p.id, needs)}
              onCuiStateReset={handleCuiStateReset}
            />
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
    </>
  );
}
