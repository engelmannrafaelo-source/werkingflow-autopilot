/**
 * GET /api/panels/inspect
 *
 * Meta-endpoint that, for each registered panel, calls the primary GET
 * endpoints the panel consumes and reports status + shape. Lets operators
 * see which panels are fully headless-bedienbar from the API alone.
 *
 * Not an exhaustive audit — each panel is represented by its primary data
 * endpoints (the GETs that render the UI). Mutations (POST/PATCH/DELETE)
 * are not exercised here; they are listed for reference only.
 */

import { Router, Request, Response } from 'express';

interface EndpointProbe {
  method: 'GET';
  path: string;
  /** optional query string appended verbatim */
  query?: string;
}

interface PanelDefinition {
  name: string;
  component: string;
  coverage: 'full' | 'partial' | 'read-only';
  /** probes actually called */
  probes: EndpointProbe[];
  /** mutation endpoints (not probed, just documented) */
  mutations?: string[];
  /** gaps noted during the last UX pass */
  notes?: string;
}

const PANELS: PanelDefinition[] = [
  {
    name: 'mission',
    component: 'components/panels/MissionControl.tsx',
    coverage: 'full',
    probes: [
      { method: 'GET', path: '/api/mission/conversations' },
      { method: 'GET', path: '/api/mission/states' },
      { method: 'GET', path: '/api/mission/visibility' },
      { method: 'GET', path: '/api/projects' },
    ],
    mutations: [
      'POST /api/mission/start',
      'POST /api/mission/send',
      'POST /api/mission/activate',
      'DELETE /api/mission/conversation/:id',
    ],
  },
  {
    name: 'bridge-monitor',
    component: 'components/panels/BridgeMonitor/BridgeMonitor.tsx',
    coverage: 'read-only',
    probes: [
      { method: 'GET', path: '/api/bridge/guard/status' },
      { method: 'GET', path: '/api/bridge/metrics/overview' },
      { method: 'GET', path: '/api/bridge/metrics/cost' },
      { method: 'GET', path: '/api/bridge/metrics/apps' },
      { method: 'GET', path: '/api/bridge/metrics/limits' },
      { method: 'GET', path: '/api/bridge/stability' },
    ],
    notes: 'Guard-Config und Worker-Restart haben keine Mutations-API',
  },
  {
    name: 'qa-dashboard',
    component: 'components/panels/QADashboard/QADashboard.tsx',
    coverage: 'partial',
    probes: [
      { method: 'GET', path: '/api/qa/runs' },
    ],
    mutations: [
      'POST /api/qa/staleness/:app/retest',
      'POST /api/qa/coverage-gaps/:app/refresh',
    ],
    notes: 'Sub-Tabs (TestRuns, Scenarios, Backend) haben keine dedizierten GET-Endpoints',
  },
  {
    name: 'virtual-office',
    component: 'components/VirtualOffice.tsx',
    coverage: 'partial',
    probes: [
      { method: 'GET', path: '/api/agents/status' },
      { method: 'GET', path: '/api/team/events' },
    ],
    notes: 'Chat + Knowledge-Graph sind client-only State',
  },
  {
    name: 'repo-dashboard',
    component: 'components/panels/RepoDashboard/RepoDashboard.tsx',
    coverage: 'partial',
    probes: [
      { method: 'GET', path: '/api/repo-dashboard/repositories' },
      { method: 'GET', path: '/api/repo-dashboard/pipeline' },
      { method: 'GET', path: '/api/repo-dashboard/structure' },
      { method: 'GET', path: '/api/repo-dashboard/hierarchy' },
    ],
    mutations: ['POST /api/repo-dashboard/refresh'],
  },
  {
    name: 'maintenance',
    component: 'components/panels/MaintenancePanel/MaintenancePanel.tsx',
    coverage: 'partial',
    probes: [
      { method: 'GET', path: '/api/maintenance/status' },
    ],
    mutations: ['POST /api/maintenance/refresh', 'POST /api/maintenance/run'],
    notes: 'Team/Docs/Repos Sub-Tabs sind client-only',
  },
  {
    name: 'infisical-monitor',
    component: 'components/panels/InfisicalMonitor/InfisicalMonitor.tsx',
    coverage: 'partial',
    probes: [
      { method: 'GET', path: '/api/infisical/status' },
      { method: 'GET', path: '/api/infisical/projects' },
      { method: 'GET', path: '/api/infisical/syncs' },
      { method: 'GET', path: '/api/infisical/health' },
    ],
    mutations: ['POST /api/infisical/trigger-sync'],
  },
  {
    name: 'background-ops',
    component: 'components/BackgroundOpsPanel.tsx',
    coverage: 'read-only',
    probes: [
      { method: 'GET', path: '/api/background-ops' },
      { method: 'GET', path: '/api/peer-awareness' },
      { method: 'GET', path: '/api/auto-inject' },
    ],
    notes: 'Settings-Tab hat kein Backend',
  },
  {
    name: 'error-monitor',
    component: 'components/panels/ErrorMonitor/ErrorMonitor.tsx',
    coverage: 'full',
    probes: [
      { method: 'GET', path: '/api/errors', query: 'limit=20' },
    ],
    mutations: [
      'PUT /api/errors/:id',
      'DELETE /api/errors/:id',
      'POST /api/errors/:id/spawn-fix',
      'SSE /api/errors/stream',
    ],
  },
  {
    name: 'my-tasks',
    component: 'components/panels/MyTasksPanel/MyTasksPanel.tsx',
    coverage: 'full',
    probes: [
      { method: 'GET', path: '/api/partner/tasks' },
    ],
    mutations: [
      'POST /api/partner/tasks',
      'PATCH /api/partner/tasks/:id',
      'DELETE /api/partner/tasks/:id',
    ],
  },
  {
    name: 'admin-wr',
    component: 'components/panels/WerkingReportAdmin/WerkingReportAdmin.tsx',
    coverage: 'full',
    probes: [
      { method: 'GET', path: '/api/admin/wr/health' },
      { method: 'GET', path: '/api/admin/wr/system-health' },
      { method: 'GET', path: '/api/admin/wr/pipeline-health' },
      { method: 'GET', path: '/api/admin/wr/usage/stats' },
      { method: 'GET', path: '/api/admin/wr/billing/overview' },
      { method: 'GET', path: '/api/admin/wr/tenants', query: 'limit=10' },
      { method: 'GET', path: '/api/admin/wr/users', query: 'limit=10' },
      { method: 'GET', path: '/api/admin/wr/notifications' },
      { method: 'GET', path: '/api/admin/wr/developer-tokens' },
    ],
    mutations: [
      'POST /api/admin/wr/users/:id/approve',
      'POST /api/admin/wr/billing/top-up',
      'POST /api/admin/wr/developer-tokens',
    ],
  },
  {
    name: 'architecture-explorer',
    component: 'components/panels/ArchitectureExplorer/*.tsx',
    coverage: 'partial',
    probes: [
      { method: 'GET', path: '/api/architecture/graph' },
      { method: 'GET', path: '/api/architecture/status' },
      { method: 'GET', path: '/api/architecture/subgraphs' },
    ],
  },
  {
    name: 'calendar',
    component: 'components/Calendar*.tsx',
    coverage: 'full',
    probes: [
      { method: 'GET', path: '/api/calendar/events' },
    ],
    mutations: [
      'POST /api/calendar/events',
      'PUT /api/calendar/events/:id',
      'DELETE /api/calendar/events/:id',
    ],
  },
  {
    name: 'mail',
    component: 'components/Mail*.tsx',
    coverage: 'full',
    probes: [
      { method: 'GET', path: '/api/mail/config' },
      { method: 'GET', path: '/api/mail/drafts' },
      { method: 'GET', path: '/api/mail/messages', query: 'folder=INBOX&limit=10' },
    ],
    mutations: [
      'POST /api/mail/drafts',
      'POST /api/mail/drafts/:id/send',
      'DELETE /api/mail/drafts/:id',
    ],
  },
  {
    name: 'auto-inject',
    component: 'components/AutoInject*.tsx',
    coverage: 'full',
    probes: [
      { method: 'GET', path: '/api/auto-inject' },
    ],
    mutations: [
      'POST /api/auto-inject',
      'DELETE /api/auto-inject/session/:id',
    ],
  },
  {
    name: 'prompt-explorer',
    component: 'components/panels/PromptExplorer/*.tsx',
    coverage: 'partial',
    probes: [
      { method: 'GET', path: '/api/prompt-explorer/pipelines' },
    ],
    notes: 'Scan-Aktionen via POST, aber keine Mutation für Pipeline-Änderungen',
  },
  {
    name: 'business-angel',
    component: 'components/panels/BusinessAngelPanel.tsx',
    coverage: 'full',
    probes: [
      { method: 'GET', path: '/api/business-angel/context' },
      { method: 'GET', path: '/api/business-angel/sessions' },
      { method: 'GET', path: '/api/business-angel/session/active' },
      { method: 'GET', path: '/api/business-angel/files' },
    ],
    mutations: [
      'POST /api/business-angel/chat',
      'POST /api/business-angel/apply-diffs',
      'POST /api/business-angel/session/new',
      'POST /api/business-angel/session/end',
    ],
  },
  {
    name: 'activity-feed',
    component: 'components/ActivityFeedPanel.tsx',
    coverage: 'read-only',
    probes: [],
    notes: 'Rein client-side (Git-basiert, keine Backend-API)',
  },
  {
    name: 'conversation-queue',
    component: 'components/ConversationQueuePanel.tsx',
    coverage: 'partial',
    probes: [
      { method: 'GET', path: '/api/mission/conversations' },
      { method: 'GET', path: '/api/projects' },
    ],
    notes: 'Queue-Reorder nur lokal, keine API',
  },
  {
    name: 'prompt-templates',
    component: 'components/PromptTemplates*.tsx',
    coverage: 'full',
    probes: [
      { method: 'GET', path: '/api/prompt-templates' },
    ],
    mutations: [
      'POST /api/prompt-templates',
      'PUT /api/prompt-templates/:id',
      'DELETE /api/prompt-templates/:id',
    ],
  },
  {
    name: 'team',
    component: 'components/Team*.tsx',
    coverage: 'full',
    probes: [
      { method: 'GET', path: '/api/team/personas' },
      { method: 'GET', path: '/api/team/events' },
      { method: 'GET', path: '/api/team/task-board' },
      { method: 'GET', path: '/api/team/tasks' },
      { method: 'GET', path: '/api/team/knowledge/registry' },
    ],
    mutations: [
      'POST /api/team/tasks',
      'PATCH /api/team/tasks/:id',
      'DELETE /api/team/tasks/:id',
      'POST /api/team/chat/:personaId',
    ],
  },
  {
    name: 'panel-health',
    component: 'components/PanelHealth*.tsx',
    coverage: 'read-only',
    probes: [
      { method: 'GET', path: '/api/panel-health' },
      { method: 'GET', path: '/api/control/health' },
    ],
  },
];

