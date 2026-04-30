# Prompt Explorer — Section-Loading Visualization

The CUI Prompt Explorer panel ("Pipeline Explorer" tile in the panel grid)
shows pipelines, phases, steps, prompt files, and how data flows between
phases. For the **WerkING Energy** pipeline the **Flow** tab additionally
shows section-loading info: which `<!-- needed_by: phase_X -->` markers each
phase emits, which `load_phase_section()` calls each consumer makes, and —
when a live project is selected — the actual reduction percentage for every
phase boundary.

## What the panel renders

| Element | What it tells you |
|---|---|
| **Phase header badge** `✓ N markers → M phases` (green) | The phase's output contains N `<!-- needed_by -->` markers tagged for M downstream phases |
| **Phase header badge** `⚠ no markers` (red) | The phase produces output but has no marker yet — downstream loaders fall back to keyword matching (or full content). Drift indicator. |
| **Phase header badge** `← N sectioned loads` (cyan) | This phase's ContextLoader makes N `ctx_mgr.load_phase_section()` calls upstream |
| **Cross-phase flow tag** `→ phase_6 (markers, -60%)` | Arrow to consumer with strategy + live reduction. Color-coded: green = markers active, amber = keyword fallback, red = full content (no reduction) |
| **Live project bar** (above flow) | Free-form path input. When set, all reduction percentages are measured against this real project's outputs. Persisted in `localStorage` so the path survives reloads. |
| `● live` badge | Confirms live measurements are active for the current scan |

## Architecture

```
Frontend (PromptExplorer panel)
  ├─ "Live project" text input + Apply / Clear / ● live badge
  └─ FlowDiagramView reads `pipeline.sectionEnrichment[phaseNum]`
      ├─ Phase header → producerMarkers + sectionedLoads counts
      └─ Cross-phase tag → liveMeasurements[`${src}->${req}`]

         ↓  GET /api/prompt-explorer/scan/energy?project=<absolute-path>

Backend (autopilot/cui/server)
  ├─ routes/prompt-explorer.ts  — passes ?project to the scanner
  ├─ pipeline-scanner.ts        — calls section-bridge for energy pipeline
  └─ section-bridge.ts          — execFileSync wrapping the Python inspector

         ↓  python3 pipeline/inspect_pipeline.py --json [--project PATH]

Python (werking-energy/backend/pipeline/inspect_pipeline.py)
  ├─ AST-parse of every phases/phase_NN/shared/context_loader.py
  ├─ section_registry.SECTION_NEEDS / DOWNSTREAM_DESCRIPTIONS
  ├─ phase_contracts.PHASE_CONTRACTS / step_runner.PHASE_STEP_DEFINITIONS
  └─ When --project: live measurements (markers / keywords / full + size delta)
```

The Python inspector is the single source of truth for section-loading
behaviour. The TS bridge is a thin RPC wrapper — it does not re-implement
any extraction logic, so there is no risk of TS/Python drift.

## API

```
GET /api/prompt-explorer/scan/:id
GET /api/prompt-explorer/scan/:id?project=<absolute-pipeline-root-path>
```

Response is the regular `PipelineScanResult`. For `id === 'energy'` the
response gains two extra fields:

- `sectionEnrichment: Record<phaseNum, PhaseSectionEnrichment>`
- `liveProjectPath: string | undefined`

`PhaseSectionEnrichment` shape (TS):

```ts
{
  sectionedLoads: { sourcePhase, requestingPhase, sourceFile }[];
  directReads:    { phaseDir, path }[];
  consumersNeed:  Record<consumerPhase, string[]>;        // keyword fallback
  consumersDescription: Record<consumerPhase, string>;   // human prose
  liveMeasurements: Record<"src->req", {
    sourcePhase, requestingPhase,
    fullChars, sectionedChars, reductionPct,
    strategy: "markers" | "keywords" | "full",
    sectionsKept: string[],
  }>;
  producerMarkers: { fileChars?, markerCount?, taggedConsumers? };
}
```

