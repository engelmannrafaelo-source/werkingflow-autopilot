import React, { useState, useEffect, useRef, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// =============================================================================
// Report Builder — Creative Document Generation Panel
// =============================================================================
// Step 1: Select sources → extract claims with VARIANTS → AI proposes draft
// Step 2: User curates claims, picks variants → configure & generate document

const API = '/api/report-builder';

// --- Types ---
interface ClaimVariant { style: string; text: string; }

interface Claim {
  id: string; text: string; context: string; variants: ClaimVariant[]; selectedVariant: number;
  reasoning: string; source: string; sourceSection: string; category: string;
  selected: boolean; note: string; weight: number; order: number;
  templateId?: string; templateReason?: string;
}

interface ClaimGroup { id: string; groupName: string; category: string; claims: Claim[]; }
interface DraftSection { title: string; description: string; claimIds: string[]; }
interface TreeNode { name: string; path: string; type: 'file' | 'directory'; size?: number; tokenEstimate?: number; children?: TreeNode[]; }
interface SessionSummary { id: string; name?: string; createdAt: string; updatedAt: string; step: string; sourceCount: number; claimCount: number; outputFormat: string; }

interface TemplateSectionInfo {
  id: string; fileRelPath: string; fileName: string; sectionIndex: number;
  title: string; preview: string; type: string;
}
interface TemplateFileInfo { relPath: string; fileName: string; documentType: 'presentation' | 'document' | 'unknown'; sectionCount: number; sections: TemplateSectionInfo[]; }
interface TemplateFavoritesData { favorites: string[]; categories: Record<string, string>; }

interface Revision {
  id: string; html: string; changePrompt: string;
  addedSources: string[]; designHints: string[]; timestamp: string;
}

type Step = 'source-select' | 'claim-curation' | 'generation' | 'review';

// --- Category Colors ---
const CAT_COLORS: Record<string, string> = {
  fact: '#7aa2f7', argument: '#bb9af7', metric: '#9ece6a', quote: '#e0af68',
  recommendation: '#f7768e', vision: '#7dcfff', problem: '#f7768e',
  solution: '#9ece6a', architecture: '#7aa2f7', roadmap: '#bb9af7',
  business: '#e0af68', differentiator: '#ff9e64', status: '#565f89', general: '#565f89',
};

const VARIANT_LABELS: Record<string, string> = { compact: 'Kurz', persuasive: 'Impact', detailed: 'Detail', executive: 'Exec' };

// Token display helpers
const CONTEXT_LIMIT = 200_000; // Claude Sonnet context window
function fmtTokens(n: number): string { return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`; }

// =============================================================================
// Session Picker
// =============================================================================
function SessionPicker({ onSelect, onCreate }: { onSelect: (id: string) => void; onCreate: () => void }) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API}/sessions`).then(r => r.json()).then(d => { setSessions(d.sessions || []); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  const stepLabels: Record<string, string> = { 'source-select': 'Quellen', 'claim-curation': 'Claims', generation: 'Config', review: 'Output' };

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--tn-text-muted)', fontSize: 12 }}>Lade Sessions...</div>;

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <SectionLabel>Sessions</SectionLabel>
        <button onClick={onCreate} style={{ ...btnPrimary, padding: '4px 12px' }}>+ Neue Session</button>
      </div>
      {sessions.length === 0 && (
        <div style={{ color: 'var(--tn-text-muted)', fontSize: 12, padding: 32, textAlign: 'center', border: '1px dashed var(--tn-border)', borderRadius: 6 }}>
          Keine Sessions. Erstelle eine neue.
        </div>
      )}
      {sessions.map(sess => (
        <div key={sess.id} onClick={() => onSelect(sess.id)} style={{
          padding: '10px 12px', marginBottom: 6, borderRadius: 6, cursor: 'pointer',
          border: '1px solid var(--tn-border)', background: 'var(--tn-bg-dark)', transition: 'all 0.15s',
        }}
        onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--tn-border-hover, #565f89)'; e.currentTarget.style.background = 'var(--tn-surface-hover, #2a2e3f)'; }}
        onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--tn-border)'; e.currentTarget.style.background = 'var(--tn-bg-dark)'; }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontWeight: 600, fontSize: 12 }}>{sess.name || `Session ${sess.id.slice(0, 8)}`}</span>
            <StatusBadge color={sess.step === 'review' ? 'var(--tn-green)' : 'var(--tn-blue)'}>{stepLabels[sess.step] || sess.step}</StatusBadge>
          </div>
          <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginTop: 4, display: 'flex', gap: 12 }}>
            <span>{sess.sourceCount} Quellen</span>
            <span>{sess.claimCount} Claims</span>
            <span style={{ fontFamily: 'monospace' }}>{sess.outputFormat}</span>
            <span>{new Date(sess.updatedAt).toLocaleDateString('de-DE')} {new Date(sess.updatedAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

// =============================================================================
// Source Selector
// =============================================================================
function SourceSelector({ selected, onToggle, onExtract, brief, setBrief, extractionPrompt, setExtractionPrompt, loading }: {
  selected: Set<string>; onToggle: (p: string) => void; onExtract: () => void;
  brief: string; setBrief: (v: string) => void;
  extractionPrompt: string; setExtractionPrompt: (v: string) => void; loading: boolean;
}) {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['shared', 'sales', 'marketing', 'customer-success', 'foerderung']));
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [previewContent, setPreviewContent] = useState<string>('');
  const [previewMeta, setPreviewMeta] = useState<{ totalLines: number; truncated: boolean; size: number } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  useEffect(() => { fetch(`${API}/business-tree`).then(r => r.json()).then(d => setTree(d.tree || [])).catch(() => {}); }, []);

  function toggleExpand(path: string) {
    setExpanded(prev => { const n = new Set(prev); n.has(path) ? n.delete(path) : n.add(path); return n; });
  }

  async function handlePreview(path: string, e: React.MouseEvent) {
    e.stopPropagation();
    if (previewPath === path) {
      setPreviewPath(null); setPreviewContent(''); setPreviewMeta(null);
      return;
    }
    setPreviewPath(path); setPreviewLoading(true); setPreviewContent(''); setPreviewMeta(null);
    try {
      const resp = await fetch(`${API}/file-preview?path=${encodeURIComponent(path)}`);
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Preview failed');
      setPreviewContent(data.preview || '');
      setPreviewMeta({ totalLines: data.totalLines, truncated: data.truncated, size: data.size });
    } catch {
      setPreviewContent('Fehler beim Laden der Vorschau.');
    } finally { setPreviewLoading(false); }
  }

  // Collect all file nodes from the tree (flat list) for the selected section
  function collectFiles(nodes: TreeNode[]): TreeNode[] {
    const files: TreeNode[] = [];
    for (const node of nodes) {
      if (node.type === 'file') files.push(node);
      if (node.type === 'directory' && node.children) files.push(...collectFiles(node.children));
    }
    return files;
  }

  // Eye icon SVG component for preview button
  function EyeIcon({ active }: { active: boolean }) {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        style={{ display: 'block' }}>
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
        <circle cx="12" cy="12" r="3"/>
      </svg>
    );
  }

  // Markdown preview styles (injected once)
  const mdStyles = `
    .rb-md-preview h1, .rb-md-preview h2, .rb-md-preview h3 { color: #7aa2f7; margin: 0.6em 0 0.3em; font-size: 1.1em; }
    .rb-md-preview h1 { font-size: 1.3em; border-bottom: 1px solid #2a2e3f; padding-bottom: 4px; }
    .rb-md-preview h2 { font-size: 1.15em; }
    .rb-md-preview p { margin: 0.3em 0; }
    .rb-md-preview ul, .rb-md-preview ol { margin: 0.3em 0; padding-left: 1.4em; }
    .rb-md-preview li { margin: 0.15em 0; }
    .rb-md-preview code { background: rgba(122,162,247,0.1); padding: 1px 4px; border-radius: 3px; font-size: 0.9em; }
    .rb-md-preview pre { background: #16161e; padding: 8px; border-radius: 4px; overflow-x: auto; margin: 0.4em 0; }
    .rb-md-preview pre code { background: none; padding: 0; }
    .rb-md-preview table { border-collapse: collapse; margin: 0.4em 0; width: 100%; font-size: 0.92em; }
    .rb-md-preview th, .rb-md-preview td { border: 1px solid #2a2e3f; padding: 3px 6px; text-align: left; }
    .rb-md-preview th { background: rgba(122,162,247,0.08); font-weight: 600; }
    .rb-md-preview blockquote { border-left: 3px solid #7aa2f7; margin: 0.4em 0; padding: 2px 10px; color: #a9b1d6; }
    .rb-md-preview strong { color: #e0af68; }
    .rb-md-preview a { color: #7dcfff; text-decoration: none; }
    .rb-md-preview hr { border: none; border-top: 1px solid #2a2e3f; margin: 0.6em 0; }
    .rb-md-preview img { max-width: 100%; border-radius: 4px; }
  `;

  // Rendered preview content based on file extension
  function renderPreviewContent(): React.ReactNode {
    if (previewLoading) return <span style={{ color: 'var(--tn-text-muted)', fontSize: 11 }}>Lade Vorschau...</span>;
    if (!previewContent) return <span style={{ color: 'var(--tn-text-muted)', fontStyle: 'italic', fontSize: 11 }}>Datei ist leer</span>;

    const ext = previewPath?.split('.').pop()?.toLowerCase() || '';

    if (ext === 'md') {
      return (
        <>
          <style>{mdStyles}</style>
          <div className="rb-md-preview" style={{ fontSize: 12, lineHeight: 1.6, color: '#c0caf5', wordBreak: 'break-word' as const }}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{previewContent}</ReactMarkdown>
          </div>
        </>
      );
    }

    if (ext === 'html') {
      return (
        <iframe
          srcDoc={previewContent}
          style={{ width: '100%', height: '100%', border: 'none', borderRadius: 4, background: '#fff', minHeight: 350 }}
          sandbox="allow-same-origin"
          title="HTML Preview"
        />
      );
    }

    // Fallback: raw monospace
    return (
      <div style={{
        fontFamily: 'monospace', fontSize: 10, lineHeight: 1.6,
        color: '#c0caf5', whiteSpace: 'pre-wrap' as const, wordBreak: 'break-word' as const, tabSize: 4,
      }}>
        {previewContent}
      </div>
    );
  }

  // Render a file row (used in both selected section and tree)
  function renderFileRow(node: TreeNode, depth: number, isSelectedSection: boolean): React.ReactNode {
    const isSel = selected.has(node.path);
    const isPreviewing = previewPath === node.path;
    // In the selected section, extract parent directory from path for context
    const parentDir = isSelectedSection ? node.path.split('/').slice(0, -1).join('/') : null;
    return (
      <div key={`${isSelectedSection ? 'sel-' : ''}${node.path}`}>
        <div style={{
          paddingLeft: isSelectedSection ? 4 : depth * 16, display: 'flex', alignItems: 'center',
          padding: isSelectedSection ? '3px 4px' : '3px 0', cursor: 'pointer', fontSize: 12,
          borderRadius: 3, background: isPreviewing ? 'rgba(122,162,247,0.15)' : isSel ? 'rgba(122,162,247,0.08)' : 'transparent', transition: 'all 0.1s',
        }} onClick={() => onToggle(node.path)}>
          <input type="checkbox" checked={isSel} readOnly style={{ marginRight: 8, cursor: 'pointer', accentColor: isSelectedSection ? '#e0af68' : 'var(--tn-blue)' }} />
          <span style={{ color: isSel ? 'var(--tn-text)' : 'var(--tn-text-muted)', flex: 1 }}>{node.name}</span>
          {isSelectedSection && parentDir && (
            <span style={{ marginLeft: 8, color: 'var(--tn-text-muted)', fontSize: 9, fontFamily: 'monospace', opacity: 0.6 }}>{parentDir}</span>
          )}
          {node.tokenEstimate != null && (
            <span style={{ marginLeft: 8, color: isSel ? 'var(--tn-yellow, #e0af68)' : 'var(--tn-text-muted)', fontSize: 9, fontFamily: 'monospace' }}>
              {fmtTokens(node.tokenEstimate)}t
            </span>
          )}
          <span
            onClick={(e) => handlePreview(node.path, e)}
            title={isPreviewing ? 'Vorschau schliessen' : 'Vorschau'}
            style={{
              marginLeft: 6, padding: '1px 4px', borderRadius: 3, cursor: 'pointer', lineHeight: 1,
              color: isPreviewing ? 'var(--tn-blue, #7aa2f7)' : 'var(--tn-text-muted)',
              background: isPreviewing ? 'rgba(122,162,247,0.15)' : 'transparent',
              transition: 'all 0.15s', flexShrink: 0, display: 'inline-flex', alignItems: 'center',
            }}
            onMouseEnter={e => { if (!isPreviewing) e.currentTarget.style.color = 'var(--tn-text)'; e.currentTarget.style.background = 'rgba(122,162,247,0.08)'; }}
            onMouseLeave={e => { if (!isPreviewing) { e.currentTarget.style.color = 'var(--tn-text-muted)'; e.currentTarget.style.background = 'transparent'; } else { e.currentTarget.style.background = 'rgba(122,162,247,0.15)'; } }}
          >
            <EyeIcon active={isPreviewing} />
          </span>
        </div>
      </div>
    );
  }

  // Render tree node, but skip selected files (they appear in the top section)
  function renderNode(node: TreeNode, depth = 0, skipSelected = false): React.ReactNode {
    if (filter && node.type === 'file' && !node.name.toLowerCase().includes(filter.toLowerCase())) return null;
    if (node.type === 'directory') {
      const isOpen = expanded.has(node.path);
      const kids = node.children?.map(c => renderNode(c, depth + 1, skipSelected)).filter(Boolean);
      if (filter && (!kids || kids.length === 0)) return null;
      // If skipSelected is on and all remaining children are selected files, hide the empty directory
      if (skipSelected && (!kids || kids.length === 0) && !filter) return null;
      return (
        <div key={node.path}>
          <div style={{ paddingLeft: depth * 16, display: 'flex', alignItems: 'center', padding: '3px 0', cursor: 'pointer', fontSize: 12 }} onClick={() => toggleExpand(node.path)}>
            <span style={{ marginRight: 6, color: 'var(--tn-text-muted)', fontSize: 10 }}>{isOpen ? '\u25BE' : '\u25B8'}</span>
            <span style={{ color: 'var(--tn-blue, #7aa2f7)', fontWeight: 600 }}>{node.name}/</span>
          </div>
          {isOpen && kids}
        </div>
      );
    }
    // Skip selected files in the tree when they are shown in the top section
    if (skipSelected && selected.has(node.path)) return null;
    return renderFileRow(node, depth, false);
  }

  // Get selected file nodes for the top section
  const allFiles = collectFiles(tree);
  const selectedFiles = allFiles.filter(f => selected.has(f.path) && (!filter || f.name.toLowerCase().includes(filter.toLowerCase())));

  // Token totals for selected files
  const totalTokens = allFiles.filter(f => selected.has(f.path)).reduce((sum, f) => sum + (f.tokenEstimate || 0), 0);
  const tokenPct = Math.min(100, (totalTokens / CONTEXT_LIMIT) * 100);
  const tokenColor = tokenPct > 80 ? 'var(--tn-red, #f7768e)' : tokenPct > 50 ? 'var(--tn-yellow, #e0af68)' : 'var(--tn-green, #9ece6a)';

  return (
    <div>
      {/* AUFTRAG — what to generate */}
      <SectionLabel>Auftrag — Was soll generiert werden?</SectionLabel>
      <textarea
        rows={3}
        style={{ ...inputStyle, resize: 'vertical' as const, fontSize: 12, lineHeight: 1.5, borderColor: brief ? 'var(--tn-blue, #7aa2f7)' : 'var(--tn-border)' }}
        placeholder="z.B. 'Erstelle eine Kundenpräsentation für Bacher mit seinen 3 Optionen (Lizenz/EP/Fachpartner), Fokus auf ROI und Marktpotential' oder 'Executive Summary für Herbert Teufel: PoC-Recap, Partnership-Angebot, Roadmap'"
        value={brief}
        onChange={e => setBrief(e.target.value)}
      />

      <SectionLabel style={{ marginTop: 14 }}>Quell-Dokumente ({allFiles.filter(f => selected.has(f.path)).length} ausgewahlt)</SectionLabel>
      <input type="text" placeholder="Filtern..." value={filter} onChange={e => setFilter(e.target.value)} style={inputStyle} />

      {/* Flex layout: File tree left, Preview right */}
      <div style={{ display: 'flex', gap: 8, marginTop: 6, minHeight: 300 }}>
        {/* Left: File tree */}
        <div style={{
          flex: previewPath ? '0 0 50%' : '1 1 100%',
          maxHeight: 450, overflow: 'auto',
          border: '1px solid var(--tn-border)', borderRadius: 6, padding: 8,
          background: 'var(--tn-bg-dark)', transition: 'flex 0.2s',
        }}>
          {/* Selected files section */}
          {selectedFiles.length > 0 && (
            <div style={{ marginBottom: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, padding: '2px 0' }}>
                <span style={{ fontSize: 9, fontWeight: 700, color: '#e0af68', letterSpacing: '0.08em', textTransform: 'uppercase' as const }}>
                  AUSGEWAHLT ({selectedFiles.length})
                </span>
              </div>
              {selectedFiles.map(f => renderFileRow(f, 0, true))}
              <div style={{ height: 1, background: 'linear-gradient(90deg, #e0af6850, #e0af6820, transparent)', margin: '6px 0 4px 0' }} />
            </div>
          )}
          {/* Remaining tree */}
          {tree.map(n => renderNode(n, 0, selectedFiles.length > 0))}
          {tree.length === 0 && <span style={{ color: 'var(--tn-text-muted)', fontSize: 11 }}>Lade...</span>}
        </div>

        {/* Right: Preview panel (visible when a file is selected for preview) */}
        {previewPath && (
          <div style={{
            flex: '0 0 50%', maxHeight: 450, display: 'flex', flexDirection: 'column' as const,
            border: '1px solid var(--tn-border)', borderRadius: 6, overflow: 'hidden',
            background: '#1a1b26',
          }}>
            {/* Preview Header */}
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '5px 10px', borderBottom: '1px solid var(--tn-border)',
              background: 'rgba(122,162,247,0.06)', flexShrink: 0,
            }}>
              <span style={{ fontSize: 10, color: 'var(--tn-text-muted)', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, flex: 1, minWidth: 0 }}>
                {previewPath.split('/').pop()}
                {previewMeta && (
                  <span style={{ marginLeft: 8, fontSize: 9 }}>
                    {previewMeta.totalLines} Z | {Math.round(previewMeta.size / 1024)}KB
                  </span>
                )}
              </span>
              <span
                onClick={(e) => { e.stopPropagation(); setPreviewPath(null); setPreviewContent(''); setPreviewMeta(null); }}
                style={{ cursor: 'pointer', color: 'var(--tn-text-muted)', fontSize: 14, fontWeight: 700, lineHeight: 1, padding: '0 4px', flexShrink: 0, marginLeft: 8 }}
                title="Schliessen"
              >&times;</span>
            </div>
            {/* Preview Content (rendered) */}
            <div style={{ flex: 1, overflow: 'auto', padding: '8px 12px', minHeight: 0 }}>
              {renderPreviewContent()}
            </div>
          </div>
        )}
      </div>

      {/* Token usage bar */}
      {selected.size > 0 && (
        <div style={{ marginTop: 10, padding: '6px 8px', background: 'var(--tn-bg-dark)', border: '1px solid var(--tn-border)', borderRadius: 6 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <span style={{ fontSize: 10, color: 'var(--tn-text-muted)' }}>
              <b style={{ color: tokenColor }}>{fmtTokens(totalTokens)}</b> / {fmtTokens(CONTEXT_LIMIT)} Tokens
            </span>
            <span style={{ fontSize: 9, color: 'var(--tn-text-muted)' }}>{selected.size} Datei{selected.size !== 1 ? 'en' : ''} | ~{Math.round(tokenPct)}%</span>
          </div>
          <div style={{ height: 3, background: 'var(--tn-border)', borderRadius: 2, overflow: 'hidden' }}>
            <div style={{ height: '100%', background: tokenColor, width: `${tokenPct}%`, transition: 'width 0.3s, background 0.3s', borderRadius: 2 }} />
          </div>
        </div>
      )}

      <SectionLabel style={{ marginTop: 14 }}>Fokus-Hinweis (optional)</SectionLabel>
      <textarea rows={2} style={{ ...inputStyle, resize: 'vertical' as const, fontSize: 10 }} placeholder="Optionaler Hinweis fuer die Extraktion, z.B. 'Nur finanzielle Kennzahlen' oder 'Technische Details ignorieren'" value={extractionPrompt} onChange={e => setExtractionPrompt(e.target.value)} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--tn-border)' }}>
        <span style={{ color: 'var(--tn-text-muted)', fontSize: 11 }}>
          {!brief && <span style={{ color: 'var(--tn-red, #f7768e)' }}>Auftrag fehlt</span>}
          {brief && <>{selected.size} Dokument{selected.size !== 1 ? 'e' : ''}</>}
        </span>
        <button style={btnPrimary} onClick={onExtract} disabled={selected.size === 0 || !brief || loading}>
          {loading ? 'Extrahiere...' : 'Claims extrahieren'}
        </button>
      </div>
    </div>
  );
}

