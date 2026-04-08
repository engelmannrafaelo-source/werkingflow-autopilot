# RepoDashboard Testing Environment

## Overview
The Git & Pipeline Monitor (RepoDashboard) panel now has comprehensive `data-ai-id` attributes for AI-driven automated testing, following the same pattern used in BridgeMonitor.

## Testing Architecture

### data-ai-id Attributes Added

All interactive and key elements now have unique `data-ai-id` attributes for test targeting:

#### Main Panel (RepoDashboard.tsx)
- `repo-dashboard-panel` - Root panel container
- `repo-dashboard-status-dot` - Health status indicator (green = clean, yellow = dirty repos)
- `repo-dashboard-quick-stats` - Quick stats badges container
- `repo-dashboard-dirty-repos-badge` - Badge showing uncommitted changes count
- `repo-dashboard-total-repos-badge` - Total repositories count
- `repo-dashboard-total-size-badge` - Total disk usage
- `repo-dashboard-refresh-button` - Manual refresh button
- `repo-dashboard-tabs` - Tab navigation container
- `repo-dashboard-tab-repos` - Repositories tab button
- `repo-dashboard-tab-pipeline` - Pipeline tab button
- `repo-dashboard-tab-disk` - Disk Usage tab button
- `repo-dashboard-content-{activeTab}` - Active tab content area

#### Repositories Tab (RepositoriesTab.tsx)
- `repositories-tab` - Tab root container
- `repositories-sort-controls` - Sort buttons container
- `repositories-sort-size` - Sort by size button
- `repositories-sort-name` - Sort by name button
- `repositories-sort-modified` - Sort by last modified button
- `repositories-table-container` - Table wrapper
- `repositories-table` - Main data table
- `repositories-table-body` - Table body
- `repo-row-{repoName}` - Individual repository row (dynamic)
- `repositories-legend` - Color legend and summary
- `repositories-color-legend` - Age-based color legend

#### Pipeline Tab (PipelineTab.tsx)
- `pipeline-tab` - Tab root container
- `pipeline-diagram` - Pipeline flow diagram
- `pipeline-table-container` - App status table wrapper
- `pipeline-table` - Main pipeline table
- `pipeline-table-body` - Table body
- `pipeline-row-{appName}` - Individual app pipeline row (dynamic)
- `pipeline-legend` - Status legend

#### Disk Usage Tab (DiskUsageTab.tsx)
- `disk-usage-tab` - Tab root container
- `disk-usage-summary` - Summary stats and view toggle
- `disk-usage-view-toggle` - View mode toggle buttons
- `disk-usage-view-treemap` - Treemap view button
- `disk-usage-view-bars` - Bars view button
- `disk-usage-treemap-container` - Treemap visualization container
- `disk-usage-treemap` - Treemap chart element
- `disk-usage-treemap-legend` - Treemap color legend
- `disk-usage-color-legend` - Age-based colors
- `disk-usage-bars-container` - Bar chart container
- `disk-usage-bar-{folderName}` - Individual folder bar (dynamic)

## Test Scenarios

### 1. Panel Loading & Basic Interaction
```typescript
// Verify panel loads
await page.locator('[data-ai-id="repo-dashboard-panel"]').waitFor();

// Check status dot color
const statusDot = page.locator('[data-ai-id="repo-dashboard-status-dot"]');
await expect(statusDot).toHaveCSS('background', /green|yellow/);

// Verify quick stats badges appear
await expect(page.locator('[data-ai-id="repo-dashboard-total-repos-badge"]')).toBeVisible();
```

### 2. Tab Navigation
```typescript
// Click Repositories tab
await page.locator('[data-ai-id="repo-dashboard-tab-repos"]').click();
await expect(page.locator('[data-ai-id="repositories-tab"]')).toBeVisible();

// Click Pipeline tab
await page.locator('[data-ai-id="repo-dashboard-tab-pipeline"]').click();
await expect(page.locator('[data-ai-id="pipeline-tab"]')).toBeVisible();

// Click Disk Usage tab
await page.locator('[data-ai-id="repo-dashboard-tab-disk"]').click();
await expect(page.locator('[data-ai-id="disk-usage-tab"]')).toBeVisible();
```

