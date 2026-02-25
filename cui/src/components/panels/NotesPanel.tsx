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

  // Load notes on mount / project change
  useEffect(() => {
    fetch(`${API}/common-notes`).then((r) => r.json()).then((d) => setCommonNotes(d.content ?? ''));
    fetch(`${API}/shared-notes`).then((r) => r.json()).then((d) => setSharedNotes(d.content ?? ''));
  }, []);

  useEffect(() => {
    fetch(`${API}/notes/${projectId}`).then((r) => r.json()).then((d) => setProjectNotes(d.content ?? ''));
  }, [projectId]);

  const saveCommon = useCallback((text: string) => {
    if (commonTimer.current) clearTimeout(commonTimer.current);
    setSaveStatus('saving');
    commonTimer.current = setTimeout(() => {
      fetch(`${API}/common-notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text }),
      }).then(() => {
        setSaveStatus('saved');
        setTimeout(() => setSaveStatus('idle'), 1500);
      });
    }, 800);
  }, []);

  const saveProject = useCallback((text: string) => {
    if (projectTimer.current) clearTimeout(projectTimer.current);
    setSaveStatus('saving');
    projectTimer.current = setTimeout(() => {
      fetch(`${API}/notes/${projectId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text }),
      }).then(() => {
        setSaveStatus('saved');
        setTimeout(() => setSaveStatus('idle'), 1500);
      });
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
          🔐 Shared
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
              onClick={() => {
                setSaveStatus('saving');
                fetch(`${API}/shared-notes/refresh`, { method: 'POST' })
                  .then(r => r.json())
                  .then(() => {
                    fetch(`${API}/shared-notes`).then(r => r.json()).then(d => setSharedNotes(d.content ?? ''));
                    setSaveStatus('saved');
                    setTimeout(() => setSaveStatus('idle'), 2000);
                  })
                  .catch(() => setSaveStatus('idle'));
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
