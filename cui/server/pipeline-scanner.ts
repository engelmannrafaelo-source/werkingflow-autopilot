/**
 * Pipeline Scanner — Code-First, Zero-Trust
 *
 * Scans pipeline directories live from the filesystem.
 * No separate registry that can go stale — the CODE is the source of truth.
 *
 * Tier 1: Filesystem Scan (phases, steps, prompt files)
 * Tier 2: AST-like analysis (function names, docstrings from Python)
 * Tier 3: Minimal annotations (cross-phase flow, labels) — validated against code
 */

import { existsSync, readFileSync, readdirSync, statSync, lstatSync, realpathSync } from 'fs';
import { join, basename, relative, resolve } from 'path';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PipelineConfig {
  id: string;
  name: string;
  basePath: string;
  type: 'phase-step' | 'flat-stage';
  /** Glob-like pattern for prompt discovery */
  promptPattern: string;
  /** Optional annotation file path (relative to basePath) */
  annotationFile?: string;
}

export interface PromptFunction {
  name: string;
  params: string[];
  docstring: string | null;
  lineNumber: number;
  /** Extracted prompt body (the f-string / return value) */
  promptBody: string | null;
}

/** Module-level prompt constant (e.g. SYSTEM_PROMPT = """...""") */
export interface PromptConstant {
  name: string;
  lineNumber: number;
  /** The string content */
  value: string;
  /** Whether it's an f-string */
  isFString: boolean;
}

/** A detected file load that feeds into a prompt (e.g. open(), read_text(), glob()) */
export interface FileLoadInfo {
  /** The variable or parameter this gets assigned to */
  targetVar: string;
  /** The file path or pattern being loaded (may contain variables) */
  filePath: string;
  /** How it's loaded: open, read_text, glob, json_load */
  method: string;
  lineNumber: number;
}

/** A detected call site where a prompt function is invoked */
export interface PromptCallSite {
  /** The prompt function being called (e.g. "get_extraction_prompt") */
  functionName: string;
  /** The file where the call happens */
  callerFile: string;
  callerRelativePath: string;
  lineNumber: number;
  /** Named arguments passed to the function and where they come from */
  arguments: { name: string; source: string }[];
  /** Files loaded in the same scope that likely feed into this call */
  nearbyFileLoads: FileLoadInfo[];
  /** Context wrappers applied (e.g. wrap_phase_context) */
  contextWrappers: string[];
}

export interface PromptFile {
  path: string;
  relativePath: string;
  functions: PromptFunction[];
  /** Module-level prompt constants */
  constants: PromptConstant[];
  /** Raw content for display */
  content: string;
  lastModified: string;
  /** Where this prompt file's functions are called from (call-site analysis) */
  callSites: PromptCallSite[];
}

/** A single prompt invocation in execution order within a step */
export interface PromptCallInOrder {
  /** 1-based execution order within this step */
  order: number;
  /** The prompt function or constant being used */
  name: string;
  /** Which prompt file it comes from */
  promptFile: string;
  /** Line number in the CALLER (stage file) — determines ordering */
  callerLine: number;
  /** Is this an inline prompt (embedded in stage code, not from prompts/) */
  isInline: boolean;
  /** Brief description of what this call does (from args/context) */
  context: string;
  /** Whether this is inside a loop (called per-item) */
  isLooped: boolean;
}

export interface StepInfo {
  id: string;
  name: string;
  dirName: string;
  hasPrompts: boolean;
  hasCode: boolean;
  promptFiles: PromptFile[];
  /** Inline prompts detected in orchestrator/stage files */
  inlinePrompts: { file: string; lineNumbers: number[]; }[];
  /** Ordered sequence of prompt calls within this step (derived from call-site line numbers) */
  executionOrder: PromptCallInOrder[];
}

export interface PhaseInfo {
  id: string;
  number: number;
  name: string;
  dirName: string;
  steps: StepInfo[];
  /** Label from annotations (human-readable) */
  label?: string;
  /** Whether this phase is iterative */
  iterative?: boolean;
}

export interface CrossPhaseFlow {
  from: string;
  to: string[];
}

export interface ValidationIssue {
  level: 'error' | 'warning';
  phase?: string;
  step?: string;
  message: string;
}

