import { useState, useEffect, useCallback, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import mermaid from 'mermaid';
import { resilientFetch } from '../../utils/resilientFetch';
import { getPathConfig, buildQuickDirs, loadPathConfig } from '../../utils/paths';
import { validateApiResponse } from '../../lib/validateApiResponse';

// Initialize mermaid once with dark theme
mermaid.initialize({
  startOnLoad: false,
  theme: 'dark',
  themeVariables: {
    primaryColor: '#1e293b',
    primaryTextColor: '#c0caf5',
    primaryBorderColor: '#334155',
    lineColor: '#7aa2f7',
    secondaryColor: '#0f172a',
    tertiaryColor: '#1a1b26',
    fontSize: '14px',
  },
  securityLevel: 'loose',
});

/** Renders Mermaid source to SVG with source/rendered toggle */
function MermaidRenderer({ source }: { source: string }) {
  const [view, setView] = useState<'rendered' | 'source'>('rendered');
  const [svgHtml, setSvgHtml] = useState<string>('');
  const [renderError, setRenderError] = useState<string>('');
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    async function render() {
      try {
        const id = `mermaid-${Date.now()}`;
        const { svg } = await mermaid.render(id, source);
        if (!cancelled) {
          setSvgHtml(svg);
          setRenderError('');
        }
      } catch (err: any) {
        if (!cancelled) {
          setRenderError(err.message || 'Mermaid render error');
          setSvgHtml('');
        }
      }
    }
    render();
    return () => { cancelled = true; };
  }, [source]);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Toggle Bar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 4,
        padding: '4px 12px', borderBottom: '1px solid var(--tn-border)',
        background: 'var(--tn-bg)', flexShrink: 0,
      }}>
        <button
          onClick={() => setView('rendered')}
          style={{
            padding: '2px 8px', fontSize: 10, borderRadius: 3, cursor: 'pointer',
            background: view === 'rendered' ? 'var(--tn-bg-highlight)' : 'transparent',
            border: view === 'rendered' ? '1px solid var(--tn-border)' : '1px solid transparent',
            color: view === 'rendered' ? 'var(--tn-blue)' : 'var(--tn-text-muted)',
            fontWeight: view === 'rendered' ? 600 : 400,
          }}
        >
          Rendered
        </button>
        <button
          onClick={() => setView('source')}
          style={{
            padding: '2px 8px', fontSize: 10, borderRadius: 3, cursor: 'pointer',
            background: view === 'source' ? 'var(--tn-bg-highlight)' : 'transparent',
            border: view === 'source' ? '1px solid var(--tn-border)' : '1px solid transparent',
            color: view === 'source' ? 'var(--tn-blue)' : 'var(--tn-text-muted)',
            fontWeight: view === 'source' ? 600 : 400,
          }}
        >
          Source
        </button>
        {renderError && (
          <span style={{ marginLeft: 8, fontSize: 10, color: 'var(--tn-red)' }}>
            Syntax Error
          </span>
        )}
      </div>

      {/* Content */}
      {view === 'source' || (renderError && view === 'rendered') ? (
        <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
          {renderError && view === 'rendered' && (
            <div style={{
              padding: '8px 12px', fontSize: 11, color: 'var(--tn-red)',
              background: 'rgba(255,0,0,0.05)', borderBottom: '1px solid var(--tn-border)',
            }}>
              {renderError}
            </div>
          )}
          <pre style={{
            flex: 1, overflow: 'auto', padding: 12, fontSize: 12,
            color: 'var(--tn-text-subtle)', fontFamily: "'JetBrains Mono', monospace",
            whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0,
          }}>
            {source}
          </pre>
        </div>
      ) : (
        <div
          ref={containerRef}
          style={{
            flex: 1, overflow: 'auto', padding: 20,
            display: 'flex', justifyContent: 'center', alignItems: 'flex-start',
          }}
          dangerouslySetInnerHTML={{ __html: svgHtml }}
        />
      )}
    </div>
  );
}

interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  ext?: string | null;
}

interface FileContent {
  path: string;
  content: string;
  mimeType: string;
  ext?: string;
}

