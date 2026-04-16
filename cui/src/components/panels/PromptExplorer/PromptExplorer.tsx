/**
 * Prompt Explorer Panel — Split-Panel Pipeline Flow
 *
 * Left: Vertical flow list with expandable phases showing steps + prompt files.
 * Right: Selected prompt detail (content, call sites, data sources).
 * The flow context is NEVER lost — you always see where you are in the pipeline.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { validateApiResponse } from '../../../lib/validateApiResponse';
import { resilientFetch } from '../../../utils/resilientFetch';
import FlowDiagramView from './FlowDiagramView';
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
  name: string;
  relativePath?: string;
  functions?: PromptFunction[];
  constants?: PromptConstant[];
  content?: string;
  lastModified?: string;
  callSites?: PromptCallSite[];
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
  type?: 'phase-step' | 'flat-stage';
  phases?: PhaseInfo[];
  entryInputs?: string[];
  finalOutputs?: string[];
  crossPhaseFlow?: CrossPhaseFlow[];
  validationIssues?: ValidationIssue[];
  scannedAt?: string;
}

interface PipelineSummary {
  id: string;
  name: string;
  phaseCount?: number;
  totalPromptFiles?: number;
  issueCount?: number;
  hasErrors?: boolean;
}

// ─── File Tree Types ─────────────────────────────────────────────────────────

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

// ─── Main Component ──────────────────────────────────────────────────────────

export default function PromptExplorer() {
  const [pipelines, setPipelines] = useState<PipelineSummary[]>([]);
  const [activePipeline, setActivePipeline] = useState<PipelineScanResult | null>(null);
  const [viewMode, setViewMode] = useState<'list' | 'flow' | 'files'>('flow');
  const [expandedPhase, setExpandedPhase] = useState<string | null>(null);
  const [selectedPromptFile, setSelectedPromptFile] = useState<PromptFile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Files view state (shared between FileTreeNavigation and FilePreviewPanel)
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<FileContent | null>(null);
  const [fileLoading, setFileLoading] = useState(false);

  useEffect(() => {
    fetch('/api/prompt-explorer/pipelines')
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(raw => {
        const data = validateApiResponse<{ pipelines: PipelineSummary[] }>(raw, '/api/prompt-explorer/pipelines', {
          pipelines: 'array',
        });
        setPipelines(data.pipelines);
        setLoading(false);
      })
      .catch(err => { setError(`Failed to load: ${err.message}`); setLoading(false); });
  }, []);

  const loadPipeline = useCallback((id: string) => {
    setLoading(true);
    setExpandedPhase(null);
    setSelectedPromptFile(null);
    fetch(`/api/prompt-explorer/scan/${id}`)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(raw => {
        const data = validateApiResponse<PipelineScanResult>(raw, `/api/prompt-explorer/scan/${id}`, {
          id: 'string',
          name: 'string',
          basePath: 'string',
        });
        setActivePipeline(data);
        setLoading(false);
      })
      .catch(err => { setError(`Failed to scan: ${err.message}`); setLoading(false); });
  }, []);

  const loadFileContent = useCallback(async (path: string) => {
    setSelectedFilePath(path);
    setFileLoading(true);
    try {
      const res = await resilientFetch(`/api/file?path=${encodeURIComponent(path)}`);
      if (!res.ok) { setFileContent(null); setFileLoading(false); return; }
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const data = await res.json();
        setFileContent(data);
      } else {
        const text = await res.text();
        const ext = path.split('.').pop();
        setFileContent({ path, content: text, mimeType: contentType, ext: ext ? `.${ext}` : undefined });
      }
    } catch { setFileContent(null); }
    setFileLoading(false);
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
                  {p.phaseCount ?? 0} phases &middot; {p.totalPromptFiles ?? 0} prompts
                  {(p.issueCount ?? 0) > 0 && <span className="pe-badge">{p.issueCount ?? 0}</span>}
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
          <div className="pe-view-toggle">
            <button
              className={`pe-view-btn ${viewMode === 'flow' ? 'active' : ''}`}
              onClick={() => setViewMode('flow')}
              title="Flow Diagram"
            >Flow</button>
            <button
              className={`pe-view-btn ${viewMode === 'list' ? 'active' : ''}`}
              onClick={() => setViewMode('list')}
              title="List View"
            >List</button>
            <button
              className={`pe-view-btn ${viewMode === 'files' ? 'active' : ''}`}
              onClick={() => setViewMode('files')}
              title="Browse workflow files"
            >Files</button>
          </div>
          <span className="pe-scanned">{activePipeline.scannedAt ? new Date(activePipeline.scannedAt).toLocaleTimeString() : ''}</span>
        </div>
        <div className="pe-flow-list">
          {viewMode === 'flow' ? (
            <FlowDiagramView
              pipeline={activePipeline}
              selectedPromptFile={selectedPromptFile}
              onSelectPrompt={selectPrompt}
            />
          ) : viewMode === 'files' ? (
            <FileTreeNavigation
              basePath={activePipeline.basePath}
              selectedFilePath={selectedFilePath}
              onSelectFile={loadFileContent}
            />
          ) : (
            <FlowNavigation
              pipeline={activePipeline}
              expandedPhase={expandedPhase}
              selectedPromptFile={selectedPromptFile}
              onTogglePhase={togglePhase}
              onSelectPrompt={selectPrompt}
            />
          )}
        </div>
      </div>

      {/* ─── RIGHT: Detail Panel ────────────────────────────────────── */}
      <div className="pe-right">
        {viewMode === 'files' ? (
          <FilePreviewPanel
            basePath={activePipeline.basePath}
            selectedFilePath={selectedFilePath}
            fileContent={fileContent}
            loading={fileLoading}
          />
        ) : selectedPromptFile ? (
          <PromptDetailPanel file={selectedPromptFile} pipeline={activePipeline} />
        ) : (
          <div className="pe-right-empty">
            <div className="pe-right-empty-icon">&#x2190;</div>
            <div>Click on a prompt in the flow view</div>
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
  const phases = pipeline.phases ?? [];
  const entryInputs = pipeline.entryInputs ?? [];
  const finalOutputs = pipeline.finalOutputs ?? [];
  const crossPhaseFlow = pipeline.crossPhaseFlow ?? [];

  // Compute per-phase input/output counts from crossPhaseFlow
  const phaseInputCount = new Map<string, number>();
  const phaseOutputCount = new Map<string, number>();
  for (const flow of crossPhaseFlow) {
    const fromPhase = flow.from.split('/')[0];
    phaseOutputCount.set(fromPhase, (phaseOutputCount.get(fromPhase) || 0) + 1);
    for (const target of (flow.to ?? [])) {
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
        const promptCount = (phase.steps ?? []).reduce((n, s) => n + (s.promptFiles?.length ?? 0), 0);
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
                  {isCentralPrompts ? 'LIB' : pipeline.type === 'flat-stage' ? (phase.id ?? '').toUpperCase() : `P${phase.number ?? 0}`}
                </span>
                <div className="pe-fl-phase-info">
                  <span className="pe-fl-phase-name">
                    {isCentralPrompts ? 'Shared Prompt Library' : (phase.label || humanize(phase.name))}
                  </span>
                  <span className="pe-fl-phase-meta">
                    {isCentralPrompts
                      ? 'Wiederverwendbare Prompts die von mehreren Stages importiert werden'
                      : `${(phase.steps ?? []).length} step${(phase.steps ?? []).length !== 1 ? 's' : ''} \u00b7 ${promptCount} prompt${promptCount !== 1 ? 's' : ''}`
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
                {(phase.steps ?? []).map((step, stepIdx) => {
                  const hasExecOrder = (step.executionOrder ?? []).length > 0;

                  return (
                    <div key={step.id} className="pe-fl-step-group">
                      {/* Step header (only if multiple steps) */}
                      {(phase.steps ?? []).length > 1 && (
                        <div className="pe-fl-step-header">
                          <span className="pe-fl-step-num">{stepIdx + 1}</span>
                          <span className="pe-fl-step-name">{humanize(step.name)}</span>
                          {hasExecOrder && (
                            <span className="pe-fl-step-calls">{(step.executionOrder ?? []).length} calls</span>
                          )}
                        </div>
                      )}

                      {/* ─── Execution Order View (when call-site data exists) ─── */}
                      {hasExecOrder ? (
                        <div className="pe-fl-exec-flow">
                          {(step.executionOrder ?? []).map((call, ci) => {
                            // Find the prompt file for click-to-detail
                            const matchingPf = (step.promptFiles ?? []).find(pf =>
                              (pf.relativePath ?? '') === call.promptFile
                              || (pf.relativePath ?? '').endsWith(call.promptFile)
                            );
                            const isSelected = matchingPf && selectedPromptFile?.path === matchingPf?.path;

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
                                {ci < (step.executionOrder ?? []).length - 1 && (
                                  <div className="pe-fl-exec-arrow">&#x2193;</div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        /* ─── Fallback: File List (for library/no-call-site phases) ─── */
                        <>
                          {(step.promptFiles ?? []).map(pf => {
                            const isSelected = selectedPromptFile?.path === pf.path;
                            const fnNames = (pf.functions ?? []).filter(fn => fn.promptBody).map(fn => fn.name);
                            const constNames = (pf.constants ?? []).map(c => c.name);
                            const allNames = [...constNames, ...fnNames];
                            const csCount = pf.callSites?.length ?? 0;

                            return (
                              <div
                                key={pf.path}
                                className={`pe-fl-prompt-item ${isSelected ? 'selected' : ''}`}
                                onClick={() => onSelectPrompt(pf)}
                              >
                                <span className="pe-fl-prompt-icon">P</span>
                                <div className="pe-fl-prompt-info">
                                  <span className="pe-fl-prompt-name">{shortFilename(pf.relativePath ?? '')}</span>
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
                      {(phase.steps ?? []).length > 1 && stepIdx < (phase.steps ?? []).length - 1 && (
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
    new Set((file.functions ?? []).filter(fn => fn.promptBody).map(fn => fn.name))
  );
  const [expandedConsts, setExpandedConsts] = useState<Set<string>>(() =>
    new Set((file.constants ?? []).map(c => c.name))
  );

  // Reset expanded state when file changes
  useEffect(() => {
    setExpandedFns(new Set((file.functions ?? []).filter(fn => fn.promptBody).map(fn => fn.name)));
    setExpandedConsts(new Set((file.constants ?? []).map(c => c.name)));
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

  const hasPromptContent = (file.functions ?? []).some(fn => fn.promptBody) || ((file.constants?.length ?? 0) > 0);
  const callSites = file.callSites ?? [];

  // Find which phase this file belongs to (for context)
  let parentPhase: PhaseInfo | null = null;
  for (const phase of (pipeline.phases ?? [])) {
    for (const step of (phase.steps ?? [])) {
      if ((step.promptFiles ?? []).some(pf => pf.path === file.path)) {
        parentPhase = phase;
        break;
      }
    }
    if (parentPhase) break;
  }

  // Compute incoming files for this phase
  const incoming = parentPhase
    ? (pipeline.crossPhaseFlow ?? []).filter(f => (f.to ?? []).includes(parentPhase!.id ?? ''))
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
          <span className="pe-detail-filename">{shortFilename(file.relativePath ?? '')}</span>
        </div>
        <div className="pe-detail-meta">
          <span className="pe-detail-path">{file.relativePath ?? ''}</span>
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
          <pre className="pe-code">{file.content ?? ''}</pre>
        ) : !hasPromptContent ? (
          <pre className="pe-code">{file.content ?? ''}</pre>
        ) : (
          <div className="pe-fn-list">
            {/* Module-level prompt constants */}
            {(file.constants ?? []).map(c => (
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
            {(file.functions ?? []).map(fn => {
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

// ─── File Tree Navigation (Left Panel, Files Mode) ──────────────────────────

function FileTreeNavigation({ basePath, selectedFilePath, onSelectFile }: {
  basePath: string;
  selectedFilePath: string | null;
  onSelectFile: (path: string) => void;
}) {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [treeError, setTreeError] = useState<string | null>(null);
  const refreshInterval = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadTree = useCallback(async () => {
    try {
      const res = await resilientFetch(
        `/api/disk-tree?path=${encodeURIComponent(basePath)}&maxDepth=6&maxPerLevel=50`
      );
      if (!res.ok) { setTreeError(`Failed to load: ${res.status}`); return; }
      const data = await res.json();
      if (data.nodes && data.nodes.length > 0) {
        // disk-tree returns a flat array with IDs like "0", "0-1", "0-1-0"
        // Reconstruct the tree hierarchy from the flat array
        const nodeMap = new Map<string, TreeNode>();
        for (const n of data.nodes) {
          const extMatch = n.name.match(/(\.[^.]+)$/);
          nodeMap.set(n.id, {
            name: n.name,
            path: n.path,
            isDir: n.isDir,
            ext: extMatch ? extMatch[1] : null,
            children: n.isDir ? [] : undefined,
          });
        }
        // Build parent-child relationships from IDs
        for (const n of data.nodes) {
          const parts = n.id.split('-');
          if (parts.length > 1) {
            const parentId = parts.slice(0, -1).join('-');
            const parent = nodeMap.get(parentId);
            const child = nodeMap.get(n.id);
            if (parent && child && parent.children) {
              parent.children.push(child);
            }
          }
        }
        // Root is "0", its children are the top-level items
        const root = nodeMap.get('0');
        const topLevel = root?.children || [];
        setTree(topLevel);
        // Auto-expand first level dirs
        const firstLevel = new Set<string>();
        for (const child of topLevel) {
          if (child.isDir) firstLevel.add(child.path);
        }
        setExpanded(prev => new Set([...prev, ...firstLevel]));
      } else {
        setTree([]);
      }
      setTreeError(null);
    } catch (err: any) {
      setTreeError(err.message || 'Failed to load tree');
    }
  }, [basePath]);

  useEffect(() => {
    loadTree();
    refreshInterval.current = setInterval(loadTree, 15000);
    return () => { if (refreshInterval.current) clearInterval(refreshInterval.current); };
  }, [loadTree]);

  const toggleDir = useCallback((path: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }, []);

  const renderNode = (node: TreeNode, depth: number): React.ReactNode => {
    if (node.name.startsWith('.') || node.name === '__pycache__' || node.name === 'venv' || node.name === '.venv' || node.name === 'node_modules') {
      return null;
    }
    const isExp = expanded.has(node.path);
    const isSel = selectedFilePath === node.path;
    const ext = node.ext || '';

    return (
      <div key={node.path}>
        <div
          className={`pe-ft-item ${isSel ? 'selected' : ''} ${node.isDir ? 'dir' : ''}`}
          style={{ paddingLeft: 12 + depth * 16 }}
          onClick={() => node.isDir ? toggleDir(node.path) : onSelectFile(node.path)}
          title={node.path}
        >
          <span className="pe-ft-icon">
            {node.isDir ? (isExp ? '▼' : '▶') : getFileTreeIcon(ext)}
          </span>
          <span className="pe-ft-name">{node.name}</span>
          {node.isDir && node.children && (
            <span className="pe-ft-count">{node.children.filter(c => !c.name.startsWith('.')).length}</span>
          )}
        </div>
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

  if (treeError && !tree.length) {
    return <div className="pe-right-empty" style={{ fontSize: 11 }}>{treeError}</div>;
  }
  if (tree.length === 0) {
    return <div className="pe-right-empty">No files found</div>;
  }

  return (
    <>
      {tree
        .sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
          return a.name.localeCompare(b.name);
        })
        .map(node => renderNode(node, 0))}
    </>
  );
}

function getFileTreeIcon(ext: string | null | undefined): string {
  if (!ext) return '📄';
  switch (ext) {
    case '.py': return '🐍';
    case '.yaml': case '.yml': return '📋';
    case '.md': return '📝';
    case '.ts': case '.tsx': return '🔷';
    case '.js': case '.jsx': return '🟨';
    case '.json': return '{}';
    case '.sh': return '⚙️';
    default: return '📄';
  }
}

function getLanguageLabel(ext: string | undefined): string {
  if (!ext) return 'text';
  switch (ext) {
    case '.py': return 'python';
    case '.yaml': case '.yml': return 'yaml';
    case '.ts': case '.tsx': return 'typescript';
    case '.js': case '.jsx': return 'javascript';
    case '.json': return 'json';
    case '.sh': return 'bash';
    case '.md': return 'markdown';
    default: return 'text';
  }
}

// ─── File Preview Panel (Right Panel, Files Mode) ───────────────────────────

function FilePreviewPanel({ basePath, selectedFilePath, fileContent, loading: fileLoading }: {
  basePath: string;
  selectedFilePath: string | null;
  fileContent: FileContent | null;
  loading: boolean;
}) {
  if (fileLoading) {
    return <div className="pe-right-empty">Loading...</div>;
  }
  if (!selectedFilePath || !fileContent) {
    return (
      <div className="pe-right-empty">
        <div className="pe-right-empty-icon">📂</div>
        <div>Select a file from the tree to preview</div>
        <div style={{ fontSize: 10, opacity: 0.5, marginTop: 4 }}>
          Server path: {basePath}
        </div>
      </div>
    );
  }

  const ext = fileContent.ext || '';
  const isMarkdown = ext === '.md' || ext === '.mdx';
  const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.svg'].includes(ext);
  const shortPath = selectedFilePath.startsWith(basePath)
    ? selectedFilePath.slice(basePath.length).replace(/^\//, '')
    : selectedFilePath;

  return (
    <div className="pe-detail">
      <div className="pe-detail-header">
        <div className="pe-detail-title">
          <span className="pe-detail-filename">
            {getFileTreeIcon(ext)} {shortPath}
          </span>
        </div>
        <div className="pe-detail-meta">
          <span className="pe-detail-path">{selectedFilePath}</span>
          <span style={{ fontSize: 10, color: '#565f89' }}>{getLanguageLabel(ext)}</span>
        </div>
      </div>
      <div className="pe-detail-body" style={{ padding: 0 }}>
        {isImage ? (
          <div style={{ padding: 16, textAlign: 'center' }}>
            <img
              src={`/api/file?path=${encodeURIComponent(fileContent.path)}`}
              alt={fileContent.path}
              style={{ maxWidth: '100%', maxHeight: '80vh' }}
            />
          </div>
        ) : isMarkdown ? (
          <div style={{ padding: '12px 24px', maxWidth: 800 }}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{fileContent.content}</ReactMarkdown>
          </div>
        ) : (
          <pre className="pe-code" style={{ margin: 0, borderRadius: 0, border: 'none' }}>
            {fileContent.content.split('\n').map((line, i) => (
              <div key={i}>
                <span style={{ display: 'inline-block', width: 40, textAlign: 'right', color: '#3b4261', marginRight: 16, userSelect: 'none' }}>{i + 1}</span>
                <span>{line}</span>
              </div>
            ))}
          </pre>
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
