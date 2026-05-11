/**
 * Business Angel Panel v2 — Full file-tree context selection, chat, diff cards.
 */

import { useState, useEffect, useCallback, useRef, Fragment } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { diffLines } from 'diff';
import { markdownComponents } from './cui/ChatMessages';
import { validateApiResponse } from '../../lib/validateApiResponse';

// --- Types ---

interface FileTokenInfo {
  path: string;
  exists: boolean;
  tokens: number;
}

interface DiaryStats {
  daily_count: number;
  weekly_count: number;
  monthly_count: number;
  total_tokens: number;
  latest_daily: string | null;
  base_dir: string;
  config: { daily_days: number; weekly_days: number };
}

interface ContextData {
  kern_files?: FileTokenInfo[];
  kern_tokens?: number;
  temp_files?: Array<{ name: string; tokens: number }>;
  temp_tokens?: number;
  temp_dir?: string;
  tagebuch?: DiaryStats;
}

interface TreeFile {
  type: 'file';
  name: string;
  path: string;
  tokens: number;
  is_kern: boolean;
}

interface TreeDir {
  type: 'dir';
  name: string;
  path: string;
  children: TreeNode[];
  totalTokens: number;
}

type TreeNode = TreeFile | TreeDir;

interface LoadResult {
  session_id: string;
  token_count: number;
  files_loaded: number;
  temp_files?: string[];
  conversation?: ChatMessage[];
  conversation_turns?: number;
  excluded?: string[];
  ack_message?: string;
  lite?: boolean;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface SessionListItem {
  id: string;
  title?: string;
  created_at: number;
  updated_at?: number;
  turns?: number;
  filename?: string;
}

// --- Helpers ---

function formatTokens(n: number): string {
  if (n >= 1000) return `~${(n / 1000).toFixed(1)}k`;
  return `~${n}`;
}

function tokenColor(n: number): string {
  if (n > 80000) return 'var(--tn-red, #f7768e)';
  if (n > 50000) return 'var(--tn-yellow, #e0af68)';
  return 'var(--tn-green, #9ece6a)';
}


// Count all files in tree that are selected
function countSelectedInTree(nodes: TreeNode[], selected: Set<string>): number {
  let count = 0;
  for (const n of nodes) {
    if (n.type === 'file' && selected.has(n.path)) count++;
    else if (n.type === 'dir') count += countSelectedInTree(n.children, selected);
  }
  return count;
}

function calcSelectedTokens(nodes: TreeNode[], selected: Set<string>): number {
  let sum = 0;
  for (const n of nodes) {
    if (n.type === 'file' && selected.has(n.path)) sum += n.tokens;
    else if (n.type === 'dir') sum += calcSelectedTokens(n.children, selected);
  }
  return sum;
}

// --- Styles ---

const S = {
  root: {
    fontFamily: 'monospace', fontSize: '13px', color: 'var(--tn-text)',
    height: '100%', display: 'flex', flexDirection: 'column' as const,
  },
  header: {
    padding: '10px 14px 8px', flexShrink: 0,
    borderBottom: '1px solid var(--tn-border, rgba(255,255,255,0.08))',
    display: 'flex', alignItems: 'center', gap: '8px',
  },
  h2: { margin: 0, fontSize: '14px', color: 'var(--tn-purple, #bb9af7)', fontWeight: 600 },
  body: { flex: 1, overflowY: 'hidden' as const, padding: '10px 14px', display: 'flex', flexDirection: 'column' as const, minHeight: 0 },
  section: { marginBottom: '14px' },
  secLabel: {
    fontSize: '10px', textTransform: 'uppercase' as const, letterSpacing: '0.07em',
    color: 'var(--tn-text-muted)', display: 'flex', alignItems: 'center',
    gap: '5px', cursor: 'pointer', userSelect: 'none' as const,
    padding: '3px 0', marginBottom: '4px',
  },
  badge: (color?: string) => ({
    fontSize: '10px', padding: '1px 5px', borderRadius: '8px',
    background: 'var(--tn-surface2, rgba(255,255,255,0.07))',
    color: color || 'var(--tn-text-muted)',
  }),
  // File tree
  treeFile: (selected: boolean, kern: boolean) => ({
    display: 'flex', alignItems: 'center', gap: '5px',
    padding: '2px 0',
    opacity: kern ? 0.7 : 1,
    cursor: kern ? 'default' : 'pointer',
    background: selected && !kern ? 'rgba(187,154,247,0.06)' : undefined,
    borderRadius: '3px',
  }),
  treeFileName: {
    flex: 1, fontSize: '11px', overflow: 'hidden',
    textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const,
  },
  treeTokens: { fontSize: '10px', color: 'var(--tn-text-muted)', flexShrink: 0 },
  kernBadge: {
    fontSize: '9px', padding: '0 4px', borderRadius: '3px',
    background: 'rgba(187,154,247,0.15)', color: 'var(--tn-purple, #bb9af7)',
    flexShrink: 0,
  },
  treeDir: {
    display: 'flex', alignItems: 'center', gap: '4px',
    fontSize: '11px', color: 'var(--tn-text-muted)',
    cursor: 'pointer', userSelect: 'none' as const,
    padding: '3px 0', fontWeight: 600,
  },
  checkbox: (checked: boolean, disabled: boolean) => ({
    width: '12px', height: '12px', flexShrink: 0,
    border: `1px solid ${checked ? 'var(--tn-purple, #bb9af7)' : 'rgba(255,255,255,0.2)'}`,
    borderRadius: '2px',
    background: checked ? 'var(--tn-purple, #bb9af7)' : 'transparent',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: '9px', color: '#1a1b26',
    opacity: disabled ? 0.5 : 1,
    cursor: disabled ? 'default' : 'pointer',
  }),
  // Buttons
  btn: {
    padding: '6px 12px', borderRadius: '4px', border: 'none',
    cursor: 'pointer', fontFamily: 'monospace', fontSize: '12px', fontWeight: 600,
  } as React.CSSProperties,
  btnPrimary: { background: 'var(--tn-purple, #bb9af7)', color: '#1a1b26' } as React.CSSProperties,
  btnGreen: { background: 'var(--tn-green, #9ece6a)', color: '#1a1b26' } as React.CSSProperties,
  btnGhost: { background: 'var(--tn-surface2, rgba(255,255,255,0.08))', color: 'var(--tn-text)' } as React.CSSProperties,
  divider: { borderTop: '1px solid var(--tn-border, rgba(255,255,255,0.07))', margin: '10px 0' },
  errMsg: { color: 'var(--tn-red, #f7768e)', fontSize: '11px', marginTop: '4px' },
  sessionBar: {
    background: 'var(--tn-surface, #1e2030)',
    border: '1px solid var(--tn-green, #9ece6a)',
    borderRadius: '4px', padding: '7px 10px', fontSize: '11px', marginBottom: '8px',
  },
  chatBox: {
    display: 'flex', flexDirection: 'column' as const, gap: '6px',
    flex: 1, minHeight: '80px', overflowY: 'auto' as const,
    overscrollBehavior: 'contain' as const,
    border: '1px solid var(--tn-border, rgba(255,255,255,0.1))',
    borderRadius: '4px', padding: '8px',
    background: 'var(--tn-surface, #1e2030)',
  },
  msgUser: {
    alignSelf: 'flex-end' as const, background: 'var(--tn-purple, #bb9af7)',
    color: '#1a1b26', borderRadius: '6px 6px 2px 6px', padding: '5px 9px',
    maxWidth: '85%', fontSize: '12px', whiteSpace: 'pre-wrap' as const, wordBreak: 'break-word' as const,
  },
  msgAssistant: {
    alignSelf: 'flex-start' as const,
    background: 'var(--tn-surface2, rgba(255,255,255,0.07))',
    color: 'var(--tn-text)', borderRadius: '6px 6px 6px 2px', padding: '5px 9px',
    maxWidth: '92%', fontSize: '12px', wordBreak: 'break-word' as const,
  },
  chatInputRow: { display: 'flex', gap: '5px', marginTop: '5px' },
  chatInput: {
    flex: 1, background: 'var(--tn-surface, #1e2030)',
    border: '1px solid var(--tn-border, rgba(255,255,255,0.15))',
    borderRadius: '4px', color: 'var(--tn-text)',
    fontFamily: 'monospace', fontSize: '12px', padding: '5px 8px',
  } as React.CSSProperties,
  diffCard: {
    border: '1px solid var(--tn-border, rgba(255,255,255,0.1))',
    borderRadius: '5px', overflow: 'hidden', marginBottom: '8px',
  },
  diffHead: {
    display: 'flex', alignItems: 'center', gap: '6px',
    padding: '6px 8px', background: 'var(--tn-surface2, rgba(255,255,255,0.05))',
    fontSize: '11px', fontWeight: 600,
  },
  diffBlock: (type: 'old' | 'new') => ({
    background: type === 'old' ? 'rgba(247,118,142,0.07)' : 'rgba(158,206,106,0.07)',
    borderTop: `1px solid ${type === 'old' ? 'rgba(247,118,142,0.18)' : 'rgba(158,206,106,0.18)'}`,
    padding: '5px 8px', fontSize: '11px', fontFamily: 'monospace' as const,
    whiteSpace: 'pre-wrap' as const, wordBreak: 'break-word' as const,
    color: type === 'old' ? 'var(--tn-red, #f7768e)' : 'var(--tn-green, #9ece6a)',
  }),
  diffLabel: { fontSize: '9px', textTransform: 'uppercase' as const, letterSpacing: '0.08em', opacity: 0.6, marginBottom: '2px' },
};

// --- FileTree sub-component ---

interface FileTreeProps {
  nodes: TreeNode[];
  selected: Set<string>;
  onToggle: (path: string, tokens: number) => void;
  onPreview?: (path: string) => void;
  previewPath?: string | null;
  depth?: number;
}

function FileTree({ nodes, selected, onToggle, onPreview, previewPath, depth = 0 }: FileTreeProps) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const pl = depth * 12;

