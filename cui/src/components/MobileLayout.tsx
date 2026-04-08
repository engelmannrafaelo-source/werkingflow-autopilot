import { useCallback, useRef, useState, useEffect, useMemo, lazy, Suspense } from 'react';
import { Layout, Model, TabNode, TabSetNode, BorderNode, IJsonModel, ITabSetRenderValues, Actions, DockLocation } from 'flexlayout-react';
import CuiLitePanel from './panels/CuiLitePanel';
import NativeChat from './panels/NativeChat';
import FilePreview from './panels/FilePreview';
import NotesPanel from './panels/NotesPanel';
import BrowserPanel from './panels/BrowserPanel';
import ImageDrop from './panels/ImageDrop';
import ErrorBoundary from './ErrorBoundary';

// Lazy-loaded heavy panels (same as LayoutManager)
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
const PeerAwarenessPanel = lazy(() => import('./panels/PeerAwarenessPanel'));
const BackgroundOpsPanel = lazy(() => import('./panels/BackgroundOpsPanel'));
const ConversationQueuePanel = lazy(() => import('./panels/ConversationQueuePanel'));
const MaintenancePanel = lazy(() => import('./panels/MaintenancePanel/MaintenancePanel'));
const UserInputAuditPanel = lazy(() => import('./panels/UserInputAuditPanel/UserInputAuditPanel'));

const PanelLoader = () => (
  <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--tn-text-muted)', fontSize: 11 }}>
    Loading...
  </div>
);

interface MobileLayoutProps {
  projectId: string;
  workDir: string;
}

// Mobile: exactly 2 panes (top/bottom), no further splitting allowed
const MOBILE_LAYOUT_VERSION = 3;

function defaultMobileLayout(workDir: string): IJsonModel {
  return {
    global: {
      tabEnableClose: true,
      tabEnablePopout: false,
      tabSetEnableMaximize: false,
      tabSetEnableDrop: true,
      tabSetEnableDrag: true,
      tabSetEnableDivide: false,
      splitterSize: 10,
      tabSetMinWidth: 100,
      tabSetMinHeight: 80,
    },
    borders: [],
    layout: {
      type: 'row',
      weight: 100,
      children: [
        {
          // Inner row — children stack vertically (top/bottom)
          type: 'row',
          weight: 100,
          children: [
            {
              type: 'tabset',
              weight: 60,
              children: [
                { type: 'tab', name: 'CUI', component: 'cui', config: {} },
              ],
            },
            {
              type: 'tabset',
              weight: 40,
              children: [
                { type: 'tab', name: 'Files', component: 'preview', config: { watchPath: workDir } },
                { type: 'tab', name: 'Notes', component: 'notes', config: {} },
              ],
            },
          ],
        },
      ],
    },
  };
}