`liveMeasurements` is only populated when `?project=` is set.

## How to add section markers to a new producer prompt

1. Add the producer phase to `pipeline/shared/section_registry.py` —
   declare what each downstream consumer needs (keywords for fallback +
   human description for prompt injection):

   ```python
   SECTION_NEEDS = {
     ...
     8: { 6: ["my keyword"], ... },
   }
   DOWNSTREAM_DESCRIPTIONS = {
     6: { 8: "Phase 8 needs ... for the report." },
     ...
   }
   ```

2. In the producer's finalization prompt (`phases/phase_NN/.../prompts/...py`),
   import and inject `get_downstream_guidance(N)` at the top of the output
   structure instructions, then add `<!-- needed_by: phase_X, phase_Y -->`
   markers above each `##` heading whose content downstream phases need.
   See `phases/phase_05_behavior_analysis/step3_finalization/prompts/system_understanding_generation.py`
   for the canonical template.

3. In the consumer's ContextLoader, replace direct `read_text()` calls with
   `ctx_mgr.load_phase_section(source_phase=N, requesting_phase=M)`. Keyword
   fallback in `SECTION_NEEDS` keeps older runs working unchanged.

4. (Optional but recommended) re-run the affected pipeline against a real
   project to populate marker counts; reload the panel with the project
   path set, and confirm the new green badge appears.

## How to deploy after editing

The Express backend on `localhost:4005` runs the source tree directly via
`tsx`, so **server restart picks up `pipeline-scanner.ts` and
`section-bridge.ts` changes automatically**. The React frontend ships from
`dist/` — run `npm run build:local` (or just `vite build`) after any edit
to `PromptExplorer.tsx`, `FlowDiagramView.tsx`, or the CSS.

⚠ **Heads-up:** the same port 4005 process also hosts Mission Chat / Audit
endpoints used by Cockpit and other CUI sessions, so a hard restart kills
in-flight conversations. Schedule restarts deliberately (idle window) and
let users know.

```bash
# Frontend-only redeploy (no session impact):
cd /root/projekte/werkingflow/autopilot/cui
NODE_ENV=production npx vite build

# Backend redeploy (kills sessions on :4005):
pkill -f "tsx.*server/index.ts"   # or use the appropriate pm2 / supervisor command
# (the watcher / restart wrapper will bring it back; if not, run the
#  documented start command for your environment)
```

## Useful inspector CLI invocations

The Python inspector is also usable standalone:

```bash
cd /root/projekte/werkingflow-production/apps/werking-energy/backend
PYTHONPATH=. python3 pipeline/inspect_pipeline.py                    # markdown stdout
PYTHONPATH=. python3 pipeline/inspect_pipeline.py --json             # JSON stdout
PYTHONPATH=. python3 pipeline/inspect_pipeline.py --phase 5          # one phase only
PYTHONPATH=. python3 pipeline/inspect_pipeline.py --project /path/to/.../pipeline/<id> --out /tmp/PIPELINE.md
```

The standalone markdown form includes a top-level "Drift between data
sources" section that flags phases declared in `step_runner` but not in
`phase_contracts` (or vice versa) — handy for catching registry rot.

## Known caveats

- **Marker scan is currently `markdown`-only.** JSON producers (e.g.
  `Phase_4_FormulaDiscovery/CALCULATIONS_LIBRARY.json`) cannot embed HTML
  comments, so reduction for these is always reported as "full" until we
  add a parallel JSON-slim mechanism.
- **`PHASE_FILES[7]` defaults to `CALCULATED_SAVINGS.md`** — old diagnostic
  runs producing `DIAGNOSTIC_FINDINGS.md` show `phase 7 → phase 8` as
  ungemessen. Either rerun with the new producer or extend the registry to
  try both filenames.
- **Energy-only.** Other pipelines (`safety`, `rlb`, the engelmann
  workflows) have no Python inspector wired up and will simply not show
  `sectionEnrichment` — the panel renders the same way as before for them.
