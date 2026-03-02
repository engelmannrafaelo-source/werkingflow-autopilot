/**
 * TypeScript Interfaces für QA Dashboard
 */

export interface AppStats {
  id: string;
  totalFeatures: number;
  testedFeatures: number;
  coveragePercent: number;
  avgScore: number;
  status: 'tested' | 'partial' | 'failing' | 'untested';
  lastTested: string | null;
  issues: number;
  scores: {
    backend: number | null;
    frontend: number | null;
    visual: number | null;
  };
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

export interface FeatureTest {
  score: number | null;
  tested_at: string;
  commit: string;
  report: string;
  issues: any[];
  manual_verification: any;
}

export interface Feature {
  id: string;
  name: string;
  combinedScore: number | null;
  status: 'tested' | 'partial' | 'failed' | 'untested';
  tests: {
    local?: {
      backend?: FeatureTest;
      frontend?: FeatureTest;
      visual?: FeatureTest;
    };
    deployed?: {
      backend?: FeatureTest;
      frontend?: FeatureTest;
      visual?: FeatureTest;
    };
  };
  issues: any[];
  surfaces: string[];
}

export interface AppDetailData {
  app: string;
  features: Feature[];
  statistics: {
    totalFeatures: number;
    testedCount: number;
    avgScore: number;
    lowestScore: { feature: string; score: number } | null;
    untestedFeatures: string[];
  };
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
  canResume: boolean;
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
  type: string;
  lastRun: string | null;
  status: string;
}

export interface ScenariosData {
  scenarios: Scenario[];
}

export interface ScoreTrend {
  date: string;
  app: string;
  feature: string;
  mode: string;
  score: number;
}

export interface TrendsData {
  trends: ScoreTrend[];
}

export interface ReportData {
  filename: string;
  content: string;
  score: number | null;
  reasoning: string | null;
}