  return (
    <>
      {nodes.map(node => {
        if (node.type === 'dir') {
          const isOpen = open[node.path] ?? false;
          // Count selected children
          const selCount = countSelectedInTree(node.children, selected);
          return (
            <div key={node.path}>
              <div style={{ ...S.treeDir, paddingLeft: `${pl}px` }}
                   onClick={() => setOpen(prev => ({ ...prev, [node.path]: !isOpen }))}>
                <span style={{ fontSize: '10px', width: '10px' }}>{isOpen ? '▾' : '▸'}</span>
                <span style={{ flex: 1 }}>{node.name}/</span>
                {selCount > 0 && (
                  <span style={{ ...S.badge(), color: 'var(--tn-purple,#bb9af7)', marginRight: '4px' }}>
                    {selCount}✓
                  </span>
                )}
                <span style={S.treeTokens}>{formatTokens(node.totalTokens)}</span>
              </div>
              {isOpen && (
                <FileTree nodes={node.children} selected={selected} onToggle={onToggle} onPreview={onPreview} previewPath={previewPath} depth={depth + 1} />
              )}
            </div>
          );
        }

        // File
        const isChecked = node.is_kern || selected.has(node.path);
        const isPreviewing = previewPath === node.path;
        return (
          <div key={node.path} style={{ paddingLeft: `${pl + 2}px` }}>
            <div style={{ ...S.treeFile(isChecked, node.is_kern), background: isPreviewing ? 'rgba(122,162,247,0.1)' : undefined }}>
              <div style={S.checkbox(isChecked, node.is_kern)} onClick={() => !node.is_kern && onToggle(node.path, node.tokens)}>
                {isChecked && '✓'}
              </div>
              <span
                style={{ ...S.treeFileName, cursor: 'pointer' }}
                title={node.path}
                onClick={() => !node.is_kern && onToggle(node.path, node.tokens)}
              >{node.name}</span>
              {node.is_kern && <span style={S.kernBadge}>KERN</span>}
              <span style={S.treeTokens}>{formatTokens(node.tokens)}</span>
              {onPreview && (
                <span
                  style={{ fontSize: '10px', cursor: 'pointer', opacity: isPreviewing ? 1 : 0.4, color: isPreviewing ? 'var(--tn-blue,#7aa2f7)' : undefined, flexShrink: 0, padding: '0 2px' }}
                  title="Vorschau"
                  onClick={e => { e.stopPropagation(); onPreview(node.path); }}
                >👁</span>
              )}
            </div>
          </div>
        );
      })}
    </>
  );
}

// --- Main Panel ---

