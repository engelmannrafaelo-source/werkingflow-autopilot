import { lazy } from 'react';

// ============================================================
// Panel Registry — Single Source of Truth
//
// Neues Panel? NUR HIER eintragen:
//   1. lazy() import
//   2. Eintrag in PANEL_NAMES
//   3. Eintrag in PANEL_MENU_OPTIONS (falls im Dropdown sichtbar)
//
// LayoutManager und MobileLayout importieren von hier — kein manueller Sync.
// ============================================================

// --- Lazy panel components ---
export const MissionControl = lazy(() => import('./panels/MissionControl'));
export const OfficePanel = lazy(() => import('./panels/OfficePanel'));
export const KnowledgeFullscreen = lazy(() => import('./panels/KnowledgeFullscreen'));
export const WerkingReportAdmin = lazy(() => import('./panels/WerkingReportAdmin/WerkingReportAdmin'));
export const LinkedInPanel = lazy(() => import('./panels/LinkedInPanel'));
export const BridgeMonitor = lazy(() => import('./panels/BridgeMonitor/BridgeMonitor'));
export const InfisicalMonitor = lazy(() => import('./panels/InfisicalMonitor/InfisicalMonitor'));
export const QADashboard = lazy(() => import('./panels/QADashboard/QADashboard'));
export const RepoDashboard = lazy(() => import('./panels/RepoDashboard/RepoDashboard'));
export const WatchdogPanel = lazy(() => import('./panels/WatchdogPanel'));
export const BackgroundOpsPanel = lazy(() => import('./panels/BackgroundOpsPanel'));
export const ConversationQueuePanel = lazy(() => import('./panels/ConversationQueuePanel'));
export const MaintenancePanel = lazy(() => import('./panels/MaintenancePanel/MaintenancePanel'));
export const UserInputAuditPanel = lazy(() => import('./panels/UserInputAuditPanel/UserInputAuditPanel'));
export const ArchitectureExplorer = lazy(() => import('./panels/ArchitectureExplorer/ArchitectureExplorer'));
export const ReportBuilder = lazy(() => import('./panels/ReportBuilder/ReportBuilder'));
export const PromptExplorer = lazy(() => import('./panels/PromptExplorer/PromptExplorer'));
export const BusinessAngelPanel = lazy(() => import('./panels/BusinessAngelPanel'));
export const BusinessDocsPanel = lazy(() => import('./panels/BusinessDocsPanel'));
export const MyTasksPanel = lazy(() => import('./panels/MyTasksPanel/MyTasksPanel'));
export const ActivityFeedPanel = lazy(() => import('./panels/ActivityFeedPanel'));
export const PartnerInboxPanel = lazy(() => import('./panels/PartnerInboxPanel'));
export const FeedbackPanel = lazy(() => import('./panels/FeedbackPanel'));
export const TeamStatusPanel = lazy(() => import('./panels/TeamStatusPanel'));
export const UploadPanel = lazy(() => import('./panels/UploadPanel'));
export const CalendarPanel = lazy(() => import('./panels/CalendarPanel'));
export const ToolHub = lazy(() => import('./panels/ToolHub'));
export const ErrorMonitor = lazy(() => import('./panels/ErrorMonitor/ErrorMonitor'));
// --- Panel ID → Display Name ---
// Aliases (virtual-office, gmail, knowledge-fullscreen, infrastructure) sind enthalten.
export const PANEL_NAMES: Record<string, string> = {
  cui: 'Chat',
  'cui-lite': 'Chat',
  browser: 'Browser',
  preview: 'File Preview',
  notes: 'Notes',
  images: 'Images',
  mission: 'Mission Control',
  'mission-chat': 'Mission Chat',
  office: 'Virtual Office',
  'virtual-office': 'Virtual Office',
  gmail: 'Virtual Office',
  knowledge: 'Knowledge',
  'knowledge-fullscreen': 'Knowledge',
  'admin-wr': 'Werking Report Admin',
  linkedin: 'LinkedIn Marketing',
  'qa-dashboard': 'QA Dashboard',
  'bridge-monitor': 'Bridge Monitor',
  'infisical-monitor': 'Infisical Monitor',
  'repo-dashboard': 'Git & Pipeline Monitor',
  watchdog: 'Dev Server Watchdog',
  infrastructure: 'Dev Server Watchdog',
  'background-ops': 'Background Ops',
  'conversation-queue': 'Conversation Queue',
  maintenance: 'Maintenance',
  'input-audit': 'Input Audit',
  architecture: 'Architecture Explorer',
  'report-builder': 'Report Builder',
  'prompt-explorer': 'Workflow Explorer',
  'business-angel': 'Business Angel',
  'business-docs': 'Business Docs',
  'my-tasks': 'My Tasks',
  'activity-feed': 'Activity Feed',
  'partner-inbox': 'Partner Inbox',
  feedback: 'Feedback',
  'team-status': 'Team Status',
  'uploads': 'Uploads',
  'calendar': 'Kalender',
  'tool-hub': 'Tool Hub',
  'error-monitor': 'Error Monitor',
};

