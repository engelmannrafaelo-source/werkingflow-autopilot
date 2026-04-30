/**
 * Section-Loading Bridge — calls the Python `inspect_pipeline.py` tool and
 * returns its JSON output verbatim, so the TS pipeline-scanner can enrich
 * its scan result with section-marker / sectioned-load / live-measurement
 * info without re-implementing that logic in TypeScript.
 *
 * The Python tool is the single source of truth for sectioned-loading state
 * (it AST-parses the ContextLoaders, reads section_registry.py, and
 * optionally measures real reductions against a live project). This module
 * is a thin RPC wrapper.
 *
 * Pipelines other than `werking-energy` currently have no Python inspector
 * (the registry + ContextManager.load_phase_section pattern is energy-only),
 * so this bridge only fires for `id === 'energy'`.
 */

import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

import { PATHS } from './config/paths.js';

// ─── Types — mirror the Python dataclass shapes exactly ──────────────────────

/** A single ``ctx_mgr.load_phase_section()`` call discovered in a ContextLoader. */
export interface SectionedLoaderCall {
  source_phase: number;
  requesting_phase: number;
  source_file: string;
}

/** A direct ``read_text()`` / ``open()`` reference to a phase output. */
export interface DirectRead {
  phase_dir: string;
  path: string;
}

/** Live-project measurement of one (source, requesting) phase boundary. */
export interface SectionLiveMeasurement {
  source_phase: number;
  requesting_phase: number;
  full_chars: number;
  sectioned_chars: number;
  reduction_pct: number;
  /** "markers" | "keywords" | "full" — which extraction strategy was used */
  strategy: string;
  sections_kept: string[];
}

/** Producer-side marker scan: how many `<!-- needed_by -->` are in the output. */
export interface ProducerMarkerInfo {
  file_chars?: number;
  marker_count?: number;
  tagged_consumers?: number[];
}

/** Per-phase enrichment from inspect_pipeline.py. */
export interface PhaseSectionInfo {
  phase_num: number;
  /** Python phase name (e.g. "Behavior Analysis") — may differ from annotations.label */
  py_name: string;
  description: string;
  sectioned_loads: SectionedLoaderCall[];
  direct_reads: DirectRead[];
  /** What downstream consumers ask of this producer phase (registry view) */
  consumers_need: Record<string, string[]>;
  /** Human-readable purpose lines, keyed by consumer phase number */
  consumers_descr: Record<string, string>;
  /** Live measurements keyed as "src->req" — only present with --project */
  live: Record<string, SectionLiveMeasurement>;
  producer_marker_info: ProducerMarkerInfo;
}

/** Top-level shape returned by the inspector. */
export interface InspectorJsonOutput {
  phases: PhaseSectionInfo[];
}

// ─── RPC ─────────────────────────────────────────────────────────────────────

const ENERGY_BACKEND_DIR = join(
  PATHS.werkingflowProductionDir,
  'apps/werking-energy/backend',
);
const INSPECT_SCRIPT = join(ENERGY_BACKEND_DIR, 'pipeline/inspect_pipeline.py');

/**
 * Run inspect_pipeline.py and return parsed JSON.
 *
 * `projectPath` is the optional pipeline-root of a real project run (e.g.
 * `…/local-storage/.../tenants/plasser/projects/Plasser_…/pipeline/Plasser_…`).
 * When provided, the inspector adds live-measurement fields per phase boundary.
 *
 * Returns `null` if the inspector script is missing (e.g. on partner-server
 * deployments without the energy pipeline checked out).
 */
export function runInspector(projectPath?: string): InspectorJsonOutput | null {
  if (!existsSync(INSPECT_SCRIPT)) {
    return null;
  }

  const args = ['pipeline/inspect_pipeline.py', '--json'];
  if (projectPath) {
    args.push('--project', projectPath);
  }

  // PYTHONPATH must include the backend root so the inspector can import
  // ``core.shared.section_registry`` (resolved via the symlinked ``core/``).
  const env = {
    ...process.env,
    PYTHONPATH: `${ENERGY_BACKEND_DIR}:${process.env.PYTHONPATH ?? ''}`,
    PYTHONUNBUFFERED: '1',
  };

  let stdout: string;
  try {
    stdout = execFileSync('python3', args, {
      cwd: ENERGY_BACKEND_DIR,
      env,
      encoding: 'utf-8',
      // Inspector runs against the local FS, so this should never block long.
      // Live measurements add ~100ms of file I/O at most.
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (err) {
    // Inspector errors are not fatal — the rest of the scan still works
    // without sectioned-loading info. Surface in console for debugging.
    console.error('[section-bridge] inspect_pipeline.py failed:', err);
    return null;
  }

  try {
    const phases = JSON.parse(stdout) as PhaseSectionInfo[];
    return { phases };
  } catch (err) {
    console.error('[section-bridge] failed to parse inspector JSON:', err);
    return null;
  }
}

/**
 * Build a quick lookup map: phase number → enrichment info.
 * Frontend / scanner consumers iterate by phase number, so flat is friendlier
 * than the raw array.
 */
export function indexByPhase(
  inspector: InspectorJsonOutput | null,
): Record<number, PhaseSectionInfo> {
  if (!inspector) return {};
  const out: Record<number, PhaseSectionInfo> = {};
  for (const p of inspector.phases) {
    out[p.phase_num] = p;
  }
  return out;
}
