import { useCallback, useRef, useState, useEffect, useMemo, Suspense } from 'react';
import { Layout, Model, TabNode, TabSetNode, BorderNode, IJsonModel, ITabSetRenderValues, Actions, DockLocation } from 'flexlayout-react';
import CuiLitePanel from './panels/CuiLitePanel';
import FilePreview from './panels/FilePreview';
import NotesPanel from './panels/NotesPanel';
import BrowserPanel from './panels/BrowserPanel';
import ImageDrop from './panels/ImageDrop';
import ErrorBoundary from './ErrorBoundary';

// --- Heavy panels from Panel Registry (Single Source of Truth) ---
// Neues Panel? panelRegistry.ts editieren, NICHT diese Datei.
import {
  MissionControl, OfficePanel, KnowledgeFullscreen, WerkingReportAdmin,
  LinkedInPanel, BridgeMonitor, InfisicalMonitor, QADashboard, RepoDashboard,
  WatchdogPanel, BackgroundOpsPanel,
  ConversationQueuePanel, MaintenancePanel, UserInputAuditPanel,
  ArchitectureExplorer, ReportBuilder, PromptExplorer, BusinessAngelPanel,
  MyTasksPanel, ActivityFeedPanel, PartnerInboxPanel,
  FeedbackPanel, TeamStatusPanel, BusinessDocsPanel, UploadPanel,
  CalendarPanel, MailPanel,
  PANEL_NAMES, PANEL_MENU_OPTIONS,
} from './panelRegistry';

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
const MOBILE_LAYOUT_VERSION = 5;

function defaultMobileLayout(workDir: string): IJsonModel {
  return {
    global: {
      tabEnableClose: true,
      tabEnablePopout: false,
      tabSetEnableMaximize: true,
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
                { type: 'tab', name: 'Chat', component: 'cui', config: {} },
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

  // Factory — identical to LayoutManager (uses panelRegistry components)
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
        return wrapPanel('Chat', <CuiLitePanel accountId={config.accountId} projectId={projectId} workDir={workDir} panelId={nodeId} isTabVisible={node.isVisible()} />);
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
      case 'office': case 'virtual-office': case 'gmail':
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
      case 'watchdog': case 'infrastructure': case 'system-health':
        return wrapPanel('WatchdogPanel', S(<WatchdogPanel />));
      case 'background-ops':
        return wrapPanel('BackgroundOps', S(<BackgroundOpsPanel />));
      case 'conversation-queue':
        return wrapPanel('ConversationQueue', S(<ConversationQueuePanel projectId={projectId} />));
      case 'maintenance':
        return wrapPanel('MaintenancePanel', S(<MaintenancePanel />));
      case 'input-audit':
        return wrapPanel('UserInputAuditPanel', S(<UserInputAuditPanel />));
      case 'architecture':
        return wrapPanel('ArchitectureExplorer', S(<ArchitectureExplorer />));
      case 'report-builder':
        return wrapPanel('ReportBuilder', S(<ReportBuilder />));
      case 'business-angel':
        return wrapPanel('Business Angel', S(<BusinessAngelPanel />));
      case 'prompt-explorer':
        return wrapPanel('PromptExplorer', S(<PromptExplorer />));
      case 'my-tasks':
        return wrapPanel('MyTasks', S(<MyTasksPanel />));
      case 'activity-feed':
        return wrapPanel('Activity Feed', S(<ActivityFeedPanel />));
      case 'partner-inbox':
        return wrapPanel('Partner Inbox', S(<PartnerInboxPanel projectId={projectId} />));
      case 'feedback':
        return wrapPanel('Feedback', S(<FeedbackPanel />));
      case 'team-status':
        return wrapPanel('Team Status', S(<TeamStatusPanel />));
      case 'business-docs':
        return wrapPanel('Business Docs', S(<BusinessDocsPanel />));
      case 'uploads':
        return wrapPanel('Uploads', S(<UploadPanel />));
      case 'calendar':
        return wrapPanel('Kalender', S(<CalendarPanel />));
      case 'mail':
        return wrapPanel('Mail', S(<MailPanel />));
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

  // Add tab — uses PANEL_NAMES from registry for display names
  const addTab = useCallback((type: string, config: Record<string, string>, targetId: string) => {
    const m = modelRef.current;
    if (!m) return;
    if (type === 'preview' && !config.watchPath) {
      config.watchPath = activeDirRef.current || workDir;
    }
    try {
      m.doAction(Actions.addNode(
        { type: 'tab', name: PANEL_NAMES[type] || type, component: type, config },
        targetId, DockLocation.CENTER, -1
      ));
    } catch { /* ignore */ }
  }, [workDir]);

  // [+] dropdown on each tabset — uses PANEL_MENU_OPTIONS from registry (grouped, same order as desktop)
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
        {PANEL_MENU_OPTIONS.map(({ category, items }) =>
          items.length === 0 ? null : (
            <optgroup key={category} label={category}>
              {items.map(({ value, label }) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </optgroup>
          )
        )}
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