export default function MobileLayout({ projectId, workDir }: MobileLayoutProps) {
  const [model, setModel] = useState<Model | null>(() => {
    try {
      const vKey = `cui-mobile-layout-v-${projectId}`;
      const cached = localStorage.getItem(`cui-mobile-layout-${projectId}`);
      const ver = parseInt(localStorage.getItem(vKey) || '0', 10);
      if (cached && ver === MOBILE_LAYOUT_VERSION) return Model.fromJson(JSON.parse(cached));
      // Clear stale cache
      localStorage.removeItem(`cui-mobile-layout-${projectId}`);
    } catch { /* ignore */ }
    return null;
  });
  // MUST be before any conditional return — React requires stable hook order
  const [viewMode, setViewMode] = useState<'both' | 'top' | 'bottom'>('both');

  const layoutRef = useRef<Layout>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(null);
  const activeDirRef = useRef(workDir);
  const modelRef = useRef<Model | null>(null);
  modelRef.current = model;

  // Use mobile-specific default layout (always own layout, not desktop)
  useEffect(() => {
    if (model) return;
    try { setModel(Model.fromJson(defaultMobileLayout(workDir))); } catch { /* ignore */ }
  }, [projectId, workDir]);

  // Factory — identical to LayoutManager
  const factory = useCallback((node: TabNode) => {
    const component = node.getComponent();
    const config = node.getConfig() ?? {};
    const nodeId = node.getId();

    const wrapPanel = (name: string, children: React.ReactNode) => (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
        <ErrorBoundary componentName={name}>{children}</ErrorBoundary>
      </div>
    );
    const S = (children: React.ReactNode) => <Suspense fallback={<PanelLoader />}>{children}</Suspense>;

    switch (component) {
      case 'cui': case 'cui-lite':
        return wrapPanel('CUI', <CuiLitePanel accountId={config.accountId} projectId={projectId} workDir={workDir} panelId={nodeId} isTabVisible={node.isVisible()} />);
      case 'preview':
        return wrapPanel('FilePreview', <FilePreview watchPath={config.watchPath || activeDirRef.current || workDir} stageDir={activeDirRef.current} />);
      case 'notes':
        return wrapPanel('NotesPanel', <NotesPanel projectId={projectId} />);
      case 'browser':
        return wrapPanel('BrowserPanel', <BrowserPanel initialUrl={config.url} panelId={nodeId} />);
      case 'images':
        return wrapPanel('ImageDrop', <ImageDrop />);
      case 'mission':
        return wrapPanel('MissionControl', S(<MissionControl projectId={projectId} workDir={workDir} />));
      case 'mission-chat':
        return wrapPanel('MissionChat', <CuiLitePanel accountId={config.accountId || 'rafael'} projectId="mission-chat" workDir="/root/orchestrator/workspaces/mission-chat" panelId={nodeId} isTabVisible={node.isVisible()} />);
      case 'chat': {
        const accountId = config.accountId || 'rafael';
        const PROXY_PORTS: Record<string, number> = { rafael: 5001, engelmann: 5002, office: 5003, local: 5004, gemini: 5005 };
        return wrapPanel('NativeChat', <NativeChat accountId={accountId} proxyPort={PROXY_PORTS[accountId] || 5001} />);
      }
      case 'office': case 'virtual-office':
        return wrapPanel('OfficePanel', S(<OfficePanel projectId={projectId} workDir={workDir} />));
      case 'knowledge': case 'knowledge-fullscreen':
        return wrapPanel('KnowledgeFullscreen', S(<KnowledgeFullscreen projectId={projectId} workDir={workDir} />));
      case 'admin-wr':
        return wrapPanel('WerkingReportAdmin', S(<WerkingReportAdmin />));
      case 'linkedin':
        return wrapPanel('LinkedInPanel', S(<LinkedInPanel />));
      case 'qa-dashboard':
        return wrapPanel('QADashboard', S(<QADashboard />));
      case 'bridge-monitor':
        return wrapPanel('BridgeMonitor', S(<BridgeMonitor />));
      case 'infisical-monitor':
        return wrapPanel('InfisicalMonitor', S(<InfisicalMonitor />));
      case 'repo-dashboard':
        return wrapPanel('RepoDashboard', S(<RepoDashboard />));
      case 'system-health':
        return wrapPanel('SystemHealth', S(<SystemHealth />));
      case 'watchdog': case 'infrastructure':
        return wrapPanel('WatchdogPanel', S(<WatchdogPanel />));
      case 'background-ops':
        return wrapPanel('BackgroundOps', S(<BackgroundOpsPanel />));
      case 'peer-awareness':
        return wrapPanel('PeerAwareness', S(<PeerAwarenessPanel />));
      case 'conversation-queue':
        return wrapPanel('ConversationQueue', S(<ConversationQueuePanel projectId={projectId} />));
      case 'maintenance':
        return wrapPanel('MaintenancePanel', S(<MaintenancePanel />));
      case 'input-audit':
        return wrapPanel('UserInputAuditPanel', S(<UserInputAuditPanel />));
      default:
        return wrapPanel(`Unknown:${component}`, <div style={{ padding: 20, color: 'var(--tn-text-muted)' }}>Unknown: {component}</div>);
    }
  }, [projectId, workDir]);

  // Save layout (local cache only — don't overwrite desktop layout on server)
  const saveLayout = useCallback((m: Model) => {
    const json = m.toJson();
    try {
      localStorage.setItem(`cui-mobile-layout-${projectId}`, JSON.stringify(json));
      localStorage.setItem(`cui-mobile-layout-v-${projectId}`, String(MOBILE_LAYOUT_VERSION));
    } catch { /* ignore */ }
  }, [projectId]);

  const handleModelChange = useCallback((m: Model) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => saveLayout(m), 1500);
  }, [saveLayout]);

  // Add tab — same [+] dropdown as desktop
  const addTab = useCallback((type: string, config: Record<string, string>, targetId: string) => {
    const m = modelRef.current;
    if (!m) return;
    const names: Record<string, string> = {
      cui: 'CUI', 'cui-lite': 'CUI', chat: 'Native Chat', browser: 'Browser', preview: 'Files',
      notes: 'Notes', images: 'Images', mission: 'Mission Control',
      'mission-chat': 'Mission Chat',
      office: 'Virtual Office', 'admin-wr': 'WR Admin', linkedin: 'LinkedIn',
      'system-health': 'System Health', 'bridge-monitor': 'Bridge Monitor',
      'repo-dashboard': 'Git & Pipeline', watchdog: 'Watchdog',
      'background-ops': 'Background Ops', 'conversation-queue': 'Conv Queue',
      maintenance: 'Maintenance', 'input-audit': 'Input Audit',
      'qa-dashboard': 'QA Dashboard', 'peer-awareness': 'Peer Awareness',
      'infisical-monitor': 'Infisical', knowledge: 'Knowledge',
    };
    if (type === 'preview' && !config.watchPath) {
      config.watchPath = activeDirRef.current || workDir;
    }
    try {
      m.doAction(Actions.addNode(
        { type: 'tab', name: names[type] || type, component: type, config },
        targetId, DockLocation.CENTER, -1
      ));
    } catch { /* ignore */ }
  }, [workDir]);

  // [+] dropdown on each tabset — identical to LayoutManager
  const onRenderTabSet = useCallback((node: TabSetNode | BorderNode, renderValues: ITabSetRenderValues) => {
    renderValues.stickyButtons.push(
      <select
        key="add-tab"
        value=""
        onChange={(e) => {
          const val = e.target.value;
          if (!val) return;
          addTab(val, {}, node.getId());
          e.target.value = '';
        }}
        title="Tab hinzufügen"
        style={{
          background: 'none', border: 'none', color: 'var(--tn-text-muted)',
          fontSize: 14, cursor: 'pointer', padding: '0 2px', width: 20,
          appearance: 'none', WebkitAppearance: 'none',
        }}
      >
        <option value="">+</option>
        <option value="cui">CUI</option>
        <option value="chat">Native Chat</option>
        <option value="browser">Browser</option>
        <option value="preview">Files</option>
        <option value="notes">Notes</option>
        <option value="images">Images</option>
        <option value="mission">Mission Control</option>
        <option value="mission-chat">Mission Chat</option>
        <option value="office">Virtual Office</option>
        <option value="knowledge">Knowledge</option>
        <option value="qa-dashboard">QA Dashboard</option>
        <option value="admin-wr">WR Admin</option>
        <option value="system-health">System Health</option>
        <option value="watchdog">Watchdog</option>
        <option value="linkedin">LinkedIn</option>
        <option value="peer-awareness">Peer Awareness</option>
        <option value="background-ops">Background Ops</option>
        <option value="conversation-queue">Conv Queue</option>
        <option value="bridge-monitor">Bridge Monitor</option>
        <option value="repo-dashboard">Git & Pipeline</option>
        <option value="infisical-monitor">Infisical</option>
        <option value="maintenance">Maintenance</option>
        <option value="input-audit">Input Audit</option>
      </select>
    );
  }, [addTab]);

  const layoutElement = useMemo(() => {
    if (!model) return null;
    return (
      <Layout
        ref={layoutRef}
        model={model}
        factory={factory}
        onModelChange={handleModelChange}
        onRenderTabSet={onRenderTabSet}
      />
    );
  }, [model, factory, handleModelChange, onRenderTabSet]);

  if (!model) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--tn-text-muted)', fontSize: 12 }}>
        Loading...
      </div>
    );
  }

  return (
    <div className="mobile-layout">
      <div className="mobile-layout-content" style={viewMode === 'both' ? undefined : { display: 'none' }}>
        {layoutElement}
      </div>
      {viewMode !== 'both' && model && (
        <SinglePaneView model={model} paneIndex={viewMode === 'top' ? 0 : 1} factory={factory} />
      )}
      <div className="mobile-view-toggle">
        <button className={viewMode === 'top' ? 'active' : ''} onClick={() => setViewMode('top')}>▲ Top</button>
        <button className={viewMode === 'both' ? 'active' : ''} onClick={() => setViewMode('both')}>⬛ Both</button>
        <button className={viewMode === 'bottom' ? 'active' : ''} onClick={() => setViewMode('bottom')}>▼ Bottom</button>
      </div>
    </div>
  );
}