### 3. Repositories Tab - Sorting
```typescript
// Sort by size (default)
await page.locator('[data-ai-id="repositories-sort-size"]').click();

// Sort by name
await page.locator('[data-ai-id="repositories-sort-name"]').click();

// Sort by last modified
await page.locator('[data-ai-id="repositories-sort-modified"]').click();

// Verify table updates
const firstRepo = page.locator('[data-ai-id^="repo-row-"]').first();
await expect(firstRepo).toBeVisible();
```

### 4. Disk Usage Tab - View Toggle
```typescript
// Switch to Treemap view
await page.locator('[data-ai-id="disk-usage-view-treemap"]').click();
await expect(page.locator('[data-ai-id="disk-usage-treemap-container"]')).toBeVisible();

// Switch to Bars view
await page.locator('[data-ai-id="disk-usage-view-bars"]').click();
await expect(page.locator('[data-ai-id="disk-usage-bars-container"]')).toBeVisible();
```

### 5. Refresh Functionality
```typescript
// Click refresh button
await page.locator('[data-ai-id="repo-dashboard-refresh-button"]').click();

// Verify button shows "Refreshing..."
await expect(page.locator('[data-ai-id="repo-dashboard-refresh-button"]')).toHaveText('Refreshing...');

// Wait for completion
await expect(page.locator('[data-ai-id="repo-dashboard-refresh-button"]')).toHaveText('Refresh');
```

## Visual Testing

### Screenshot Capture Points
1. **Full Panel Overview** - After loading with all 3 tabs
2. **Repositories Tab** - Table with age-based row colors
3. **Pipeline Tab** - App status table with develop→main→Vercel flow
4. **Disk Usage - Treemap** - Hierarchical visualization
5. **Disk Usage - Bars** - Bar chart with color coding

### Automated Visual Capture Script
```python
# /root/projekte/werkingflow/autopilot/cui/capture-repo-dashboard.py
import asyncio
from playwright.async_api import async_playwright

async def capture_views():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page(viewport={'width': 1920, 'height': 1080})

        await page.goto('http://localhost:4005')
        await page.wait_for_timeout(3000)  # Wait for panel load

        # Capture Repositories Tab
        await page.locator('[data-ai-id="repo-dashboard-tab-repos"]').click()
        await page.wait_for_timeout(1000)
        await page.screenshot(path='/root/orchestrator/workspaces/cui-workspace/repo-dashboard-01-repositories.png')

        # Capture Pipeline Tab
        await page.locator('[data-ai-id="repo-dashboard-tab-pipeline"]').click()
        await page.wait_for_timeout(1000)
        await page.screenshot(path='/root/orchestrator/workspaces/cui-workspace/repo-dashboard-02-pipeline.png')

        # Capture Disk Usage - Treemap
        await page.locator('[data-ai-id="repo-dashboard-tab-disk"]').click()
        await page.locator('[data-ai-id="disk-usage-view-treemap"]').click()
        await page.wait_for_timeout(2000)
        await page.screenshot(path='/root/orchestrator/workspaces/cui-workspace/repo-dashboard-03-treemap.png')

        # Capture Disk Usage - Bars
        await page.locator('[data-ai-id="disk-usage-view-bars"]').click()
        await page.wait_for_timeout(1000)
        await page.screenshot(path='/root/orchestrator/workspaces/cui-workspace/repo-dashboard-04-bars.png')

        await browser.close()

asyncio.run(capture_views())
```

## Backend API Testing

### API Endpoints
- `GET /api/repo-dashboard/repositories` - Get all git repositories
- `GET /api/repo-dashboard/pipeline` - Get pipeline status
- `GET /api/repo-dashboard/structure` - Get folder disk usage
- `POST /api/repo-dashboard/refresh` - Clear all caches

