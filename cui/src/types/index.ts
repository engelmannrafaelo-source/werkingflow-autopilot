export interface Account {
  id: string;
  label: string;
  port: number;
  host: string;
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

// Proxy ports on the CUI workspace server (all localhost on the dev server)
// Rafael/Engelmann/Office: :5001-5003 → :4001-4003
// Lokal: :5004 → :4004
export const ACCOUNTS: Account[] = [
  { id: 'rafael', label: 'Rafael', port: 5001, host: '', color: '#7aa2f7' },
  { id: 'engelmann', label: 'Engelmann', port: 5002, host: '', color: '#bb9af7' },
  { id: 'office', label: 'Office', port: 5003, host: '', color: '#9ece6a' },
  { id: 'local', label: 'Lokal', port: 5004, host: '', color: '#e0af68' },
];

export function getCuiUrl(account: Account): string {
  const host = account.host || window.location.hostname;
  return `http://${host}:${account.port}`;
}

export type CuiState = 'idle' | 'processing' | 'done';
export type CuiStates = Record<string, CuiState>;
