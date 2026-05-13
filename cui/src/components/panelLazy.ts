import { lazy } from 'react';

// All panel lazy imports except ToolHub — extracted to break the circular dependency
// panelRegistry imports from here; ToolHub imports from here too (not from panelRegistry).

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
export const PrivatAngelPanel = lazy(() => import('./panels/PrivatAngelPanel'));
export const BusinessDocsPanel = lazy(() => import('./panels/BusinessDocsPanel'));
export const MyTasksPanel = lazy(() => import('./panels/MyTasksPanel/MyTasksPanel'));
export const ActivityFeedPanel = lazy(() => import('./panels/ActivityFeedPanel'));
export const PartnerInboxPanel = lazy(() => import('./panels/PartnerInboxPanel'));
export const FeedbackPanel = lazy(() => import('./panels/FeedbackPanel'));
export const TeamStatusPanel = lazy(() => import('./panels/TeamStatusPanel'));
export const UploadPanel = lazy(() => import('./panels/UploadPanel'));
export const CalendarPanel = lazy(() => import('./panels/CalendarPanel'));
export const MailPanel = lazy(() => import('./panels/MailPanel'));
export const ErrorMonitor = lazy(() => import('./panels/ErrorMonitor/ErrorMonitor'));
export const PartnerServerPanel = lazy(() => import('./panels/PartnerServerPanel'));
export const SandboxAngelPanel = lazy(() => import('./panels/SandboxAngelPanel'));
export const PlatformAdmin = lazy(() => import('./panels/PlatformAdmin/PlatformAdmin'));