### API Test Examples
```bash
# Test repositories endpoint
curl http://localhost:4005/api/repo-dashboard/repositories | jq '.repos[0]'

# Test pipeline endpoint
curl http://localhost:4005/api/repo-dashboard/pipeline | jq '.pipeline'

# Test structure endpoint
curl http://localhost:4005/api/repo-dashboard/structure | jq '.structure[0]'

# Trigger cache refresh
curl -X POST http://localhost:4005/api/repo-dashboard/refresh
```

## Integration with Unified-Tester

### Scenario JSON Structure
```json
{
  "scenario_id": "cui.repo-dashboard.overview",
  "description": "Verify Git & Pipeline Monitor panel loads and displays repository data",
  "initial_url": "http://localhost:4005",
  "tasks": [
    {
      "task": "Open Git & Pipeline Monitor panel",
      "expected_outcome": "Panel loads with Repositories tab active"
    },
    {
      "task": "Click on Pipeline tab",
      "expected_outcome": "Pipeline flow diagram and app status table displayed"
    },
    {
      "task": "Click on Disk Usage tab and switch to Treemap view",
      "expected_outcome": "Treemap visualization shows folder sizes with age-based colors"
    },
    {
      "task": "Click refresh button",
      "expected_outcome": "Data reloads and caches are cleared"
    }
  ]
}
```

### Test Location
Create new scenarios in: `/root/projekte/werkingflow/tests/unified-tester/scenarios/cui/repo-dashboard/`

## Color Heatmap Reference

### Age-Based Colors (Tokyo Night Palette)
- **Fresh** (< 1 week): `#9ece6a` (Green)
- **Recent** (< 1 month): `#e0af68` (Yellow)
- **Aging** (< 3 months): `#ff9e64` (Orange)
- **Stale** (< 6 months): `#f7768e` (Red)
- **Dead** (> 6 months): `#565f89` (Gray)

### Row Colors (Repositories Tab - RGBA with 12% opacity)
- Fresh: `rgba(158, 206, 106, 0.12)`
- Recent: `rgba(224, 175, 104, 0.12)`
- Aging: `rgba(255, 158, 100, 0.12)`
- Stale: `rgba(247, 118, 142, 0.12)`
- Dead: `rgba(86, 95, 137, 0.12)`

### Treemap Colors (Disk Usage Tab - Solid Hex)
Uses solid colors for better visibility in treemap cells.

## Caching Behavior

### Cache TTL: 60 seconds
All API endpoints have 60-second caching:
- First request: Expensive git operations (slow)
- Subsequent requests: Instant from cache
- Manual refresh: Clears all caches

### Cache Keys
- `repoCache` - Repository data
- `pipelineCache` - Pipeline status
- `structureCache` - Folder disk usage

## Related Files

### Frontend Components
- `/root/projekte/werkingflow/autopilot/cui/src/components/panels/RepoDashboard/RepoDashboard.tsx`
- `/root/projekte/werkingflow/autopilot/cui/src/components/panels/RepoDashboard/tabs/RepositoriesTab.tsx`
- `/root/projekte/werkingflow/autopilot/cui/src/components/panels/RepoDashboard/tabs/PipelineTab.tsx`
- `/root/projekte/werkingflow/autopilot/cui/src/components/panels/RepoDashboard/tabs/DiskUsageTab.tsx`

### Backend API
- `/root/projekte/werkingflow/autopilot/cui/server/index.ts` (lines 5329-5500)

### Panel Registration
- `/root/projekte/werkingflow/autopilot/cui/src/components/LayoutManager.tsx`

## Next Steps

1. **Create Unified-Tester Scenarios**
   - Basic panel load and navigation
   - Sort and filter operations
   - View mode toggles
   - Refresh functionality

2. **Add Visual Regression Tests**
   - Capture baseline screenshots
   - Compare on each build
   - Flag visual changes

3. **API Contract Tests**
   - Validate response schemas
   - Test cache behavior
   - Verify error handling

4. **Performance Tests**
   - Measure git scan time
   - Verify cache effectiveness
   - Test with large repo count (100+)

---

**Testing Setup Complete ✅**
- 40+ `data-ai-id` attributes added
- Pattern matches BridgeMonitor testing architecture
- Ready for AI-driven automated testing
- Visual capture script template provided
