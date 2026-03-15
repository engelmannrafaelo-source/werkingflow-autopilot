import { useCallback, useRef, useState, useEffect, useMemo, lazy, Suspense } from 'react';
import { Layout, Model, TabNode, TabSetNode, BorderNode, IJsonModel, ITabSetRenderValues, ITabRenderValues, Actions, DockLocation, Rect } from 'flexlayout-react';
import type { CuiStates } from '../types';
import { copyToClipboard } from '../utils/clipboard';
const ACCOUNT_LABELS: Record<string, string> = { rafael: "Engelmann", engelmann: "Gmail", office: "Office", local: "Lokal", gemini: "Gemini" };

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
function patchLayoutRedraw(layoutRef: any) {
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
import NativeChat from './panels/NativeChat';
import ImageDrop from './panels/ImageDrop';
import BrowserPanel from './panels/BrowserPanel';
import FilePreview from './panels/FilePreview';
import NotesPanel from './panels/NotesPanel';
import ErrorBoundary from './ErrorBoundary';
import PanelConnectivityGuard from './panels/PanelConnectivityGuard';

// --- Heavy panels (lazy-loaded: recharts, d3, large component trees) ---
const MissionControl = lazy(() => import('./panels/MissionControl'));
const OfficePanel = lazy(() => import('./panels/OfficePanel'));
const KnowledgeFullscreen = lazy(() => import('./panels/KnowledgeFullscreen'));
const WerkingReportAdmin = lazy(() => import('./panels/WerkingReportAdmin/WerkingReportAdmin'));
const LinkedInPanel = lazy(() => import('./panels/LinkedInPanel'));
const BridgeMonitor = lazy(() => import('./panels/BridgeMonitor/BridgeMonitor'));
const InfisicalMonitor = lazy(() => import('./panels/InfisicalMonitor/InfisicalMonitor'));
const QADashboard = lazy(() => import('./panels/QADashboard/QADashboard'));
const RepoDashboard = lazy(() => import('./panels/RepoDashboard/RepoDashboard'));
const SystemHealth = lazy(() => import('./panels/SystemHealth'));
const WatchdogPanel = lazy(() => import('./panels/WatchdogPanel'));
const LayoutBuilder = lazy(() => import('./LayoutBuilder'));
const PeerAwarenessPanel = lazy(() => import('./panels/PeerAwarenessPanel'));
const BackgroundOpsPanel = lazy(() => import('./panels/BackgroundOpsPanel'));
const ConversationQueuePanel = lazy(() => import("./panels/ConversationQueuePanel"));
const MaintenancePanel = lazy(() => import('./panels/MaintenancePanel/MaintenancePanel'));

import '../styles/office.css';

// Shared loading spinner for lazy panels
const PanelLoader = () => (
  <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--tn-text-muted)", fontSize: 11 }}>
    Loading panel...
  </div>
);

const API = '/api';

