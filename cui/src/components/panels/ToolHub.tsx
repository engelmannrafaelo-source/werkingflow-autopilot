import { useState, useEffect, useCallback, Suspense, useRef } from 'react';
import { PANEL_MENU_OPTIONS, PANEL_NAMES } from '../panelRegistry';
import ErrorBoundary from '../ErrorBoundary';
import { useAuth } from '../../contexts/AuthContext';

// --- Lazy panel imports (same as LayoutManager) ---
import ImageDrop from './ImageDrop';
import BrowserPanel from './BrowserPanel';
import FilePreview from './FilePreview';
import NotesPanel from './NotesPanel';
import {
  MissionControl, OfficePanel, KnowledgeFullscreen, WerkingReportAdmin,
  LinkedInPanel, BridgeMonitor, InfisicalMonitor, QADashboard, RepoDashboard,
  SystemHealth, WatchdogPanel, PeerAwarenessPanel, BackgroundOpsPanel,
  ConversationQueuePanel, MaintenancePanel, UserInputAuditPanel,
  ArchitectureExplorer, ReportBuilder, PromptExplorer, BusinessAngelPanel,
  SubSessionPanel, MyTasksPanel, ActivityFeedPanel, PartnerInboxPanel,
  FeedbackPanel, TeamStatusPanel, BusinessDocsPanel, UploadPanel,
} from '../panelRegistry';

const API = '/api';

const PanelLoader = () => (
  <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--tn-text-muted)', fontSize: 11 }}>
    Loading...
  </div>
);

// Tool-specific icons — compact, recognizable
const TOOL_ICONS: Record<string, string> = {
  browser: '🌐', preview: '📄', notes: '📝', images: '🖼️',
  mission: '🎯', 'mission-chat': '💬', 'conversation-queue': '📋',
  'sub-sessions': '🔀', office: '🏢',
  'qa-dashboard': '✅', architecture: '🏗️', knowledge: '📚',
  'report-builder': '📑', 'prompt-explorer': '🧪',
  'system-health': '💚', 'bridge-monitor': '🌉', 'repo-dashboard': '🔧',
  'infisical-monitor': '🔐', watchdog: '🐕', 'peer-awareness': '👁️',
  'admin-wr': '📊', 'business-angel': '😇', 'background-ops': '⏳',
  maintenance: '🔨', 'input-audit': '📥', linkedin: '💼',
  'business-docs': '📂', 'my-tasks': '✏️', 'activity-feed': '📰',
  'partner-inbox': '📬', feedback: '💡', 'team-status': '👥', uploads: '📤',
};

// Short labels for the icon bar (max ~8 chars)
const SHORT_LABELS: Record<string, string> = {
  browser: 'Browser', preview: 'Files', notes: 'Notes', images: 'Images',
  mission: 'Mission', 'mission-chat': 'M-Chat', 'conversation-queue': 'Queue',
  'sub-sessions': 'Subs', office: 'Office',
  'qa-dashboard': 'QA', architecture: 'Arch', knowledge: 'Know',
  'report-builder': 'Report', 'prompt-explorer': 'Prompts',
  'system-health': 'Health', 'bridge-monitor': 'Bridge', 'repo-dashboard': 'Repos',
  'infisical-monitor': 'Secrets', watchdog: 'Watch', 'peer-awareness': 'Peers',
  'admin-wr': 'WR Admin', 'business-angel': 'Angel', 'background-ops': 'BgOps',
  maintenance: 'Maint', 'input-audit': 'Audit', linkedin: 'LinkedIn',
  'business-docs': 'BizDocs', 'my-tasks': 'Tasks', 'activity-feed': 'Feed',
  'partner-inbox': 'Inbox', feedback: 'Fdbk', 'team-status': 'Team', uploads: 'Upload',
};

const EXCLUDED_TOOLS = new Set(['cui', 'cui-lite']);

interface ToolHubProps {
  projectId: string;
  workDir: string;
}

