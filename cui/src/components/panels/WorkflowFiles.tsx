/**
 * Workflow Files Panel — Directory tree + code preview for workflow development.
 *
 * Shows the Engelmann workflows directory as an expandable tree (left)
 * with syntax-highlighted code preview (right). Auto-refreshes on file changes.
 *
 * Used in the engelmann-developer workspace alongside Prompt Explorer.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { resilientFetch } from '../../utils/resilientFetch';

// ── Types ──────────────────────────────────────────────────────

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  ext?: string | null;
  children?: TreeNode[];
}

interface FileContent {
  path: string;
  content: string;
  mimeType: string;
  ext?: string;
}

interface Props {
  basePath?: string;
}

// ── Helpers ────────────────────────────────────────────────────

function getFileIcon(ext: string | null | undefined): string {
  if (!ext) return '📄';
  switch (ext) {
    case '.py': return '🐍';
    case '.yaml': case '.yml': return '📋';
    case '.md': return '📝';
    case '.ts': case '.tsx': return '🔷';
    case '.js': case '.jsx': return '🟨';
    case '.json': return '{}';
    case '.sh': return '⚙️';
    case '.txt': return '📄';
    default: return '📄';
  }
}

function getLanguageClass(ext: string | undefined): string {
  if (!ext) return '';
  switch (ext) {
    case '.py': return 'python';
    case '.yaml': case '.yml': return 'yaml';
    case '.ts': case '.tsx': return 'typescript';
    case '.js': case '.jsx': return 'javascript';
    case '.json': return 'json';
    case '.sh': return 'bash';
    case '.md': return 'markdown';
    default: return '';
  }
}

function shortenPath(fullPath: string, basePath: string): string {
  if (fullPath.startsWith(basePath)) {
    return fullPath.slice(basePath.length).replace(/^\//, '');
  }
  return fullPath;
}

// ── Styles ─────────────────────────────────────────────────────

const S = {
  container: {
    display: 'flex',
    height: '100%',
    background: '#0f172a',
    color: '#c0caf5',
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
    fontSize: 13,
    overflow: 'hidden',
  } as React.CSSProperties,

  sidebar: {
    width: 280,
    minWidth: 200,
    borderRight: '1px solid #1e293b',
    display: 'flex',
    flexDirection: 'column' as const,
    overflow: 'hidden',
  } as React.CSSProperties,

  sidebarHeader: {
    padding: '8px 12px',
    borderBottom: '1px solid #1e293b',
    background: '#1a1b26',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: 12,
    fontWeight: 600,
    color: '#7aa2f7',
  } as React.CSSProperties,

  sidebarTree: {
    flex: 1,
    overflow: 'auto',
    padding: '4px 0',
  } as React.CSSProperties,

  treeItem: (depth: number, isDir: boolean, isSelected: boolean) => ({
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    padding: '3px 8px',
    paddingLeft: 12 + depth * 16,
    cursor: 'pointer',
    background: isSelected ? '#1e293b' : 'transparent',
    borderLeft: isSelected ? '2px solid #7aa2f7' : '2px solid transparent',
    color: isDir ? '#7aa2f7' : '#c0caf5',
    fontWeight: isDir ? 600 : 400,
    fontSize: 12,
    whiteSpace: 'nowrap' as const,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    border: 'none',
    width: '100%',
    textAlign: 'left' as const,
    fontFamily: 'inherit',
  }) as React.CSSProperties,

  content: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column' as const,
    overflow: 'hidden',
  } as React.CSSProperties,

  contentHeader: {
    padding: '6px 12px',
    borderBottom: '1px solid #1e293b',
    background: '#1a1b26',
    fontSize: 11,
    color: '#565f89',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  } as React.CSSProperties,

  contentBody: {
    flex: 1,
    overflow: 'auto',
    padding: 0,
  } as React.CSSProperties,

  codeBlock: {
    margin: 0,
    padding: '12px 16px',
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
    fontSize: 12,
    lineHeight: 1.6,
    whiteSpace: 'pre' as const,
    color: '#c0caf5',
    background: '#0f172a',
    minHeight: '100%',
  } as React.CSSProperties,

  lineNumber: {
    display: 'inline-block',
    width: 40,
    textAlign: 'right' as const,
    color: '#3b4261',
    marginRight: 16,
    userSelect: 'none' as const,
  } as React.CSSProperties,

  emptyState: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    color: '#565f89',
    fontSize: 13,
    padding: 24,
    textAlign: 'center' as const,
  } as React.CSSProperties,

  refreshBtn: {
    background: 'none',
    border: '1px solid #334155',
    borderRadius: 4,
    color: '#7aa2f7',
    cursor: 'pointer',
    padding: '2px 8px',
    fontSize: 11,
    fontFamily: 'inherit',
  } as React.CSSProperties,

  badge: {
    fontSize: 10,
    padding: '1px 5px',
    borderRadius: 3,
    background: '#1e293b',
    color: '#565f89',
    marginLeft: 'auto',
  } as React.CSSProperties,
} as const;

// ── Component ──────────────────────────────────────────────────

export default function WorkflowFiles({ basePath }: Props) {
  const defaultPath = basePath || '/root/projekte/workflows/partners/engelmann';
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<FileContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());
  const refreshInterval = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Load directory tree ──
  const loadTree = useCallback(async () => {
    try {
      const res = await resilientFetch(
        `/api/disk-tree?path=${encodeURIComponent(defaultPath)}&maxDepth=6&maxPerLevel=50`
      );
      if (!res.ok) {
        setError(`Failed to load: ${res.status}`);
        return;
      }
      const data = await res.json();
      if (data.nodes && data.nodes.length > 0) {
        // disk-tree returns a single root node with children
        const root = data.nodes[0];
        setTree(root.children || []);
        // Auto-expand first level
        const firstLevel = new Set<string>();
        for (const child of root.children || []) {
          if (child.isDir) firstLevel.add(child.path);
        }
        setExpanded(prev => new Set([...prev, ...firstLevel]));
      } else {
        setTree([]);
      }
      setError(null);
      setLastRefresh(new Date());
    } catch (err: any) {
      setError(err.message || 'Failed to load tree');
    }
  }, [defaultPath]);

  // ── Load file content ──
  const loadFile = useCallback(async (path: string) => {
    setSelectedFile(path);
    setLoading(true);
    try {
      const res = await resilientFetch(`/api/file?path=${encodeURIComponent(path)}`);
      if (!res.ok) {
        setFileContent(null);
        setError(`Failed to load file: ${res.status}`);
        setLoading(false);
        return;
      }
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const data = await res.json();
        setFileContent(data);
      } else {
        const text = await res.text();
        const ext = path.split('.').pop();
        setFileContent({ path, content: text, mimeType: contentType, ext: ext ? `.${ext}` : undefined });
      }
      setError(null);
    } catch (err: any) {
      setError(err.message || 'Failed to load file');
    }
    setLoading(false);
  }, []);

  // ── Initial load + auto-refresh ──
  useEffect(() => {
    loadTree();
    refreshInterval.current = setInterval(loadTree, 15000);
    return () => {
      if (refreshInterval.current) clearInterval(refreshInterval.current);
    };
  }, [loadTree]);

  // ── Toggle directory expand ──
  const toggleDir = useCallback((path: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  // ── Render tree node recursively ──
  const renderNode = (node: TreeNode, depth: number): React.ReactNode => {
    const isExp = expanded.has(node.path);
    const isSel = selectedFile === node.path;

    // Skip hidden dirs, __pycache__, venv, .git
    if (node.name.startsWith('.') || node.name === '__pycache__' || node.name === 'venv' || node.name === '.venv' || node.name === 'node_modules') {
      return null;
    }

    return (
      <div key={node.path}>
        <button
          style={S.treeItem(depth, node.isDir, isSel)}
          onClick={() => {
            if (node.isDir) {
              toggleDir(node.path);
            } else {
              loadFile(node.path);
            }
          }}
          title={node.path}
        >
          <span style={{ opacity: 0.7, flexShrink: 0 }}>
            {node.isDir ? (isExp ? '▼' : '▶') : getFileIcon(node.ext)}
          </span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {node.name}
          </span>
          {node.isDir && node.children && (
            <span style={S.badge}>{node.children.filter(c => !c.name.startsWith('.')).length}</span>
          )}
        </button>
        {node.isDir && isExp && node.children && (
          <div>
            {node.children
              .sort((a, b) => {
                if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
                return a.name.localeCompare(b.name);
              })
              .map(child => renderNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  // ── Render file content ──
  const renderContent = () => {
    if (loading) {
      return <div style={S.emptyState}>Loading...</div>;
    }
    if (!selectedFile || !fileContent) {
      return (
        <div style={S.emptyState}>
          <div>
            <div style={{ fontSize: 24, marginBottom: 8 }}>📂</div>
            <div>Select a file from the tree to preview</div>
            <div style={{ fontSize: 11, marginTop: 8, opacity: 0.6 }}>
              Click on workflow files to see their code
            </div>
          </div>
        </div>
      );
    }

    const ext = fileContent.ext || '';
    const isMarkdown = ext === '.md' || ext === '.mdx';
    const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.svg'].includes(ext);

    if (isImage) {
      return (
        <div style={{ padding: 16, textAlign: 'center' }}>
          <img
            src={`/api/file?path=${encodeURIComponent(fileContent.path)}`}
            alt={fileContent.path}
            style={{ maxWidth: '100%', maxHeight: '80vh' }}
          />
        </div>
      );
    }

    if (isMarkdown) {
      return (
        <div style={{ padding: '12px 24px', maxWidth: 800 }}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {fileContent.content}
          </ReactMarkdown>
        </div>
      );
    }

    // Code view with line numbers
    const lines = fileContent.content.split('\n');
    return (
      <pre style={S.codeBlock}>
        {lines.map((line, i) => (
          <div key={i}>
            <span style={S.lineNumber}>{i + 1}</span>
            <span>{line}</span>
          </div>
        ))}
      </pre>
    );
  };

  return (
    <div style={S.container}>
      {/* Left: Directory Tree */}
      <div style={S.sidebar}>
        <div style={S.sidebarHeader}>
          <span>📁 Workflow Files</span>
          <button
            style={S.refreshBtn}
            onClick={loadTree}
            title="Refresh file tree"
          >
            ↻
          </button>
        </div>
        <div style={S.sidebarTree}>
          {error && !tree.length ? (
            <div style={{ ...S.emptyState, fontSize: 11 }}>{error}</div>
          ) : tree.length === 0 ? (
            <div style={S.emptyState}>No files found</div>
          ) : (
            tree
              .sort((a, b) => {
                if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
                return a.name.localeCompare(b.name);
              })
              .map(node => renderNode(node, 0))
          )}
        </div>
        <div style={{
          padding: '4px 12px',
          borderTop: '1px solid #1e293b',
          fontSize: 10,
          color: '#3b4261',
        }}>
          {lastRefresh.toLocaleTimeString()}
        </div>
      </div>

      {/* Right: File Preview */}
      <div style={S.content}>
        {selectedFile && (
          <div style={S.contentHeader}>
            <span style={{ color: '#7aa2f7' }}>
              {getFileIcon(fileContent?.ext)} {shortenPath(selectedFile, defaultPath)}
            </span>
            <span style={{ fontSize: 10 }}>
              {getLanguageClass(fileContent?.ext) || 'text'}
            </span>
          </div>
        )}
        <div style={S.contentBody}>
          {renderContent()}
        </div>
      </div>
    </div>
  );
}
