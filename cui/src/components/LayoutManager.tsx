import { useCallback, useRef, useState, useEffect } from 'react';
import { Layout, Model, TabNode, TabSetNode, BorderNode, IJsonModel, ITabSetRenderValues, ITabRenderValues, Actions, DockLocation } from 'flexlayout-react';
import type { CuiStates } from '../types';
import CuiPanel from './panels/CuiPanel';
import NativeChat from './panels/NativeChat';
import ImageDrop from './panels/ImageDrop';
import BrowserPanel from './panels/BrowserPanel';
import FilePreview from './panels/FilePreview';
import NotesPanel from './panels/NotesPanel';
import MissionControl from './panels/MissionControl';
import OfficePanel from './panels/OfficePanel';
import WerkingReportAdmin from './panels/WerkingReportAdmin/WerkingReportAdmin';
import LinkedInPanel from './panels/LinkedInPanel';
import BridgeMonitor from './panels/BridgeMonitor/BridgeMonitor';
import SystemHealth from './panels/SystemHealth';
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
    const wrapWithId = (children: React.ReactNode) => (
      <div data-node-id={nodeId} style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
        {children}
      </div>
    );

    switch (component) {
      case 'cui':
        return wrapWithId(<CuiPanel accountId={config.accountId} projectId={projectId} workDir={workDir} panelId={nodeId} isTabVisible={node.isVisible()}
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
        return wrapWithId(<OfficePanel projectId={projectId} workDir={workDir} />);
      case 'admin-wr':
        return wrapWithId(<WerkingReportAdmin />);
      case 'linkedin':
        return wrapWithId(<LinkedInPanel />);
      case 'bridge-monitor':
        return wrapWithId(<BridgeMonitor />);
      case 'system-health':
        return wrapWithId(<SystemHealth />);
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

  const addTab = useCallback((type: 'cui' | 'browser' | 'preview' | 'notes' | 'images' | 'mission' | 'office' | 'admin-wr' | 'linkedin' | 'system-health' | 'bridge-monitor', config: Record<string, string>, targetId: string) => {
    if (!model) return;
    const names: Record<string, string> = {
      cui: config.accountId ? config.accountId.charAt(0).toUpperCase() + config.accountId.slice(1) : 'CUI',
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
          } else {
            addTab(val as 'browser' | 'preview' | 'notes' | 'images' | 'mission' | 'office' | 'admin-wr' | 'linkedin' | 'system-health' | 'bridge-monitor', {}, node.getId());
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
          <option value="cui:rafael">Rafael</option>
          <option value="cui:engelmann">Engelmann</option>
          <option value="cui:office">Office</option>
          <option value="cui:local">Lokal</option>
        </optgroup>
        <option value="browser">Browser</option>
        <option value="preview">File Preview</option>
        <option value="notes">Notes</option>
        <option value="images">Images</option>
        <option value="mission">Mission Control</option>
        <option value="office">Virtual Office 👥</option>
        <option value="admin-wr">Werking Report Admin</option>
        <option value="system-health">System Health</option>
        <option value="linkedin">LinkedIn Marketing 🔗</option>
        <option value="bridge-monitor">Bridge Monitor</option>
      </select>
    );
  }, [addTab]);

  // Force flexlayout to re-render CUI tabs when states change
  // (flexlayout only re-renders tabs when their model node changes)
  useEffect(() => {
    if (!model) return;
    model.visitNodes((node) => {
      if (node.getType() === 'tab') {
        const tab = node as TabNode;
        if (tab.getComponent() === 'cui') {
          const cuiId = tab.getConfig()?.accountId;
          if (!cuiId) return;
          const state = cuiStates[cuiId] || 'idle';
          const currentState = tab.getConfig()?._cuiState;
          if (currentState !== state) {
            model.doAction(Actions.updateNodeAttributes(tab.getId(), {
              config: { ...tab.getConfig(), _cuiState: state },
            }));
          }
        }
      }
    });
  }, [model, cuiStates]);

  // Reset CUI state to idle when user selects a CUI tab
  const handleAction = useCallback((action: any) => {
    if (action.type === 'FlexLayout_SelectTab' && onCuiStateReset && model) {
      const nodeId = action.data?.tabNode;
      if (nodeId) {
        try {
          const node = model.getNodeById(nodeId);
          if (node && (node as TabNode).getComponent?.() === 'cui') {
            const cuiId = (node as TabNode).getConfig?.()?.accountId;
            if (cuiId && cuiStates[cuiId] === 'done') {
              onCuiStateReset(cuiId);
            }
          }
        } catch { /* node might not exist */ }
      }
    }
    return action;
  }, [model, cuiStates, onCuiStateReset]);

  // Color indicators on CUI tabs based on state + show node ID
  const onRenderTab = useCallback((node: TabNode, renderValues: ITabRenderValues) => {
    const nodeId = node.getId();

    // Add node ID badge (visible on hover)
    renderValues.buttons.push(
      <span
        key="node-id"
        title={`Panel ID: ${nodeId}\nClick to copy`}
        onClick={(e) => {
          e.stopPropagation();
          navigator.clipboard.writeText(nodeId);
          // Brief visual feedback
          (e.target as HTMLElement).style.background = 'var(--tn-green)';
          setTimeout(() => {
            (e.target as HTMLElement).style.background = 'var(--tn-bg-dark)';
          }, 200);
        }}
        style={{
          fontSize: 8,
          fontFamily: 'monospace',
          padding: '2px 4px',
          borderRadius: 2,
          background: 'var(--tn-bg-dark)',
          color: 'var(--tn-text-muted)',
          cursor: 'pointer',
          opacity: 0.4,
          transition: 'opacity 0.15s',
          userSelect: 'none',
        }}
        onMouseEnter={(e) => { (e.target as HTMLElement).style.opacity = '1'; }}
        onMouseLeave={(e) => { (e.target as HTMLElement).style.opacity = '0.4'; }}
      >
        #{nodeId}
      </span>
    );

    // CUI state indicators
    if (node.getComponent() !== 'cui') return;
    const cuiId = node.getConfig()?.accountId;
    if (!cuiId) return;
    const state = cuiStates[cuiId];
    if (state === 'processing') {
      renderValues.leading = (
        <span style={{
          width: 7, height: 7, borderRadius: '50%',
          background: '#9ece6a',
          display: 'inline-block', marginRight: 4, flexShrink: 0,
          animation: 'pulse 1.5s ease-in-out infinite',
        }} />
      );
    } else if (state === 'done') {
      renderValues.leading = (
        <span style={{
          width: 7, height: 7, borderRadius: '50%',
          background: '#e0af68',
          display: 'inline-block', marginRight: 4, flexShrink: 0,
        }} />
      );
    }
  }, [cuiStates]);

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

  if (!model) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--tn-text-muted)', fontSize: 12 }}>
        Loading layout...
      </div>
    );
  }

  return (
    <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
      <Layout
        ref={layoutRef}
        model={model}
        factory={factory}
        onModelChange={handleModelChange}
        onAction={handleAction}
        onRenderTabSet={onRenderTabSet}
        onRenderTab={onRenderTab}
      />

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
