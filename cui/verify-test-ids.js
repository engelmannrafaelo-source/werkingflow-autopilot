#!/usr/bin/env node

/**
 * Verify data-ai-id attributes in CUI components
 * Quick smoke test to ensure all test IDs are present in built files
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const distDir = path.join(__dirname, 'dist/assets');
const expectedIds = [
  // RepoDashboard - Main Panel
  'repo-dashboard-panel',
  'repo-dashboard-status-dot',
  'repo-dashboard-tabs',
  'repo-dashboard-refresh-button',

  // RepoDashboard - Repositories Tab
  'repositories-tab',
  'repositories-sort-controls',
  'repositories-table',

  // RepoDashboard - Pipeline Tab
  'pipeline-tab',
  'pipeline-diagram',
  'pipeline-table',

  // RepoDashboard - Disk Usage Tab
  'disk-usage-tab',
  'disk-usage-view-toggle',
  'disk-usage-treemap-container',
  'disk-usage-bars-container',

  // InfisicalMonitor - Main Panel
  'infisical-monitor-panel',
  'infisical-monitor-loading',
  'infisical-monitor-error-state',
  'infisical-monitor-error-message',
  'infisical-monitor-retry-button',
  'infisical-monitor-status-dot',
  'infisical-monitor-refresh-button',

  // InfisicalMonitor - Tabs
  'infisical-monitor-tab-overview',
  'infisical-monitor-tab-projects',
  'infisical-monitor-tab-syncs',
  'infisical-monitor-tab-health',
  'infisical-monitor-tab-settings',

  // InfisicalMonitor - Content Areas (dynamic based on activeTab)
  'infisical-monitor-content-overview',
  'infisical-monitor-content-projects',
  'infisical-monitor-content-syncs',
  'infisical-monitor-content-health',
  'infisical-monitor-content-settings',
];

console.log('🔍 Verifying data-ai-id attributes in CUI components...\n');

// Read all JS files in dist/assets
const jsFiles = fs.readdirSync(distDir)
  .filter(f => f.endsWith('.js') && !f.endsWith('.map'))
  .map(f => path.join(distDir, f));

if (jsFiles.length === 0) {
  console.error('❌ No built JS files found in dist/assets/');
  process.exit(1);
}

// Read concatenated content
const content = jsFiles
  .map(f => fs.readFileSync(f, 'utf8'))
  .join('\n');

let foundCount = 0;
let missingIds = [];

expectedIds.forEach(id => {
  if (content.includes(`data-ai-id="${id}"`)) {
    console.log(`✅ Found: ${id}`);
    foundCount++;
  } else {
    console.log(`❌ Missing: ${id}`);
    missingIds.push(id);
  }
});

console.log(`\n📊 Summary: ${foundCount}/${expectedIds.length} test IDs found`);

if (missingIds.length > 0) {
  console.log(`\n⚠️  Missing IDs (${missingIds.length}):`);
  missingIds.forEach(id => console.log(`   - ${id}`));
  process.exit(1);
} else {
  console.log('\n🎉 All test IDs verified successfully!');
  console.log('✨ CUI components are ready for automated testing');
  console.log('   - RepoDashboard: ✅');
  console.log('   - InfisicalMonitor: ✅');
}
