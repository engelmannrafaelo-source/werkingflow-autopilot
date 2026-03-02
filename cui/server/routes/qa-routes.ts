/**
 * QA Dashboard Routes
 *
 * Aggregiert Test-Daten aus dem Unified-Tester für alle Apps:
 * - Registry JSONs (Scores, Coverage)
 * - Reports (Markdown mit Begründungen)
 * - Checkpoints (Resume-State)
 * - Live-Tests (PIDs)
 */

import express, { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const router: Router = express.Router();

// Base path für Unified-Tester
const UNIFIED_TESTER_ROOT = '/root/projekte/werkingflow/tests/unified-tester';
const COVERAGE_ROOT = path.join(UNIFIED_TESTER_ROOT, 'coverage/apps');
const REPORTS_ROOT = path.join(UNIFIED_TESTER_ROOT, 'reports');
const SCENARIOS_ROOT = path.join(UNIFIED_TESTER_ROOT, 'scenarios');

// Helper: Liest Registry JSON für eine App
function readAppRegistry(appId: string) {
  const registryPath = path.join(COVERAGE_ROOT, appId, 'registry.json');
  if (!fs.existsSync(registryPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
  } catch (err) {
    console.error(`[QA] Failed to read registry for ${appId}:`, err);
    return null;
  }
}

// Helper: Berechnet App-Statistiken aus Registry
function calculateAppStats(registry: any, appId: string) {
  if (!registry || !registry.features) {
    return {
      id: appId,
      totalFeatures: 0,
      testedFeatures: 0,
      coveragePercent: 0,
      avgScore: 0,
      status: 'untested' as const,
      lastTested: null,
      issues: 0,
      scores: { backend: null, frontend: null, visual: null }
    };
  }

  const features = Object.values(registry.features) as any[];
  const totalFeatures = features.length;
  const testedFeatures = features.filter(f => f.status === 'tested').length;

  // Scores sammeln
  const allScores: number[] = [];
  let backendScores: number[] = [];
  let frontendScores: number[] = [];
  let visualScores: number[] = [];
  let latestDate: string | null = null;
  let issueCount = 0;

  features.forEach(feature => {
    if (feature.combined_score != null) {
      allScores.push(feature.combined_score);
    }

    // Backend
    if (feature.tests?.local?.backend?.score != null) {
      backendScores.push(feature.tests.local.backend.score);
      const testedAt = feature.tests.local.backend.tested_at;
      if (testedAt && (!latestDate || testedAt > latestDate)) {
        latestDate = testedAt;
      }
    }

    // Frontend
    if (feature.tests?.local?.frontend?.score != null) {
      frontendScores.push(feature.tests.local.frontend.score);
      const testedAt = feature.tests.local.frontend.tested_at;
      if (testedAt && (!latestDate || testedAt > latestDate)) {
        latestDate = testedAt;
      }
    }

    // Visual
    if (feature.tests?.local?.visual?.score != null) {
      visualScores.push(feature.tests.local.visual.score);
      const testedAt = feature.tests.local.visual.tested_at;
      if (testedAt && (!latestDate || testedAt > latestDate)) {
        latestDate = testedAt;
      }
    }

    // Issues zählen (Score < 8.0 oder status failed)
    if (feature.combined_score != null && feature.combined_score < 8.0) {
      issueCount++;
    }
    if (feature.status === 'failed') {
      issueCount++;
    }
  });

  const avgScore = allScores.length > 0
    ? allScores.reduce((a, b) => a + b, 0) / allScores.length
    : 0;

  const coveragePercent = totalFeatures > 0
    ? (testedFeatures / totalFeatures) * 100
    : 0;

  // Status ermitteln
  let status: 'tested' | 'partial' | 'failing' | 'untested' = 'untested';
  if (testedFeatures === 0) {
    status = 'untested';
  } else if (issueCount > 0) {
    status = 'failing';
  } else if (testedFeatures < totalFeatures) {
    status = 'partial';
  } else {
    status = 'tested';
  }

  return {
    id: appId,
    totalFeatures,
    testedFeatures,
    coveragePercent: Math.round(coveragePercent * 10) / 10,
    avgScore: Math.round(avgScore * 10) / 10,
    status,
    lastTested: latestDate,
    issues: issueCount,
    scores: {
      backend: backendScores.length > 0
        ? Math.round((backendScores.reduce((a, b) => a + b, 0) / backendScores.length) * 10) / 10
        : null,
      frontend: frontendScores.length > 0
        ? Math.round((frontendScores.reduce((a, b) => a + b, 0) / frontendScores.length) * 10) / 10
        : null,
      visual: visualScores.length > 0
        ? Math.round((visualScores.reduce((a, b) => a + b, 0) / visualScores.length) * 10) / 10
        : null
    }
  };
}

// GET /api/qa/overview - Alle Apps aggregiert
router.get('/overview', (req: Request, res: Response) => {
  try {
    const apps: string[] = fs.existsSync(COVERAGE_ROOT)
      ? fs.readdirSync(COVERAGE_ROOT).filter(dir => {
          const stat = fs.statSync(path.join(COVERAGE_ROOT, dir));
          return stat.isDirectory();
        })
      : [];

    const appData = apps.map(appId => {
      const registry = readAppRegistry(appId);
      return calculateAppStats(registry, appId);
    }).filter(app => app.totalFeatures > 0); // Nur Apps mit Features

    // Totals berechnen
    const totals = {
      features: appData.reduce((sum, app) => sum + app.totalFeatures, 0),
      tested: appData.reduce((sum, app) => sum + app.testedFeatures, 0),
      coverage: 0,
      avgScore: 0,
      appsWithIssues: appData.filter(app => app.issues > 0).length
    };

    if (totals.features > 0) {
      totals.coverage = Math.round((totals.tested / totals.features) * 100 * 10) / 10;
    }

    const allScores = appData
      .filter(app => app.avgScore > 0)
      .map(app => app.avgScore);

    if (allScores.length > 0) {
      totals.avgScore = Math.round((allScores.reduce((a, b) => a + b, 0) / allScores.length) * 10) / 10;
    }

    res.json({
      apps: appData,
      totals
    });
  } catch (err) {
    console.error('[QA] Error in /overview:', err);
    res.status(500).json({ error: 'Failed to load overview data' });
  }
});

// GET /api/qa/app/:appId - Detail-View einer App
router.get('/app/:appId', (req: Request, res: Response) => {
  try {
    const { appId } = req.params;
    const registry = readAppRegistry(appId);

    if (!registry) {
      return res.status(404).json({ error: `App ${appId} not found` });
    }

    const features = Object.entries(registry.features || {}).map(([id, feature]: [string, any]) => {
      return {
        id,
        name: feature.name || id,
        combinedScore: feature.combined_score ?? null,
        status: feature.status || 'untested',
        tests: feature.tests || {},
        issues: feature.issues || [],
        surfaces: feature.surfaces || []
      };
    });

    const stats = calculateAppStats(registry, appId);

    // Niedrigster Score
    const scoredFeatures = features.filter(f => f.combinedScore != null);
    const lowestScore = scoredFeatures.length > 0
      ? scoredFeatures.reduce((min, f) => f.combinedScore! < (min?.combinedScore ?? 10) ? f : min)
      : null;

    // Untested Features
    const untestedFeatures = features
      .filter(f => f.status === 'untested')
      .map(f => f.id);

    res.json({
      app: appId,
      features,
      statistics: {
        totalFeatures: stats.totalFeatures,
        testedCount: stats.testedFeatures,
        avgScore: stats.avgScore,
        lowestScore: lowestScore ? { feature: lowestScore.id, score: lowestScore.combinedScore } : null,
        untestedFeatures
      }
    });
  } catch (err) {
    console.error(`[QA] Error in /app/${req.params.appId}:`, err);
    res.status(500).json({ error: 'Failed to load app data' });
  }
});

// GET /api/qa/runs - Laufende Tests + Checkpoints + Recent Reports
router.get('/runs', (req: Request, res: Response) => {
  try {
    // 1. Laufende Tests via test-runner.sh list
    const running: any[] = [];
    try {
      const listOutput = execSync(
        'cd /root/projekte/werkingflow/tests/unified-tester && ./test-runner.sh list 2>/dev/null || echo ""',
        { encoding: 'utf-8', timeout: 5000 }
      );

      // Parse Output (Format: "PID scenario logfile started")
      const lines = listOutput.trim().split('\n').filter(l => l && !l.startsWith('Running'));
      lines.forEach(line => {
        const match = line.match(/^(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/);
        if (match) {
          const [, pid, scenario, logFile, started] = match;
          running.push({ scenario, pid: parseInt(pid), startedAt: started, logFile });
        }
      });
    } catch (err) {
      console.warn('[QA] Failed to get running tests:', err);
    }

    // 2. Checkpoints
    const checkpoints: any[] = [];
    const checkpointDir = '/tmp/test-checkpoints';
    if (fs.existsSync(checkpointDir)) {
      const files = fs.readdirSync(checkpointDir).filter(f => f.endsWith('.json'));
      files.forEach(file => {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(checkpointDir, file), 'utf-8'));
          checkpoints.push({
            scenario: file.replace('.json', ''),
            savedAt: data.timestamp || null,
            turnNumber: data.current_turn || 0,
            canResume: true
          });
        } catch (err) {
          console.warn(`[QA] Failed to read checkpoint ${file}:`, err);
        }
      });
    }

    // 3. Recent Reports (letzte 50)
    const recentRuns: any[] = [];
    const scenariosDir = path.join(REPORTS_ROOT, 'scenarios');
    if (fs.existsSync(scenariosDir)) {
      const files = fs.readdirSync(scenariosDir)
        .filter(f => f.endsWith('.md'))
        .map(f => {
          const stat = fs.statSync(path.join(scenariosDir, f));
          return { file: f, mtime: stat.mtime };
        })
        .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
        .slice(0, 50);

      files.forEach(({ file, mtime }) => {
        // Parse filename: persona_scenario_timestamp_mode.md
        const parts = file.replace('.md', '').split('_');
        const persona = parts[0] || 'unknown';
        const timestamp = parts.find(p => /^\d{8}$/.test(p)) || null;
        const mode = parts[parts.length - 1] || 'unknown';

        // App ermitteln (sehr grob - könnte verbessert werden)
        let app = 'unknown';
        if (file.includes('werking') || file.includes('report')) app = 'werking-report';
        else if (file.includes('safety')) app = 'werking-safety';
        else if (file.includes('energy')) app = 'werking-energy';
        else if (file.includes('engelmann')) app = 'engelmann';

        recentRuns.push({
          file,
          persona,
          app,
          mode,
          timestamp: timestamp ? `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}` : null,
          path: path.join(scenariosDir, file)
        });
      });
    }

    res.json({
      running,
      checkpoints,
      recentRuns
    });
  } catch (err) {
    console.error('[QA] Error in /runs:', err);
    res.status(500).json({ error: 'Failed to load test runs data' });
  }
});

