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
export const SystemHealth = lazy(() => import('./panels/SystemHealth'));
export const WatchdogPanel = lazy(() => import('./panels/WatchdogPanel'));
export const PeerAwarenessPanel = lazy(() => import('./panels/PeerAwarenessPanel'));
export const BackgroundOpsPanel = lazy(() => import('./panels/BackgroundOpsPanel'));
export const ConversationQueuePanel = lazy(() => import('./panels/ConversationQueuePanel'));
export const MaintenancePanel = lazy(() => import('./panels/MaintenancePanel/MaintenancePanel'));
export const UserInputAuditPanel = lazy(() => import('./panels/UserInputAuditPanel/UserInputAuditPanel'));
export const ArchitectureExplorer = lazy(() => import('./panels/ArchitectureExplorer/ArchitectureExplorer'));
export const ReportBuilder = lazy(() => import('./panels/ReportBuilder/ReportBuilder'));
export const PromptExplorer = lazy(() => import('./panels/PromptExplorer/PromptExplorer'));
export const BusinessAngelPanel = lazy(() => import('./panels/BusinessAngelPanel'));
export const SubSessionPanel = lazy(() => import('./panels/SubSessionPanel'));

// --- Panel ID → Display Name ---
// Aliases (virtual-office, gmail, knowledge-fullscreen, infrastructure) sind enthalten.
export const PANEL_NAMES: Record<string, string> = {
  cui: 'CUI',
  'cui-lite': 'CUI',
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
  'system-health': 'System Health',
  watchdog: 'Dev Server Watchdog',
  infrastructure: 'Dev Server Watchdog',
  'background-ops': 'Background Ops',
  'peer-awareness': 'Peer Awareness',
  'conversation-queue': 'Conversation Queue',
  maintenance: 'Maintenance',
  'input-audit': 'Input Audit',
  architecture: 'Architecture Explorer',
  'report-builder': 'Report Builder',
  'prompt-explorer': 'Prompt Explorer',
  'business-angel': 'Business Angel',
  'sub-sessions': 'Sub-Sessions',
};

// --- Dropdown-Optionen für den [+] Tab-Picker ---
// Reihenfolge = Anzeigereihenfolge im Dropdown.
export const PANEL_MENU_OPTIONS: { value: string; label: string }[] = [
  { value: 'cui', label: 'CUI' },
  { value: 'browser', label: 'Browser' },
  { value: 'preview', label: 'File Preview' },
  { value: 'notes', label: 'Notes' },
  { value: 'images', label: 'Images' },
  { value: 'mission', label: 'Mission Control' },
  { value: 'mission-chat', label: 'Mission Chat' },
  { value: 'office', label: 'Virtual Office' },
  { value: 'knowledge', label: 'Knowledge' },
  { value: 'qa-dashboard', label: 'QA Dashboard' },
  { value: 'admin-wr', label: 'Werking Report Admin' },
  { value: 'system-health', label: 'System Health' },
  { value: 'watchdog', label: 'Dev Server Watchdog' },
  { value: 'linkedin', label: 'LinkedIn Marketing' },
  { value: 'peer-awareness', label: 'Peer Awareness' },
  { value: 'background-ops', label: 'Background Ops' },
  { value: 'conversation-queue', label: 'Conversation Queue' },
  { value: 'bridge-monitor', label: 'Bridge Monitor' },
  { value: 'repo-dashboard', label: 'Git & Pipeline Monitor' },
  { value: 'infisical-monitor', label: 'Infisical Monitor' },
  { value: 'maintenance', label: 'Maintenance' },
  { value: 'input-audit', label: 'Input Audit' },
  { value: 'architecture', label: 'Architecture Explorer' },
  { value: 'report-builder', label: 'Report Builder' },
  { value: 'prompt-explorer', label: 'Prompt Explorer' },
  { value: 'business-angel', label: 'Business Angel' },
  { value: 'sub-sessions', label: 'Sub-Sessions' },
];
