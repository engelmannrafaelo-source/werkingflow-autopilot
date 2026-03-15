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
  | 'send_failed'
  | 'context_overflow';

/** High-level attention state for a conversation. */
export type ConvAttentionState = 'working' | 'needs_attention' | 'idle';

/** Info about the currently executing tool (present only during tool execution). */
export interface ToolExecutionInfo {
  /** Tool name: Bash, Read, Write, Grep, Glob, Edit, WebSearch, etc. */
  toolName: string;
  /** Short description of what the tool is doing. */
  toolDetail?: string;
  /** Timestamp when tool execution started. */
  startedAt: number;
}

/** Persisted per-session state tracking attention + account ownership. */
export interface SessionState {
  state: ConvAttentionState;
  reason?: AttentionReason;
  since: number;
  accountId: string;
  sessionId?: string;
  /** Present when state='working' and a tool is actively executing. */
  toolInfo?: ToolExecutionInfo;
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
