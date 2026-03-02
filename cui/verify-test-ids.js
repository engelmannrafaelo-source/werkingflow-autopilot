#!/usr/bin/env node

/**
 * Verify data-ai-id attributes in RepoDashboard components
 * Quick smoke test to ensure all test IDs are present in built files
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const distDir = path.join(__dirname, 'dist/assets');
const expectedIds = [
  // Main Panel
  'repo-dashboard-panel',
  'repo-dashboard-status-dot',
  'repo-dashboard-tabs',
  'repo-dashboard-refresh-button',

  // Repositories Tab
  'repositories-tab',
  'repositories-sort-controls',
  'repositories-table',

  // Pipeline Tab
  'pipeline-tab',
  'pipeline-diagram',
  'pipeline-table',

  // Disk Usage Tab
  'disk-usage-tab',
  'disk-usage-view-toggle',
  'disk-usage-treemap-container',
  'disk-usage-bars-container'
];

console.log('🔍 Verifying data-ai-id attributes in RepoDashboard...\n');

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
  console.log('✨ RepoDashboard is ready for automated testing');
}
