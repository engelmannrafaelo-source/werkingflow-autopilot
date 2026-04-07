export interface Account {
  id: string;
  label: string;
  color: string;
}

export interface Project {
  id: string;
  name: string;
  workDir: string;
  location: 'remote' | 'local';
  lastOpened: string;
}

export interface PanelConfig {
  type: 'cui' | 'preview' | 'browser';
  accountId?: string;
  url?: string;
  watchPath?: string;
}

export const ACCOUNTS: Account[] = [
  { id: 'engelmann', label: 'Engelmann', color: '#bb9af7' },
  { id: 'office', label: 'Office', color: '#9ece6a' },
  { id: 'gmail', label: 'Gmail', color: '#7aa2f7' },
  { id: 'werking', label: 'Werking', color: '#f7768e' },
  { id: 'local', label: 'Lokal', color: '#e0af68' },
];

export type CuiState = 'idle' | 'processing' | 'done';
export type CuiStates = Record<string, CuiState>;
