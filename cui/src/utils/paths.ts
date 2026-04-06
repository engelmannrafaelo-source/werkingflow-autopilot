/**
 * Frontend Path Configuration — loaded from server at startup.
 *
 * Provides the same paths as server/config/paths.ts but for the browser.
 * Loaded once via /api/config/paths, then cached.
 *
 * Usage:
 *   import { getPathConfig, shortenPath } from '../../utils/paths';
 *   const config = getPathConfig();
 *   const quickDirs = buildQuickDirs(config);
 */

export interface PathConfig {
  businessDir: string;
  orchestratorDir: string;
  worklistsDir: string;
  personasDir: string;
  projectsRoot: string;
  werkingflowProductionDir: string;
  claudeUserHome: string;
}

// Defaults match the dev-server layout (fallback if API call fails)
const DEFAULT_CONFIG: PathConfig = {
  businessDir: '/root/projekte/werkingflow-business',
  orchestratorDir: '/root/projekte/orchestrator',
  worklistsDir: '/root/projekte/orchestrator/team/worklists',
  personasDir: '/root/projekte/orchestrator/team/personas',
  projectsRoot: '/root/projekte',
  werkingflowProductionDir: '/root/projekte/werkingflow-production',
  claudeUserHome: '/home/claude-user',
};

let _cached: PathConfig | null = null;
let _loading: Promise<PathConfig> | null = null;

/** Load path config from server (cached after first call) */
export async function loadPathConfig(): Promise<PathConfig> {
  if (_cached) return _cached;
  if (_loading) return _loading;

  _loading = fetch('/api/config/paths')
    .then(r => r.ok ? r.json() : DEFAULT_CONFIG)
    .then((config: PathConfig) => {
      _cached = config;
      return config;
    })
    .catch(() => {
      _cached = DEFAULT_CONFIG;
      return DEFAULT_CONFIG;
    });

  return _loading;
}

/** Get cached config synchronously (returns defaults if not yet loaded) */
export function getPathConfig(): PathConfig {
  return _cached ?? DEFAULT_CONFIG;
}

/** Shorten absolute paths for display */
export function shortenPath(absolutePath: string): string {
  const config = getPathConfig();
  return absolutePath
    .replace(config.projectsRoot + '/', '')
    .replace(config.businessDir + '/', 'business/');
}

/** Build QUICK_DIRS array from config */
export function buildQuickDirs(config: PathConfig): Array<{ label: string; path: string; color?: string }> {
  return [
    { label: 'business', path: config.businessDir, color: '#e0af68' },
    { label: 'shared', path: `${config.businessDir}/shared` },
    { label: 'sales', path: `${config.businessDir}/sales` },
    { label: 'finance', path: `${config.businessDir}/finance` },
    { label: 'marketing', path: `${config.businessDir}/marketing` },
    { label: 'customer', path: `${config.businessDir}/customer-success` },
    { label: 'legal', path: `${config.businessDir}/legal` },
    { label: 'foerderung', path: `${config.businessDir}/foerderung` },
    { label: 'team', path: `${config.businessDir}/team` },
    { label: 'products', path: `${config.businessDir}/products` },
    { label: 'reports', path: `${config.businessDir}/reports` },
    { label: 'archive', path: `${config.businessDir}/archive` },
    { label: 'worklists', path: config.worklistsDir, color: '#7aa2f7' },
  ];
}
