import { useState, useEffect, useRef, useCallback } from 'react';

const API = '/api';

interface NotesPanelProps {
  projectId: string;
}

export default function NotesPanel({ projectId }: NotesPanelProps) {
  const [commonNotes, setCommonNotes] = useState('');
  const [projectNotes, setProjectNotes] = useState('');
  const [sharedNotes, setSharedNotes] = useState('');
  const [activeTab, setActiveTab] = useState<'common' | 'project' | 'shared'>('project');
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'idle'>('idle');
  const commonTimer = useRef<ReturnType<typeof setTimeout>>(null);
  const projectTimer = useRef<ReturnType<typeof setTimeout>>(null);

  // Robust fetch with retry (3 attempts, exponential backoff)
  const fetchWithRetry = useCallback(async (url: string, maxRetries = 3): Promise<string> => {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if ((window as any).__cuiServerAlive === false) return '';
        const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        return d.content ?? '';
      } catch (err) {
        console.warn(`[NotesPanel] ${url} attempt ${attempt}/${maxRetries} failed:`, err);
        if (attempt < maxRetries) {
          await new Promise(res => setTimeout(res, 1000 * attempt)); // 1s, 2s backoff
        }
      }
    }
    return '';
  }, []);

  // Load common + shared notes on mount AND on page visibility change (tab switch back)
  const loadGlobalNotes = useCallback(async () => {
    const [common, shared] = await Promise.all([
      fetchWithRetry(`${API}/common-notes`),
      fetchWithRetry(`${API}/shared-notes`),
    ]);
    if (common) setCommonNotes(common);
    if (shared) setSharedNotes(shared);
  }, [fetchWithRetry]);

  useEffect(() => {
    loadGlobalNotes();

    // Re-fetch when user switches back to this browser tab
    const onVisibility = () => {
      if (document.visibilityState === 'visible') loadGlobalNotes();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [loadGlobalNotes]);

  useEffect(() => {
    fetchWithRetry(`${API}/notes/${projectId}`).then(c => { if (c) setProjectNotes(c); });
  }, [projectId, fetchWithRetry]);

  const saveCommon = useCallback((text: string) => {
    if (commonTimer.current) clearTimeout(commonTimer.current);
    setSaveStatus('saving');
    commonTimer.current = setTimeout(async () => {
      if ((window as any).__cuiServerAlive === false) return;
      try {
        const res = await fetch(`${API}/common-notes`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: text }),
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) throw new Error(`[NotesPanel] save common-notes failed: HTTP ${res.status}`);
        setSaveStatus('saved');
        setTimeout(() => setSaveStatus('idle'), 1500);
      } catch (err) {
        console.warn('[NotesPanel] save common-notes error:', err);
        setSaveStatus('idle');
      }
    }, 800);
  }, []);

  const saveProject = useCallback((text: string) => {
    if (projectTimer.current) clearTimeout(projectTimer.current);
    setSaveStatus('saving');
    projectTimer.current = setTimeout(async () => {
      if ((window as any).__cuiServerAlive === false) return;
      try {
        const res = await fetch(`${API}/notes/${projectId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: text }),
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) throw new Error(`[NotesPanel] save project-notes failed: HTTP ${res.status}`);
        setSaveStatus('saved');
        setTimeout(() => setSaveStatus('idle'), 1500);
      } catch (err) {
        console.warn('[NotesPanel] save project-notes error:', err);
        setSaveStatus('idle');
      }
    }, 800);
  }, [projectId]);

  const statusColor = saveStatus === 'saving' ? 'var(--tn-orange)' : saveStatus === 'saved' ? 'var(--tn-green)' : 'var(--tn-text-muted)';
  const statusText = saveStatus === 'saving' ? 'Saving...' : saveStatus === 'saved' ? 'Saved' : '';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--tn-surface)' }}>
      {/* Tab Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 0,
        background: 'var(--tn-bg-dark)', borderBottom: '1px solid var(--tn-border)',
        height: 30, flexShrink: 0,
      }}>
        <button
          onClick={() => setActiveTab('project')}
          style={{
            flex: 1, background: activeTab === 'project' ? 'var(--tn-surface)' : 'transparent',
            color: activeTab === 'project' ? 'var(--tn-blue)' : 'var(--tn-text-muted)',
            border: 'none', borderBottom: activeTab === 'project' ? '2px solid var(--tn-blue)' : '2px solid transparent',
            padding: '4px 8px', fontSize: 11, cursor: 'pointer',
          }}
        >
          Project Notes
        </button>
        <button
          onClick={() => setActiveTab('common')}
          style={{
            flex: 1, background: activeTab === 'common' ? 'var(--tn-surface)' : 'transparent',
            color: activeTab === 'common' ? 'var(--tn-purple)' : 'var(--tn-text-muted)',
            border: 'none', borderBottom: activeTab === 'common' ? '2px solid var(--tn-purple)' : '2px solid transparent',
            padding: '4px 8px', fontSize: 11, cursor: 'pointer',
          }}
        >
          Common Notes
        </button>
        <button
          onClick={() => setActiveTab('shared')}
          style={{
            flex: 1, background: activeTab === 'shared' ? 'var(--tn-surface)' : 'transparent',
            color: activeTab === 'shared' ? 'var(--tn-cyan)' : 'var(--tn-text-muted)',
            border: 'none', borderBottom: activeTab === 'shared' ? '2px solid var(--tn-cyan)' : '2px solid transparent',
            padding: '4px 8px', fontSize: 11, cursor: 'pointer',
          }}
        >
          Shared
        </button>
        {statusText && (
          <span style={{ fontSize: 10, color: statusColor, padding: '0 8px', whiteSpace: 'nowrap' }}>
            {statusText}
          </span>
        )}
      </div>

      {/* Textarea */}
      {activeTab === 'project' ? (
        <textarea
          value={projectNotes}
          onChange={(e) => {
            setProjectNotes(e.target.value);
            saveProject(e.target.value);
          }}
          placeholder={`Notes for this project...\n\nThese are specific to the "${projectId}" workspace.`}
          spellCheck={false}
          style={{
            flex: 1, resize: 'none', padding: '10px 12px',
            background: 'var(--tn-bg)', color: 'var(--tn-text)',
            border: 'none', outline: 'none',
            fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
            fontSize: 12, lineHeight: 1.6,
          }}
        />
      ) : activeTab === 'common' ? (
        <textarea
          value={commonNotes}
          onChange={(e) => {
            setCommonNotes(e.target.value);
            saveCommon(e.target.value);
          }}
          placeholder="Common notes shared across ALL workspaces...\n\nUse this for global reminders, links, credentials, etc."
          spellCheck={false}
          style={{
            flex: 1, resize: 'none', padding: '10px 12px',
            background: 'var(--tn-bg)', color: 'var(--tn-text)',
            border: 'none', outline: 'none',
            fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
            fontSize: 12, lineHeight: 1.6,
          }}
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
          <div style={{ padding: '4px 12px', borderBottom: '1px solid var(--tn-border)', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <span style={{ fontSize: 10, color: 'var(--tn-text-muted)', flex: 1 }}>
              {sharedNotes ? 'Credentials aus CLAUDE.md / Scenarios' : 'Noch nicht generiert'}
            </span>
            <button
              onClick={async () => {
                if ((window as any).__cuiServerAlive === false) return;
                setSaveStatus('saving');
                try {
                  const refreshRes = await fetch(`${API}/shared-notes/refresh`, { method: 'POST', signal: AbortSignal.timeout(15000) });
                  if (!refreshRes.ok) throw new Error(`[NotesPanel] refresh failed: HTTP ${refreshRes.status}`);
                  await refreshRes.json();
                  const loadRes = await fetch(`${API}/shared-notes`, { signal: AbortSignal.timeout(20000) });
                  if (!loadRes.ok) throw new Error(`[NotesPanel] reload shared-notes failed: HTTP ${loadRes.status}`);
                  const d = await loadRes.json();
                  setSharedNotes(d.content ?? '');
                  setSaveStatus('saved');
                  setTimeout(() => setSaveStatus('idle'), 2000);
                } catch (err) {
                  console.warn('[NotesPanel] refresh shared-notes error:', err);
                  setSaveStatus('idle');
                }
              }}
              style={{
                padding: '2px 8px', fontSize: 9, borderRadius: 3, cursor: 'pointer',
                background: 'rgba(16,185,129,0.15)', border: '1px solid rgba(16,185,129,0.3)',
                color: '#10B981', fontWeight: 600,
              }}
            >
              Refresh
            </button>
          </div>
          <textarea
            value={sharedNotes}
            readOnly
            placeholder="Keine Credentials geladen.\n\nKlicke 'Refresh' um Zugangsdaten aus CLAUDE.md Dateien zu laden."
            spellCheck={false}
            style={{
              flex: 1, resize: 'none', padding: '10px 12px',
              background: 'var(--tn-bg)', color: 'var(--tn-text)',
              border: 'none', outline: 'none',
              fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
              fontSize: 12, lineHeight: 1.6,
              cursor: 'default',
              userSelect: 'text',
            }}
          />
        </div>
      )}
    </div>
  );
}
