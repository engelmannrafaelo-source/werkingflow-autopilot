import { useState, useEffect, useCallback, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  ext: string | null;
}

interface FileContent {
  path: string;
  content: string;
  mimeType: string;
  ext: string;
}

interface FilePreviewProps {
  watchPath?: string;
  stageDir?: string; // Target directory for staging files
}

const API = '/api';

// Maps local watchPath to its SSH equivalent (mirror path on server)
const SSH_ROOT = '/root/projekte/werkingflow';

function isSSHPath(p: string): boolean {
  return p.startsWith('/root/');
}

function toSSHPath(localPath: string): string {
  // e.g. /Users/rafael/Documents/GitHub/werkingflow/autopilot/cui/data/active/werking-report
  //   → /root/projekte/werkingflow/autopilot/cui/data/active/werking-report
  const match = localPath.match(/\/werkingflow(.*)/);
  if (match) return `${SSH_ROOT}${match[1]}`;
  return SSH_ROOT;
}

function toLocalPath(sshPath: string, localBase: string): string {
  const match = sshPath.match(/\/root\/projekte\/werkingflow(.*)/);
  if (!match) return localBase;
  const localRoot = localBase.match(/^(.*\/werkingflow)/)?.[1] ?? localBase;
  return `${localRoot}${match[1]}`;
}

