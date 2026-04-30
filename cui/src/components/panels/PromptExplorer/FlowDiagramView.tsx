/**
 * Flow Diagram View — SVG-based pipeline visualization for Prompt Explorer.
 *
 * Phases stacked vertically, steps as clickable nodes in a row.
 * SVG Bezier overlay for connections on hover/click.
 * Adapted from DependenciesTab pattern.
 */

import { useState, useRef, useCallback, useLayoutEffect, useMemo } from 'react';

// ─── Types (mirrored from PromptExplorer — no shared module needed) ───────────

interface PromptFile {
  path: string;
  name: string;
  relativePath?: string;
  functions?: { name: string; params: string[]; docstring: string | null; lineNumber: number; promptBody: string | null }[];
  constants?: { name: string; lineNumber: number; value: string; isFString: boolean }[];
  content?: string;
  lastModified?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  callSites?: any[];
}

interface PromptCallInOrder {
  order: number;
  name: string;
  promptFile: string;
  callerLine: number;
  isInline: boolean;
  context: string;
  isLooped: boolean;
}

interface StepInfo {
  id: string;
  name: string;
  dirName: string;
  hasPrompts: boolean;
  hasCode: boolean;
  promptFiles: PromptFile[];
  inlinePrompts: { file: string; lineNumbers: number[] }[];
  executionOrder: PromptCallInOrder[];
}

interface PhaseInfo {
  id: string;
  number: number;
  name: string;
  dirName: string;
  steps: StepInfo[];
  label?: string;
  iterative?: boolean;
}

interface CrossPhaseFlow {
  from: string;
  to: string[];
}

interface PhaseSectionEnrichment {
  sectionedLoads: { sourcePhase: number; requestingPhase: number; sourceFile: string }[];
  directReads: { phaseDir: string; path: string }[];
  consumersNeed: Record<string, string[]>;
  consumersDescription: Record<string, string>;
  liveMeasurements: Record<
    string,
    {
      sourcePhase: number;
      requestingPhase: number;
      fullChars: number;
      sectionedChars: number;
      reductionPct: number;
      strategy: string;
      sectionsKept: string[];
    }
  >;
  producerMarkers: { fileChars?: number; markerCount?: number; taggedConsumers?: number[] };
}

interface PipelineScanResult {
  id: string;
  name: string;
  basePath: string;
  type?: 'phase-step' | 'flat-stage';
  phases?: PhaseInfo[];
  entryInputs?: string[];
  finalOutputs?: string[];
  crossPhaseFlow?: CrossPhaseFlow[];
  scannedAt?: string;
  sectionEnrichment?: Record<number, PhaseSectionEnrichment>;
  liveProjectPath?: string;
}

