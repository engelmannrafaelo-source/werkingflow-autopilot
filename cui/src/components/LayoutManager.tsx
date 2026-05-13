import { useCallback, useRef, useState, useEffect, useMemo, lazy, Suspense } from 'react';
import { Layout, Model, TabNode, TabSetNode, BorderNode, IJsonModel, ITabSetRenderValues, ITabRenderValues, Actions, DockLocation, Rect, Action } from 'flexlayout-react';
import type { CuiStates } from '../types';
import { copyToClipboard } from '../utils/clipboard';
import { logCuiTelemetry } from '../lib/cuiTelemetry';
import { devPortUrl } from '../lib/devPortUrl';
import { useAuth } from '../contexts/AuthContext';
import { ACCOUNTS } from '../types';
const ACCOUNT_LABELS: Record<string, string> = Object.fromEntries(ACCOUNTS.map(a => [a.id, a.label]));

// --- flexlayout-react CPU fix ---
// flexlayout's internal useLayoutEffect hooks (no dep arrays) call getBoundingClientRect
// on every render and trigger redrawInternal() when sub-pixel float comparisons fail.
// This creates a continuous render loop consuming 100%+ CPU on a single core.
// Fix: Tolerance-based comparison stops re-render triggers from sub-pixel float jitter.
// Both equals() and equalSize() use strict === on getBoundingClientRect floats.
// equalSize() is critical: it's used in arePropsEqual to decide if tab CONTENT re-renders.
// Without this patch, ALL visible tab content re-renders on every flexlayout frame.
Rect.prototype.equals = function patchedEquals(rect: Rect | undefined) {
  if (!rect) return false;
  return Math.abs(this.x - rect.x) < 0.5
    && Math.abs(this.y - rect.y) < 0.5
    && Math.abs(this.width - rect.width) < 0.5
    && Math.abs(this.height - rect.height) < 0.5;
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- patching library method
const rectProto = Rect.prototype as any;
rectProto.equalSize = function patchedEqualSize(rect: Rect | undefined) {
  if (!rect) return false;
  return Math.abs(this.width - rect.width) < 0.5
    && Math.abs(this.height - rect.height) < 0.5;
};

// Throttle LayoutInternal.redrawInternal to max 4 calls/sec.
// Each call triggers full LayoutInternal render → useLayoutEffect hooks → getBoundingClientRect
// → forced synchronous browser layout. At 60fps this consumes 100% CPU.
// Layout ref → Layout class → selfRef → LayoutInternal (where redrawInternal lives).
interface FlexLayoutInternal {
  _redrawPatched?: boolean;
  redrawInternal?: (reason?: string) => void;
}
interface PatchableLayoutRef {
  selfRef?: { current?: FlexLayoutInternal };
}
function patchLayoutRedraw(layoutRef: PatchableLayoutRef | null) {
  const internal = layoutRef?.selfRef?.current;
  if (!internal || internal._redrawPatched) return;
  const orig = internal.redrawInternal;
  if (typeof orig !== 'function') return;
  let scheduled = false;
  internal.redrawInternal = (reason?: string) => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => { scheduled = false; orig.call(internal, reason); }, 250);
  };
  internal._redrawPatched = true;
}
// --- Critical-path panels (lightweight, needed immediately) ---
import CuiLitePanel from './panels/CuiLitePanel';
import ImageDrop from './panels/ImageDrop';
import BrowserPanel from './panels/BrowserPanel';
import FilePreview from './panels/FilePreview';
import NotesPanel from './panels/NotesPanel';
import ErrorBoundary from './ErrorBoundary';
import PanelConnectivityGuard from './panels/PanelConnectivityGuard';

// --- Heavy panels — aus Panel Registry (Single Source of Truth) ---
// Neues Panel? panelRegistry.ts editieren, NICHT diese Datei.
import {
  MissionControl, OfficePanel, KnowledgeFullscreen, WerkingReportAdmin,
  LinkedInPanel, BridgeMonitor, InfisicalMonitor, QADashboard, RepoDashboard,
  WatchdogPanel, BackgroundOpsPanel,
  ConversationQueuePanel, MaintenancePanel, UserInputAuditPanel,
  ArchitectureExplorer, ReportBuilder, PromptExplorer, BusinessAngelPanel, PrivatAngelPanel,
  MyTasksPanel, ActivityFeedPanel, PartnerInboxPanel,
  FeedbackPanel, TeamStatusPanel, BusinessDocsPanel, UploadPanel, ToolHub,
  CalendarPanel, MailPanel, ErrorMonitor, PartnerServerPanel, SandboxAngelPanel,
  PlatformAdmin,
  PANEL_NAMES, PANEL_MENU_OPTIONS,
} from './panelRegistry';
// LayoutBuilder ist Desktop-only — bleibt hier
const LayoutBuilder = lazy(() => import('./LayoutBuilder'));

import '../styles/office.css';

// Shared loading spinner for lazy panels
const PanelLoader = () => (
  <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--tn-text-muted)", fontSize: 11 }}>
    Loading panel...
  </div>
);

const API = '/api';

// Map workspace to default browser URL for new panels.
// devPortUrl picks subdomain proxy on partner / app-proxy on dev — see lib/devPortUrl.ts.
const WORKSPACE_BROWSER_PORTS: Record<string, number> = {
  "engelmann-ai-hub": 3009,
  "engelmann-dashboards": 4800,
  "engelmann-developer": 3009,
  "werking-energy": 3007,
  "werking-report": 3008,
  "werkingsafety": 3006,
};
const WORKSPACE_BROWSER_URLS: Record<string, string> = Object.fromEntries(
  Object.entries(WORKSPACE_BROWSER_PORTS).map(([ws, port]) => [ws, devPortUrl(port)])
);

function defaultLayout(workDir: string): IJsonModel {
  // Standard layout:
  //   [ Chat (top)             | Tool Hub ]
  //   [ Browser (workspace-App)|          ]
  const wsId = workDir.split('/').pop() || '';
  const port = WORKSPACE_BROWSER_PORTS[wsId];
  const browserUrl = port ? devPortUrl(port) : '';
  return {
    global: {
      tabEnableClose: true,
      tabEnablePopout: false,
      tabSetEnableMaximize: true,
      tabSetEnableDrop: true,
      tabSetEnableDrag: true,
      tabSetEnableDivide: true,
      splitterSize: 4,
      tabSetMinWidth: 200,
      tabSetMinHeight: 150,
    },
    borders: [],
    layout: {
      type: 'row',
      weight: 100,
      children: [
        {
          // Left column: Chat top, Browser bottom (workspace-specific App)
          type: 'row',
          weight: 70,
          children: [
            {
              type: 'tabset',
              weight: 60,
              children: [
                { type: 'tab', name: 'Chat', component: 'cui', config: {} },
              ],
            },
            {
              type: 'tabset',
              weight: 40,
              children: [
                { type: 'tab', name: 'Browser', component: 'browser', config: { url: browserUrl } },
              ],
            },
          ],
        },
        {
          // Right column: Tool Hub
          type: 'tabset',
          weight: 30,
          children: [
            { type: 'tab', name: 'Tool Hub', component: 'tool-hub', config: {} },
          ],
        },
      ],
    },
  };
}

interface ActivationPlan {
  projectId: string;
  conversations: Array<{ sessionId: string; accountId: string }>;
}

interface LayoutManagerProps {
  projectId: string;
  workDir: string;
  cuiStates?: CuiStates;
  onAttentionChange?: (needsAttention: boolean, state?: 'working' | 'needs_attention' | 'idle') => void;
  onCuiStateReset?: (cuiId: string) => void;
  pendingActivation?: ActivationPlan[] | null;
  onActivationProcessed?: (projectId?: string) => void;
  isActive?: boolean;
  onMissingSessions?: (count: number) => void;
}