export default function ToolHub({ projectId, workDir }: ToolHubProps) {
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [syncedComponents, setSyncedComponents] = useState<Set<string>>(new Set());
  const loadedRef = useRef(false);
  const { canAccessPanel } = useAuth();

  // Load persisted selection on mount
  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    fetch(`${API}/toolhub/active`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data?.activeTool) setActiveTool(data.activeTool); })
      .catch(() => {});
  }, []);

  // Collect components from layout tree that are synced (have _synced: true config)
  const collectSyncedComponents = (node: any, acc: Set<string>) => {
    if (!node) return;
    if (node.type === 'tab' && node.component && node.config?._synced) {
      acc.add(node.component);
    }
    for (const child of node.children ?? []) collectSyncedComponents(child, acc);
  };

  // Poll the active layout to reflect which tools are currently synced.
  // Also listen for WS layout updates via window events dispatched by parent.
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      fetch(`${API}/layouts/${projectId}`)
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          if (cancelled || !data?.layout) return;
          const synced = new Set<string>();
          collectSyncedComponents(data.layout, synced);
          setSyncedComponents(synced);
        })
        .catch(() => {});
    };
    refresh();
    const onLayoutChanged = () => refresh();
    window.addEventListener('cui-layout-changed', onLayoutChanged);
    const interval = setInterval(refresh, 5000);
    return () => {
      cancelled = true;
      window.removeEventListener('cui-layout-changed', onLayoutChanged);
      clearInterval(interval);
    };
  }, [projectId]);

  // 1-click tool switch + persist
  const selectTool = useCallback((tool: string) => {
    setActiveTool(tool);
    fetch(`${API}/toolhub/active`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activeTool: tool }),
    }).catch(() => {});
  }, []);

  // Toggle sync for a tool: dispatches event to parent LayoutManager (projectId-filtered)
  const toggleSync = useCallback((component: string, displayName: string) => {
    window.dispatchEvent(new CustomEvent('cui-toggle-sync-tool', {
      detail: { component, name: displayName, projectId }
    }));
    // Optimistic update — real state follows after refetch via WS/poll
    setSyncedComponents(prev => {
      const next = new Set(prev);
      if (next.has(component)) next.delete(component);
      else next.add(component);
      return next;
    });
  }, [projectId]);

  // Render the active tool
  const renderTool = () => {
    if (!activeTool) return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--tn-text-muted)', fontSize: 12, textAlign: 'center', padding: 20 }}>
        Tool oben anklicken
      </div>
    );

    const withSuspense = (el: React.ReactNode) => <Suspense fallback={<PanelLoader />}>{el}</Suspense>;

    switch (activeTool) {
      case 'images': return <ImageDrop />;
      case 'browser': return <BrowserPanel initialUrl={undefined} panelId="toolhub-browser" onUrlChange={() => {}} />;
      case 'preview': return <FilePreview watchPath={workDir} stageDir={workDir} />;
      case 'notes': return withSuspense(<NotesPanel projectId={projectId} />);
      case 'mission': return withSuspense(<MissionControl projectId={projectId} workDir={workDir} />);
      case 'office': case 'virtual-office': return withSuspense(<OfficePanel projectId={projectId} workDir={workDir} />);
      case 'knowledge': case 'knowledge-fullscreen': return withSuspense(<KnowledgeFullscreen projectId={projectId} workDir={workDir} />);
      case 'admin-wr': return withSuspense(<WerkingReportAdmin />);
      case 'linkedin': return withSuspense(<LinkedInPanel />);
      case 'qa-dashboard': return withSuspense(<QADashboard />);
      case 'bridge-monitor': return withSuspense(<BridgeMonitor />);
      case 'infisical-monitor': return withSuspense(<InfisicalMonitor />);
      case 'repo-dashboard': return withSuspense(<RepoDashboard />);
      case 'system-health': return withSuspense(<SystemHealth />);
      case 'watchdog': case 'infrastructure': return withSuspense(<WatchdogPanel />);
      case 'background-ops': return withSuspense(<BackgroundOpsPanel />);
      case 'peer-awareness': return withSuspense(<PeerAwarenessPanel />);
      case 'conversation-queue': return withSuspense(<ConversationQueuePanel projectId={projectId} />);
      case 'maintenance': return withSuspense(<MaintenancePanel />);
      case 'input-audit': return withSuspense(<UserInputAuditPanel />);
      case 'architecture': return withSuspense(<ArchitectureExplorer />);
      case 'report-builder': return withSuspense(<ReportBuilder />);
      case 'prompt-explorer': return withSuspense(<PromptExplorer />);
      case 'business-angel': return withSuspense(<BusinessAngelPanel />);
      case 'sub-sessions': return withSuspense(<SubSessionPanel workDir={workDir} isVisible={true} />);
      case 'my-tasks': return withSuspense(<MyTasksPanel />);
      case 'activity-feed': return withSuspense(<ActivityFeedPanel />);
      case 'partner-inbox': return withSuspense(<PartnerInboxPanel projectId={projectId} />);
      case 'feedback': return withSuspense(<FeedbackPanel />);
      case 'team-status': return withSuspense(<TeamStatusPanel />);
      case 'business-docs': return withSuspense(<BusinessDocsPanel />);
      case 'uploads': return withSuspense(<UploadPanel />);
      default: return <div style={{ padding: 20, color: 'var(--tn-text-muted)' }}>Unknown: {activeTool}</div>;
    }
  };

  // Flatten all tools from all categories into a single list, filtered by permissions
  const allTools = PANEL_MENU_OPTIONS
    .flatMap(g => g.items)
    .filter(i => !EXCLUDED_TOOLS.has(i.value) && canAccessPanel(i.value));

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--tn-surface)', overflow: 'hidden' }}>
      {/* Icon bar: all tools, 1-click access */}
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: 2, padding: '4px 4px',
        borderBottom: '1px solid var(--tn-border)', background: 'var(--tn-bg-dark)',
        flexShrink: 0, overflowY: 'auto', maxHeight: 80,
      }}>
        {allTools.map(item => {
          const isActive = activeTool === item.value;
          const isSynced = syncedComponents.has(item.value);
          const displayName = PANEL_NAMES[item.value] || item.label;
          return (
            <div
              key={item.value}
              style={{
                width: 44, height: 34, borderRadius: 4,
                background: isActive ? 'rgba(122, 162, 247, 0.25)' : 'transparent',
                position: 'relative',
                transition: 'background 0.1s',
              }}
            >
              <button
                onClick={() => selectTool(item.value)}
                title={displayName}
                style={{
                  display: 'flex', flexDirection: 'column', alignItems: 'center',
                  justifyContent: 'center', gap: 0,
                  width: '100%', height: '100%', border: 'none', background: 'transparent',
                  cursor: 'pointer',
                  color: isActive ? 'var(--tn-blue)' : 'var(--tn-text-muted)',
                  transition: 'color 0.1s',
                  padding: 0,
                }}
              >
                <span style={{ fontSize: 15, lineHeight: 1 }}>{TOOL_ICONS[item.value] || '•'}</span>
                <span style={{
                  fontSize: 7, lineHeight: 1, marginTop: 1,
                  fontWeight: isActive ? 700 : 400,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  maxWidth: 42,
                }}>
                  {SHORT_LABELS[item.value] || item.label}
                </span>
              </button>
              {/* Pin/sync toggle — top-right corner of each tool button */}
              <span
                onClick={(e) => { e.stopPropagation(); toggleSync(item.value, displayName); }}
                title={isSynced
                  ? 'In allen Workspaces — klicken zum Entfernen'
                  : 'Nur hier — klicken zum Synchronisieren'}
                style={{
                  position: 'absolute', top: 1, right: 1,
                  width: 12, height: 12, borderRadius: 6,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 9, lineHeight: 1, cursor: 'pointer',
                  color: isSynced ? '#fff' : 'var(--tn-text-muted)',
                  background: isSynced ? 'var(--tn-blue, #7aa2f7)' : 'rgba(0,0,0,0.25)',
                  opacity: isSynced ? 1 : 0.55,
                  userSelect: 'none',
                  transition: 'opacity 0.15s, background 0.15s, color 0.15s',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
                onMouseLeave={(e) => { e.currentTarget.style.opacity = isSynced ? '1' : '0.55'; }}
              >
                📌
              </span>
              {isActive && (
                <div style={{
                  position: 'absolute', bottom: 0, left: '20%', right: '20%',
                  height: 2, borderRadius: 1, background: 'var(--tn-blue)',
                  pointerEvents: 'none',
                }} />
              )}
            </div>
          );
        })}
      </div>

      {/* Active tool content */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <ErrorBoundary componentName={`ToolHub:${activeTool || 'empty'}`}>
          {renderTool()}
        </ErrorBoundary>
      </div>
    </div>
  );
}
