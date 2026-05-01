/**
 * Prompt Explorer API — Live Pipeline & Prompt Scanner
 *
 * GET /api/prompt-explorer/pipelines          → List all pipelines (summary)
 * GET /api/prompt-explorer/scan/:id           → Full scan of one pipeline
 * GET /api/prompt-explorer/scan               → Full scan of all pipelines
 * GET /api/prompt-explorer/prompt?path=...    → Read a specific prompt file
 */

import { Router, Request, Response } from 'express';
import { scanPipeline, scanAllPipelines, getPipelineIds, readPromptFile } from '../pipeline-scanner.js';
import { runValidator } from '../section-bridge.js';

export function createPromptExplorerRouter(): Router {
  const router = Router();

  // List all registered pipelines (lightweight — no scanning)
  router.get('/pipelines', (_req: Request, res: Response) => {
    const ids = getPipelineIds();
    const pipelines = ids.map(id => {
      const result = scanPipeline(id);
      if (!result) return null;
      return {
        id: result.id,
        name: result.name,
        basePath: result.basePath,
        type: result.type,
        phaseCount: result.phases.length,
        totalPromptFiles: result.phases.reduce((sum, p) =>
          sum + p.steps.reduce((s, st) => s + st.promptFiles.length, 0), 0),
        issueCount: result.validationIssues.length,
        hasErrors: result.validationIssues.some(i => i.level === 'error'),
      };
    }).filter(Boolean);

    res.json({ pipelines });
  });

  // Full scan of a single pipeline.
  // Optional ?project=<absolute-pipeline-root> triggers live section-loading
  // measurements via the Python inspector (energy pipeline only).
  router.get('/scan/:id', (req: Request, res: Response) => {
    const liveProjectPath = typeof req.query.project === 'string' ? req.query.project : undefined;
    const result = scanPipeline(req.params.id, { liveProjectPath });
    if (!result) {
      res.status(404).json({ error: `Pipeline "${req.params.id}" not found` });
      return;
    }
    res.json(result);
  });

  // Full scan of all pipelines
  router.get('/scan', (_req: Request, res: Response) => {
    const results = scanAllPipelines();
    res.json({ pipelines: results });
  });

  // Run the Layer-0 prompt validator (energy pipeline only).
  // Returns the parsed JSON test results, including failures.
  router.get('/validator', (_req: Request, res: Response) => {
    const results = runValidator();
    if (results === null) {
      res.status(404).json({ error: 'Validator not available (non-energy deployment).' });
      return;
    }
    const errors = results.flatMap(r => r.findings.filter(f => f.severity === 'error')).length;
    const warnings = results.flatMap(r => r.findings.filter(f => f.severity === 'warning')).length;
    res.json({
      results,
      summary: {
        total_tests: results.length,
        passed: results.filter(r => r.passed).length,
        errors,
        warnings,
      },
    });
  });

  // Read a specific prompt file (security-checked in scanner)
  router.get('/prompt', (req: Request, res: Response) => {
    const filePath = req.query.path as string;
    if (!filePath) {
      res.status(400).json({ error: 'Missing "path" query parameter' });
      return;
    }

    const content = readPromptFile(filePath);
    if (content === null) {
      res.status(404).json({ error: `File not found or access denied: ${filePath}` });
      return;
    }

    res.json({ path: filePath, content });
  });

  return router;
}

