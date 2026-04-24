export interface ServerInfo {
  server: string;
  tailscaleIP: string;
  publicIP: string;
  webUI: string;
  configured: boolean;
  docs: string;
  timestamp: string;
}

export interface Project {
  name: string;
  syncTarget: string;
  environment: string;
}

export interface Sync {
  project: string;
  integration: 'vercel' | 'railway';
  status: 'succeeded' | 'failed' | 'pending';
  lastSync: string;
  autoSync: boolean;
}

export interface HealthStatus {
  status: 'healthy' | 'unhealthy';
  server: string;
  response?: any;
  error?: string;
  timestamp: string;
}

export interface InfisicalData {
  serverInfo: ServerInfo | null;
  projects: Project[];
  syncs: Sync[];
  health: HealthStatus | null;
}
