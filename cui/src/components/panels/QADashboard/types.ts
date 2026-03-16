/**
 * TypeScript Interfaces für QA Dashboard
 * Source of Truth: scenario_registry.json + Pyramid Layer Data
 */

export interface LayerSummary {
  id: number;
  name: string;
  passed: number;
  total: number;
  avgScore: number;
  status: string;
}

export interface AppStats {
  id: string;
  totalScenarios: number;
  testedScenarios: number;
  coveragePercent: number;
  avgScore: number;
  status: 'tested' | 'partial' | 'failing' | 'untested';
  lastTested: string | null;
  issues: number;
  layers?: LayerSummary[];
}

export interface OverviewData {
  apps: AppStats[];
  totals: {
    features: number;
    tested: number;
    coverage: number;
    avgScore: number;
    appsWithIssues: number;
  };
}

export interface ScenarioDetail {
  id: string;
  name: string;
  layer: number;
  layerName: string;
  status: string;
  score: number | null;
  lastRun: string | null;
  reportPath: string | null;
}

export interface AppDetailData {
  appId: string;
  scenarios: ScenarioDetail[];
  statistics: {
    totalScenarios: number;
    testedCount: number;
    avgScore: number;
    untestedScenarios: string[];
  };
  layers: Array<{
    id: number;
    name: string;
    passed: number;
    total: number;
    avgScore: number;
  }>;
}

export interface RunningTest {
  scenario: string;
  pid: number;
  startedAt: string;
  logFile: string;
}

export interface Checkpoint {
  scenario: string;
  savedAt: string | null;
  turnNumber: number;
}

export interface RecentRun {
  file: string;
  persona: string;
  app: string;
  mode: string;
  timestamp: string | null;
  path: string;
}

export interface TestRunsData {
  running: RunningTest[];
  checkpoints: Checkpoint[];
  recentRuns: RecentRun[];
}

export interface Scenario {
  app: string;
  id: string;
  name: string;
  lastRun: string | null;
  status: string;
}

export interface ScenariosData {
  scenarios: Scenario[];
}

export interface ReportData {
  filename: string;
  content: string;
  score: number | null;
  reasoning: string | null;
}
