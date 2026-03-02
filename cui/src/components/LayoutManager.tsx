import { useCallback, useRef, useState, useEffect, useMemo, lazy, Suspense } from 'react';
import { Layout, Model, TabNode, TabSetNode, BorderNode, IJsonModel, ITabSetRenderValues, ITabRenderValues, Actions, DockLocation, Rect } from 'flexlayout-react';
import type { CuiStates } from '../types';
import { copyToClipboard } from '../utils/clipboard';
const ACCOUNT_LABELS: Record<string, string> = { rafael: "Engelmann", engelmann: "Gmail", office: "Office", local: "Lokal" };

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
const InfrastructurePanel = lazy(() => import('./panels/InfrastructurePanel'));
const AdministrationPanel = lazy(() => import('./panels/AdministrationPanel'));
const LayoutBuilder = lazy(() => import('./LayoutBuilder'));

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
  onAttentionChange?: (needsAttention: boolean) => void;
  onCuiStateReset?: (cuiId: string) => void;
  pendingActivation?: ActivationPlan[] | null;
  onActivationProcessed?: () => void;
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
  const templateRef = useRef<IJsonModel | null>(null);
  const layoutRef = useRef<Layout>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(null);
  const activeDirRef = useRef<string>(workDir);
  const controlWsRef = useRef<WebSocket | null>(null);

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
          onRouteChange={(route) => updateNodeConfig(nodeId, { _route: route })} />);
      case 'chat': {
        const accountId = config.accountId || 'rafael';
        const PROXY_PORTS: Record<string, number> = {
          rafael: 5001,
          engelmann: 5002,
          office: 5003,
          local: 5004
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
            checkUrl="http://localhost:3004/api/version"
            port={3004}
            startCommand="cd /root/projekte/werkingflow/platform && npm run build:local"
          >
            {withSuspense(<LinkedInPanel />)}
          </PanelConnectivityGuard>
        );
      case 'qa-dashboard':
        return wrapPanel('QADashboard', withSuspense(<QADashboard />));
      case 'bridge-monitor':
        return wrapPanel('BridgeMonitor',
          <PanelConnectivityGuard
            panelName="Bridge (Hetzner)"
            checkUrl="http://49.12.72.66:8000/health"
            startCommand="# Bridge runs on Hetzner (49.12.72.66:8000)
ssh root@49.12.72.66 'docker ps | grep ai-bridge'
ssh root@49.12.72.66 'docker logs ai-bridge --tail 50'"
          >
            {withSuspense(<BridgeMonitor />)}
          </PanelConnectivityGuard>
        );
      case 'infisical-monitor':
        // Using mock data in development - no connectivity check needed
        return wrapPanel('InfisicalMonitor', withSuspense(<InfisicalMonitor />));
      case 'repo-dashboard':
        return wrapPanel('RepoDashboard', withSuspense(<RepoDashboard />));
      case 'system-health':
        return wrapPanel('SystemHealth', withSuspense(<SystemHealth />));
      case 'watchdog':
        return wrapPanel('WatchdogPanel', withSuspense(<WatchdogPanel />));
      case 'infrastructure':
        return wrapPanel('InfrastructurePanel', withSuspense(<InfrastructurePanel />));
      case 'administration':
        return wrapPanel('AdministrationPanel', withSuspense(<AdministrationPanel />));
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

  const addTab = useCallback((type: 'cui' | 'cui-lite' | 'browser' | 'preview' | 'notes' | 'images' | 'mission' | 'office' | 'admin-wr' | 'linkedin' | 'system-health' | 'bridge-monitor' | 'repo-dashboard' | 'watchdog' | 'infrastructure', config: Record<string, string>, targetId: string) => {
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
      infrastructure: 'Infrastructure',
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
            addTab(val as 'browser' | 'preview' | 'notes' | 'images' | 'mission' | 'office' | 'admin-wr' | 'linkedin' | 'system-health' | 'bridge-monitor' | 'repo-dashboard' | 'watchdog' | 'infrastructure', {}, node.getId());
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
        <option value="office">Virtual Office 👥</option>
        <option value="admin-wr">Werking Report Admin</option>
        <option value="system-health">System Health</option>
        <option value="watchdog">Dev Server Watchdog</option>
        <option value="linkedin">LinkedIn Marketing 🔗</option>
        <option value="bridge-monitor">Bridge Monitor (Old)</option>
        <option value="repo-dashboard">Git & Pipeline Monitor</option>
        <option value="infrastructure">Infrastructure</option>
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

  // CUI state indicators on tabs (stable JSX refs to avoid per-render allocation)
  const processingDot = <span key="dot" style={{ width: 7, height: 7, borderRadius: '50%', background: '#9ece6a', display: 'inline-block', marginRight: 4, flexShrink: 0 }} />;
  const doneDot = <span key="dot" style={{ width: 7, height: 7, borderRadius: '50%', background: '#e0af68', display: 'inline-block', marginRight: 4, flexShrink: 0 }} />;

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

    if (node.getComponent() !== 'cui') return;
    const cuiId = node.getConfig()?.accountId;
    if (!cuiId) return;
    const state = cuiStatesRef.current[cuiId];
    if (state === 'processing') {
      renderValues.leading = processingDot;
    } else if (state === 'done') {
      renderValues.leading = doneDot;
    }
  }, []);

  // Control API: listen for panel/layout commands + report panel state (auto-reconnect)
  useEffect(() => {
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let backoff = 1000; // start at 1s, doubles up to 30s max

    const connect = () => {
      if (disposed) return;
      // Don't hammer WS when server is down — wait for App WS to restore __cuiServerAlive
      if ((window as any).__cuiServerAlive === false) {
        reconnectTimer = setTimeout(connect, Math.min(backoff, 10000));
        return;
      }
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${protocol}://${window.location.host}/ws`);
      ws.onerror = () => {}; // Suppress console noise during server restarts
      controlWsRef.current = ws;

      function reportPanels() {
        if (!model || ws.readyState !== WebSocket.OPEN) return;
        try {
          const panels: Array<{ id: string; component: string; config: Record<string, unknown>; name: string }> = [];
          model.visitNodes((node) => {
            if (node.getType() === 'tab') {
              const tab = node as TabNode;
              panels.push({ id: tab.getId(), component: tab.getComponent() ?? 'unknown', config: tab.getConfig() ?? {}, name: tab.getName() });
            }
          });
          ws.send(JSON.stringify({ type: 'state-report', panels }));
        } catch (err) { console.warn('[LayoutManager] reportPanels failed:', err); }
      }

      ws.onopen = () => {
        backoff = 1000; // reset backoff on successful connection
        console.log('[LayoutManager WS] Connected');
        reportPanels();
      };
      ws.onclose = () => {
        if (controlWsRef.current === ws) controlWsRef.current = null;
        if (!disposed) {
          if (backoff <= 1000) console.log('[LayoutManager WS] Disconnected, reconnecting...');
          reconnectTimer = setTimeout(() => {
            backoff = Math.min(backoff * 2, 30000);
            connect();
          }, backoff);
        }
      };
      ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'control:panel-add' && model) {
          let targetId = '';
          model.visitNodes((node) => { if (!targetId && node.getType() === 'tabset') targetId = node.getId(); });
          if (targetId) {
            try {
              model.doAction(Actions.addNode(
                { type: 'tab', name: msg.name || msg.component, component: msg.component, config: msg.config || {} },
                targetId, DockLocation.CENTER, -1
              ));
              reportPanels();
            } catch (err) { console.warn('[LayoutManager] panel-add doAction failed:', err); }
          }
        }
        if (msg.type === 'control:panel-remove' && msg.nodeId && model) {
          try {
            model.doAction(Actions.deleteTab(msg.nodeId));
            reportPanels();
          } catch (err) { console.warn('[LayoutManager] panel-remove doAction failed:', err); }
        }
        // Close panels when a conversation is finished or deleted via Mission Control
        if ((msg.type === 'control:conversation-finished' || msg.type === 'control:conversation-deleted') && msg.panelsToClose && model) {
          const myPanels = (msg.panelsToClose as Array<{ panelId: string; projectId: string }>)
            .filter(p => p.projectId === projectId);
          for (const p of myPanels) {
            try { model.doAction(Actions.deleteTab(p.panelId)); } catch (err) { console.warn('[LayoutManager] deleteTab failed for panel', p.panelId, ':', err); }
          }
          if (myPanels.length > 0) {
            reportPanels();
            saveLayout(model);
          }
        }
        if (msg.type === 'control:layout-reset') {
          handleResetLayout();
          setTimeout(reportPanels, 200);
        }
        // Select/activate a tab by nodeId or component name (e.g. "admin-wr")
        if (msg.type === 'control:select-tab' && model && msg.target) {
          let foundId = '';
          model.visitNodes((node) => {
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
              model.doAction(Actions.selectTab(foundId));
              ws.send(JSON.stringify({ type: 'tab-selected', nodeId: foundId, target: msg.target }));
            } catch (err) { console.warn('[LayoutManager] select-tab doAction failed:', err); }
          } else {
            ws.send(JSON.stringify({ type: 'tab-select-failed', target: msg.target, error: 'not found' }));
          }
        }
        // Ensure a panel exists and is visible: find by component, add if missing, select if hidden
        if (msg.type === 'control:ensure-panel' && model && msg.component) {
          let foundId = '';
          model.visitNodes((node) => {
            if (foundId) return;
            if (node.getType() === 'tab') {
              const tab = node as TabNode;
              if (tab.getComponent() === msg.component) foundId = tab.getId();
            }
          });
          if (!foundId) {
            // Panel doesn't exist — add it
            let targetId = '';
            model.visitNodes((node) => { if (!targetId && node.getType() === 'tabset') targetId = node.getId(); });
            if (targetId) {
              const nameMap: Record<string, string> = { 'admin-wr': 'Werking Report Admin', 'browser': 'Browser', 'images': 'Images', 'notes': 'Notes' };
              try {
                model.doAction(Actions.addNode(
                  { type: 'tab', name: nameMap[msg.component] || msg.component, component: msg.component, config: msg.config || {} },
                  targetId, DockLocation.CENTER, -1
                ));
              } catch (err) { console.warn('[LayoutManager] ensure-panel addNode failed:', err); }
              // Find the newly added tab
              model.visitNodes((node) => {
                if (node.getType() === 'tab') {
                  const tab = node as TabNode;
                  if (tab.getComponent() === msg.component) foundId = tab.getId();
                }
              });
            }
          }
          if (foundId) {
            try {
              model.doAction(Actions.selectTab(foundId));
            } catch (err) { console.warn('[LayoutManager] ensure-panel selectTab failed:', err); }
            reportPanels();
            ws.send(JSON.stringify({ type: 'panel-ensured', nodeId: foundId, component: msg.component }));
          } else {
            ws.send(JSON.stringify({ type: 'panel-ensure-failed', component: msg.component, error: 'could not add' }));
          }
        }
        // --- Conversation Activation: open CUI panels for selected conversations ---
        if (msg.type === 'control:activate-conversations' && model && msg.plan) {
          const myPlan = (msg.plan as Array<{ projectId: string; conversations: Array<{ sessionId: string; accountId: string }> }>)
            .find(p => p.projectId === projectId);
          if (!myPlan) return;

          // 1. Inventory existing CUI panels (generic, no account binding)
          const existingPanels: string[] = [];
          model.visitNodes((node) => {
            if (node.getType() === 'tab') {
              const tab = node as TabNode;
              if (tab.getComponent() === 'cui' || tab.getComponent() === 'cui-lite') {
                existingPanels.push(tab.getId());
              }
            }
          });

          // 2. Match conversations to available panels (round-robin)
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

          // 3. Create new CUI panels for unmatched conversations (auto-split)
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
            } catch (err) { console.warn('[LayoutManager] activate-conversations addNode failed:', err); continue; }
            tabsetCount++;

            // Find the new node
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

          // 4. Send navigate commands (staggered to avoid iframe race conditions)
          assignments.forEach((a, i) => {
            setTimeout(() => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'navigate-request', panelId: a.panelId, sessionId: a.sessionId, projectId }));
              }
            }, i * 300);
          });

          // Save layout after modifications
          saveLayout(model);
          reportPanels();
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
  }, [model, handleResetLayout]);

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
      onActivationProcessed?.();
    };

    tryProcess();
  }, [pendingActivation, model, projectId, onActivationProcessed, saveLayout]);

  // Report attention state to parent (any CUI tab in 'done' state)
  useEffect(() => {
    if (!model || !onAttentionChange) return;
    let hasAttention = false;
    model.visitNodes((node) => {
      if (node.getType() === 'tab') {
        const tab = node as TabNode;
        if (tab.getComponent() === 'cui') {
          const cuiId = tab.getConfig()?.accountId;
          if (cuiId && cuiStates[cuiId] === 'done') hasAttention = true;
        }
      }
    });
    onAttentionChange(hasAttention);
  }, [model, cuiStates, onAttentionChange]);

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
