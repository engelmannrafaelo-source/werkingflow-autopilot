import React, { useState, useEffect, useCallback, useRef, useMemo, useLayoutEffect } from 'react';
import { resilientFetch } from '../../../../utils/resilientFetch';
import FilePreviewSidebar from '../FilePreviewSidebar';
import { validateApiResponse } from '../../../../lib/validateApiResponse';

// ─── Types ──────────────────────────────────────────────────────────────────
interface DepNode {
  id: string;
  layer: number | null;
  label: string;
  status: string | null;
  score: number | null;
  coverage: number | null;
  duration: number | null;
  email: string | null;
  files: { key: string; name: string; path: string; size: number | null }[];
  requires_scenarios: string[];
  requires_artifacts: { type: string }[];
  skip_setup: boolean;
  first_active_step: number | null;
}

interface DepEdge { from: string; to: string | null; type: string; artifact_type?: string; }
interface DepUser { email: string; count: number; layers: number[]; }
interface DepFile { name: string; path: string; size: number | null; scenarios: string[]; }

interface DepGraphData {
  app: string;
  generated_at?: string;
  nodes: DepNode[];
  edges: DepEdge[];
  users?: DepUser[];
  files?: DepFile[];
  summary?: { total?: number; with_deps?: number; with_files?: number; skip_setup?: number; unique_users?: number; unique_files?: number; };
}

interface Brick { node: DepNode; layer: number; wave: number; }
interface LayerStack { layer: number; waves: Brick[][]; totalBricks: number; }
interface ConnLine { x1: number; y1: number; x2: number; y2: number; color?: string; dashed?: boolean; }

// ─── Constants ──────────────────────────────────────────────────────────────
const LAYER_NAMES: Record<number, string> = {
  [-1]: 'Unassigned', 0: 'L0 Contract', 1: 'L1 Backend',
  2: 'L2 Components', 3: 'L3 Workflows', 4: 'L4 Golden',
};
const LAYER_COLORS: Record<number, string> = {
  [-1]: '#565f89', 0: '#7aa2f7', 1: '#9ece6a',
  2: '#e0af68', 3: '#bb9af7', 4: '#f7768e',
};