export interface PipelineScanResult {
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

// ─── Pipeline Registry (hardcoded paths — these ARE the source of truth) ─────

import { PATHS } from './config/paths.js';

const PIPELINE_CONFIGS: PipelineConfig[] = [
  {
    id: 'energy',
    name: 'WerkING Energy',
    basePath: `${PATHS.werkingflowProductionDir}/apps/werking-energy/backend/pipeline`,
    type: 'phase-step',
    promptPattern: 'phases/**/prompts/*.py',
    annotationFile: 'pipeline.annotations.yaml',
  },
  {
    id: 'safety',
    name: 'WerkING Safety',
    basePath: `${PATHS.werkingflowProductionDir}/apps/werking-safety/backend/core`,
    type: 'phase-step',
    promptPattern: 'phases/**/prompts/*.py',
    annotationFile: 'pipeline.annotations.yaml',
  },
  {
    id: 'rlb',
    name: 'RLB Campus',
    basePath: `${PATHS.projectsRoot}/B-0070_RLB_nachfolgeprojekt/pipeline`,
    type: 'flat-stage',
    promptPattern: 'prompts/*.py',
    annotationFile: 'pipeline.annotations.yaml',
  },
];

// ─── Python AST-like Parsing (regex-based, no external deps) ─────────────────

function extractPythonFunctions(content: string): PromptFunction[] {
  const functions: PromptFunction[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    // Match def foo(params) -> return_type:
    const match = lines[i].match(/^def\s+(\w+)\s*\(([^)]*)\)/);
    if (!match) continue;

    const name = match[1];
    const rawParams = match[2];
    const params = rawParams
      .split(',')
      .map(p => p.trim().split(':')[0].split('=')[0].trim())
      .filter(p => p && p !== 'self');

    // Determine function indent level
    const defIndent = lines[i].search(/\S/);

    // Look for docstring (next non-empty line after def)
    let docstring: string | null = null;
    for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
      const trimmed = lines[j].trim();
      if (!trimmed) continue;
      if (trimmed.startsWith('"""') || trimmed.startsWith("'''")) {
        const quote = trimmed.slice(0, 3);
        if (trimmed.endsWith(quote) && trimmed.length > 6) {
          docstring = trimmed.slice(3, -3).trim();
        } else {
          // Multi-line docstring
          const parts = [trimmed.slice(3)];
          for (let k = j + 1; k < Math.min(j + 20, lines.length); k++) {
            if (lines[k].trim().endsWith(quote)) {
              parts.push(lines[k].trim().slice(0, -3));
              break;
            }
            parts.push(lines[k].trim());
          }
          docstring = parts.join(' ').trim();
        }
      }
      break;
    }

    // Extract prompt body: find `return f"""..."""` or `return """..."""` within this function
    const promptBody = extractFunctionReturnString(lines, i + 1, defIndent);

    functions.push({ name, params, docstring, lineNumber: i + 1, promptBody });
  }

  return functions;
}