function defaultLayout(workDir: string): IJsonModel {
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
          type: 'row',
          weight: 50,
          children: [
            {
              type: 'tabset',
              weight: 50,
              children: [
                {
                  type: 'tab',
                  name: 'CUI',
                  component: 'cui',
                  config: {},
                },
              ],
            },
            {
              type: 'tabset',
              weight: 50,
              children: [
                {
                  type: 'tab',
                  name: 'File Preview',
                  component: 'preview',
                  config: { watchPath: workDir },
                },
                {
                  type: 'tab',
                  name: 'Notes',
                  component: 'notes',
                  config: {},
                },
              ],
            },
          ],
        },
        {
          type: 'row',
          weight: 50,
          children: [
            {
              type: 'tabset',
              weight: 50,
              children: [
                {
                  type: 'tab',
                  name: 'CUI',
                  component: 'cui',
                  config: {},
                },
              ],
            },
            {
              type: 'tabset',
              weight: 50,
              children: [
                {
                  type: 'tab',
                  name: 'Browser',
                  component: 'browser',
                  config: { url: '' },
                },
              ],
            },
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
  onAttentionChange?: (needsAttention: boolean, state?: 'working' | 'needs_attention') => void;
  onCuiStateReset?: (cuiId: string) => void;
  pendingActivation?: ActivationPlan[] | null;
  onActivationProcessed?: (projectId?: string) => void;
}

export default function LayoutManager({ projectId, workDir, cuiStates = {}, onAttentionChange, onCuiStateReset, pendingActivation, onActivationProcessed }: LayoutManagerProps) {
  // Stale-while-revalidate: use cached layout instantly, refresh in background
  const [model, setModel] = useState<Model | null>(() => {
    try {
      const cached = localStorage.getItem(`cui-layout-${projectId}`);
      if (cached) return Model.fromJson(JSON.parse(cached));
    } catch (err) { console.warn('[LayoutManager] Corrupted layout cache in initializer:', err); }
    return null;
  });
  const [showBuilder, setShowBuilder] = useState(false);
  const [attentionVersion, setAttentionVersion] = useState(0); // triggers re-evaluation of attention state
  const templateRef = useRef<IJsonModel | null>(null);
  const layoutRef = useRef<Layout>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(null);
  const activeDirRef = useRef<string>(workDir);
  const controlWsRef = useRef<WebSocket | null>(null);

  // Per-session state tracking for tab indicators (updated via WS conv-attention events)
  // Key: sessionId, Value: { state, reason }
  const sessionStatesRef = useRef<Map<string, { state: string; reason?: string }>>(new Map());
  // Force tab re-render counter (bumped when session states change)
  const [tabRenderTick, setTabRenderTick] = useState(0);

  // Refs for stable Layout callback props (prevent Layout re-render → revision++ → ALL tab content re-render)
  const cuiStatesRef = useRef(cuiStates);
  cuiStatesRef.current = cuiStates;
  const onCuiStateResetRef = useRef(onCuiStateReset);
  onCuiStateResetRef.current = onCuiStateReset;
  const modelRef = useRef<Model | null>(null);
  modelRef.current = model;

  // Background refresh: fetch fresh layout from server (stale-while-revalidate)
  // Model is already loaded from localStorage cache in useState initializer above
  useEffect(() => {
    let cancelled = false;
    const cacheKey = `cui-layout-${projectId}`;
    const tplCacheKey = `cui-template-${projectId}`;
    const hadCachedModel = model !== null;

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

    Promise.all([
      fetchWithTimeout(`${API}/layouts/${projectId}`),
      fetchWithTimeout(`${API}/layouts/${projectId}/template`),
      fetchWithTimeout(`${API}/active-dir/${projectId}`),
    ]).then(([layoutJson, tplJson, activeDir]) => {
      if (cancelled) return;
      if (activeDir?.path) activeDirRef.current = activeDir.path;
      if (tplJson) {
        templateRef.current = tplJson;
        try { localStorage.setItem(tplCacheKey, JSON.stringify(tplJson)); } catch (e) { console.warn('[LayoutManager] Failed to cache template:', e); }
      }
      if (layoutJson) {
        // Cache for next load
        try { localStorage.setItem(cacheKey, JSON.stringify(layoutJson)); } catch (e) { console.warn('[LayoutManager] Failed to cache layout:', e); }
        // Only update model if we didn't have a cache (avoid destroying existing Layout tree)
        if (!hadCachedModel) {
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

    switch (component) {
      case 'cui':
      case 'cui-lite':
        return wrapPanel('CUI', <CuiLitePanel accountId={config.accountId} projectId={projectId} workDir={workDir} panelId={nodeId} isTabVisible={node.isVisible()}
          initialRoute={config._route}
          initialSessionId={config.initialSessionId}
          onRouteChange={(route) => updateNodeConfig(nodeId, { _route: route })}
          onStateChange={(state) => { updateNodeConfig(nodeId, { _attention: state }); setAttentionVersion(v => v + 1); }}
          onFinish={(sid) => {
            const m = modelRef.current;
            if (m) {
              try { m.doAction(Actions.deleteTab(nodeId)); saveLayoutRef.current(m); } catch (e) { console.warn('[LM] Finish deleteTab:', e); }
            }
          }} />);
      case 'chat': {
        const accountId = config.accountId || 'rafael';
        const PROXY_PORTS: Record<string, number> = {
          rafael: 5001,
          engelmann: 5002,
          office: 5003,
          local: 5004,
          gemini: 5005
        };
        return wrapPanel('NativeChat', <NativeChat accountId={accountId} proxyPort={PROXY_PORTS[accountId] || 5001} />);
      }
      case 'images':
        return wrapPanel('ImageDrop', <ImageDrop />);
      case 'browser':
        return wrapPanel('BrowserPanel', <BrowserPanel initialUrl={config.url} panelId={nodeId}
          onUrlChange={(url) => updateNodeConfig(nodeId, { url })} />);
      case 'preview':
        return wrapPanel('FilePreview', <FilePreview watchPath={config.watchPath || activeDirRef.current || workDir} stageDir={activeDirRef.current} />);
      case 'notes':
        return wrapPanel('NotesPanel', <NotesPanel projectId={projectId} />);
      case 'mission':
        return wrapPanel('MissionControl', withSuspense(<MissionControl projectId={config.projectId || projectId} workDir={config.workDir || workDir} />));
      case 'office':
      case 'virtual-office':
        return wrapPanel('OfficePanel', withSuspense(<OfficePanel projectId={projectId} workDir={workDir} />));
      case 'knowledge':
      case 'knowledge-fullscreen':
        return wrapPanel('KnowledgeFullscreen', withSuspense(<KnowledgeFullscreen projectId={projectId} workDir={workDir} />));
      case 'admin-wr':
        return wrapPanel('WerkingReportAdmin', withSuspense(<WerkingReportAdmin />));
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
      case 'system-health':
        return wrapPanel('SystemHealth', withSuspense(<SystemHealth />));
      case 'watchdog':
      case 'infrastructure': // Alias: both point to Watchdog (iframe on :9090)
        return wrapPanel('WatchdogPanel', withSuspense(<WatchdogPanel />));
      case 'background-ops':
        return wrapPanel('BackgroundOps', withSuspense(<BackgroundOpsPanel />));
      case 'peer-awareness':
        return wrapPanel('PeerAwareness', withSuspense(<PeerAwarenessPanel />));
      case 'conversation-queue':
        return wrapPanel('ConversationQueue', withSuspense(<ConversationQueuePanel projectId={projectId} />));
      case 'maintenance':
        return wrapPanel('MaintenancePanel', withSuspense(<MaintenancePanel />));
      default:
        return wrapPanel(`Unknown:${component}`,
          <div style={{ padding: 20, color: 'var(--tn-text-muted)' }}>
            Unknown panel: {component}
          </div>
        );
    }
  }, [projectId, workDir]);

  const saveLayout = useCallback((m: Model) => {
    const json = m.toJson();
    // Cache locally for instant load on next visit
    try { localStorage.setItem(`cui-layout-${projectId}`, JSON.stringify(json)); } catch (e) { console.warn('[LayoutManager] Failed to cache layout locally:', e); }
    if ((window as any).__cuiServerAlive === false) return;
    try {
      fetch(`${API}/layouts/${projectId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(json),
        signal: AbortSignal.timeout(15000),
      }).catch((err) => { console.warn('[LayoutManager] saveLayout fetch failed:', err); });
    } catch (err) { console.warn('[LayoutManager] saveLayout error:', err); }
  }, [projectId]);

  const handleModelChange = useCallback(
    (m: Model) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => saveLayout(m), 1500);
    },
    [saveLayout]
  );

  const saveTemplate = useCallback((tpl: IJsonModel) => {
    templateRef.current = tpl;
    if ((window as any).__cuiServerAlive === false) return;
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
      const tpl = templateRef.current ?? defaultLayout(workDir);
      const newModel = Model.fromJson(tpl);
      setModel(newModel);
      saveLayout(newModel);
    } catch (err) { console.warn('[LayoutManager] handleResetLayout Model.fromJson failed:', err); }
  }, [workDir, saveLayout]);

  // Stable refs for WS effect (prevent reconnect on model/callback changes)
  const handleResetLayoutRef = useRef(handleResetLayout);
  handleResetLayoutRef.current = handleResetLayout;
  const saveLayoutRef = useRef(saveLayout);
  saveLayoutRef.current = saveLayout;

  const addTab = useCallback((type: 'cui' | 'cui-lite' | 'browser' | 'preview' | 'notes' | 'images' | 'mission' | 'office' | 'admin-wr' | 'linkedin' | 'system-health' | 'bridge-monitor' | 'repo-dashboard' | 'watchdog' | 'background-ops' | 'conversation-queue' | 'maintenance' | 'qa-dashboard' | 'peer-awareness' | 'infisical-monitor', config: Record<string, string>, targetId: string) => {
    const m = modelRef.current;
    if (!m) return;
    const names: Record<string, string> = {
      cui: 'CUI',
      'cui-lite': 'CUI',
      browser: 'Browser',
      preview: 'File Preview',
      notes: 'Notes',
      images: 'Images',
      mission: 'Mission Control',
      office: 'Virtual Office',
      'admin-wr': 'Werking Report Admin',
      linkedin: 'LinkedIn Marketing',
      'system-health': 'System Health',
      'bridge-monitor': 'Bridge Monitor',
      'repo-dashboard': 'Git & Pipeline Monitor',
      watchdog: 'Dev Server Watchdog',
      'background-ops': 'Background Ops',
      'conversation-queue': 'Conversation Queue',
      maintenance: 'Maintenance',
      'qa-dashboard': 'QA Dashboard',
      'peer-awareness': 'Peer Awareness',
      'infisical-monitor': 'Infisical Monitor',
    };
    if (type === 'preview' && !config.watchPath) {
      config.watchPath = activeDirRef.current || workDir;
    }
    try {
      m.doAction(
        Actions.addNode(
          { type: 'tab', name: names[type], component: type, config },
          targetId,
          DockLocation.CENTER,
          -1
        )
      );
    } catch (err) { console.warn('[LayoutManager] addTab doAction failed for', type, ':', err); }
  }, [workDir]);

  const onRenderTabSet = useCallback((node: TabSetNode | BorderNode, renderValues: ITabSetRenderValues) => {
    const nodeId = node.getId().replace(/^#/, '');
    renderValues.stickyButtons.push(
      <select
        key="add-tab"
        data-ai-id={`add-tab-dropdown-${nodeId}`}
        value=""
        onChange={(e) => {
          const val = e.target.value;
          if (!val) return;
          if (val === 'cui') {
            addTab('cui', {}, node.getId());
          } else {
            addTab(val as 'browser' | 'preview' | 'notes' | 'images' | 'mission' | 'office' | 'admin-wr' | 'linkedin' | 'system-health' | 'bridge-monitor' | 'repo-dashboard' | 'watchdog' | 'background-ops' | 'conversation-queue' | 'maintenance' | 'qa-dashboard' | 'peer-awareness' | 'infisical-monitor', {}, node.getId());
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
        <option value="cui">CUI</option>
        <option value="browser">Browser</option>
        <option value="preview">File Preview</option>
        <option value="notes">Notes</option>
        <option value="images">Images</option>
        <option value="mission">Mission Control</option>
        <option value="office">Virtual Office</option>
        <option value="qa-dashboard">QA Dashboard</option>
        <option value="admin-wr">Werking Report Admin</option>
        <option value="system-health">System Health</option>
        <option value="watchdog">Dev Server Watchdog</option>
        <option value="linkedin">LinkedIn Marketing</option>
        <option value="peer-awareness">Peer Awareness</option>
        <option value="background-ops">Background Ops</option>
        <option value="conversation-queue">Conversation Queue</option>
        <option value="bridge-monitor">Bridge Monitor (Old)</option>
        <option value="repo-dashboard">Git & Pipeline Monitor</option>
        <option value="infisical-monitor">Infisical Monitor</option>
        <option value="maintenance">Maintenance</option>
      </select>
    );
  }, [addTab]);

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
  const handleAction = useCallback((action: any) => {
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

    if (node.getComponent() !== 'cui' && node.getComponent() !== 'cui-lite') return;

    // Primary: panel-reported attention state (from CuiLitePanel onStateChange callback)
    const panelState = node.getConfig()?._attention as string | undefined;

    // Fallback: per-session WS state or per-account legacy state
    let sessionState = panelState || 'idle';
    if (sessionState === 'idle') {
      const route = node.getConfig()?._route as string | undefined;
      const sessionId = route?.startsWith('/c/') ? route.slice(3) : null;
      if (sessionId) {
        const ss = sessionStatesRef.current.get(sessionId);
        if (ss && ss.state !== 'idle') sessionState = ss.state;
      }
    }

    // State indicators: working (green pulse), needs_attention (red pulse), idle (dim)
    if (sessionState === 'working') {
      renderValues.leading = <span key="dot" className="cui-tab-dot cui-tab-dot--working" />;
    } else if (sessionState === 'needs_attention') {
      const attentionReason = node.getConfig()?._attentionReason;
      const label = attentionReason === 'permission' ? '⚡' : attentionReason === 'error' ? '⚠' : '●';
      renderValues.leading = <span key="dot" className="cui-tab-dot cui-tab-dot--attention" title={attentionReason || 'Needs input'}>{label}</span>;
    } else if (node.getConfig()?._route) {
      // Has a conversation open but idle
      renderValues.leading = <span key="dot" className="cui-tab-dot cui-tab-dot--idle" />;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabRenderTick]);

  // Control API: listen for panel/layout commands + report panel state (auto-reconnect)
  // IMPORTANT: No model/callback dependencies — uses refs to prevent WS reconnect on every model change
  useEffect(() => {
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let backoff = 1000; // start at 1s, doubles up to 30s max

    const connect = () => {
      if (disposed) return;
      if ((window as any).__cuiServerAlive === false) {
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
          ws.send(JSON.stringify({ type: 'state-report', panels, projectId }));
        } catch (err) { console.warn('[LayoutManager] reportPanels failed:', err); }
      }

      ws.onopen = () => {
        backoff = 1000;
        reportPanels();
        // Re-sync conversations on reconnect
        setTimeout(() => syncNowRef.current?.(), 1500);
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
        if ((msg.type === 'control:conversation-finished' || msg.type === 'control:conversation-deleted') && msg.panelsToClose && m) {
          const myPanels = (msg.panelsToClose as Array<{ panelId: string; projectId: string }>)
            .filter(p => p.projectId === projectId);
          for (const p of myPanels) {
            try { m.doAction(Actions.deleteTab(p.panelId)); } catch (err) { console.warn('[LayoutManager] deleteTab failed for panel', p.panelId, ':', err); }
          }
          if (myPanels.length > 0) {
            reportPanels();
            saveLayoutRef.current(m);
          }
        }
        if (msg.type === 'control:conversation-started' && msg.workDir === workDir) {
          // New conversation for our project — delay to let panel update its config first
          setTimeout(() => syncNowRef.current?.(), 5000);
        }
        if (msg.type === 'control:layout-reset') {
          handleResetLayoutRef.current();
          setTimeout(reportPanels, 200);
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
        if (msg.type === 'control:activate-conversations' && m && msg.plan) {
          const myPlan = (msg.plan as Array<{ projectId: string; conversations: Array<{ sessionId: string; accountId: string }> }>)
            .find(p => p.projectId === projectId);
          if (!myPlan) return;

          const existingPanels: string[] = [];
          m.visitNodes((node) => {
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
          m.visitNodes((node) => { if (node.getType() === 'tabset') tabsetCount++; });

          for (const conv of unmatched) {
            let targetId = '';
            let minTabs = Infinity;
            m.visitNodes((node) => {
              if (node.getType() === 'tabset') {
                const ts = node as TabSetNode;
                const count = ts.getChildren().length;
                if (count < minTabs) { minTabs = count; targetId = ts.getId(); }
              }
            });
            if (!targetId) continue;

            const dockLocation = tabsetCount < 6
              ? (tabsetCount % 2 === 0 ? DockLocation.RIGHT : DockLocation.BOTTOM)
              : DockLocation.CENTER;

            try {
              m.doAction(Actions.addNode(
                { type: 'tab', name: 'CUI', component: 'cui', config: {} },
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
      } catch (err) { console.warn('[LayoutManager] WS message handler error:', err); }
    };
    };

    connect();
    return () => {
      disposed = true;
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
        let targetId = '';
        let minTabs = Infinity;
        model.visitNodes((node) => {
          if (node.getType() === 'tabset') {
            const ts = node as TabSetNode;
            const count = ts.getChildren().length;
            if (count < minTabs) { minTabs = count; targetId = ts.getId(); }
          }
        });
        if (!targetId) continue;

        const dockLocation = tabsetCount < 6
          ? (tabsetCount % 2 === 0 ? DockLocation.RIGHT : DockLocation.BOTTOM)
          : DockLocation.CENTER;

        try {
          model.doAction(Actions.addNode(
            { type: 'tab', name: 'CUI', component: 'cui', config: {} },
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
    if (!model || !workDir) return;
    let disposed = false;

    const syncConversations = async () => {
      const m = modelRef.current;
      const ws = controlWsRef.current;
      if (!m || disposed || (window as any).__cuiServerAlive === false) return;

      try {
        const res = await fetch(`/api/mission/conversations?project=${encodeURIComponent(workDir)}`,
          { signal: AbortSignal.timeout(10000) });
        if (!res.ok || disposed) return;
        const data = await res.json();
        const conversations: any[] = data.conversations || [];

        // Inventory mounted CUI tabs
        const mountedSessions = new Map<string, string>(); // sessionId -> nodeId
        const emptyPanels: string[] = [];
        m.visitNodes((node) => {
          if (node.getType() === 'tab') {
            const tab = node as TabNode;
            const comp = tab.getComponent?.();
            if (comp !== 'cui' && comp !== 'cui-lite') return;
            const route = tab.getConfig()?._route || '';
            const cfgSid = tab.getConfig()?.initialSessionId || '';
            const sid = route.startsWith('/c/') ? route.slice(3) : cfgSid || '';
            if (sid) {
              mountedSessions.set(sid, tab.getId());
            } else {
              emptyPanels.push(tab.getId());
            }
          }
        });

        // Determine which conversations should be active (ongoing OR recent 48h, not finished)
        const cutoff48h = Date.now() - 48 * 60 * 60 * 1000;
        const active = conversations.filter((c: any) =>
          !c.manualFinished &&
          (c.status === 'ongoing' || new Date(c.updatedAt || 0).getTime() > cutoff48h)
        );
        const activeSessionIds = new Set(active.map((c: any) => c.sessionId));

        // Close panels whose sessions are NOT in the active set (finished, old, or unknown)
        let closedCount = 0;
        for (const [sid, nodeId] of mountedSessions) {
          if (!activeSessionIds.has(sid)) {
            try { m.doAction(Actions.deleteTab(nodeId)); closedCount++; } catch {}
          }
        }
        // Skip sessions that are already visible (mounted in a panel, even if config not yet updated)
        const missing = active.filter((c: any) => !mountedSessions.has(c.sessionId) && !c.isVisible);
        if (missing.length === 0 && closedCount === 0) return;

        const assignments: Array<{ panelId: string; sessionId: string }> = [];
        let emptyIdx = 0;

        for (const conv of missing) {
          if (emptyIdx < emptyPanels.length) {
            assignments.push({ panelId: emptyPanels[emptyIdx], sessionId: conv.sessionId });
            emptyIdx++;
          } else {
            // Only mount into tabsets that contain CUI panels (never web/preview/browser)
            let targetTabsetId = '';
            let bestScore = -1;
            m.visitNodes((node) => {
              if (node.getType() === 'tabset') {
                const ts = node as TabSetNode;
                const children = ts.getChildren();
                let cuiCount = 0;
                for (const child of children) {
                  const comp = (child as TabNode).getComponent?.();
                  if (comp === 'cui' || comp === 'cui-lite') cuiCount++;
                }
                if (cuiCount === 0) return; // Skip non-CUI tabsets entirely
                // Pure CUI tabsets get priority; fewer tabs = better
                const isPure = cuiCount === children.length;
                const score = (isPure ? 1000 : 0) + (100 - Math.min(children.length, 100));
                if (score > bestScore) { bestScore = score; targetTabsetId = ts.getId(); }
              }
            });
            if (!targetTabsetId) continue;
            try {
              m.doAction(Actions.addNode(
                { type: 'tab', name: (conv as any).customName || (conv as any).summary?.slice(0, 30) || 'CUI',
                  component: 'cui', config: { initialSessionId: conv.sessionId, accountId: conv.accountId } },
                targetTabsetId, DockLocation.CENTER, -1
              ));
              m.visitNodes((node) => {
                if (node.getType() === 'tab') {
                  const tab = node as TabNode;
                  if (tab.getConfig()?.initialSessionId === conv.sessionId) {
                    assignments.push({ panelId: tab.getId(), sessionId: conv.sessionId });
                  }
                }
              });
            } catch (err) { console.warn('[LM] auto-sync addNode failed:', err); }
          }
        }

        // Navigate assigned panels
        if (ws && ws.readyState === WebSocket.OPEN) {
          assignments.forEach((a, i) => {
            setTimeout(() => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'navigate-request', panelId: a.panelId, sessionId: a.sessionId, projectId }));
              }
            }, i * 300);
          });
        }

        if (assignments.length > 0 || closedCount > 0) {
          saveLayout(m);
          if (assignments.length > 0) console.log(`[LM] Auto-sync: mounted ${assignments.length} conversations`);
          if (closedCount > 0) console.log(`[LM] Auto-sync: closed ${closedCount} finished conversations`);
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
  }, [model, workDir, projectId, saveLayout]);

  // Report attention state to parent (any CUI panel working or needs_attention)
  useEffect(() => {
    if (!model || !onAttentionChange) return;
    let hasAttention = false;
    let highestState: 'working' | 'needs_attention' | undefined;
    model.visitNodes((node) => {
      if (node.getType() === 'tab') {
        const tab = node as TabNode;
        const comp = tab.getComponent();
        if (comp === 'cui' || comp === 'cui-lite') {
          const panelState = tab.getConfig()?._attention as string | undefined;
          if (panelState === 'needs_attention') {
            hasAttention = true;
            highestState = 'needs_attention'; // highest priority
          } else if (panelState === 'working' && highestState !== 'needs_attention') {
            hasAttention = true;
            highestState = 'working';
          }
        }
      }
    });
    onAttentionChange(hasAttention, highestState);
  }, [model, cuiStates, onAttentionChange, attentionVersion]);

  // Patch flexlayout's redrawInternal to prevent continuous render loop
  useEffect(() => {
    if (layoutRef.current) patchLayoutRedraw(layoutRef.current);
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
        onRenderTabSet={onRenderTabSet}
        onRenderTab={onRenderTab}
      />
    );
  }, [model, factory, handleModelChange, handleAction, onRenderTabSet, onRenderTab]);

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
