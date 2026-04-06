// =============================================================================
// Architecture Explorer — Backend Route
// =============================================================================
// GET  /api/architecture/graph   → Read MASTER.yaml, parse, return JSON (cached 30s)
// POST /api/architecture/refresh → Invalidate cache

import { Router } from 'express';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { load as yamlLoad } from 'js-yaml';

import { PATHS } from '../config/paths.js';

const ARCH_DIR = PATHS.architectureDir;
const MASTER_YAML_PATH = `${ARCH_DIR}/MASTER.yaml`;
const CACHE_TTL_MS = 30_000;

let cachedGraph: unknown = null;
let cacheTime = 0;

// Sub-graph cache: appId → { data, time }
const subgraphCache = new Map<string, { data: unknown; time: number }>();

const router = Router();

router.get('/graph', (_req, res) => {
  const now = Date.now();

  // Return cached if fresh
  if (cachedGraph && (now - cacheTime) < CACHE_TTL_MS) {
    res.json(cachedGraph);
    return;
  }

  // Read and parse MASTER.yaml
  if (!existsSync(MASTER_YAML_PATH)) {
    res.status(404).json({ error: `MASTER.yaml not found at ${MASTER_YAML_PATH}` });
    return;
  }

  try {
    const content = readFileSync(MASTER_YAML_PATH, 'utf-8');
    const parsed = yamlLoad(content);
    cachedGraph = parsed;
    cacheTime = now;
    res.json(parsed);
  } catch (err) {
    console.error('[architecture] YAML parse error:', err);
    res.status(500).json({ error: `Failed to parse MASTER.yaml: ${err instanceof Error ? err.message : String(err)}` });
  }
});

// GET /api/architecture/subgraph/:appId → Load app-specific sub-graph YAML
router.get('/subgraph/:appId', (req, res) => {
  const { appId } = req.params;
  const now = Date.now();

  // Sanitize appId (only alphanumeric + hyphens)
  if (!/^[a-z0-9-]+$/.test(appId)) {
    res.status(400).json({ error: `Invalid appId: ${appId}` });
    return;
  }

  // Return cached if fresh
  const cached = subgraphCache.get(appId);
  if (cached && (now - cached.time) < CACHE_TTL_MS) {
    res.json(cached.data);
    return;
  }

  const yamlPath = `${ARCH_DIR}/${appId}.yaml`;
  if (!existsSync(yamlPath)) {
    res.status(404).json({ error: `No sub-graph for ${appId}` });
    return;
  }

  try {
    const content = readFileSync(yamlPath, 'utf-8');
    const parsed = yamlLoad(content);
    subgraphCache.set(appId, { data: parsed, time: now });
    res.json(parsed);
  } catch (err) {
    console.error(`[architecture] Sub-graph parse error (${appId}):`, err);
    res.status(500).json({ error: `Failed to parse ${appId}.yaml: ${err instanceof Error ? err.message : String(err)}` });
  }
});

// GET /api/architecture/subgraphs → List available sub-graphs
router.get('/subgraphs', (_req, res) => {
  try {
    const files: string[] = readdirSync(ARCH_DIR);
    const subgraphs = files
      .filter((f: string) => f.endsWith('.yaml') && f !== 'MASTER.yaml')
      .map((f: string) => f.replace('.yaml', ''));
    res.json({ subgraphs });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.post('/refresh', (_req, res) => {
  cachedGraph = null;
  cacheTime = 0;
  subgraphCache.clear();
  res.json({ status: 'cache invalidated' });
});

export default router;
