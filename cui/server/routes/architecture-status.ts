// =============================================================================
// Architecture Explorer — Port Status Overlay
// =============================================================================
// GET /api/architecture/status → Check all ports from ports.json, return live status
// Uses TCP socket connect (no HTTP) for fast, reliable port checks.

import { Router } from 'express';
import { readFileSync, existsSync } from 'fs';
import { createConnection } from 'net';

import { PATHS } from '../config/paths.js';

const PORTS_JSON_PATH = PATHS.portsJsonPath;
const DEFAULT_TIMEOUT_MS = 3000;

interface PortCheck {
  port: number;
  appId: string;
  label: string;
  isBackend: boolean;
}

function checkPort(port: number, timeoutMs: number): Promise<{ online: boolean; latency_ms: number | null }> {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = createConnection({ host: 'localhost', port, timeout: timeoutMs });

    socket.on('connect', () => {
      const latency = Date.now() - start;
      socket.destroy();
      resolve({ online: true, latency_ms: latency });
    });

    socket.on('timeout', () => {
      socket.destroy();
      resolve({ online: false, latency_ms: null });
    });

    socket.on('error', () => {
      socket.destroy();
      resolve({ online: false, latency_ms: null });
    });
  });
}

const router = Router();

router.get('/', async (_req, res) => {
  if (!existsSync(PORTS_JSON_PATH)) {
    res.status(404).json({ error: 'ports.json not found' });
    return;
  }

  try {
    const content = readFileSync(PORTS_JSON_PATH, 'utf-8');
    const portsConfig = JSON.parse(content);
    const checks: PortCheck[] = [];

    // Collect ports from apps
    for (const [appId, appConfig] of Object.entries(portsConfig.apps || {})) {
      const cfg = appConfig as Record<string, unknown>;
      if (cfg.user_port) {
        checks.push({
          port: cfg.user_port as number,
          appId,
          label: (cfg.name as string) || appId,
          isBackend: false,
        });
      }
      if (cfg.backend_port) {
        checks.push({
          port: cfg.backend_port as number,
          appId,
          label: `${(cfg.name as string) || appId} (Backend)`,
          isBackend: true,
        });
      }
    }

    // CUI itself
    checks.push({ port: 4005, appId: 'cui', label: 'CUI', isBackend: false });

    // Watchdog
    checks.push({ port: 9090, appId: 'watchdog', label: 'Watchdog', isBackend: false });

    // Run all checks in parallel
    const results = await Promise.all(
      checks.map(async (check) => {
        const { online, latency_ms } = await checkPort(check.port, DEFAULT_TIMEOUT_MS);
        return { ...check, status: online ? 'online' as const : 'offline' as const, latency_ms };
      })
    );

    const healthy = results.filter((r) => r.status === 'online').length;

    // Build port→status map keyed by appId for easy frontend lookup
    const portMap: Record<string, { status: string; port: number; latency_ms: number | null; isBackend: boolean }> = {};
    for (const r of results) {
      const key = r.isBackend ? `${r.appId}-backend` : r.appId;
      portMap[key] = { status: r.status, port: r.port, latency_ms: r.latency_ms, isBackend: r.isBackend };
    }

    res.json({
      timestamp: new Date().toISOString(),
      healthy,
      total: results.length,
      ports: portMap,
    });
  } catch (err) {
    console.error('[architecture-status] Error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