/** Extract the return string (f-string or regular string) from a function body */
function extractFunctionReturnString(lines: string[], startLine: number, defIndent: number): string | null {
  const bodyIndent = defIndent + 4; // Standard Python indent

  for (let i = startLine; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const lineIndent = lines[i].search(/\S/);

    // Stop if we hit another def/class at same or lesser indent (end of function)
    if (lineIndent >= 0 && lineIndent <= defIndent && i > startLine && (trimmed.startsWith('def ') || trimmed.startsWith('class '))) {
      break;
    }

    // Look for: return f"""..."""  or  return """..."""
    const returnMatch = trimmed.match(/^return\s+(f?)("""|''')/);
    if (!returnMatch) continue;

    const isFString = returnMatch[1] === 'f';
    const quote = returnMatch[2];

    // Check if single-line return
    const afterReturn = trimmed.slice(trimmed.indexOf(quote));
    if (afterReturn.indexOf(quote, 3) > 0) {
      // Single line: return f"""something"""
      return afterReturn.slice(3, afterReturn.indexOf(quote, 3));
    }

    // Multi-line: collect until closing """
    const bodyParts: string[] = [afterReturn.slice(3)];
    for (let j = i + 1; j < lines.length; j++) {
      const jTrimmed = lines[j].trimEnd();
      const closeIdx = jTrimmed.indexOf(quote);
      if (closeIdx >= 0) {
        bodyParts.push(jTrimmed.slice(0, closeIdx));
        break;
      }
      bodyParts.push(jTrimmed);
      // Safety: don't read more than 500 lines of prompt
      if (j - i > 500) break;
    }

    return bodyParts.join('\n');
  }

  return null;
}

/** Extract module-level prompt constants (PROMPT_NAME = """...""" or f"""...""") */
function extractPromptConstants(content: string): PromptConstant[] {
  const constants: PromptConstant[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match: NAME = """..."""  or  NAME = f"""..."""  (at module level, indent 0)
    const match = line.match(/^([A-Z][A-Z_0-9]*)\s*=\s*(f?)("""|''')/);
    if (!match) continue;

    const name = match[1];
    const isFString = match[2] === 'f';
    const quote = match[3];

    // Find content after the opening quotes
    const afterAssign = line.slice(line.indexOf(quote) + 3);

    // Check for single-line
    if (afterAssign.indexOf(quote) >= 0) {
      constants.push({
        name,
        lineNumber: i + 1,
        value: afterAssign.slice(0, afterAssign.indexOf(quote)),
        isFString,
      });
      continue;
    }

    // Multi-line: collect until closing quotes
    const parts: string[] = [afterAssign];
    for (let j = i + 1; j < lines.length; j++) {
      const jLine = lines[j].trimEnd();
      const closeIdx = jLine.indexOf(quote);
      if (closeIdx >= 0) {
        parts.push(jLine.slice(0, closeIdx));
        break;
      }
      parts.push(jLine);
      if (j - i > 500) break;
    }

    constants.push({
      name,
      lineNumber: i + 1,
      value: parts.join('\n'),
      isFString,
    });
  }

  return constants;
}

/** Extract top-level string constants that look like prompts */
function detectInlinePrompts(content: string): number[] {
  const lineNumbers: number[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    // Match patterns like: PROMPT = """ or SYSTEM_PROMPT = f""" or get_xxx_prompt
    if (/^[A-Z_]*PROMPT[A-Z_]*\s*=\s*(f?"""|f?''')/.test(trimmed)) {
      lineNumbers.push(i + 1);
    }
    if (/^def\s+_?get_\w*prompt\w*\s*\(/.test(trimmed)) {
      lineNumbers.push(i + 1);
    }
  }

  return lineNumbers;
}

// ─── Call-Site Analysis (traces WHERE prompt functions are called + WHAT they receive) ────

/** Find all Python files that import from prompt modules within a pipeline */
function findCallerFiles(basePath: string, promptFiles: PromptFile[]): string[] {
  const callerPaths: string[] = [];
  const promptModuleNames = new Set(
    promptFiles.map(pf => basename(pf.path, '.py'))
  );

  // Recursively find all .py files that aren't prompt files themselves
  const visitedDirs = new Set<string>();

  function walkDir(dir: string) {
    try {
      // Prevent symlink loops by tracking real paths
      const realDir = realpathSync(dir);
      if (visitedDirs.has(realDir)) return;
      visitedDirs.add(realDir);

      const entries = readdirSync(dir);
      for (const entry of entries) {
        if (entry === '__pycache__' || entry === 'node_modules' || entry === '.git') continue;
        const fullPath = join(dir, entry);
        try {
          const stat = statSync(fullPath);
          if (stat.isDirectory()) {
            walkDir(fullPath);
          } else if (entry.endsWith('.py') && entry !== '__init__.py') {
            // Skip if this IS a prompt file
            if (promptFiles.some(pf => pf.path === fullPath)) continue;
            // Quick check if it imports from any prompt module
            try {
              const content = readFileSync(fullPath, 'utf-8');
              const hasImport = [...promptModuleNames].some(mod =>
                content.includes(`prompts.${mod}`) ||
                content.includes(`prompts import ${mod}`) ||
                content.includes(`import ${mod}`)
              );
              // Also check for direct function name imports
              const hasDirectImport = promptFiles.some(pf =>
                pf.functions.some(fn =>
                  content.includes(`import ${fn.name}`) || content.includes(`, ${fn.name}`)
                ) ||
                pf.constants.some(c =>
                  content.includes(`import ${c.name}`) || content.includes(`, ${c.name}`)
                )
              );
              if (hasImport || hasDirectImport) {
                callerPaths.push(fullPath);
              }
            } catch { /* skip unreadable files */ }
          }
        } catch { /* skip stat errors */ }
      }
    } catch { /* skip unreadable dirs */ }
  }

  walkDir(basePath);
  return callerPaths;
}

/** Extract file-loading patterns from Python code */
function extractFileLoads(content: string): FileLoadInfo[] {
  const loads: FileLoadInfo[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Pattern: with open(path, 'r') as f:  or  open(path, 'r', encoding=...)
    const openMatch = trimmed.match(/(?:with\s+)?open\(\s*(.+?)\s*[,)]/);
    if (openMatch) {
      // Try to find what variable it's assigned to
      const assignMatch = trimmed.match(/(\w+)\s*=\s*.*\.read/);
      const varName = assignMatch ? assignMatch[1] : 'file_content';
      loads.push({
        targetVar: varName,
        filePath: openMatch[1].replace(/['"]/g, ''),
        method: 'open',
        lineNumber: i + 1,
      });
      continue;
    }

    // Pattern: path.read_text() or Path(x).read_text()
    const readTextMatch = trimmed.match(/(\w+)\s*=\s*(.+?)\.read_text\(/);
    if (readTextMatch) {
      loads.push({
        targetVar: readTextMatch[1],
        filePath: readTextMatch[2].trim(),
        method: 'read_text',
        lineNumber: i + 1,
      });
      continue;
    }

    // Pattern: json.load(f) or json.loads(f.read())
    const jsonLoadMatch = trimmed.match(/(\w+)\s*=\s*json\.loads?\(/);
    if (jsonLoadMatch) {
      loads.push({
        targetVar: jsonLoadMatch[1],
        filePath: '(json)',
        method: 'json_load',
        lineNumber: i + 1,
      });
      continue;
    }

    // Pattern: glob("pattern") or Path.glob("pattern")
    const globMatch = trimmed.match(/\.glob\(\s*["'](.+?)["']\s*\)/);
    if (globMatch) {
      const assignVar = trimmed.match(/for\s+(\w+)\s+in/) || trimmed.match(/(\w+)\s*=/);
      loads.push({
        targetVar: assignVar ? assignVar[1] : 'files',
        filePath: globMatch[1],
        method: 'glob',
        lineNumber: i + 1,
      });
      continue;
    }

    // Pattern: pd.read_parquet() or pd.read_csv()
    const pdMatch = trimmed.match(/(\w+)\s*=\s*pd\.read_(?:parquet|csv)\(\s*(.+?)\s*[,)]/);
    if (pdMatch) {
      loads.push({
        targetVar: pdMatch[1],
        filePath: pdMatch[2].replace(/['"]/g, ''),
        method: 'pandas_read',
        lineNumber: i + 1,
      });
    }
  }

  return loads;
}

/** Detect context wrapper function calls (wrap_phase_context, etc.) */
function extractContextWrappers(content: string): string[] {
  const wrappers: string[] = [];
  const wrapperPattern = /\b(wrap_\w+|build_context|_build_context|format_\w+_for_prompt)\s*\(/g;
  let match;
  while ((match = wrapperPattern.exec(content)) !== null) {
    if (!wrappers.includes(match[1])) {
      wrappers.push(match[1]);
    }
  }
  return wrappers;
}

/** Find where a specific prompt function is called and what arguments it receives */
function findCallSites(
  callerPath: string,
  callerContent: string,
  promptFile: PromptFile,
  basePath: string,
): PromptCallSite[] {
  const callSites: PromptCallSite[] = [];
  const lines = callerContent.split('\n');
  const fileLoads = extractFileLoads(callerContent);
  const contextWrappers = extractContextWrappers(callerContent);

  const promptModuleName = basename(promptFile.path, '.py');

  // First, verify this caller actually imports from THIS specific prompt file
  // Patterns: `from ..prompts.module_name import`, `from ..prompts import module_name`,
  //           `import module_name`, `prompts.module_name`
  const hasDirectImport = callerContent.includes(`prompts.${promptModuleName}`) ||
    callerContent.includes(`import ${promptModuleName}`) ||
    callerContent.includes(`, ${promptModuleName}`);

  // If no module-level import match, check for individual function imports
  const hasSpecificImport = promptFile.functions.some(fn =>
    callerContent.includes(`import ${fn.name}`) || callerContent.includes(`, ${fn.name}`)
  ) || promptFile.constants.some(c =>
    callerContent.includes(`import ${c.name}`) || callerContent.includes(`, ${c.name}`)
  );

  if (!hasDirectImport && !hasSpecificImport) return [];

  // Build set of all prompt function names
  const promptFnNames = new Set(promptFile.functions.map(fn => fn.name));

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Check if this line calls a prompt function
    for (const fnName of promptFnNames) {
      // Match: fnName( or module.fnName(
      const callPattern = new RegExp(`(?:^|\\W)((?:\\w+\\.)?${fnName})\\s*\\(`);
      const callMatch = line.match(callPattern);
      if (!callMatch) continue;

      // Extra validation for generic names like "get_prompt":
      // If the function name is very common, require module prefix or direct import
      if (fnName === 'get_prompt' || fnName === 'get_system_prompt') {
        const hasModulePrefix = line.includes(`${promptModuleName}.${fnName}`);
        const hasDirectFnImport = callerContent.includes(`import ${fnName}`) &&
          callerContent.includes(promptModuleName);
        if (!hasModulePrefix && !hasDirectFnImport) continue;
      }

      // Extract arguments from the call (may span multiple lines)
      const args = extractCallArguments(lines, i);

      callSites.push({
        functionName: fnName,
        callerFile: callerPath,
        callerRelativePath: relative(realpathSync(basePath), realpathSync(callerPath)),
        lineNumber: i + 1,
        arguments: args,
        nearbyFileLoads: fileLoads,
        contextWrappers,
      });
    }
  }

  return callSites;
}

/** Extract named arguments from a function call (possibly spanning multiple lines) */
function extractCallArguments(lines: string[], startLine: number): { name: string; source: string }[] {
  const args: { name: string; source: string }[] = [];

  // Collect the full call expression (may span multiple lines)
  let parenDepth = 0;
  let callText = '';
  let started = false;

  for (let i = startLine; i < Math.min(startLine + 30, lines.length); i++) {
    const line = lines[i];
    for (const ch of line) {
      if (ch === '(') { parenDepth++; started = true; }
      if (started) callText += ch;
      if (ch === ')') {
        parenDepth--;
        if (parenDepth === 0 && started) break;
      }
    }
    if (parenDepth === 0 && started) break;
    if (started) callText += '\n';
  }

  // Remove outer parens
  callText = callText.replace(/^\(/, '').replace(/\)$/, '');

  // Split by commas (respecting nested parens/brackets/strings)
  const argParts = splitArguments(callText);

  for (const part of argParts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    // Named argument: key=value
    const namedMatch = trimmed.match(/^(\w+)\s*=\s*(.+)$/s);
    if (namedMatch) {
      args.push({
        name: namedMatch[1],
        source: namedMatch[2].trim().split('\n')[0].slice(0, 100),
      });
    } else {
      // Positional argument
      args.push({
        name: `arg${args.length}`,
        source: trimmed.split('\n')[0].slice(0, 100),
      });
    }
  }

  return args;
}

/** Split comma-separated arguments respecting nested brackets and strings */
function splitArguments(text: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let inString: string | null = null;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      current += ch;
      if (ch === inString && text[i - 1] !== '\\') inString = null;
      continue;
    }

    if (ch === '"' || ch === "'") {
      // Check for triple quotes
      if (text.slice(i, i + 3) === '"""' || text.slice(i, i + 3) === "'''") {
        const triple = text.slice(i, i + 3);
        const endIdx = text.indexOf(triple, i + 3);
        if (endIdx >= 0) {
          current += text.slice(i, endIdx + 3);
          i = endIdx + 2;
          continue;
        }
      }
      inString = ch;
      current += ch;
      continue;
    }

    if (ch === '(' || ch === '[' || ch === '{') { depth++; current += ch; continue; }
    if (ch === ')' || ch === ']' || ch === '}') { depth--; current += ch; continue; }

    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }

    current += ch;
  }

  if (current.trim()) parts.push(current);
  return parts;
}

// ─── Filesystem Scanner ─────────────────────────────────────────────────────

function scanPromptFile(filePath: string, basePath: string): PromptFile | null {
  try {
    if (!existsSync(filePath)) return null;
    const content = readFileSync(filePath, 'utf-8');
    const stat = statSync(filePath);
    const functions = extractPythonFunctions(content);
    const constants = extractPromptConstants(content);

    return {
      path: filePath,
      relativePath: relative(basePath, filePath),
      functions,
      constants,
      content,
      lastModified: stat.mtime.toISOString(),
      callSites: [], // populated in post-scan call-site analysis
    };
  } catch {
    return null;
  }
}

function scanPhaseStepPipeline(config: PipelineConfig): PipelineScanResult {
  const issues: ValidationIssue[] = [];
  const phases: PhaseInfo[] = [];

  const phasesDir = join(config.basePath, 'phases');
  if (!existsSync(phasesDir)) {
    issues.push({ level: 'error', message: `Phases directory not found: ${phasesDir}` });
    return buildResult(config, phases, issues);
  }

  const phaseDirs = readdirSync(phasesDir)
    .filter(d => /^phase_\d+/.test(d))
    .sort();

  for (const phaseDir of phaseDirs) {
    const phaseMatch = phaseDir.match(/^phase_(\d+)_?(.*)$/);
    if (!phaseMatch) continue;

    const phaseNum = parseInt(phaseMatch[1], 10);
    const phaseName = phaseMatch[2] || `phase_${phaseNum}`;
    const phaseFullPath = join(phasesDir, phaseDir);

    if (!statSync(phaseFullPath).isDirectory()) continue;

    const steps: StepInfo[] = [];
    const entries = readdirSync(phaseFullPath);

    // Find step directories
    const stepDirs = entries
      .filter(d => /^step[_]?\d+/.test(d) && statSync(join(phaseFullPath, d)).isDirectory())
      .sort();

    for (const stepDir of stepDirs) {
      const stepMatch = stepDir.match(/^step[_]?(\d+)[_]?(.*)$/);
      if (!stepMatch) continue;

      const stepFullPath = join(phaseFullPath, stepDir);
      const hasPrompts = existsSync(join(stepFullPath, 'prompts'));
      const hasCode = existsSync(join(stepFullPath, 'code'));

      const promptFiles: PromptFile[] = [];
      if (hasPrompts) {
        const promptDir = join(stepFullPath, 'prompts');
        const pyFiles = readdirSync(promptDir).filter(f => f.endsWith('.py') && f !== '__init__.py');
        for (const pyFile of pyFiles) {
          const pf = scanPromptFile(join(promptDir, pyFile), config.basePath);
          if (pf) promptFiles.push(pf);
        }
      }

      // Check for inline prompts in code/ files
      const inlinePrompts: { file: string; lineNumbers: number[] }[] = [];
      if (hasCode) {
        const codeDir = join(stepFullPath, 'code');
        const pyFiles = readdirSync(codeDir).filter(f => f.endsWith('.py') && f !== '__init__.py');
        for (const pyFile of pyFiles) {
          try {
            const content = readFileSync(join(codeDir, pyFile), 'utf-8');
            const lines = detectInlinePrompts(content);
            if (lines.length > 0) {
              inlinePrompts.push({ file: relative(config.basePath, join(codeDir, pyFile)), lineNumbers: lines });
            }
          } catch { /* skip */ }
        }
      }

      steps.push({
        id: `step_${stepMatch[1]}`,
        name: stepMatch[2] || `step_${stepMatch[1]}`,
        dirName: stepDir,
        hasPrompts,
        hasCode,
        promptFiles,
        inlinePrompts,
        executionOrder: [],
      });
    }

    // Also check for prompts/ directly in phase dir (Safety pattern)
    if (existsSync(join(phaseFullPath, 'prompts'))) {
      const promptDir = join(phaseFullPath, 'prompts');
      const pyFiles = readdirSync(promptDir).filter(f => f.endsWith('.py') && f !== '__init__.py');

      if (pyFiles.length > 0 && steps.length === 0) {
        // Phase has prompts but no step dirs — create a virtual "main" step
        const promptFiles: PromptFile[] = [];
        for (const pyFile of pyFiles) {
          const pf = scanPromptFile(join(promptDir, pyFile), config.basePath);
          if (pf) promptFiles.push(pf);
        }
        steps.push({
          id: 'main',
          name: 'main',
          dirName: phaseDir,
          hasPrompts: true,
          hasCode: false,
          promptFiles,
          inlinePrompts: [],
          executionOrder: [],
        });
      } else if (pyFiles.length > 0) {
        // Phase has BOTH step dirs AND phase-level prompts — attach to phase
        const promptFiles: PromptFile[] = [];
        for (const pyFile of pyFiles) {
          const pf = scanPromptFile(join(promptDir, pyFile), config.basePath);
          if (pf) promptFiles.push(pf);
        }
        steps.unshift({
          id: 'phase_prompts',
          name: 'Phase-level Prompts',
          dirName: 'prompts',
          hasPrompts: true,
          hasCode: false,
          promptFiles,
          inlinePrompts: [],
          executionOrder: [],
        });
      }
    }

    // Check for orchestrator with inline prompts
    const orchestratorFiles = entries.filter(f =>
      f.includes('orchestrator') && f.endsWith('.py')
    );
    for (const orchFile of orchestratorFiles) {
      try {
        const content = readFileSync(join(phaseFullPath, orchFile), 'utf-8');
        const lines = detectInlinePrompts(content);
        if (lines.length > 0) {
          // Add inline prompts to first step or create a virtual one
          const inlineEntry = { file: relative(config.basePath, join(phaseFullPath, orchFile)), lineNumbers: lines };
          if (steps.length > 0) {
            steps[0].inlinePrompts.push(inlineEntry);
          } else {
            steps.push({
              id: 'orchestrator',
              name: 'Orchestrator (inline)',
              dirName: phaseDir,
              hasPrompts: false,
              hasCode: true,
              promptFiles: [],
              inlinePrompts: [inlineEntry],
              executionOrder: [],
            });
          }
        }
      } catch { /* skip */ }
    }

    if (steps.length === 0) {
      issues.push({ level: 'warning', phase: phaseDir, message: `Phase has no steps or prompts` });
    }

    phases.push({
      id: `phase_${phaseNum}`,
      number: phaseNum,
      name: phaseName,
      dirName: phaseDir,
      steps,
    });
  }

  return buildResult(config, phases, issues);
}

function scanFlatStagePipeline(config: PipelineConfig): PipelineScanResult {
  const issues: ValidationIssue[] = [];
  const phases: PhaseInfo[] = [];

  const stagesDir = join(config.basePath, 'stages');
  const promptsDir = join(config.basePath, 'prompts');

  if (!existsSync(stagesDir)) {
    issues.push({ level: 'error', message: `Stages directory not found: ${stagesDir}` });
    return buildResult(config, phases, issues);
  }

  // Scan central prompts/ directory
  const centralPromptFiles: PromptFile[] = [];
  if (existsSync(promptsDir)) {
    const pyFiles = readdirSync(promptsDir).filter(f => f.endsWith('.py') && f !== '__init__.py');
    for (const pyFile of pyFiles) {
      const pf = scanPromptFile(join(promptsDir, pyFile), config.basePath);
      if (pf) centralPromptFiles.push(pf);
    }
  }

  // Scan stage files
  const stageFiles = readdirSync(stagesDir)
    .filter(f => /^s\d+/.test(f) && f.endsWith('.py'))
    .sort();

  // Group stages by primary number (s07, s07b, s07c → group "07")
  const stageGroups = new Map<string, string[]>();
  for (const sf of stageFiles) {
    const match = sf.match(/^s(\d+)/);
    if (!match) continue;
    const group = match[1];
    if (!stageGroups.has(group)) stageGroups.set(group, []);
    stageGroups.get(group)!.push(sf);
  }

  for (const [groupNum, files] of stageGroups) {
    const steps: StepInfo[] = [];

    for (const stageFile of files) {
      const match = stageFile.match(/^s(\d+[a-z]?)_(.+)\.py$/);
      if (!match) continue;

      const stageId = match[1];
      const stageName = match[2];
      const filePath = join(stagesDir, stageFile);

      try {
        const content = readFileSync(filePath, 'utf-8');
        const inlineLines = detectInlinePrompts(content);
        const functions = extractPythonFunctions(content);

        // Check which central prompts this stage imports
        const importedPrompts: PromptFile[] = [];
        for (const cpf of centralPromptFiles) {
          const moduleName = basename(cpf.path, '.py');
          // Check for: from ..prompts.X import Y  or  from prompts.X import Y
          if (content.includes(`prompts.${moduleName}`) || content.includes(`from ..prompts import`)) {
            importedPrompts.push(cpf);
          }
        }

        steps.push({
          id: `s${stageId}`,
          name: stageName,
          dirName: stageFile,
          hasPrompts: importedPrompts.length > 0 || inlineLines.length > 0,
          hasCode: true,
          promptFiles: importedPrompts,
          inlinePrompts: inlineLines.length > 0
            ? [{ file: relative(config.basePath, filePath), lineNumbers: inlineLines }]
            : [],
          executionOrder: [],
        });
      } catch {
        issues.push({ level: 'warning', step: stageFile, message: `Could not read stage file` });
      }
    }

    // Use first stage's name as phase label
    const phaseName = steps.length > 0 ? steps[0].name : `stage_${groupNum}`;

    phases.push({
      id: `s${groupNum}`,
      number: parseInt(groupNum, 10),
      name: phaseName,
      dirName: `stages/s${groupNum}*`,
      steps,
    });
  }

  // Add central prompts as a special "phase"
  if (centralPromptFiles.length > 0) {
    phases.unshift({
      id: 'central_prompts',
      number: 0,
      name: 'Central Prompts',
      dirName: 'prompts/',
      steps: [{
        id: 'central',
        name: 'Shared Prompt Modules',
        dirName: 'prompts/',
        hasPrompts: true,
        hasCode: false,
        promptFiles: centralPromptFiles,
        inlinePrompts: [],
        executionOrder: [],
      }],
    });
  }

  return buildResult(config, phases, issues);
}

// ─── Annotations Loading + Validation ───────────────────────────────────────

interface AnnotationData {
  id?: string;
  name?: string;
  description?: string;
  phases?: Record<string, {
    label?: string;
    iterative?: boolean;
    loop_exit?: string;
  }>;
  cross_phase_flow?: Array<{
    from: string;
    to: string[];
  }>;
  entry_inputs?: string[];
  final_outputs?: string[];
}

function loadAnnotations(config: PipelineConfig): AnnotationData | null {
  if (!config.annotationFile) return null;
  const annoPath = join(config.basePath, config.annotationFile);
  if (!existsSync(annoPath)) return null;

  try {
    const content = readFileSync(annoPath, 'utf-8');
    // Simple YAML parser for our flat structure (no external deps)
    return parseSimpleYaml(content);
  } catch {
    return null;
  }
}

/** Minimal YAML parser — handles our annotation format only */
function parseSimpleYaml(content: string): AnnotationData {
  const result: AnnotationData = {};
  const lines = content.split('\n');
  let currentSection = '';
  let currentPhase = '';
  let currentFlow: { from: string; to: string[] } | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const indent = line.search(/\S/);

    // Top-level keys
    if (indent === 0) {
      const kv = trimmed.match(/^(\w+):\s*(.*)$/);
      if (kv) {
        currentSection = kv[1];
        if (kv[2] && !kv[2].startsWith('#')) {
          (result as any)[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
        }
        if (kv[1] === 'phases') result.phases = {};
        if (kv[1] === 'cross_phase_flow') result.cross_phase_flow = [];
        if (kv[1] === 'entry_inputs') result.entry_inputs = [];
        if (kv[1] === 'final_outputs') result.final_outputs = [];
      }
      continue;
    }

    // Phase section
    if (currentSection === 'phases' && indent === 2) {
      const phaseKey = trimmed.replace(':', '').trim();
      currentPhase = phaseKey;
      if (result.phases) result.phases[phaseKey] = {};
      continue;
    }

    if (currentSection === 'phases' && indent >= 4 && currentPhase && result.phases) {
      const kv = trimmed.match(/^(\w+):\s*(.+)$/);
      if (kv) {
        const val = kv[2].replace(/^["']|["']$/g, '');
        (result.phases[currentPhase] as any)[kv[1]] = val === 'true' ? true : val === 'false' ? false : val;
      }
      continue;
    }

    // Cross-phase flow
    if (currentSection === 'cross_phase_flow') {
      if (trimmed.startsWith('- from:')) {
        if (currentFlow) result.cross_phase_flow!.push(currentFlow);
        currentFlow = { from: trimmed.replace('- from:', '').trim().replace(/^["']|["']$/g, ''), to: [] };
      } else if (trimmed.startsWith('to:') && currentFlow) {
        // to: might be inline array
        const inlineArr = trimmed.match(/to:\s*\[(.+)\]/);
        if (inlineArr) {
          currentFlow.to = inlineArr[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
        }
      } else if (trimmed.startsWith('- ') && currentFlow) {
        currentFlow.to.push(trimmed.slice(2).trim().replace(/^["']|["']$/g, ''));
      }
      continue;
    }

    // List items for entry_inputs / final_outputs
    if ((currentSection === 'entry_inputs' || currentSection === 'final_outputs') && trimmed.startsWith('- ')) {
      const val = trimmed.slice(2).trim().replace(/^["']|["']$/g, '');
      (result as any)[currentSection]!.push(val);
    }
  }

  // Push last flow
  if (currentFlow && result.cross_phase_flow) {
    result.cross_phase_flow.push(currentFlow);
  }

  return result;
}

function applyAnnotations(result: PipelineScanResult, annotations: AnnotationData | null): void {
  if (!annotations) return;

  // Apply phase labels and flags
  if (annotations.phases) {
    for (const phase of result.phases) {
      const anno = annotations.phases[phase.id] || annotations.phases[phase.dirName];
      if (anno) {
        if (anno.label) phase.label = anno.label;
        if (anno.iterative !== undefined) phase.iterative = anno.iterative;
      }
    }

    // Validate: check for stale annotation references
    for (const annoPhaseId of Object.keys(annotations.phases)) {
      const found = result.phases.some(p => p.id === annoPhaseId || p.dirName === annoPhaseId);
      if (!found) {
        result.validationIssues.push({
          level: 'error',
          phase: annoPhaseId,
          message: `Annotation references phase "${annoPhaseId}" but it does not exist in the codebase`,
        });
      }
    }
  }

  // Apply cross-phase flow
  if (annotations.cross_phase_flow) {
    result.crossPhaseFlow = annotations.cross_phase_flow;
  }

  // Apply entry/exit info
  if (annotations.entry_inputs) result.entryInputs = annotations.entry_inputs;
  if (annotations.final_outputs) result.finalOutputs = annotations.final_outputs;
}

// ─── Result Builder ─────────────────────────────────────────────────────────

function buildResult(
  config: PipelineConfig,
  phases: PhaseInfo[],
  issues: ValidationIssue[],
): PipelineScanResult {
  return {
    id: config.id,
    name: config.name,
    basePath: config.basePath,
    type: config.type,
    phases,
    entryInputs: [],
    finalOutputs: [],
    crossPhaseFlow: [],
    validationIssues: issues,
    scannedAt: new Date().toISOString(),
  };
}

// ─── Public API ─────────────────────────────────────────────────────────────

/** Scan a single pipeline by ID */
export function scanPipeline(pipelineId: string): PipelineScanResult | null {
  const config = PIPELINE_CONFIGS.find(c => c.id === pipelineId);
  if (!config) return null;

  if (!existsSync(config.basePath)) {
    return {
      id: config.id,
      name: config.name,
      basePath: config.basePath,
      type: config.type,
      phases: [],
      entryInputs: [],
      finalOutputs: [],
      crossPhaseFlow: [],
      validationIssues: [{ level: 'error', message: `Base path not found: ${config.basePath}` }],
      scannedAt: new Date().toISOString(),
    };
  }

  const result = config.type === 'phase-step'
    ? scanPhaseStepPipeline(config)
    : scanFlatStagePipeline(config);

  // Load and apply annotations
  const annotations = loadAnnotations(config);
  applyAnnotations(result, annotations);

  // ─── Post-scan: Call-Site Analysis ─────────────────────────────────────
  // Collect all prompt files from the scan result
  const allPromptFiles: PromptFile[] = [];
  for (const phase of result.phases) {
    for (const step of phase.steps) {
      allPromptFiles.push(...step.promptFiles);
    }
  }

  if (allPromptFiles.length > 0) {
    // Find all Python files that import from prompt modules
    const callerPaths = findCallerFiles(config.basePath, allPromptFiles);

    // For each caller, find which prompt functions it calls and with what arguments
    for (const callerPath of callerPaths) {
      try {
        const callerContent = readFileSync(callerPath, 'utf-8');

        for (const pf of allPromptFiles) {
          const callSites = findCallSites(
            callerPath,
            callerContent,
            pf,
            config.basePath,
          );
          if (callSites.length > 0) {
            pf.callSites.push(...callSites);
          }
        }
      } catch { /* skip unreadable files */ }
    }
  }

  // ─── Post-scan: Build Execution Order per Step ────────────────────────
  // For each step, collect all prompt calls that originate FROM this step's
  // stage/orchestrator file, sorted by line number = execution order.
  for (const phase of result.phases) {
    for (const step of phase.steps) {
      const calls: PromptCallInOrder[] = [];

      // Collect call sites from prompt files that target this step's stage file
      for (const pf of step.promptFiles) {
        for (const cs of pf.callSites) {
          // Match caller to this step: check if the caller filename contains the step's stage file
          const callerBase = basename(cs.callerFile);
          const stepBase = step.dirName;

          // For flat-stage: step.dirName IS the stage file (e.g. "s05_consolidate_buildings.py")
          // For phase-step: step.dirName is a directory, check if caller is in that dir
          const isMatch = callerBase === stepBase
            || cs.callerRelativePath.includes(step.dirName)
            || (step.id.startsWith('s') && callerBase.startsWith(step.id.replace('s', 's')));

          if (isMatch) {
            // Detect if call is inside a for/while loop by checking nearby lines
            const isLooped = detectLoopContext(cs.callerFile, cs.lineNumber);

            // Build context from arguments
            const argSummary = cs.arguments.slice(0, 2)
              .map(a => `${a.name}=${a.source}`)
              .join(', ');

            calls.push({
              order: 0, // will be set after sorting
              name: cs.functionName,
              promptFile: pf.relativePath,
              callerLine: cs.lineNumber,
              isInline: false,
              context: argSummary || '',
              isLooped,
            });
          }
        }
      }

      // Add inline prompts
      for (const ip of step.inlinePrompts) {
        for (const lineNum of ip.lineNumbers) {
          calls.push({
            order: 0,
            name: '(inline prompt)',
            promptFile: ip.file,
            callerLine: lineNum,
            isInline: true,
            context: '',
            isLooped: false,
          });
        }
      }

      // Sort by line number (= execution order) and deduplicate same-line calls
      calls.sort((a, b) => a.callerLine - b.callerLine);

      // Deduplicate: if same function at same line (from duplicate call-site matches), keep one
      const seen = new Set<string>();
      const deduped = calls.filter(c => {
        const key = `${c.name}:${c.callerLine}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      // Assign 1-based order
      deduped.forEach((c, i) => { c.order = i + 1; });
      step.executionOrder = deduped;
    }
  }

  return result;
}

/** Detect if a line is inside a for/while loop by reading the caller file */
function detectLoopContext(callerFile: string, lineNumber: number): boolean {
  try {
    const content = readFileSync(callerFile, 'utf-8');
    const lines = content.split('\n');
    // Look at the 20 lines before this call for a for/while at lower indent
    const callLine = lines[lineNumber - 1] || '';
    const callIndent = callLine.search(/\S/);
    for (let i = lineNumber - 2; i >= Math.max(0, lineNumber - 25); i--) {
      const line = lines[i];
      const indent = line.search(/\S/);
      if (indent >= 0 && indent < callIndent && /^\s*(for |while |async for )/.test(line)) {
        return true;
      }
    }
  } catch { /* skip */ }
  return false;
}

/** Scan all registered pipelines */
export function scanAllPipelines(): PipelineScanResult[] {
  return PIPELINE_CONFIGS.map(c => scanPipeline(c.id)!).filter(Boolean);
}

/** Get list of registered pipeline IDs */
export function getPipelineIds(): string[] {
  return PIPELINE_CONFIGS.map(c => c.id);
}

/** Read a specific prompt file's content */
export function readPromptFile(absolutePath: string): string | null {
  try {
    if (!existsSync(absolutePath)) return null;
    // Security: only allow reading from known pipeline base paths
    const allowed = PIPELINE_CONFIGS.some(c => absolutePath.startsWith(c.basePath));
    if (!allowed) return null;
    return readFileSync(absolutePath, 'utf-8');
  } catch {
    return null;
  }
}
