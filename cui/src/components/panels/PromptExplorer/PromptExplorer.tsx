/**
 * Prompt Explorer Panel — Split-Panel Pipeline Flow
 *
 * Left: Vertical flow list with expandable phases showing steps + prompt files.
 * Right: Selected prompt detail (content, call sites, data sources).
 * The flow context is NEVER lost — you always see where you are in the pipeline.
 */

import { useState, useEffect, useCallback } from 'react';
import './PromptExplorer.css';

// ─── Types ───────────────────────────────────────────────────────────────────

interface PromptFunction {
  name: string;
  params: string[];
  docstring: string | null;
  lineNumber: number;
  promptBody: string | null;
}

interface PromptConstant {
  name: string;
  lineNumber: number;
  value: string;
  isFString: boolean;
}

interface FileLoadInfo {
  targetVar: string;
  filePath: string;
  method: string;
  lineNumber: number;
}

interface PromptCallSite {
  functionName: string;
  callerFile: string;
  callerRelativePath: string;
  lineNumber: number;
  arguments: { name: string; source: string }[];
  nearbyFileLoads: FileLoadInfo[];
  contextWrappers: string[];
}

interface PromptFile {
  path: string;
  relativePath: string;
  functions: PromptFunction[];
  constants: PromptConstant[];
  content: string;
  lastModified: string;
  callSites: PromptCallSite[];
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

interface ValidationIssue {
  level: 'error' | 'warning';
  phase?: string;
  step?: string;
  message: string;
}

interface PipelineScanResult {
  id: string;
  name: string;
  basePath: string;
  type: 'phase-step' | 'flat-stage';
  phases: PhaseInfo[];
  entryInputs: string[];
  finalOutputs: string[];
  crossPhaseFlow: CrossPhaseFlow[];
  validationIssues: ValidationIssue[];
  scannedAt: string;
}

interface PipelineSummary {
  id: string;
  name: string;
  phaseCount: number;
  totalPromptFiles: number;
  issueCount: number;
  hasErrors: boolean;
}

// ─── Main Component ──────────────────────────────────────────────────────────

export default function PromptExplorer() {
  const [pipelines, setPipelines] = useState<PipelineSummary[]>([]);
  const [activePipeline, setActivePipeline] = useState<PipelineScanResult | null>(null);
  const [expandedPhase, setExpandedPhase] = useState<string | null>(null);
  const [selectedPromptFile, setSelectedPromptFile] = useState<PromptFile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/prompt-explorer/pipelines')
      .then(r => r.json())
      .then(data => { setPipelines(data.pipelines || []); setLoading(false); })
      .catch(err => { setError(`Failed to load: ${err.message}`); setLoading(false); });
  }, []);

  const loadPipeline = useCallback((id: string) => {
    setLoading(true);
    setExpandedPhase(null);
    setSelectedPromptFile(null);
    fetch(`/api/prompt-explorer/scan/${id}`)
      .then(r => r.json())
      .then((data: PipelineScanResult) => { setActivePipeline(data); setLoading(false); })
      .catch(err => { setError(`Failed to scan: ${err.message}`); setLoading(false); });
  }, []);

  if (loading && pipelines.length === 0) {
    return <div className="pe-loading">Scanning pipelines...</div>;
  }
  if (error) {
    return <div className="pe-error">{error}</div>;
  }

  // ─── Pipeline Selector ──────────────────────────────────────────────
  if (!activePipeline) {
    return (
      <div className="pe-container">
        <div className="pe-full">
          <div className="pe-title-bar">Pipeline Explorer</div>
          <div className="pe-pipeline-grid">
            {pipelines.map(p => (
              <button key={p.id} className="pe-pipeline-card" onClick={() => loadPipeline(p.id)}>
                <span className={`pe-dot ${p.hasErrors ? 'error' : 'ok'}`} />
                <span className="pe-card-name">{p.name}</span>
                <span className="pe-card-stats">
                  {p.phaseCount} phases &middot; {p.totalPromptFiles} prompts
                  {p.issueCount > 0 && <span className="pe-badge">{p.issueCount}</span>}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // ─── Split-Panel: Flow Left + Detail Right ──────────────────────────
  const togglePhase = (phaseId: string) => {
    setExpandedPhase(prev => prev === phaseId ? null : phaseId);
  };

  const selectPrompt = (pf: PromptFile) => {
    setSelectedPromptFile(pf);
  };

  return (
    <div className="pe-container">
      {/* ─── LEFT: Flow Navigation ──────────────────────────────────── */}
      <div className="pe-left">
        <div className="pe-title-bar">
          <button className="pe-back" onClick={() => setActivePipeline(null)}>&larr;</button>
          <span className="pe-breadcrumb">{activePipeline.name}</span>
          <span className="pe-scanned">{new Date(activePipeline.scannedAt).toLocaleTimeString()}</span>
        </div>
        <div className="pe-flow-list">
          <FlowNavigation
            pipeline={activePipeline}
            expandedPhase={expandedPhase}
            selectedPromptFile={selectedPromptFile}
            onTogglePhase={togglePhase}
            onSelectPrompt={selectPrompt}
          />
        </div>
      </div>

      {/* ─── RIGHT: Detail Panel ────────────────────────────────────── */}
      <div className="pe-right">
        {selectedPromptFile ? (
          <PromptDetailPanel file={selectedPromptFile} pipeline={activePipeline} />
        ) : (
          <div className="pe-right-empty">
            <div className="pe-right-empty-icon">&#x2190;</div>
            <div>Klick auf einen Prompt in der Flow-Ansicht</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Flow Navigation (Left Panel) ────────────────────────────────────────────

function FlowNavigation({ pipeline, expandedPhase, selectedPromptFile, onTogglePhase, onSelectPrompt }: {
  pipeline: PipelineScanResult;
  expandedPhase: string | null;
  selectedPromptFile: PromptFile | null;
  onTogglePhase: (id: string) => void;
  onSelectPrompt: (pf: PromptFile) => void;
}) {
  const { phases, entryInputs, finalOutputs, crossPhaseFlow } = pipeline;

  // Compute per-phase input/output counts from crossPhaseFlow
  const phaseInputCount = new Map<string, number>();
  const phaseOutputCount = new Map<string, number>();
  for (const flow of crossPhaseFlow) {
    const fromPhase = flow.from.split('/')[0];
    phaseOutputCount.set(fromPhase, (phaseOutputCount.get(fromPhase) || 0) + 1);
    for (const target of flow.to) {
      phaseInputCount.set(target, (phaseInputCount.get(target) || 0) + 1);
    }
  }

  return (
    <>
      {/* Entry Inputs */}
      {entryInputs.length > 0 && (
        <div className="pe-fl-entry">
          <div className="pe-fl-entry-label">ENTRY INPUTS</div>
          {entryInputs.map((inp, i) => (
            <div key={i} className="pe-fl-entry-item">
              <span className="pe-fl-dot" style={{ background: fileColorHex(inp) }} />
              <span style={{ color: fileColorHex(inp) }}>{inp}</span>
            </div>
          ))}
        </div>
      )}

      {/* Flow arrow */}
      {entryInputs.length > 0 && <div className="pe-fl-arrow">&#x25BC;</div>}

      {/* Phase nodes */}
      {phases.map((phase, idx) => {
        const isExpanded = expandedPhase === phase.id;
        const promptCount = phase.steps.reduce((n, s) => n + s.promptFiles.length, 0);
        const inCount = phaseInputCount.get(phase.id) || 0;
        const outCount = phaseOutputCount.get(phase.id) || 0;
        const isCentralPrompts = phase.id === 'central_prompts';

        return (
          <div key={phase.id}>
            {/* Phase node */}
            <div
              className={`pe-fl-phase ${isExpanded ? 'expanded' : ''} ${phase.iterative ? 'iterative' : ''}`}
              onClick={() => onTogglePhase(phase.id)}
            >
              <div className="pe-fl-phase-main">
                <span className="pe-fl-phase-badge">
                  {isCentralPrompts ? 'LIB' : pipeline.type === 'flat-stage' ? phase.id.toUpperCase() : `P${phase.number}`}
                </span>
                <div className="pe-fl-phase-info">
                  <span className="pe-fl-phase-name">
                    {isCentralPrompts ? 'Shared Prompt Library' : (phase.label || humanize(phase.name))}
                  </span>
                  <span className="pe-fl-phase-meta">
                    {isCentralPrompts
                      ? 'Wiederverwendbare Prompts die von mehreren Stages importiert werden'
                      : `${phase.steps.length} step${phase.steps.length !== 1 ? 's' : ''} \u00b7 ${promptCount} prompt${promptCount !== 1 ? 's' : ''}`
                    }
                    {inCount > 0 && ` \u00b7 ${inCount} in`}
                    {outCount > 0 && ` \u00b7 ${outCount} out`}
                  </span>
                </div>
                <div className="pe-fl-phase-right">
                  {phase.iterative && <span className="pe-fl-loop">\u21bb</span>}
                  <span className="pe-fl-chevron">{isExpanded ? '\u25BC' : '\u25B6'}</span>
                </div>
              </div>
            </div>

            {/* Expanded: Execution Flow or File List */}
            {isExpanded && (
              <div className="pe-fl-phase-content">
                {phase.steps.map((step, stepIdx) => {
                  const hasExecOrder = (step.executionOrder || []).length > 0;

                  return (
                    <div key={step.id} className="pe-fl-step-group">
                      {/* Step header (only if multiple steps) */}
                      {phase.steps.length > 1 && (
                        <div className="pe-fl-step-header">
                          <span className="pe-fl-step-num">{stepIdx + 1}</span>
                          <span className="pe-fl-step-name">{humanize(step.name)}</span>
                          {hasExecOrder && (
                            <span className="pe-fl-step-calls">{step.executionOrder.length} calls</span>
                          )}
                        </div>
                      )}

                      {/* ─── Execution Order View (when call-site data exists) ─── */}
                      {hasExecOrder ? (
                        <div className="pe-fl-exec-flow">
                          {step.executionOrder.map((call, ci) => {
                            // Find the prompt file for click-to-detail
                            const matchingPf = step.promptFiles.find(pf =>
                              pf.relativePath === call.promptFile
                              || pf.relativePath.endsWith(call.promptFile)
                            );
                            const isSelected = matchingPf && selectedPromptFile?.path === matchingPf.path;

                            return (
                              <div key={`${call.name}-${call.callerLine}`}>
                                <div
                                  className={`pe-fl-exec-item ${isSelected ? 'selected' : ''} ${call.isInline ? 'inline' : ''}`}
                                  onClick={() => matchingPf && onSelectPrompt(matchingPf)}
                                >
                                  <span className="pe-fl-exec-num">{call.order}</span>
                                  <div className="pe-fl-exec-info">
                                    <span className="pe-fl-exec-name">
                                      {call.isInline ? '(inline)' : `${call.name}()`}
                                    </span>
                                    {call.context && (
                                      <span className="pe-fl-exec-ctx">{call.context}</span>
                                    )}
                                  </div>
                                  <div className="pe-fl-exec-badges">
                                    {call.isLooped && <span className="pe-fl-exec-loop" title="Called in a loop (per item)">&#x21bb;</span>}
                                    <span className="pe-fl-exec-line">L{call.callerLine}</span>
                                  </div>
                                </div>
                                {/* Arrow between calls */}
                                {ci < step.executionOrder.length - 1 && (
                                  <div className="pe-fl-exec-arrow">&#x2193;</div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        /* ─── Fallback: File List (for library/no-call-site phases) ─── */
                        <>
                          {step.promptFiles.map(pf => {
                            const isSelected = selectedPromptFile?.path === pf.path;
                            const fnNames = pf.functions.filter(fn => fn.promptBody).map(fn => fn.name);
                            const constNames = (pf.constants || []).map(c => c.name);
                            const allNames = [...constNames, ...fnNames];
                            const csCount = pf.callSites?.length || 0;

                            return (
                              <div
                                key={pf.path}
                                className={`pe-fl-prompt-item ${isSelected ? 'selected' : ''}`}
                                onClick={() => onSelectPrompt(pf)}
                              >
                                <span className="pe-fl-prompt-icon">P</span>
                                <div className="pe-fl-prompt-info">
                                  <span className="pe-fl-prompt-name">{shortFilename(pf.relativePath)}</span>
                                  {allNames.length > 0 && (
                                    <span className="pe-fl-prompt-fns">{allNames.slice(0, 3).join(', ')}{allNames.length > 3 ? ` +${allNames.length - 3}` : ''}</span>
                                  )}
                                </div>
                                {csCount > 0 && <span className="pe-fl-prompt-cs">{csCount}x</span>}
                              </div>
                            );
                          })}
                          {step.inlinePrompts.map((ip, i) => (
                            <div key={`inline-${i}`} className="pe-fl-prompt-item inline">
                              <span className="pe-fl-prompt-icon in">IN</span>
                              <div className="pe-fl-prompt-info">
                                <span className="pe-fl-prompt-name">{shortFilename(ip.file)}</span>
                                <span className="pe-fl-prompt-fns">L{ip.lineNumbers.join(',')}</span>
                              </div>
                            </div>
                          ))}
                        </>
                      )}

                      {/* Step separator arrow (between steps, not after last) */}
                      {phase.steps.length > 1 && stepIdx < phase.steps.length - 1 && (
                        <div className="pe-fl-step-arrow">&#x25BE;</div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Flow arrow between phases */}
            {idx < phases.length - 1 && <div className="pe-fl-arrow">&#x25BC;</div>}
          </div>
        );
      })}

      {/* Final Outputs */}
      {finalOutputs.length > 0 && (
        <>
          <div className="pe-fl-arrow">&#x25BC;</div>
          <div className="pe-fl-entry pe-fl-final">
            <div className="pe-fl-entry-label">FINAL OUTPUTS</div>
            {finalOutputs.map((out, i) => (
              <div key={i} className="pe-fl-entry-item">
                <span className="pe-fl-dot" style={{ background: fileColorHex(out) }} />
                <span style={{ color: fileColorHex(out) }}>{out}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}

// ─── Prompt Detail Panel (Right Side) ────────────────────────────────────────

function PromptDetailPanel({ file, pipeline }: { file: PromptFile; pipeline: PipelineScanResult }) {
  const [showRaw, setShowRaw] = useState(false);
  const [expandedFns, setExpandedFns] = useState<Set<string>>(() =>
    new Set(file.functions.filter(fn => fn.promptBody).map(fn => fn.name))
  );
  const [expandedConsts, setExpandedConsts] = useState<Set<string>>(() =>
    new Set((file.constants || []).map(c => c.name))
  );

  // Reset expanded state when file changes
  useEffect(() => {
    setExpandedFns(new Set(file.functions.filter(fn => fn.promptBody).map(fn => fn.name)));
    setExpandedConsts(new Set((file.constants || []).map(c => c.name)));
    setShowRaw(false);
  }, [file.path]);

  const toggleFn = (name: string) => {
    setExpandedFns(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  };

  const toggleConst = (name: string) => {
    setExpandedConsts(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  };

  const hasPromptContent = file.functions.some(fn => fn.promptBody) || (file.constants?.length > 0);
  const callSites = file.callSites || [];

  // Find which phase this file belongs to (for context)
  let parentPhase: PhaseInfo | null = null;
  for (const phase of pipeline.phases) {
    for (const step of phase.steps) {
      if (step.promptFiles.some(pf => pf.path === file.path)) {
        parentPhase = phase;
        break;
      }
    }
    if (parentPhase) break;
  }

  // Compute incoming files for this phase
  const incoming = parentPhase
    ? pipeline.crossPhaseFlow.filter(f => f.to.includes(parentPhase!.id))
    : [];

  return (
    <div className="pe-detail">
      {/* Header */}
      <div className="pe-detail-header">
        <div className="pe-detail-title">
          {parentPhase && (
            <span className="pe-detail-phase-tag">
              {parentPhase.label || humanize(parentPhase.name)}
            </span>
          )}
          <span className="pe-detail-filename">{shortFilename(file.relativePath)}</span>
        </div>
        <div className="pe-detail-meta">
          <span className="pe-detail-path">{file.relativePath}</span>
          <button className="pe-pv-toggle" onClick={() => setShowRaw(!showRaw)}>
            {showRaw ? 'Prompts' : 'Raw Code'}
          </button>
        </div>
      </div>

      <div className="pe-detail-body">
        {/* ─── Call Sites: Context & Data Sources ─────────────────────── */}
        {callSites.length > 0 && (
          <div className="pe-cs-section">
            <div className="pe-cs-title-row">CONTEXT &amp; DATA SOURCES</div>
            {callSites.map((cs, i) => (
              <div key={i} className="pe-cs-callsite">
                <div className="pe-cs-caller">
                  <span className="pe-cs-fn-name">{cs.functionName}()</span>
                  <span className="pe-cs-called-by">called by</span>
                  <span className="pe-cs-caller-file">{shortFilename(cs.callerRelativePath)}</span>
                  <span className="pe-fn-line">L{cs.lineNumber}</span>
                </div>
                {cs.arguments.length > 0 && (
                  <div className="pe-cs-args">
                    <span className="pe-cs-label">ARGS</span>
                    <div className="pe-cs-args-list">
                      {cs.arguments.map((arg, j) => (
                        <div key={j} className="pe-cs-arg">
                          <span className="pe-cs-arg-name">{arg.name}</span>
                          <span className="pe-cs-arg-eq">=</span>
                          <span className="pe-cs-arg-source">{arg.source}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {cs.nearbyFileLoads.length > 0 && (
                  <div className="pe-cs-loads">
                    <span className="pe-cs-label">FILES</span>
                    <div className="pe-cs-loads-list">
                      {cs.nearbyFileLoads.slice(0, 8).map((fl, j) => (
                        <span key={j} className={`pe-cs-load-chip pe-cs-load-${fl.method}`}>
                          {fl.method === 'glob' ? fl.filePath : fl.method === 'json_load' ? 'json' : shortFilename(fl.filePath)}
                        </span>
                      ))}
                      {cs.nearbyFileLoads.length > 8 && (
                        <span className="pe-cs-load-chip pe-cs-load-more">+{cs.nearbyFileLoads.length - 8}</span>
                      )}
                    </div>
                  </div>
                )}
                {cs.contextWrappers.length > 0 && (
                  <div className="pe-cs-loads">
                    <span className="pe-cs-label">WRAP</span>
                    <div className="pe-cs-loads-list">
                      {cs.contextWrappers.map((w, j) => (
                        <span key={j} className="pe-cs-load-chip pe-cs-load-wrap">{w}()</span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* ─── Phase Inputs (files coming from other phases) ──────────── */}
        {incoming.length > 0 && (
          <div className="pe-detail-inputs">
            <div className="pe-cs-title-row">INPUTS FROM OTHER PHASES</div>
            <div className="pe-detail-inputs-list">
              {incoming.map((f, i) => (
                <div key={i} className="pe-detail-input-item">
                  <span className="pe-fl-dot" style={{ background: fileColorHex(shortFile(f.from)) }} />
                  <span style={{ color: fileColorHex(shortFile(f.from)) }}>{shortFile(f.from)}</span>
                  <span className="pe-detail-input-src">&larr; {f.from.split('/')[0]}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ─── Prompt Content ──────────────────────────────────────────── */}
        {showRaw ? (
          <pre className="pe-code">{file.content}</pre>
        ) : !hasPromptContent ? (
          <pre className="pe-code">{file.content}</pre>
        ) : (
          <div className="pe-fn-list">
            {/* Module-level prompt constants */}
            {(file.constants || []).map(c => (
              <div key={c.name} className="pe-prompt-block">
                <div className="pe-prompt-header" onClick={() => toggleConst(c.name)}>
                  <span className="pe-prompt-expand">{expandedConsts.has(c.name) ? '\u25BC' : '\u25B6'}</span>
                  <span className="pe-prompt-type const-type">CONST</span>
                  <span className="pe-prompt-name">{c.name}</span>
                  {c.isFString && <span className="pe-prompt-fstr">f-string</span>}
                  <span className="pe-fn-line">L{c.lineNumber}</span>
                </div>
                {expandedConsts.has(c.name) && (
                  <pre className="pe-prompt-body">{c.value}</pre>
                )}
              </div>
            ))}

            {/* Functions with prompt bodies */}
            {file.functions.map(fn => {
              const fnCallSites = callSites.filter(cs => cs.functionName === fn.name);
              return (
                <div key={fn.name} className="pe-prompt-block">
                  <div className="pe-prompt-header" onClick={() => toggleFn(fn.name)}>
                    <span className="pe-prompt-expand">
                      {fn.promptBody ? (expandedFns.has(fn.name) ? '\u25BC' : '\u25B6') : '\u2013'}
                    </span>
                    <span className="pe-prompt-type def-type">DEF</span>
                    <span className="pe-fn-sig-compact">
                      <span className="pe-fn-name">{fn.name}</span>
                      (<span className="pe-fn-params">{fn.params.join(', ')}</span>)
                    </span>
                    {fnCallSites.length > 0 && (
                      <span className="pe-cs-inline-badge">{fnCallSites.length}x</span>
                    )}
                    {!fn.promptBody && <span className="pe-prompt-no-body">no return string</span>}
                    <span className="pe-fn-line">L{fn.lineNumber}</span>
                  </div>
                  {fn.docstring && <div className="pe-fn-doc">{fn.docstring}</div>}
                  {fn.promptBody && expandedFns.has(fn.name) && (
                    <pre className="pe-prompt-body">{fn.promptBody}</pre>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function humanize(name: string): string {
  return name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function fileColorHex(filename: string): string {
  if (filename.endsWith('.parquet')) return '#9ece6a';
  if (filename.endsWith('.json')) return '#e0af68';
  if (filename.endsWith('.md')) return '#7aa2f7';
  if (filename.match(/\.(png|jpg|jpeg|svg)/)) return '#bb9af7';
  if (filename.endsWith('.pdf')) return '#f7768e';
  if (filename.endsWith('.eco')) return '#7dcfff';
  if (filename.includes('*')) return '#9ece6a';
  return '#565f89';
}

function shortFile(ref: string): string {
  const parts = ref.split('/');
  return parts[parts.length - 1];
}

function shortFilename(relativePath: string): string {
  return relativePath.split('/').pop() || relativePath;
}