interface ClaudeMapRef {
  label: string;
  path: string;
  type: string; // 'ref' | 'link' | 'doc' | 'table'
}

interface ClaudeMapItem {
  path: string;
  label: string;
  refs: ClaudeMapRef[];
}

interface ClaudeMapGroup {
  key: string;
  label: string;
  items: ClaudeMapItem[];
}

interface FilePreviewProps {
  watchPath?: string;
  stageDir?: string;
}

const API = '/api';

// Quick navigation shortcuts (loaded from server config)
const QUICK_DIRS: Array<{ label: string; path: string; color?: string }> = buildQuickDirs(getPathConfig());

export default function FilePreview({ watchPath, stageDir }: FilePreviewProps) {
  const [currentDir, setCurrentDir] = useState(watchPath ?? '');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [selectedFile, setSelectedFile] = useState<FileContent | null>(null);
  const [error, setError] = useState('');
  const [inputPath, setInputPath] = useState(watchPath ?? '');
  const [stageLoading, setStageLoading] = useState(false);
  const [stageSuccess, setStageSuccess] = useState(false);

  // Markdown render mode: 'preview' = ReactMarkdown (dark), 'html' = WerkING branded HTML (light)
  const [mdView, setMdView] = useState<'preview' | 'html'>('preview');

  // Persistent font size (stored in localStorage)
  const [fontSize, setFontSize] = useState<number>(() => {
    try { return parseInt(localStorage.getItem('cui-filepreview-fontsize') || '14', 10); } catch { return 14; }
  });
  const changeFontSize = (delta: number) => {
    setFontSize(prev => {
      const next = Math.max(9, Math.min(28, prev + delta));
      try { localStorage.setItem('cui-filepreview-fontsize', String(next)); } catch {} // silent-ok: localStorage may be disabled
      return next;
    });
  };
  const [mdHtml, setMdHtml] = useState<string>('');
  const [mdHtmlLoading, setMdHtmlLoading] = useState(false);

  // CLAUDE mode state
  const [mode, setMode] = useState<'browse' | 'claude'>('browse');
  const [claudeMap, setClaudeMap] = useState<ClaudeMapGroup[]>([]);
  const [claudeTotal, setClaudeTotal] = useState(0);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [expandedRefs, setExpandedRefs] = useState<Set<string>>(new Set());
  const [claudeLoading, setClaudeLoading] = useState(false);

  const loadDir = useCallback(async (dirPath: string) => {
    if ((window as any).__cuiServerAlive === false) return;
    try {
      const res = await resilientFetch(`${API}/files?path=${encodeURIComponent(dirPath)}`);
      if (!res.ok) throw new Error(await res.text());
      const raw = await res.json();
      const data = validateApiResponse<{ entries: FileEntry[]; path: string }>(raw, '/api/files', {
        entries: 'array',
        path: 'string',
      });
      setEntries(data.entries);
      setCurrentDir(data.path);
      setError('');
    } catch (err: any) {
      console.warn('[FilePreview] loadDir:', err);
      setError(err.message);
    }
  }, []);

  const loadFile = useCallback(async (filePath: string) => {
    if ((window as any).__cuiServerAlive === false) return;
    // Reset rendered HTML cache when loading a new file
    setMdHtml('');
    setMdView('preview');
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico'];
    const pdfExts = ['pdf'];

    if (imageExts.includes(ext)) {
      setSelectedFile({
        path: filePath,
        content: `${API}/file?path=${encodeURIComponent(filePath)}`,
        mimeType: 'image',
        ext: `.${ext}`,
      });
      return;
    }

    if (pdfExts.includes(ext)) {
      setSelectedFile({
        path: filePath,
        content: `${API}/file?path=${encodeURIComponent(filePath)}`,
        mimeType: 'application/pdf',
        ext: `.${ext}`,
      });
      return;
    }

    try {
      const res = await resilientFetch(`${API}/file?path=${encodeURIComponent(filePath)}`);
      if (!res.ok) throw new Error(await res.text());
      const raw = await res.json();
      const data = validateApiResponse<FileContent>(raw, '/api/file', {
        path: 'string',
        content: 'string',
        mimeType: 'string',
        ext: { type: 'string', optional: true },
      });
      setSelectedFile(data);
    } catch (err: any) {
      console.warn('[FilePreview] loadFile:', err);
      setError(err.message);
    }
  }, []);

  const loadClaudeMap = useCallback(async () => {
    if ((window as any).__cuiServerAlive === false) return;
    setClaudeLoading(true);
    try {
      const res = await resilientFetch(`${API}/claude-map`);
      if (!res.ok) throw new Error(await res.text());
      const raw = await res.json();
      const data = validateApiResponse<{ groups: ClaudeMapGroup[]; total: number }>(raw, '/api/claude-map', {
        groups: 'array',
        total: 'number',
      });
      setClaudeMap(data.groups);
      setClaudeTotal(data.total);
      // Expand first group by default
      if (data.groups.length > 0) {
        setExpandedGroups(new Set(data.groups.map((g: ClaudeMapGroup) => g.key)));
      }
    } catch (err: any) {
      console.warn('[FilePreview] loadClaudeMap:', err);
      setError(err.message);
    } finally {
      setClaudeLoading(false);
    }
  }, []);

  useEffect(() => {
    if (currentDir) loadDir(currentDir);
    const onReconnect = () => { if (currentDir) loadDir(currentDir); };
    window.addEventListener('cui-reconnected', onReconnect);
    return () => window.removeEventListener('cui-reconnected', onReconnect);
  }, []);

  // Load claude map when switching to claude mode
  useEffect(() => {
    if (mode === 'claude' && claudeMap.length === 0) {
      loadClaudeMap();
    }
  }, [mode]);

  function navigate() {
    const path = inputPath.trim();
    if (path) {
      loadDir(path);
      setSelectedFile(null);
    }
  }

  function goUp() {
    const parent = currentDir.replace(/\/[^/]+\/?$/, '') || '/';
    setInputPath(parent);
    loadDir(parent);
    setSelectedFile(null);
  }

  async function stageFile() {
    if ((window as any).__cuiServerAlive === false) return;
    if (!selectedFile || !stageDir) return;
    setStageLoading(true);
    setStageSuccess(false);
    setError('');

    try {
      const res = await fetch(`${API}/files/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourcePath: selectedFile.path,
          targetDir: stageDir,
          operation: 'copy',
        }),
        signal: AbortSignal.timeout(25000),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(errText);
      }

      const data = await res.json();
      setStageSuccess(true);
      console.log('[FilePreview] Staged file:', data);
      setTimeout(() => setStageSuccess(false), 3000);
    } catch (err: any) {
      console.warn('[FilePreview] stageFile:', err);
      setError(`Stage failed: ${err.message}`);
    } finally {
      setStageLoading(false);
    }
  }

  function toggleGroup(key: string) {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  function toggleRefs(path: string) {
    setExpandedRefs(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }

  // Resolve a relative ref path to absolute
  // Type icons for different ref types
  function refTypeIcon(type: string): string {
    switch (type) {
      case 'ref': return '⚙'; // refs/*.md config files
      case 'link': return '→'; // [text](path) links
      case 'doc': return '📄'; // backtick docs
      case 'table': return '📋'; // table-referenced files
      default: return '→';
    }
  }

  function renderClaudeTree() {
    if (claudeLoading) {
      return (
        <div style={{ padding: 12, fontSize: 11, color: 'var(--tn-text-muted)', textAlign: 'center' }}>
          Scanne CLAUDE.md Files...
        </div>
      );
    }

    return (
      <div style={{ overflow: 'auto', flex: 1 }}>
        {claudeMap.map(group => (
          <div key={group.key}>
            {/* Group Header */}
            <button
              onClick={() => toggleGroup(group.key)}
              style={{
                display: 'flex', alignItems: 'center', gap: 4, width: '100%',
                padding: '4px 8px', background: 'var(--tn-bg-dark)', border: 'none',
                borderBottom: '1px solid var(--tn-border)',
                color: 'var(--tn-text)', fontSize: 10, fontWeight: 700,
                cursor: 'pointer', textAlign: 'left',
              }}
            >
              <span style={{ fontSize: 8, opacity: 0.6 }}>{expandedGroups.has(group.key) ? '▼' : '▶'}</span>
              <span>{group.label}</span>
              <span style={{ marginLeft: 'auto', color: 'var(--tn-text-muted)', fontWeight: 400 }}>{group.items.length}</span>
            </button>

            {/* Group Items */}
            {expandedGroups.has(group.key) && group.items.map(item => (
              <div key={item.path}>
                {/* CLAUDE.md Item */}
                <button
                  onClick={() => loadFile(item.path)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 4, width: '100%',
                    padding: '3px 8px 3px 16px',
                    background: selectedFile?.path === item.path ? 'var(--tn-bg-highlight)' : 'transparent',
                    border: 'none',
                    color: selectedFile?.path === item.path ? 'var(--tn-purple)' : 'var(--tn-text-subtle)',
                    fontSize: 11, textAlign: 'left', cursor: 'pointer',
                  }}
                >
                  <span style={{ fontSize: 9, color: 'var(--tn-purple)', fontWeight: 700, flexShrink: 0 }}>C</span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.label}</span>
                  {item.refs.length > 0 && (
                    <span
                      onClick={(e) => { e.stopPropagation(); toggleRefs(item.path); }}
                      style={{
                        marginLeft: 'auto', fontSize: 9, color: 'var(--tn-text-muted)',
                        padding: '0 4px', cursor: 'pointer', flexShrink: 0,
                      }}
                      title={`${item.refs.length} Referenzen`}
                    >
                      {expandedRefs.has(item.path) ? '−' : '+'}{item.refs.length}
                    </span>
                  )}
                </button>

                {/* Refs sub-items */}
                {expandedRefs.has(item.path) && item.refs.map(ref => (
                    <button
                      key={ref.path}
                      onClick={() => loadFile(ref.path)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 4, width: '100%',
                        padding: '2px 8px 2px 28px',
                        background: selectedFile?.path === ref.path ? 'var(--tn-bg-highlight)' : 'transparent',
                        border: 'none',
                        color: 'var(--tn-text-muted)', fontSize: 10, textAlign: 'left', cursor: 'pointer',
                      }}
                      title={`${ref.type}: ${ref.path}`}
                    >
                      <span style={{ fontSize: 8, opacity: 0.6, flexShrink: 0 }}>{refTypeIcon(ref.type)}</span>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ref.label}</span>
                    </button>
                ))}
              </div>
            ))}
          </div>
        ))}
      </div>
    );
  }

  function renderContent() {
    if (!selectedFile) {
      return (
        <div style={{ padding: 20, color: 'var(--tn-text-muted)', fontSize: 12, textAlign: 'center' }}>
          {mode === 'claude' ? 'CLAUDE.md auswaehlen' : 'Datei auswaehlen'}
        </div>
      );
    }

    const content = selectedFile.content;
    const mimeType = selectedFile.mimeType;
    const ext = selectedFile.ext ?? '';

    if (mimeType === 'image') {
      return (
        <div style={{ padding: 12, display: 'flex', justifyContent: 'center', alignItems: 'center', flex: 1 }}>
          <img src={content} alt="" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
        </div>
      );
    }

    if (mimeType === 'application/pdf') {
      return <iframe src={content} style={{ flex: 1, border: 'none', width: '100%' }} />;
    }

    if (ext === '.md' || ext === '.mdx') {
      const loadRenderedHtml = async () => {
        if (mdHtml) return; // already loaded for this file
        setMdHtmlLoading(true);
        try {
          const res = await resilientFetch(`${API}/file/render-md?path=${encodeURIComponent(selectedFile.path)}`);
          if (!res.ok) throw new Error(await res.text());
          const html = await res.text();
          setMdHtml(html);
        } catch (err: any) {
          setMdHtml(`<html><body style="font-family:sans-serif;padding:40px;color:#e53e3e"><h2>Render Error</h2><pre>${err.message}</pre></body></html>`);
        } finally {
          setMdHtmlLoading(false);
        }
      };

      // Auto-load rendered HTML when view is 'html' (default)
      if (mdView === 'html' && !mdHtml && !mdHtmlLoading) {
        loadRenderedHtml();
      }

      return (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {/* Toggle Bar */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 4,
            padding: '4px 12px', borderBottom: '1px solid var(--tn-border)',
            background: 'var(--tn-bg)', flexShrink: 0,
          }}>
            <button
              onClick={() => { setMdView('preview'); }}
              title="Dark Mode Markdown Rendering"
              style={{
                padding: '2px 8px', fontSize: 10, borderRadius: 3, cursor: 'pointer',
                background: mdView === 'preview' ? 'var(--tn-bg-highlight)' : 'transparent',
                border: mdView === 'preview' ? '1px solid var(--tn-border)' : '1px solid transparent',
                color: mdView === 'preview' ? 'var(--tn-blue)' : 'var(--tn-text-muted)',
                fontWeight: mdView === 'preview' ? 600 : 400,
              }}
            >
              Dark
            </button>
            <button
              onClick={() => { setMdView('html'); loadRenderedHtml(); }}
              title="WerkING Report Style (heller Hintergrund)"
              style={{
                padding: '2px 8px', fontSize: 10, borderRadius: 3, cursor: 'pointer',
                background: mdView === 'html' ? 'var(--tn-bg-highlight)' : 'transparent',
                border: mdView === 'html' ? '1px solid var(--tn-border)' : '1px solid transparent',
                color: mdView === 'html' ? '#DEC15E' : 'var(--tn-text-muted)',
                fontWeight: mdView === 'html' ? 600 : 400,
              }}
            >
              WerkING
            </button>
            {mdHtmlLoading && (
              <span style={{ marginLeft: 8, fontSize: 10, color: 'var(--tn-text-muted)' }}>Rendering…</span>
            )}
          </div>

          {/* Content */}
          {mdView === 'html' ? (
            <iframe
              srcDoc={mdHtml || '<html><body style="font-family:sans-serif;padding:40px;color:#718096;text-align:center"><p>Wird gerendert…</p></body></html>'}
              style={{ flex: 1, border: 'none', width: '100%', background: 'white' }}
              sandbox="allow-scripts allow-same-origin"
            />
          ) : (
            <div
              style={{
                flex: 1,
                overflow: 'auto',
                padding: '20px 32px',
                fontSize,
                lineHeight: 1.7,
                color: 'var(--tn-text)',
                maxWidth: '100%',
                boxSizing: 'border-box',
                overflowWrap: 'break-word',
                wordBreak: 'break-word',
              }}
              className="markdown-preview"
            >
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  h1: ({node, ...props}) => <h1 style={{fontSize: '28px', fontWeight: '700', color: 'var(--tn-text)', marginTop: '32px', marginBottom: '16px', borderBottom: '2px solid var(--tn-border)', paddingBottom: '8px'}} {...props} />,
                  h2: ({node, ...props}) => <h2 style={{fontSize: '22px', fontWeight: '600', color: 'var(--tn-text)', marginTop: '24px', marginBottom: '12px'}} {...props} />,
                  h3: ({node, ...props}) => <h3 style={{fontSize: '18px', fontWeight: '600', color: 'var(--tn-blue)', marginTop: '20px', marginBottom: '10px'}} {...props} />,
                  p: ({node, ...props}) => <p style={{marginBottom: '14px', color: 'var(--tn-text-subtle)'}} {...props} />,
                  ul: ({node, ...props}) => <ul style={{marginLeft: '20px', marginBottom: '14px', listStyleType: 'disc'}} {...props} />,
                  ol: ({node, ...props}) => <ol style={{marginLeft: '20px', marginBottom: '14px'}} {...props} />,
                  li: ({node, ...props}) => <li style={{marginBottom: '6px', color: 'var(--tn-text-subtle)'}} {...props} />,
                  code: ({node, inline, ...props}: any) => inline
                    ? <code style={{background: 'var(--tn-bg-highlight)', padding: '2px 6px', borderRadius: '3px', fontSize: '13px', fontFamily: 'monospace', color: 'var(--tn-blue)'}} {...props} />
                    : <code style={{display: 'block', background: 'var(--tn-bg-dark)', padding: '12px', borderRadius: '6px', fontSize: '13px', fontFamily: 'monospace', overflow: 'auto', marginBottom: '14px', border: '1px solid var(--tn-border)'}} {...props} />,
                  table: ({node, ...props}) => <div style={{overflowX: 'auto', marginBottom: '20px'}}><table style={{width: '100%', borderCollapse: 'collapse', fontSize: '13px', tableLayout: 'auto'}} {...props} /></div>,
                  thead: ({node, ...props}) => <thead style={{background: 'var(--tn-bg-highlight)', borderBottom: '2px solid var(--tn-border)'}} {...props} />,
                  th: ({node, ...props}) => <th style={{padding: '10px 12px', textAlign: 'left', fontWeight: '600', borderBottom: '1px solid var(--tn-border)'}} {...props} />,
                  td: ({node, ...props}) => <td style={{padding: '8px 12px', borderBottom: '1px solid var(--tn-border)', wordBreak: 'break-word', maxWidth: '300px'}} {...props} />,
                  blockquote: ({node, ...props}) => <blockquote style={{borderLeft: '4px solid var(--tn-blue)', paddingLeft: '16px', marginLeft: '0', marginBottom: '14px', color: 'var(--tn-text-muted)', fontStyle: 'italic'}} {...props} />,
                  hr: ({node, ...props}) => <hr style={{border: 'none', borderTop: '1px solid var(--tn-border)', margin: '24px 0'}} {...props} />,
                  a: ({node, href, ...props}) => {
                    if (mode === 'claude' && href && !href.startsWith('http') && selectedFile) {
                      let resolved = href;
                      if (href.startsWith('/')) {
                        resolved = href;
                      } else if (href.startsWith('refs/')) {
                        resolved = `${getPathConfig().claudeUserHome}/.claude/${href}`;
                      } else {
                        const dir = (selectedFile.path).replace(/\/[^/]+$/, '');
                        resolved = `${dir}/${href}`;
                      }
                      return (
                        <a
                          style={{color: 'var(--tn-purple)', textDecoration: 'underline', cursor: 'pointer'}}
                          onClick={(e) => { e.preventDefault(); loadFile(resolved); }}
                          title={resolved}
                          {...props}
                        />
                      );
                    }
                    return <a style={{color: 'var(--tn-blue)', textDecoration: 'none'}} href={href} {...props} />;
                  },
                  strong: ({node, ...props}) => <strong style={{fontWeight: '600', color: 'var(--tn-text)'}} {...props} />,
                }}
              >
                {content}
              </ReactMarkdown>
            </div>
          )}
        </div>
      );
    }

    if (ext === '.mmd' || ext === '.merm') {
      return <MermaidRenderer source={content} />;
    }

    if (ext === '.html' || ext === '.htm') {
      // Resolve relative src/href paths in HTML to API-served absolute URLs
      // so that images, stylesheets, and other assets load correctly in srcDoc iframes
      const htmlDir = (selectedFile.path).replace(/\/[^/]+$/, '');
      const processedContent = content.replace(
        /(src|href)\s*=\s*"(?!https?:\/\/|data:|\/api\/|#|mailto:)([^"]+)"/g,
        (_match: string, attr: string, relPath: string) => {
          const absPath = `${htmlDir}/${relPath}`;
          return `${attr}="${API}/file?path=${encodeURIComponent(absPath)}"`;
        }
      );
      return (
        <iframe
          srcDoc={processedContent}
          style={{ flex: 1, border: 'none', width: '100%', background: 'white' }}
          sandbox="allow-scripts allow-same-origin"
        />
      );
    }

    if (ext === '.json') {
      let formatted = content;
      try { formatted = JSON.stringify(JSON.parse(content), null, 2); } catch {} // silent-ok: invalid JSON formatting attempt fails gracefully; raw content displayed
      return (
        <pre style={{
          flex: 1, overflow: 'auto', padding: 12, fontSize,
          color: 'var(--tn-text-subtle)', fontFamily: "'JetBrains Mono', monospace",
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        }}>
          {formatted}
        </pre>
      );
    }

    return (
      <pre style={{
        flex: 1, overflow: 'auto', padding: 12, fontSize,
        color: 'var(--tn-text-subtle)', fontFamily: "'JetBrains Mono', monospace",
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      }}>
        {content}
      </pre>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--tn-surface)' }}>
      {/* Path Bar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px',
        background: 'var(--tn-bg-dark)', borderBottom: '1px solid var(--tn-border)',
        height: 30, flexShrink: 0,
      }}>
        {mode === 'browse' && (
          <button
            onClick={goUp}
            style={{ background: 'none', border: 'none', color: 'var(--tn-text-muted)', cursor: 'pointer', fontSize: 13 }}
            title="Up"
          >
            ..
          </button>
        )}
        {mode === 'browse' ? (
          <input
            value={inputPath}
            onChange={(e) => setInputPath(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') navigate(); }}
            placeholder="Pfad eingeben..."
            style={{
              flex: 1, background: 'var(--tn-bg)', color: 'var(--tn-text)',
              border: '1px solid var(--tn-border)', borderRadius: 4, padding: '2px 8px', fontSize: 11,
            }}
          />
        ) : (
          <span style={{ flex: 1, fontSize: 11, color: 'var(--tn-purple)', fontWeight: 600 }}>
            CLAUDE.md Navigator ({claudeTotal} files)
          </span>
        )}
      </div>

      {error && (
        <div style={{ padding: '4px 8px', fontSize: 11, color: 'var(--tn-red)', background: 'var(--tn-bg-dark)' }}>
          {error}
        </div>
      )}

      {/* Quick Nav + Mode Toggle */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 2, padding: '2px 8px',
        background: 'var(--tn-bg)', borderBottom: '1px solid var(--tn-border)',
        flexShrink: 0, flexWrap: 'wrap', minHeight: 22,
      }}>
        {/* CLAUDE Mode Toggle */}
        <button
          onClick={() => { setMode(m => m === 'claude' ? 'browse' : 'claude'); setSelectedFile(null); }}
          style={{
            background: mode === 'claude' ? 'rgba(187,154,247,0.2)' : 'none',
            border: mode === 'claude' ? '1px solid rgba(187,154,247,0.4)' : '1px solid transparent',
            borderRadius: 3, padding: '1px 6px', fontSize: 10,
            color: '#bb9af7', cursor: 'pointer',
            fontWeight: mode === 'claude' ? 700 : 600,
            marginRight: 4,
          }}
          title="CLAUDE.md Navigator"
        >
          CLAUDE
        </button>

        {/* Separator */}
        <span style={{ width: 1, height: 12, background: 'var(--tn-border)', marginRight: 2 }} />

        {/* Quick Dir buttons (only in browse mode) */}
        {mode === 'browse' && QUICK_DIRS.map((d) => (
          <button
            key={d.path}
            onClick={() => { setInputPath(d.path); loadDir(d.path); setSelectedFile(null); }}
            style={{
              background: currentDir.startsWith(d.path) ? 'var(--tn-bg-highlight)' : 'none',
              border: currentDir.startsWith(d.path) ? '1px solid var(--tn-border)' : '1px solid transparent',
              borderRadius: 3, padding: '1px 6px', fontSize: 10,
              color: d.color || 'var(--tn-text-muted)', cursor: 'pointer',
              fontWeight: currentDir === d.path ? 700 : 400,
            }}
            title={d.path}
          >
            {d.label}
          </button>
        ))}
      </div>

      {/* Split: File List + Preview */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* Sidebar */}
        <div style={{ width: mode === 'claude' ? 240 : 200, borderRight: '1px solid var(--tn-border)', overflow: 'auto', flexShrink: 0 }}>
          {mode === 'claude' ? renderClaudeTree() : (
            <>
              {entries.map((e) => (
                <button
                  key={e.path}
                  onClick={() => {
                    if (e.isDir) {
                      setInputPath(e.path);
                      loadDir(e.path);
                      setSelectedFile(null);
                    } else {
                      loadFile(e.path);
                    }
                  }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6, width: '100%',
                    padding: '3px 8px',
                    background: selectedFile?.path === (e.path) ? 'var(--tn-bg-highlight)' : 'transparent',
                    border: 'none', color: e.isDir ? 'var(--tn-blue)' : 'var(--tn-text)',
                    fontSize: 11, textAlign: 'left', cursor: 'pointer',
                  }}
                >
                  <span style={{ fontSize: 10, opacity: 0.6 }}>{e.isDir ? '/' : getFileIcon(e.ext ?? null)}</span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.name}</span>
                </button>
              ))}
              {entries.length === 0 && currentDir && (
                <div style={{ padding: 12, fontSize: 11, color: 'var(--tn-text-muted)', textAlign: 'center' }}>Leer</div>
              )}
            </>
          )}
        </div>

        {/* Content Area */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
          {selectedFile && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '2px 8px', fontSize: 10,
              borderBottom: '1px solid var(--tn-border)', background: 'var(--tn-bg)',
            }}>
              <span style={{ flex: 1, color: 'var(--tn-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {selectedFile.path}
              </span>
              {/* Font Size Controls */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 2, marginRight: 4 }}>
                <button
                  onClick={() => changeFontSize(-1)}
                  style={{
                    width: 18, height: 18, fontSize: 12, lineHeight: '16px',
                    background: 'none', border: '1px solid var(--tn-border)', borderRadius: 3,
                    color: 'var(--tn-text-muted)', cursor: 'pointer', padding: 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}
                  title="Schrift kleiner"
                >A</button>
                <span style={{ fontSize: 9, color: 'var(--tn-text-muted)', minWidth: 18, textAlign: 'center' }}>{fontSize}</span>
                <button
                  onClick={() => changeFontSize(1)}
                  style={{
                    width: 18, height: 18, fontSize: 14, lineHeight: '16px', fontWeight: 700,
                    background: 'none', border: '1px solid var(--tn-border)', borderRadius: 3,
                    color: 'var(--tn-text-muted)', cursor: 'pointer', padding: 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}
                  title="Schrift groesser"
                >A</button>
              </div>
              <a
                href={`${API}/file/download?path=${encodeURIComponent(selectedFile.path)}`}
                download
                style={{
                  padding: '2px 8px', fontSize: 10, borderRadius: 3,
                  background: 'var(--tn-green)',
                  color: 'white', border: 'none', cursor: 'pointer',
                  textDecoration: 'none', display: 'inline-block',
                }}
                title="Download file"
              >
                Download
              </a>
              {stageDir && (
                <button
                  onClick={stageFile}
                  disabled={stageLoading}
                  style={{
                    padding: '2px 8px', fontSize: 10, borderRadius: 3,
                    background: stageSuccess ? 'var(--tn-green)' : 'var(--tn-blue)',
                    color: 'white', border: 'none', cursor: stageLoading ? 'wait' : 'pointer',
                    opacity: stageLoading ? 0.6 : 1,
                  }}
                  title={`Copy to ${stageDir}`}
                >
                  {stageLoading ? '...' : stageSuccess ? 'Staged' : 'Stage'}
                </button>
              )}
            </div>
          )}
          {renderContent()}
        </div>
      </div>
    </div>
  );
}

function getFileIcon(ext: string | null): string {
  switch (ext) {
    case '.md': return 'M';
    case '.json': return 'J';
    case '.ts': case '.tsx': return 'T';
    case '.js': case '.jsx': return 'J';
    case '.py': return 'P';
    case '.html': return 'H';
    case '.css': return 'C';
    case '.pdf': return 'P';
    case '.mmd': case '.merm': return 'D';
    case '.png': case '.jpg': case '.jpeg': case '.gif': case '.svg': return 'I';
    default: return '-';
  }
}