// ─── Main Component ─────────────────────────────────────────────────────────
export default function DependenciesTab() {
  const [apps, setApps] = useState<string[]>([]);
  const [selectedApp, setSelectedApp] = useState<string>('');
  const [data, setData] = useState<DepGraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredFile, setHoveredFile] = useState<string | null>(null);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const brickRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const fileRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [connLines, setConnLines] = useState<ConnLine[]>([]);
  const [svgSize, setSvgSize] = useState({ w: 0, h: 0 });

  // ─── Data fetching ──────────────────────────────────────────────────────
  const fetchApps = useCallback(async () => {
    if ((window as any).__cuiServerAlive === false) return;
    try {
      const res = await resilientFetch('/api/qa/dependency-graph/apps');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setApps(json.apps || []);
      if (json.apps?.length > 0 && !selectedApp) setSelectedApp(json.apps[0]);
    } catch (err) { console.warn('[QADeps] fetch apps failed:', err); }
  }, [selectedApp]);

  const fetchGraph = useCallback(async () => {
    if (!selectedApp || (window as any).__cuiServerAlive === false) return;
    try {
      setError(null); setLoading(true);
      const res = await resilientFetch(`/api/qa/dependency-graph/${selectedApp}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = await res.json();
      const validated = validateApiResponse<DepGraphData>(raw, `/api/qa/dependency-graph/${selectedApp}`, {
        app: 'string',
        nodes: 'array',
        edges: 'array',
      });
      setData(validated);
      if (retryTimer.current) { clearTimeout(retryTimer.current); retryTimer.current = null; }
    } catch (err) {
      console.warn('[QADeps] fetch graph failed:', err);
      setError(err instanceof Error ? err.message : 'Failed to load');
      retryTimer.current = setTimeout(fetchGraph, 5000);
    } finally { setLoading(false); }
  }, [selectedApp]);

  useEffect(() => { fetchApps(); }, [fetchApps]);
  useEffect(() => {
    if (selectedApp) { fetchGraph(); setSelectedId(null); setHoveredId(null); setHoveredFile(null); setPreviewPath(null); }
    return () => { if (retryTimer.current) clearTimeout(retryTimer.current); };
  }, [selectedApp, fetchGraph]);

  // ─── Build stacking model (topological wave sort) ───────────────────────
  const stacks = useMemo((): LayerStack[] => {
    if (!data) return [];
    const layerGroups: Record<number, DepNode[]> = {};
    for (const n of data.nodes) {
      const l = n.layer ?? -1;
      if (!layerGroups[l]) layerGroups[l] = [];
      layerGroups[l].push(n);
    }
    const result: LayerStack[] = [];
    for (const layerNum of Object.keys(layerGroups).map(Number).sort((a, b) => a - b)) {
      const nodes = layerGroups[layerNum];
      const idSet = new Set(nodes.map(n => n.id));
      const localDeps = new Map<string, Set<string>>();
      for (const n of nodes) {
        const deps = new Set<string>();
        for (const d of n.requires_scenarios) { if (idSet.has(d)) deps.add(d); }
        localDeps.set(n.id, deps);
      }
      const nodeWave = new Map<string, number>();
      const remaining = new Set(nodes.map(n => n.id));
      let wave = 0;
      while (remaining.size > 0) {
        const ready: string[] = [];
        for (const id of remaining) {
          if ([...localDeps.get(id)!].every(d => !remaining.has(d))) ready.push(id);
        }
        if (ready.length === 0) { for (const id of remaining) nodeWave.set(id, wave); break; }
        for (const id of ready) { nodeWave.set(id, wave); remaining.delete(id); }
        wave++;
      }
      const waves: Brick[][] = [];
      for (const n of nodes) {
        const w = nodeWave.get(n.id) ?? 0;
        while (waves.length <= w) waves.push([]);
        waves[w].push({ node: n, layer: layerNum, wave: w });
      }
      for (const row of waves) {
        row.sort((a, b) => {
          if ((b.node.score ?? -1) !== (a.node.score ?? -1)) return (b.node.score ?? -1) - (a.node.score ?? -1);
          return a.node.label.localeCompare(b.node.label);
        });
      }
      result.push({ layer: layerNum, waves, totalBricks: nodes.length });
    }
    return result;
  }, [data]);

  // ─── Build lookup maps ──────────────────────────────────────────────────
  const activeId = selectedId || hoveredId;

  const chainIds = useMemo(() => {
    if (!activeId || !data) return null;
    const ids = new Set<string>([activeId]);
    const walkUp = (id: string) => {
      const n = data.nodes.find(x => x.id === id);
      if (n) for (const d of n.requires_scenarios) { if (!ids.has(d)) { ids.add(d); walkUp(d); } }
    };
    const walkDown = (id: string) => {
      for (const n of data.nodes) {
        if (n.requires_scenarios.includes(id) && !ids.has(n.id)) { ids.add(n.id); walkDown(n.id); }
      }
    };
    walkUp(activeId);
    walkDown(activeId);
    return ids;
  }, [activeId, data]);

  // Files connected to active node
  const activeFiles = useMemo(() => {
    if (!activeId || !data) return null;
    const node = data.nodes.find(n => n.id === activeId);
    if (!node) return null;
    return new Set(node.files.map(f => f.path));
  }, [activeId, data]);

  // Scenarios connected to the hovered file
  const hoveredFileScenarios = useMemo(() => {
    if (!hoveredFile || !data) return null;
    const file = (data.files ?? []).find(f => f.path === hoveredFile);
    if (!file) return null;
    return new Set(file.scenarios);
  }, [hoveredFile, data]);

  // Node → file paths map
  const nodeFileMap = useMemo(() => {
    if (!data) return new Map<string, Set<string>>();
    const m = new Map<string, Set<string>>();
    for (const file of (data.files ?? [])) {
      for (const sId of file.scenarios) {
        if (!m.has(sId)) m.set(sId, new Set());
        m.get(sId)!.add(file.path);
      }
    }
    return m;
  }, [data]);

  // Group files by extension
  const fileGroups = useMemo(() => {
    if (!data) return [];
    const groups: Record<string, DepFile[]> = {};
    for (const f of (data.files ?? [])) {
      const ext = f.name.includes('.') ? f.name.split('.').pop()!.toLowerCase() : 'other';
      const cat = ['pdf'].includes(ext) ? 'PDF' :
                  ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext) ? 'Images' :
                  ['xlsx', 'csv', 'xls'].includes(ext) ? 'Data' :
                  ['json', 'txt', 'md', 'yaml', 'yml'].includes(ext) ? 'Config' :
                  ['wfreport', 'wfpres'].includes(ext) ? 'Templates' : 'Other';
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(f);
    }
    // Sort groups by total size desc
    return Object.entries(groups).sort((a, b) => {
      const sizeA = a[1].reduce((s, f) => s + (f.size || 0), 0);
      const sizeB = b[1].reduce((s, f) => s + (f.size || 0), 0);
      return sizeB - sizeA;
    });
  }, [data]);

  // ─── Click-to-Connect / File-Hover: draw SVG lines ─────────────────────
  const computeLines = useCallback(() => {
    if ((!selectedId && !hoveredFile) || !data || !scrollRef.current) { setConnLines([]); return; }
    const container = scrollRef.current;
    const cRect = container.getBoundingClientRect();
    const sT = container.scrollTop;
    const sL = container.scrollLeft;
    const lines: ConnLine[] = [];

    const getCenter = (el: HTMLDivElement) => {
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2 - cRect.left + sL, y: r.top + r.height / 2 - cRect.top + sT };
    };

    // Scenario deps: draw lines to/from selected node
    if (selectedId) {
      const selNode = data.nodes.find(n => n.id === selectedId);
      if (selNode) {
        const selEl = brickRefs.current.get(selectedId);
        if (selEl) {
          const selP = getCenter(selEl);
          // Upstream deps (this node requires)
          for (const depId of selNode.requires_scenarios) {
            const depEl = brickRefs.current.get(depId);
            if (depEl) {
              const depP = getCenter(depEl);
              lines.push({ ...selP, x2: depP.x, y2: depP.y, x1: selP.x, y1: selP.y, color: '#bb9af7', dashed: false });
            }
          }
          // Downstream (nodes that require this one)
          for (const n of data.nodes) {
            if (n.requires_scenarios.includes(selectedId)) {
              const el = brickRefs.current.get(n.id);
              if (el) {
                const p = getCenter(el);
                lines.push({ x1: selP.x, y1: selP.y, x2: p.x, y2: p.y, color: '#7aa2f7', dashed: false });
              }
            }
          }
          // File connections
          for (const f of selNode.files) {
            const fileEl = fileRefs.current.get(f.path);
            if (fileEl) {
              const fp = getCenter(fileEl);
              lines.push({ x1: fp.x, y1: fp.y, x2: selP.x, y2: selP.y, color: '#7dcfff', dashed: true });
            }
          }
        }
      }
    }

    // File hover: draw lines from hovered file to all consuming scenarios
    if (hoveredFile && !selectedId) {
      const file = (data.files ?? []).find(f => f.path === hoveredFile);
      if (file) {
        const fileEl = fileRefs.current.get(file.path);
        if (fileEl) {
          const fp = getCenter(fileEl);
          for (const scenarioId of file.scenarios) {
            const brickEl = brickRefs.current.get(scenarioId);
            if (brickEl) {
              const bp = getCenter(brickEl);
              lines.push({ x1: fp.x, y1: fp.y, x2: bp.x, y2: bp.y, color: '#7dcfff', dashed: true });
            }
          }
        }
      }
    }

    const maxX = Math.max(container.scrollWidth, cRect.width);
    const maxY = Math.max(container.scrollHeight, cRect.height);
    setSvgSize({ w: maxX, h: maxY });
    setConnLines(lines);
  }, [selectedId, hoveredFile, data]);

  useLayoutEffect(() => {
    const timer = setTimeout(computeLines, 60);
    return () => clearTimeout(timer);
  }, [computeLines, stacks]);

  // ─── Render ──────────────────────────────────────────────────────────────
  if (loading && !data) return <div style={{ padding: 20, textAlign: 'center', color: 'var(--tn-text-muted)' }}>Loading...</div>;
  if (error && !data) return <div style={{ padding: 20, color: 'var(--tn-red)' }}>Error: {error}</div>;
  if (!data) return null;

  const totalParallel = data.nodes.filter(n => n.requires_scenarios.length === 0).length;
  const totalSequential = data.nodes.filter(n => n.requires_scenarios.length > 0).length;
  const totalFiles = (data.files ?? []).reduce((s, f) => s + (f.size || 0), 0);

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden', minWidth: 0 }}
         onClick={(e) => { if ((e.target as HTMLElement).closest('[data-brick]') || (e.target as HTMLElement).closest('[data-file]')) return; setSelectedId(null); }}>
      {/* Toolbar */}
      <div style={{
        display: 'flex', gap: 8, alignItems: 'center', padding: '6px 12px',
        borderBottom: '1px solid var(--tn-border)', flexShrink: 0,
        background: 'var(--tn-bg-dark)', flexWrap: 'wrap',
      }}>
        <select
          value={selectedApp}
          onChange={(e) => { setSelectedApp(e.target.value); setSelectedId(null); setHoveredId(null); setHoveredFile(null); }}
          style={{
            background: 'var(--tn-surface)', color: 'var(--tn-text)',
            border: '1px solid var(--tn-border)', borderRadius: 4,
            padding: '3px 8px', fontSize: 11, fontWeight: 600, cursor: 'pointer',
          }}
        >
          {apps.map(a => <option key={a} value={a}>{a}</option>)}
        </select>

        <Pill label="Tests" val={data.summary?.total ?? 0} c="#7aa2f7" />
        <Pill label="Indep" val={totalParallel} c="#9ece6a" />
        <Pill label="Seq" val={totalSequential} c="#bb9af7" />
        <Pill label="Files" val={data.summary?.unique_files ?? 0} c="#7dcfff" />
        <Pill label="Size" val={0} c="#7dcfff" text={fmtBytes(totalFiles)} />

        <div style={{ flex: 1 }} />
        {selectedId && (
          <span style={{ fontSize: 8, color: '#bb9af7', fontFamily: 'monospace', cursor: 'pointer' }}
                onClick={(e) => { e.stopPropagation(); setSelectedId(null); }}>
            [x] clear selection
          </span>
        )}
        <span style={{ fontSize: 8, color: 'var(--tn-text-muted)', fontFamily: 'monospace' }}>
          hover=dim | click=connect
        </span>
      </div>

      {/* Scrollable content */}
      <div ref={scrollRef} style={{ flex: 1, overflow: 'auto', position: 'relative' }}>
        {/* SVG lines — only for selected node */}
        {connLines.length > 0 && (
          <svg width={svgSize.w} height={svgSize.h}
               style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none', zIndex: 10 }}>
            <defs>
              <marker id="arr-up" viewBox="0 0 6 6" refX="6" refY="3" markerWidth="5" markerHeight="4" orient="auto-start-reverse">
                <path d="M 0 0 L 6 3 L 0 6 z" fill="#bb9af7" />
              </marker>
              <marker id="arr-down" viewBox="0 0 6 6" refX="6" refY="3" markerWidth="5" markerHeight="4" orient="auto-start-reverse">
                <path d="M 0 0 L 6 3 L 0 6 z" fill="#7aa2f7" />
              </marker>
              <marker id="arr-file" viewBox="0 0 6 6" refX="6" refY="3" markerWidth="5" markerHeight="4" orient="auto-start-reverse">
                <path d="M 0 0 L 6 3 L 0 6 z" fill="#7dcfff" />
              </marker>
            </defs>
            {connLines.map((l, i) => {
              const lx1 = l.x1, ly1 = l.y1, lx2 = l.x2, ly2 = l.y2;
              const dx = lx2 - lx1;
              const dy = ly2 - ly1;
              const dist = Math.sqrt(dx * dx + dy * dy);
              const bend = Math.min(dist * 0.25, 40);
              const mid = `${(lx1 + lx2) / 2} ${(ly1 + ly2) / 2 - bend}`;
              return (
                <path key={i}
                  d={`M ${lx1} ${ly1} Q ${mid}, ${lx2} ${ly2}`}
                  fill="none" stroke={l.color ?? '#565f89'}
                  strokeWidth={1.5} strokeDasharray={(l.dashed ?? false) ? '4,3' : undefined}
                  opacity={0.7}
                  markerEnd={(l.dashed ?? false) ? 'url(#arr-file)' : (l.color ?? '') === '#bb9af7' ? 'url(#arr-up)' : 'url(#arr-down)'}
                />
              );
            })}
          </svg>
        )}

        <div style={{ position: 'relative', zIndex: 2, padding: '8px 8px 0' }}>
          {/* ── Execution Order: Layer stacks bottom-up ── */}
          <div style={{ display: 'flex', flexDirection: 'column-reverse', gap: 2 }}>
            {stacks.map(stack => {
              const lc = LAYER_COLORS[stack.layer] || '#565f89';
              const layerPassed = stack.waves.flat().filter(b => {
                const s = b.node.status?.toUpperCase();
                return s === 'PASS' || s === 'PASSED';
              }).length;

              return (
                <div key={stack.layer} style={{ borderLeft: `3px solid ${lc}`, background: `${lc}06` }}>
                  {/* Layer header */}
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    padding: '3px 8px', background: `${lc}10`,
                  }}>
                    <span style={{ fontSize: 10, fontWeight: 800, color: lc, fontFamily: 'monospace' }}>
                      {LAYER_NAMES[stack.layer] || `L${stack.layer}`}
                    </span>
                    <span style={{
                      fontSize: 9, fontWeight: 600, fontFamily: 'monospace',
                      color: layerPassed === stack.totalBricks ? '#9ece6a' : 'var(--tn-text-muted)',
                    }}>
                      {layerPassed}/{stack.totalBricks}
                    </span>
                    {stack.waves.length > 1 ? (
                      <span style={{ fontSize: 8, color: '#bb9af7', fontFamily: 'monospace' }}>
                        {stack.waves.length} waves ({stack.waves.map((w, i) => `${w.length}${i < stack.waves.length - 1 ? ' → ' : ''}`).join('')})
                      </span>
                    ) : (
                      <span style={{ fontSize: 8, color: '#9ece6a', fontFamily: 'monospace' }}>
                        all parallel
                      </span>
                    )}
                  </div>

                  {/* Wave rows — bottom-up within layer */}
                  <div style={{ display: 'flex', flexDirection: 'column-reverse', padding: '2px 0 4px' }}>
                    {stack.waves.map((row, waveIdx) => (
                      <div key={waveIdx} style={{ display: 'flex', alignItems: 'stretch' }}>
                        {/* Wave label column — fixed width */}
                        <div style={{
                          width: 44, flexShrink: 0,
                          display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center',
                          borderRight: `1px solid ${lc}15`,
                          padding: '2px 0',
                          background: waveIdx === 0 ? undefined : `${lc}08`,
                        }}>
                          {waveIdx === 0 ? (
                            <>
                              <span style={{ fontSize: 7, fontWeight: 800, color: '#9ece6a', fontFamily: 'monospace', letterSpacing: 0.5 }}>
                                START
                              </span>
                              <span style={{ fontSize: 7, color: 'var(--tn-text-muted)', fontFamily: 'monospace' }}>
                                {row.length}x &#x21C6;
                              </span>
                            </>
                          ) : (
                            <>
                              <span style={{ fontSize: 8, fontWeight: 700, color: '#bb9af7', fontFamily: 'monospace' }}>
                                &#x25BC; W{waveIdx + 1}
                              </span>
                              <span style={{ fontSize: 7, color: 'var(--tn-text-muted)', fontFamily: 'monospace' }}>
                                {row.length}x &#x21C6;
                              </span>
                            </>
                          )}
                        </div>
                        {/* Brick area */}
                        <div style={{
                          flex: 1, display: 'flex', flexWrap: 'wrap', gap: 2,
                          padding: '3px 4px',
                          borderTop: waveIdx > 0 ? `1px dashed ${lc}30` : undefined,
                        }}>
                          {row.map(brick => (
                            <BrickEl
                              key={brick.node.id}
                              node={brick.node}
                              layerColor={lc}
                              isActive={activeId === brick.node.id}
                              isInChain={chainIds?.has(brick.node.id) ?? false}
                              isDimmed={
                                (chainIds !== null && !chainIds.has(brick.node.id)) ||
                                (hoveredFileScenarios !== null && !hoveredFileScenarios.has(brick.node.id))
                              }
                              fileCount={nodeFileMap.get(brick.node.id)?.size ?? 0}
                              depCount={brick.node.requires_scenarios.length}
                              onHover={setHoveredId}
                              onClick={setSelectedId}
                              refCallback={(el) => { if (el) brickRefs.current.set(brick.node.id, el); }}
                            />
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          {/* ── File Foundation ── */}
          {(data.files ?? []).length > 0 && (
            <div style={{
              marginTop: 6, borderTop: '2px solid rgba(125,207,255,0.3)',
              padding: '6px 0',
            }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '0 4px 4px',
              }}>
                <span style={{ fontSize: 9, fontWeight: 800, color: '#7dcfff', fontFamily: 'monospace', textTransform: 'uppercase', letterSpacing: 1 }}>
                  Input Files
                </span>
                <span style={{ fontSize: 8, color: 'var(--tn-text-muted)', fontFamily: 'monospace' }}>
                  {(data.files ?? []).length} files | {fmtBytes(totalFiles)}
                </span>
              </div>

              {fileGroups.map(([category, files]) => (
                <div key={category} style={{ marginBottom: 4 }}>
                  <div style={{
                    fontSize: 7, fontWeight: 700, color: 'var(--tn-text-muted)',
                    textTransform: 'uppercase', letterSpacing: 1, padding: '2px 6px',
                  }}>
                    {category} ({files.length})
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 2, padding: '0 4px' }}>
                    {files.sort((a, b) => b.scenarios.length - a.scenarios.length).map(file => {
                      const isFileActive = activeFiles?.has(file.path);
                      const isFileHovered = hoveredFile === file.path;
                      const isFileDimmed = (activeId !== null && !isFileActive) ||
                        (hoveredFile !== null && !isFileHovered);
                      return (
                        <div
                          key={file.path}
                          data-file
                          ref={el => { if (el) fileRefs.current.set(file.path, el); }}
                          title={`${file.path}\n${file.scenarios.map(s => s.replace(/^[^.]+\./, '')).join(', ')}`}
                          onMouseEnter={() => setHoveredFile(file.path)}
                          onMouseLeave={() => setHoveredFile(null)}
                          onClick={(e) => { e.stopPropagation(); setPreviewPath(file.path); }}
                          style={{
                            height: 20, padding: '0 6px',
                            display: 'flex', alignItems: 'center', gap: 4,
                            background: previewPath === file.path ? 'rgba(125,207,255,0.25)' : isFileHovered ? 'rgba(125,207,255,0.2)' : isFileActive ? 'rgba(125,207,255,0.15)' : 'rgba(125,207,255,0.04)',
                            border: previewPath === file.path ? '1px solid rgba(125,207,255,1)' : isFileHovered ? '1px solid rgba(125,207,255,0.8)' : isFileActive ? '1px solid rgba(125,207,255,0.6)' : '1px solid rgba(125,207,255,0.15)',
                            borderRadius: 3, cursor: 'pointer',
                            opacity: isFileDimmed ? 0.2 : 1,
                            transition: 'opacity 0.15s, border-color 0.15s, background 0.15s',
                          }}
                        >
                          <span style={{ fontSize: 8, fontWeight: 600, color: '#7dcfff', fontFamily: 'monospace',
                            maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {file.name}
                          </span>
                          {file.size != null && file.size > 0 && (
                            <span style={{ fontSize: 7, color: 'var(--tn-text-muted)', fontFamily: 'monospace' }}>
                              {fmtBytes(file.size)}
                            </span>
                          )}
                          <span style={{
                            fontSize: 7, fontWeight: 700, fontFamily: 'monospace',
                            color: file.scenarios.length > 3 ? '#e0af68' : 'var(--tn-text-muted)',
                          }}>
                            {file.scenarios.length}x
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ── Execution order bar ── */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 4,
            padding: '8px 0 6px', flexWrap: 'wrap',
          }}>
            <span style={{ fontSize: 8, fontWeight: 700, color: 'var(--tn-text-muted)', textTransform: 'uppercase', letterSpacing: 1 }}>
              Execution:
            </span>
            {(data.files ?? []).length > 0 && (
              <>
                <span style={{ fontSize: 8, fontWeight: 700, color: '#7dcfff', fontFamily: 'monospace', padding: '1px 4px', background: 'rgba(125,207,255,0.08)', borderRadius: 2 }}>
                  Files
                </span>
                <span style={{ color: 'var(--tn-text-muted)', fontSize: 10 }}>&rarr;</span>
              </>
            )}
            {stacks.map((s, i) => {
              const lc = LAYER_COLORS[s.layer] || '#565f89';
              const passed = s.waves.flat().filter(b => {
                const st = b.node.status?.toUpperCase();
                return st === 'PASS' || st === 'PASSED';
              }).length;
              return (
                <React.Fragment key={s.layer}>
                  {i > 0 && <span style={{ color: 'var(--tn-text-muted)', fontSize: 10 }}>&rarr;</span>}
                  <span style={{
                    fontSize: 8, fontWeight: 700, fontFamily: 'monospace',
                    color: lc, background: `${lc}10`, border: `1px solid ${lc}25`,
                    borderRadius: 2, padding: '1px 5px',
                  }}>
                    {LAYER_NAMES[s.layer]?.replace(/^L\d /, '') || `L${s.layer}`}
                    <span style={{ color: passed === s.totalBricks ? '#9ece6a' : 'var(--tn-text-muted)', fontWeight: 600 }}>
                      {' '}{passed}/{s.totalBricks}
                    </span>
                  </span>
                </React.Fragment>
              );
            })}
          </div>

          {/* ── Selected node detail panel ── */}
          {selectedId && data && <DetailPanel nodeId={selectedId} data={data} onFileClick={setPreviewPath} />}
        </div>
      </div>
    </div>

    {/* ── File Preview Sidebar ── */}
    {previewPath && (
      <FilePreviewSidebar
        filePath={previewPath}
        onClose={() => setPreviewPath(null)}
      />
    )}
    </div>
  );
}

// ─── Brick Component ────────────────────────────────────────────────────────
function BrickEl({ node, layerColor, isActive, isInChain, isDimmed, fileCount, depCount,
  onHover, onClick, refCallback }: {
  node: DepNode; layerColor: string;
  isActive: boolean; isInChain: boolean; isDimmed: boolean;
  fileCount: number; depCount: number;
  onHover: (id: string | null) => void;
  onClick: (id: string) => void;
  refCallback: (el: HTMLDivElement | null) => void;
}) {
  const sc = statusColor(node.status);
  return (
    <div
      data-brick
      ref={refCallback}
      onMouseEnter={() => onHover(node.id)}
      onMouseLeave={() => onHover(null)}
      onClick={(e) => { e.stopPropagation(); onClick(node.id); }}
      title={buildTooltip(node)}
      style={{
        height: 22, padding: '0 6px',
        display: 'flex', alignItems: 'center', gap: 3,
        background: isActive ? `${layerColor}28` : `${sc}08`,
        borderLeft: `2px solid ${sc}`,
        borderRadius: 2, cursor: 'pointer',
        opacity: isDimmed ? 0.15 : 1,
        transition: 'opacity 0.12s',
        outline: isActive ? `1px solid ${layerColor}` : isInChain ? `1px solid ${layerColor}40` : undefined,
      }}
    >
      {/* Status dot */}
      <span style={{
        width: 5, height: 5, borderRadius: '50%',
        background: sc, flexShrink: 0,
      }} />

      {/* Label */}
      <span style={{
        fontSize: 9, fontWeight: 600, color: 'var(--tn-text)',
        fontFamily: 'monospace',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        maxWidth: 120,
      }}>
        {node.label}
      </span>

      {/* Score */}
      {node.score != null && (
        <span style={{
          fontSize: 8, fontWeight: 800, fontFamily: 'monospace',
          color: node.score >= 8 ? '#9ece6a' : node.score >= 5 ? '#e0af68' : '#f7768e',
        }}>
          {node.score}
        </span>
      )}

      {/* Badges: dep count + file count */}
      {depCount > 0 && (
        <span style={{
          fontSize: 6, fontWeight: 700, fontFamily: 'monospace',
          color: '#1a1b26', background: '#bb9af7', borderRadius: 3,
          padding: '0 3px', lineHeight: '12px',
        }}>
          &larr;{depCount}
        </span>
      )}
      {fileCount > 0 && (
        <span style={{
          fontSize: 6, fontWeight: 700, fontFamily: 'monospace',
          color: '#1a1b26', background: '#7dcfff', borderRadius: 3,
          padding: '0 3px', lineHeight: '12px',
        }}>
          {fileCount}f
        </span>
      )}
    </div>
  );
}

// ─── Detail Panel (shown when a node is selected) ───────────────────────────
function DetailPanel({ nodeId, data, onFileClick }: { nodeId: string; data: DepGraphData; onFileClick: (path: string) => void }) {
  const node = data.nodes.find(n => n.id === nodeId);
  if (!node) return null;

  const upstream = data.nodes.filter(n => node.requires_scenarios.includes(n.id));
  const downstream = data.nodes.filter(n => n.requires_scenarios.includes(nodeId));

  return (
    <div style={{
      margin: '6px 0', padding: '8px 10px',
      background: 'rgba(187,154,247,0.06)',
      border: '1px solid rgba(187,154,247,0.25)',
      borderRadius: 4, fontSize: 9, fontFamily: 'monospace',
    }}>
      <div style={{ fontWeight: 800, color: '#bb9af7', marginBottom: 4 }}>{node.id}</div>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', color: 'var(--tn-text-muted)' }}>
        <span>Status: <b style={{ color: statusColor(node.status) }}>{node.status || '?'}</b></span>
        {node.score != null && <span>Score: <b style={{ color: node.score >= 8 ? '#9ece6a' : node.score >= 5 ? '#e0af68' : '#f7768e' }}>{node.score}/10</b></span>}
        {node.email && <span>User: <b style={{ color: 'var(--tn-text)' }}>{node.email}</b></span>}
        {node.skip_setup && <span style={{ color: '#e0af68' }}>Skip setup (step {node.first_active_step ?? '?'})</span>}
      </div>
      {upstream.length > 0 && (
        <div style={{ marginTop: 4 }}>
          <span style={{ color: '#bb9af7' }}>Requires: </span>
          {upstream.map(u => (
            <span key={u.id} style={{
              display: 'inline-block', marginRight: 4, padding: '0 4px',
              background: `${statusColor(u.status)}15`, borderRadius: 2,
              borderLeft: `2px solid ${statusColor(u.status)}`,
              color: 'var(--tn-text)',
            }}>{u.label}</span>
          ))}
        </div>
      )}
      {downstream.length > 0 && (
        <div style={{ marginTop: 4 }}>
          <span style={{ color: '#7aa2f7' }}>Required by: </span>
          {downstream.map(d => (
            <span key={d.id} style={{
              display: 'inline-block', marginRight: 4, padding: '0 4px',
              background: `${statusColor(d.status)}15`, borderRadius: 2,
              borderLeft: `2px solid ${statusColor(d.status)}`,
              color: 'var(--tn-text)',
            }}>{d.label}</span>
          ))}
        </div>
      )}
      {node.files.length > 0 && (
        <div style={{ marginTop: 4 }}>
          <span style={{ color: '#7dcfff' }}>Files: </span>
          {node.files.map(f => (
            <span key={f.path} style={{
              display: 'inline-block', marginRight: 4, padding: '0 4px',
              background: 'rgba(125,207,255,0.1)', borderRadius: 2,
              color: '#7dcfff', cursor: 'pointer',
            }}
            onClick={() => onFileClick(f.path)}
            title={`Preview: ${f.path}`}
            >{f.name}{f.size ? ` (${fmtBytes(f.size)})` : ''}</span>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function Pill({ label, val, c, text }: { label: string; val: number; c: string; text?: string }) {
  return (
    <span style={{ fontSize: 9, fontWeight: 600, fontFamily: 'monospace', color: 'var(--tn-text-muted)' }}>
      {label}:<span style={{ color: c, fontWeight: 700 }}> {text ?? val}</span>
    </span>
  );
}

function statusColor(status: string | null): string {
  if (!status) return '#565f89';
  switch (status.toUpperCase()) {
    case 'PASS': case 'PASSED': return '#9ece6a';
    case 'FAIL': case 'FAILED': case 'ERROR': return '#f7768e';
    case 'PARTIAL': return '#e0af68';
    default: return '#565f89';
  }
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function buildTooltip(n: DepNode): string {
  const lines = [n.id];
  if (n.status) lines.push(`Status: ${n.status}`);
  if (n.score != null) lines.push(`Score: ${n.score}/10`);
  if (n.email) lines.push(`User: ${n.email}`);
  if (n.requires_scenarios.length) lines.push(`Deps: ${n.requires_scenarios.map(d => d.replace(/^[^.]+\./, '')).join(', ')}`);
  if (n.requires_artifacts.length) lines.push(`Artifacts: ${n.requires_artifacts.map(a => a.type).join(', ')}`);
  if (n.files.length) lines.push(`Files: ${n.files.map(f => f.name).join(', ')}`);
  if (n.skip_setup) lines.push(`Skip setup (step ${n.first_active_step ?? '?'})`);
  return lines.join('\n');
}
