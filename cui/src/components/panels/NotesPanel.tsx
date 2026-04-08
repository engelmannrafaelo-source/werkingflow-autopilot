import { useState, useEffect, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const API = '/api';

interface NotesPanelProps {
  projectId: string;
}

/** Copy text to clipboard with fallback for non-HTTPS contexts */
function copyToClipboard(text: string): void {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
}
function fallbackCopy(text: string): void {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
}

/** Tiny copy-to-clipboard button */
function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      title={`Copy: ${text}`}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        copyToClipboard(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      style={{
        marginLeft: 4, padding: '1px 4px', fontSize: 9, lineHeight: 1,
        border: '1px solid var(--tn-border)', borderRadius: 3,
        background: copied ? 'rgba(16,185,129,0.25)' : 'rgba(255,255,255,0.05)',
        color: copied ? '#10B981' : 'var(--tn-text-muted)',
        cursor: 'pointer', verticalAlign: 'middle',
        transition: 'all 0.15s',
      }}
    >
      {copied ? '\u2713' : '\u2398'}
    </button>
  );
}

/** Markdown components for credentials rendering with copy buttons */
const credentialsMdComponents = {
  h1: ({ node, ...props }: any) => <h1 style={{ fontSize: 16, fontWeight: 700, color: 'var(--tn-text)', margin: '12px 0 8px', paddingBottom: 6, borderBottom: '1px solid var(--tn-border)' }} {...props} />,
  h2: ({ node, ...props }: any) => <h2 style={{ fontSize: 13, fontWeight: 600, color: 'var(--tn-cyan)', margin: '14px 0 6px', paddingTop: 6 }} {...props} />,
  p: ({ node, ...props }: any) => <p style={{ margin: '4px 0', fontSize: 11, color: 'var(--tn-text-subtle)', lineHeight: 1.5 }} {...props} />,
  hr: ({ node, ...props }: any) => <hr style={{ border: 'none', borderTop: '1px solid var(--tn-border)', margin: '8px 0' }} {...props} />,
  strong: ({ node, children, ...props }: any) => {
    const text = String(children);
    // [GOLDEN] badge
    if (text === '[GOLDEN]') {
      return <span style={{ background: 'rgba(250,204,21,0.2)', color: '#FBBF24', padding: '1px 5px', borderRadius: 3, fontSize: 9, fontWeight: 700, marginLeft: 4, verticalAlign: 'middle' }}>GOLDEN</span>;
    }
    // GOLDEN TEST: banner line
    if (text.startsWith('GOLDEN TEST:')) {
      return <strong style={{ fontWeight: 600, color: '#FBBF24' }} {...props}>{children}</strong>;
    }
    // Local/Staged labels
    if (text === 'Local:' || text === 'Staged:') {
      return <strong style={{ fontWeight: 600, color: 'var(--tn-text-muted)', fontSize: 10 }} {...props}>{children}</strong>;
    }
    return <strong style={{ fontWeight: 600, color: 'var(--tn-text)' }} {...props}>{children}</strong>;
  },
  // Inline code = credentials (emails in table cells, passwords in backticks) → add copy button
  code: ({ node, inline, children, ...props }: any) => {
    const text = String(children).replace(/\n$/, '');
    if (inline) {
      return (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 0 }}>
          <code style={{
            background: 'var(--tn-bg-highlight)', padding: '1px 5px', borderRadius: 3,
            fontSize: 11, fontFamily: "'JetBrains Mono', monospace", color: 'var(--tn-green)',
          }} {...props}>{children}</code>
          <CopyBtn text={text} />
        </span>
      );
    }
    return <code style={{ display: 'block', background: 'var(--tn-bg-dark)', padding: 8, borderRadius: 4, fontSize: 11, fontFamily: 'monospace', overflow: 'auto', margin: '4px 0', border: '1px solid var(--tn-border)' }} {...props}>{children}</code>;
  },
  table: ({ node, ...props }: any) => (
    <div style={{ overflowX: 'auto', margin: '4px 0' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }} {...props} />
    </div>
  ),
  thead: ({ node, ...props }: any) => <thead style={{ background: 'var(--tn-bg-highlight)' }} {...props} />,
  th: ({ node, ...props }: any) => <th style={{ padding: '5px 8px', textAlign: 'left', fontWeight: 600, fontSize: 10, color: 'var(--tn-text-muted)', borderBottom: '1px solid var(--tn-border)', whiteSpace: 'nowrap' }} {...props} />,
  td: ({ node, children, ...props }: any) => {
    // Extract plain text from children (may be string or React elements)
    const extractText = (c: any): string => {
      if (typeof c === 'string') return c;
      if (Array.isArray(c)) return c.map(extractText).join('');
      if (c?.props?.children) return extractText(c.props.children);
      return '';
    };
    const plainText = extractText(children).trim();
    // Email cells: add copy button
    const isEmail = plainText.includes('@') && !plainText.includes(' ') && plainText.length > 3;
    if (isEmail) {
      return (
        <td style={{ padding: '4px 8px', borderBottom: '1px solid var(--tn-border)', whiteSpace: 'nowrap' }} {...props}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 0 }}>
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11 }}>{plainText}</span>
            <CopyBtn text={plainText} />
          </span>
        </td>
      );
    }
    return <td style={{ padding: '4px 8px', borderBottom: '1px solid var(--tn-border)', fontSize: 11, lineHeight: 1.4 }} {...props}>{children}</td>;
  },
  ul: ({ node, ...props }: any) => <ul style={{ marginLeft: 16, marginBottom: 6, listStyleType: 'disc', fontSize: 11 }} {...props} />,
  li: ({ node, ...props }: any) => <li style={{ marginBottom: 2, color: 'var(--tn-text-subtle)' }} {...props} />,
  a: ({ node, ...props }: any) => <a style={{ color: 'var(--tn-blue)', textDecoration: 'none', fontSize: 11 }} target="_blank" {...props} />,
};

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
          await new Promise(res => setTimeout(res, 1000 * attempt));
        }
      }
    }
    return '';
  }, []);

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

      {/* Content */}
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
              {sharedNotes ? 'Credentials aus test-credentials.json + Golden Tests (tier 4)' : 'Noch nicht generiert'}
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
          {sharedNotes ? (
            <div style={{
              flex: 1, overflowY: 'auto', padding: '8px 12px',
              background: 'var(--tn-bg)', color: 'var(--tn-text)',
              fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
            }}>
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={credentialsMdComponents}
              >
                {sharedNotes}
              </ReactMarkdown>
            </div>
          ) : (
            <div style={{
              flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'var(--tn-text-muted)', fontSize: 12,
            }}>
              Keine Credentials geladen. Klicke &apos;Refresh&apos;.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