export default function FilePreview({ watchPath, stageDir }: FilePreviewProps) {
  const [currentDir, setCurrentDir] = useState(watchPath ?? '');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [selectedFile, setSelectedFile] = useState<FileContent | null>(null);
  const [error, setError] = useState('');
  const [inputPath, setInputPath] = useState(watchPath ?? '');
  const [stageLoading, setStageLoading] = useState(false);
  const [stageSuccess, setStageSuccess] = useState(false);
  const [sshMode, setSSHMode] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const localBaseRef = useRef(watchPath ?? '');

  // WebSocket for file changes
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      if (currentDir) {
        ws.send(JSON.stringify({ type: 'watch', path: currentDir }));
      }
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'file-change') {
        if (currentDir) loadDir(currentDir);
        if (selectedFile && msg.path === selectedFile.path) {
          loadFile(selectedFile.path);
        }
      }
    };

    return () => ws.close();
  }, [currentDir]);

  const loadDir = useCallback(async (dirPath: string) => {
    try {
      const res = await fetch(`${API}/files?path=${encodeURIComponent(dirPath)}`);
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setEntries(data.entries);
      setCurrentDir(data.path);
      setError('');

      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'watch', path: data.path }));
      }
    } catch (err: any) {
      setError(err.message);
    }
  }, []);

  const loadFile = useCallback(async (filePath: string) => {
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
      const res = await fetch(`${API}/file?path=${encodeURIComponent(filePath)}`);
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setSelectedFile(data);
    } catch (err: any) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    if (watchPath && !isSSHPath(watchPath)) {
      localBaseRef.current = watchPath;
    }
    if (currentDir) loadDir(currentDir);
  }, []);

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

  function toggleSSH() {
    const nextSSH = !sshMode;
    setSSHMode(nextSSH);
    setSelectedFile(null);
    const newPath = nextSSH
      ? toSSHPath(currentDir || localBaseRef.current)
      : toLocalPath(currentDir, localBaseRef.current);
    setInputPath(newPath);
    loadDir(newPath);
  }

  async function stageFile() {
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
          operation: 'copy', // Copy by default (keep original)
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(errText);
      }

      const data = await res.json();
      setStageSuccess(true);
      console.log('[FilePreview] Staged file:', data);

      // Auto-hide success message after 3s
      setTimeout(() => setStageSuccess(false), 3000);
    } catch (err: any) {
      setError(`Stage failed: ${err.message}`);
    } finally {
      setStageLoading(false);
    }
  }

  function renderContent() {
    if (!selectedFile) {
      return (
        <div style={{ padding: 20, color: 'var(--tn-text-muted)', fontSize: 12, textAlign: 'center' }}>
          Datei auswaehlen
        </div>
      );
    }

    const { content, mimeType, ext } = selectedFile;

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
      return (
        <div
          style={{
            flex: 1,
            overflow: 'auto',
            padding: '20px 32px',
            fontSize: 14,
            lineHeight: 1.7,
            color: 'var(--tn-text)',
            maxWidth: '900px',
            margin: '0 auto',
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
              code: ({node, inline, ...props}) => inline
                ? <code style={{background: 'var(--tn-bg-highlight)', padding: '2px 6px', borderRadius: '3px', fontSize: '13px', fontFamily: 'monospace', color: 'var(--tn-blue)'}} {...props} />
                : <code style={{display: 'block', background: 'var(--tn-bg-dark)', padding: '12px', borderRadius: '6px', fontSize: '13px', fontFamily: 'monospace', overflow: 'auto', marginBottom: '14px', border: '1px solid var(--tn-border)'}} {...props} />,
              table: ({node, ...props}) => <table style={{width: '100%', borderCollapse: 'collapse', marginBottom: '20px', fontSize: '13px'}} {...props} />,
              thead: ({node, ...props}) => <thead style={{background: 'var(--tn-bg-highlight)', borderBottom: '2px solid var(--tn-border)'}} {...props} />,
              th: ({node, ...props}) => <th style={{padding: '10px 12px', textAlign: 'left', fontWeight: '600', borderBottom: '1px solid var(--tn-border)'}} {...props} />,
              td: ({node, ...props}) => <td style={{padding: '8px 12px', borderBottom: '1px solid var(--tn-border)'}} {...props} />,
              blockquote: ({node, ...props}) => <blockquote style={{borderLeft: '4px solid var(--tn-blue)', paddingLeft: '16px', marginLeft: '0', marginBottom: '14px', color: 'var(--tn-text-muted)', fontStyle: 'italic'}} {...props} />,
              hr: ({node, ...props}) => <hr style={{border: 'none', borderTop: '1px solid var(--tn-border)', margin: '24px 0'}} {...props} />,
              a: ({node, ...props}) => <a style={{color: 'var(--tn-blue)', textDecoration: 'none'}} {...props} />,
              strong: ({node, ...props}) => <strong style={{fontWeight: '600', color: 'var(--tn-text)'}} {...props} />,
            }}
          >
            {content}
          </ReactMarkdown>
        </div>
      );
    }

    if (ext === '.html' || ext === '.htm') {
      return (
        <iframe
          srcDoc={content}
          style={{ flex: 1, border: 'none', width: '100%', background: 'white' }}
          sandbox="allow-scripts"
        />
      );
    }

    if (ext === '.json') {
      let formatted = content;
      try { formatted = JSON.stringify(JSON.parse(content), null, 2); } catch {}
      return (
        <pre style={{
          flex: 1, overflow: 'auto', padding: 12, fontSize: 12,
          color: 'var(--tn-text-subtle)', fontFamily: "'JetBrains Mono', monospace",
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        }}>
          {formatted}
        </pre>
      );
    }

    return (
      <pre style={{
        flex: 1, overflow: 'auto', padding: 12, fontSize: 12,
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
        <button
          onClick={goUp}
          style={{ background: 'none', border: 'none', color: 'var(--tn-text-muted)', cursor: 'pointer', fontSize: 13 }}
          title="Up"
        >
          ..
        </button>
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
        <button
          onClick={toggleSSH}
          title={sshMode ? 'SSH (Server) – klicken für Lokal' : 'Lokal – klicken für SSH (Server)'}
          style={{
            padding: '2px 7px', fontSize: 10, borderRadius: 3, flexShrink: 0,
            background: sshMode ? 'var(--tn-blue)' : 'var(--tn-bg-highlight)',
            color: sshMode ? 'white' : 'var(--tn-text-muted)',
            border: `1px solid ${sshMode ? 'var(--tn-blue)' : 'var(--tn-border)'}`,
            cursor: 'pointer', fontFamily: 'monospace',
          }}
        >
          {sshMode ? 'SSH' : 'Lokal'}
        </button>
      </div>

      {error && (
        <div style={{ padding: '4px 8px', fontSize: 11, color: 'var(--tn-red)', background: 'var(--tn-bg-dark)' }}>
          {error}
        </div>
      )}

      {/* Split: File List + Preview */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* File List Sidebar */}
        <div style={{ width: 200, borderRight: '1px solid var(--tn-border)', overflow: 'auto', flexShrink: 0 }}>
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
                background: selectedFile?.path === e.path ? 'var(--tn-bg-highlight)' : 'transparent',
                border: 'none', color: e.isDir ? 'var(--tn-blue)' : 'var(--tn-text)',
                fontSize: 11, textAlign: 'left', cursor: 'pointer',
              }}
            >
              <span style={{ fontSize: 10, opacity: 0.6 }}>{e.isDir ? '/' : getFileIcon(e.ext)}</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.name}</span>
            </button>
          ))}
          {entries.length === 0 && currentDir && (
            <div style={{ padding: 12, fontSize: 11, color: 'var(--tn-text-muted)', textAlign: 'center' }}>Leer</div>
          )}
        </div>

        {/* Content Area */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
          {selectedFile && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '2px 8px', fontSize: 10,
              borderBottom: '1px solid var(--tn-border)', background: 'var(--tn-bg)',
            }}>
              <span style={{ flex: 1, color: 'var(--tn-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {selectedFile.path}
              </span>
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
                  {stageLoading ? '⏳' : stageSuccess ? '✓ Staged' : '→ Stage'}
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
    case '.png': case '.jpg': case '.jpeg': case '.gif': case '.svg': return 'I';
    default: return '-';
  }
}
