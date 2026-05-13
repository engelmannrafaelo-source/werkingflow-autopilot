import { lazy } from 'react';

// ============================================================
// Panel Registry — Single Source of Truth
//
// Neues Panel? NUR HIER eintragen:
//   1. lazy() import in panelLazy.ts (oder hier für ToolHub-Sonderfälle)
//   2. Eintrag in panelConstants.ts (PANEL_NAMES + PANEL_MENU_OPTIONS)
//
// LayoutManager und MobileLayout importieren von hier — kein manueller Sync.
// ToolHub importiert aus panelLazy.ts + panelConstants.ts direkt (kein Cycle).
// ============================================================

// --- Re-export lazy panel components (all except ToolHub) ---
export {
  MissionControl, OfficePanel, KnowledgeFullscreen, WerkingReportAdmin,
  LinkedInPanel, BridgeMonitor, InfisicalMonitor, QADashboard, RepoDashboard,
  WatchdogPanel, BackgroundOpsPanel, ConversationQueuePanel, MaintenancePanel,
  UserInputAuditPanel, ArchitectureExplorer, ReportBuilder, PromptExplorer,
  BusinessAngelPanel, PrivatAngelPanel, BusinessDocsPanel, MyTasksPanel, ActivityFeedPanel,
  PartnerInboxPanel, FeedbackPanel, TeamStatusPanel, UploadPanel,
  CalendarPanel, MailPanel, ErrorMonitor, PartnerServerPanel, SandboxAngelPanel,
  PlatformAdmin,
} from './panelLazy';

// ToolHub is defined here (not in panelLazy) to avoid circular dependency:
// ToolHub imports from panelLazy + panelConstants; panelRegistry exports ToolHub.
export const ToolHub = lazy(() => import('./panels/ToolHub'));

// --- Re-export panel metadata ---
export type { PanelMenuOption, PanelMenuGroup } from './panelConstants';
export { PANEL_NAMES, PANEL_MENU_OPTIONS } from './panelConstants';
