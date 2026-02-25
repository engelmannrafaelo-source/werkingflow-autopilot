# Virtual Office - Autonomous Visual Testing

**Status**: ✅ PRODUCTION READY
**Last Updated**: 2026-02-24

---

## Quick Start

```bash
cd /root/projekte/werkingflow/autopilot/cui

# 1. Server muss laufen
npm run dev:server  # Port 4005

# 2. Screenshots erstellen
python3 capture-all-views.py

# 3. Screenshots anschauen
ls -lh /root/orchestrator/workspaces/team/0*.png
```

**Output**: 9 Screenshots aller Virtual Office Views in `/root/orchestrator/workspaces/team/`

---

## System Architecture

### Component Registration (KRITISCH!)

**File**: `src/components/LayoutManager.tsx`

```typescript
// BEIDE component names MÜSSEN registriert sein:
case 'office':
case 'virtual-office':  // ← Ohne diese Zeile: "Unknown panel: virtual-office"
  return wrapWithId(<OfficePanel projectId={projectId} workDir={workDir} />);
```

**Warum beide?**
- Layout JSON: `"component": "office"`
- Browser-Tab: `"component": "virtual-office"` (dynamisch von "Virtual Office" name)
- Ohne beide → "Unknown panel" Error

### Screenshot System

**Technology**: Playwright (headless Chromium)
**Viewport**: 1920x1080
**Wait Time**: ~12 Sekunden für vollständiges Rendering
**URL**: `http://localhost:4005?project=team`

---

## 9 Captured Views

1. **01-dashboard-agent-grid.png**
   - 3-Panel Dashboard (Hauptansicht)
   - Left: Live Activity Stream (SSE)
   - Center: Agent Grid mit 17 Agent Cards
   - Right: Action Items (18 PENDING)

2. **02-dashboard-org-chart.png**
   - Hierarchische "Berichtet an" Struktur
   - Team Organization Chart

3. **03-dashboard-raci-matrix.png**
   - Responsibility Matrix
   - Owner / Responsible / Consulted / Informed

4. **04-office-view.png**
   - Office View mit Team-Übersicht

5. **05-tasks-view.png**
   - Task Board

6. **06-reviews-view.png**
   - Review Queue

7. **07-knowledge-view.png**
   - Knowledge Graph

8. **08-agents-view.png**
   - Agent Dashboard

9. **09-chat-view.png**
   - Persona Chat

---

## Automated Testing (Rafbot)

### Daily Screenshot Job

```python
#!/usr/bin/env python3
"""
Rafbot: Daily Virtual Office Visual Test
Schedule: 06:00 daily
"""
import asyncio
from playwright.async_api import async_playwright

async def daily_check():
    # 1. Capture alle 9 views
    await capture_all_views()

    # 2. Claude Vision API für Analyse
    results = await analyze_with_vision([
        "01-dashboard-agent-grid.png",
        # ... alle anderen
    ])

    # 3. Check Erwartungen:
    expectations = {
        "dashboard": {
            "activity_stream": "min 5 events",
            "agent_grid": "17 agents visible",
            "action_items": "18 PENDING visible"
        },
        "org_chart": "hierarchy complete",
        "raci_matrix": "responsibilities defined"
    }

    # 4. Business Approval erstellen bei Problemen
    if has_issues(results, expectations):
        create_business_approval({
            "type": "VISUAL_TEST_FAILURE",
            "severity": "medium",
            "details": results
        })
```

### Expected Data

**Dashboard - Agent Grid**:
- 17 Agent Cards sichtbar
- Status indicators (idle/working/blocked)
- Last run timestamps

**Activity Stream**:
- Minimum 5-7 recent events
- Real-time via SSE

**Action Items**:
- 18 PENDING approvals
- Business documents zur Freigabe

---

## Troubleshooting

### "Unknown panel: virtual-office"

**Cause**: LayoutManager kennt component name nicht

**Fix**:
```typescript
// src/components/LayoutManager.tsx
case 'office':
case 'virtual-office':  // ← ADD THIS LINE
  return wrapWithId(<OfficePanel projectId={projectId} workDir={workDir} />);
```

Then rebuild:
```bash
npm run build
npm run dev:server
```

### Screenshot Timeout

**Error**: `Page.goto: Timeout 30000ms exceeded`

**Cause**: Server braucht länger zum Starten

**Fix**: Increase timeout in script:
```python
await page.goto(url, timeout=60000)
await asyncio.sleep(12)  # Wait for full render
```

### Empty Panels

**Cause**: SSE connection failed

**Check**:
```bash
curl http://localhost:4005/api/agents/activity-stream
# Should stream events
```

**Fix**: Restart server, check SSE endpoint

### No Agent Cards Visible

**Check**:
1. Persona files exist: `/root/projekte/orchestrator/team/personas/*.md`
2. API responds: `curl http://localhost:4005/api/agents`
3. Agent Grid button is clicked (default view)

---

## Files

### Scripts:
- `capture-all-views.py` - Main screenshot script (9 views)
- `quick-test.py` - Fast single screenshot test
- `test-extended-wait.py` - Debug tool

### Documentation:
- `/root/.claude/CLAUDE.md` - Global config (Section: "Autonomous Visual Testing")
- `/root/orchestrator/workspaces/team/SUCCESS.md` - Fix history
- This file - Quick reference

### Output:
- `/root/orchestrator/workspaces/team/01-*.png` through `09-*.png`

---

## Development

### Add New View

1. Add button check in `capture-all-views.py`:
```python
# 10. New view
print("📸 10. New View...")
new_btn = await page.query_selector('button:has-text("New View")')
if new_btn:
    await new_btn.click()
    await asyncio.sleep(3)
await page.screenshot(path=f"{OUTPUT}/10-new-view.png", full_page=True)
```

2. Update documentation count (9 → 10 views)

### Modify Screenshot Resolution

```python
context = await browser.new_context(
    viewport={'width': 2560, 'height': 1440}  # 2K
)
```

---

## Production Checklist

- [x] Component registration (`office` + `virtual-office`)
- [x] Server running on port 4005
- [x] Playwright installed (`playwright install chromium`)
- [x] Output directory exists (`/root/orchestrator/workspaces/team/`)
- [x] All 9 views accessible
- [x] Screenshots captured successfully
- [x] Documentation updated

---

**Next Steps for Rafbot**:
1. Integrate in daily schedule (06:00)
2. Claude Vision analysis
3. Business Approval bei Anomalien
4. Trending-Analyse (Vergleich mit Previous Days)

**Maintained by**: Claude Sonnet 4.5
**First Working**: 2026-02-24