export default function BusinessAngelPanel() {
  // Context overview (kern + temp)
  const [ctx, setCtx] = useState<ContextData | null>(null);
  const [ctxLoading, setCtxLoading] = useState(true);
  const [ctxError, setCtxError] = useState('');

  // File tree for extra file selection
  const [fileTree, setFileTree] = useState<TreeNode[]>([]);
  const [treeLoading, setTreeLoading] = useState(true);
  const [treeOpen, setTreeOpen] = useState(false);

  // Section open states
  const [kernOpen, setKernOpen] = useState(false);
  const [tempOpen, setTempOpen] = useState(false);
  const [diaryOpen, setDiaryOpen] = useState(false);
  const [contextCollapsed, setContextCollapsed] = useState(false);
  const [diffsCollapsed, setDiffsCollapsed] = useState(false);
  const [chatOnly, setChatOnly] = useState(false);

  // Selected extra files
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [selectedTokens, setSelectedTokens] = useState(0);
  // Files already sent to the AI (via /load at session start OR prepended to a previous chat message).
  // Difference to selectedFiles = pending files that will be injected on next send.
  const [committedFiles, setCommittedFiles] = useState<Set<string>>(new Set());

  // File preview
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [previewContent, setPreviewContent] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewMeta, setPreviewMeta] = useState<{ totalLines: number; size: number } | null>(null);

  // Session
  const [starting, setStarting] = useState(false);
  const [session, setSession] = useState<LoadResult | null>(null);
  const [startError, setStartError] = useState('');
  const [activeSessionInfo, setActiveSessionInfo] = useState<{ session_id: string; created_at: number; conversation_turns: number; in_memory: boolean } | null>(null);

  // Session list
  const [sessionList, setSessionList] = useState<SessionListItem[]>([]);
  const [sessionListOpen, setSessionListOpen] = useState(false);
  const [sessionListLoading, setSessionListLoading] = useState(false);
  const [loadingSessionId, setLoadingSessionId] = useState<string | null>(null);

  // Chat
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatSending, setChatSending] = useState(false);
  const [chatError, setChatError] = useState('');
  const chatEndRef = useRef<HTMLDivElement>(null);

  // File watcher — external changes during session
  const [changedFiles, setChangedFiles] = useState<string[]>([]);
  const watcherRef = useRef<EventSource | null>(null);

  // File content cache for full-file diff view
  const [fileContents, setFileContents] = useState<Record<string, string>>({});
  const fetchFileContent = useCallback(async (filePath: string) => {
    // Re-fetch if empty string (may be stale from previous bug)
    if (fileContents[filePath] !== undefined && fileContents[filePath] !== '') return;
    try {
      const r = await fetch(`/api/business-angel/file-preview?path=${encodeURIComponent(filePath)}`);
      if (!r.ok) return;
      const data = await r.json();
      setFileContents(prev => ({ ...prev, [filePath]: data.preview ?? data.content ?? '' }));
    } catch { /* ignore */ }
  }, [fileContents]);

  // Snapshot cache — immutable baseline for diff comparison
  const [snapshotFiles, setSnapshotFiles] = useState<Record<string, string>>({});
  const [snapshotLoaded, setSnapshotLoaded] = useState(false);

  const fetchSnapshot = useCallback(async (sessionId: string) => {
    try {
      const r = await fetch(`/api/business-angel/snapshot?session_id=${encodeURIComponent(sessionId)}`);
      if (!r.ok) {
        console.warn('[BusinessAngel] No snapshot found');
        setSnapshotLoaded(true);
        return;
      }
      const data = await r.json();
      const validated = validateApiResponse<{ files: Record<string, string> }>(data, '/api/business-angel/snapshot', { files: 'object' });
      setSnapshotFiles(validated.files);
      setSnapshotLoaded(true);
      console.log(`[BusinessAngel] Snapshot loaded: ${Object.keys(validated.files).length} files`);
    } catch {
      setSnapshotLoaded(true);
    }
  }, []);

  // --- Load data ---

  const fetchContext = useCallback(async () => {
    setCtxLoading(true);
    setCtxError('');
    try {
      const resp = await fetch('/api/business-angel/context');
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      setCtx(await resp.json());
    } catch (e: unknown) {
      setCtxError(e instanceof Error ? e.message : String(e));
    } finally {
      setCtxLoading(false);
    }
  }, []);

  const fetchFileTree = useCallback(async () => {
    setTreeLoading(true);
    try {
      const resp = await fetch('/api/business-angel/files');
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const raw = await resp.json();
      const data = validateApiResponse<{ tree: TreeNode[] }>(raw, '/api/business-angel/files', { tree: 'array' });
      setFileTree(data.tree);
    } catch {
      // non-critical — tree just stays empty
    } finally {
      setTreeLoading(false);
    }
  }, []);

  useEffect(() => { fetchContext(); fetchFileTree(); }, [fetchContext, fetchFileTree]);

  // Check for persisted active session on mount — auto-restore immediately
  useEffect(() => {
    fetch('/api/business-angel/session/active')
      .then(r => r.json())
      .then(d => { if (d.active) startSession(true); })
      .catch(() => {}); // silent-ok: active session check on mount is best-effort
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [chatMessages]);

  // Open SSE file-watcher when session starts; close when session ends
  useEffect(() => {
    if (!session?.session_id) {
      watcherRef.current?.close();
      watcherRef.current = null;
      setChangedFiles([]);
      return;
    }
    const es = new EventSource(`/api/business-angel/file-watch?session_id=${encodeURIComponent(session.session_id)}`);
    es.onmessage = (ev) => {
      try {
        const { file, event } = JSON.parse(ev.data) as { file: string; event: string };
        if (event !== 'change' && event !== 'add') return;
        // Invalidate disk-content cache so VORHER picks up the external change
        setFileContents(prev => { const n = { ...prev }; delete n[file]; return n; });
        setChangedFiles(prev => prev.includes(file) ? prev : [...prev, file]);
      } catch { /* ignore malformed */ }
    };
    watcherRef.current = es;
    return () => { es.close(); watcherRef.current = null; };
  }, [session?.session_id]);

  const openPreview = useCallback(async (path: string) => {
    if (previewPath === path) { setPreviewPath(null); setPreviewContent(''); setPreviewMeta(null); return; }
    setPreviewPath(path); setPreviewLoading(true); setPreviewContent(''); setPreviewMeta(null);
    try {
      const resp = await fetch(`/api/business-angel/file-preview?path=${encodeURIComponent(path)}`);
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Preview failed');
      setPreviewContent(data.preview || '');
      setPreviewMeta({ totalLines: data.totalLines, size: data.size });
    } catch { setPreviewContent('Fehler beim Laden.'); }
    finally { setPreviewLoading(false); }
  }, [previewPath]);

  // --- Selection ---

  const toggleFile = (path: string, tokens: number) => {
    setSelectedFiles(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
        setSelectedTokens(t => t - tokens);
      } else {
        next.add(path);
        setSelectedTokens(t => t + tokens);
      }
      return next;
    });
  };

  const totalTokens = (ctx?.kern_tokens ?? 0) + (ctx?.temp_tokens ?? 0) + (ctx?.tagebuch?.total_tokens ?? 0) + selectedTokens;

  // --- Session ---

  const startSession = async (restore = false) => {
    setStarting(true);
    setStartError('');
    try {
      const resp = await fetch('/api/business-angel/load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ extra_files: [...selectedFiles], restore }),
      });
      const raw = await resp.json();
      if (!resp.ok) throw new Error(raw.error || `HTTP ${resp.status}`);
      const data = validateApiResponse<LoadResult>(raw, '/api/business-angel/load', {
        session_id: 'string',
        token_count: 'number',
        files_loaded: 'number',
      });
      setSession(data);
      setCommittedFiles(new Set(selectedFiles));
      setContextCollapsed(true);
      setActiveSessionInfo(null);
      // Load snapshot for diff baseline
      fetchSnapshot(data.session_id);
      const excluded: string[] = data.excluded ?? [];
      const excludedNote = excluded.length > 0
        ? `\n\n⚠️ Nicht geladen (Budget): ${excluded.map((f: string) => f.split('/').pop()).join(', ')}`
        : '';
      if (restore && data.conversation && data.conversation.length > 0) {
        // Restore actual conversation history + show reload notice at bottom
        const restoredMessages = [
          ...data.conversation,
          {
            role: 'assistant' as const,
            content: `_(Dokumente neu geladen · ${data.files_loaded} Dateien · ~${Math.round(data.token_count / 1000)}k Tokens${excludedNote})_`,
          },
        ];
        setChatMessages(restoredMessages);
      } else {
        const initialContent = data.ack_message
          ?? `Dokumente geladen (${data.files_loaded} Dateien, ~${Math.round(data.token_count / 1000)}k Tokens).${excludedNote}\n\nIch bin dein strategischer Berater und arbeite ausschließlich mit diesen Quellen. Was brauchst du?`;
        setChatMessages([{ role: 'assistant', content: initialContent }]);
      }
    } catch (e: unknown) {
      setStartError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  };

  const endSession = async () => {
    await fetch('/api/business-angel/session/end', { method: 'POST' }).catch(() => {}); // silent-ok: session end notification is best-effort; state cleared immediately
    setSession(null);
    setChatMessages([]);
    setActiveSessionInfo(null);
    setSnapshotFiles({});
    setSnapshotLoaded(false);
    setCommittedFiles(new Set());
  };

  // --- Session Management ---

  const fetchSessionList = async () => {
    setSessionListLoading(true);
    try {
      const resp = await fetch('/api/business-angel/sessions');
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const raw = await resp.json();
      const data = validateApiResponse<{ sessions: SessionListItem[] }>(raw, '/api/business-angel/sessions', { sessions: 'array' });
      setSessionList(data.sessions);
    } catch {
      setSessionList([]);
    } finally {
      setSessionListLoading(false);
    }
  };

  const newSession = async () => {
    setStarting(true);
    setStartError('');
    try {
      // Archive current session + clear
      await fetch('/api/business-angel/session/new', { method: 'POST' });
      setSession(null);
      setChatMessages([]);
      setActiveSessionInfo(null);
      setContextCollapsed(false);
      setCommittedFiles(new Set());
      // Start fresh session with currently selected files
      await startSession(false);
    } catch (e: unknown) {
      setStartError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  };

  const loadArchivedSession = async (sessionId: string) => {
    setLoadingSessionId(sessionId);
    try {
      const resp = await fetch(`/api/business-angel/session/load/${sessionId}`, { method: 'POST' });
      if (!resp.ok) {
        const data = await resp.json();
        throw new Error(data.error || `HTTP ${resp.status}`);
      }
      // Now restore via /load with restore=true (re-injects context + loads conversation)
      await startSession(true);
      setSessionListOpen(false);
    } catch (e: unknown) {
      setStartError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingSessionId(null);
    }
  };

  // --- Chat ---

  // Strip prefixes we added for the AI (diff_status, new_context) when displaying
  // user messages — Rafael doesn't want to see those in the chat feed.
  const stripInvisibleTags = (text: string): string => {
    return text
      .replace(/<diff_status>[\s\S]*?<\/diff_status>\s*/g, '')
      .replace(/<new_context[^>]*>[\s\S]*?<\/new_context>\s*/g, '')
      .replace(/^\s+/, '');
  };

  // Build a prefix for the next outgoing message that tells the AI:
  //   1) which of the previously-proposed diffs Rafael applied/skipped/left pending
  //   2) which newly-selected context files to ingest (mid-session file injection)
  // Both blocks are invisible in the UI (stripped from display) but persisted in history.
  const buildMessagePrefix = async (): Promise<string> => {
    // Pending file injection happens via /sync-context (separate turn) before send — see sendMessage.
    return '';
  };

  // Sync new/changed files into the conversation as a separate turn (not into the immutable
  // first context_message). Backend computes diff against session manifest. Returns whether
  // anything was synced.
  const syncContext = async (extra: string[]): Promise<boolean> => {
    if (!session) return false;
    try {
      const resp = await fetch('/api/business-angel/sync-context', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: session.session_id, extra_files: extra }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      if (data.no_changes) {
        setChatError('Keine Änderungen seit Session-Start');
        setTimeout(() => setChatError(''), 3000);
        return false;
      }
      setChatMessages(prev => [...prev, ...(data.messages ?? [])]);
      setCommittedFiles(new Set(selectedFiles));
      return true;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setChatError(`Sync fehlgeschlagen: ${msg}`);
      return false;
    }
  };

  const sendMessage = async () => {
    if (!chatInput.trim() || !session || chatSending) return;
    const userMsg = chatInput.trim();
    setChatInput('');
    setChatSending(true);
    setChatError('');
    const pendingFiles = [...selectedFiles].filter(f => !committedFiles.has(f));
    if (pendingFiles.length > 0) {
      await syncContext(pendingFiles);
    }
    // Assistant msg will be appended after the user msg — predict its index now
    // so we can tie any diffs to the correct message.
    const assistantIdx = chatMessages.length + 1 + (pendingFiles.length > 0 ? 2 : 0);
    setChatMessages(prev => [...prev, { role: 'user', content: userMsg }]);
    try {
      const prefix = await buildMessagePrefix();
      const wireMsg = prefix + userMsg;
      const resp = await fetch('/api/business-angel/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: session.session_id, message: wireMsg }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      setChatMessages(prev => [...prev, { role: 'assistant', content: data.response }]);
      setCommittedFiles(new Set(selectedFiles));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      // Session expired (server restart) — clear session so user can reload
      if (msg.includes('Session not found') || msg.includes('404')) {
        setSession(null);
        setChatMessages([]);
        setChatError('Session abgelaufen (Server-Neustart). Bitte Session neu laden.');
      } else {
        setChatError(msg);
      }
    } finally {
      setChatSending(false);
    }
  };


  // --- Render ---

  const mdStyles = `
    .ba-md-preview h1,.ba-md-preview h2,.ba-md-preview h3{color:#bb9af7;margin:.6em 0 .3em;font-size:13px}
    .ba-md-preview h1{font-size:15px}.ba-md-preview h2{font-size:13px}
    .ba-md-preview p{margin:.3em 0}.ba-md-preview code{background:rgba(255,255,255,0.08);padding:1px 4px;border-radius:3px;font-size:10px}
    .ba-md-preview pre{background:rgba(255,255,255,0.05);padding:8px;border-radius:4px;overflow-x:auto;font-size:10px;margin:.4em 0}
    .ba-md-preview pre code{background:none;padding:0}
    .ba-md-preview table{border-collapse:collapse;width:100%;font-size:11px;margin:.4em 0}
    .ba-md-preview th,.ba-md-preview td{border:1px solid rgba(255,255,255,0.12);padding:3px 6px}
    .ba-md-preview th{background:rgba(187,154,247,0.12)}
    .ba-md-preview blockquote{border-left:3px solid rgba(187,154,247,0.4);margin:.3em 0;padding:.2em .6em;color:var(--tn-text-muted)}
    .ba-md-preview a{color:#7aa2f7}.ba-md-preview ul,.ba-md-preview ol{padding-left:1.4em;margin:.3em 0}
    .ba-md-preview li{margin:.1em 0}
  `;

  function renderPreviewContent() {
    if (previewLoading) return <div style={{ color: 'var(--tn-text-muted)', fontSize: 11, padding: '12px 0' }}>Lade Vorschau…</div>;
    if (!previewContent) return null;
    const ext = previewPath?.split('.').pop()?.toLowerCase() || '';
    if (ext === 'md') return (
      <>
        <style>{mdStyles}</style>
        <div className="ba-md-preview" style={{ fontSize: 12, lineHeight: 1.6, color: '#c0caf5', wordBreak: 'break-word' as const }}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{previewContent}</ReactMarkdown>
        </div>
      </>
    );
    if (ext === 'html') return (
      <iframe srcDoc={previewContent} style={{ width: '100%', minHeight: 300, border: 'none', borderRadius: 4, background: '#fff' }} sandbox="allow-same-origin" title="Preview" />
    );
    return <div style={{ fontFamily: 'monospace', fontSize: 10, lineHeight: 1.6, color: '#c0caf5', whiteSpace: 'pre-wrap' as const, wordBreak: 'break-word' as const }}>{previewContent}</div>;
  }


  if (ctxLoading) return (
    <div style={{ ...S.root, padding: '20px', alignItems: 'center', justifyContent: 'center' }}>
      <span style={{ color: 'var(--tn-text-muted)' }}>Lade…</span>
    </div>
  );

  if (ctxError) return (
    <div style={{ ...S.root, padding: '20px' }}>
      <div style={S.errMsg}>Fehler: {ctxError}</div>
      <button style={{ ...S.btn, ...S.btnGhost, marginTop: '8px' }} onClick={fetchContext}>Retry</button>
    </div>
  );

  return (
    <div style={S.root}>

      {/* ── Header ── */}
      <div style={S.header}>
        <h2 style={S.h2}>🤝 Business Angel</h2>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '4px', alignItems: 'center' }}>
          {session && (() => {
            const pendingFiles = [...selectedFiles].filter(f => !committedFiles.has(f));
            if (pendingFiles.length === 0) return null;
            return (
              <span
                onClick={() => { syncContext(pendingFiles); }}
                style={{ fontSize: '10px', color: 'var(--tn-cyan,#7dcfff)', padding: '2px 8px', borderRadius: '4px', background: 'rgba(125,207,255,0.12)', border: '1px dashed rgba(125,207,255,0.45)', cursor: 'pointer', fontWeight: 600 }}
                title="Klick: Auswahl jetzt in den Chat einfügen (separater Turn — Original-Kontext bleibt unverändert)"
              >
                📎 {pendingFiles.length} sync
              </span>
            );
          })()}
          {session && (
            <button
              style={{ ...S.btn, ...S.btnGhost, padding: '3px 7px', fontSize: '11px' }}
              onClick={() => syncContext([])}
              title="Stand abgleichen — checkt yaml + Filesystem auf Änderungen seit Session-Start und schickt nur das Delta in den Chat"
            >
              🔄
            </button>
          )}
          {session && changedFiles.length > 0 && (
            <span
              onClick={() => setChangedFiles([])}
              title={`Geändert: ${changedFiles.join(', ')} — klicken zum Schließen`}
              style={{ fontSize: '10px', color: 'var(--tn-yellow,#e0af68)', padding: '2px 8px', borderRadius: '4px', background: 'rgba(224,175,104,0.12)', border: '1px solid rgba(224,175,104,0.35)', cursor: 'pointer', flexShrink: 0 }}
            >
              ⚠ {changedFiles.length} extern geändert
            </span>
          )}
          {session && (
            <button
              style={{
                ...S.btn,
                padding: '3px 8px', fontSize: '10px', borderRadius: '10px',
                background: chatOnly ? 'var(--tn-purple, #bb9af7)' : 'transparent',
                color: chatOnly ? '#1a1b26' : 'var(--tn-text-muted)',
                border: chatOnly ? 'none' : '1px solid var(--tn-border, rgba(255,255,255,0.15))',
                fontWeight: 600,
              }}
              onClick={() => setChatOnly(v => !v)}
              title={chatOnly ? 'Kontext & Diffs anzeigen' : 'Nur Chat anzeigen'}
            >
              {chatOnly ? '◧ Voll' : '☷ Chat'}
            </button>
          )}
<span style={{ fontSize: '13px', fontWeight: 700, color: tokenColor(totalTokens) }}>
            {formatTokens(totalTokens)} tokens
          </span>
          <button style={{ ...S.btn, ...S.btnGhost, padding: '3px 7px', fontSize: '11px' }} onClick={() => { fetchContext(); fetchFileTree(); }}>↻</button>
          {session && (
            <button
              style={{
                ...S.btn,
                padding: '3px 10px', fontSize: '14px', borderRadius: '6px',
                background: 'var(--tn-green, #9ece6a)',
                color: '#1a1b26',
                border: 'none',
                fontWeight: 700,
                marginLeft: '4px',
              }}
              onClick={newSession}
              title="Neue Session starten"
              disabled={starting}
            >＋</button>
          )}
        </div>
      </div>

      <div style={S.body}>

        {/* ── Kontext-Bereich (collapsible) ── */}
        {!chatOnly && <div style={{ flexShrink: 0 }}>
          {session && (
            <div
              style={{
                display: 'flex', alignItems: 'center', gap: '6px',
                padding: '5px 10px', marginBottom: '6px',
                background: contextCollapsed ? 'var(--tn-surface, #1e2030)' : 'rgba(122,162,247,0.06)',
                border: '1px solid var(--tn-border, rgba(255,255,255,0.08))',
                borderRadius: '4px', cursor: 'pointer', userSelect: 'none' as const,
                fontSize: '11px', fontWeight: 600,
              }}
              onClick={() => setContextCollapsed(v => !v)}
            >
              <span style={{ fontSize: '10px', transition: 'transform 0.15s', transform: contextCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}>▾</span>
              <span>Kontext</span>
              <span style={S.badge(tokenColor(totalTokens))}>{formatTokens(totalTokens)}</span>
              {contextCollapsed && selectedFiles.size > 0 && (
                <span style={S.badge('var(--tn-purple,#bb9af7)')}>+{selectedFiles.size} Dateien</span>
              )}
              {contextCollapsed && (
                <span style={{ marginLeft: 'auto', fontSize: '10px', color: 'var(--tn-text-muted)' }}>aufklappen</span>
              )}
            </div>
          )}
        {!contextCollapsed && (<>
        {/* ── Kern-Kontext ── */}
        <div style={S.section}>
          <div style={S.secLabel} onClick={() => setKernOpen(v => !v)}>
            <span style={{ fontSize: '9px', width: '10px' }}>{kernOpen ? '▾' : '▸'}</span>
            Kern-Kontext (immer geladen)
            <span style={S.badge(tokenColor(ctx?.kern_tokens ?? 0))}>
              {(ctx?.kern_files ?? []).filter(f => f.exists).length}/{(ctx?.kern_files ?? []).length} · {formatTokens(ctx?.kern_tokens ?? 0)}
            </span>
          </div>
          {kernOpen && (
            <div style={{ paddingLeft: '10px' }}>
              {(ctx?.kern_files ?? []).map(f => (
                <div key={f.path} style={{ display: 'flex', alignItems: 'center', gap: '5px', padding: '1px 0', background: previewPath === f.path ? 'rgba(122,162,247,0.08)' : undefined, borderRadius: '3px' }}>
                  <span style={{ fontSize: '9px', color: f.exists ? 'var(--tn-green,#9ece6a)' : 'var(--tn-red,#f7768e)' }}>●</span>
                  <span style={{ flex: 1, fontSize: '11px', color: 'var(--tn-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }} title={f.path}>
                    {f.path.split('/').pop()}
                  </span>
                  {f.exists && <span style={S.treeTokens}>{formatTokens(f.tokens)}</span>}
                  {f.exists && <span style={{ fontSize: '10px', cursor: 'pointer', opacity: previewPath === f.path ? 1 : 0.35, color: previewPath === f.path ? 'var(--tn-blue,#7aa2f7)' : undefined }} onClick={() => openPreview(f.path)}>👁</span>}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Temp-Ordner ── */}
        <div style={S.section}>
          <div style={S.secLabel} onClick={() => setTempOpen(v => !v)}>
            <span style={{ fontSize: '9px', width: '10px' }}>{tempOpen ? '▾' : '▸'}</span>
            Temp-Ordner
            <span style={S.badge((ctx?.temp_files?.length ?? 0) > 0 ? 'var(--tn-cyan,#7dcfff)' : undefined)}>
              {(ctx?.temp_files ?? []).length} Dateien · {formatTokens(ctx?.temp_tokens ?? 0)}
            </span>
          </div>
          {tempOpen && (
            <div style={{ paddingLeft: '10px' }}>
              {(ctx?.temp_files ?? []).length === 0
                ? <div style={{ fontSize: '11px', color: 'var(--tn-text-muted)', padding: '2px 0' }}>Leer</div>
                : (ctx?.temp_files ?? []).map(f => {
                  const tempPath = `temp/${f.name}`;
                  const isPrev = previewPath === f.name || previewPath === tempPath;
                  return (
                    <div key={f.name} style={{ display: 'flex', gap: '5px', padding: '1px 0', fontSize: '11px', alignItems: 'center', background: isPrev ? 'rgba(122,162,247,0.08)' : undefined, borderRadius: '3px' }}>
                      <span style={{ color: 'var(--tn-cyan,#7dcfff)' }}>●</span>
                      <span style={{ flex: 1 }}>{f.name}</span>
                      <span style={S.treeTokens}>{formatTokens(f.tokens)}</span>
                      <span style={{ fontSize: '10px', cursor: 'pointer', opacity: isPrev ? 1 : 0.35, color: isPrev ? 'var(--tn-blue,#7aa2f7)' : undefined }} onClick={() => openPreview(f.name)}>👁</span>
                    </div>
                  );
                })
              }
            </div>
          )}
        </div>

        {/* ── Tagebuch (Verlauf) ── */}
        <div style={S.section}>
          <div style={S.secLabel} onClick={() => setDiaryOpen(v => !v)}>
            <span style={{ fontSize: '9px', width: '10px' }}>{diaryOpen ? '▾' : '▸'}</span>
            Tagebuch (Verlauf)
            <span style={S.badge((ctx?.tagebuch?.total_tokens ?? 0) > 0 ? 'var(--tn-green,#9ece6a)' : undefined)}>
              {ctx?.tagebuch
                ? `${ctx.tagebuch.daily_count}d · ${ctx.tagebuch.weekly_count}w · ${ctx.tagebuch.monthly_count}m · ${formatTokens(ctx.tagebuch.total_tokens)}`
                : '—'}
            </span>
          </div>
          {diaryOpen && (
            <div style={{ paddingLeft: '10px', fontSize: '11px', color: 'var(--tn-text-muted)' }}>
              {!ctx?.tagebuch ? (
                <div style={{ padding: '2px 0' }}>Keine Konfiguration gefunden.</div>
              ) : ctx.tagebuch.daily_count + ctx.tagebuch.weekly_count + ctx.tagebuch.monthly_count === 0 ? (
                <div style={{ padding: '2px 0' }}>
                  Noch keine Einträge in {ctx.tagebuch.base_dir}.
                  Erzeuge welche mit einer Claude Code Session: "neuer Tagebuch-Eintrag".
                </div>
              ) : (
                <>
                  <div style={{ padding: '1px 0' }}>
                    Pyramide: 0–{ctx.tagebuch.config.daily_days}T täglich, {ctx.tagebuch.config.daily_days}–{ctx.tagebuch.config.weekly_days}T wöchentlich, älter monatlich
                  </div>
                  {ctx.tagebuch.latest_daily && (
                    <div style={{ padding: '1px 0' }}>
                      Letzter Daily-Eintrag: <span style={{ color: 'var(--tn-text)' }}>{ctx.tagebuch.latest_daily}</span>
                    </div>
                  )}
                  <div style={{ padding: '1px 0' }}>
                    Daily: {ctx.tagebuch.daily_count} · Weekly: {ctx.tagebuch.weekly_count} · Monthly: {ctx.tagebuch.monthly_count}
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {/* ── File Tree (Zusatz-Auswahl) ── */}
        <div style={S.section}>
          <div style={S.secLabel} onClick={() => setTreeOpen(v => !v)}>
            <span style={{ fontSize: '9px', width: '10px' }}>{treeOpen ? '▾' : '▸'}</span>
            Zusatz-Dateien
            {selectedFiles.size > 0 && (
              <span style={S.badge('var(--tn-purple,#bb9af7)')}>
                {selectedFiles.size} gewählt · {formatTokens(selectedTokens)}
              </span>
            )}
            {selectedFiles.size === 0 && (
              <span style={S.badge()}>Klicken zum Auswählen</span>
            )}
          </div>
          {treeOpen && (
            <div style={{
              border: '1px solid var(--tn-border, rgba(255,255,255,0.08))',
              borderRadius: '4px', padding: '6px 8px',
              background: 'var(--tn-surface, #1e2030)',
              maxHeight: '280px', overflowY: 'auto' as const,
            }}>
              {treeLoading ? (
                <div style={{ fontSize: '11px', color: 'var(--tn-text-muted)', padding: '8px 0' }}>Lade Dateibaum…</div>
              ) : (
                <FileTree nodes={fileTree} selected={selectedFiles} onToggle={toggleFile} onPreview={openPreview} previewPath={previewPath} />
              )}
            </div>
          )}
          {selectedFiles.size > 0 && (
            <div style={{ display: 'flex', gap: '6px', marginTop: '4px', flexWrap: 'wrap' as const }}>
              {[...selectedFiles].map(p => {
                const isPending = session !== null && !committedFiles.has(p);
                return (
                  <span
                    key={p}
                    onClick={() => {
                      // find tokens for this path in tree
                      const findTokens = (nodes: TreeNode[]): number => {
                        for (const n of nodes) {
                          if (n.type === 'file' && n.path === p) return n.tokens;
                          if (n.type === 'dir') { const t = findTokens(n.children); if (t > 0) return t; }
                        }
                        return 0;
                      };
                      toggleFile(p, findTokens(fileTree));
                    }}
                    style={{
                      fontSize: '10px', padding: '2px 7px', borderRadius: '10px',
                      background: isPending ? 'rgba(125,207,255,0.16)' : 'rgba(187,154,247,0.12)',
                      color: isPending ? 'var(--tn-cyan,#7dcfff)' : 'var(--tn-purple,#bb9af7)',
                      border: isPending ? '1px dashed rgba(125,207,255,0.45)' : '1px solid transparent',
                      cursor: 'pointer',
                    }}
                    title={isPending ? `NEU — wird mit nächster Nachricht gesendet: ${p}` : `Klicken zum Entfernen: ${p}`}
                  >
                    {isPending && <span style={{ marginRight: '3px', fontSize: '9px', fontWeight: 700 }}>NEU</span>}
                    {p.split('/').pop()} ✕
                  </span>
                );
              })}
            </div>
          )}
        </div>

        {/* ── File Preview ── */}
        {previewPath && (
          <div style={{ ...S.section, border: '1px solid var(--tn-border,rgba(255,255,255,0.1))', borderRadius: '5px', overflow: 'hidden' }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: '6px',
              padding: '6px 10px', background: 'var(--tn-surface2,rgba(255,255,255,0.05))',
              fontSize: '11px', fontWeight: 600,
            }}>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, color: 'var(--tn-blue,#7aa2f7)' }}>
                {previewPath.split('/').pop()}
              </span>
              {previewMeta && (
                <span style={{ color: 'var(--tn-text-muted)', fontSize: '10px', flexShrink: 0 }}>
                  {previewMeta.totalLines} Zeilen · {(previewMeta.size / 1024).toFixed(1)}KB
                </span>
              )}
              <span style={{ cursor: 'pointer', color: 'var(--tn-text-muted)', fontSize: '12px' }} onClick={() => { setPreviewPath(null); setPreviewContent(''); }}>✕</span>
            </div>
            <div style={{ padding: '8px 10px', maxHeight: '320px', overflowY: 'auto' as const, background: 'var(--tn-surface,#1e2030)' }}>
              {renderPreviewContent()}
            </div>
          </div>
        )}

        {/* ── Session starten ── */}
        <div style={S.section}>
          {!session ? (
            <>
              <div style={{ display: 'flex', gap: '6px' }}>
                <button
                  style={{ ...S.btn, ...S.btnPrimary, flex: 1, opacity: starting ? 0.6 : 1 }}
                  onClick={() => startSession(false)}
                  disabled={starting}
                >
                  {starting ? 'Lade…' : `Session starten · ${formatTokens(totalTokens)}`}
                </button>
                <button
                  style={{ ...S.btn, ...S.btnGhost, padding: '4px 10px', fontSize: '11px' }}
                  onClick={() => { setSessionListOpen(v => !v); if (!sessionListOpen) fetchSessionList(); }}
                  title="Frühere Sessions anzeigen"
                >
                  📋
                </button>
              </div>
              {startError && <div style={S.errMsg}>{startError}</div>}

              {/* Session list dropdown */}
              {sessionListOpen && (
                <div style={{
                  marginTop: '6px', border: '1px solid var(--tn-border, rgba(255,255,255,0.1))',
                  borderRadius: '4px', background: 'var(--tn-surface, #1e2030)',
                  maxHeight: '200px', overflowY: 'auto' as const,
                }}>
                  <div style={{ padding: '5px 8px', fontSize: '10px', fontWeight: 600, color: 'var(--tn-text-muted)', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                    Frühere Sessions {sessionListLoading && '…'}
                  </div>
                  {sessionList.length === 0 && !sessionListLoading && (
                    <div style={{ padding: '8px', fontSize: '11px', color: 'var(--tn-text-muted)', textAlign: 'center' as const }}>Keine archivierten Sessions</div>
                  )}
                  {sessionList.map(s => (
                    <div
                      key={s.id}
                      style={{
                        padding: '5px 8px', cursor: loadingSessionId ? 'default' : 'pointer',
                        borderBottom: '1px solid rgba(255,255,255,0.04)',
                        opacity: loadingSessionId === (s.id) ? 0.6 : 1,
                        background: loadingSessionId === (s.id) ? 'rgba(187,154,247,0.08)' : undefined,
                      }}
                      onClick={() => { if (!loadingSessionId) loadArchivedSession(s.id); }}
                    >
                      <div style={{ fontSize: '11px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
                        {loadingSessionId === (s.id) ? 'Lade…' : (s.title ?? '')}
                      </div>
                      <div style={{ fontSize: '9px', color: 'var(--tn-text-muted)', marginTop: '1px' }}>
                        {new Date(s.created_at).toLocaleDateString('de-DE')} · {s.turns ?? 0} Nachrichten
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
              <div style={S.sessionBar}>
                <div style={{ color: 'var(--tn-green,#9ece6a)' }}>● Session aktiv — {session.files_loaded} Dateien · {formatTokens(session.token_count)}</div>
                <div style={{ color: 'var(--tn-text-muted)', fontSize: '10px', marginTop: '2px' }}>
                  {(session.session_id).slice(0, 8)}…
                  {(session.temp_files?.length ?? 0) > 0 && ` · Temp: ${(session.temp_files ?? []).join(', ')}`}
                </div>
              </div>
              <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                <button
                  style={{ ...S.btn, ...S.btnPrimary, padding: '4px 10px', fontSize: '11px' }}
                  onClick={newSession}
                  disabled={starting}
                  title="Aktuelle Session archivieren und neue starten"
                >
                  {starting ? '…' : '+ Neue Session'}
                </button>
                <button
                  style={{ ...S.btn, ...S.btnGhost, padding: '4px 10px', fontSize: '11px' }}
                  onClick={() => { setSessionListOpen(v => !v); if (!sessionListOpen) fetchSessionList(); }}
                  title="Frühere Sessions anzeigen"
                >
                  📋 Sessions
                </button>
                <button style={{ ...S.btn, ...S.btnGhost, padding: '4px 8px', fontSize: '11px', marginLeft: 'auto' }}
                  onClick={endSession}>
                  Session beenden
                </button>
              </div>

              {/* Session list dropdown (within active session) */}
              {sessionListOpen && (
                <div style={{
                  marginTop: '6px', border: '1px solid var(--tn-border, rgba(255,255,255,0.1))',
                  borderRadius: '4px', background: 'var(--tn-surface, #1e2030)',
                  maxHeight: '200px', overflowY: 'auto' as const,
                }}>
                  <div style={{ padding: '5px 8px', fontSize: '10px', fontWeight: 600, color: 'var(--tn-text-muted)', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                    Frühere Sessions {sessionListLoading && '…'}
                  </div>
                  {sessionList.length === 0 && !sessionListLoading && (
                    <div style={{ padding: '8px', fontSize: '11px', color: 'var(--tn-text-muted)', textAlign: 'center' as const }}>Keine archivierten Sessions</div>
                  )}
                  {sessionList.map(s => (
                    <div
                      key={s.id}
                      style={{
                        padding: '5px 8px', cursor: loadingSessionId ? 'default' : 'pointer',
                        borderBottom: '1px solid rgba(255,255,255,0.04)',
                        opacity: loadingSessionId === (s.id) ? 0.6 : 1,
                        background: loadingSessionId === (s.id) ? 'rgba(187,154,247,0.08)' : undefined,
                      }}
                      onClick={() => { if (!loadingSessionId) loadArchivedSession(s.id); }}
                    >
                      <div style={{ fontSize: '11px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
                        {loadingSessionId === (s.id) ? 'Lade…' : (s.title ?? '')}
                      </div>
                      <div style={{ fontSize: '9px', color: 'var(--tn-text-muted)', marginTop: '1px' }}>
                        {new Date(s.created_at).toLocaleDateString('de-DE')} · {s.turns ?? 0} Nachrichten
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        </>)}
        </div>}


        {/* ── Chat ── */}
        {session && (
          <div style={{ ...S.section, flex: 1, display: 'flex', flexDirection: 'column' as const, minHeight: 0 }}>
            {!chatOnly && <div style={S.divider} />}
            {!chatOnly && (
              <div style={{ display: 'flex', alignItems: 'center', marginBottom: '6px' }}>
                <span style={{ fontSize: '11px', fontWeight: 600 }}>Chat</span>
              </div>
            )}
            <div
              style={{ ...S.chatBox, WebkitOverflowScrolling: 'touch' as any }}
            >
              {chatMessages.length === 0 && (
                <div style={{ color: 'var(--tn-text-muted)', fontSize: '11px', textAlign: 'center' as const, padding: '16px 0' }}>
                  Business Angel bereit
                </div>
              )}
              {chatMessages.map((msg, i) => {
                // Backend liefert bereits clean (response-Feld extrahiert, Tool-Summary angehängt).
                // Nur user-side prefixes (diff_status, new_context) müssen für die UI stripped werden.
                const displayContent = (msg.role) === 'user' ? stripInvisibleTags(msg.content) : msg.content;
                if (!displayContent.trim()) return null;
                return (
                  <Fragment key={i}>
                    <div style={(msg.role) === 'user' ? S.msgUser : S.msgAssistant}>
                      {(msg.role) === 'assistant' ? (
                        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{displayContent}</ReactMarkdown>
                      ) : (displayContent)}
                    </div>
                  </Fragment>
                );
              })}
              {chatSending && (
                <div style={{ ...S.msgAssistant, color: 'var(--tn-text-muted)', fontStyle: 'italic' }}>Denkt nach…</div>
              )}
              <div ref={chatEndRef} />
            </div>
            <div style={S.chatInputRow}>
              {(() => {
                const pendingCount = [...selectedFiles].filter(f => !committedFiles.has(f)).length;
                return (
                  <button
                    style={{
                      ...S.btn,
                      padding: '6px 9px', fontSize: '13px',
                      background: pendingCount > 0 ? 'rgba(125,207,255,0.15)' : 'transparent',
                      border: pendingCount > 0 ? '1px dashed rgba(125,207,255,0.5)' : '1px solid var(--tn-border, rgba(255,255,255,0.15))',
                      color: pendingCount > 0 ? 'var(--tn-cyan,#7dcfff)' : 'var(--tn-text-muted)',
                      position: 'relative',
                      fontWeight: 600,
                    }}
                    onClick={() => { setChatOnly(false); setContextCollapsed(false); setTreeOpen(true); }}
                    disabled={chatSending}
                    title={pendingCount > 0
                      ? `${pendingCount} neue Datei${pendingCount !== 1 ? 'en' : ''} vorbereitet — werden mit nächster Nachricht gesendet. Klicken öffnet Kontext-Panel.`
                      : 'Dokument zum Kontext hinzufügen'}
                  >
                    📎{pendingCount > 0 && <span style={{ marginLeft: '4px', fontSize: '10px', fontWeight: 700 }}>{pendingCount}</span>}
                  </button>
                );
              })()}
              <input
                style={S.chatInput}
                placeholder="Nachricht…"
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
                disabled={chatSending}
              />
              <button
                style={{ ...S.btn, ...S.btnPrimary, opacity: chatSending || !chatInput.trim() ? 0.6 : 1 }}
                onClick={sendMessage} disabled={chatSending || !chatInput.trim()}
              >↑</button>
            </div>
            {chatError && <div style={S.errMsg}>{chatError}</div>}
          </div>
        )}

      </div>
    </div>
  );
}
