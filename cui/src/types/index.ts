export interface Account {
  id: string;
  label: string;
  color: string;
}

export interface Project {
  id: string;
  name: string;
  workDir: string;
  location?: 'remote' | 'local';
  lastOpened: string;
}

export interface PanelConfig {
  type: 'cui' | 'preview' | 'browser';
  accountId?: string;
  url?: string;
  watchPath?: string;
}

// Build-time generated from {claudeUserHome}/.claude/accounts/registry.json
// by scripts/generate-accounts.cjs (runs as `prebuild` script). Each
// deployment (dev / partner) bakes in its own real account list at build
// time — no hardcoded names that drift between environments.
import { GENERATED_ACCOUNTS } from './accounts-generated';
export const ACCOUNTS: Account[] = GENERATED_ACCOUNTS;

export type CuiState = 'idle' | 'processing' | 'done';
export type CuiStates = Record<string, CuiState>;