// GET /api/qa/report/:filename - Report-Inhalt mit Score-Extraktion
router.get('/report/:filename', (req: Request, res: Response) => {
  try {
    const { filename } = req.params;
    const reportPath = path.join(REPORTS_ROOT, 'scenarios', filename);

    if (!fs.existsSync(reportPath)) {
      return res.status(404).json({ error: 'Report not found' });
    }

    const content = fs.readFileSync(reportPath, 'utf-8');

    // Score extrahieren (Pattern: "UX Score: 8.5" oder "Score: 9.0")
    const scoreMatch = content.match(/(?:UX\s+)?Score:\s*(\d+(?:\.\d+)?)/i);
    const score = scoreMatch ? parseFloat(scoreMatch[1]) : null;

    // Begründung extrahieren (Section nach "## Bewertung" oder "## Assessment")
    let reasoning = null;
    const reasoningMatch = content.match(/##\s*(?:Bewertung|Assessment|Findings)\s*\n([\s\S]+?)(?:\n##|$)/i);
    if (reasoningMatch) {
      reasoning = reasoningMatch[1].trim();
    }

    res.json({
      filename,
      content,
      score,
      reasoning
    });
  } catch (err) {
    console.error(`[QA] Error in /report/${req.params.filename}:`, err);
    res.status(500).json({ error: 'Failed to load report' });
  }
});

// GET /api/qa/scenarios - Alle Szenarien über alle Apps
router.get('/scenarios', (req: Request, res: Response) => {
  try {
    const scenarios: any[] = [];

    if (!fs.existsSync(SCENARIOS_ROOT)) {
      return res.json({ scenarios: [] });
    }

    const apps = fs.readdirSync(SCENARIOS_ROOT).filter(dir => {
      const stat = fs.statSync(path.join(SCENARIOS_ROOT, dir));
      return stat.isDirectory();
    });

    apps.forEach(app => {
      const appDir = path.join(SCENARIOS_ROOT, app);
      const files = fs.readdirSync(appDir).filter(f => f.endsWith('.json'));

      files.forEach(file => {
        const scenarioId = file.replace('.json', '');
        const scenarioPath = path.join(appDir, file);

        try {
          const data = JSON.parse(fs.readFileSync(scenarioPath, 'utf-8'));
          scenarios.push({
            app,
            id: scenarioId,
            name: data.name || scenarioId,
            type: 'scenario',
            lastRun: null, // TODO: Aus Reports ermitteln
            status: 'unknown' // TODO: Aus Reports ermitteln
          });
        } catch (err) {
          console.warn(`[QA] Failed to parse scenario ${app}/${file}:`, err);
        }
      });
    });

    res.json({ scenarios });
  } catch (err) {
    console.error('[QA] Error in /scenarios:', err);
    res.status(500).json({ error: 'Failed to load scenarios' });
  }
});

// GET /api/qa/scores/trends - Score-Verlauf über Zeit
router.get('/scores/trends', (req: Request, res: Response) => {
  try {
    const apps: string[] = fs.existsSync(COVERAGE_ROOT)
      ? fs.readdirSync(COVERAGE_ROOT).filter(dir => {
          const stat = fs.statSync(path.join(COVERAGE_ROOT, dir));
          return stat.isDirectory();
        })
      : [];

    const trends: any[] = [];

    apps.forEach(appId => {
      const registry = readAppRegistry(appId);
      if (!registry || !registry.features) return;

      const features = Object.values(registry.features) as any[];

      // Alle Tests mit Timestamp sammeln
      features.forEach(feature => {
        ['backend', 'frontend', 'visual'].forEach(mode => {
          const test = feature.tests?.local?.[mode];
          if (test?.score != null && test.tested_at) {
            trends.push({
              date: test.tested_at.split('T')[0], // YYYY-MM-DD
              app: appId,
              feature: feature.name,
              mode,
              score: test.score
            });
          }
        });
      });
    });

    // Nach Datum sortieren
    trends.sort((a, b) => a.date.localeCompare(b.date));

    res.json({ trends });
  } catch (err) {
    console.error('[QA] Error in /scores/trends:', err);
    res.status(500).json({ error: 'Failed to load score trends' });
  }
});

export default router;
