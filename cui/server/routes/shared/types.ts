/**
 * Shared type definitions for CUI server route modules.
 *
 * These types were duplicated across state.ts, mission.ts, autoinject.ts,
 * and proxy.ts. Centralizing them here eliminates drift and ensures
 * a single source of truth.
 */

/** Reason why a conversation requires attention or reached a terminal state. */
export type AttentionReason =
  | 'plan'
  | 'question'
  | 'permission'
  | 'error'
  | 'done'
  | 'rate_limit'
  | 'send_failed';

/** High-level attention state for a conversation. */
export type ConvAttentionState = 'working' | 'needs_attention' | 'idle';

/** Persisted per-session state tracking attention + account ownership. */
export interface SessionState {
  state: ConvAttentionState;
  reason?: AttentionReason;
  since: number;
  accountId: string;
  sessionId?: string;
}

/** Tracks which conversation is visible in which panel. */
export interface PanelVisibility {
  panelId: string;
  projectId: string;
  accountId: string;
  sessionId: string;
  route: string;
  updatedAt: number;
}

/** Definition of a CUI reverse proxy (account -> local port -> target). */
export interface CuiProxy {
  id: string;
  localPort: number;
  target: string;
}