// --- Dropdown-Optionen für den [+] Tab-Picker (grouped) ---
// Reihenfolge = Anzeigereihenfolge im Dropdown.
export interface PanelMenuOption { value: string; label: string }
export interface PanelMenuGroup { category: string; items: PanelMenuOption[] }

export const PANEL_MENU_OPTIONS: PanelMenuGroup[] = [
  {
    category: 'Workspace',
    items: [
      { value: 'cui', label: 'Chat' },
      { value: 'browser', label: 'Browser' },
      { value: 'preview', label: 'File Preview' },
      { value: 'notes', label: 'Notes' },
      { value: 'images', label: 'Images' },
    ],
  },
  {
    category: 'Übersicht',
    items: [
      { value: 'mission', label: 'Mission Control' },
      { value: 'mission-chat', label: 'Mission Chat' },
      { value: 'conversation-queue', label: 'Conversation Queue' },
      { value: 'office', label: 'Virtual Office' },
    ],
  },
  {
    category: 'Analyse',
    items: [
      { value: 'qa-dashboard', label: 'QA Dashboard' },
      { value: 'architecture', label: 'Architecture Explorer' },
      { value: 'knowledge', label: 'Knowledge' },
      { value: 'report-builder', label: 'Report Builder' },
      { value: 'prompt-explorer', label: 'Workflow Explorer' },
    ],
  },
  {
    category: 'Monitoring',
    items: [
      { value: 'error-monitor', label: 'Error Monitor' },
      { value: 'bridge-monitor', label: 'Bridge Monitor' },
      { value: 'repo-dashboard', label: 'Git & Pipeline Monitor' },
      { value: 'infisical-monitor', label: 'Infisical Monitor' },
      { value: 'watchdog', label: 'Dev Server Watchdog' },
    ],
  },
  {
    category: 'Admin',
    items: [
      { value: 'admin-wr', label: 'Werking Report Admin' },
      { value: 'business-angel', label: 'Business Angel' },
      { value: 'background-ops', label: 'Background Ops' },
      { value: 'maintenance', label: 'Maintenance' },
      { value: 'input-audit', label: 'Input Audit' },
      { value: 'linkedin', label: 'LinkedIn Marketing' },
    ],
  },
  {
    category: 'Partner',
    items: [
      { value: 'business-docs', label: 'Business Docs' },
      { value: 'my-tasks', label: 'My Tasks' },
      { value: 'activity-feed', label: 'Activity Feed' },
      { value: 'partner-inbox', label: 'Partner Inbox' },
      { value: 'feedback', label: 'Feedback' },
      { value: 'team-status', label: 'Team Status' },
      { value: 'uploads', label: 'Uploads' },
      { value: 'calendar', label: 'Kalender' },
    ],
  },
];
