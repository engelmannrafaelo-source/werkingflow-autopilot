/**
 * Centralized Path Configuration — Single Source of Truth for all absolute paths.
 *
 * Every hardcoded path in the CUI codebase should reference this module.
 * On the dev-server, defaults match the existing layout.
 * On the partner-server (or any other deployment), set env vars to override.
 *
 * Usage:
 *   import { PATHS } from '../config/paths.js';
 *   const file = join(PATHS.businessDir, 'shared', 'VISION.md');
 */

import { resolve, join } from 'path';

// CUI root = two levels up from server/config/
const CUI_ROOT = resolve(import.meta.dirname ?? '.', '..', '..');

export const PATHS = {
  // --- CUI Internal ---
  cuiRoot: CUI_ROOT,
  dataDir: process.env.CUI_DATA_DIR || join(CUI_ROOT, 'data'),
  /** Desktop-App-Bundles (mac.zip / windows.zip / linux.AppImage) für Login-Seite. */
  downloadsDir: process.env.CUI_DOWNLOADS_DIR || join(process.env.CUI_DATA_DIR || join(CUI_ROOT, 'data'), '..', 'downloads'),

  // --- Claude User Home (JSONL sessions, .claude config) ---
  claudeUserHome: process.env.CUI_CLAUDE_USER_HOME || '/home/claude-user',

  // --- Business Documents ---
  businessDir: process.env.CUI_BUSINESS_DIR || '/root/projekte/werkingflow-business',

  // --- Orchestrator ---
  orchestratorDir: process.env.CUI_ORCHESTRATOR_DIR || '/root/projekte/orchestrator',
  personasDir: process.env.CUI_PERSONAS_DIR || '/root/projekte/orchestrator/team/personas',
  worklistsDir: process.env.CUI_WORKLISTS_DIR || '/root/projekte/orchestrator/team/worklists',
  knowledgeRegistryPath: process.env.CUI_KNOWLEDGE_REGISTRY || '/root/projekte/orchestrator/team/KNOWLEDGE_REGISTRY.json',

  // --- Projects Root (for display path shortening) ---
  projectsRoot: process.env.CUI_PROJECTS_ROOT || '/root/projekte',

  // --- Werkingflow Monorepo ---
  werkingflowDir: process.env.CUI_WERKINGFLOW_DIR || '/root/projekte/werkingflow',
  werkingflowProductionDir: process.env.CUI_WERKINGFLOW_PRODUCTION_DIR || '/root/projekte/werkingflow-production',

  // --- QA / Testing ---
  unifiedTesterRoot: process.env.CUI_UNIFIED_TESTER_ROOT || '/root/projekte/werkingflow/tests/unified-tester',
  testsRoot: process.env.CUI_TESTS_ROOT || '/root/projekte/werkingflow/tests',
  scenarioRegistry: process.env.CUI_SCENARIO_REGISTRY || '/root/projekte/orchestrator/data/scenario_registry.json',
  archTestResultsDir: process.env.CUI_ARCH_TEST_RESULTS_DIR || '/root/projekte/orchestrator/data/arch-test-results',
  pyramidCacheDir: process.env.CUI_PYRAMID_CACHE_DIR || '/root/projekte/orchestrator/data/pyramid_cache',
  stalenessDir: process.env.CUI_STALENESS_DIR || '/root/projekte/orchestrator/data/staleness',

  // --- Architecture ---
  architectureDir: process.env.CUI_ARCHITECTURE_DIR || '/root/projekte/orchestrator/architecture',
  portsJsonPath: process.env.CUI_PORTS_JSON || '/root/projekte/orchestrator/config/ports.json',

  // --- Team Agents ---
  agentsDir: process.env.CUI_AGENTS_DIR || '/root/projekte/werkingflow/team-agents',
  agentLogsDir: process.env.CUI_AGENT_LOGS_DIR || '/root/projekte/local-storage/backends/team-agents/logs',

  // --- Maintenance ---
  docsMaintenanceBin: process.env.CUI_DOCS_MAINTENANCE_BIN || '/root/projekte/orchestrator/bin/docs-maintenance',
  pipelineCheckBin: process.env.CUI_PIPELINE_CHECK_BIN || '/root/projekte/orchestrator/bin/pipeline-check',

  // --- Infisical ---
  infisicalApiScript: process.env.CUI_INFISICAL_API_SCRIPT || '/root/.infisical/infisical-api.sh',
  infisicalTokenScript: process.env.CUI_INFISICAL_TOKEN_SCRIPT || '/root/.infisical/get-token.py',

  // --- Local Storage ---
  localStorage: process.env.CUI_LOCAL_STORAGE || '/root/projekte/local-storage',
} as const;

// --- Centralized Service URLs (env var, fail-fast if not set) ---
if (!process.env.AI_BRIDGE_URL) {
  throw new Error('AI_BRIDGE_URL env var not set — check Infisical config');
}
export const BRIDGE_URL = process.env.AI_BRIDGE_URL;
export const INFISICAL_BASE_URL = process.env.INFISICAL_URL || 'http://100.79.71.99:80';

/**
 * CUI_APP_HOST — the base URL clients use to reach apps running on this server.
 *
 * Dev-Server:     CUI_APP_HOST=http://100.121.161.109  (Tailscale IP)
 * Partner-Server: CUI_APP_HOST=http://100.119.199.86   (or https://partner.werking.tools)
 *
 * Used by: Browser Panel URLs, Common Notes, Layout configs.
 * Without this, localhost URLs in browser panels won't work for remote clients.
 *
 * NOTE: Getter function because .env is loaded at runtime in index.ts AFTER
 * ESM module evaluation. A const would capture the value too early.
 */
export function getAppHost(): string {
  return process.env.CUI_APP_HOST || 'http://localhost';
}

// --- Derived Helpers ---

/** Shorten an absolute path for display (e.g., /root/projekte/werkingflow/... → werkingflow/...) */
export function shortenPath(absolutePath: string): string {
  return absolutePath
    .replace(PATHS.projectsRoot + '/', '')
    .replace(PATHS.claudeUserHome + '/.claude/', '~/.claude/')
    .replace(PATHS.claudeUserHome + '/', '~/');
}

/** Get the .claude directory for a specific account home */
function claudeDir(accountHome: string): string {
  return join(accountHome, '.claude');
}

/** Get the projects directory for a specific account home */
function claudeProjectsDir(accountHome: string): string {
  return join(accountHome, '.claude', 'projects');
}