// =============================================================================
// Claim Card (with variant selector)
// =============================================================================
function ClaimCard({ claim, onChange, templateCandidates, onSelectTemplate }: {
  claim: Claim;
  onChange: (claimId: string, update: Partial<Claim>) => void;
  templateCandidates?: Array<{ templateId: string; templateTitle: string; templateType: string; hasSvg: boolean; reason: string; rank: number; selected: boolean }>;
  onSelectTemplate?: (claimId: string, templateId: string) => void;
}) {
  const [showNote, setShowNote] = useState(!!claim.note);
  const catColor = CAT_COLORS[claim.category] || '#565f89';
  const vs = claim.variants || [];
  const activeText = claim.selectedVariant >= 0 && vs[claim.selectedVariant]
    ? vs[claim.selectedVariant].text : claim.text;

  return (
    <div style={{
      padding: '8px 10px', marginBottom: 3, borderRadius: 6,
      border: `1px solid ${claim.selected ? 'var(--tn-border)' : 'transparent'}`,
      background: claim.selected ? 'var(--tn-bg-dark)' : 'transparent',
      opacity: claim.selected ? 1 : 0.3, transition: 'all 0.15s',
    }}>
      {/* Row 1: checkbox + badge + text + stars */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
        <input type="checkbox" checked={claim.selected} onChange={() => onChange(claim.id, { selected: !claim.selected })}
          style={{ cursor: 'pointer', accentColor: 'var(--tn-blue)', flexShrink: 0, marginTop: 2 }} />
        <StatusBadge color={catColor}>{claim.category}</StatusBadge>
        <div style={{ flex: 1, minWidth: 0, fontSize: 12, lineHeight: 1.5 }}>{activeText}</div>
        <div style={{ display: 'flex', gap: 1, flexShrink: 0 }}>
          {[1, 2, 3, 4, 5].map(w => (
            <span key={w} onClick={() => onChange(claim.id, { weight: w })} style={{
              cursor: 'pointer', fontSize: 11, lineHeight: 1,
              color: w <= claim.weight ? 'var(--tn-yellow, #e0af68)' : 'var(--tn-text-muted)',
            }}>{w <= claim.weight ? '\u2605' : '\u2606'}</span>
          ))}
        </div>
      </div>

      {/* Template candidates as thumbnail strip */}
      {templateCandidates && templateCandidates.length > 0 && claim.selected && (
        <div style={{ marginLeft: 22, marginTop: 4, display: 'flex', gap: 6, overflowX: 'auto' }}>
          {templateCandidates.map(tc => (
            <div key={tc.templateId}
              onClick={() => onSelectTemplate?.(claim.id, tc.templateId)}
              style={{
                flexShrink: 0, width: 192, cursor: 'pointer', borderRadius: 5, overflow: 'hidden',
                border: `2px solid ${tc.selected ? (tc.hasSvg ? '#9ece6a' : 'var(--tn-blue)') : 'var(--tn-border)'}`,
                background: '#0a0f1e', position: 'relative' as const, transition: 'border-color 0.15s',
              }}>
              {/* Mini iframe preview */}
              <div style={{ width: 192, height: 120, overflow: 'hidden', position: 'relative' as const }}>
                <iframe
                  src={`/api/report-builder/template-section/${tc.templateId}/html`}
                  style={{ width: 640, height: 400, border: 'none', transform: 'scale(0.3)', transformOrigin: 'top left', pointerEvents: 'none' }}
                  sandbox="allow-same-origin" title={tc.templateTitle} loading="lazy" />
              </div>
              {/* Label bar */}
              <div style={{ padding: '3px 5px', background: 'rgba(0,0,0,0.6)', fontSize: 9, lineHeight: 1.3, display: 'flex', alignItems: 'center', gap: 3 }}>
                {tc.selected && <span style={{ color: '#9ece6a', fontSize: 11 }}>&#10003;</span>}
                {tc.hasSvg && <span style={{ color: '#9ece6a', fontWeight: 700, fontSize: 8 }}>SVG</span>}
                <span style={{ color: tc.selected ? '#fff' : 'var(--tn-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }} title={tc.reason}>
                  {tc.templateTitle.slice(0, 30)}{tc.templateTitle.length > 30 ? '..' : ''}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Row 2: Variant pills (only when selected) */}
      {vs.length > 0 && claim.selected && (
        <div style={{ display: 'flex', gap: 3, marginTop: 5, marginLeft: 22, flexWrap: 'wrap' }}>
          <VariantPill active={claim.selectedVariant === -1} onClick={() => onChange(claim.id, { selectedVariant: -1 })}>Original</VariantPill>
          {vs.map((v, vi) => (
            <VariantPill key={vi} active={claim.selectedVariant === vi} onClick={() => onChange(claim.id, { selectedVariant: vi })} title={v.text}>
              {VARIANT_LABELS[v.style] || v.style}
            </VariantPill>
          ))}
        </div>
      )}

      {/* Row 3: Source + reasoning + note */}
      {claim.selected && (
        <div style={{ marginLeft: 22, marginTop: 4 }}>
          <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', fontFamily: 'monospace' }}>
            {claim.source} &gt; {claim.sourceSection}
          </div>
          {claim.context && <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginTop: 2, lineHeight: 1.4, borderLeft: '2px solid var(--tn-border)', paddingLeft: 6 }}>{claim.context}</div>}
          {claim.reasoning && <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', fontStyle: 'italic', marginTop: 1 }}>{claim.reasoning}</div>}
          <div style={{ marginTop: 3 }}>
            {showNote ? (
              <input type="text" value={claim.note} placeholder="Anmerkung..."
                onChange={e => onChange(claim.id, { note: e.target.value })}
                onBlur={() => { if (!claim.note) setShowNote(false); }} autoFocus
                style={{ ...inputStyle, padding: '2px 6px', fontSize: 10, width: 250, background: 'var(--tn-bg)' }} />
            ) : (
              <span onClick={() => setShowNote(true)} style={{ fontSize: 9, color: 'var(--tn-text-muted)', cursor: 'pointer' }}>+ Anmerkung</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Claim Curation (Step 2)
// =============================================================================
function ClaimCuration({ groups, draftOutline, onChange, onToggleGroup, generalNotes, setGeneralNotes, onBack, onNext, claimTemplateMatches, onSelectTemplate }: {
  groups: ClaimGroup[]; draftOutline: DraftSection[];
  onChange: (groupId: string, claimId: string, update: Partial<Claim>) => void;
  onToggleGroup: (groupId: string, selected: boolean) => void;
  generalNotes: string; setGeneralNotes: (v: string) => void;
  onBack: () => void; onNext: () => void;
  claimTemplateMatches?: Array<{ claimId: string; templateId: string; reason: string; rank: number; selected: boolean; templateTitle: string; templateType: string; templateFile: string; hasSvg: boolean }>;
  onSelectTemplate?: (claimId: string, templateId: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [showDraft, setShowDraft] = useState(draftOutline.length > 0);
  const total = groups.reduce((a, g) => a + g.claims.length, 0);
  const selected = groups.reduce((a, g) => a + g.claims.filter(c => c.selected).length, 0);

  return (
    <div>
      {/* Stats + toggle */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <span style={{ fontSize: 11, color: 'var(--tn-text-muted)' }}>
          <b style={{ color: 'var(--tn-text)' }}>{selected}</b>/{total} Claims
        </span>
        {draftOutline.length > 0 && (
          <button onClick={() => setShowDraft(!showDraft)} style={{ ...btnSecondary, fontSize: 10 }}>
            {showDraft ? 'Claims anzeigen' : 'KI-Entwurf'}
          </button>
        )}
      </div>

      {/* Draft Outline */}
      {showDraft && draftOutline.length > 0 && (
        <div style={{ marginBottom: 14, padding: 12, background: 'var(--tn-bg-dark)', border: '1px solid var(--tn-border)', borderRadius: 6 }}>
          <SectionLabel>KI-Entwurf — "So wurde ich das aufbauen"</SectionLabel>
          {draftOutline.map((section, si) => (
            <div key={si} style={{ marginBottom: 10 }}>
              <div style={{ fontWeight: 700, fontSize: 12, color: 'var(--tn-blue, #7aa2f7)', marginBottom: 2 }}>{si + 1}. {section.title}</div>
              <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginBottom: 4 }}>{section.description}</div>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {section.claimIds.map(cid => {
                  const claim = groups.flatMap(g => g.claims).find(c => c.id === cid);
                  if (!claim) return null;
                  return (
                    <span key={cid} title={claim.text} style={{
                      fontSize: 9, padding: '2px 6px', borderRadius: 3, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const,
                      background: claim.selected ? 'rgba(122,162,247,0.1)' : 'rgba(86,95,137,0.1)',
                      color: claim.selected ? 'var(--tn-blue)' : 'var(--tn-text-muted)',
                      border: `1px solid ${claim.selected ? 'var(--tn-blue)' : 'var(--tn-border)'}`,
                    }}>{claim.text.slice(0, 55)}{claim.text.length > 55 ? '...' : ''}</span>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Claim Groups */}
      {!showDraft && groups.map(group => {
        const isCollapsed = collapsed.has(group.id);
        const gs = group.claims.filter(c => c.selected).length;
        const catColor = CAT_COLORS[group.category] || '#565f89';
        return (
          <div key={group.id} style={{ marginBottom: 6 }}>
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '6px 10px', borderRadius: 6, cursor: 'pointer',
              background: 'var(--tn-surface, var(--tn-bg-dark))', border: '1px solid var(--tn-border)', transition: 'all 0.15s',
            }}
            onClick={() => setCollapsed(prev => { const n = new Set(prev); n.has(group.id) ? n.delete(group.id) : n.add(group.id); return n; })}
            onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--tn-border-hover, #565f89)'; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--tn-border)'; }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ color: 'var(--tn-text-muted)', fontSize: 10 }}>{isCollapsed ? '\u25B8' : '\u25BE'}</span>
                <StatusBadge color={catColor}>{group.category}</StatusBadge>
                <span style={{ fontWeight: 600, fontSize: 12 }}>{group.groupName}</span>
                <span style={{ fontSize: 10, color: 'var(--tn-text-muted)' }}>({gs}/{group.claims.length})</span>
              </div>
              <button style={{ ...btnSecondary, fontSize: 9, padding: '2px 6px' }}
                onClick={e => { e.stopPropagation(); onToggleGroup(group.id, gs < group.claims.length); }}>
                {gs === group.claims.length ? 'Keine' : 'Alle'}
              </button>
            </div>
            {!isCollapsed && group.claims.map(claim => (
              <ClaimCard key={claim.id} claim={claim}
                onChange={(cid, upd) => onChange(group.id, cid, upd)}
                templateCandidates={claimTemplateMatches?.filter(m => m.claimId === claim.id).sort((a, b) => a.rank - b.rank)}
                onSelectTemplate={onSelectTemplate} />
            ))}
          </div>
        );
      })}

      {/* Notes + Nav */}
      <SectionLabel style={{ marginTop: 14 }}>Allgemeine Anweisungen</SectionLabel>
      <textarea rows={2} style={{ ...inputStyle, resize: 'vertical' as const }} placeholder="z.B. 'Max. 10 Seiten, SVG Architektur-Diagramm, Executive Summary'" value={generalNotes} onChange={e => setGeneralNotes(e.target.value)} />
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--tn-border)' }}>
        <button style={btnSecondary} onClick={onBack}>Quellen</button>
        <button style={btnPrimary} onClick={onNext} disabled={selected === 0}>Config ({selected} Claims)</button>
      </div>
    </div>
  );
}

// =============================================================================
// Template Browser — Select design reference sections from business HTML files
// =============================================================================
const SECTION_TYPE_LABELS: Record<string, string> = { hero: 'Hero', content: 'Content', divider: 'Divider', cta: 'CTA', footer: 'Footer', other: 'Sonstig' };
const SECTION_TYPE_COLORS: Record<string, string> = { hero: '#f7768e', content: '#7aa2f7', divider: '#e0af68', cta: '#9ece6a', footer: '#565f89', other: '#bb9af7' };
const TEMPLATE_CATEGORIES = ['Layout', 'Hero', 'Team', 'Produkt', 'Pricing', 'Workflow', 'CTA', 'Statistik', 'Timeline', 'Vergleich'];

const DOC_TYPE_LABELS: Record<string, string> = { presentation: 'Slides', document: 'Bericht', unknown: '?' };
const DOC_TYPE_COLORS: Record<string, { bg: string; fg: string; previewBg: string }> = {
  presentation: { bg: 'rgba(247,118,142,0.12)', fg: '#f7768e', previewBg: '#0a0f1e' },
  document:     { bg: 'rgba(122,162,247,0.12)', fg: '#7aa2f7', previewBg: '#f8f9fa' },
  unknown:      { bg: 'rgba(86,95,137,0.12)',   fg: '#565f89', previewBg: '#1a1b26' },
};

type DocTypeFilter = 'all' | 'presentation' | 'document';

function TemplateBrowser({ selectedIds, onToggle, onSetCategory, autoMatchResults }: {
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
  onSetCategory: (id: string, cat: string) => void;
  autoMatchResults?: Array<{ sectionId: string; score: number; reason: string }>;
}) {
  const [files, setFiles] = useState<TemplateFileInfo[]>([]);
  const [favorites, setFavorites] = useState<TemplateFavoritesData>({ favorites: [], categories: {} });
  const [loading, setLoading] = useState(true);
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [previewHtml, setPreviewHtml] = useState('');
  const [previewDocType, setPreviewDocType] = useState<string>('presentation');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [filter, setFilter] = useState('');
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);
  const [docTypeFilter, setDocTypeFilter] = useState<DocTypeFilter>('all');
  const [catEdit, setCatEdit] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${API}/templates`).then(r => r.json()).then(d => {
      setFiles(d.files || []);
      setFavorites(d.favorites || { favorites: [], categories: {} });
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  // Build file→documentType lookup
  const fileDocType = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of files) m.set(f.relPath, f.documentType || 'unknown');
    return m;
  }, [files]);

  async function toggleFavorite(sectionId: string, e: React.MouseEvent) {
    e.stopPropagation();
    try {
      const resp = await fetch(`${API}/templates/toggle-favorite`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sectionId }),
      });
      const data = await resp.json();
      if (data.ok) setFavorites({ favorites: data.favorites, categories: data.categories });
    } catch {}
  }

  async function setCategory(sectionId: string, category: string) {
    try {
      const resp = await fetch(`${API}/templates/set-category`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sectionId, category }),
      });
      const data = await resp.json();
      if (data.ok) setFavorites({ favorites: data.favorites, categories: data.categories });
      onSetCategory(sectionId, category);
    } catch {}
    setCatEdit(null);
  }

  async function handlePreview(sectionId: string, fileRelPath: string, e: React.MouseEvent) {
    e.stopPropagation();
    if (previewId === sectionId) { setPreviewId(null); setPreviewHtml(''); return; }
    setPreviewId(sectionId); setPreviewLoading(true);
    const dt = fileDocType.get(fileRelPath) || 'unknown';
    setPreviewDocType(dt);
    const bgColor = DOC_TYPE_COLORS[dt]?.previewBg || '#1a1b26';
    try {
      const resp = await fetch(`${API}/templates/section?id=${encodeURIComponent(sectionId)}`);
      const data = await resp.json();
      if (data.section && data.styleBlock) {
        setPreviewHtml(`<!DOCTYPE html><html><head><style>${data.styleBlock}</style></head><body style="margin:0;background:${bgColor};">${data.section.html}</body></html>`);
      } else {
        setPreviewHtml(`<pre style="color:red">Section not found</pre>`);
      }
    } catch { setPreviewHtml('<pre style="color:red">Fehler</pre>'); }
    setPreviewLoading(false);
  }

  // Collect all sections, with favorite/category/docType info
  const allSections: (TemplateSectionInfo & { isFavorite: boolean; category: string; docType: string })[] = [];
  for (const f of files) {
    for (const s of f.sections) {
      allSections.push({
        ...s,
        isFavorite: favorites.favorites.includes(s.id),
        category: favorites.categories[s.id] || '',
        docType: f.documentType || 'unknown',
      });
    }
  }

  // Count per type
  const typeCounts = useMemo(() => {
    const c = { all: allSections.length, presentation: 0, document: 0 };
    for (const s of allSections) {
      if (s.docType === 'presentation') c.presentation++;
      else if (s.docType === 'document') c.document++;
    }
    return c;
  }, [allSections]);

  // Filter
  const filtered = allSections.filter(s => {
    if (docTypeFilter !== 'all' && s.docType !== docTypeFilter) return false;
    if (showFavoritesOnly && !s.isFavorite && !selectedIds.has(s.id)) return false;
    if (filter) {
      const q = filter.toLowerCase();
      return s.title.toLowerCase().includes(q) || s.fileName.toLowerCase().includes(q) || s.type.toLowerCase().includes(q) || (s.category || '').toLowerCase().includes(q);
    }
    return true;
  });

  // Group by file, sort AI-matched files to top
  const aiMatchedIds = new Set((autoMatchResults || []).map(r => r.sectionId));
  const groupedByFile = new Map<string, typeof filtered>();
  for (const s of filtered) {
    const arr = groupedByFile.get(s.fileRelPath) || [];
    arr.push(s);
    groupedByFile.set(s.fileRelPath, arr);
  }
  // Sort: files containing AI matches first, auto-expand them
  if (aiMatchedIds.size > 0) {
    const sorted = new Map([...groupedByFile.entries()].sort((a, b) => {
      const aHasAi = a[1].some(s => aiMatchedIds.has(s.id)) ? 1 : 0;
      const bHasAi = b[1].some(s => aiMatchedIds.has(s.id)) ? 1 : 0;
      return bHasAi - aHasAi;
    }));
    groupedByFile.clear();
    for (const [k, v] of sorted) groupedByFile.set(k, v);
  }

  if (loading) return <div style={{ padding: 20, textAlign: 'center', color: 'var(--tn-text-muted)', fontSize: 11 }}>Lade Templates...</div>;

  return (
    <div>
      {/* Type filter tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
        {(['all', 'presentation', 'document'] as DocTypeFilter[]).map(t => {
          const active = docTypeFilter === t;
          const label = t === 'all' ? 'Alle' : t === 'presentation' ? 'Slides' : 'Berichte';
          const count = typeCounts[t] ?? 0;
          const color = t === 'all' ? 'var(--tn-text)' : DOC_TYPE_COLORS[t]?.fg || 'var(--tn-text-muted)';
          return (
            <div key={t} onClick={() => setDocTypeFilter(t)}
              style={{
                padding: '3px 10px', borderRadius: 4, cursor: 'pointer', fontSize: 10, fontWeight: 600,
                background: active ? (t === 'all' ? 'rgba(255,255,255,0.08)' : DOC_TYPE_COLORS[t]?.bg || 'rgba(255,255,255,0.08)') : 'transparent',
                color: active ? color : 'var(--tn-text-muted)',
                border: active ? `1px solid ${color}33` : '1px solid transparent',
                transition: 'all 0.15s',
              }}>
              {label} <span style={{ opacity: 0.6 }}>({count})</span>
            </div>
          );
        })}
      </div>

      {/* Search + Favorites */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8 }}>
        <input type="text" placeholder="Suchen..." value={filter} onChange={e => setFilter(e.target.value)}
          style={{ ...inputStyle, flex: 1, padding: '4px 8px', fontSize: 10 }} />
        <Chip active={showFavoritesOnly} onClick={() => setShowFavoritesOnly(!showFavoritesOnly)}>
          {'\u2605'} Favoriten
        </Chip>
      </div>

      {/* Selected count */}
      {selectedIds.size > 0 && (
        <div style={{ fontSize: 10, color: 'var(--tn-yellow, #e0af68)', marginBottom: 6, fontWeight: 600 }}>
          {selectedIds.size} Vorlage{selectedIds.size !== 1 ? 'n' : ''} ausgewahlt
        </div>
      )}

      {/* Content: file list + preview */}
      <div style={{ display: 'flex', gap: 8, minHeight: 200 }}>
        {/* Section list */}
        <div style={{
          flex: previewId ? '0 0 50%' : '1 1 100%',
          maxHeight: 350, overflow: 'auto',
          border: '1px solid var(--tn-border)', borderRadius: 6, padding: 6,
          background: 'var(--tn-bg-dark)', transition: 'flex 0.2s',
        }}>
          {filtered.length === 0 && (
            <div style={{ padding: 20, textAlign: 'center', color: 'var(--tn-text-muted)', fontSize: 11 }}>
              {files.length === 0 ? 'Keine HTML-Dateien im Business-Ordner gefunden.' : 'Keine Sections gefunden.'}
            </div>
          )}
          {Array.from(groupedByFile.entries()).map(([filePath, sections]) => {
            const hasAiMatches = sections.some(s => aiMatchedIds.has(s.id));
            const isExpanded = expandedFiles.has(filePath) || !!filter || showFavoritesOnly || hasAiMatches;
            const dt = fileDocType.get(filePath) || 'unknown';
            const dtStyle = DOC_TYPE_COLORS[dt] || DOC_TYPE_COLORS.unknown;
            return (
              <div key={filePath} style={{ marginBottom: 4 }}>
                {/* File header */}
                <div onClick={() => setExpandedFiles(prev => { const n = new Set(prev); n.has(filePath) ? n.delete(filePath) : n.add(filePath); return n; })}
                  style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 4px', cursor: 'pointer', borderRadius: 3 }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'rgba(122,162,247,0.06)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
                  <span style={{ fontSize: 9, color: 'var(--tn-text-muted)' }}>{isExpanded ? '\u25BE' : '\u25B8'}</span>
                  <span style={{ fontSize: 8, padding: '1px 5px', borderRadius: 3, background: dtStyle.bg, color: dtStyle.fg, fontWeight: 600, flexShrink: 0 }}>
                    {DOC_TYPE_LABELS[dt] || '?'}
                  </span>
                  <span style={{ fontSize: 10, color: 'var(--tn-blue)', fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
                    {filePath.split('/').pop()}
                  </span>
                  <span style={{ fontSize: 9, color: 'var(--tn-text-muted)' }}>{sections.length}s</span>
                </div>
                {/* Sections */}
                {isExpanded && sections.map(section => {
                  const isSelected = selectedIds.has(section.id);
                  const typeColor = SECTION_TYPE_COLORS[section.type] || '#565f89';
                  return (
                    <div key={section.id}>
                      <div
                        onClick={() => onToggle(section.id)}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 5, padding: '4px 6px 4px 18px',
                          cursor: 'pointer', borderRadius: 3, transition: 'all 0.1s',
                          background: isSelected ? 'rgba(224,175,104,0.08)' : previewId === section.id ? 'rgba(122,162,247,0.08)' : 'transparent',
                        }}
                        onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = 'rgba(122,162,247,0.04)'; }}
                        onMouseLeave={e => { if (!isSelected && previewId !== section.id) e.currentTarget.style.background = 'transparent'; }}>
                        <input type="checkbox" checked={isSelected} readOnly
                          style={{ cursor: 'pointer', accentColor: '#e0af68', flexShrink: 0 }} />
                        <StatusBadge color={typeColor}>{SECTION_TYPE_LABELS[section.type] || section.type}</StatusBadge>
                        {(() => { const aiMatch = autoMatchResults?.find(r => r.sectionId === section.id); return aiMatch ? (
                          <span title={aiMatch.reason} style={{ fontSize: 8, padding: '0 3px', borderRadius: 2, background: 'rgba(158,206,106,0.2)', color: '#9ece6a', fontWeight: 700, flexShrink: 0 }}>AI★{aiMatch.score}</span>
                        ) : null; })()}
                        <span style={{ fontSize: 11, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const,
                          color: isSelected ? 'var(--tn-text)' : 'var(--tn-text-muted)' }}>
                          {section.title}
                        </span>
                        {/* Category badge */}
                        {section.category && catEdit !== section.id && (
                          <span onClick={e => { e.stopPropagation(); setCatEdit(section.id); }}
                            style={{ fontSize: 8, padding: '1px 4px', borderRadius: 2, background: 'rgba(187,154,247,0.15)', color: '#bb9af7', cursor: 'pointer' }}>
                            {section.category}
                          </span>
                        )}
                        {/* Category editor */}
                        {catEdit === section.id && (
                          <div onClick={e => e.stopPropagation()} style={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
                            {TEMPLATE_CATEGORIES.map(cat => (
                              <span key={cat} onClick={() => setCategory(section.id, cat)}
                                style={{ fontSize: 8, padding: '1px 4px', borderRadius: 2, cursor: 'pointer',
                                  background: section.category === cat ? 'rgba(187,154,247,0.25)' : 'rgba(86,95,137,0.15)',
                                  color: section.category === cat ? '#bb9af7' : 'var(--tn-text-muted)' }}>
                                {cat}
                              </span>
                            ))}
                            <span onClick={() => { setCategory(section.id, ''); setCatEdit(null); }}
                              style={{ fontSize: 8, padding: '1px 4px', borderRadius: 2, cursor: 'pointer', color: 'var(--tn-text-muted)' }}>x</span>
                          </div>
                        )}
                        {/* Favorite star */}
                        <span onClick={e => toggleFavorite(section.id, e)}
                          style={{ cursor: 'pointer', fontSize: 12, color: section.isFavorite ? '#e0af68' : 'var(--tn-text-muted)', flexShrink: 0 }}>
                          {section.isFavorite ? '\u2605' : '\u2606'}
                        </span>
                        {/* Preview eye */}
                        <span onClick={e => handlePreview(section.id, section.fileRelPath, e)}
                          style={{ cursor: 'pointer', fontSize: 11, color: previewId === section.id ? 'var(--tn-blue)' : 'var(--tn-text-muted)', flexShrink: 0 }}
                          title="Vorschau">
                          {'\u{1F441}'}
                        </span>
                      </div>
                      {/* Inline preview text */}
                      {section.preview && isSelected && (
                        <div style={{ padding: '2px 6px 4px 42px', fontSize: 9, color: 'var(--tn-text-muted)', lineHeight: 1.4 }}>
                          {section.preview.slice(0, 120)}{section.preview.length > 120 ? '...' : ''}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

        {/* Preview pane */}
        {previewId && (
          <div style={{
            flex: '0 0 50%', maxHeight: 350, display: 'flex', flexDirection: 'column' as const,
            border: '1px solid var(--tn-border)', borderRadius: 6, overflow: 'hidden',
            background: DOC_TYPE_COLORS[previewDocType]?.previewBg || '#1a1b26',
          }}>
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '4px 8px', borderBottom: '1px solid var(--tn-border)', background: 'rgba(122,162,247,0.06)', flexShrink: 0,
            }}>
              <span style={{ fontSize: 10, color: 'var(--tn-text-muted)' }}>
                Vorschau {previewDocType === 'presentation' ? '(Dark)' : previewDocType === 'document' ? '(Light)' : ''}
              </span>
              <span onClick={() => { setPreviewId(null); setPreviewHtml(''); }}
                style={{ cursor: 'pointer', color: 'var(--tn-text-muted)', fontSize: 14, fontWeight: 700 }}>&times;</span>
            </div>
            <div style={{ flex: 1, overflow: 'hidden', minHeight: 0 }}>
              {previewLoading ? (
                <div style={{ padding: 20, textAlign: 'center', color: 'var(--tn-text-muted)', fontSize: 11 }}>Lade...</div>
              ) : (
                <iframe srcDoc={previewHtml}
                  style={{ width: '100%', height: '100%', border: 'none', background: DOC_TYPE_COLORS[previewDocType]?.previewBg || '#1a1b26' }}
                  sandbox="allow-same-origin" title="Section Preview" />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// Generation Config + Output (Steps 3+4)
// =============================================================================
function GenerationStep({ outputFormat, setOutputFormat, customInstructions, setCustomInstructions, templateSectionIds, onToggleTemplate, onSetTemplateCategory, onBack, onGenerate, generatedContent, loading, feedback, setFeedback, onSave, savedPath, revisions, activeRevisionIndex, onSwitchRevision, autoMatchResults, autoMatchLoading, autoMatchApplied, onRerunAutoMatch, onClearAutoMatch, claimTemplateMatches, groups }: {
  outputFormat: string; setOutputFormat: (v: string) => void;
  customInstructions: string; setCustomInstructions: (v: string) => void;
  templateSectionIds: Set<string>; onToggleTemplate: (id: string) => void; onSetTemplateCategory: (id: string, cat: string) => void;
  onBack: () => void; onGenerate: () => void; generatedContent: string; loading: boolean;
  feedback: string; setFeedback: (v: string) => void; onSave: () => void; savedPath: string | null;
  revisions: Revision[]; activeRevisionIndex: number; onSwitchRevision: (index: number) => void;
  autoMatchResults?: Array<{ sectionId: string; score: number; reason: string }>; autoMatchLoading?: boolean; autoMatchApplied?: boolean;
  onRerunAutoMatch?: () => void; onClearAutoMatch?: () => void;
  claimTemplateMatches?: Array<{ claimId: string; templateId: string; reason: string; templateTitle: string; templateType: string; templateFile: string; hasSvg: boolean }>;
  groups?: ClaimGroup[];
}) {
  const docTypes = [
    { value: 'presentation', label: 'Präsentation', template: 'TEMPLATE-PRESENTATION.html', desc: 'Dark Theme (Navy/Gold), Slides, Fullscreen' },
    { value: 'document', label: 'Bericht', template: 'TEMPLATE-DOCUMENT.html', desc: 'Light Theme (Weiss/Navy), A4, Print-Ready' },
  ];
  const activeDocType = docTypes.find(d => d.value === outputFormat) || docTypes[0];
  const [showCode, setShowCode] = useState(false);
  const [showConfig, setShowConfig] = useState(!generatedContent);
  const [templatePreviewHtml, setTemplatePreviewHtml] = useState('');
  const [templatePreviewLoading, setTemplatePreviewLoading] = useState(false);

  function toggleTemplatePreview() {
    if (templatePreviewHtml) { setTemplatePreviewHtml(''); return; }
    setTemplatePreviewLoading(true);
    fetch(`${API}/template-preview?file=shared/${activeDocType.template}`)
      .then(r => r.json())
      .then(d => { setTemplatePreviewHtml(d.html || ''); setTemplatePreviewLoading(false); })
      .catch(() => { setTemplatePreviewHtml('<p>Fehler beim Laden</p>'); setTemplatePreviewLoading(false); });
  }

  return (
    <div>
      {/* Config section — always accessible, collapsible when output exists */}
      {generatedContent && !loading && (
        <div
          onClick={() => setShowConfig(!showConfig)}
          style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, marginBottom: showConfig ? 10 : 12, padding: '4px 0' }}
        >
          <span style={{ fontSize: 10, color: 'var(--tn-text-muted)', transform: showConfig ? 'rotate(90deg)' : 'rotate(0)', transition: 'transform 0.15s' }}>▶</span>
          <SectionLabel style={{ marginBottom: 0, cursor: 'pointer' }}>Config</SectionLabel>
          <span style={{ fontSize: 10, color: 'var(--tn-text-muted)' }}>
            {outputFormat === 'presentation' ? 'Präsentation' : 'Bericht'}{templateSectionIds.size > 0 ? ` / ${templateSectionIds.size} Design-Hints` : ''}
          </span>
        </div>
      )}

      {(showConfig || (!generatedContent && !loading)) && !loading && (
        <div style={{ marginBottom: 14, paddingBottom: generatedContent ? 10 : 0, borderBottom: generatedContent ? '1px solid var(--tn-border)' : 'none' }}>
          {/* Dokumenttyp-Auswahl */}
          <SectionLabel>Dokumenttyp</SectionLabel>
          <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
            {docTypes.map(d => <Chip key={d.value} active={outputFormat === d.value} onClick={() => setOutputFormat(d.value)}>{d.label}</Chip>)}
          </div>

          {/* Standardvorlage — zeigt aktives Template */}
          <SectionLabel>Standardvorlage</SectionLabel>
          <div style={{ padding: '8px 10px', marginBottom: templatePreviewHtml ? 0 : 12, background: 'rgba(122,162,247,0.08)', border: '1px solid rgba(122,162,247,0.2)', borderRadius: templatePreviewHtml ? '6px 6px 0 0' : 6 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--tn-text)' }}>{activeDocType.label}</div>
                <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginTop: 2 }}>{activeDocType.desc}</div>
                <div style={{ fontSize: 9, color: 'var(--tn-text-dim, #565f89)', marginTop: 2, fontFamily: 'monospace' }}>shared/{activeDocType.template}</div>
              </div>
              <span onClick={toggleTemplatePreview}
                style={{ cursor: 'pointer', fontSize: 14, color: templatePreviewHtml ? 'var(--tn-blue, #7aa2f7)' : 'var(--tn-text-muted)', flexShrink: 0, padding: '4px 6px' }}
                title="Vorlage anzeigen">
                {'\u{1F441}'}
              </span>
            </div>
          </div>
          {templatePreviewLoading && (
            <div style={{ padding: 12, textAlign: 'center', color: 'var(--tn-text-muted)', fontSize: 11, border: '1px solid rgba(122,162,247,0.2)', borderTop: 'none', borderRadius: '0 0 6px 6px', marginBottom: 12 }}>Lade Vorlage...</div>
          )}
          {templatePreviewHtml && !templatePreviewLoading && (
            <div style={{ marginBottom: 12, border: '1px solid rgba(122,162,247,0.2)', borderTop: 'none', borderRadius: '0 0 6px 6px', overflow: 'hidden' }}>
              <iframe srcDoc={templatePreviewHtml}
                style={{ width: '100%', height: 300, border: 'none', background: activeDocType.value === 'presentation' ? '#0a0f1e' : '#fff' }}
                sandbox="allow-same-origin" title="Template Preview" />
            </div>
          )}

          {/* Claim-Template Assignments */}
          {claimTemplateMatches && claimTemplateMatches.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <SectionLabel>Claim → Vorlage Zuordnung <span style={{ color: '#9ece6a', fontWeight: 400, fontSize: 9 }}>({claimTemplateMatches.length} zugeordnet)</span></SectionLabel>
              <div style={{ border: '1px solid var(--tn-border)', borderRadius: 6, overflow: 'hidden', background: 'var(--tn-bg-dark)' }}>
                {claimTemplateMatches.map((m, i) => (
                  <div key={m.claimId} style={{
                    display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', fontSize: 10,
                    borderBottom: i < claimTemplateMatches.length - 1 ? '1px solid var(--tn-border)' : 'none',
                  }}>
                    {(() => {
                      const claim = groups?.flatMap(g => g.claims).find(c => c.id === m.claimId);
                      const claimText = claim?.text?.slice(0, 40) || m.claimId;
                      return <>
                        <span style={{ flex: '0 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, color: 'var(--tn-text)', maxWidth: '40%' }} title={claim?.text || m.claimId}>{claimText}</span>
                        <span style={{ color: 'var(--tn-text-muted)', flexShrink: 0 }}>→</span>
                        {m.hasSvg && <span style={{ fontSize: 8, padding: '0 3px', borderRadius: 2, background: 'rgba(158,206,106,0.2)', color: '#9ece6a', fontWeight: 700, flexShrink: 0 }}>SVG</span>}
                        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, color: 'var(--tn-blue)' }} title={m.reason}>
                          {m.templateTitle || m.templateId.slice(0, 8)}
                        </span>
                      </>;
                    })()}
                    <span onClick={() => {
                      // Remove this assignment
                      const updated = claimTemplateMatches.filter(x => x.claimId !== m.claimId);
                      // Would need to lift state — for now just toggle the template
                      onToggleTemplate(m.templateId);
                    }} style={{ cursor: 'pointer', color: 'var(--tn-text-muted)', fontSize: 10, flexShrink: 0 }} title="Vorlage entfernen">×</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Design-Hints: Beispiel-Slides/Sections als Referenz */}
          <SectionLabel>Design-Hints {templateSectionIds.size > 0 && <span style={{ color: '#e0af68', fontWeight: 700, fontSize: 10 }}>({templateSectionIds.size} ausgewahlt)</span>}</SectionLabel>

          {/* Auto-match banner */}
          {autoMatchLoading && (
            <div style={{ padding: '6px 10px', marginBottom: 6, background: 'rgba(122,162,247,0.08)', border: '1px solid rgba(122,162,247,0.2)', borderRadius: 6, fontSize: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ display: 'inline-block', fontSize: 10 }}>⟳</span>
              <span>AI analysiert Claims und wählt passende Design-Vorlagen...</span>
            </div>
          )}
          {autoMatchApplied && !autoMatchLoading && autoMatchResults && autoMatchResults.length > 0 && (
            <div style={{ padding: '6px 10px', marginBottom: 6, background: 'rgba(158,206,106,0.08)', border: '1px solid rgba(158,206,106,0.2)', borderRadius: 6, fontSize: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <span style={{ color: 'var(--tn-green, #9ece6a)', fontWeight: 600 }}>
                  ✦ AI hat {autoMatchResults.length} Design-Vorlagen vorgeschlagen
                </span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <span onClick={onRerunAutoMatch} style={{ cursor: 'pointer', color: 'var(--tn-blue)', textDecoration: 'underline' }}>Neu berechnen</span>
                  <span onClick={onClearAutoMatch} style={{ cursor: 'pointer', color: 'var(--tn-text-muted)', textDecoration: 'underline' }}>Zurucksetzen</span>
                </div>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: 3 }}>
                {autoMatchResults.slice(0, 8).map(r => (
                  <span key={r.sectionId} title={r.reason} style={{
                    padding: '1px 6px', borderRadius: 3, fontSize: 9, background: 'rgba(122,162,247,0.1)',
                    color: 'var(--tn-text)', border: '1px solid rgba(122,162,247,0.2)',
                  }}>
                    ★{r.score} {r.reason.slice(0, 30)}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginBottom: 6 }}>
            {autoMatchApplied ? 'AI-Vorschläge aktiv — manuell anpassen oder zurücksetzen' : `Beispiel-${activeDocType.value === 'presentation' ? 'Slides' : 'Abschnitte'} aus bestehenden Dokumenten als visuelle Referenz`}
          </div>
          <TemplateBrowser selectedIds={templateSectionIds} onToggle={onToggleTemplate} onSetCategory={onSetTemplateCategory} autoMatchResults={autoMatchResults} />

          <SectionLabel style={{ marginTop: 12 }}>Zusatzliche Anweisungen</SectionLabel>
          <textarea rows={3} style={{ ...inputStyle, resize: 'vertical' as const }} placeholder="z.B. 'Dark glassmorphism theme, SVG diagrams, gold accents'" value={customInstructions} onChange={e => setCustomInstructions(e.target.value)} />

          {!generatedContent && (
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--tn-border)' }}>
              <button style={btnSecondary} onClick={onBack}>Claims</button>
              <button style={btnPrimary} onClick={onGenerate}>Generieren</button>
            </div>
          )}
        </div>
      )}

      {loading && (
        <div style={{ padding: 40, textAlign: 'center' }}>
          <div style={{ fontSize: 13, marginBottom: 8 }}>Generierung lauft...</div>
          <div style={{ height: 3, background: 'var(--tn-border)', borderRadius: 2, overflow: 'hidden', maxWidth: 200, margin: '0 auto' }}>
            <div style={{ height: '100%', background: 'var(--tn-blue)', width: '60%', animation: 'pulse 1.5s infinite' }} />
          </div>
        </div>
      )}

      {generatedContent && !loading && (<>
        {/* Revision bar */}
        {revisions.length > 0 && (
          <div style={{ display: 'flex', gap: 4, marginBottom: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginRight: 4 }}>Revisionen:</span>
            {revisions.map((rev, i) => (
              <span key={rev.id} onClick={() => onSwitchRevision(i)}
                style={{
                  padding: '2px 8px', borderRadius: 4, fontSize: 10, cursor: 'pointer',
                  fontWeight: i === activeRevisionIndex ? 700 : 400,
                  background: i === activeRevisionIndex ? 'var(--tn-blue, #7aa2f7)' : 'rgba(122,162,247,0.1)',
                  color: i === activeRevisionIndex ? '#fff' : 'var(--tn-text-muted)',
                  transition: 'all 0.15s',
                }}
                title={rev.changePrompt || 'Erstgenerierung'}>
                {rev.id}
              </span>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <SectionLabel style={{ marginBottom: 0 }}>
            {revisions.length > 0 && activeRevisionIndex >= 0
              ? `${revisions[activeRevisionIndex]?.id || 'Dokument'}`
              : 'Generiertes Dokument'}
            {' '}<span style={{ fontFamily: 'monospace', fontWeight: 400 }}>({generatedContent.length} chars)</span>
          </SectionLabel>
          <button style={{ ...btnSecondary, fontSize: 9, padding: '2px 8px' }} onClick={() => setShowCode(!showCode)}>
            {showCode ? 'Vorschau' : 'Code'}
          </button>
        </div>

        {/* HTML preview (default) or code view */}
        {!showCode ? (
          <iframe
            srcDoc={generatedContent}
            style={{ width: '100%', height: 500, border: '1px solid var(--tn-border)', borderRadius: 6, background: '#fff' }}
            sandbox="allow-same-origin allow-scripts"
            title="HTML Preview"
          />
        ) : (
          <div style={{ maxHeight: 400, overflow: 'auto', ...previewStyle }}>{generatedContent}</div>
        )}

        {savedPath && (
          <div style={{ marginTop: 10, padding: '6px 10px', background: 'rgba(158,206,106,0.1)', border: '1px solid rgba(158,206,106,0.3)', borderRadius: 6, fontSize: 11 }}>
            <span style={{ color: 'var(--tn-green, #9ece6a)', fontWeight: 600 }}>Gespeichert:</span>{' '}
            <span style={{ fontFamily: 'monospace', fontSize: 10, color: 'var(--tn-text)', wordBreak: 'break-all' as const }}>{savedPath}</span>
          </div>
        )}

        {/* Change request section */}
        <SectionLabel style={{ marginTop: 14 }}>Anderung anfordern</SectionLabel>
        <textarea rows={2} style={{ ...inputStyle, resize: 'vertical' as const }} placeholder="z.B. 'Slide 3 kurzen, mehr Kennzahlen, Diagramm zu Umsatz hinzufugen'" value={feedback} onChange={e => setFeedback(e.target.value)} />

        {/* Active revision info */}
        {revisions.length > 0 && activeRevisionIndex >= 0 && revisions[activeRevisionIndex]?.changePrompt && (
          <div style={{ marginTop: 6, padding: '4px 8px', background: 'rgba(122,162,247,0.06)', borderRadius: 4, fontSize: 10, color: 'var(--tn-text-muted)' }}>
            Letzte Anderung ({revisions[activeRevisionIndex].id}): {revisions[activeRevisionIndex].changePrompt}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--tn-border)' }}>
          <div style={{ display: 'flex', gap: 6 }}>
            <button style={btnSecondary} onClick={onBack}>Claims</button>
            <button style={btnSecondary} onClick={onSave}>Speichern</button>
            <button style={btnSecondary} onClick={() => navigator.clipboard.writeText(generatedContent)}>Kopieren</button>
          </div>
          <button style={btnPrimary} onClick={onGenerate}>
            {revisions.length === 0 ? 'Generieren' : feedback ? 'Revision erstellen' : 'Neu generieren'}
          </button>
        </div>
      </>)}
    </div>
  );
}

// =============================================================================
// Shared UI Primitives
// =============================================================================
function SectionLabel({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--tn-text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase' as const, marginBottom: 6, ...style }}>{children}</div>;
}

function StatusBadge({ children, color }: { children: React.ReactNode; color: string }) {
  return <span style={{ fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 3, background: `${color}20`, color, flexShrink: 0 }}>{children}</span>;
}

function Chip({ children, active, onClick }: { children: React.ReactNode; active: boolean; onClick: () => void }) {
  return (
    <span onClick={onClick} style={{
      padding: '4px 10px', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: active ? 700 : 400,
      border: `1px solid ${active ? 'var(--tn-blue)' : 'var(--tn-border)'}`,
      background: active ? 'rgba(122,162,247,0.15)' : 'transparent',
      color: active ? 'var(--tn-blue)' : 'var(--tn-text-muted)', transition: 'all 0.15s',
    }}>{children}</span>
  );
}

function VariantPill({ children, active, onClick, title }: { children: React.ReactNode; active: boolean; onClick: () => void; title?: string }) {
  return (
    <span onClick={onClick} title={title} style={{
      fontSize: 9, padding: '2px 6px', borderRadius: 3, cursor: 'pointer', transition: 'all 0.15s',
      border: `1px solid ${active ? 'var(--tn-blue)' : 'var(--tn-border)'}`,
      background: active ? 'rgba(122,162,247,0.15)' : 'transparent',
      color: active ? 'var(--tn-blue)' : 'var(--tn-text-muted)', fontWeight: active ? 700 : 400,
    }}>{children}</span>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '6px 8px', border: '1px solid var(--tn-border)', borderRadius: 4,
  background: 'var(--tn-bg-dark)', color: 'var(--tn-text)', fontSize: 11, fontFamily: 'inherit',
  outline: 'none', boxSizing: 'border-box' as const,
};

const btnPrimary: React.CSSProperties = {
  border: 'none', padding: '5px 14px', borderRadius: 4, fontSize: 11, fontWeight: 600,
  cursor: 'pointer', transition: 'all 0.15s', background: 'var(--tn-blue, #7aa2f7)', color: '#fff',
};

const btnSecondary: React.CSSProperties = {
  border: 'none', padding: '5px 14px', borderRadius: 4, fontSize: 11, fontWeight: 600,
  cursor: 'pointer', transition: 'all 0.15s', background: 'var(--tn-surface, #2a2e3f)', color: 'var(--tn-text)',
};

const previewStyle: React.CSSProperties = {
  padding: 12, background: 'var(--tn-bg-dark)', borderRadius: 6,
  border: '1px solid var(--tn-border)', fontSize: 12, lineHeight: 1.7,
  whiteSpace: 'pre-wrap' as const, fontFamily: 'monospace',
};

// =============================================================================
// Main Panel
// =============================================================================
export default function ReportBuilder() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionName, setSessionName] = useState('');
  const [showPicker, setShowPicker] = useState(true);
  const [step, setStep] = useState<Step>('source-select');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selectedSources, setSelectedSources] = useState<Set<string>>(new Set());
  const [brief, setBrief] = useState('');
  const [extractionPrompt, setExtractionPrompt] = useState('');
  const [groups, setGroups] = useState<ClaimGroup[]>([]);
  const [draftOutline, setDraftOutline] = useState<DraftSection[]>([]);
  const [generalNotes, setGeneralNotes] = useState('');
  const [outputFormat, setOutputFormat] = useState('presentation');
  const [tone, setTone] = useState('formal');
  const [language, setLanguage] = useState('de');
  const [customInstructions, setCustomInstructions] = useState('');
  const [templateSectionIds, setTemplateSectionIds] = useState<Set<string>>(new Set());
  const [generatedContent, setGeneratedContent] = useState('');
  const [feedback, setFeedback] = useState('');
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [activeRevisionIndex, setActiveRevisionIndex] = useState(-1);

  // Claim-template matching state
  const [autoMatchLoading, setAutoMatchLoading] = useState(false);
  const [claimTemplateMatches, setClaimTemplateMatches] = useState<Array<{
    claimId: string; templateId: string; reason: string; rank: number; selected: boolean;
    templateTitle: string; templateType: string; templateFile: string; templatePreview: string; hasSvg: boolean;
  }>>([]);
  const [autoMatchApplied, setAutoMatchApplied] = useState(false);

  // Legacy compat: derive autoMatchResults from selected claimTemplateMatches for TemplateBrowser
  const autoMatchResults = claimTemplateMatches.filter(m => m.selected).map(m => ({ sectionId: m.templateId, score: m.hasSvg ? 9 : 7, reason: m.reason }));

  // Select a template for a claim (toggle: deselect others for same claim, select this one)
  function handleSelectTemplate(claimId: string, templateId: string) {
    setClaimTemplateMatches(prev => prev.map(m => {
      if (m.claimId !== claimId) return m;
      return { ...m, selected: m.templateId === templateId };
    }));
  }

  async function runClaimTemplateMatch() {
    if (!sessionId) return;
    setAutoMatchLoading(true);
    try {
      const resp = await fetch(`${API}/match-claim-templates`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Match failed');
      const matches = data.matches || [];
      setClaimTemplateMatches(matches);

      // Apply selected (rank 1) to session
      const selectedMatches = matches.filter((m: any) => m.selected);
      await fetch(`${API}/sessions/${sessionId}/claim-templates`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assignments: selectedMatches }),
      });

      // Update local templateSectionIds (only selected ones)
      const newIds = new Set(selectedMatches.map((m: any) => m.templateId).filter(Boolean));
      setTemplateSectionIds(newIds);
      setAutoMatchApplied(true);

      // Update local groups with templateId assignments (rank 1 only)
      setGroups(prev => prev.map(g => ({
        ...g,
        claims: g.claims.map(c => {
          const match = selectedMatches.find((m: any) => m.claimId === c.id);
          return match ? { ...c, templateId: match.templateId, templateReason: match.reason } : c;
        }),
      })));
    } catch (err: any) {
      console.error('Claim-template match failed:', err);
    } finally {
      setAutoMatchLoading(false);
    }
  }

  function handleClaimsToConfig() {
    setStep('generation');
    // Auto-match if no assignments exist yet
    const hasAssignments = groups.some(g => g.claims.some(c => (c as any).templateId));
    if (!hasAssignments) {
      runClaimTemplateMatch();
    }
  }

  // Normalize old-format claims (included→selected, userNote→note, add missing variants)
  function normalizeGroups(groups: any[]): ClaimGroup[] {
    return (groups || []).map((g: any) => ({
      ...g,
      groupName: g.groupName || g.title || 'Gruppe',
      claims: (g.claims || []).map((c: any) => ({
        ...c,
        selected: c.selected ?? c.included ?? false,
        context: c.context ?? '',
        note: c.note ?? c.userNote ?? '',
        variants: c.variants || [],
        selectedVariant: c.selectedVariant ?? -1,
        weight: c.weight ?? 3,
        order: c.order ?? 0,
      })),
    }));
  }

  // Load existing session
  async function loadSession(id: string) {
    try {
      const resp = await fetch(`${API}/sessions/${id}`);
      const data = await resp.json();
      const s = data.session;
      if (!s) throw new Error('Not found');
      setSessionId(s.id); setSessionName(s.name || '');
      setSelectedSources(new Set(s.sources || [])); setBrief(s.brief || ''); setExtractionPrompt(s.extractionPrompt || '');
      const loadedGroups = normalizeGroups(s.groups);
      setGroups(loadedGroups); setDraftOutline(s.draftOutline || []);
      setGeneralNotes(s.generalNotes || ''); setOutputFormat((s.outputFormat === 'presentation' || s.outputFormat === 'document') ? s.outputFormat : 'presentation');
      setTone(s.tone || 'formal'); setLanguage(s.language || 'de');
      setCustomInstructions(s.customInstructions || ''); setTemplateSectionIds(new Set(s.templateSectionIds || []));
      const loadedContent = s.generatedContent || '';
      setGeneratedContent(loadedContent);
      setRevisions(s.revisions || []);
      setActiveRevisionIndex(s.activeRevisionIndex ?? -1);
      setShowPicker(false);
      // Restore claim-template matches from session (persisted by server)
      if (s.claimTemplateMatches && s.claimTemplateMatches.length > 0) {
        setClaimTemplateMatches(s.claimTemplateMatches);
        setAutoMatchApplied(true);
      } else {
        setClaimTemplateMatches([]);
        setAutoMatchApplied(false);
      }
      // Derive correct step from actual data — don't trust persisted step blindly
      const totalClaims = loadedGroups.reduce((a: number, g: any) => a + (g.claims?.length || 0), 0);
      let derivedStep: Step = s.step || 'source-select';
      if (loadedContent && loadedContent.length > 100) {
        derivedStep = 'review';
      } else if (totalClaims > 0) {
        derivedStep = derivedStep === 'generation' ? 'generation' : 'claim-curation';
      }
      setStep(derivedStep);
    } catch (err: any) { setError(err.message); }
  }

  // Create new
  async function createSession() {
    try {
      const resp = await fetch(`${API}/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const data = await resp.json();
      setSessionId(data.session?.id); setSessionName(''); setStep('source-select');
      setSelectedSources(new Set()); setBrief(''); setExtractionPrompt(''); setGroups([]); setDraftOutline([]);
      setGeneralNotes(''); setOutputFormat('presentation'); setTone('formal'); setLanguage('de');
      setCustomInstructions(''); setTemplateSectionIds(new Set()); setGeneratedContent(''); setFeedback('');
      setRevisions([]); setActiveRevisionIndex(-1); setShowPicker(false);
    } catch { setError('Session konnte nicht erstellt werden'); }
  }

  // Persist
  const persistRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!sessionId || showPicker) return;
    if (persistRef.current) clearTimeout(persistRef.current);
    persistRef.current = setTimeout(() => {
      fetch(`${API}/sessions/${sessionId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ step, groups, draftOutline, generalNotes, outputFormat, tone, language, customInstructions, templateSectionIds: [...templateSectionIds], generatedContent, sources: [...selectedSources], brief, extractionPrompt }),
      }).catch(() => {});
    }, 1500);
  }, [sessionId, showPicker, step, groups, generalNotes, outputFormat, tone, language, customInstructions, templateSectionIds, generatedContent, brief]);

  function toggleSource(path: string) {
    setSelectedSources(prev => { const n = new Set(prev); n.has(path) ? n.delete(path) : n.add(path); return n; });
  }

  // Poll session status until extraction completes (survives workspace switches)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  // On load: if session is already extracting or generating, start polling
  useEffect(() => {
    if (!sessionId) return;
    const checkResume = async () => {
      try {
        const resp = await fetch(`${API}/sessions/${sessionId}`);
        const data = await resp.json();
        const s = data.session;
        if (s?.generationStatus === 'extracting') {
          setLoading(true);
          startPolling(sessionId);
        } else if (s?.generationStatus === 'generating') {
          setLoading(true); setStep('review'); setGeneratedContent('');
          startPolling(sessionId);
        }
      } catch {}
    };
    checkResume();
  }, [sessionId]);

  function startPolling(sid: string) {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const resp = await fetch(`${API}/sessions/${sid}`);
        const data = await resp.json();
        const s = data.session;
        if (!s) return;
        if (s.generationStatus === 'idle' && s.step === 'claim-curation') {
          // Extraction finished successfully
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          setGroups(normalizeGroups(s.groups)); setDraftOutline(s.draftOutline || []);
          setStep('claim-curation'); setLoading(false); setError(null);
          runClaimTemplateMatch();
        } else if (s.generationStatus === 'done' && s.step === 'review') {
          // Generation finished successfully
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          setGeneratedContent(s.generatedContent || '');
          setRevisions(s.revisions || []);
          setActiveRevisionIndex(s.activeRevisionIndex ?? -1);
          setStep('review'); setLoading(false); setError(null); setFeedback('');
        } else if (s.generationStatus === 'error') {
          // Extraction or generation failed
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          setError(s.error || 'Operation failed'); setLoading(false);
        }
        // else: still extracting/generating, keep polling
      } catch {}
    }, 2000);
  }

  async function handleExtract() {
    if (!sessionId) return;
    setLoading(true); setError(null);
    try {
      const resp = await fetch(`${API}/extract`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, sources: [...selectedSources], brief, extractionPrompt }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Extraction failed');
      // Backend responds immediately — poll for results
      startPolling(sessionId);
    } catch (err: any) { setError(err.message); setLoading(false); }
  }

  function updateClaim(groupId: string, claimId: string, update: Partial<Claim>) {
    setGroups(prev => prev.map(g => g.id === groupId ? { ...g, claims: g.claims.map(c => c.id === claimId ? { ...c, ...update } : c) } : g));
  }

  function toggleGroup(groupId: string, selected: boolean) {
    setGroups(prev => prev.map(g => g.id === groupId ? { ...g, claims: g.claims.map(c => ({ ...c, selected })) } : g));
  }

  async function handleGenerate() {
    if (!sessionId) return;
    const isRevision = revisions.length > 0 && feedback.trim().length > 0;
    setLoading(true); setError(null); setStep('review'); setGeneratedContent('');
    try {
      // Persist current config before generating
      await fetch(`${API}/sessions/${sessionId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groups, generalNotes, outputFormat, tone, language, customInstructions, templateSectionIds: [...templateSectionIds] }),
      });
      const resp = await fetch(`${API}/generate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, feedback: feedback || undefined, revisionMode: isRevision }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Generation failed');
      // Backend responds immediately — poll for results
      startPolling(sessionId);
    } catch (err: any) { setError(err.message); setLoading(false); }
  }

  async function switchRevision(index: number) {
    if (index < 0 || index >= revisions.length) return;
    setActiveRevisionIndex(index);
    setGeneratedContent(revisions[index].html);
    if (sessionId) {
      fetch(`${API}/sessions/${sessionId}/active-revision`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ index }),
      }).catch(() => {});
    }
  }

  const [savedPath, setSavedPath] = useState<string | null>(null);

  async function handleSave() {
    if (!sessionId) return;
    try {
      const resp = await fetch(`${API}/save`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId }) });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error);
      setSavedPath(data.path);
    } catch (err: any) { setError(err.message); }
  }

  const steps: { key: Step; label: string }[] = [
    { key: 'source-select', label: '1. Quellen' }, { key: 'claim-curation', label: '2. Claims' },
    { key: 'generation', label: '3. Config' }, { key: 'review', label: '4. Output' },
  ];
  const stepIdx = steps.findIndex(s => s.key === step);

  // Session Picker
  if (showPicker) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column' as const, height: '100%', background: 'var(--tn-surface, var(--tn-bg))', color: 'var(--tn-text)', fontFamily: 'var(--tn-font, monospace)', fontSize: 13 }}>
        <div style={{ background: 'var(--tn-bg-dark)', borderBottom: '2px solid var(--tn-border)', padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--tn-blue, #7aa2f7)' }}>Report Builder</span>
        </div>
        <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
          <SessionPicker onSelect={loadSession} onCreate={createSession} />
        </div>
      </div>
    );
  }

  // Active Session
  return (
    <div style={{ display: 'flex', flexDirection: 'column' as const, height: '100%', background: 'var(--tn-surface, var(--tn-bg))', color: 'var(--tn-text)', fontFamily: 'var(--tn-font, monospace)', fontSize: 13 }}>
      {/* Header */}
      <div style={{ background: 'var(--tn-bg-dark)', borderBottom: '2px solid var(--tn-border)', padding: '8px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span onClick={() => setShowPicker(true)} style={{ cursor: 'pointer', color: 'var(--tn-text-muted)', fontSize: 14, lineHeight: '1' }} title="Sessions">&larr;</span>
          <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--tn-blue, #7aa2f7)' }}>Report Builder</span>
          {sessionName && <span style={{ fontSize: 10, color: 'var(--tn-text-muted)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>— {sessionName}</span>}
        </div>
        {sessionId && <span style={{ fontSize: 9, color: 'var(--tn-text-muted)', fontFamily: 'monospace' }}>{sessionId.slice(0, 8)}</span>}
      </div>

      {/* Step Bar */}
      <div style={{ display: 'flex', gap: 4, padding: '6px 12px', borderBottom: '1px solid var(--tn-border)', background: 'var(--tn-bg-dark)', flexShrink: 0 }}>
        {steps.map((st, i) => (
          <span key={st.key} onClick={() => i < stepIdx && setStep(st.key)} style={{
            padding: '3px 10px', borderRadius: 4, fontSize: 10, fontWeight: step === st.key ? 700 : 400,
            cursor: i < stepIdx ? 'pointer' : 'default', transition: 'all 0.15s',
            background: step === st.key ? 'var(--tn-blue, #7aa2f7)' : i < stepIdx ? 'rgba(158,206,106,0.15)' : 'transparent',
            color: step === st.key ? '#fff' : i < stepIdx ? 'var(--tn-green)' : 'var(--tn-text-muted)',
            opacity: step === st.key || i < stepIdx ? 1 : 0.5,
          }}>{st.label}</span>
        ))}
      </div>

      {/* Error */}
      {error && (
        <div style={{ padding: '6px 12px', fontSize: 11, background: 'rgba(247,118,142,0.1)', color: 'var(--tn-red, #f7768e)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
          <span>{error}</span><span onClick={() => setError(null)} style={{ cursor: 'pointer', fontWeight: 700 }}>x</span>
        </div>
      )}

      {/* Body */}
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0, padding: 12 }}>
        {step === 'source-select' && <SourceSelector selected={selectedSources} onToggle={toggleSource} onExtract={handleExtract} brief={brief} setBrief={setBrief} extractionPrompt={extractionPrompt} setExtractionPrompt={setExtractionPrompt} loading={loading} />}
        {step === 'claim-curation' && <ClaimCuration groups={groups} draftOutline={draftOutline} onChange={updateClaim} onToggleGroup={toggleGroup} generalNotes={generalNotes} setGeneralNotes={setGeneralNotes} onBack={() => setStep('source-select')} onNext={handleClaimsToConfig} claimTemplateMatches={claimTemplateMatches} onSelectTemplate={handleSelectTemplate} />}
        {(step === 'generation' || step === 'review') && <GenerationStep outputFormat={outputFormat} setOutputFormat={setOutputFormat} customInstructions={customInstructions} setCustomInstructions={setCustomInstructions} templateSectionIds={templateSectionIds} onToggleTemplate={(id) => setTemplateSectionIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; })} onSetTemplateCategory={() => {}} onBack={() => setStep('claim-curation')} onGenerate={handleGenerate} generatedContent={generatedContent} loading={loading} feedback={feedback} setFeedback={setFeedback} onSave={handleSave} savedPath={savedPath} revisions={revisions} activeRevisionIndex={activeRevisionIndex} onSwitchRevision={switchRevision} autoMatchResults={autoMatchResults} autoMatchLoading={autoMatchLoading} autoMatchApplied={autoMatchApplied} onRerunAutoMatch={runClaimTemplateMatch} onClearAutoMatch={() => { setTemplateSectionIds(new Set()); setAutoMatchApplied(false); setClaimTemplateMatches([]); }} claimTemplateMatches={claimTemplateMatches} groups={groups} />}
      </div>
    </div>
  );
}
