/**
 * CUI Auth Types — User roles, permissions, and JWT payload.
 */

/** User roles determine panel access and capabilities */
export type UserRole = 'admin' | 'product-owner' | 'fachpartner';

/** Panel component identifiers (must match LayoutManager.tsx case labels) */
export type PanelId =
  | 'cui-lite' | 'cui' | 'chat'
  | 'images' | 'browser' | 'preview' | 'notes'
  | 'mission' | 'mission-chat'
  | 'gmail' | 'virtual-office'
  | 'knowledge' | 'knowledge-fullscreen'
  | 'admin-wr' | 'linkedin'
  | 'qa-dashboard' | 'bridge-monitor' | 'infisical-monitor'
  | 'repo-dashboard' | 'system-health' | 'watchdog' | 'infrastructure'
  | 'background-ops' | 'peer-awareness' | 'conversation-queue'
  | 'maintenance' | 'input-audit' | 'architecture'
  | 'report-builder' | 'prompt-explorer';

/** User configuration stored in users.json */
export interface CuiUser {
  id: string;
  name: string;
  email: string;
  /** bcrypt hash or plain (for dev) — prefix with '$2' = bcrypt, else plain */
  passwordHash: string;
  role: UserRole;
  /** Which Claude account this user maps to (e.g., 'rafael', 'engelmann') */
  claudeAccountId: string;
  /** Allowed panels — '*' means all panels */
  allowedPanels: PanelId[] | '*';
  /** Allowed workspaces (project IDs from data/projects/) — '*' means all */
  allowedWorkspaces: string[] | '*';
  /** Can this user push code to git? */
  canGitPush: boolean;
  /** Can this user approve/reject document edits? */
  canApproveEdits: boolean;
  /** Is this user active? */
  active: boolean;
}

/** JWT payload embedded in the token */
export interface JwtPayload {
  sub: string;        // user ID
  name: string;
  role: UserRole;
  claudeAccountId: string;
  iat: number;        // issued at (epoch seconds)
  exp: number;        // expires at (epoch seconds)
}

/** Users config file structure */
export interface UsersConfig {
  /** Schema version for future migrations */
  version: '1.0';
  users: CuiUser[];
}

/** Authenticated request — Express req with user attached */
export interface AuthenticatedRequest extends Express.Request {
  user?: JwtPayload;
}