// Renders a single pane fullscreen by extracting tabs from the model's nth tabset
function SinglePaneView({ model, paneIndex, factory }: { model: Model; paneIndex: number; factory: (node: TabNode) => React.ReactNode }) {
  const singleModel = useMemo(() => {
    // Collect tabsets from model
    const tabsets: TabSetNode[] = [];
    model.visitNodes((node) => {
      if (node.getType() === 'tabset') tabsets.push(node as TabSetNode);
    });
    const ts = tabsets[paneIndex] || tabsets[0];
    if (!ts) return null;

    // Build a single-tabset layout from the tabs
    const tabs = ts.getChildren().map((child) => {
      const tab = child as TabNode;
      return { type: 'tab' as const, name: tab.getName(), component: tab.getComponent() || 'unknown', config: tab.getConfig() ?? {} };
    });
    if (tabs.length === 0) return null;

    try {
      return Model.fromJson({
        global: {
          tabEnableClose: false,
          tabEnablePopout: false,
          tabSetEnableMaximize: false,
          tabSetEnableDivide: false,
          splitterSize: 0,
        },
        borders: [],
        layout: {
          type: 'row',
          weight: 100,
          children: [{ type: 'tabset', weight: 100, children: tabs }],
        },
      });
    } catch { return null; }
  }, [model, paneIndex]);

  if (!singleModel) return null;
  return (
    <div className="mobile-layout-content">
      <Layout model={singleModel} factory={factory} />
    </div>
  );
}