export default function LayoutManager({ projectId, workDir, cuiStates = {}, onAttentionChange, onCuiStateReset, pendingActivation, onActivationProcessed, isActive, onMissingSessions }: LayoutManagerProps) {
  const { canAccessPanel } = useAuth();

  // Toggle sync for a tool identified by component name (driven by Tool Hub pin button).
  // If the component already exists as a tab in this layout: unsync + remove from here + delete everywhere.
  // If the component does NOT exist: add it as a synced tab in this layout + push to all others.
  const toggleSyncTool = useCallback((component: string, displayName: string) => {
    const m = modelRef.current;
    if (!m) return;

    // Find an existing tab with this component
    let existingTab: TabNode | null = null;
    m.visitNodes((n) => {
      if (existingTab) return;
      if (n.getType() === 'tab') {
        const t = n as TabNode;
        if (t.getComponent() === component) existingTab = t;
      }
    });

    if (existingTab) {
      // Already mounted → user is un-pinning: remove from this layout AND from all others
      const existingTabId = (existingTab as TabNode).getId();
      try { m.doAction(Actions.deleteTab(existingTabId)); } catch { /* ignore */ }
      fetch(`${API}/layouts/delete-synced-tab`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tabId: existingTabId }),
        signal: AbortSignal.timeout(5000),
      }).catch(err => console.warn('[LayoutManager] delete-synced-tab failed:', err));
      return;
    }

    // Not mounted → add synced tab to this layout + propagate to all others
    // Stable ID so all layouts reference the same tab (idempotent across sessions)
    const tabId = `#synced-${component}`;
    let targetTabsetId = '';
    m.visitNodes((n) => {
      if (!targetTabsetId && n.getType() === 'tabset') targetTabsetId = n.getId();
    });
    if (!targetTabsetId) return;

    const newConfig = { _synced: true };
    try {
      m.doAction(Actions.addNode(
        { type: 'tab', id: tabId, name: displayName, component, config: newConfig },
        targetTabsetId, DockLocation.CENTER, -1
      ));
    } catch (err) { console.warn('[LayoutManager] toggleSyncTool addNode failed:', err); return; }

    fetch(`${API}/layouts/sync-tab`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceProjectId: projectId,
        tabConfig: { id: tabId, name: displayName, component, config: newConfig },
      }),
      signal: AbortSignal.timeout(5000),
    }).catch(err => console.warn('[LayoutManager] sync-tab failed:', err));
  }, [projectId]);

  // Stale-while-revalidate: use cached layout instantly, refresh in background
  const [model, setModel] = useState<Model | null>(() => {
    try {
      const cached = localStorage.getItem(`cui-layout-${projectId}`);
      if (cached) return Model.fromJson(JSON.parse(cached));
    } catch (err) { console.warn('[LayoutManager] Corrupted layout cache in initializer:', err); }
    return null;
  });
  const [showBuilder, setShowBuilder] = useState(false);
  const [showSubSessions, setShowSubSessions] = useState<boolean>(() => {
    try { return localStorage.getItem('cui-show-sub-sessions') === 'true'; } catch { return false; }
  });
  const [attentionVersion, setAttentionVersion] = useState(0); // triggers re-evaluation of attention state
  // Ephemeral per-tab state — kept out of the persisted Tab-Config to prevent save-loops.
  // _attention (idle/working/needs_attention) flips multiple times per second and used to be
  // written into Tab-Config via updateNodeConfig → triggered onModelChange → POST → Echo → Loop.
  // _route (live navigation in a CUI tab) had the same problem on every navigate.
  // Both are now memory-only refs; setAttentionVersion(v+1) re-renders Tab-Headers when changed.
  // Cost: navigation within a Tab is not persisted across browser reloads — Tab returns to initialSessionId.
  const attentionByNodeRef = useRef<Map<string, string>>(new Map());
  const routeByNodeRef = useRef<Map<string, string>>(new Map());
  const templateRef = useRef<IJsonModel | null>(null);
  const layoutRef = useRef<Layout>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(null);
  const activeDirRef = useRef<string>(workDir);
  const controlWsRef = useRef<WebSocket | null>(null);

  // Per-session state tracking for tab indicators (updated via WS conv-attention events)
  // Key: sessionId, Value: { state, reason }
  const sessionStatesRef = useRef<Map<string, { state: string; reason?: string }>>(new Map());
  // Per-session pause tracking (updated via WS conv-paused events)
  const pausedSessionsRef = useRef<Set<string>>(new Set());
  // Force tab re-render counter (bumped when session states change)
  const [tabRenderTick, setTabRenderTick] = useState(0);

  // Refs for stable Layout callback props (prevent Layout re-render → revision++ → ALL tab content re-render)
  const cuiStatesRef = useRef(cuiStates);
  cuiStatesRef.current = cuiStates;
  const onCuiStateResetRef = useRef(onCuiStateReset);
  onCuiStateResetRef.current = onCuiStateReset;
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;
  const onMissingSessionsRef = useRef(onMissingSessions);
  onMissingSessionsRef.current = onMissingSessions;
  const modelRef = useRef<Model | null>(null);
  modelRef.current = model;
  const modelInitialized = model !== null;  // stable boolean: changes only once (null->Model)

  // Version tracking for optimistic concurrency: prevents stale browser from overwriting
  // a newer server layout (set via API). Server increments _v on every write.
  const currentLayoutVersionRef = useRef<number>(0);
  // Suppress the next handleModelChange call after an external layout is applied
  // (WebSocket control:apply-layout or 409 recovery) to avoid echoing back to server.
  // Time-based suppression: when set, ignore handleModelChange until this epoch ms.
  // Boolean flag was insufficient because onModelChange fires multiple times per setModel
  // (React Re-Renders); the first call consumed the flag, the second triggered an echo save.
  const suppressUntilRef = useRef<number>(0);
  // Self-echo detection: when we POST a layout, store its JSON (sans _v). When the server
  // broadcasts our own write back to us, we recognize it and skip setModel — preventing
  // the re-mount cascade that re-loads every Chat panel from scratch.
  const lastSavedJsonRef = useRef<string>('');

  // Background refresh: fetch fresh layout from server (stale-while-revalidate)
  // Model is already loaded from localStorage cache in useState initializer above
  useEffect(() => {
    let cancelled = false;
    const cacheKey = `cui-layout-${projectId}`;
    const tplCacheKey = `cui-template-${projectId}`;
    const hadCachedModel = model !== null;

    // Initialize version from localStorage cache so we don't send a stale _v=0
    if (hadCachedModel) {
      try {
        const cached = localStorage.getItem(cacheKey);
        if (cached) {
          const parsed = JSON.parse(cached);
          if (typeof parsed._v === 'number') {
            currentLayoutVersionRef.current = parsed._v;
          }
        }
      } catch { /* ignore */ }
    }

    // Load template cache if available
    try {
      const cachedTpl = localStorage.getItem(tplCacheKey);
      if (cachedTpl) templateRef.current = JSON.parse(cachedTpl);
    } catch (err) {
      console.warn('[LayoutManager] Corrupted template cache:', err);
      try { localStorage.removeItem(tplCacheKey); } catch (e) { console.warn('[LayoutManager] Failed to clear template cache:', e); }
    }

    // Fetch from server in background (update cache for next load)
    const fetchWithTimeout = (url: string, ms = 8000) =>
      fetch(url, { signal: AbortSignal.timeout(ms) }).then(r => r.ok ? r.json() : null).catch((err) => { console.warn('[LayoutManager] fetchWithTimeout failed for', url, ':', err); return null; });

    // Template fetch differentiates "server says no template" from network error.
    // Server GET /layouts/:id/template returns 200 with null body when file is missing.
    // Sentinel { _deleted: true } means server confirmed no template → clear stale client cache.
    const fetchTemplate = (url: string, ms = 8000): Promise<IJsonModel | { _deleted: true } | null> =>
      fetch(url, { signal: AbortSignal.timeout(ms) })
        .then(async r => {
          if (r.status === 404) return { _deleted: true } as const;
          if (!r.ok) return null;
          const body = await r.json();
          return body === null ? { _deleted: true } as const : body;
        })
        .catch((err) => { console.warn('[LayoutManager] fetchTemplate failed for', url, ':', err); return null; });

    Promise.all([
      fetchWithTimeout(`${API}/layouts/${projectId}`),
      fetchTemplate(`${API}/layouts/${projectId}/template`),
      fetchWithTimeout(`${API}/active-dir/${projectId}`),
    ]).then(([layoutJson, tplResult, activeDir]) => {
      if (cancelled) return;
      if (activeDir?.path) activeDirRef.current = activeDir.path;
      if (tplResult && '_deleted' in tplResult) {
        // Server explicitly has no template — clear stale cache so reset uses defaultLayout
        templateRef.current = null;
        try { localStorage.removeItem(tplCacheKey); } catch (e) { console.warn('[LayoutManager] Failed to clear template cache:', e); }
      } else if (tplResult) {
        templateRef.current = tplResult as IJsonModel;
        try { localStorage.setItem(tplCacheKey, JSON.stringify(tplResult)); } catch (e) { console.warn('[LayoutManager] Failed to cache template:', e); }
      }
      if (layoutJson) {
        // Cache for next load
        try { localStorage.setItem(cacheKey, JSON.stringify(layoutJson)); } catch (e) { console.warn('[LayoutManager] Failed to cache layout:', e); }
        const serverV = typeof layoutJson._v === 'number' ? layoutJson._v : -1;
        if (serverV > currentLayoutVersionRef.current) {
          // Server has a newer version (e.g. set via API) — apply it and suppress echo.
          // Suppression must outlast handleModelChange's 1500ms debounce, otherwise the post-setModel
          // onChange wave fires saveLayout → 409 → re-mount loop with WS disconnect storm.
          currentLayoutVersionRef.current = serverV;
          suppressUntilRef.current = Date.now() + 2500;
          if (saveTimer.current) clearTimeout(saveTimer.current);
          try { setModel(Model.fromJson(layoutJson)); } catch (e) { console.warn('[LayoutManager] Failed to parse server layout JSON:', e); }
        } else if (!hadCachedModel) {
          // No local cache at all — apply whatever the server has
          if (serverV >= 0) currentLayoutVersionRef.current = serverV;
          try { setModel(Model.fromJson(layoutJson)); } catch (e) { console.warn('[LayoutManager] Failed to parse server layout JSON:', e); }
        }
        return;
      }
      // Server returned nothing — use default if not loaded from cache
      if (!hadCachedModel) {
        try { setModel(Model.fromJson(defaultLayout(activeDirRef.current))); } catch (e) { console.warn('[LayoutManager] Failed to create default layout model:', e); }
      }
    });

    // If nothing loaded after 3s (no cache, server slow), show default
    if (!hadCachedModel) {
      const fallbackTimer = setTimeout(() => {
        if (cancelled) return;
        try { setModel(prev => prev ?? Model.fromJson(defaultLayout(activeDirRef.current))); } catch (e) { console.warn('[LayoutManager] Failed to create fallback layout model:', e); }
      }, 3000);
      return () => { cancelled = true; clearTimeout(fallbackTimer); };
    }
    return () => { cancelled = true; };
  }, [projectId, workDir]);

  // Read ephemeral per-tab state. Falls back to Tab-Config so old persisted layouts
  // (with _attention/_route saved) still work during the transition.
  const getNodeAttention = useCallback((node: TabNode): string | undefined => {
    return attentionByNodeRef.current.get(node.getId()) ?? (node.getConfig()?._attention as string | undefined);
  }, []);
  const getNodeRoute = useCallback((node: TabNode): string | undefined => {
    return routeByNodeRef.current.get(node.getId()) ?? (node.getConfig()?._route as string | undefined);
  }, []);

  // Update a tab node's config and trigger debounced layout save
  const updateNodeConfig = useCallback((nodeId: string, patch: Record<string, string>) => {
    const m = modelRef.current;
    if (!m) return;
    try {
      const node = m.getNodeById(nodeId) as TabNode | null;
      if (!node) return;
      const existing = node.getConfig() ?? {};
      m.doAction(Actions.updateNodeAttributes(nodeId, { config: { ...existing, ...patch } }));
    } catch (err) { console.warn('[LayoutManager] updateNodeConfig failed for', nodeId, ':', err); }
  }, []);

  const factory = useCallback((node: TabNode) => {
    const component = node.getComponent();
    const config = node.getConfig() ?? {};
    const nodeId = node.getId();

    // Wrapper with data-node-id for screenshot targeting + ErrorBoundary for crash isolation
    // contain: strict limits layout recalculation scope when flexlayout measures via getBoundingClientRect
    const cleanNodeId = nodeId.replace(/^#/, '');
    const wrapPanel = (panelName: string, children: React.ReactNode) => (
      <div data-node-id={cleanNodeId} style={{ height: '100%', display: 'flex', flexDirection: 'column', contain: 'strict' }}>
        <ErrorBoundary componentName={panelName}>
          {children}
        </ErrorBoundary>
      </div>
    );

    // Helper: wrap lazy-loaded components with Suspense
    const withSuspense = (children: React.ReactNode) => (
      <Suspense fallback={<PanelLoader />}>{children}</Suspense>
    );

    // Panel access check (no-op when auth is disabled)
    if (component && !canAccessPanel(component)) {
      return wrapPanel('AccessDenied',
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--tn-text-muted)', fontSize: 12, textAlign: 'center', padding: 20 }}>
          <div>
            <div style={{ fontSize: 18, marginBottom: 8, opacity: 0.5 }}>Restricted</div>
            <div>You don't have access to this panel.</div>
          </div>
        </div>
      );
    }

    switch (component) {
      case 'cui':
      case 'cui-lite':
        return wrapPanel('Chat', <CuiLitePanel accountId={config.accountId} projectId={projectId} workDir={workDir} panelId={nodeId} isTabVisible={node.isVisible()}
          initialRoute={config._route}
          initialSessionId={config.initialSessionId}
          onRouteChange={(route) => { routeByNodeRef.current.set(nodeId, route); setAttentionVersion(v => v + 1); }}
          onStateChange={(state) => { attentionByNodeRef.current.set(nodeId, state); setAttentionVersion(v => v + 1); }}
          onFinish={(sid) => {
            const m = modelRef.current;
            if (m) {
              try { m.doAction(Actions.deleteTab(nodeId)); saveLayoutRef.current(m); } catch (e) { console.warn('[LM] Finish deleteTab:', e); }
            }
          }} />);
      case 'images':
        return wrapPanel('ImageDrop', <ImageDrop />);
      case 'browser': {
        // Auto-fill URL from workspace mapping when layout has no URL set.
        // Works for initial layout load (addTab() has same fallback for new tabs).
        const wsId = workDir.split('/').pop() || '';
        const browserUrl = config.url || WORKSPACE_BROWSER_URLS[wsId] || '';
        return wrapPanel('BrowserPanel', <BrowserPanel initialUrl={browserUrl} panelId={nodeId}
          onUrlChange={(url) => updateNodeConfig(nodeId, { url })} />);
      }
      case 'preview':
        return wrapPanel('FilePreview', <FilePreview watchPath={config.watchPath || activeDirRef.current || workDir} stageDir={activeDirRef.current} />);
      case 'notes':
        return wrapPanel('NotesPanel', <NotesPanel projectId={projectId} />);
      case 'mission':
        return wrapPanel('MissionControl', withSuspense(<MissionControl projectId={config.projectId || projectId} workDir={config.workDir || workDir} />));
      case 'mission-chat':
        return wrapPanel('MissionChat', <CuiLitePanel accountId={config.accountId || 'engelmann'} projectId="mission-chat" workDir="/root/orchestrator/workspaces/mission-chat" panelId={nodeId} isTabVisible={node.isVisible()}
          initialSessionId={config.initialSessionId}
          onRouteChange={(route) => { routeByNodeRef.current.set(nodeId, route); setAttentionVersion(v => v + 1); }}
          onStateChange={(state) => { attentionByNodeRef.current.set(nodeId, state); setAttentionVersion(v => v + 1); }}
          onFinish={(sid) => {
            const m = modelRef.current;
            if (m) {
              try { m.doAction(Actions.deleteTab(nodeId)); saveLayoutRef.current(m); } catch (e) { console.warn('[LM] Finish deleteTab:', e); }
            }
          }} />);
      case 'gmail':
      case 'virtual-office':
        return wrapPanel('OfficePanel', withSuspense(<OfficePanel projectId={projectId} workDir={workDir} />));
      case 'knowledge':
      case 'knowledge-fullscreen':
        return wrapPanel('KnowledgeFullscreen', withSuspense(<KnowledgeFullscreen projectId={projectId} workDir={workDir} />));
      case 'admin-wr':
        return wrapPanel('WerkingReportAdmin', withSuspense(<WerkingReportAdmin />));
      case 'platform-admin':
        return wrapPanel('PlatformAdmin', withSuspense(<PlatformAdmin />));
      case 'linkedin':
        return wrapPanel('LinkedInPanel',
          <PanelConnectivityGuard
            panelName="Platform"
            checkUrl="/api/panel-health"
            startCommand="# Platform managed by dev-servers CLI"
          >
            {withSuspense(<LinkedInPanel />)}
          </PanelConnectivityGuard>
        );
      case 'qa-dashboard':
        return wrapPanel('QADashboard', withSuspense(<QADashboard />));
      case 'bridge-monitor':
        // No connectivity guard needed — all calls go through CUI server proxy
        return wrapPanel('BridgeMonitor', withSuspense(<BridgeMonitor />));
      case 'infisical-monitor':
        // Using mock data in development - no connectivity check needed
        return wrapPanel('InfisicalMonitor', withSuspense(<InfisicalMonitor />));
      case 'repo-dashboard':
        return wrapPanel('RepoDashboard', withSuspense(<RepoDashboard />));
      case 'watchdog':
      case 'infrastructure': // Alias: both point to Watchdog (iframe on :9090)
      case 'system-health': // Legacy alias: System Health is now a tab inside Watchdog
        return wrapPanel('WatchdogPanel', withSuspense(<WatchdogPanel />));
      case 'background-ops':
        return wrapPanel('BackgroundOps', withSuspense(<BackgroundOpsPanel />));
      case 'conversation-queue':
        return wrapPanel('ConversationQueue', withSuspense(<ConversationQueuePanel projectId={projectId} />));
      case 'maintenance':
        return wrapPanel('MaintenancePanel', withSuspense(<MaintenancePanel />));
      case 'input-audit':
        return wrapPanel('UserInputAuditPanel', withSuspense(<UserInputAuditPanel />));
      case 'architecture':
        return wrapPanel('ArchitectureExplorer', withSuspense(<ArchitectureExplorer />));
      case 'report-builder':
        return wrapPanel('ReportBuilder', withSuspense(<ReportBuilder />));
      case 'business-angel':
        return wrapPanel('Business Angel', withSuspense(<BusinessAngelPanel />));
      case 'privat-angel':
        return wrapPanel('Privat Angel', withSuspense(<PrivatAngelPanel />));
      case 'prompt-explorer':
        return wrapPanel('PromptExplorer', withSuspense(<PromptExplorer />));
      case 'my-tasks':
        return wrapPanel('MyTasks', withSuspense(<MyTasksPanel />));
      case 'activity-feed':
        return wrapPanel('Activity Feed', withSuspense(<ActivityFeedPanel />));
      case 'partner-inbox':
        return wrapPanel('Partner Inbox', withSuspense(<PartnerInboxPanel projectId={projectId} />));
      case 'feedback':
        return wrapPanel('Feedback', withSuspense(<FeedbackPanel />));
      case 'team-status':
        return wrapPanel('Team Status', withSuspense(<TeamStatusPanel />));
      case 'business-docs':
        return wrapPanel('Business Docs', withSuspense(<BusinessDocsPanel />));
      case 'uploads':
        return wrapPanel('Uploads', withSuspense(<UploadPanel />));
      case 'calendar':
        return wrapPanel('Kalender', withSuspense(<CalendarPanel />));
      case 'mail':
        return wrapPanel('Mail', withSuspense(<MailPanel />));
      case 'tool-hub':
        return wrapPanel('ToolHub', withSuspense(<ToolHub projectId={projectId} workDir={workDir} />));
      case 'error-monitor':
        return wrapPanel('ErrorMonitor', withSuspense(<ErrorMonitor />));
      case 'partner-server':
        return wrapPanel('Partner Server Health', withSuspense(<PartnerServerPanel />));
      case 'sandbox-privat-angel':
        return wrapPanel('Privat-Assistent', withSuspense(<SandboxAngelPanel mode="private" />));
      case 'sandbox-business-angel':
        return wrapPanel('Business-Assistent', withSuspense(<SandboxAngelPanel mode="business" />));
      case 'sandbox-rafael-angel':
        return wrapPanel('Rafael-Assistent', withSuspense(<SandboxAngelPanel mode="rafael" />));
      default:
        return wrapPanel(`Unknown:${component}`,
          <div style={{ padding: 20, color: 'var(--tn-text-muted)' }}>
            Unknown panel: {component}
          </div>
        );
    }
  }, [projectId, workDir]);

  // ============================================================================
  // mergeServerLayout — apply server's layout WITHOUT setModel when possible.
  //
  // Why: setModel(Model.fromJson(...)) re-mounts every panel because React sees a
  // new Model instance + new tab nodeIds → every CuiLite panel's WebSocket drops
  // and reconnects → "reload storm" the user sees.
  //
  // Race-condition that triggers this: multiple browser tabs on the same workspace
  // run independent syncConversations() loops every 30s. Both autonomously call
  // Actions.addNode(...) for the same conversation, each generating a different
  // random nodeId. POST → one wins, the other gets 409 → 409-handler runs setModel
  // with the winner's layout (different nodeIds for semantically identical tabs).
  //
  // Strategy: match tabs by SEMANTIC IDENTITY (component + key config field) rather
  // than nodeId. If both layouts have the same tab-set, just patch configs/names
  // via updateNodeAttributes (no re-mount). If tab-sets differ, fall back to
  // setModel (rare — only when panes were truly added/removed/restructured).
  // ============================================================================
  const tabIdentity = useCallback((tab: { component?: string; name?: string; config?: Record<string, unknown> }): string => {
    const cfg = (tab.config || {}) as Record<string, string | undefined>;
    if (cfg.initialSessionId) return `s|${cfg.initialSessionId}`;
    if (cfg.url) return `u|${cfg.url}`;
    if (cfg.watchPath) return `p|${cfg.watchPath}`;
    return `c|${tab.component || ''}|${tab.name || ''}`;
  }, []);

  // Walk JSON layout (server format) → flat list of {identity, name, component, config}
  const collectJsonTabs = useCallback((node: unknown, out: Array<{ identity: string; name: string; component: string; config: Record<string, unknown> }>): void => {
    if (!node || typeof node !== 'object') return;
    const n = node as { type?: string; component?: string; name?: string; config?: Record<string, unknown>; children?: unknown[] };
    if (n.type === 'tab') {
      out.push({
        identity: tabIdentity(n),
        name: n.name || '',
        component: n.component || '',
        config: n.config || {},
      });
      return;
    }
    for (const child of n.children || []) collectJsonTabs(child, out);
  }, [tabIdentity]);

  // Walk current Model → flat list of live tabs (with their actual nodeId for in-place updates)
  const collectModelTabs = useCallback((m: Model): Array<{ identity: string; nodeId: string; name: string; component: string; config: Record<string, unknown> }> => {
    const out: Array<{ identity: string; nodeId: string; name: string; component: string; config: Record<string, unknown> }> = [];
    m.visitNodes((node) => {
      if (node.getType() !== 'tab') return;
      const tab = node as TabNode;
      const config = (tab.getConfig?.() || {}) as Record<string, unknown>;
      out.push({
        identity: tabIdentity({ component: tab.getComponent(), name: tab.getName(), config }),
        nodeId: tab.getId(),
        name: tab.getName(),
        component: tab.getComponent() || '',
        config,
      });
    });
    return out;
  }, [tabIdentity]);

  // Try to merge server's layout into the current Model in-place.
  // Returns true if successful (no setModel needed). False → caller falls back to setModel.
  const tryMergeServerLayout = useCallback((m: Model | null, serverLayoutJson: { layout?: unknown } | null): boolean => {
    if (!m || !serverLayoutJson?.layout) return false;
    const serverTabs: Array<{ identity: string; name: string; component: string; config: Record<string, unknown> }> = [];
    collectJsonTabs(serverLayoutJson.layout, serverTabs);
    const localTabs = collectModelTabs(m);

    // If tab-sets differ in identity, the diff is too complex (panes added/removed/restructured)
    // → bail out, caller will setModel.
    const serverIds = new Set(serverTabs.map(t => t.identity));
    const localIds = new Set(localTabs.map(t => t.identity));
    if (serverIds.size !== serverTabs.length || localIds.size !== localTabs.length) return false; // duplicate identities — can't safely match
    if (serverIds.size !== localIds.size) return false;
    for (const id of serverIds) if (!localIds.has(id)) return false;

    // Same tab-set — patch any per-tab attributes that drifted (config / name)
    const localByIdentity = new Map(localTabs.map(t => [t.identity, t]));
    for (const sTab of serverTabs) {
      const lTab = localByIdentity.get(sTab.identity);
      if (!lTab) continue;
      const configDiffers = JSON.stringify(lTab.config) !== JSON.stringify(sTab.config);
      const nameDiffers = lTab.name !== sTab.name;
      if (!configDiffers && !nameDiffers) continue;
      try {
        const attrs: Record<string, unknown> = {};
        if (configDiffers) attrs.config = sTab.config;
        if (nameDiffers) attrs.name = sTab.name;
        m.doAction(Actions.updateNodeAttributes(lTab.nodeId, attrs));
      } catch (e) { console.warn('[LM merge] updateNodeAttributes failed for', lTab.nodeId, ':', e); }
    }
    return true;
  }, [collectJsonTabs, collectModelTabs]);

  const saveLayout = useCallback((m: Model) => {
    const json = m.toJson();
    const payload = { ...json, _v: currentLayoutVersionRef.current };
    // Remember what we just sent — apply-layout handler uses this to detect self-echo
    // (server broadcasts our own POST back to us, which would otherwise trigger setModel
    // and re-mount every CUI panel = the "chats reload every few seconds" problem)
    try { lastSavedJsonRef.current = JSON.stringify({ ...json }); } catch { lastSavedJsonRef.current = ''; }
    // Cache locally for instant load on next visit
    try { localStorage.setItem(`cui-layout-${projectId}`, JSON.stringify(payload)); } catch (e) { console.warn('[LayoutManager] Failed to cache layout locally:', e); }
    if (window.__cuiServerAlive === false) return;
    try {
      fetch(`${API}/layouts/${projectId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      }).then(async (res) => {
        if (res.ok) {
          const data = await res.json().catch(() => ({})); // silent-ok: malformed layout save response; layout already persisted
          if (typeof data._v === 'number') currentLayoutVersionRef.current = data._v;
        } else if (res.status === 409) {
          // Server has newer version — apply it, suppress echo
          const data = await res.json().catch(() => ({})); // silent-ok: malformed 409 response; server-side layout version ignored
          if (data.layout) {
            currentLayoutVersionRef.current = typeof data._v === 'number' ? data._v : currentLayoutVersionRef.current;
            // Self-echo: if server's layout equals what we just sent, only bump version — don't setModel.
            // setModel would re-mount every child panel (WS disconnect storm), so skip when content is identical.
            let isSelfEcho = false;
            try {
              const { _v: _vIn, ...incomingNoV } = data.layout;
              if (lastSavedJsonRef.current && JSON.stringify(incomingNoV) === lastSavedJsonRef.current) {
                isSelfEcho = true;
              }
            } catch { /* compare failed; fall through to setModel */ }
            if (!isSelfEcho) {
              // Suppression must outlast handleModelChange's 1500ms debounce, otherwise the post-setModel
              // onChange wave fires another saveLayout → 409 → loop.
              suppressUntilRef.current = Date.now() + 2500;
              if (saveTimer.current) clearTimeout(saveTimer.current);
              // Try to merge in-place first (no re-mount). Only fall back to setModel if tab-sets differ.
              const merged = tryMergeServerLayout(modelRef.current, data.layout as { layout?: unknown });
              logCuiTelemetry({ ts: Date.now(), kind: '409-conflict-applied', projectId, merged });
              if (merged) {
                try { localStorage.setItem(`cui-layout-${projectId}`, JSON.stringify(data.layout)); } catch { /* ignore */ }
              } else {
                try {
                  setModel(Model.fromJson(data.layout));
                  localStorage.setItem(`cui-layout-${projectId}`, JSON.stringify(data.layout));
                } catch (e) { console.warn('[LayoutManager] Failed to apply conflict layout:', e); }
              }
            }
          }
        }
      }).catch((err) => { console.warn('[LayoutManager] saveLayout fetch failed:', err); });
    } catch (err) { console.warn('[LayoutManager] saveLayout error:', err); }
  }, [projectId]);

  const handleModelChange = useCallback(
    (m: Model) => {
      // Time-based suppression covers the React Re-Render wave after setModel().
      // Self-echo of our own POSTs is handled separately in the apply-layout handler
      // (lastSavedJsonRef compare). Together: no save loops, no Chat re-mount cascades.
      if (Date.now() < suppressUntilRef.current) return;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => saveLayout(m), 1500);
    },
    [saveLayout]
  );

  const saveTemplate = useCallback((tpl: IJsonModel) => {
    templateRef.current = tpl;
    if (window.__cuiServerAlive === false) return;
    try {
      fetch(`${API}/layouts/${projectId}/template`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(tpl),
        signal: AbortSignal.timeout(15000),
      }).catch((err) => { console.warn('[LayoutManager] saveTemplate fetch failed:', err); });
    } catch (err) { console.warn('[LayoutManager] saveTemplate error:', err); }
  }, [projectId]);

  const handleApplyLayout = useCallback((layoutJson: IJsonModel) => {
    try {
      const newModel = Model.fromJson(layoutJson);
      setModel(newModel);
      setShowBuilder(false);
      saveLayout(newModel);
      saveTemplate(layoutJson);
    } catch (err) { console.warn('[LayoutManager] handleApplyLayout Model.fromJson failed:', err); }
  }, [saveLayout, saveTemplate]);

  const handleResetLayout = useCallback(() => {
    try {
      // Reset means "back to the baked-in default", not "back to a user-saved template".
      // Drop the template cache so a stale per-workspace template can't hijack the default
      // (this happened when older layouts were saved without the /app-proxy browser URL).
      templateRef.current = null;
      try { localStorage.removeItem(`cui-template-${projectId}`); } catch (e) { console.warn('[LayoutManager] Failed to clear template cache on reset:', e); }
      const newModel = Model.fromJson(defaultLayout(workDir));
      setModel(newModel);
      saveLayout(newModel);
    } catch (err) { console.warn('[LayoutManager] handleResetLayout Model.fromJson failed:', err); }
  }, [workDir, projectId, saveLayout]);

  // Stable refs for WS effect (prevent reconnect on model/callback changes)
  const handleResetLayoutRef = useRef(handleResetLayout);
  handleResetLayoutRef.current = handleResetLayout;
  const saveLayoutRef = useRef(saveLayout);
  saveLayoutRef.current = saveLayout;

  const addTab = useCallback((type: 'cui' | 'cui-lite' | 'browser' | 'preview' | 'notes' | 'images' | 'mission' | 'gmail' | 'admin-wr' | 'platform-admin' | 'linkedin' | 'system-health' | 'bridge-monitor' | 'repo-dashboard' | 'watchdog' | 'background-ops' | 'conversation-queue' | 'maintenance' | 'input-audit' | 'qa-dashboard' | 'peer-awareness' | 'infisical-monitor' | 'mission-chat' | 'architecture' | 'report-builder' | 'prompt-explorer' | 'sub-sessions' | 'business-docs' | 'my-tasks' | 'activity-feed' | 'partner-inbox' | 'feedback' | 'team-status' | 'uploads', config: Record<string, string>, targetId: string) => {
    const m = modelRef.current;
    if (!m) return;
    // Panel-Namen kommen aus der Registry (SSoT)
    if (type === 'preview' && !config.watchPath) {
      config.watchPath = activeDirRef.current || workDir;
    }
    if (type === "browser" && !config.url) {
      const wsId = workDir.split("/").pop() || "";
      if (WORKSPACE_BROWSER_URLS[wsId]) config.url = WORKSPACE_BROWSER_URLS[wsId];
    }
    try {
      m.doAction(
        Actions.addNode(
          { type: 'tab', name: PANEL_NAMES[type] ?? type, component: type, config },
          targetId,
          DockLocation.CENTER,
          -1
        )
      );
    } catch (err) { console.warn('[LayoutManager] addTab doAction failed for', type, ':', err); }
  }, [workDir]);

  const onRenderTabSet = useCallback((node: TabSetNode | BorderNode, renderValues: ITabSetRenderValues) => {
    if (node instanceof BorderNode) return;
    const nodeId = node.getId().replace(/^#/, '');

    // Add-tab dropdown
    renderValues.stickyButtons.push(
      <select
        key="add-tab"
        data-ai-id={`add-tab-dropdown-${nodeId}`}
        value=""
        onChange={(e) => {
          const val = e.target.value;
          if (!val) return;
          if (val === 'cui') {
            addTab('cui', { _userReserved: String(Date.now()) }, node.getId());
          } else {
            addTab(val as 'browser' | 'preview' | 'notes' | 'images' | 'mission' | 'gmail' | 'admin-wr' | 'platform-admin' | 'linkedin' | 'system-health' | 'bridge-monitor' | 'repo-dashboard' | 'watchdog' | 'background-ops' | 'conversation-queue' | 'maintenance' | 'input-audit' | 'qa-dashboard' | 'peer-awareness' | 'infisical-monitor' | 'mission-chat' | 'architecture' | 'report-builder' | 'prompt-explorer' | 'sub-sessions' | 'business-docs' | 'my-tasks' | 'activity-feed' | 'partner-inbox' | 'feedback' | 'team-status' | 'uploads', {}, node.getId());
          }
          e.target.value = '';
        }}
        title="Tab hinzufuegen"
        style={{
          background: 'none',
          border: 'none',
          color: 'var(--tn-text-muted)',
          fontSize: 14,
          cursor: 'pointer',
          padding: '0 2px',
          width: 20,
          appearance: 'none',
          WebkitAppearance: 'none',
        }}
      >
        <option value="">+</option>
        {PANEL_MENU_OPTIONS.map(({ category, items }) =>
          items.length === 0 ? null : (
            <optgroup key={category} label={category}>
              {items.map(({ value, label }) => {
                const allowed = canAccessPanel(value);
                return (
                  <option key={value} value={value} disabled={!allowed}
                    style={!allowed ? { color: 'var(--tn-text-muted)', opacity: 0.5 } : undefined}>
                    {allowed ? label : `${label} (nicht verfügbar)`}
                  </option>
                );
              })}
            </optgroup>
          )
        )}
      </select>
    );
  }, [addTab, canAccessPanel]);

  // When cuiStates changes, update tab header dots via DOM (no React re-render needed).
  // Direct DOM manipulation avoids triggering flexlayout's expensive render/layout cycle.
  useEffect(() => {
    if (!model) return;
    model.visitNodes((node) => {
      if (node.getType() !== 'tab') return;
      const tab = node as TabNode;
      if (tab.getComponent() !== 'cui') return;
      const cuiId = tab.getConfig()?.accountId;
      if (!cuiId) return;
      const state = cuiStates[cuiId];
      // Find the tab button element by flexlayout's data attribute
      const tabEl = document.querySelector(`[data-layout-path="${tab.getId()}"]`)
        ?? document.querySelector(`.flexlayout__tab_button[data-node="${tab.getId()}"]`);
      if (!tabEl) return;
      let dot = tabEl.querySelector('.cui-state-dot') as HTMLElement;
      if (state === 'processing' || state === 'done') {
        if (!dot) {
          dot = document.createElement('span');
          dot.className = 'cui-state-dot';
          Object.assign(dot.style, { width: '7px', height: '7px', borderRadius: '50%', display: 'inline-block', marginRight: '4px', flexShrink: '0' });
          tabEl.insertBefore(dot, tabEl.firstChild);
        }
        dot.style.background = state === 'processing' ? '#9ece6a' : '#e0af68';
      } else if (dot) {
        dot.remove();
      }
    });
  }, [model, cuiStates]);

  // Reset CUI state to idle when user selects a CUI tab
  const handleAction = useCallback((action: Action) => {
    const m = modelRef.current;
    if (action.type === 'FlexLayout_SelectTab' && m) {
      const nodeId = action.data?.tabNode;
      if (nodeId) {
        try {
          const node = m.getNodeById(nodeId);
          if (node && (node as TabNode).getComponent?.() === 'cui') {
            const cuiId = (node as TabNode).getConfig?.()?.accountId;
            if (cuiId && cuiStatesRef.current[cuiId] === 'done') {
              onCuiStateResetRef.current?.(cuiId);
            }
          }
        } catch (err) { console.warn('[LayoutManager] handleAction tab lookup failed:', err); }
      }
    }
    // Intercept tab close: if synced, remove from all other layouts too
    if (action.type === 'FlexLayout_DeleteTab' && m) {
      const nodeId = action.data?.tabNode;
      if (nodeId) {
        try {
          const node = m.getNodeById(nodeId);
          if (node && (node as TabNode).getConfig?.()._synced) {
            fetch(`${API}/layouts/delete-synced-tab`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ tabId: nodeId }),
              signal: AbortSignal.timeout(5000),
            }).catch(err => console.warn('[LayoutManager] delete-synced-tab failed:', err));
          }
        } catch (err) { console.warn('[LayoutManager] delete-synced-tab check failed:', err); }
      }
    }
    return action;
  }, []);

  const onRenderTab = useCallback((node: TabNode, renderValues: ITabRenderValues) => {
    // Show node ID badge on every tab — clickable to copy full ID
    const fullId = node.getId().replace(/^#/, '');
    const shortId = fullId.slice(0, 6);
    renderValues.buttons.push(
      <span
        key="node-id"
        title={`Click to copy: ${fullId}`}
        onClick={(e) => {
          e.stopPropagation();
          copyToClipboard(fullId);
          const el = e.currentTarget;
          el.textContent = 'copied!';
          el.style.color = 'var(--tn-green)';
          setTimeout(() => { el.textContent = shortId; el.style.color = 'var(--tn-text-muted)'; }, 1200);
        }}
        style={{
          fontSize: 9, color: 'var(--tn-text-muted)', opacity: 0.7,
          fontFamily: 'monospace', marginLeft: 6, cursor: 'pointer',
          padding: '1px 4px', borderRadius: 3,
          background: 'var(--tn-surface-alt)',
        }}
      >{shortId}</span>
    );

    // Screenshot button — captures panel content, returns server path
    renderValues.buttons.push(
      <span
        key="screenshot"
        title="Screenshot vom Panel"
        onClick={async (e) => {
          e.stopPropagation();
          const btn = e.currentTarget;
          const original = btn.textContent;
          const setLabel = (text: string, color: string) => {
            btn.textContent = text;
            btn.style.color = color;
          };
          setLabel('⏳', 'var(--tn-yellow)');
          try {
            const target = document.querySelector<HTMLElement>(`[data-node-id="${fullId}"]`);
            if (!target) throw new Error(`Panel ${shortId} nicht im DOM`);
            const rect = target.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) throw new Error('Panel ist nicht sichtbar');

            // Temporarily expand the panel + all scrollable descendants so
            // html2canvas captures the full content, not just the viewport.
            // Panel briefly grows + restores — acceptable for manual action.
            type Saved = { el: HTMLElement; scrollTop: number; scrollLeft: number; cssText: string };
            const saved: Saved[] = [];
            const expand = (el: HTMLElement, isTarget: boolean) => {
              saved.push({ el, scrollTop: el.scrollTop, scrollLeft: el.scrollLeft, cssText: el.style.cssText });
              el.style.overflow = 'visible';
              el.style.overflowX = 'visible';
              el.style.overflowY = 'visible';
              el.style.maxHeight = 'none';
              if (isTarget) {
                el.style.contain = 'none';
                el.style.height = 'auto';
              } else {
                el.style.height = 'auto';
                el.style.maxWidth = 'none';
              }
              el.scrollTop = 0;
              el.scrollLeft = 0;
            };
            expand(target, true);
            for (const child of Array.from(target.querySelectorAll<HTMLElement>('*'))) {
              const cs = getComputedStyle(child);
              const ov = `${cs.overflow}${cs.overflowX}${cs.overflowY}`;
              if (ov.includes('auto') || ov.includes('scroll')) expand(child, false);
            }
            await new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));

            const fullW = target.scrollWidth;
            const fullH = target.scrollHeight;
            const html2canvas = (await import('html2canvas')).default;
            let canvas: HTMLCanvasElement;
            try {
              canvas = await html2canvas(target, {
                backgroundColor: '#1a1b26', scale: 1, useCORS: true, logging: false, allowTaint: true,
                width: fullW, height: fullH, windowWidth: fullW, windowHeight: fullH,
              });
            } finally {
              for (const s of saved) {
                s.el.style.cssText = s.cssText;
                s.el.scrollTop = s.scrollTop;
                s.el.scrollLeft = s.scrollLeft;
              }
            }
            const dataUrl = canvas.toDataURL('image/png');
            const resp = await fetch(`/api/screenshot/${encodeURIComponent(fullId)}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ dataUrl, width: canvas.width, height: canvas.height }),
              signal: AbortSignal.timeout(20000),
            });
            if (!resp.ok) throw new Error(`Server: ${resp.status}`);
            const data = await resp.json() as { filePath?: string; url?: string };
            const pathToCopy = data.filePath || data.url || '';
            await copyToClipboard(pathToCopy);
            setLabel('✓ kopiert', 'var(--tn-green)');
            console.log(`[Screenshot] ${shortId}: ${pathToCopy}`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            setLabel('✗', 'var(--tn-red)');
            console.error(`[Screenshot] ${shortId}:`, msg);
          }
          setTimeout(() => setLabel(original || '📷', 'var(--tn-text-muted)'), 1800);
        }}
        style={{
          fontSize: 11, color: 'var(--tn-text-muted)', opacity: 0.7,
          marginLeft: 4, cursor: 'pointer',
          padding: '1px 4px', borderRadius: 3,
          background: 'var(--tn-surface-alt)',
        }}
      >📷</span>
    );

    // Sync state is controlled from Tool Hub (not tab header)
    const tabComp = node.getComponent();
    if (tabComp !== 'cui' && tabComp !== 'cui-lite' && tabComp !== 'mission-chat') {
      return;
    }

    // Primary: panel-reported attention state (from CuiLitePanel onStateChange callback)
    const panelState = getNodeAttention(node);

    // Fallback: per-session WS state or per-account legacy state
    let sessionState = panelState || 'idle';
    if (sessionState === 'idle') {
      const route = getNodeRoute(node);
      const sessionId = route?.startsWith('/c/') ? route.slice(3) : null;
      if (sessionId) {
        const ss = sessionStatesRef.current.get(sessionId);
        if (ss && ss.state !== 'idle') sessionState = ss.state;
      }
    }

    // State indicators: working (green pulse), needs_attention (red pulse), paused (grey), idle (dim)
    const sessionId = node.getConfig()?.initialSessionId || node.getConfig()?.sessionId;
    const isPaused = sessionId ? pausedSessionsRef.current.has(sessionId) : false;
    if (isPaused) {
      renderValues.leading = <span key="dot" className="cui-tab-dot cui-tab-dot--paused" title="Paused">⏸</span>;
    } else if (sessionState === 'working') {
      renderValues.leading = <span key="dot" className="cui-tab-dot cui-tab-dot--working" />;
    } else if (sessionState === 'needs_attention') {
      const attentionReason = node.getConfig()?._attentionReason;
      const label = attentionReason === 'permission' ? '⚡' : attentionReason === 'error' ? '⚠' : '●';
      renderValues.leading = <span key="dot" className="cui-tab-dot cui-tab-dot--attention" title={attentionReason || 'Needs input'}>{label}</span>;
    } else if (getNodeRoute(node)) {
      // Has a conversation open but idle
      renderValues.leading = <span key="dot" className="cui-tab-dot cui-tab-dot--idle" />;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabRenderTick, getNodeAttention, getNodeRoute]);

  // Stable refs for Layout callbacks — prevent Layout element recreation on state changes.
  // Without these, every tabRenderTick bump recreates the <Layout> element via useMemo,
  // which causes flexlayout to re-render ALL visible tabs (expensive!).
  const onRenderTabStableRef = useRef(onRenderTab);
  onRenderTabStableRef.current = onRenderTab;
  const stableOnRenderTab = useCallback((node: TabNode, rv: ITabRenderValues) => {
    onRenderTabStableRef.current(node, rv);
  }, []);

  const onRenderTabSetStableRef = useRef(onRenderTabSet);
  onRenderTabSetStableRef.current = onRenderTabSet;
  const stableOnRenderTabSet = useCallback((node: TabSetNode | BorderNode, rv: ITabSetRenderValues) => {
    onRenderTabSetStableRef.current(node, rv);
  }, []);

  // Control API: listen for panel/layout commands + report panel state (auto-reconnect)
  // IMPORTANT: No model/callback dependencies — uses refs to prevent WS reconnect on every model change
  useEffect(() => {
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let backoff = 1000; // start at 1s, doubles up to 30s max

    const connect = () => {
      if (disposed) return;
      if (window.__cuiServerAlive === false) {
        reconnectTimer = setTimeout(connect, Math.min(backoff, 10000));
        return;
      }
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${protocol}://${window.location.host}/ws`);
      ws.onerror = () => {};
      controlWsRef.current = ws;

      function reportPanels() {
        const m = modelRef.current;
        if (!m || ws.readyState !== WebSocket.OPEN) return;
        try {
          const panels: Array<{ id: string; component: string; config: Record<string, unknown>; name: string }> = [];
          m.visitNodes((node) => {
            if (node.getType() === 'tab') {
              const tab = node as TabNode;
              panels.push({ id: tab.getId(), component: tab.getComponent() ?? 'unknown', config: tab.getConfig() ?? {}, name: tab.getName() });
            }
          });
          const msg: Record<string, unknown> = { type: 'state-report', panels, projectId };
          if (isActiveRef.current) msg.activeProjectId = projectId;
          ws.send(JSON.stringify(msg));
        } catch (err) { console.warn('[LayoutManager] reportPanels failed:', err); }
      }

      ws.onopen = () => {
        backoff = 1000;
        reportPanels();
        // Re-sync conversations on reconnect
        setTimeout(() => syncNowRef.current?.(), 1500);
        // Auto-layout disabled on reconnect — only triggered manually via Layout button
      };
      ws.onclose = () => {
        if (controlWsRef.current === ws) controlWsRef.current = null;
        if (!disposed) {
          reconnectTimer = setTimeout(() => {
            backoff = Math.min(backoff * 2, 30000);
            connect();
          }, backoff);
        }
      };
      ws.onmessage = (e) => {
      const m = modelRef.current;
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'control:panel-add' && m) {
          let targetId = '';
          m.visitNodes((node) => { if (!targetId && node.getType() === 'tabset') targetId = node.getId(); });
          if (targetId) {
            try {
              m.doAction(Actions.addNode(
                { type: 'tab', name: msg.name || msg.component, component: msg.component, config: msg.config || {} },
                targetId, DockLocation.CENTER, -1
              ));
              reportPanels();
            } catch (err) { console.warn('[LayoutManager] panel-add doAction failed:', err); }
          }
        }
        if (msg.type === 'control:panel-remove' && msg.nodeId && m) {
          try {
            m.doAction(Actions.deleteTab(msg.nodeId));
            reportPanels();
          } catch (err) { console.warn('[LayoutManager] panel-remove doAction failed:', err); }
        }
        if ((msg.type === 'control:conversation-finished' || msg.type === 'control:conversation-deleted') && m) {
          // Only close panels the server explicitly lists — no aggressive search by sessionId
          // (aggressive deletion caused panels to disappear on any auto-finish event)
          const myPanels = ((msg.panelsToClose || []) as Array<{ panelId: string; projectId: string }>)
            .filter(p => p.projectId === projectId);
          let closed = 0;
          for (const p of myPanels) {
            try { m.doAction(Actions.deleteTab(p.panelId)); closed++; } catch (err) { console.warn('[LayoutManager] deleteTab failed for panel', p.panelId, ':', err); }
          }
          if (closed > 0) {
            reportPanels();
            saveLayoutRef.current(m);
          }
        }
        if (msg.type === 'control:conversation-started' && msg.workDir === workDir) {
          // New conversation for our project — short delay to let session initialize
          setTimeout(() => syncNowRef.current?.(), 1000);
        }
        if (msg.type === 'control:layout-reset') {
          handleResetLayoutRef.current();
          setTimeout(reportPanels, 200);
        }
        // Nuclear option: clear all layout caches and force full reload from server
        if (msg.type === 'control:nuke-layout-cache') {
          try {
            const keys = Object.keys(localStorage).filter(k => k.startsWith('cui-layout-') || k.startsWith('cui-template-') || k.startsWith('cui-msgs-'));
            keys.forEach(k => localStorage.removeItem(k));
            console.log(`[LayoutManager] Nuked ${keys.length} layout cache entries, reloading...`);
          } catch (e) { console.warn('[LayoutManager] nuke-layout-cache error:', e); }
          setTimeout(() => window.location.reload(), 500);
        }
        // Notify in-process listeners (Tool Hub, etc.) that layout/sync state changed
        if (msg.type === 'synced-tab-added' || msg.type === 'synced-tab-removed' || msg.type === 'control:apply-layout') {
          try { window.dispatchEvent(new CustomEvent('cui-layout-changed', { detail: { projectId: msg.projectId || projectId } })); } catch { /* ignore */ }
        }
        // Synced tab added in another workspace → add to our layout if we're affected
        if (msg.type === 'synced-tab-added' && msg.tabConfig && Array.isArray(msg.affectedProjectIds) && msg.affectedProjectIds.includes(projectId)) {
          const tc = msg.tabConfig;
          if (m) {
            let alreadyPresent = false;
            m.visitNodes((n) => { if (n.getId() === tc.id) alreadyPresent = true; });
            if (!alreadyPresent) {
              let rightmostTabsetId = '';
              m.visitNodes((n) => { if (n.getType() === 'tabset') rightmostTabsetId = n.getId(); });
              if (rightmostTabsetId) {
                try {
                  m.doAction(Actions.addNode(
                    { type: 'tab', id: tc.id, name: tc.name, component: tc.component, config: tc.config },
                    rightmostTabsetId, DockLocation.CENTER, -1
                  ));
                  saveLayoutRef.current(m);
                } catch (err) { console.warn('[LayoutManager] synced-tab-added addNode failed:', err); }
              }
            }
          }
        }
        // Synced tab removed in another workspace → remove from our layout
        if (msg.type === 'synced-tab-removed' && msg.tabId && m) {
          let found = false;
          m.visitNodes((n) => { if (n.getId() === msg.tabId) found = true; });
          if (found) {
            try {
              m.doAction(Actions.deleteTab(msg.tabId));
              saveLayoutRef.current(m);
            } catch (err) { console.warn('[LayoutManager] synced-tab-removed deleteTab failed:', err); }
          }
        }
        // Server-pushed layout update: apply without reload (triggered by POST /api/layouts/:projectId)
        if (msg.type === 'control:apply-layout' && msg.projectId === projectId && msg.layout) {
          try {
            const serverV = typeof msg.layout._v === 'number' ? msg.layout._v : -1;
            // Only apply if server version is newer (or unversioned) — prevents processing our own echo
            if (serverV > currentLayoutVersionRef.current || serverV === -1) {
              // Self-echo detection: server broadcasts our own POST back to us. The race
              // condition where serverV arrives before the POST response means the version
              // check alone fails. Instead, compare layout content (sans _v) against what we
              // just sent. If identical, just bump version + skip setModel — no re-mount.
              let isSelfEcho = false;
              try {
                const { _v, ...incomingNoV } = msg.layout;
                if (lastSavedJsonRef.current && JSON.stringify(incomingNoV) === lastSavedJsonRef.current) {
                  isSelfEcho = true;
                }
              } catch { /* compare failed; proceed normally */ }
              if (isSelfEcho) {
                // Server is broadcasting our own POST back; bump version, don't re-apply
                if (serverV >= 0) currentLayoutVersionRef.current = serverV;
                return;
              }
              if (serverV >= 0) currentLayoutVersionRef.current = serverV;
              // Suppression must outlast handleModelChange's 1500ms debounce (otherwise post-setModel
              // onChange wave fires saveLayout → 409 → re-mount loop, with WS disconnect storm).
              suppressUntilRef.current = Date.now() + 2500;
              if (saveTimer.current) clearTimeout(saveTimer.current);
              // Try in-place merge first — preserves child panels' WS connections (no re-mount).
              // Falls back to setModel only when tab-sets truly differ (panes added/removed/restructured).
              const merged = tryMergeServerLayout(modelRef.current, msg.layout as { layout?: unknown });
              logCuiTelemetry({ ts: Date.now(), kind: 'ws-apply-layout', projectId, merged, serverV });
              if (!merged) {
                const newModel = Model.fromJson(msg.layout);
                setModel(newModel);
              }
              try { localStorage.setItem(`cui-layout-${projectId}`, JSON.stringify(msg.layout)); } catch (e) { /* ignore */ }
              setTimeout(reportPanels, 200);
            }
          } catch (err) { console.warn('[LayoutManager] apply-layout failed:', err); }
        }
        if (msg.type === 'control:select-tab' && m && msg.target) {
          let foundId = '';
          m.visitNodes((node) => {
            if (foundId) return;
            if (node.getType() === 'tab') {
              const tab = node as TabNode;
              if (tab.getId() === msg.target || tab.getComponent() === msg.target) {
                foundId = tab.getId();
              }
            }
          });
          if (foundId) {
            try {
              m.doAction(Actions.selectTab(foundId));
              ws.send(JSON.stringify({ type: 'tab-selected', nodeId: foundId, target: msg.target }));
            } catch (err) { console.warn('[LayoutManager] select-tab doAction failed:', err); }
          } else {
            ws.send(JSON.stringify({ type: 'tab-select-failed', target: msg.target, error: 'not found' }));
          }
        }
        if (msg.type === 'control:ensure-panel' && m && msg.component) {
          let foundId = '';
          m.visitNodes((node) => {
            if (foundId) return;
            if (node.getType() === 'tab') {
              const tab = node as TabNode;
              if (tab.getComponent() === msg.component) foundId = tab.getId();
            }
          });
          if (!foundId) {
            let targetId = '';
            m.visitNodes((node) => { if (!targetId && node.getType() === 'tabset') targetId = node.getId(); });
            if (targetId) {
              const nameMap: Record<string, string> = { 'admin-wr': 'Werking Report Admin', 'browser': 'Browser', 'images': 'Images', 'notes': 'Notes' };
              try {
                m.doAction(Actions.addNode(
                  { type: 'tab', name: nameMap[msg.component] || msg.component, component: msg.component, config: msg.config || {} },
                  targetId, DockLocation.CENTER, -1
                ));
              } catch (err) { console.warn('[LayoutManager] ensure-panel addNode failed:', err); }
              m.visitNodes((node) => {
                if (node.getType() === 'tab') {
                  const tab = node as TabNode;
                  if (tab.getComponent() === msg.component) foundId = tab.getId();
                }
              });
            }
          }
          if (foundId) {
            try {
              m.doAction(Actions.selectTab(foundId));
            } catch (err) { console.warn('[LayoutManager] ensure-panel selectTab failed:', err); }
            reportPanels();
            ws.send(JSON.stringify({ type: 'panel-ensured', nodeId: foundId, component: msg.component }));
          } else {
            ws.send(JSON.stringify({ type: 'panel-ensure-failed', component: msg.component, error: 'could not add' }));
          }
        }
        // Split tabsets that contain multiple CUI panels into separate panels
        if (msg.type === 'control:split-cui-panels' && m) {
          let tabsetCount = 0;
          m.visitNodes((node) => { if (node.getType() === 'tabset') tabsetCount++; });

          let changed = false;
          // Collect tabsets that have >1 CUI tab
          const tabsetsToSplit: Array<{ tabsetId: string; extraTabIds: string[] }> = [];
          m.visitNodes((node) => {
            if (node.getType() !== 'tabset') return;
            const ts = node as TabSetNode;
            const cuiTabs = (ts.getChildren() as TabNode[]).filter(
              t => t.getType() === 'tab' && (t.getComponent() === 'cui' || t.getComponent() === 'cui-lite')
            );
            if (cuiTabs.length > 1) {
              // Keep the first, split out the rest
              tabsetsToSplit.push({ tabsetId: ts.getId(), extraTabIds: cuiTabs.slice(1).map(t => t.getId()) });
            }
          });

          for (const { tabsetId, extraTabIds } of tabsetsToSplit) {
            for (const tabId of extraTabIds) {
              // Dock relative to the CUI tabset itself — flexlayout splits it into a sibling tabset
              const targetId = tabsetId;

              const dockLocation = DockLocation.RIGHT;
              const tab = m.getNodeById(tabId) as TabNode | undefined;
              if (!tab) continue;
              const tabJson = { type: 'tab' as const, name: tab.getName(), component: tab.getComponent() || 'cui', config: { ...tab.getConfig() } };
              try {
                m.doAction(Actions.moveNode(tabId, targetId, dockLocation, -1));
                tabsetCount++;
                changed = true;
              } catch {
                // moveNode not available — add new + delete old
                try {
                  m.doAction(Actions.addNode(tabJson, targetId, dockLocation, -1));
                  m.doAction(Actions.deleteTab(tabId));
                  tabsetCount++;
                  changed = true;
                } catch (err) { console.warn('[LayoutManager] split-cui-panels failed:', err); }
              }
            }
          }
          if (changed) { saveLayoutRef.current(m); reportPanels(); }
        }
        if (msg.type === 'control:activate-conversations' && m && msg.plan) {
          const myPlan = (msg.plan as Array<{ projectId: string; conversations: Array<{ sessionId: string; accountId: string }> }>)
            .find(p => p.projectId === projectId);
          if (!myPlan) return;

          const existingPanels: string[] = [];
          m.visitNodes((node) => {
            if (node.getType() === 'tab') {
              const tab = node as TabNode;
              // Only use cui/cui-lite panels for activation — never mission-chat (reserved panel)
              if (tab.getComponent() === 'cui' || tab.getComponent() === 'cui-lite') {
                existingPanels.push(tab.getId());
              }
            }
          });

          const assignments: Array<{ panelId: string; sessionId: string }> = [];
          const usedPanels = new Set<string>();
          const unmatched: Array<{ sessionId: string; accountId: string }> = [];

          for (const conv of myPlan.conversations) {
            const panel = existingPanels.find(id => !usedPanels.has(id));
            if (panel) {
              assignments.push({ panelId: panel, sessionId: conv.sessionId });
              usedPanels.add(panel);
            } else {
              unmatched.push(conv);
            }
          }

          let tabsetCount = 0;
          m.visitNodes((node) => { if (node.getType() === 'tabset') tabsetCount++; });

          // Only create new panels if auto-layout is explicitly triggered (not automatic)
          if (!window.__cuiAutoLayoutActive && unmatched.length > 0) {
            console.log(`[LM] activate-conversations: ${unmatched.length} unmatched convs skipped (auto-layout disabled)`);
          }

          for (const conv of window.__cuiAutoLayoutActive ? unmatched : []) {
            // Target an existing CUI tabset directly — flexlayout splits it into a sibling tabset
            let targetId = '';
            m.visitNodes((node) => {
              if (node.getType() === 'tab' && !targetId) {
                const tab = node as TabNode;
                if (tab.getComponent() === 'cui' || tab.getComponent() === 'cui-lite') {
                  const parent = tab.getParent();
                  if (parent && parent.getType() === 'tabset') targetId = parent.getId();
                }
              }
            });
            // Fallback: any tabset
            if (!targetId) {
              m.visitNodes((node) => { if (node.getType() === 'tabset' && !targetId) targetId = node.getId(); });
            }
            if (!targetId) continue;

            const dockLocation = tabsetCount < 6
              ? DockLocation.RIGHT
              : DockLocation.CENTER;

            try {
              m.doAction(Actions.addNode(
                { type: 'tab', name: 'Chat', component: 'cui', config: {} },
                targetId, dockLocation, -1
              ));
            } catch (err) { console.warn('[LayoutManager] activate-conversations addNode failed:', err); continue; }
            tabsetCount++;

            let newPanelId = '';
            m.visitNodes((node) => {
              if (node.getType() === 'tab') {
                const tab = node as TabNode;
                if ((tab.getComponent() === 'cui' || tab.getComponent() === 'cui-lite')
                    && !usedPanels.has(tab.getId()) && !assignments.some(a => a.panelId === tab.getId())) {
                  newPanelId = tab.getId();
                }
              }
            });
            if (newPanelId) {
              assignments.push({ panelId: newPanelId, sessionId: conv.sessionId });
              usedPanels.add(newPanelId);
            }
          }

          assignments.forEach((a, i) => {
            setTimeout(() => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'navigate-request', panelId: a.panelId, sessionId: a.sessionId, projectId }));
              }
            }, i * 300);
          });

          saveLayoutRef.current(m);
          reportPanels();
        }
        // Track per-session states for tab indicators
        if (msg.type === 'conv-attention' && msg.sessionId) {
          const prev = sessionStatesRef.current.get(msg.sessionId);
          const newState = msg.state || 'idle';
          const newReason = msg.reason;
          if (!prev || prev.state !== newState || prev.reason !== newReason) {
            sessionStatesRef.current.set(msg.sessionId, { state: newState, reason: newReason });
            setTabRenderTick(t => t + 1);
          }
        }
        if (msg.type === 'cui-state' && msg.sessionId) {
          const mapped = msg.state === 'processing' ? 'working' : msg.state === 'done' ? 'idle' : msg.state;
          const prev = sessionStatesRef.current.get(msg.sessionId);
          if (!prev || prev.state !== mapped) {
            sessionStatesRef.current.set(msg.sessionId, { state: mapped, reason: prev?.reason });
            setTabRenderTick(t => t + 1);
          }
        }
        // Bulk session state init (WS reconnect recovery)
        if (msg.type === "session-states-init" && msg.states) {
          const states = msg.states as Record<string, { state: string; reason?: string; sessionId?: string }>;
          let changed = false;
          for (const [key, val] of Object.entries(states)) {
            const sid = val.sessionId || key;
            const mapped = val.state === "working" ? "working" : val.state === "needs_attention" ? "needs_attention" : "idle";
            const prev = sessionStatesRef.current.get(sid);
            if (!prev || prev.state !== mapped || prev.reason !== val.reason) {
              sessionStatesRef.current.set(sid, { state: mapped, reason: val.reason });
              changed = true;
            }
          }
          if (changed) setTabRenderTick(t => t + 1);
        }
        // Pause state: suppress needs_attention indicator
        if (msg.type === 'conv-paused' && msg.sessionId) {
          if (msg.paused) {
            pausedSessionsRef.current.add(msg.sessionId);
          } else {
            pausedSessionsRef.current.delete(msg.sessionId);
          }
          setTabRenderTick(t => t + 1);
        }
      } catch (err) { console.warn('[LayoutManager] WS message handler error:', err); }
    };
    };

    connect();

    // Listen for SessionStore reconnection — immediately reconnect control WS
    const onServerReconnected = () => {
      if (disposed) return;
      console.log('[LayoutManager WS] Server reconnected via SessionStore, immediate reconnect');
      if (reconnectTimer) clearTimeout(reconnectTimer);
      backoff = 1000;
      const existing = controlWsRef.current;
      if (existing) { existing.onclose = null; existing.close(); controlWsRef.current = null; }
      connect();
    };
    window.addEventListener('cui-reconnected', onServerReconnected);

    return () => {
      disposed = true;
      window.removeEventListener('cui-reconnected', onServerReconnected);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      const ws = controlWsRef.current;
      controlWsRef.current = null;
      ws?.close();
    };
  }, [projectId]); // Only reconnect when project changes, not on every model update

  // Process pending activation plan (from prop, e.g. after project switch)
  useEffect(() => {
    if (!pendingActivation || !model) return;
    const myPlan = pendingActivation.find(p => p.projectId === projectId);
    if (!myPlan) return;

    // Wait for WS to connect before sending navigate commands
    const tryProcess = () => {
      const ws = controlWsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        // WS not ready yet - retry shortly
        setTimeout(tryProcess, 200);
        return;
      }

      // Same logic as the WS handler: inventory, match, split, navigate (generic, no account binding)
      // Only use cui/cui-lite panels — never mission-chat (reserved panel)
      const existingPanels: string[] = [];
      model.visitNodes((node) => {
        if (node.getType() === 'tab') {
          const tab = node as TabNode;
          if (tab.getComponent() === 'cui' || tab.getComponent() === 'cui-lite') {
            existingPanels.push(tab.getId());
          }
        }
      });

      const assignments: Array<{ panelId: string; sessionId: string }> = [];
      const usedPanels = new Set<string>();
      const unmatched: Array<{ sessionId: string; accountId: string }> = [];

      for (const conv of myPlan.conversations) {
        const panel = existingPanels.find(id => !usedPanels.has(id));
        if (panel) {
          assignments.push({ panelId: panel, sessionId: conv.sessionId });
          usedPanels.add(panel);
        } else {
          unmatched.push(conv);
        }
      }

      let tabsetCount = 0;
      model.visitNodes((node) => { if (node.getType() === 'tabset') tabsetCount++; });

      for (const conv of unmatched) {
        // Find a tabset and use its PARENT as target — this creates a new separate panel
        // (targeting the tabset itself would just add a tab into it)
        let targetId = '';
        let fallbackTabsetId = '';
        model.visitNodes((node) => {
          if (node.getType() === 'tabset' && !targetId) {
            const ts = node as TabSetNode;
            fallbackTabsetId = ts.getId();
            const parent = ts.getParent();
            if (parent) targetId = parent.getId();
          }
        });
        if (!targetId) {
          targetId = fallbackTabsetId;
          if (!targetId) continue;
        }

        const dockLocation = tabsetCount < 6
          ? DockLocation.RIGHT
          : DockLocation.CENTER;

        try {
          model.doAction(Actions.addNode(
            { type: 'tab', name: 'Chat', component: 'cui', config: {} },
            targetId, dockLocation, -1
          ));
        } catch (err) { console.warn('[LayoutManager] pendingActivation addNode failed:', err); continue; }
        tabsetCount++;

        let newPanelId = '';
        model.visitNodes((node) => {
          if (node.getType() === 'tab') {
            const tab = node as TabNode;
            if ((tab.getComponent() === 'cui' || tab.getComponent() === 'cui-lite')
                && !usedPanels.has(tab.getId()) && !assignments.some(a => a.panelId === tab.getId())) {
              newPanelId = tab.getId();
            }
          }
        });
        if (newPanelId) {
          assignments.push({ panelId: newPanelId, sessionId: conv.sessionId });
          usedPanels.add(newPanelId);
        }
      }

      assignments.forEach((a, i) => {
        setTimeout(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'navigate-request', panelId: a.panelId, sessionId: a.sessionId, projectId }));
          }
        }, i * 300);
      });

      saveLayout(model);
      onActivationProcessed?.(projectId);
    };

    tryProcess();
  }, [pendingActivation, model, projectId, onActivationProcessed, saveLayout]);

  // Auto-mount ongoing (non-finished) conversations for this project as tabs
  // Continuous auto-sync: periodically mount missing conversations, close finished ones
  const syncNowRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!modelInitialized || !workDir) return;
    let disposed = false;

    const syncConversations = async () => {
      const m = modelRef.current;
      const ws = controlWsRef.current;
      if (!m || disposed || window.__cuiServerAlive === false) return;

      try {
        // Filter by projectId (precise — resolves multi-workspace users like David/Sahori).
        // Server accepts either projectId or workDir for backwards compat.
        const projFilter = projectId || workDir;
        const res = await fetch(`/api/mission/conversations?project=${encodeURIComponent(projFilter)}`,
          { signal: AbortSignal.timeout(10000) });
        if (!res.ok || disposed) return;
        const data = await res.json();
        const conversations: any[] = data.conversations || [];

        // Inventory mounted CUI tabs (and mission-chat tabs to avoid routing sessions there).
        // mountedSessions tracks ONLY cui/cui-lite tabs — these are the ones the cleanup
        // loop is allowed to delete. mission-chat panels are tracked separately so we
        // don't double-mount sessions there, but they are NEVER candidates for deletion.
        const mountedSessions = new Map<string, string>(); // sessionId -> cui/cui-lite nodeId (canonical = first)
        const allMountsBySid = new Map<string, string[]>(); // sessionId -> ALL nodeIds (for duplicate detection)
        const sessionsInMissionChat = new Set<string>();    // sessions currently shown in a mission-chat panel
        const emptyPanels: string[] = [];
        m.visitNodes((node) => {
          if (node.getType() === 'tab') {
            const tab = node as TabNode;
            const comp = tab.getComponent?.();
            if (comp === 'mission-chat') {
              const route = getNodeRoute(tab) || '';
              const sid = route.startsWith('/c/') ? route.slice(3) : '';
              if (sid) sessionsInMissionChat.add(sid);
              return;
            }
            if (comp !== 'cui' && comp !== 'cui-lite') return;
            const route = getNodeRoute(tab) || '';
            const cfgSid = tab.getConfig()?.initialSessionId || '';
            const sid = route.startsWith('/c/') ? route.slice(3) : cfgSid || '';
            if (sid) {
              if (!mountedSessions.has(sid)) mountedSessions.set(sid, tab.getId());
              const arr = allMountsBySid.get(sid) || [];
              arr.push(tab.getId());
              allMountsBySid.set(sid, arr);
              // Ensure config has initialSessionId (triggers useEffect in CuiLitePanel to un-stuck Queue)
              if (!cfgSid) {
                try {
                  m.doAction(Actions.updateNodeAttributes(tab.getId(), {
                    config: { ...tab.getConfig(), initialSessionId: sid }
                  }));
                } catch {} // silent-ok: FlexLayout node attribute update is best-effort for session routing
              }
            } else {
              emptyPanels.push(tab.getId());
            }
          }
        });
        // Determine which conversations should be active.
        // Single source of truth: only manualFinished decides. The server's
        // status='completed' fires after every Claude reply (between turns) and
        // therefore must NOT be used to evict tabs — would constantly remove
        // tabs that the user is actively working in.
        const active = conversations.filter((c: any) => !c.manualFinished);
        const activeSessionIds = new Set(active.map((c: any) => c.sessionId));

        // Duplicate-cleanup: same sessionId mounted on multiple cui tabs.
        // Happens when server-persisted layout drifts (apply-layout merge edge cases,
        // user-driven tab splits, race conditions in addNode). Always remove duplicates,
        // not gated on __cuiAutoLayoutActive — duplicates make the chat appear twice
        // and confuse session-claim eviction.
        let duplicatesRemoved = 0;
        for (const [sid, ids] of allMountsBySid) {
          if (ids.length <= 1) continue;
          // Keep the FIRST (canonical = the one mountedSessions points to).
          // Delete the rest.
          for (let i = 1; i < ids.length; i++) {
            try {
              m.doAction(Actions.deleteTab(ids[i]));
              duplicatesRemoved++;
            } catch (err) { console.warn('[LM] duplicate deleteTab failed:', err); }
          }
          logCuiTelemetry({
            ts: Date.now(), kind: 'lm-duplicate-detected', projectId,
            sessionId: sid.slice(0, 8), totalMounts: ids.length, kept: ids[0], removed: ids.slice(1)
          });
        }
        if (duplicatesRemoved > 0) {
          saveLayoutRef.current(m);
          console.log(`[LM] Removed ${duplicatesRemoved} duplicate cui tabs`);
        }

        // Cleanup: remove tabs whose session is no longer active (finished or too old)
        // ONLY when user explicitly clicked Layout button (prevents sessions from disappearing)
        let removed = 0;
        if (window.__cuiAutoLayoutActive) {
          for (const [sid, nodeId] of mountedSessions) {
            // Keep if session is in active list
            if (activeSessionIds.has(sid)) continue;
            // Keep panels reserved for new session creation (placeholder route)
            if (sid === '_starting') continue;
            // Remove stale tab
            try {
              m.doAction(Actions.deleteTab(nodeId));
              removed++;
            } catch (err) { console.warn('[LM] cleanup deleteTab failed:', err); }
          }
          if (removed > 0) {
            saveLayoutRef.current(m);
            logCuiTelemetry({ ts: Date.now(), kind: 'lm-cleanup', projectId, removed, autoLayoutActive: !!window.__cuiAutoLayoutActive });
            console.log(`[LM] Cleanup: removed ${removed} stale tabs`);
          }
        }

        const missing = active.filter((c: any) => !mountedSessions.has(c.sessionId));

        // Report missing sessions count to parent (for Layout button indicator)
        onMissingSessionsRef.current?.(missing.length);

        if (missing.length === 0 && removed === 0 && duplicatesRemoved === 0) return;
        if (missing.length === 0) {
          if (duplicatesRemoved > 0) {
            logCuiTelemetry({ ts: Date.now(), kind: 'lm-sync-done', projectId, mounted: 0, removed, duplicatesRemoved, autoLayoutActive: !!window.__cuiAutoLayoutActive });
          }
          return;
        }

        let mounted = 0;
        const newlyMounted: Array<{ panelId: string; sessionId: string }> = [];

        for (const conv of missing) {
          // Race-protection: re-verify session isn't already mounted on a tab.
          // `mountedSessions` is built from a stale visitNodes snapshot — between
          // that scan and now, FlexLayout may have hydrated a tab's config (so
          // initialSessionId is now visible), or apply-layout may have arrived.
          // Skip if any cui/cui-lite tab currently reports this session.
          let alreadyMountedNow = false;
          m.visitNodes((node) => {
            if (alreadyMountedNow) return;
            if (node.getType() !== 'tab') return;
            const tab = node as TabNode;
            const tcomp = tab.getComponent?.();
            if (tcomp !== 'cui' && tcomp !== 'cui-lite') return;
            const tcfg = tab.getConfig() || {};
            if (tcfg.initialSessionId === conv.sessionId) { alreadyMountedNow = true; return; }
            const troute = getNodeRoute(tab) || '';
            if (troute === `/c/${conv.sessionId}`) alreadyMountedNow = true;
          });
          if (alreadyMountedNow) {
            logCuiTelemetry({ ts: Date.now(), kind: 'lm-skip-already-mounted-race', projectId, sessionId: conv.sessionId?.slice(0, 8) });
            continue;
          }

          // Priority 1: Reuse an empty/stale CUI panel — just update its config
          // (always allowed — needed to show sessions on load and after sync)
          if (emptyPanels.length > 0) {
            const reuseNodeId = emptyPanels.shift()!;
            const existingCfg = (m.getNodeById(reuseNodeId) as TabNode)?.getConfig?.() ?? {};
            // Skip panels that were just reserved by user (have _userReserved timestamp within last 60s)
            if (existingCfg._userReserved && Date.now() - existingCfg._userReserved < 60000) {
              emptyPanels.unshift(reuseNodeId); // put back, don't claim
            } else if (existingCfg.initialSessionId && existingCfg.initialSessionId !== conv.sessionId) {
              // Race: panel looked empty during visitNodes but now has a (different) session.
              // Don't overwrite — that would silently steal a tab from another conversation.
              logCuiTelemetry({ ts: Date.now(), kind: 'lm-skip-reuse-race', projectId, panelId: reuseNodeId, hadSession: existingCfg.initialSessionId?.slice(0, 8), wantedSession: conv.sessionId?.slice(0, 8) });
            } else {
              try {
                m.doAction(Actions.updateNodeAttributes(reuseNodeId, {
                  config: { ...existingCfg, initialSessionId: conv.sessionId, accountId: conv.accountId }
                }));
                logCuiTelemetry({ ts: Date.now(), kind: 'lm-reuse-empty-panel', projectId, panelId: reuseNodeId, sessionId: conv.sessionId?.slice(0, 8) });
                newlyMounted.push({ panelId: reuseNodeId, sessionId: conv.sessionId });
                mounted++;
                continue;
              } catch {} // silent-ok: panel config reuse failure is non-critical; session gets a new tab
            }
          }

          // Priority 2: Add as separate split panel — only when explicitly triggered
          if (!window.__cuiAutoLayoutActive) {
            // Silent: this branch fires every 30s for every unmounted session — would flood the console
            continue;
          }
          // Find a CUI tabset to split from (prefer one with existing CUI panels)
          let targetTabsetId = '';
          m.visitNodes((node) => {
            if (node.getType() === 'tab' && !targetTabsetId) {
              const tab = node as TabNode;
              if (tab.getComponent() === 'cui' || tab.getComponent() === 'cui-lite') {
                const parent = tab.getParent();
                if (parent && parent.getType() === 'tabset') targetTabsetId = parent.getId();
              }
            }
          });
          // Fallback: any tabset
          if (!targetTabsetId) {
            m.visitNodes((node) => {
              if (!targetTabsetId && node.getType() === 'tabset') targetTabsetId = node.getId();
            });
          }
          if (!targetTabsetId) continue;

          // Count current tabsets to determine split direction
          let tabsetCount = 0;
          m.visitNodes((node) => { if (node.getType() === 'tabset') tabsetCount++; });

          // Split as separate panel: always horizontal (side by side), CENTER as fallback
          const dockLocation = tabsetCount < 6
            ? DockLocation.RIGHT
            : DockLocation.CENTER;

          try {
            logCuiTelemetry({ ts: Date.now(), kind: 'lm-addnode-split', projectId, sessionId: conv.sessionId?.slice(0, 8), targetTabsetId, tabsetCount });
            m.doAction(Actions.addNode(
              { type: 'tab', name: 'Chat', component: 'cui',
                config: { initialSessionId: conv.sessionId, accountId: conv.accountId } },
              targetTabsetId, dockLocation, -1
            ));
            // addNode generates a new nodeId — find it by scanning for the session
            m.visitNodes((node) => {
              if (node.getType() === 'tab') {
                const tab = node as TabNode;
                if (tab.getConfig()?.initialSessionId === conv.sessionId) {
                  newlyMounted.push({ panelId: tab.getId(), sessionId: conv.sessionId });
                }
              }
            });
            mounted++;
          } catch (err) { console.warn('[LM] auto-sync addNode failed:', err); }
        }

        // Send navigate-request ONLY for newly mounted panels (not all panels)
        if (newlyMounted.length > 0 && ws?.readyState === WebSocket.OPEN) {
          for (const ps of newlyMounted) {
            ws.send(JSON.stringify({ type: 'navigate-request', panelId: ps.panelId, sessionId: ps.sessionId, projectId }));
          }
        }

        if (mounted > 0) {
          saveLayoutRef.current(m);
          logCuiTelemetry({ ts: Date.now(), kind: 'lm-sync-done', projectId, mounted, removed, autoLayoutActive: !!window.__cuiAutoLayoutActive });
          console.log(`[LM] Auto-sync: mounted ${mounted} conversations`);
        }
      } catch (err) { console.warn('[LM] auto-sync error:', err); }
    };

    syncNowRef.current = syncConversations;

    // Initial sync after 2s (let layout settle)
    const initialTimer = setTimeout(() => { if (!disposed) syncConversations(); }, 2000);
    // Periodic sync every 30s
    const interval = setInterval(() => { if (!disposed) syncConversations(); }, 30000);

    return () => {
      disposed = true;
      syncNowRef.current = null;
      clearTimeout(initialTimer);
      clearInterval(interval);
    };
  }, [modelInitialized, workDir, projectId]);

  // Tool Hub pin event: toggle sync for a tool by component name
  // Only the active workspace reacts (projectId filter in detail)
  useEffect(() => {
    if (!modelInitialized) return;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.component) return;
      // Only active workspace handles — prevents multiple mounted LayoutManagers from reacting
      if (detail.projectId && detail.projectId !== projectId) return;
      toggleSyncTool(detail.component, detail.name || detail.component);
    };
    window.addEventListener('cui-toggle-sync-tool', handler);
    return () => window.removeEventListener('cui-toggle-sync-tool', handler);
  }, [modelInitialized, projectId, toggleSyncTool]);

  // Manual sync trigger: 'cui-auto-layout' event (dispatched by Layout button in toolbar).
  // Mounts all open chats into the current layout without resetting it — the
  // __cuiAutoLayoutActive flag tells syncConversations to add unmatched chats as
  // new tabs (the default "automatic" sync only touches chats already in the layout).
  // Factory reset lives in the Cache button (wipes client + server layout).
  useEffect(() => {
    if (!modelInitialized) return;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.projectId && detail.projectId !== projectId) return;
      logCuiTelemetry({ ts: Date.now(), kind: 'lm-layout-button-clicked', projectId });
      window.__cuiAutoLayoutActive = true;
      syncNowRef.current?.();
      setTimeout(() => { window.__cuiAutoLayoutActive = false; }, 3000);
    };
    window.addEventListener('cui-auto-layout', handler);
    return () => window.removeEventListener('cui-auto-layout', handler);
  }, [modelInitialized, projectId]);

  // Trigger immediate sync + notify server when this project tab becomes active
  useEffect(() => {
    if (isActive) {
      // Force FlexLayout to recalculate dimensions after display:none → display:flex transition
      // Without this, FlexLayout may render with stale 0x0 dimensions from when the tab was hidden
      const redrawTimer = setTimeout(() => {
        const internal = (layoutRef.current as unknown as PatchableLayoutRef)?.selfRef?.current;
        if (internal?.redrawInternal) {
          internal.redrawInternal('project-switch');
        }
      }, 50); // 50ms: enough for CSS display:flex to take effect, before user sees black screen

      // Notify server of active project (sets activeProjectId for auto-layout)
      fetch(`/api/control/project/switch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId }),
      }).catch(() => { /* non-critical */ });
      // Also report panels with activeProjectId
      const ws = controlWsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        const m = modelRef.current;
        if (m) {
          const panels: Array<{ id: string; component: string; config: Record<string, unknown>; name: string }> = [];
          m.visitNodes((node) => {
            if (node.getType() === 'tab') {
              const tab = node as TabNode;
              panels.push({ id: tab.getId(), component: tab.getComponent() ?? 'unknown', config: tab.getConfig() ?? {}, name: tab.getName() });
            }
          });
          ws.send(JSON.stringify({ type: 'state-report', panels, projectId, activeProjectId: projectId }));
        }
      }
      // Small delay to let CSS display:flex take effect before syncing conversations
      if (syncNowRef.current) {
        const t = setTimeout(() => syncNowRef.current?.(), 300);
        return () => { clearTimeout(t); clearTimeout(redrawTimer); };
      }
      return () => clearTimeout(redrawTimer);
    }
  }, [isActive, projectId]);

  // Report attention state to parent (any CUI panel working, needs_attention, or idle with session)
  // Uses both panel-reported _attention AND WS-tracked sessionStatesRef for reliability
  useEffect(() => {
    if (!model || !onAttentionChange) return;
    let hasAttention = false;
    let highestState: 'working' | 'needs_attention' | 'idle' | undefined;
    let hasAnySession = false;
    model.visitNodes((node) => {
      if (node.getType() === 'tab') {
        const tab = node as TabNode;
        const comp = tab.getComponent();
        if (comp === 'cui' || comp === 'cui-lite') {
          const route = getNodeRoute(tab);
          const hasRoute = !!route;
          if (hasRoute) hasAnySession = true;

          // Primary: panel-reported attention (live, ephemeral)
          let effectiveState = getNodeAttention(tab);

          // Fallback: WS-tracked session state (more reliable for non-visible panels)
          const sessionId = route?.startsWith('/c/') ? route.slice(3) :
            (tab.getConfig()?.initialSessionId || tab.getConfig()?.sessionId || null);
          if (!effectiveState || effectiveState === 'idle') {
            if (sessionId) {
              const wsState = sessionStatesRef.current.get(sessionId);
              if (wsState && wsState.state !== 'idle') {
                effectiveState = wsState.state;
              }
            }
          }

          // Paused sessions: suppress needs_attention — don't bubble up to project indicator
          if (sessionId && pausedSessionsRef.current.has(sessionId)) {
            effectiveState = 'idle';
          }

          if (effectiveState === 'needs_attention') {
            hasAttention = true;
            highestState = 'needs_attention'; // highest priority
          } else if (effectiveState === 'working' && highestState !== 'needs_attention') {
            hasAttention = true;
            highestState = 'working';
          } else if (hasRoute && highestState !== 'needs_attention' && highestState !== 'working') {
            highestState = 'idle';
          }
        }
      }
    });
    // Report idle state if there are sessions but none are working/needs_attention
    if (!hasAttention && hasAnySession && highestState === 'idle') {
      onAttentionChange(false, 'idle');
    } else {
      onAttentionChange(hasAttention, highestState);
    }
  }, [model, cuiStates, onAttentionChange, attentionVersion, tabRenderTick]);

  // Patch flexlayout's redrawInternal to prevent continuous render loop
  useEffect(() => {
    if (layoutRef.current) patchLayoutRedraw(layoutRef.current as unknown as PatchableLayoutRef);
  }, [model]);

  // Memoize Layout element: Layout is a class component without shouldComponentUpdate.
  // Without this, every LayoutManager re-render (e.g. cuiStates change) causes
  // Layout.render() → this.revision++ → ALL visible tab content re-renders.
  // Must be before any early returns to satisfy React's rules of hooks.
  const layoutElement = useMemo(() => {
    if (!model) return null;
    return (
      <Layout
        ref={layoutRef}
        model={model}
        factory={factory}
        onModelChange={handleModelChange}
        onAction={handleAction}
        onRenderTabSet={stableOnRenderTabSet}
        onRenderTab={stableOnRenderTab}
      />
    );
  }, [model, factory, handleModelChange, handleAction, stableOnRenderTabSet, stableOnRenderTab]);

  if (!model) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--tn-text-muted)', fontSize: 12 }}>
        Loading layout...
      </div>
    );
  }

  return (
    <div style={{ flex: 1, position: 'relative', minHeight: 0, contain: 'layout style' }}>
      {layoutElement}

      {/* Floating toolbar */}
      <div style={{
        position: 'absolute', top: 6, right: 6, zIndex: 10,
        display: 'flex', gap: 4,
      }}>
        <button
          onClick={() => setShowBuilder(true)}
          title="Layout Builder"
          style={{
            background: 'var(--tn-bg-dark)', border: '1px solid var(--tn-border)',
            color: 'var(--tn-text-muted)', cursor: 'pointer', fontSize: 13,
            padding: '3px 7px', borderRadius: 4, opacity: 0.7,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
          onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.7'; }}
        >
          ⊞
        </button>
        <button
          onClick={handleResetLayout}
          title="Layout zuruecksetzen"
          style={{
            background: 'var(--tn-bg-dark)', border: '1px solid var(--tn-border)',
            color: 'var(--tn-text-muted)', cursor: 'pointer', fontSize: 13,
            padding: '3px 7px', borderRadius: 4, opacity: 0.7,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
          onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.7'; }}
        >
          ↺
        </button>
      </div>

      {showBuilder && (
        <Suspense fallback={<PanelLoader />}>
          <LayoutBuilder
            workDir={workDir}
            onApply={handleApplyLayout}
            onClose={() => setShowBuilder(false)}
          />
        </Suspense>
      )}
    </div>
  );
}