const TIMEOUT_MS = 15000;
const SELF_BASE = 'http://localhost:4005';

interface ProbeResult {
  method: string;
  path: string;
  status: 'ok' | 'error';
  http?: number;
  latencyMs: number;
  bodyKeys?: string[];
  bodySize?: number;
  error?: string;
}

interface MutationProbeResult {
  method: string;
  path: string;
  status: 'wired' | 'missing';
  http?: number;
  error?: string;
}

interface PanelResult {
  name: string;
  component: string;
  coverage: PanelDefinition['coverage'];
  probes: ProbeResult[];
  mutations: string[];
  mutationProbes: MutationProbeResult[];
  notes?: string;
  allOk: boolean;
}

async function runProbe(probe: EndpointProbe, cookie: string | undefined): Promise<ProbeResult> {
  const url = `${SELF_BASE}${probe.path}${probe.query ? `?${probe.query}` : ''}`;
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: probe.method,
      headers: cookie ? { cookie } : {},
      signal: controller.signal,
    });
    const latencyMs = Date.now() - start;
    const text = await res.text();
    const contentType = res.headers.get('content-type') ?? '';
    // SPA-fallback detection: Vite serves index.html for unknown /api/* paths,
    // which returns HTTP 200 but is NOT the intended API — treat as error.
    const isSpaFallback =
      contentType.toLowerCase().includes('text/html') ||
      text.trimStart().startsWith('<!DOCTYPE');
    let bodyKeys: string[] | undefined;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        bodyKeys = Object.keys(parsed).slice(0, 12);
      } else if (Array.isArray(parsed)) {
        bodyKeys = ['<array>', `len=${parsed.length}`];
      }
    } catch {
      // non-JSON body — leave bodyKeys undefined
    }
    const ok = res.ok && !isSpaFallback;
    return {
      method: probe.method,
      path: probe.path + (probe.query ? `?${probe.query}` : ''),
      status: ok ? 'ok' : 'error',
      http: res.status,
      latencyMs,
      bodySize: text.length,
      bodyKeys,
      error: isSpaFallback ? 'SPA-fallback (route not registered)' : undefined,
    };
  } catch (err: unknown) {
    const latencyMs = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    return {
      method: probe.method,
      path: probe.path,
      status: 'error',
      latencyMs,
      error: message.slice(0, 160),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe a mutation endpoint with OPTIONS to verify the route is registered,
 * without triggering the actual handler. Parses entries like
 *   "POST /api/foo/bar"   or   "DELETE /api/foo/:id"
 * and replaces :params with a safe literal for the probe.
 *
 * Verdicts:
 *   - wired: OPTIONS returned non-HTML (Express matched a route)
 *   - missing: OPTIONS returned HTML (SPA-fallback — route not registered)
 */
async function runMutationProbe(entry: string): Promise<MutationProbeResult> {
  const match = entry.match(/^([A-Z]+)\s+(\/\S+)$/);
  if (!match) {
    return { method: '?', path: entry, status: 'missing', error: 'unparseable' };
  }
  const method = match[1];
  // Only probe HTTP methods; tags like "SSE" are informational only.
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    return { method, path: match[2], status: 'wired', error: `not probed (${method})` };
  }
  const path = match[2].replace(/:[A-Za-z_][A-Za-z0-9_]*/g, '__probe__');
  const url = `${SELF_BASE}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, { method: 'OPTIONS', signal: controller.signal });
    const text = await res.text();
    const contentType = res.headers.get('content-type') ?? '';
    const isSpaFallback =
      contentType.toLowerCase().includes('text/html') ||
      text.trimStart().startsWith('<!DOCTYPE');
    return {
      method,
      path,
      status: isSpaFallback ? 'missing' : 'wired',
      http: res.status,
      error: isSpaFallback ? 'SPA-fallback (route not registered)' : undefined,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { method, path, status: 'missing', error: message.slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }
}

const router = Router();

router.get('/api/panels/inspect', async (req: Request, res: Response) => {
  const startedAt = Date.now();
  const cookie = req.headers.cookie;
  const filter = typeof req.query.panel === 'string' ? req.query.panel : null;

  const panels = filter
    ? PANELS.filter(p => p.name === filter)
    : PANELS;

  // Probe sequentially. Running self-fetches in parallel starves this
  // same express process — some handlers do sync fs/git work that blocks
  // the event loop and causes fetch timers to fire on unrelated probes.
  const results: PanelResult[] = [];
  for (const panel of panels) {
    const probes: ProbeResult[] = [];
    for (const p of panel.probes) {
      probes.push(await runProbe(p, cookie));
    }
    const mutationProbes: MutationProbeResult[] = [];
    for (const m of panel.mutations ?? []) {
      mutationProbes.push(await runMutationProbe(m));
    }
    const getsOk = probes.length === 0 ? true : probes.every(p => p.status === 'ok');
    const mutationsOk = mutationProbes.every(m => m.status === 'wired');
    results.push({
      name: panel.name,
      component: panel.component,
      coverage: panel.coverage,
      probes,
      mutations: panel.mutations ?? [],
      mutationProbes,
      notes: panel.notes,
      allOk: getsOk && mutationsOk,
    });
  }

  const totalProbes = results.reduce((sum, r) => sum + r.probes.length, 0);
  const okProbes = results.reduce(
    (sum, r) => sum + r.probes.filter(p => p.status === 'ok').length,
    0,
  );
  const totalMutations = results.reduce((sum, r) => sum + r.mutationProbes.length, 0);
  const wiredMutations = results.reduce(
    (sum, r) => sum + r.mutationProbes.filter(m => m.status === 'wired').length,
    0,
  );
  const summary = {
    panels: results.length,
    panelsOk: results.filter(r => r.allOk).length,
    panelsWithFailures: results.filter(r => !r.allOk).map(r => r.name),
    probes: totalProbes,
    probesOk: okProbes,
    probesFailed: totalProbes - okProbes,
    mutations: totalMutations,
    mutationsWired: wiredMutations,
    mutationsMissing: totalMutations - wiredMutations,
    coverageBreakdown: {
      full: results.filter(r => r.coverage === 'full').length,
      partial: results.filter(r => r.coverage === 'partial').length,
      readOnly: results.filter(r => r.coverage === 'read-only').length,
    },
    durationMs: Date.now() - startedAt,
  };

  res.json({ summary, panels: results });
});

export default router;
