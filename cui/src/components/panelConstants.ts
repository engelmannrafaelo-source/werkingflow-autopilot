// Panel metadata — separated from lazy imports to avoid circular dependencies with ToolHub.
// ToolHub imports from here; panelRegistry re-exports from here.

export interface PanelMenuOption { value: string; label: string }
export interface PanelMenuGroup { category: string; items: PanelMenuOption[] }

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
  'mail': 'Mail',
  'tool-hub': 'Tool Hub',
  'error-monitor': 'Error Monitor',
};

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
      { value: 'mail', label: 'Mail' },
    ],
  },
];
