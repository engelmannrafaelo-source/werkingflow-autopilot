/**
 * Business Angel Panel v2 — Full file-tree context selection, chat, diff cards.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { diffLines } from 'diff';
import { markdownComponents } from './cui/ChatMessages';

// --- Types ---

interface FileTokenInfo {
  path: string;
  exists: boolean;
  tokens: number;
}

interface ContextData {
  kern_files: FileTokenInfo[];
  kern_tokens: number;
  temp_files: Array<{ name: string; tokens: number }>;
  temp_tokens: number;
  temp_dir: string;
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
  temp_files: string[];
  conversation?: ChatMessage[];
  conversation_turns?: number;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface SessionListItem {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  turns: number;
  filename: string;
}

interface DiffCard {
  id: string;
  file: string;
  old: string;
  newText: string;
  rawHunk?: string;
  status: 'unchecked' | 'ok' | 'error' | 'applied' | 'skipped';
  reason?: string;
  oldExpanded: boolean;
  newExpanded: boolean;
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

function parseDiffsClient(text: string): Array<{ file: string; old: string; newText: string; rawHunk?: string }> {
  const results: Array<{ file: string; old: string; newText: string; rawHunk?: string }> = [];

  // ── Format 1: git unified diff ────────────────────────────────────
  // Split on file headers (--- a/path or --- /dev/null)
  const fileBlocks = text.split(/(?=^--- )/m).filter(s => s.trimStart().startsWith('---'));
  for (const fileBlock of fileBlocks) {
    const lines = fileBlock.split('\n');
    const plusLine = lines.find(l => l.startsWith('+++'));
    if (!plusLine) continue;
    const filePath = plusLine.replace(/^\+\+\+\s+(?:b\/)?/, '').trim();
    if (!filePath || filePath === '/dev/null') continue;

    // Split into individual hunks by @@ headers — one DiffCard per hunk
    const hunkParts = fileBlock.split(/(?=^@@)/m).filter(h => h.trimStart().startsWith('@@'));
    for (const hunkPart of hunkParts) {
      const hunkLines = hunkPart.split('\n');
      const contentLines = hunkLines.slice(1); // skip @@ line
      const oldLines: string[] = [];
      const newLines: string[] = [];
      for (const line of contentLines) {
        if (line.startsWith('-')) {
          oldLines.push(line.slice(1));
        } else if (line.startsWith('+')) {
          newLines.push(line.slice(1));
        } else {
          // context line: space prefix or empty
          const content = line.startsWith(' ') ? line.slice(1) : line;
          oldLines.push(content);
          newLines.push(content);
        }
      }
      if (oldLines.length === 0 && newLines.length === 0) continue;
      const rawHunk = `--- a/${filePath}\n+++ b/${filePath}\n${hunkPart.trim()}`;
      results.push({
        file: filePath,
        old: oldLines.join('\n').replace(/\n+$/, ''),
        newText: newLines.join('\n').replace(/\n+$/, ''),
        rawHunk,
      });
    }
  }

  // ── Format 2: legacy FILE:/OLD:/NEW: ─────────────────────────────
  // NOTE: We split on FILE: first so each block only contains one diff.
  // The regex /^NEW:\s*([\s\S]*?)(?=^FILE:\s*|$)/m is BROKEN — with /m,
  // $ matches end of any line so the non-greedy match captures only line 1.
  // Fix: parse line-by-line to correctly extract multiline OLD/NEW blocks.
  if (results.length === 0) {
    const blocks = text.split(/^FILE:\s*/m).filter(b => b.trim());
    for (const block of blocks) {
      const fileLineEnd = block.indexOf('\n');
      if (fileLineEnd === -1) continue;
      const filePath = block.slice(0, fileLineEnd).trim();
      const rest = block.slice(fileLineEnd + 1);

      const lines = rest.split('\n');
      let oldLineIdx = -1, newLineIdx = -1;
      for (let i = 0; i < lines.length; i++) {
        if (oldLineIdx === -1 && /^OLD:\s*/.test(lines[i])) oldLineIdx = i;
        if (newLineIdx === -1 && /^NEW:\s*/.test(lines[i])) newLineIdx = i;
      }
      if (oldLineIdx === -1 || newLineIdx === -1) continue;

      // OLD: inline part + lines up to NEW:
      const oldInline = lines[oldLineIdx].replace(/^OLD:\s*/, '');
      const oldBody = lines.slice(oldLineIdx + 1, newLineIdx).join('\n');
      const oldText = (oldInline + (oldBody ? '\n' + oldBody : '')).trimEnd();

      // NEW: inline part + all remaining lines
      // Strip trailing separator/header junk from the end (--- and ## DIFF N: patterns)
      const newInline = lines[newLineIdx].replace(/^NEW:\s*/, '');
      const newBodyLines = lines.slice(newLineIdx + 1);
      while (newBodyLines.length > 0) {
        const last = newBodyLines[newBodyLines.length - 1].trim();
        if (last === '' || last === '---' || /^##\s+DIFF\s+\d+:/.test(last)) {
          newBodyLines.pop();
        } else break;
      }
      const newBody = newBodyLines.join('\n');
      const newText = (newInline + (newBody ? '\n' + newBody : '')).trimEnd();

      if (!filePath || !oldText) continue;
      results.push({ file: filePath, old: oldText, newText });
    }
  }

  return results;
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
  statusBadge: (s: DiffCard['status']) => {
    const bg: Record<string, string> = { unchecked: 'rgba(255,255,255,0.08)', ok: 'rgba(158,206,106,0.18)', error: 'rgba(247,118,142,0.18)', applied: 'rgba(122,162,247,0.18)', skipped: 'rgba(255,255,255,0.04)' };
    const fg: Record<string, string> = { unchecked: 'var(--tn-text-muted)', ok: 'var(--tn-green,#9ece6a)', error: 'var(--tn-red,#f7768e)', applied: 'var(--tn-blue,#7aa2f7)', skipped: 'var(--tn-text-muted)' };
    return { padding: '2px 6px', borderRadius: '8px', fontSize: '10px', fontWeight: 600, background: bg[s] ?? bg.unchecked, color: fg[s] ?? fg.unchecked };
  },
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
  const [contextCollapsed, setContextCollapsed] = useState(false);
  const [diffsCollapsed, setDiffsCollapsed] = useState(false);
  const [chatOnly, setChatOnly] = useState(false);

  // Selected extra files
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [selectedTokens, setSelectedTokens] = useState(0);

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

  // Diffs
  const [diffCards, setDiffCards] = useState<DiffCard[]>([]);
  const [validating, setValidating] = useState(false);
  const [applyingAll, setApplyingAll] = useState(false);
  const [applyError, setApplyError] = useState('');
  const [pasteOpen, setPasteOpen] = useState(false);
  const [rawPasteText, setRawPasteText] = useState('');
  const diffRef = useRef<HTMLDivElement>(null);

  // View mode + diff editing
  const [activeView, setActiveView] = useState<'chat' | 'diffs'>('chat');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBuffer, setEditBuffer] = useState('');

  // File content cache for full-file diff view
  const [fileContents, setFileContents] = useState<Record<string, string>>({});
  const fetchFileContent = useCallback(async (filePath: string) => {
    if (fileContents[filePath] !== undefined) return;
    try {
      const r = await fetch(`/api/business-angel/file-preview?path=${encodeURIComponent(filePath)}`);
      if (!r.ok) return;
      const data = await r.json();
      setFileContents(prev => ({ ...prev, [filePath]: data.content ?? '' }));
    } catch { /* ignore */ }
  }, [fileContents]);

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
      const data = await resp.json();
      setFileTree(data.tree ?? []);
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
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [chatMessages]);

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

  const totalTokens = (ctx?.kern_tokens ?? 0) + (ctx?.temp_tokens ?? 0) + selectedTokens;

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
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      setSession(data as LoadResult);
      setContextCollapsed(true);
      setActiveSessionInfo(null);
      const excluded: string[] = data.excluded ?? [];
      const excludedNote = excluded.length > 0
        ? `\n\n⚠️ Nicht geladen (Budget): ${excluded.map((f: string) => f.split('/').pop()).join(', ')}`
        : '';
      if (restore && data.conversation && data.conversation.length > 0) {
        // Restore actual conversation history + show reload notice at bottom
        setChatMessages([
          ...data.conversation,
          {
            role: 'assistant',
            content: `_(Dokumente neu geladen · ${data.files_loaded} Dateien · ~${Math.round(data.token_count / 1000)}k Tokens${excludedNote})_`,
          },
        ]);
        // Re-inject diffs from the last assistant message that contains diffs
        const assistantMsgs = (data.conversation as Array<{role: string; content: string}>)
          .filter(m => m.role === 'assistant');
        for (let i = assistantMsgs.length - 1; i >= 0; i--) {
          const parsed = parseDiffsClient(assistantMsgs[i].content);
          if (parsed.length > 0) {
            setDiffCards(parsed.map(d => ({
              id: Math.random().toString(36).slice(2),
              file: d.file, old: d.old, newText: d.newText, rawHunk: d.rawHunk,
              status: 'unchecked' as const,
              oldExpanded: false, newExpanded: false,
            })));
            break; // only inject from the most recent message that has diffs
          }
        }
      } else {
        setChatMessages([{
          role: 'assistant',
          content: `Dokumente geladen (${data.files_loaded} Dateien, ~${Math.round(data.token_count / 1000)}k Tokens).${excludedNote}\n\nIch bin dein strategischer Berater und arbeite ausschließlich mit diesen Quellen. Was brauchst du?`,
        }]);
      }
    } catch (e: unknown) {
      setStartError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  };

  const endSession = async () => {
    await fetch('/api/business-angel/session/end', { method: 'POST' }).catch(() => {});
    setSession(null);
    setChatMessages([]);
    setActiveSessionInfo(null);
  };

  // --- Session Management ---

  const fetchSessionList = async () => {
    setSessionListLoading(true);
    try {
      const resp = await fetch('/api/business-angel/sessions');
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      setSessionList(data.sessions ?? []);
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
      setDiffCards([]);
      setActiveSessionInfo(null);
      setContextCollapsed(false);
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

  const sendMessage = async () => {
    if (!chatInput.trim() || !session || chatSending) return;
    const userMsg = chatInput.trim();
    setChatInput('');
    setChatSending(true);
    setChatError('');
    setChatMessages(prev => [...prev, { role: 'user', content: userMsg }]);
    try {
      const resp = await fetch('/api/business-angel/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: session.session_id, message: userMsg }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      setChatMessages(prev => [...prev, { role: 'assistant', content: data.response }]);
      if (/^FILE:/m.test(data.response) || /^--- /m.test(data.response)) {
        injectDiffs(data.response);
        setTimeout(() => diffRef.current?.scrollIntoView({ behavior: 'smooth' }), 300);
      }
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

  // --- Diffs ---

  const injectDiffs = (text: string) => {
    const parsed = parseDiffsClient(text);
    if (!parsed.length) return;
    setDiffCards(prev => [
      ...prev,
      ...parsed.map(d => ({
        id: Math.random().toString(36).slice(2),
        file: d.file, old: d.old, newText: d.newText, rawHunk: d.rawHunk,
        status: 'unchecked' as const,
        oldExpanded: false, newExpanded: false,
      })),
    ]);
    setActiveView('diffs'); // auto-switch to diffs view when new diffs arrive
  };

  const updateNewText = (id: string, text: string) =>
    setDiffCards(prev => prev.map(c => c.id === id ? { ...c, newText: text } : c));

  const startEdit = (card: DiffCard) => { setEditingId(card.id); setEditBuffer(card.newText); };
  const saveEdit  = (id: string)    => { updateNewText(id, editBuffer); setEditingId(null); setEditBuffer(''); };
  const cancelEdit = ()             => { setEditingId(null); setEditBuffer(''); };

  const parsePasted = () => {
    if (!rawPasteText.trim()) return;
    injectDiffs(rawPasteText);
    setRawPasteText(''); setPasteOpen(false);
  };

  const toggleExpand = (id: string, side: 'old' | 'new') =>
    setDiffCards(prev => prev.map(d => d.id !== id ? d : {
      ...d,
      oldExpanded: side === 'old' ? !d.oldExpanded : d.oldExpanded,
      newExpanded: side === 'new' ? !d.newExpanded : d.newExpanded,
    }));

  const skipDiff  = (id: string) => setDiffCards(prev => prev.map(d => d.id === id ? { ...d, status: 'skipped' as const } : d));
  const removeDiff = (id: string) => setDiffCards(prev => prev.filter(d => d.id !== id));

  const validateAll = async () => {
    const toCheck = diffCards.filter(d => d.status === 'unchecked' || d.status === 'error');
    if (!toCheck.length) return;
    setValidating(true);
    try {
      const resp = await fetch('/api/business-angel/apply-diffs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dry_run: true, diffs: toCheck.map(d => ({ file: d.file, old: d.old, newText: d.newText })) }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      const okSet = new Set<string>(data.applied as string[]);
      const failMap = new Map<string, string>((data.failed as Array<{ file: string; reason: string }>).map(f => [f.file, f.reason]));
      setDiffCards(prev => prev.map(d => {
        if (!toCheck.find(v => v.id === d.id)) return d;
        if (okSet.has(d.file)) return { ...d, status: 'ok' as const, reason: undefined };
        if (failMap.has(d.file)) return { ...d, status: 'error' as const, reason: failMap.get(d.file) };
        return d;
      }));
    } catch (e: unknown) { setApplyError(e instanceof Error ? e.message : String(e)); }
    finally { setValidating(false); }
  };

  const applyOne = async (id: string) => {
    const card = diffCards.find(d => d.id === id);
    if (!card) return;
    const resp = await fetch('/api/business-angel/apply-diffs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ diffs: [{ file: card.file, old: card.old, newText: card.newText }] }),
    });
    const data = await resp.json();
    if ((data.applied as string[]).includes(card.file)) {
      setDiffCards(prev => prev.map(d => d.id === id ? { ...d, status: 'applied' as const } : d));
    } else {
      const reason = (data.failed as Array<{ file: string; reason: string }>).find(f => f.file === card.file)?.reason ?? 'Unknown';
      setDiffCards(prev => prev.map(d => d.id === id ? { ...d, status: 'error' as const, reason } : d));
    }
  };

  const applyAll = async () => {
    const toApply = diffCards.filter(d => d.status === 'ok');
    if (!toApply.length) return;
    setApplyingAll(true); setApplyError('');
    try {
      const resp = await fetch('/api/business-angel/apply-diffs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ diffs: toApply.map(d => ({ file: d.file, old: d.old, newText: d.newText })) }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      const okSet = new Set<string>(data.applied as string[]);
      const failMap = new Map<string, string>((data.failed as Array<{ file: string; reason: string }>).map(f => [f.file, f.reason]));
      setDiffCards(prev => prev.map(d => {
        if (!toApply.find(v => v.id === d.id)) return d;
        if (okSet.has(d.file)) return { ...d, status: 'applied' as const };
        if (failMap.has(d.file)) return { ...d, status: 'error' as const, reason: failMap.get(d.file) };
        return d;
      }));
    } catch (e: unknown) { setApplyError(e instanceof Error ? e.message : String(e)); }
    finally { setApplyingAll(false); }
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

  const okCount = diffCards.filter(d => d.status === 'ok').length;
  const pendingCount = diffCards.filter(d => d.status === 'unchecked').length;
  const appliedCount = diffCards.filter(d => d.status === 'applied').length;

  const statusLabel = (s: DiffCard['status']) =>
    ({ unchecked: '⬜', ok: '✓ ok', error: '✗', applied: '✓ applied', skipped: '—' })[s] ?? s;

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
          {session && (
            <>
              {/* Tab: Chat */}
              <button
                style={{
                  ...S.btn, padding: '3px 10px', fontSize: '11px', borderRadius: '6px',
                  background: activeView === 'chat' ? 'var(--tn-purple, #bb9af7)' : 'transparent',
                  color: activeView === 'chat' ? '#1a1b26' : 'var(--tn-text-muted)',
                  border: activeView === 'chat' ? 'none' : '1px solid rgba(255,255,255,0.12)',
                }}
                onClick={() => setActiveView('chat')}
              >💬 Chat</button>
              {/* Tab: Diffs */}
              <button
                style={{
                  ...S.btn, padding: '3px 10px', fontSize: '11px', borderRadius: '6px',
                  background: activeView === 'diffs' ? 'var(--tn-cyan, #7dcfff)' : 'transparent',
                  color: activeView === 'diffs' ? '#1a1b26' : diffCards.length > 0 ? 'var(--tn-cyan, #7dcfff)' : 'var(--tn-text-muted)',
                  border: activeView === 'diffs' ? 'none' : '1px solid rgba(255,255,255,0.12)',
                  fontWeight: diffCards.length > 0 ? 700 : 400,
                }}
                onClick={() => setActiveView('diffs')}
              >📝 Diffs{diffCards.length > 0 ? ` (${diffCards.length})` : ''}</button>
            </>
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
            <span style={S.badge(tokenColor(ctx!.kern_tokens))}>
              {ctx!.kern_files.filter(f => f.exists).length}/{ctx!.kern_files.length} · {formatTokens(ctx!.kern_tokens)}
            </span>
          </div>
          {kernOpen && (
            <div style={{ paddingLeft: '10px' }}>
              {ctx!.kern_files.map(f => (
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
            <span style={S.badge(ctx!.temp_files.length > 0 ? 'var(--tn-cyan,#7dcfff)' : undefined)}>
              {ctx!.temp_files.length} Dateien · {formatTokens(ctx!.temp_tokens)}
            </span>
          </div>
          {tempOpen && (
            <div style={{ paddingLeft: '10px' }}>
              {ctx!.temp_files.length === 0
                ? <div style={{ fontSize: '11px', color: 'var(--tn-text-muted)', padding: '2px 0' }}>Leer</div>
                : ctx!.temp_files.map(f => {
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
              {[...selectedFiles].map(p => (
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
                    background: 'rgba(187,154,247,0.12)', color: 'var(--tn-purple,#bb9af7)',
                    cursor: 'pointer',
                  }}
                  title={`Klicken zum Entfernen: ${p}`}
                >
                  {p.split('/').pop()} ✕
                </span>
              ))}
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
                        opacity: loadingSessionId === s.id ? 0.6 : 1,
                        background: loadingSessionId === s.id ? 'rgba(187,154,247,0.08)' : undefined,
                      }}
                      onClick={() => { if (!loadingSessionId) loadArchivedSession(s.id); }}
                    >
                      <div style={{ fontSize: '11px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
                        {loadingSessionId === s.id ? 'Lade…' : s.title}
                      </div>
                      <div style={{ fontSize: '9px', color: 'var(--tn-text-muted)', marginTop: '1px' }}>
                        {new Date(s.created_at).toLocaleDateString('de-DE')} · {s.turns} Nachrichten
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
                  {session.session_id.slice(0, 8)}…
                  {session.temp_files.length > 0 && ` · Temp: ${session.temp_files.join(', ')}`}
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
                        opacity: loadingSessionId === s.id ? 0.6 : 1,
                        background: loadingSessionId === s.id ? 'rgba(187,154,247,0.08)' : undefined,
                      }}
                      onClick={() => { if (!loadingSessionId) loadArchivedSession(s.id); }}
                    >
                      <div style={{ fontSize: '11px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
                        {loadingSessionId === s.id ? 'Lade…' : s.title}
                      </div>
                      <div style={{ fontSize: '9px', color: 'var(--tn-text-muted)', marginTop: '1px' }}>
                        {new Date(s.created_at).toLocaleDateString('de-DE')} · {s.turns} Nachrichten
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

        {/* ── Diffs Fullscreen View ── */}
        {session && activeView === 'diffs' && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column' as const, minHeight: 0, overflow: 'hidden' }}>
            {/* Sticky action bar */}
            <div style={{
              display: 'flex', gap: '6px', alignItems: 'center', flexShrink: 0,
              padding: '6px 0 8px', borderBottom: '1px solid rgba(255,255,255,0.07)',
              flexWrap: 'wrap' as const,
            }}>
              <span style={{ fontSize: '11px', color: 'var(--tn-text-muted)', flex: 1 }}>
                {diffCards.filter(d => d.status === 'ok').length}/{diffCards.length} bereit
                {appliedCount > 0 && ` · ${appliedCount} applied`}
                {pendingCount > 0 && ` · ${pendingCount} ausstehend`}
              </span>
              {applyError && <span style={{ color: 'var(--tn-red,#f7768e)', fontSize: '11px' }}>{applyError}</span>}
              <button style={{ ...S.btn, ...S.btnGhost, padding: '4px 10px', fontSize: '11px' }}
                onClick={validateAll} disabled={validating}>
                {validating ? '…' : '✓ Alle validieren'}
              </button>
              {okCount > 0 && (
                <button style={{ ...S.btn, ...S.btnGreen, padding: '4px 10px', fontSize: '11px' }}
                  onClick={applyAll} disabled={applyingAll}>
                  {applyingAll ? '…' : `▶ Anwenden (${okCount})`}
                </button>
              )}
              {appliedCount > 0 && (
                <button style={{ ...S.btn, ...S.btnGhost, padding: '4px 8px', fontSize: '11px', opacity: 0.6 }}
                  onClick={() => setDiffCards(prev => prev.filter(d => d.status !== 'applied' && d.status !== 'skipped'))}>
                  ✕ Erledigte entfernen
                </button>
              )}
            </div>

            {/* Scrollable feed — all diffs open, no inner scrollbars */}
            <div style={{ flex: 1, overflowY: 'auto' as const, paddingBottom: '24px' }}>
              <style>{mdStyles}</style>

              {diffCards.length === 0 ? (
                <div style={{ padding: '48px 0', textAlign: 'center' as const, color: 'var(--tn-text-muted)', fontSize: '13px' }}>
                  Keine Diffs — im Chat «bau die Diffs» sagen
                </div>
              ) : diffCards.map((card, idx) => {
                // Trigger file fetch for full-file diff view
                if (fileContents[card.file] === undefined && card.old.trim()) fetchFileContent(card.file);
                const isEditing = editingId === card.id;
                const isDone = card.status === 'applied' || card.status === 'skipped';
                const borderColor = card.status === 'ok' ? 'rgba(158,206,106,0.35)'
                  : card.status === 'error' ? 'rgba(247,118,142,0.35)'
                  : card.status === 'applied' ? 'rgba(122,162,247,0.25)'
                  : 'rgba(255,255,255,0.08)';
                return (
                  <div key={card.id} style={{
                    marginTop: idx === 0 ? '12px' : '20px',
                    border: `1px solid ${borderColor}`,
                    borderRadius: '8px', overflow: 'hidden',
                    opacity: isDone ? 0.45 : 1,
                    transition: 'opacity 0.2s',
                  }}>
                    {/* ── Card header ── */}
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: '8px',
                      padding: '7px 12px',
                      background: 'rgba(255,255,255,0.04)',
                      borderBottom: `1px solid ${borderColor}`,
                    }}>
                      <span style={{
                        fontFamily: 'monospace', fontSize: '11px', flex: 1,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const,
                        color: 'var(--tn-blue,#7aa2f7)',
                      }} title={card.file}>{card.file}</span>

                      {card.status === 'error' && card.reason && (
                        <span style={{ fontSize: '10px', color: 'var(--tn-red,#f7768e)', flexShrink: 0 }} title={card.reason}>⚠ {card.reason.slice(0, 40)}</span>
                      )}

                      <div style={{ display: 'flex', gap: '4px', alignItems: 'center', flexShrink: 0 }}>
                        {/* Accept / status toggle */}
                        <button
                          title={card.status === 'ok' ? 'Akzeptiert — klicken zum Anwenden' : card.status === 'applied' ? 'Angewendet' : 'Akzeptieren'}
                          style={{
                            ...S.btn,
                            padding: '3px 12px', fontSize: '12px', borderRadius: '6px',
                            background: card.status === 'ok' ? 'rgba(158,206,106,0.2)' : card.status === 'applied' ? 'rgba(122,162,247,0.2)' : 'rgba(255,255,255,0.06)',
                            color: card.status === 'ok' ? 'var(--tn-green,#9ece6a)' : card.status === 'applied' ? 'var(--tn-blue,#7aa2f7)' : 'var(--tn-text-muted)',
                            border: `1px solid ${card.status === 'ok' ? 'rgba(158,206,106,0.4)' : card.status === 'applied' ? 'rgba(122,162,247,0.3)' : 'rgba(255,255,255,0.12)'}`,
                          }}
                          onClick={() => card.status === 'ok' ? applyOne(card.id) : card.status === 'unchecked' || card.status === 'error' ? validateAll() : undefined}
                        >
                          {card.status === 'applied' ? '✓ Applied' : card.status === 'ok' ? '✓ Apply' : card.status === 'error' ? '✗ Fehler' : card.status === 'skipped' ? '— Skip' : '⬜ Prüfen'}
                        </button>
                        {!isDone && (
                          <button style={{ ...S.btn, ...S.btnGhost, padding: '3px 7px', fontSize: '11px', opacity: 0.6 }}
                            title="Überspringen" onClick={() => skipDiff(card.id)}>—</button>
                        )}
                        <button style={{ ...S.btn, ...S.btnGhost, padding: '3px 7px', fontSize: '11px', color: 'rgba(247,118,142,0.6)' }}
                          title="Entfernen" onClick={() => removeDiff(card.id)}>✕</button>
                      </div>
                    </div>

                    {/* ── Full-file side-by-side diff — complete text, scrollable ── */}
                    {(() => {
                      const isNew = !card.old.trim();
                      const fullFile = fileContents[card.file];

                      // Build left/right full-file content
                      const normalize = (s: string) => s.replace(/\r\n/g, '\n').split('\n').map(l => l.trimEnd()).join('\n');
                      const leftFull = isNew ? '' : (fullFile ?? card.old);
                      const rightFull = isNew ? card.newText : (() => {
                        if (!fullFile) return card.newText;
                        const n = normalize(fullFile);
                        const nOld = normalize(card.old);
                        const nNew = normalize(card.newText);
                        return n.includes(nOld) ? n.replace(nOld, nNew) : card.newText;
                      })();

                      // Compute line-level diff
                      type LineEntry = { text: string; type: 'removed'|'added'|'unchanged' };
                      const leftLines: LineEntry[] = [];
                      const rightLines: LineEntry[] = [];
                      const chunks = diffLines(leftFull, rightFull);
                      for (const chunk of chunks) {
                        const lines = chunk.value.replace(/\n$/, '').split('\n');
                        if (chunk.removed) {
                          lines.forEach(l => { leftLines.push({ text: l, type: 'removed' }); rightLines.push({ text: '\u00a0', type: 'unchanged' }); });
                        } else if (chunk.added) {
                          lines.forEach(l => { leftLines.push({ text: '\u00a0', type: 'unchanged' }); rightLines.push({ text: l, type: 'added' }); });
                        } else {
                          lines.forEach(l => { leftLines.push({ text: l, type: 'unchanged' }); rightLines.push({ text: l, type: 'unchanged' }); });
                        }
                      }

                      const lineStyle = (type: LineEntry['type']): React.CSSProperties => ({
                        fontFamily: 'monospace', fontSize: '11px', lineHeight: 1.55,
                        whiteSpace: 'pre-wrap' as const, wordBreak: 'break-word' as const,
                        padding: '0 8px',
                        background: type === 'removed' ? 'rgba(247,118,142,0.18)'
                          : type === 'added' ? 'rgba(158,206,106,0.18)' : 'transparent',
                        color: type === 'removed' ? 'rgba(247,118,142,0.9)'
                          : type === 'added' ? 'rgba(158,206,106,0.9)' : 'var(--tn-text-muted)',
                      });
                      const colHdr = (label: string, clr: string, extra?: React.ReactNode) => (
                        <div style={{ padding: '3px 8px', fontSize: '9px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' as const, color: clr, borderBottom: `1px solid ${clr}22`, display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0, position: 'sticky' as const, top: 0, zIndex: 1, background: 'var(--tn-bg,#1a1b26)' }}>
                          {label}{extra}
                        </div>
                      );

                      const renderAllLines = (lines: LineEntry[]) => {
                        if (!lines.length) return <div key="empty" style={{ padding: '8px', fontSize: '11px', color: 'rgba(255,255,255,0.2)', fontFamily: 'monospace' }}>Lade…</div>;
                        return lines.map((l, i) => {
                          const prefix = l.type === 'removed' ? '− ' : l.type === 'added' ? '+ ' : '\u00a0\u00a0';
                          return <div key={i} style={lineStyle(l.type)}>{prefix}{l.text}</div>;
                        });
                      };

                      return (
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', minHeight: '60px', maxHeight: '70vh' }}>
                          {/* LEFT — full old text, scrollable */}
                          <div style={{ borderRight: '1px solid rgba(255,255,255,0.07)', background: 'rgba(247,118,142,0.02)', overflowY: 'auto' as const, maxHeight: '70vh', display: 'flex', flexDirection: 'column' as const }}>
                            {colHdr('Vorher', 'rgba(247,118,142,0.55)')}
                            {isNew
                              ? <div style={{ padding: '8px', fontSize: '11px', color: 'rgba(255,255,255,0.2)', fontStyle: 'italic', fontFamily: 'monospace' }}>— neue Datei —</div>
                              : <div style={{ padding: '4px 0' }}>{renderAllLines(leftLines)}</div>
                            }
                          </div>
                          {/* RIGHT — full new text, scrollable, editable */}
                          <div style={{ background: 'rgba(158,206,106,0.02)', display: 'flex', flexDirection: 'column' as const, overflowY: 'auto' as const, maxHeight: '70vh' }}>
                            {colHdr('Nachher', 'rgba(158,206,106,0.55)',
                              !isDone && <button style={{ marginLeft: 'auto', fontSize: '9px', opacity: 0.45, background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: '0 2px' }} onClick={() => setEditingId(editingId === card.id ? null : card.id)} title="Bearbeiten">✎</button>
                            )}
                            {editingId === card.id ? (
                              <textarea autoFocus value={card.newText} onChange={e => updateNewText(card.id, e.target.value)} onBlur={() => setEditingId(null)}
                                style={{ flex: 1, display: 'block', width: '100%', minHeight: '300px', resize: 'vertical' as const, background: 'transparent', border: 'none', outline: 'none', color: '#c0caf5', fontFamily: 'monospace', fontSize: '11px', lineHeight: 1.55, padding: '4px 8px', boxSizing: 'border-box' as const }} />
                            ) : (
                              <div style={{ padding: '4px 0', cursor: isDone ? 'default' : 'text' }} onClick={() => !isDone && setEditingId(card.id)}>
                                {isNew
                                  ? card.newText.replace(/\n$/, '').split('\n').map((l, i) => <div key={i} style={lineStyle('added')}>+ {l || '\u00a0'}</div>)
                                  : renderAllLines(rightLines)
                                }
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                );
              })}

              {/* Diffs manuell einfügen */}
              <div style={{ marginTop: '24px', borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '12px' }}>
                <div style={{ ...S.secLabel, cursor: 'pointer' }} onClick={() => setPasteOpen(v => !v)}>
                  <span style={{ fontSize: '9px', width: '10px' }}>{pasteOpen ? '▾' : '▸'}</span>
                  Diffs manuell einfügen
                </div>
                {pasteOpen && (
                  <div style={{ marginTop: '6px' }}>
                    <textarea
                      style={{
                        width: '100%', minHeight: '80px', resize: 'vertical' as const,
                        background: 'var(--tn-surface,#1e2030)',
                        border: '1px solid rgba(255,255,255,0.1)',
                        borderRadius: '4px', color: 'var(--tn-text)',
                        fontFamily: 'monospace', fontSize: '11px', padding: '6px',
                        boxSizing: 'border-box' as const,
                      }}
                      value={rawPasteText}
                      onChange={e => setRawPasteText(e.target.value)}
                    />
                    <button style={{ ...S.btn, ...S.btnGhost, padding: '3px 8px', fontSize: '11px', marginTop: '4px' }}
                      onClick={parsePasted} disabled={!rawPasteText.trim()}>Parsen & hinzufügen</button>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── Chat ── */}
        {session && activeView === 'chat' && (
          <div style={{ ...S.section, flex: 1, display: 'flex', flexDirection: 'column' as const, minHeight: 0 }}>
            {!chatOnly && <div style={S.divider} />}
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: '6px' }}>
              {!chatOnly && <span style={{ fontSize: '11px', fontWeight: 600 }}>Chat</span>}
              {diffCards.length > 0 && (
                <span
                  style={{ ...S.badge('var(--tn-cyan,#7dcfff)'), marginLeft: '8px', cursor: 'pointer' }}
                  onClick={() => setActiveView('diffs')}
                >
                  {diffCards.length} Diff{diffCards.length !== 1 ? 's' : ''} → ansehen
                </span>
              )}
            </div>
            <div style={S.chatBox}>
              {chatMessages.length === 0 && (
                <div style={{ color: 'var(--tn-text-muted)', fontSize: '11px', textAlign: 'center' as const, padding: '16px 0' }}>
                  Business Angel bereit
                </div>
              )}
              {chatMessages.map((msg, i) => (
                <div key={i} style={msg.role === 'user' ? S.msgUser : S.msgAssistant}>
                  {msg.role === 'assistant' ? (
                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{msg.content}</ReactMarkdown>
                  ) : msg.content}
                </div>
              ))}
              {chatSending && (
                <div style={{ ...S.msgAssistant, color: 'var(--tn-text-muted)', fontStyle: 'italic' }}>Denkt nach…</div>
              )}
              <div ref={chatEndRef} />
            </div>
            <div style={S.chatInputRow}>
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
