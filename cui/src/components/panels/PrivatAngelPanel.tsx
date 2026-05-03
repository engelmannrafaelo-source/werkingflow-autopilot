/**
 * Privat Angel Panel — Personal coach chat (clone of BusinessAngelPanel for privat workspace).
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

interface ContextData {
  kern_files?: FileTokenInfo[];
  kern_tokens?: number;
  // Privat Angel uses inbox_* (Voice-Transkripte, Notizen) + tagebuch_* (rolling diary window)
  inbox_files?: Array<{ name: string; tokens: number }>;
  inbox_tokens?: number;
  inbox_dir?: string;
  tagebuch_files?: Array<{ date: string; name: string; tokens: number }>;
  tagebuch_tokens?: number;
  tagebuch_rolling_days?: number;
  // Legacy fallback (when this code is reused for business angel)
  temp_files?: Array<{ name: string; tokens: number }>;
  temp_tokens?: number;
  temp_dir?: string;
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
  inbox_files?: string[];
  tagebuch_files?: string[];
  temp_files?: string[]; // legacy compatibility
  conversation?: ChatMessage[];
  conversation_turns?: number;
  excluded?: string[];
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

interface DiffCard {
  id: string;
  file: string;
  old?: string;
  newText?: string;
  rawHunk?: string;
  status?: 'unchecked' | 'ok' | 'error' | 'applied' | 'already_applied' | 'skipped';
  reason?: string;
  oldExpanded?: boolean;
  newExpanded?: boolean;
  // Index of the assistant message that produced this diff. Rendered inline
  // under that message in the chat flow. -1 = orphan (manual paste before any msg).
  msgIdx: number;
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

  // ── Format 0: <<<DIFF ... >>> and <<<NEW ... >>> blocks ──────────
  // This is the preferred snapshot-based diff format.
  const diffBlockRe = /<<<DIFF\s+(.+?)\n([\s\S]*?)>>>/g;
  const newBlockRe  = /<<<NEW\s+(.+?)\n([\s\S]*?)>>>/g;

  let match: RegExpExecArray | null;

  // Parse <<<DIFF blocks
  while ((match = diffBlockRe.exec(text)) !== null) {
    const filePath = match[1].trim();
    const body = match[2];

    // Extract old_string and new_string from YAML-like body
    const oldMatch = body.match(/^old_string:\s*\|?\s*\n([\s\S]*?)(?=^new_string:)/m);
    // NOTE: greedy [\s\S]* (not non-greedy) — the outer <<<DIFF ... >>>
    // regex already bounds `body`. With /m, `$` matches end of any line, so
    // non-greedy *? would stop at the first line end and capture only line 1.
    // See rescue 2026-04-24 — this bug silently truncated apply-diff writes.
    const newMatch = body.match(/^new_string:\s*\|?\s*\n([\s\S]*)$/m);

    if (oldMatch && newMatch) {
      // Remove leading 2-space indent from YAML block scalar
      const dedent = (s: string) => s.replace(/^  /gm, '').replace(/\n+$/, '');
      results.push({
        file: filePath,
        old: dedent(oldMatch[1]),
        newText: dedent(newMatch[1]),
        rawHunk: match[0],
      });
    }
  }

  // Parse <<<NEW blocks
  while ((match = newBlockRe.exec(text)) !== null) {
    const filePath = match[1].trim();
    const body = match[2];

    const contentMatch = body.match(/^content:\s*\|?\s*\n([\s\S]*)$/m);
    if (contentMatch) {
      const dedent = (s: string) => s.replace(/^  /gm, '').replace(/\n+$/, '');
      results.push({
        file: filePath,
        old: '',
        newText: dedent(contentMatch[1]),
        rawHunk: match[0],
      });
    }
  }

  // If we found <<<DIFF/<<<NEW blocks, return them (preferred format)
  if (results.length > 0) return results;

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
  statusBadge: (s: DiffCard['status']) => {
    const bg: Record<string, string> = { unchecked: 'rgba(255,255,255,0.08)', ok: 'rgba(158,206,106,0.18)', error: 'rgba(247,118,142,0.18)', applied: 'rgba(122,162,247,0.18)', skipped: 'rgba(255,255,255,0.04)' };
    const fg: Record<string, string> = { unchecked: 'var(--tn-text-muted)', ok: 'var(--tn-green,#9ece6a)', error: 'var(--tn-red,#f7768e)', applied: 'var(--tn-blue,#7aa2f7)', skipped: 'var(--tn-text-muted)' };
    return { padding: '2px 6px', borderRadius: '8px', fontSize: '10px', fontWeight: 600, background: bg[s ?? 'unchecked'] ?? bg.unchecked, color: fg[s ?? 'unchecked'] ?? fg.unchecked };
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

export default function PrivatAngelPanel() {
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
  const [chatScrollActive, setChatScrollActive] = useState(false);

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

  // Diffs
  const [diffCards, setDiffCards] = useState<DiffCard[]>([]);
  const [validating, setValidating] = useState(false);
  const [applyError, setApplyError] = useState('');

  // File content cache for full-file diff view
  const [fileContents, setFileContents] = useState<Record<string, string>>({});
  const fetchFileContent = useCallback(async (filePath: string) => {
    // Re-fetch if empty string (may be stale from previous bug)
    if (fileContents[filePath] !== undefined && fileContents[filePath] !== '') return;
    try {
      const r = await fetch(`/api/privat-angel/file-preview?path=${encodeURIComponent(filePath)}`);
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
      const r = await fetch(`/api/privat-angel/snapshot?session_id=${encodeURIComponent(sessionId)}`);
      if (!r.ok) {
        console.warn('[PrivatAngel] No snapshot found');
        setSnapshotLoaded(true);
        return;
      }
      const data = await r.json();
      const validated = validateApiResponse<{ files: Record<string, string> }>(data, '/api/privat-angel/snapshot', { files: 'object' });
      setSnapshotFiles(validated.files);
      setSnapshotLoaded(true);
      console.log(`[PrivatAngel] Snapshot loaded: ${Object.keys(validated.files).length} files`);
    } catch {
      setSnapshotLoaded(true);
    }
  }, []);

  // --- Load data ---

  const fetchContext = useCallback(async () => {
    setCtxLoading(true);
    setCtxError('');
    try {
      const resp = await fetch('/api/privat-angel/context');
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
      const resp = await fetch('/api/privat-angel/files');
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const raw = await resp.json();
      const data = validateApiResponse<{ tree: TreeNode[] }>(raw, '/api/privat-angel/files', { tree: 'array' });
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
    fetch('/api/privat-angel/session/active')
      .then(r => r.json())
      .then(d => { if (d.active) startSession(true); })
      .catch(() => {}); // silent-ok: active session check on mount is best-effort
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [chatMessages]);

  const openPreview = useCallback(async (path: string) => {
    if (previewPath === path) { setPreviewPath(null); setPreviewContent(''); setPreviewMeta(null); return; }
    setPreviewPath(path); setPreviewLoading(true); setPreviewContent(''); setPreviewMeta(null);
    try {
      const resp = await fetch(`/api/privat-angel/file-preview?path=${encodeURIComponent(path)}`);
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

  const totalTokens = (ctx?.kern_tokens ?? 0) + (ctx?.inbox_tokens ?? 0) + (ctx?.tagebuch_tokens ?? 0) + selectedTokens;

  // --- Session ---

  const startSession = async (restore = false) => {
    setStarting(true);
    setStartError('');
    try {
      const resp = await fetch('/api/privat-angel/load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ extra_files: [...selectedFiles], restore }),
      });
      const raw = await resp.json();
      if (!resp.ok) throw new Error(raw.error || `HTTP ${resp.status}`);
      const data = validateApiResponse<LoadResult>(raw, '/api/privat-angel/load', {
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
        // Re-inject diffs from the last assistant message that contains diffs,
        // tagged with that message's original index in the restored list.
        for (let i = data.conversation.length - 1; i >= 0; i--) {
          const msg = data.conversation[i];
          if (msg.role !== 'assistant') continue;
          const parsed = parseDiffsClient(msg.content);
          if (parsed.length > 0) {
            setDiffCards(parsed.map(d => ({
              id: Math.random().toString(36).slice(2),
              file: d.file, old: d.old, newText: d.newText, rawHunk: d.rawHunk,
              status: 'unchecked' as const,
              oldExpanded: false, newExpanded: false,
              msgIdx: i,
            })));
            break;
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
    await fetch('/api/privat-angel/session/end', { method: 'POST' }).catch(() => {}); // silent-ok: session end notification is best-effort; state cleared immediately
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
      const resp = await fetch('/api/privat-angel/sessions');
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const raw = await resp.json();
      const data = validateApiResponse<{ sessions: SessionListItem[] }>(raw, '/api/privat-angel/sessions', { sessions: 'array' });
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
      await fetch('/api/privat-angel/session/new', { method: 'POST' });
      setSession(null);
      setChatMessages([]);
      setDiffCards([]);
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
      const resp = await fetch(`/api/privat-angel/session/load/${sessionId}`, { method: 'POST' });
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
    const parts: string[] = [];

    if (diffCards.length > 0) {
      const seen = <T extends { file: string }>(arr: T[]) => [...new Set(arr.map(c => c.file))];
      const applied = seen(diffCards.filter(c => (c.status ?? 'unchecked') === 'applied'));
      const skipped = seen(diffCards.filter(c => (c.status ?? 'unchecked') === 'skipped'));
      const pending = seen(diffCards.filter(c => {
        const s = c.status ?? 'unchecked';
        return s !== 'applied' && s !== 'skipped';
      }));
      const lines: string[] = [];
      if (applied.length) lines.push(`Angewendet: ${applied.join(', ')}`);
      if (skipped.length) lines.push(`Abgelehnt (nicht übernommen): ${skipped.join(', ')}`);
      if (pending.length) lines.push(`Noch offen: ${pending.join(', ')}`);
      if (lines.length) parts.push(`<diff_status>\n${lines.join('\n')}\n</diff_status>`);
    }

    // Pending file injection happens via /sync-context (separate turn) before send — see sendMessage.
    return parts.length > 0 ? parts.join('\n\n') + '\n\n' : '';
  };

  // Sync new/changed files into the conversation as a separate turn (not into the immutable
  // first context_message). Backend computes diff against session manifest. Returns whether
  // anything was synced.
  const syncContext = async (extra: string[]): Promise<boolean> => {
    if (!session) return false;
    try {
      const resp = await fetch('/api/privat-angel/sync-context', {
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
      setCommittedFiles(new Set(selectedFiles));  // mark current selection as in-context
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
    // If user picked files in the tree since session start, sync them as a separate turn first
    // (keeps the immutable context_message clean → prompt cache stays warm).
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
      const resp = await fetch('/api/privat-angel/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: session.session_id, message: wireMsg }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      setChatMessages(prev => [...prev, { role: 'assistant', content: data.response }]);
      setCommittedFiles(new Set(selectedFiles));
      if (/^FILE:/m.test(data.response) || /^--- /m.test(data.response) || /<<<DIFF\s/m.test(data.response) || /<<<NEW\s/m.test(data.response)) {
        injectDiffs(data.response, assistantIdx);
        setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 300);
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

  // --- Generate Diffs (standard prompt injection) ---

  const GENERATE_DIFFS_PROMPT = `Generiere für jede Datei die du ändern willst einen strukturierten Diff-Block.
Beziehe dich dabei IMMER auf den ORIGINAL-Inhalt der Dateien (wie sie zu Beginn der Session geladen wurden), NICHT auf zwischenzeitliche Änderungen.

Format für Änderungen:
<<<DIFF pfad/zur/datei.md
old_string: |
  ...exakter Text aus dem Original...
new_string: |
  ...neuer Text...
>>>

Format für neue Dateien:
<<<NEW pfad/zur/neuen-datei.md
content: |
  ...vollständiger Inhalt...
>>>

Wichtig:
- old_string muss EXAKT im Original-Dokument vorkommen (nicht in einer bereits geänderten Version)
- Genug Kontext-Zeilen für eindeutigen Match
- Mehrere Diff-Blöcke pro Datei sind erlaubt`;

  const generateDiffs = async () => {
    if (!session || chatSending) return;
    setChatSending(true);
    setChatError('');
    const assistantIdx = chatMessages.length + 1;
    setChatMessages(prev => [...prev, { role: 'user', content: '📝 Generiere Diffs' }]);
    try {
      const prefix = await buildMessagePrefix();
      const wireMsg = prefix + GENERATE_DIFFS_PROMPT;
      const resp = await fetch('/api/privat-angel/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: session.session_id, message: wireMsg }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      setChatMessages(prev => [...prev, { role: 'assistant', content: data.response }]);
      setCommittedFiles(new Set(selectedFiles));
      // Auto-detect and inject diffs from response
      const parsed = parseDiffsClient(data.response);
      if (parsed.length > 0) {
        injectDiffs(data.response, assistantIdx);
        setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 300);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
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

  const injectDiffs = (text: string, msgIdx: number) => {
    const parsed = parseDiffsClient(text);
    if (!parsed.length) return;
    setDiffCards(prev => [
      ...prev,
      ...parsed.map(d => ({
        id: Math.random().toString(36).slice(2),
        file: d.file, old: d.old, newText: d.newText, rawHunk: d.rawHunk,
        status: 'unchecked' as const,
        oldExpanded: false, newExpanded: false,
        msgIdx,
      })),
    ]);
  };

  const skipDiff  = (id: string) => setDiffCards(prev => prev.map(d => (d.id) === id ? { ...d, status: 'skipped' as const } : d));
  const removeDiff = (id: string) => setDiffCards(prev => prev.filter(d => (d.id) !== id));

  const validateAll = async () => {
    const toCheck = diffCards.filter(d => (d.status ?? 'unchecked') === 'unchecked' || (d.status ?? 'unchecked') === 'error');
    if (!toCheck.length) return;
    setValidating(true);
    try {
      const resp = await fetch('/api/privat-angel/apply-diffs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dry_run: true, diffs: toCheck.map(d => ({ file: d.file, old: d.old ?? '', newText: d.newText ?? '' })) }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      const okSet      = new Set<string>(data.applied as string[]);
      const alreadySet = new Set<string>((data.already_applied ?? []) as string[]);
      const failMap    = new Map<string, string>((data.failed as Array<{ file: string; reason: string }>).map(f => [f.file, f.reason]));
      setDiffCards(prev => prev.map(d => {
        if (!toCheck.find(v => (v.id) === (d.id))) return d;
        if (okSet.has(d.file))      return { ...d, status: 'ok' as const, reason: undefined };
        if (alreadySet.has(d.file)) return { ...d, status: 'already_applied' as const, reason: undefined };
        if (failMap.has(d.file))    return { ...d, status: 'error' as const, reason: failMap.get(d.file) };
        return d;
      }));
    } catch (e: unknown) { setApplyError(e instanceof Error ? e.message : String(e)); }
    finally { setValidating(false); }
  };

  const applyOne = async (id: string) => {
    const card = diffCards.find(d => (d.id) === id);
    if (!card) return;
    const resp = await fetch('/api/privat-angel/apply-diffs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        diffs: [{ file: card.file, old: card.old ?? '', newText: card.newText ?? '' }],
        ...(session?.session_id ? { session_id: session.session_id } : {}),
      }),
    });
    const data = await resp.json();
    const appliedList      = (data.applied ?? []) as string[];
    const alreadyList      = (data.already_applied ?? []) as string[];
    const failedList       = (data.failed ?? []) as Array<{ file: string; reason: string }>;

    if (appliedList.includes(card.file)) {
      setDiffCards(prev => prev.map(d => (d.id) === id ? { ...d, status: 'applied' as const } : d));
      // Refresh snapshot so the next generate round uses the updated file as baseline
      if (session?.session_id) fetchSnapshot(session.session_id);
    } else if (alreadyList.includes(card.file)) {
      setDiffCards(prev => prev.map(d => (d.id) === id ? { ...d, status: 'already_applied' as const, reason: undefined } : d));
    } else {
      const reason = failedList.find(f => f.file === card.file)?.reason ?? 'Unknown';
      setDiffCards(prev => prev.map(d => (d.id) === id ? { ...d, status: 'error' as const, reason } : d));
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

  const okCount = diffCards.filter(d => (d.status ?? 'unchecked') === 'ok').length;
  const pendingCount = diffCards.filter(d => (d.status ?? 'unchecked') === 'unchecked').length;
  const appliedCount = diffCards.filter(d => (d.status ?? 'unchecked') === 'applied').length;

  const statusLabel = (s: DiffCard['status']) =>
    ({ unchecked: '⬜', ok: '✓ ok', error: '✗', applied: '✓ applied', already_applied: '↩ bereits applied', skipped: '—' })[s ?? 'unchecked'] ?? s;

  // Helper: render a single file's diff group (header + side-by-side preview).
  // Used inline in the chat flow, one invocation per (message, file) pair.
  const renderFileDiffGroup = (file: string, fileCards: DiffCard[], keyPrefix: string) => {
    const snapshotContent = snapshotFiles[file];
    const rawFileContent = fileContents[file];
    const fullFile = snapshotContent ?? (rawFileContent && rawFileContent.length > 0 ? rawFileContent : undefined);
    const isNewFile = !fullFile && fileCards.every(c => !(c.old ?? '').trim() && c.rawHunk?.startsWith('<<<NEW'));
    const allDone = fileCards.every(c => (c.status ?? 'unchecked') === 'applied' || (c.status ?? 'unchecked') === 'already_applied' || (c.status ?? 'unchecked') === 'skipped');
    const isLoadingContent = !fullFile && !isNewFile;

    // Baseline → final text after applying all hunks for this file
    const normalize = (s: string) => s.replace(/\r\n/g, '\n').split('\n').map(l => l.trimEnd()).join('\n');
    const leftFull = isNewFile ? '' : (fullFile ?? '');
    const rightFull = isNewFile
      ? fileCards.map(c => c.newText ?? '').join('\n')
      : (() => {
          if (!fullFile) return fileCards.map(c => c.newText ?? '').join('\n');
          let result = normalize(fullFile);
          for (const card of fileCards) {
            if ((card.old ?? '').trim()) {
              const nOld = normalize(card.old ?? '');
              const nNew = normalize(card.newText ?? '');
              if (result.includes(nOld)) result = result.replace(nOld, nNew);
            } else {
              result = result + (result.endsWith('\n') ? '' : '\n') + normalize(card.newText ?? '');
            }
          }
          return result;
        })();

    // Per-line highlight sets (1-indexed)
    const leftRemovedLines = new Set<number>();
    const rightAddedLines = new Set<number>();
    {
      let leftLn = 1, rightLn = 1;
      const chunks = diffLines(leftFull, rightFull);
      for (const chunk of chunks) {
        const raw = chunk.value;
        const lineCount = raw.length === 0 ? 0 : raw.split('\n').length - (raw.endsWith('\n') ? 1 : 0);
        if (chunk.removed) {
          for (let i = 0; i < lineCount; i++) leftRemovedLines.add(leftLn + i);
          leftLn += lineCount;
        } else if (chunk.added) {
          for (let i = 0; i < lineCount; i++) rightAddedLines.add(rightLn + i);
          rightLn += lineCount;
        } else {
          leftLn += lineCount;
          rightLn += lineCount;
        }
      }
    }
    const hasChanges = leftRemovedLines.size > 0 || rightAddedLines.size > 0;

    const colHdr = (label: string, clr: string) => (
      <div style={{ padding: '3px 8px', fontSize: '9px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' as const, color: clr, borderBottom: `1px solid ${clr}22`, display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0, position: 'sticky' as const, top: 0, zIndex: 1, background: 'var(--tn-bg,#1a1b26)' }}>
        {label}
      </div>
    );

    const makeHighlightedComponents = (highlightSet: Set<number>, bg: string, border: string) => {
      const isHit = (node: any): boolean => {
        const start = node?.position?.start?.line;
        const end = node?.position?.end?.line ?? start;
        if (!start) return false;
        for (let ln = start; ln <= end; ln++) if (highlightSet.has(ln)) return true;
        return false;
      };
      const hlBlock: React.CSSProperties = { background: bg, borderLeft: `3px solid ${border}`, paddingLeft: '10px', marginLeft: '-13px', borderRadius: '0 2px 2px 0' };
      const merge = (node: any, base: React.CSSProperties): React.CSSProperties =>
        isHit(node) ? { ...base, ...hlBlock } : base;
      return {
        ...markdownComponents,
        h1: ({ node, ...props }: any) => <h1 style={merge(node, { fontSize: '20px', fontWeight: 700, color: 'var(--tn-text)', marginTop: '16px', marginBottom: '8px' })} {...props} />,
        h2: ({ node, ...props }: any) => <h2 style={merge(node, { fontSize: '17px', fontWeight: 600, color: 'var(--tn-text)', marginTop: '12px', marginBottom: '6px' })} {...props} />,
        h3: ({ node, ...props }: any) => <h3 style={merge(node, { fontSize: '15px', fontWeight: 600, color: 'var(--tn-blue)', marginTop: '10px', marginBottom: '5px' })} {...props} />,
        h4: ({ node, ...props }: any) => <h4 style={merge(node, { fontSize: '14px', fontWeight: 600, color: 'var(--tn-text)', marginTop: '8px', marginBottom: '4px' })} {...props} />,
        p: ({ node, ...props }: any) => <p style={merge(node, { marginBottom: '8px', lineHeight: '1.6' })} {...props} />,
        li: ({ node, ...props }: any) => <li style={merge(node, { marginBottom: '3px' })} {...props} />,
        blockquote: ({ node, ...props }: any) => <blockquote style={merge(node, { borderLeft: '3px solid var(--tn-blue)', paddingLeft: '12px', marginBottom: '8px', color: 'var(--tn-text-muted)', fontStyle: 'italic' })} {...props} />,
        hr: ({ node, ...props }: any) => <hr style={merge(node, { border: 'none', borderTop: '1px solid var(--tn-border)', margin: '12px 0' })} {...props} />,
        pre: ({ node, children, ...props }: any) => <pre style={merge(node, { margin: 0 })} {...props}>{children}</pre>,
        tr: ({ node, children, ...props }: any) => (
          <tr style={isHit(node) ? { background: bg, boxShadow: `inset 3px 0 0 ${border}` } : undefined} {...props}>{children}</tr>
        ),
      };
    };
    const leftComponents = makeHighlightedComponents(leftRemovedLines, 'rgba(247,118,142,0.18)', 'rgba(247,118,142,0.7)');
    const rightComponents = makeHighlightedComponents(rightAddedLines, 'rgba(158,206,106,0.18)', 'rgba(158,206,106,0.7)');

    const fileAppliedCount      = fileCards.filter(c => (c.status ?? 'unchecked') === 'applied').length;
    const fileAlreadyCount      = fileCards.filter(c => (c.status ?? 'unchecked') === 'already_applied').length;
    const fileOkCount           = fileCards.filter(c => (c.status ?? 'unchecked') === 'ok').length;
    const fileErrorCount        = fileCards.filter(c => (c.status ?? 'unchecked') === 'error').length;
    const filePendingCount      = fileCards.filter(c => (c.status ?? 'unchecked') === 'unchecked').length;
    const headerBorderColor = fileErrorCount > 0 ? 'rgba(247,118,142,0.35)'
      : fileOkCount > 0 ? 'rgba(158,206,106,0.35)'
      : allDone ? 'rgba(122,162,247,0.25)'
      : 'rgba(255,255,255,0.08)';

    return (
      <div key={`${keyPrefix}-${file}`} style={{
        marginTop: '10px',
        border: `1px solid rgba(255,255,255,0.08)`,
        borderRadius: '8px', overflow: 'hidden',
        opacity: allDone ? 0.45 : 1,
        transition: 'opacity 0.2s',
      }}>
        {/* File header + controls */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: '8px',
          padding: '7px 12px',
          background: 'rgba(255,255,255,0.04)',
          borderBottom: `1px solid ${headerBorderColor}`,
        }}>
          <span style={{
            fontFamily: 'monospace', fontSize: '11px', flex: 1,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const,
            color: 'var(--tn-blue,#7aa2f7)',
          }} title={file}>
            {file}
            {fileCards.length > 1 && (
              <span style={{ color: 'var(--tn-text-muted)', fontSize: '10px', marginLeft: '6px' }}>
                ({fileCards.length} Änderungen)
              </span>
            )}
          </span>
          {fileErrorCount > 0 && (
            <span style={{ fontSize: '10px', color: 'var(--tn-red,#f7768e)', flexShrink: 0 }}>
              ⚠ {fileErrorCount} Fehler
            </span>
          )}
          {fileAlreadyCount > 0 && fileAlreadyCount < fileCards.length && (
            <span style={{ fontSize: '10px', color: 'rgba(122,162,247,0.7)', flexShrink: 0 }}>
              ↩ {fileAlreadyCount} bereits applied
            </span>
          )}
          {fileAppliedCount > 0 && fileAppliedCount < fileCards.length && (
            <span style={{ fontSize: '10px', color: 'var(--tn-blue,#7aa2f7)', flexShrink: 0 }}>
              {fileAppliedCount}/{fileCards.length} applied
            </span>
          )}
          <div style={{ display: 'flex', gap: '4px', alignItems: 'center', flexShrink: 0 }}>
            <button
              title={allDone ? 'Alle angewendet' : fileOkCount > 0 ? 'Alle akzeptierten anwenden' : 'Alle prüfen'}
              style={{
                ...S.btn,
                padding: '3px 12px', fontSize: '12px', borderRadius: '6px',
                background: allDone ? 'rgba(122,162,247,0.2)' : fileOkCount > 0 ? 'rgba(158,206,106,0.2)' : 'rgba(255,255,255,0.06)',
                color: allDone ? 'var(--tn-blue,#7aa2f7)' : fileOkCount > 0 ? 'var(--tn-green,#9ece6a)' : 'var(--tn-text-muted)',
                border: `1px solid ${allDone ? 'rgba(122,162,247,0.3)' : fileOkCount > 0 ? 'rgba(158,206,106,0.4)' : 'rgba(255,255,255,0.12)'}`,
              }}
              onClick={() => {
                if (fileOkCount > 0) fileCards.filter(c => (c.status ?? 'unchecked') === 'ok').forEach(c => applyOne(c.id));
                else if (filePendingCount > 0 || fileErrorCount > 0) validateAll();
              }}
            >
              {allDone ? '✓ Applied' : fileOkCount > 0 ? `✓ Apply${fileCards.length > 1 ? ` (${fileOkCount})` : ''}` : filePendingCount > 0 ? '⬜ Prüfen' : '✗ Fehler'}
            </button>
            {!allDone && (
              <button style={{ ...S.btn, ...S.btnGhost, padding: '3px 7px', fontSize: '11px', opacity: 0.6 }}
                title="Alle überspringen"
                onClick={() => fileCards.forEach(c => { if ((c.status ?? 'unchecked') !== 'applied' && (c.status ?? 'unchecked') !== 'skipped') skipDiff(c.id); })}>—</button>
            )}
            <button style={{ ...S.btn, ...S.btnGhost, padding: '3px 7px', fontSize: '11px', color: 'rgba(247,118,142,0.6)' }}
              title="Alle entfernen"
              onClick={() => fileCards.forEach(c => removeDiff(c.id))}>✕</button>
          </div>
        </div>
        {/* Error details */}
        {fileCards.some(c => (c.status ?? 'unchecked') === 'error' || (c.status ?? 'unchecked') === 'already_applied') && (
          <div style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
            {fileCards.map((card, hunkIdx) => {
              const s = card.status ?? 'unchecked';
              if (s === 'error' && card.reason)
                return (
                  <div key={card.id} style={{ padding: '4px 12px', fontSize: '10px', color: 'var(--tn-red,#f7768e)' }}>
                    Hunk {hunkIdx + 1}: ⚠ {card.reason}
                  </div>
                );
              if (s === 'already_applied')
                return (
                  <div key={card.id} style={{ padding: '4px 12px', fontSize: '10px', color: 'rgba(122,162,247,0.8)', background: 'rgba(122,162,247,0.06)' }}>
                    Hunk {hunkIdx + 1}: ↩ Bereits applied — Änderung ist schon in der Datei, kein Schreibvorgang nötig.
                  </div>
                );
              return null;
            })}
          </div>
        )}
        {/* Side-by-side full-file preview with line highlights */}
        {isLoadingContent ? (
          <div style={{ padding: '16px', fontSize: '11px', color: 'rgba(255,255,255,0.3)', fontFamily: 'monospace', textAlign: 'center' as const }}>
            Lade Dateiinhalt…
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', height: '60vh' }}>
            <div style={{ borderRight: '1px solid rgba(255,255,255,0.07)', overflowY: 'auto' as const, overscrollBehavior: 'contain', display: 'flex', flexDirection: 'column' as const, background: 'rgba(247,118,142,0.02)', minHeight: 0 }}>
              {colHdr(snapshotContent ? 'Vorher (Snapshot)' : 'Vorher', 'rgba(247,118,142,0.55)')}
              <div style={{ padding: '12px 18px', fontSize: '12px', lineHeight: 1.6 }}>
                {leftFull.trim() ? (
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={leftComponents}>{leftFull}</ReactMarkdown>
                ) : (
                  <div style={{ color: 'var(--tn-text-muted)', fontSize: '11px', fontStyle: 'italic' }}>(neue Datei — keine Vorher-Version)</div>
                )}
              </div>
            </div>
            <div style={{ overflowY: 'auto' as const, overscrollBehavior: 'contain', display: 'flex', flexDirection: 'column' as const, background: 'rgba(158,206,106,0.02)', minHeight: 0 }}>
              {colHdr(hasChanges ? 'Nachher' : 'Nachher (identisch)', 'rgba(158,206,106,0.55)')}
              <div style={{ padding: '12px 18px', fontSize: '12px', lineHeight: 1.6 }}>
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={rightComponents}>{rightFull}</ReactMarkdown>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };

  // Render all file-grouped diffs attached to a given message.
  const renderDiffsForMessage = (msgIdx: number) => {
    const cards = diffCards.filter(c => c.msgIdx === msgIdx);
    if (!cards.length) return null;
    const fileGroups = new Map<string, DiffCard[]>();
    cards.forEach(c => {
      const g = fileGroups.get(c.file) || [];
      g.push(c);
      fileGroups.set(c.file, g);
    });
    // Trigger lazy file-content fetch
    fileGroups.forEach((_, file) => {
      if (fileContents[file] === undefined) fetchFileContent(file);
    });
    return (
      <div style={{ marginTop: '8px' }}>
        {Array.from(fileGroups.entries()).map(([file, fcs]) =>
          renderFileDiffGroup(file, fcs, `m${msgIdx}`))}
      </div>
    );
  };

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
        <h2 style={S.h2}>🪞 Privat Angel</h2>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '4px', alignItems: 'center' }}>
          {session && diffCards.length > 0 && (
            <span style={{ fontSize: '10px', color: 'var(--tn-cyan,#7dcfff)', padding: '2px 8px', borderRadius: '4px', background: 'rgba(125,207,255,0.1)', border: '1px solid rgba(125,207,255,0.2)' }}>
              📝 {diffCards.length} Diff{diffCards.length !== 1 ? 's' : ''} inline
            </span>
          )}
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

        {/* ── Tagebuch (Rolling Window) ── */}
        <div style={S.section}>
          <div style={S.secLabel}>
            <span style={{ fontSize: '9px', width: '10px' }}>▸</span>
            Tagebuch ({ctx?.tagebuch_rolling_days ?? 7} Tage rolling)
            <span style={S.badge((ctx?.tagebuch_files?.length ?? 0) > 0 ? 'var(--tn-magenta,#bb9af7)' : undefined)}>
              {(ctx?.tagebuch_files ?? []).length} Tage · {formatTokens(ctx?.tagebuch_tokens ?? 0)}
            </span>
          </div>
          <div style={{ paddingLeft: '10px' }}>
            {(ctx?.tagebuch_files ?? []).length === 0
              ? <div style={{ fontSize: '11px', color: 'var(--tn-text-muted)', padding: '2px 0' }}>Keine Eintraege im Fenster</div>
              : (ctx?.tagebuch_files ?? []).map(f => {
                const isPrev = previewPath === f.name;
                return (
                  <div key={f.name} style={{ display: 'flex', gap: '5px', padding: '1px 0', fontSize: '11px', alignItems: 'center', background: isPrev ? 'rgba(122,162,247,0.08)' : undefined, borderRadius: '3px' }}>
                    <span style={{ color: 'var(--tn-magenta,#bb9af7)' }}>●</span>
                    <span style={{ flex: 1 }}>{f.date}</span>
                    <span style={S.treeTokens}>{formatTokens(f.tokens)}</span>
                    <span style={{ fontSize: '10px', cursor: 'pointer', opacity: isPrev ? 1 : 0.35, color: isPrev ? 'var(--tn-blue,#7aa2f7)' : undefined }} onClick={() => openPreview(f.name)}>👁</span>
                  </div>
                );
              })
            }
          </div>
        </div>

        {/* ── Inbox (frische Inputs) ── */}
        <div style={S.section}>
          <div style={S.secLabel} onClick={() => setTempOpen(v => !v)}>
            <span style={{ fontSize: '9px', width: '10px' }}>{tempOpen ? '▾' : '▸'}</span>
            Inbox
            <span style={S.badge((ctx?.inbox_files?.length ?? 0) > 0 ? 'var(--tn-cyan,#7dcfff)' : undefined)}>
              {(ctx?.inbox_files ?? []).length} Dateien · {formatTokens(ctx?.inbox_tokens ?? 0)}
            </span>
          </div>
          {tempOpen && (
            <div style={{ paddingLeft: '10px' }}>
              {(ctx?.inbox_files ?? []).length === 0
                ? <div style={{ fontSize: '11px', color: 'var(--tn-text-muted)', padding: '2px 0' }}>Leer — wirf Voice-Transkripte / Notizen in {ctx?.inbox_dir ?? 'inbox/'}</div>
                : (ctx?.inbox_files ?? []).map(f => {
                  const isPrev = previewPath === f.name || previewPath === `inbox/${f.name}`;
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
                  {(session.inbox_files?.length ?? 0) > 0 && ` · Inbox: ${(session.inbox_files ?? []).join(', ')}`}
                  {(session.tagebuch_files?.length ?? 0) > 0 && ` · ${(session.tagebuch_files ?? []).length} Tagebuch-Tage`}
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
              style={{ ...S.chatBox, overflowY: (chatScrollActive || (typeof window !== 'undefined' && window.matchMedia('(hover: none)').matches)) ? 'auto' : 'hidden', WebkitOverflowScrolling: 'touch' as any }}
              onMouseEnter={() => setChatScrollActive(true)}
              onMouseLeave={() => setChatScrollActive(false)}
            >
              {chatMessages.length === 0 && (
                <div style={{ color: 'var(--tn-text-muted)', fontSize: '11px', textAlign: 'center' as const, padding: '16px 0' }}>
                  Privat Angel bereit
                </div>
              )}
              {chatMessages.map((msg, i) => {
                const displayContent = (msg.role) === 'user' ? stripInvisibleTags(msg.content) : msg.content;
                return (
                  <Fragment key={i}>
                    <div style={(msg.role) === 'user' ? S.msgUser : S.msgAssistant}>
                      {(msg.role) === 'assistant' ? (
                        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{displayContent}</ReactMarkdown>
                      ) : (displayContent)}
                    </div>
                    {(msg.role) === 'assistant' && renderDiffsForMessage(i)}
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
                style={{
                  ...S.btn,
                  background: 'var(--tn-cyan, #7dcfff)', color: '#1a1b26',
                  padding: '6px 10px', fontSize: '11px', fontWeight: 700,
                  opacity: chatSending ? 0.5 : 1,
                }}
                onClick={generateDiffs}
                disabled={chatSending}
                title="Standard-Prompt injizieren: Generiere strukturierte Diffs basierend auf dem Snapshot"
              >Diffs</button>
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