interface ConnLine {
  x1: number; y1: number; x2: number; y2: number;
  color: string;
  dashed?: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const PHASE_COLORS = ['#7aa2f7', '#9ece6a', '#e0af68', '#bb9af7', '#f7768e', '#7dcfff'];

// ─── Main Component ───────────────────────────────────────────────────────────

export default function FlowDiagramView({ pipeline, selectedPromptFile, onSelectPrompt }: {
  pipeline: PipelineScanResult;
  selectedPromptFile: PromptFile | null;
  onSelectPrompt: (pf: PromptFile) => void;
}) {
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [connLines, setConnLines] = useState<ConnLine[]>([]);
  const [svgSize, setSvgSize] = useState({ w: 0, h: 0 });

  const phases = pipeline.phases ?? [];
  const entryInputs = pipeline.entryInputs ?? [];
  const finalOutputs = pipeline.finalOutputs ?? [];
  const crossPhaseFlow = pipeline.crossPhaseFlow ?? [];

  // activeKey format: `${phaseIdx}/${stepIdx}`
  const activeKey = selectedKey ?? hoveredKey;

  // Build set of "chain" keys for dimming: active node + its cross-phase neighbors
  const chainKeys = useMemo<Set<string> | null>(() => {
    if (!activeKey) return null;
    const [phaseIdxStr, stepIdxStr] = activeKey.split('/');
    const phaseIdx = parseInt(phaseIdxStr, 10);
    const phase = phases[phaseIdx];
    if (!phase) return null;

    const keys = new Set<string>([activeKey]);

    // All steps in the same phase
    (phase.steps ?? []).forEach((_, si) => keys.add(`${phaseIdx}/${si}`));

    // Downstream phases via crossPhaseFlow
    const fromId = phase.id;
    for (const flow of crossPhaseFlow) {
      if (flow.from.split('/')[0] === fromId) {
        for (const toId of (flow.to ?? [])) {
          const toIdx = phases.findIndex(p => p.id === toId);
          if (toIdx !== -1) {
            (phases[toIdx].steps ?? []).forEach((_, si) => keys.add(`${toIdx}/${si}`));
          }
        }
      }
      // Also reverse: if this phase is a target, highlight the source
      if ((flow.to ?? []).includes(fromId)) {
        const srcIdx = phases.findIndex(p => p.id === flow.from.split('/')[0]);
        if (srcIdx !== -1) {
          (phases[srcIdx].steps ?? []).forEach((_, si) => keys.add(`${srcIdx}/${si}`));
        }
      }
    }

    return keys;
  }, [activeKey, phases, crossPhaseFlow]);

  // ─── SVG Line Computation ────────────────────────────────────────────────

  const computeLines = useCallback(() => {
    if (!activeKey || !scrollRef.current) { setConnLines([]); return; }
    const container = scrollRef.current;
    const cRect = container.getBoundingClientRect();
    const sT = container.scrollTop;
    const sL = container.scrollLeft;

    const getCenter = (el: HTMLDivElement) => {
      const r = el.getBoundingClientRect();
      return {
        x: r.left + r.width / 2 - cRect.left + sL,
        y: r.top + r.height / 2 - cRect.top + sT,
      };
    };

    const lines: ConnLine[] = [];
    const [phaseIdxStr, stepIdxStr] = activeKey.split('/');
    const phaseIdx = parseInt(phaseIdxStr, 10);
    const stepIdx = parseInt(stepIdxStr, 10);
    const phase = phases[phaseIdx];
    if (!phase) { setConnLines([]); return; }

    const activeEl = nodeRefs.current.get(activeKey);
    if (!activeEl) { setConnLines([]); return; }
    const activeP = getCenter(activeEl);

    // Within-phase: connect to adjacent steps
    if (stepIdx > 0) {
      const prevEl = nodeRefs.current.get(`${phaseIdx}/${stepIdx - 1}`);
      if (prevEl) {
        const p = getCenter(prevEl);
        lines.push({ x1: p.x, y1: p.y, x2: activeP.x, y2: activeP.y, color: PHASE_COLORS[phaseIdx % PHASE_COLORS.length] });
      }
    }
    if (phase.steps && stepIdx < phase.steps.length - 1) {
      const nextEl = nodeRefs.current.get(`${phaseIdx}/${stepIdx + 1}`);
      if (nextEl) {
        const p = getCenter(nextEl);
        lines.push({ x1: activeP.x, y1: activeP.y, x2: p.x, y2: p.y, color: PHASE_COLORS[phaseIdx % PHASE_COLORS.length] });
      }
    }

    // Cross-phase connections
    for (const flow of crossPhaseFlow) {
      const fromPhaseId = flow.from.split('/')[0];
      if (fromPhaseId === phase.id) {
        for (const toId of (flow.to ?? [])) {
          const toPhaseIdx = phases.findIndex(p => p.id === toId);
          if (toPhaseIdx !== -1) {
            const toEl = nodeRefs.current.get(`${toPhaseIdx}/0`);
            if (toEl) {
              const p = getCenter(toEl);
              lines.push({ x1: activeP.x, y1: activeP.y, x2: p.x, y2: p.y, color: '#bb9af7' });
            }
          }
        }
      }
      // Reverse: show where this phase receives from
      if ((flow.to ?? []).includes(phase.id)) {
        const srcPhaseIdx = phases.findIndex(p => p.id === flow.from.split('/')[0]);
        if (srcPhaseIdx !== -1) {
          const lastStepIdx = (phases[srcPhaseIdx].steps?.length ?? 1) - 1;
          const srcEl = nodeRefs.current.get(`${srcPhaseIdx}/${lastStepIdx}`);
          if (srcEl) {
            const p = getCenter(srcEl);
            lines.push({ x1: p.x, y1: p.y, x2: activeP.x, y2: activeP.y, color: '#bb9af7' });
          }
        }
      }
    }

    const maxX = Math.max(container.scrollWidth, container.clientWidth);
    const maxY = Math.max(container.scrollHeight, container.clientHeight);
    setSvgSize({ w: maxX, h: maxY });
    setConnLines(lines);
  }, [activeKey, phases, crossPhaseFlow]);

  useLayoutEffect(() => {
    const t = setTimeout(computeLines, 60);
    return () => clearTimeout(t);
  }, [computeLines]);

  // ─── Step Click ──────────────────────────────────────────────────────────

  const handleStepClick = (phaseIdx: number, stepIdx: number) => {
    const key = `${phaseIdx}/${stepIdx}`;
    setSelectedKey(prev => {
      if (prev === key) { setConnLines([]); return null; }
      return key;
    });
    const step = phases[phaseIdx]?.steps?.[stepIdx];
    // Pick the first prompt file with actual content, or just first
    const firstPrompt = step?.promptFiles?.[0];
    if (firstPrompt) onSelectPrompt(firstPrompt);
  };

  // Sync selected key when selectedPromptFile changes externally (from list view)
  // Not needed: diagram is self-contained for selection

  // ─── Render ──────────────────────────────────────────────────────────────

  const clearSelection = () => { setSelectedKey(null); setConnLines([]); };

  return (
    <div
      ref={scrollRef}
      className="pe-fd-scroll"
      onClick={(e) => {
        if (!(e.target as HTMLElement).closest('[data-fd-node]')) clearSelection();
      }}
    >
      {/* ─── SVG Overlay ─────────────────────────────────────── */}
      {connLines.length > 0 && (
        <svg
          width={svgSize.w}
          height={svgSize.h}
          style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none', zIndex: 10 }}
        >
          <defs>
            <marker id="fd-arr-phase" viewBox="0 0 6 6" refX="6" refY="3" markerWidth="5" markerHeight="4" orient="auto-start-reverse">
              <path d="M 0 0 L 6 3 L 0 6 z" fill="#bb9af7" />
            </marker>
            {PHASE_COLORS.map((c, i) => (
              <marker key={i} id={`fd-arr-${i}`} viewBox="0 0 6 6" refX="6" refY="3" markerWidth="5" markerHeight="4" orient="auto-start-reverse">
                <path d="M 0 0 L 6 3 L 0 6 z" fill={c} />
              </marker>
            ))}
          </defs>
          {connLines.map((l, i) => {
            const dx = l.x2 - l.x1;
            const dy = l.y2 - l.y1;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const bend = Math.min(dist * 0.25, 50);
            // Curve perpendicular to direction
            const nx = dist > 0 ? -dy / dist : 0;
            const ny = dist > 0 ? dx / dist : 1;
            const mx = (l.x1 + l.x2) / 2 + nx * bend;
            const my = (l.y1 + l.y2) / 2 + ny * bend;
            const phaseIdx = activeKey ? parseInt(activeKey.split('/')[0], 10) : 0;
            const markerId = l.color === '#bb9af7' ? 'fd-arr-phase' : `fd-arr-${phaseIdx % PHASE_COLORS.length}`;
            return (
              <path
                key={i}
                d={`M ${l.x1} ${l.y1} Q ${mx} ${my}, ${l.x2} ${l.y2}`}
                fill="none"
                stroke={l.color}
                strokeWidth={1.5}
                strokeDasharray={l.dashed ? '4,3' : undefined}
                opacity={0.8}
                markerEnd={`url(#${markerId})`}
              />
            );
          })}
        </svg>
      )}

      <div style={{ position: 'relative', zIndex: 2, padding: '12px 16px 16px' }}>

        {/* ─── Entry Inputs ──────────────────────────────────── */}
        {entryInputs.length > 0 && (
          <div className="pe-fd-io-row">
            <span className="pe-fd-io-label" style={{ color: '#7dcfff' }}>ENTRY INPUTS</span>
            <div className="pe-fd-io-chips">
              {entryInputs.map((inp, i) => (
                <span key={i} className="pe-fd-chip" style={{
                  color: fileColorHex(inp),
                  borderColor: fileColorHex(inp) + '50',
                  background: fileColorHex(inp) + '12',
                }}>
                  {inp}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* ─── Phase Rows ────────────────────────────────────── */}
        {phases.map((phase, phaseIdx) => {
          const phaseColor = PHASE_COLORS[phaseIdx % PHASE_COLORS.length];
          const isCentralPrompts = phase.id === 'central_prompts';

          return (
            <div key={phase.id}>
              {/* Arrow divider */}
              <div className="pe-fd-divider">
                <div className="pe-fd-divider-line" style={{ background: `linear-gradient(to bottom, transparent, ${phaseColor}60, transparent)` }} />
                <svg width="14" height="14" style={{ display: 'block', flexShrink: 0 }}>
                  <defs>
                    <marker id={`da-${phaseIdx}`} viewBox="0 0 6 6" refX="3" refY="6" markerWidth="4" markerHeight="4" orient="auto">
                      <path d="M 0 0 L 3 6 L 6 0" fill="none" stroke={phaseColor + '80'} strokeWidth="1.5" />
                    </marker>
                  </defs>
                  <line x1="7" y1="0" x2="7" y2="10" stroke={phaseColor + '60'} strokeWidth="1.5" markerEnd={`url(#da-${phaseIdx})`} />
                </svg>
              </div>

              {/* Phase block */}
              <div
                className="pe-fd-phase"
                style={{
                  borderColor: phaseColor + '50',
                  background: phaseColor + '06',
                }}
              >
                {/* Phase header */}
                <div className="pe-fd-phase-header" style={{ borderBottomColor: phaseColor + '25' }}>
                  <span className="pe-fd-phase-badge" style={{ background: phaseColor + '20', color: phaseColor }}>
                    {isCentralPrompts ? 'LIB' : pipeline.type === 'flat-stage' ? (phase.id ?? '').toUpperCase().slice(0, 4) : `P${phase.number ?? phaseIdx + 1}`}
                  </span>
                  <span className="pe-fd-phase-name" style={{ color: phaseColor }}>
                    {isCentralPrompts ? 'Shared Prompt Library' : (phase.label || humanize(phase.name))}
                  </span>
                  {phase.iterative && <span className="pe-fd-loop-badge" style={{ color: phaseColor }}>↻ iterative</span>}
                  <span className="pe-fd-phase-count">{(phase.steps ?? []).length} step{(phase.steps ?? []).length !== 1 ? 's' : ''}</span>
                  {(() => {
                    const enrich = pipeline.sectionEnrichment?.[phase.number ?? -1];
                    if (!enrich) return null;
                    const mc = enrich.producerMarkers.markerCount ?? 0;
                    const tagged = enrich.producerMarkers.taggedConsumers ?? [];
                    if (mc === 0 && tagged.length === 0) {
                      return (
                        <span className="pe-fd-marker-badge" title="No <!-- needed_by --> markers in this phase's output (downstream loaders fall back to keyword matching)" style={{ color: '#f7768e', borderColor: '#f7768e40', background: '#f7768e10' }}>
                          ⚠ no markers
                        </span>
                      );
                    }
                    return (
                      <span className="pe-fd-marker-badge" title={`Output contains ${mc} needed_by markers tagged for: ${tagged.map(p => `phase_${p}`).join(', ')}`} style={{ color: '#9ece6a', borderColor: '#9ece6a40', background: '#9ece6a10' }}>
                        ✓ {mc} marker{mc === 1 ? '' : 's'} → {tagged.length} phase{tagged.length === 1 ? '' : 's'}
                      </span>
                    );
                  })()}
                  {(() => {
                    const enrich = pipeline.sectionEnrichment?.[phase.number ?? -1];
                    const sectionedLoads = enrich?.sectionedLoads ?? [];
                    if (sectionedLoads.length === 0) return null;
                    return (
                      <span className="pe-fd-marker-badge" title={`This phase loads sectioned data from upstream: ${sectionedLoads.map(s => `phase_${s.sourcePhase}`).join(', ')}`} style={{ color: '#7dcfff', borderColor: '#7dcfff40', background: '#7dcfff10' }}>
                        ← {sectionedLoads.length} sectioned load{sectionedLoads.length === 1 ? '' : 's'}
                      </span>
                    );
                  })()}
                </div>

                {/* Steps row */}
                <div className="pe-fd-steps-row">
                  {(phase.steps ?? []).map((step, stepIdx) => {
                    const nodeKey = `${phaseIdx}/${stepIdx}`;
                    const isActive = activeKey === nodeKey;
                    const isSelected = selectedKey === nodeKey;
                    const isDimmed = chainKeys !== null && !chainKeys.has(nodeKey);
                    const promptCount = (step.promptFiles ?? []).length;
                    const callCount = (step.executionOrder ?? []).length;
                    const hasLoops = (step.executionOrder ?? []).some(c => c.isLooped);
                    const hasInline = (step.inlinePrompts ?? []).length > 0;

                    return (
                      <div key={step.id} className="pe-fd-step-wrapper">
                        {/* Step node */}
                        <div
                          data-fd-node
                          ref={el => { if (el) nodeRefs.current.set(nodeKey, el as HTMLDivElement); }}
                          className={`pe-fd-node ${isActive ? 'active' : ''} ${isDimmed ? 'dimmed' : ''} ${isSelected ? 'selected' : ''}`}
                          style={{
                            borderColor: isActive ? phaseColor : phaseColor + '35',
                            background: isSelected ? phaseColor + '20' : isActive ? phaseColor + '15' : phaseColor + '07',
                            boxShadow: isSelected ? `0 0 0 1.5px ${phaseColor}50, 0 2px 8px ${phaseColor}20` : undefined,
                          }}
                          onMouseEnter={() => setHoveredKey(nodeKey)}
                          onMouseLeave={() => setHoveredKey(null)}
                          onClick={e => { e.stopPropagation(); handleStepClick(phaseIdx, stepIdx); }}
                        >
                          <div className="pe-fd-node-top">
                            <span className="pe-fd-node-num" style={{ color: phaseColor }}>{stepIdx + 1}</span>
                            <span className="pe-fd-node-name">{humanize(step.name)}</span>
                          </div>
                          <div className="pe-fd-node-badges">
                            {callCount > 0 && (
                              <span className="pe-fd-badge calls">{callCount} calls</span>
                            )}
                            {promptCount > 0 && (
                              <span className="pe-fd-badge prompts" style={{ color: phaseColor, borderColor: phaseColor + '40', background: phaseColor + '10' }}>
                                {promptCount}P
                              </span>
                            )}
                            {hasLoops && <span className="pe-fd-badge loop" title="Contains looped prompt calls">↻</span>}
                            {hasInline && <span className="pe-fd-badge inline" title="Has inline prompts">◆</span>}
                          </div>
                        </div>

                        {/* Arrow to next step */}
                        {stepIdx < (phase.steps ?? []).length - 1 && (
                          <div className="pe-fd-step-arrow" style={{ color: phaseColor + '80' }}>
                            <span>→</span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* CrossPhaseFlow outputs for this phase. When section
                    enrichment is present we replace the coarse file-level
                    flow with per-consumer rows that include live reduction %
                    so the user sees what each downstream phase actually
                    pulls (markers/keywords/full + size delta). */}
                {(() => {
                  const outFlows = crossPhaseFlow.filter(f => f.from.split('/')[0] === phase.id);
                  if (outFlows.length === 0) return null;
                  // Merge consumer phase numbers with their live measurement
                  const consumerInfo: { id: string; reduction?: number; strategy?: string }[] = [];
                  const seen = new Set<string>();
                  for (const flow of outFlows) {
                    for (const to of (flow.to ?? [])) {
                      if (seen.has(to)) continue;
                      seen.add(to);
                      // Pull live measurement from THE CONSUMER's enrichment
                      // (live[src->req] is keyed on the consumer's phase view)
                      const consumerNum = Number((to.match(/\d+/) ?? [])[0]);
                      const phaseNum = phase.number ?? -1;
                      const consumerEnrich = pipeline.sectionEnrichment?.[consumerNum];
                      const live = consumerEnrich?.liveMeasurements?.[`${phaseNum}->${consumerNum}`];
                      consumerInfo.push({
                        id: to,
                        reduction: live?.reductionPct,
                        strategy: live?.strategy,
                      });
                    }
                  }
                  return (
                    <div className="pe-fd-phase-flows">
                      {consumerInfo.map((c, fi) => {
                        const colorByStrategy =
                          c.strategy === 'markers' ? '#9ece6a' :
                          c.strategy === 'keywords' ? '#e0af68' :
                          c.strategy === 'full' ? '#f7768e' : '#bb9af7';
                        const label = c.reduction != null
                          ? `${c.id} (${c.strategy}, -${c.reduction.toFixed(0)}%)`
                          : c.id;
                        return (
                          <div key={fi} className="pe-fd-flow-tag" title={c.strategy ? `Loading strategy: ${c.strategy}; reduction ${c.reduction?.toFixed(1)}%` : 'No live measurement'} style={{ color: colorByStrategy, borderColor: colorByStrategy + '40', background: colorByStrategy + '08' }}>
                            <span style={{ opacity: 0.6 }}>→</span>
                            {' '}
                            {label}
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}
              </div>
            </div>
          );
        })}

        {/* ─── Final Outputs ─────────────────────────────────── */}
        {finalOutputs.length > 0 && (
          <>
            <div className="pe-fd-divider">
              <div className="pe-fd-divider-line" style={{ background: 'linear-gradient(to bottom, transparent, #7dcfff60, transparent)' }} />
              <svg width="14" height="14" style={{ display: 'block', flexShrink: 0 }}>
                <line x1="7" y1="0" x2="7" y2="10" stroke="#7dcfff60" strokeWidth="1.5" />
              </svg>
            </div>
            <div className="pe-fd-io-row">
              <span className="pe-fd-io-label" style={{ color: '#9ece6a' }}>FINAL OUTPUTS</span>
              <div className="pe-fd-io-chips">
                {finalOutputs.map((out, i) => (
                  <span key={i} className="pe-fd-chip" style={{
                    color: fileColorHex(out),
                    borderColor: fileColorHex(out) + '50',
                    background: fileColorHex(out) + '12',
                  }}>
                    {out}
                  </span>
                ))}
              </div>
            </div>
          </>
        )}

        {/* Legend */}
        <div className="pe-fd-legend">
          <span className="pe-fd-legend-item" style={{ color: '#bb9af7' }}>― cross-phase</span>
          <span className="pe-fd-legend-item" style={{ color: '#7aa2f7' }}>― within phase</span>
          <span className="pe-fd-legend-item" style={{ color: 'var(--tn-text-muted)' }}>click node = connections</span>
        </div>

      </div>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function humanize(name: string): string {
  return name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function fileColorHex(filename: string): string {
  if (filename.endsWith('.parquet')) return '#9ece6a';
  if (filename.endsWith('.json')) return '#e0af68';
  if (filename.endsWith('.md')) return '#7aa2f7';
  if (filename.match(/\.(png|jpg|jpeg|svg)/)) return '#bb9af7';
  if (filename.endsWith('.pdf')) return '#f7768e';
  if (filename.endsWith('.eco') || filename.endsWith('.xlsx') || filename.endsWith('.csv')) return '#7dcfff';
  if (filename.includes('*')) return '#9ece6a';
  return '#565f89';
}
