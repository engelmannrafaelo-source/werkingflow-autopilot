#!/usr/bin/env npx tsx
/**
 * Convert Scraped Data to Override Format
 *
 * Reads claude-usage-scraped.json and updates claude-limits-override.json
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const SCRAPED_FILE = join(process.cwd(), 'claude-usage-scraped.json');
const OVERRIDE_FILE = join(process.cwd(), 'claude-limits-override.json');

interface ScrapedData {
  account: string;
  timestamp: string;
  currentSession: {
    percent: number;
    resetIn: string;
  };
  weeklyAllModels: {
    percent: number;
    resetDate: string;
  };
  weeklySonnet: {
    percent: number;
    resetDate: string;
  };
}

interface OverrideData {
  weeklyLimitTokens: number | null;
  currentWeeklyPercent: number;
  currentSessionPercent: number;
  weeklyResetDate: string;
  currentSessionResetDate: string | null;
  lastManualUpdate: string;
}

function main() {
  if (!existsSync(SCRAPED_FILE)) {
    console.error('ERROR: No scraped data found at', SCRAPED_FILE);
    process.exit(1);
  }

  const scraped: ScrapedData[] = JSON.parse(readFileSync(SCRAPED_FILE, 'utf-8'));

  // Load existing overrides (preserve weeklyLimitTokens if set manually)
  let existing: Record<string, OverrideData> = {};
  if (existsSync(OVERRIDE_FILE)) {
    existing = JSON.parse(readFileSync(OVERRIDE_FILE, 'utf-8'));
  }

  const updated: Record<string, OverrideData> = {};

  scraped.forEach((data) => {
    const accountName = data.account.toLowerCase();

    updated[accountName] = {
      // Preserve manually-set weeklyLimitTokens or set to null
      weeklyLimitTokens: existing[accountName]?.weeklyLimitTokens ?? null,
      currentWeeklyPercent: data.weeklyAllModels.percent,
      currentSessionPercent: data.currentSession.percent,
      weeklyResetDate: data.weeklyAllModels.resetDate,
      currentSessionResetDate: data.currentSession.resetIn,
      lastManualUpdate: new Date().toISOString(),
    };
  });

  writeFileSync(OVERRIDE_FILE, JSON.stringify(updated, null, 2), 'utf-8');
  console.log(`✓ Updated ${Object.keys(updated).length} accounts in ${OVERRIDE_FILE}`);
}

main();
