import { useCallback, useRef, useState, useEffect, useMemo } from 'react';
import { Layout, Model, TabNode, TabSetNode, BorderNode, IJsonModel, ITabSetRenderValues, ITabRenderValues, Actions, DockLocation, Rect } from 'flexlayout-react';
import type { CuiStates } from '../types';
import { copyToClipboard } from '../utils/clipboard';

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
import CuiPanel from './panels/CuiPanel';
import CuiLitePanel from './panels/CuiLitePanel';
import NativeChat from './panels/NativeChat';
import ImageDrop from './panels/ImageDrop';
import BrowserPanel from './panels/BrowserPanel';
import FilePreview from './panels/FilePreview';
import NotesPanel from './panels/NotesPanel';
import MissionControl from './panels/MissionControl';
import OfficePanel from './panels/OfficePanel';
import ErrorBoundary from './ErrorBoundary';
import WerkingReportAdmin from './panels/WerkingReportAdmin/WerkingReportAdmin';
import LinkedInPanel from './panels/LinkedInPanel';
import BridgeMonitor from './panels/BridgeMonitor/BridgeMonitor';
import AttributionDashboard from './panels/AttributionDashboard';
import SystemHealth from './panels/SystemHealth';
import WatchdogPanel from './panels/WatchdogPanel';
import PanelConnectivityGuard from './panels/PanelConnectivityGuard';
import LayoutBuilder from './LayoutBuilder';
import '../styles/office.css';

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
                  name: 'Rafael',
                  component: 'cui',
                  config: { accountId: 'rafael' },
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
                  name: 'Engelmann',
                  component: 'cui',
                  config: { accountId: 'engelmann' },
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
  const [model, setModel] = useState<Model | null>(null);
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

  // Load layout + template + ACTIVE folder from server, fall back to default
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch(`${API}/layouts/${projectId}`).then((r) => r.json()).catch(() => null),
      fetch(`${API}/layouts/${projectId}/template`).then((r) => r.json()).catch(() => null),
      fetch(`${API}/active-dir/${projectId}`).then((r) => r.json()).catch(() => null),
    ]).then(([layoutJson, tplJson, activeDir]) => {
      if (cancelled) return;
      if (activeDir?.path) activeDirRef.current = activeDir.path;
      if (tplJson) templateRef.current = tplJson;
      if (layoutJson) {
        try {
          setModel(Model.fromJson(layoutJson));
          return;
        } catch {
          // Corrupted layout, fall through
        }
      }
      setModel(Model.fromJson(defaultLayout(activeDirRef.current)));
    });
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
    } catch {}
  }, []);

  const factory = useCallback((node: TabNode) => {
    const component = node.getComponent();
    const config = node.getConfig() ?? {};
    const nodeId = node.getId();

    // Wrapper with data-node-id for screenshot targeting
    // contain: strict limits layout recalculation scope when flexlayout measures via getBoundingClientRect
    const cleanNodeId = nodeId.replace(/^#/, '');
    const wrapWithId = (children: React.ReactNode) => (
      <div data-node-id={cleanNodeId} style={{ height: '100%', display: 'flex', flexDirection: 'column', contain: 'strict' }}>
        {children}
      </div>
    );

    switch (component) {
      case 'cui':
        return wrapWithId(<CuiPanel accountId={config.accountId} projectId={projectId} workDir={workDir} panelId={nodeId} isTabVisible={node.isVisible()}
          onRouteChange={(route) => updateNodeConfig(nodeId, { _route: route })} />);
      case 'cui-lite':
        return wrapWithId(<CuiLitePanel accountId={config.accountId} projectId={projectId} workDir={workDir} panelId={nodeId} isTabVisible={node.isVisible()}
          onRouteChange={(route) => updateNodeConfig(nodeId, { _route: route })} />);
      case 'chat': {
        const accountId = config.accountId || 'rafael';
        const PROXY_PORTS: Record<string, number> = {
          rafael: 5001,
          engelmann: 5002,
          office: 5003,
          local: 5004
        };
        return wrapWithId(<NativeChat accountId={accountId} proxyPort={PROXY_PORTS[accountId] || 5001} />);
      }
      case 'images':
        return wrapWithId(<ImageDrop />);
      case 'browser':
        return wrapWithId(<BrowserPanel initialUrl={config.url} panelId={nodeId}
          onUrlChange={(url) => updateNodeConfig(nodeId, { url })} />);
      case 'preview':
        return wrapWithId(<FilePreview watchPath={config.watchPath || activeDirRef.current || workDir} stageDir={activeDirRef.current} />);
      case 'notes':
        return wrapWithId(<NotesPanel projectId={projectId} />);
      case 'mission':
        return wrapWithId(<MissionControl projectId={config.projectId || projectId} workDir={config.workDir || workDir} />);
      case 'office':
      case 'virtual-office':
        return wrapWithId(
          <ErrorBoundary>
            <OfficePanel projectId={projectId} workDir={workDir} />
          </ErrorBoundary>
        );
      case 'admin-wr':
        return wrapWithId(<WerkingReportAdmin />);
      case 'linkedin':
        return wrapWithId(
          <PanelConnectivityGuard
            panelName="Platform"
            checkUrl="http://localhost:3004/api/version"
            port={3004}
            startCommand="cd /root/projekte/werkingflow/platform && npm run build:local"
          >
            <LinkedInPanel />
          </PanelConnectivityGuard>
        );
      case 'bridge-monitor':
        return wrapWithId(
          <PanelConnectivityGuard
            panelName="Bridge"
            checkUrl="http://localhost:8000/health"
            port={8000}
            startCommand="# Bridge runs on Hetzner - check server status"
          >
            <BridgeMonitor />
          </PanelConnectivityGuard>
        );
      case 'attribution-dashboard':
        return wrapWithId(
          <PanelConnectivityGuard
            panelName="Dashboard"
            checkUrl="http://localhost:3333/api/version"
            port={3333}
            startCommand="cd /root/projekte/werkingflow/dashboard && python3 -m dashboard.app"
          >
            <AttributionDashboard />
          </PanelConnectivityGuard>
        );
      case 'system-health':
        return wrapWithId(<SystemHealth />);
      case 'watchdog':
        return wrapWithId(<WatchdogPanel />);
      default:
        return wrapWithId(
          <div style={{ padding: 20, color: 'var(--tn-text-muted)' }}>
            Unknown panel: {component}
          </div>
        );
    }
  }, [projectId, workDir]);

  const saveLayout = useCallback((m: Model) => {
    fetch(`${API}/layouts/${projectId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(m.toJson()),
    }).catch(() => {});
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
    fetch(`${API}/layouts/${projectId}/template`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tpl),
    }).catch(() => {});
  }, [projectId]);

  const handleApplyLayout = useCallback((layoutJson: IJsonModel) => {
    const newModel = Model.fromJson(layoutJson);
    setModel(newModel);
    setShowBuilder(false);
    saveLayout(newModel);
    saveTemplate(layoutJson);
  }, [saveLayout, saveTemplate]);

  const handleResetLayout = useCallback(() => {
    const tpl = templateRef.current ?? defaultLayout(workDir);
    const newModel = Model.fromJson(tpl);
    setModel(newModel);
    saveLayout(newModel);
  }, [workDir, saveLayout]);

  const addTab = useCallback((type: 'cui' | 'cui-lite' | 'browser' | 'preview' | 'notes' | 'images' | 'mission' | 'office' | 'admin-wr' | 'linkedin' | 'system-health' | 'bridge-monitor' | 'attribution-dashboard' | 'watchdog', config: Record<string, string>, targetId: string) => {
    if (!model) return;
    const names: Record<string, string> = {
      cui: config.accountId ? config.accountId.charAt(0).toUpperCase() + config.accountId.slice(1) : 'CUI',
      'cui-lite': config.accountId ? config.accountId.charAt(0).toUpperCase() + config.accountId.slice(1) + ' Lite' : 'CUI Lite',
      browser: 'Browser',
      preview: 'File Preview',
      notes: 'Notes',
      images: 'Images',
      mission: 'Mission Control',
      office: 'Virtual Office',
      'admin-wr': 'Werking Report Admin',
      linkedin: 'LinkedIn Marketing 🔗',
      'system-health': 'System Health',
      'bridge-monitor': 'Bridge Monitor',
      'attribution-dashboard': 'Attribution Dashboard 📊',
      watchdog: 'Dev Server Watchdog',
    };
    if (type === 'preview' && !config.watchPath) {
      config.watchPath = activeDirRef.current || workDir;
    }
    model.doAction(
      Actions.addNode(
        { type: 'tab', name: names[type], component: type, config },
        targetId,
        DockLocation.CENTER,
        -1
      )
    );
  }, [model, workDir]);

  const onRenderTabSet = useCallback((node: TabSetNode | BorderNode, renderValues: ITabSetRenderValues) => {
    renderValues.stickyButtons.push(
      <select
        key="add-tab"
        value=""
        onChange={(e) => {
          const val = e.target.value;
          if (!val) return;
          if (val.startsWith('cui:')) {
            addTab('cui', { accountId: val.split(':')[1] }, node.getId());
          } else if (val.startsWith('lite:')) {
            addTab('cui-lite', { accountId: val.split(':')[1] }, node.getId());
          } else {
            addTab(val as 'browser' | 'preview' | 'notes' | 'images' | 'mission' | 'office' | 'admin-wr' | 'linkedin' | 'system-health' | 'bridge-monitor' | 'attribution-dashboard' | 'watchdog', {}, node.getId());
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
        <optgroup label="CUI">
          <option value="lite:rafael">Rafael</option>
          <option value="lite:engelmann">Engelmann</option>
          <option value="lite:office">Office</option>
        </optgroup>
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
        <option value="attribution-dashboard">Attribution Dashboard 📊</option>
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
    if (action.type === 'FlexLayout_SelectTab' && model) {
      const nodeId = action.data?.tabNode;
      if (nodeId) {
        try {
          const node = model.getNodeById(nodeId);
          if (node && (node as TabNode).getComponent?.() === 'cui') {
            const cuiId = (node as TabNode).getConfig?.()?.accountId;
            if (cuiId && cuiStatesRef.current[cuiId] === 'done') {
              onCuiStateResetRef.current?.(cuiId);
            }
          }
        } catch { /* node might not exist */ }
      }
    }
    return action;
  }, [model]);

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

  // Control API: listen for panel/layout commands + report panel state
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${protocol}://${window.location.host}/ws`);
    controlWsRef.current = ws;

    function reportPanels() {
      if (!model || ws.readyState !== WebSocket.OPEN) return;
      const panels: Array<{ id: string; component: string; config: Record<string, unknown>; name: string }> = [];
      model.visitNodes((node) => {
        if (node.getType() === 'tab') {
          const tab = node as TabNode;
          panels.push({ id: tab.getId(), component: tab.getComponent() ?? 'unknown', config: tab.getConfig() ?? {}, name: tab.getName() });
        }
      });
      ws.send(JSON.stringify({ type: 'state-report', panels }));
    }

    ws.onopen = reportPanels;
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'control:panel-add' && model) {
          let targetId = '';
          model.visitNodes((node) => { if (!targetId && node.getType() === 'tabset') targetId = node.getId(); });
          if (targetId) {
            model.doAction(Actions.addNode(
              { type: 'tab', name: msg.name || msg.component, component: msg.component, config: msg.config || {} },
              targetId, DockLocation.CENTER, -1
            ));
            reportPanels();
          }
        }
        if (msg.type === 'control:panel-remove' && msg.nodeId && model) {
          model.doAction(Actions.deleteTab(msg.nodeId));
          reportPanels();
        }
        // Close panels when a conversation is finished or deleted via Mission Control
        if ((msg.type === 'control:conversation-finished' || msg.type === 'control:conversation-deleted') && msg.panelsToClose && model) {
          const myPanels = (msg.panelsToClose as Array<{ panelId: string; projectId: string }>)
            .filter(p => p.projectId === projectId);
          for (const p of myPanels) {
            try { model.doAction(Actions.deleteTab(p.panelId)); } catch {}
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
            model.doAction(Actions.selectTab(foundId));
            ws.send(JSON.stringify({ type: 'tab-selected', nodeId: foundId, target: msg.target }));
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
              model.doAction(Actions.addNode(
                { type: 'tab', name: nameMap[msg.component] || msg.component, component: msg.component, config: msg.config || {} },
                targetId, DockLocation.CENTER, -1
              ));
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
            model.doAction(Actions.selectTab(foundId));
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

          // 1. Inventory existing CUI panels
          const existingPanels: Array<{ nodeId: string; accountId: string }> = [];
          model.visitNodes((node) => {
            if (node.getType() === 'tab') {
              const tab = node as TabNode;
              if (tab.getComponent() === 'cui') {
                existingPanels.push({ nodeId: tab.getId(), accountId: tab.getConfig()?.accountId || '' });
              }
            }
          });

          // 2. Match conversations to existing panels (same accountId first)
          const assignments: Array<{ panelId: string; sessionId: string }> = [];
          const usedPanels = new Set<string>();
          const unmatched: Array<{ sessionId: string; accountId: string }> = [];

          for (const conv of myPlan.conversations) {
            const panel = existingPanels.find(p => p.accountId === conv.accountId && !usedPanels.has(p.nodeId));
            if (panel) {
              assignments.push({ panelId: panel.nodeId, sessionId: conv.sessionId });
              usedPanels.add(panel.nodeId);
            } else {
              unmatched.push(conv);
            }
          }

          // 3. Create new CUI panels for unmatched conversations (auto-split)
          let tabsetCount = 0;
          model.visitNodes((node) => { if (node.getType() === 'tabset') tabsetCount++; });

          for (const conv of unmatched) {
            // Find tabset with fewest children
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

            const tabName = conv.accountId.charAt(0).toUpperCase() + conv.accountId.slice(1);
            const dockLocation = tabsetCount < 6
              ? (tabsetCount % 2 === 0 ? DockLocation.RIGHT : DockLocation.BOTTOM)
              : DockLocation.CENTER;

            model.doAction(Actions.addNode(
              { type: 'tab', name: tabName, component: 'cui', config: { accountId: conv.accountId } },
              targetId, dockLocation, -1
            ));
            tabsetCount++;

            // Find the new node (last CUI tab with this accountId that isn't already assigned)
            let newPanelId = '';
            model.visitNodes((node) => {
              if (node.getType() === 'tab') {
                const tab = node as TabNode;
                if (tab.getComponent() === 'cui' && tab.getConfig()?.accountId === conv.accountId
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
      } catch { /* ignore */ }
    };

    return () => { controlWsRef.current = null; ws.close(); };
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

      // Same logic as the WS handler: inventory, match, split, navigate
      const existingPanels: Array<{ nodeId: string; accountId: string }> = [];
      model.visitNodes((node) => {
        if (node.getType() === 'tab') {
          const tab = node as TabNode;
          if (tab.getComponent() === 'cui') {
            existingPanels.push({ nodeId: tab.getId(), accountId: tab.getConfig()?.accountId || '' });
          }
        }
      });

      const assignments: Array<{ panelId: string; sessionId: string }> = [];
      const usedPanels = new Set<string>();
      const unmatched: Array<{ sessionId: string; accountId: string }> = [];

      for (const conv of myPlan.conversations) {
        const panel = existingPanels.find(p => p.accountId === conv.accountId && !usedPanels.has(p.nodeId));
        if (panel) {
          assignments.push({ panelId: panel.nodeId, sessionId: conv.sessionId });
          usedPanels.add(panel.nodeId);
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

        const tabName = conv.accountId.charAt(0).toUpperCase() + conv.accountId.slice(1);
        const dockLocation = tabsetCount < 6
          ? (tabsetCount % 2 === 0 ? DockLocation.RIGHT : DockLocation.BOTTOM)
          : DockLocation.CENTER;

        model.doAction(Actions.addNode(
          { type: 'tab', name: tabName, component: 'cui', config: { accountId: conv.accountId } },
          targetId, dockLocation, -1
        ));
        tabsetCount++;

        let newPanelId = '';
        model.visitNodes((node) => {
          if (node.getType() === 'tab') {
            const tab = node as TabNode;
            if (tab.getComponent() === 'cui' && tab.getConfig()?.accountId === conv.accountId
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
        <LayoutBuilder
          workDir={workDir}
          onApply={handleApplyLayout}
          onClose={() => setShowBuilder(false)}
        />
      )}
    </div>
  );
}
