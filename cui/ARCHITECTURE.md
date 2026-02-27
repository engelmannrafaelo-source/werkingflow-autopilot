# CUI System Architecture

**Version**: 2.0 (Multi-Browser Context System)
**Location**: `/root/projekte/werkingflow/autopilot/cui/`
**Main Port**: 4005

---

## 🎯 Overview

The CUI (Claude UI) System is a **multi-browser context management system** that allows multiple Claude Desktop accounts to interact with different project contexts simultaneously.

**Key Innovation**: One server (port 4005) manages 4 independent browser contexts (ports 4001-4004), each accessible via proxies (ports 5001-5004).

---

## 📊 Port Architecture

### Layer 1: Main Server (Port 4005)

**Purpose**: Central Next.js server
- Serves frontend UI
- Coordinates all browser contexts
- Handles API routes
- Manages state

**Access**: `http://localhost:4005`

### Layer 2: Browser Contexts (Ports 4001-4004)

**Purpose**: Isolated Claude Desktop browser sessions

| Port | Context | Purpose |
|------|---------|---------|
| 4001 | Rafael | Rafael's personal projects |
| 4002 | Engelmann | Engelmann customer context |
| 4003 | Office | Virtual Office / Team context |
| 4004 | Local | Local development / testing |

**Key Properties:**
- Each port = separate browser instance
- Independent cookies/sessions
- No cross-context contamination
- Internal only (not exposed externally)

### Layer 3: Proxy Layer (Ports 5001-5004)

**Purpose**: External access to browser contexts

| Port | Target | Usage |
|------|--------|-------|
| 5001 | →4001 | Screenshot/automation for Rafael |
| 5002 | →4002 | Screenshot/automation for Engelmann |
| 5003 | →4003 | Screenshot/automation for Office |
| 5004 | →4004 | Screenshot/automation for Local |

**Implementation:**
```typescript
// server/index.ts
const CUIS = [
  { id: 'rafael',    localPort: 5001, target: 'http://localhost:4001' },
  { id: 'engelmann', localPort: 5002, target: 'http://localhost:4002' },
  { id: 'office',    localPort: 5003, target: 'http://localhost:4003' },
  { id: 'local',     localPort: 5004, target: 'http://localhost:4004' },
];
```

### Layer 4: Development Server (Port 5173)

**Purpose**: Vite dev server (development only)
- Hot reload during development
- NOT used in production

---

## 🏗️ Architecture Diagram

```
┌─────────────────────────────────────────────────────┐
│           External Access (Proxies)                  │
│                                                      │
│  :5001 (Rafael)   :5002 (Engelmann)                │
│  :5003 (Office)   :5004 (Local)                    │
└──────────────┬──────────────┬────────────────────────┘
               │              │
               ▼              ▼
┌─────────────────────────────────────────────────────┐
│         Browser Contexts (Internal)                  │
│                                                      │
│  :4001 (Rafael)   :4002 (Engelmann)                │
│  :4003 (Office)   :4004 (Local)                    │
│                                                      │
│  - Isolated sessions                                 │
│  - Separate cookies                                  │
│  - No cross-talk                                     │
└──────────────┬──────────────┬────────────────────────┘
               │              │
               ▼              ▼
┌─────────────────────────────────────────────────────┐
│              Main CUI Server                         │
│                                                      │
│                  :4005                               │
│                                                      │
│  - Next.js Server                                    │
│  - State Management                                  │
│  - API Routes                                        │
│  - Frontend UI                                       │
└──────────────────────────────────────────────────────┘
```

---

## 🔄 Request Flow

### Scenario 1: User Accesses CUI

```
User Browser
    ↓
http://localhost:4005
    ↓
Next.js Server (Main)
    ↓
Renders Frontend
```

### Scenario 2: Screenshot Automation

```
Playwright Script
    ↓
http://localhost:5002 (Engelmann Proxy)
    ↓
Forwards to :4002 (Engelmann Browser)
    ↓
Isolated Engelmann Context
    ↓
Screenshot Captured
```

### Scenario 3: API Call

```
Frontend (:4005)
    ↓
POST /api/agents/status
    ↓
Server Handler
    ↓
Returns Agent Data
```

---

## 🚀 Startup Process

### 1. Start Main Server

```bash
cd /root/projekte/werkingflow/autopilot/cui
PORT=4005 NODE_ENV=production npx tsx server/index.ts
```

**Starts:**
- Next.js server on 4005
- Browser contexts on 4001-4004
- Proxies on 5001-5004

### 2. Health Check

```bash
curl http://localhost:4005/api/health
# → {"status":"ok","timestamp":...}
```

### 3. Access CUI

```bash
open http://localhost:4005
```

---

## 📂 File Structure

```
/root/projekte/werkingflow/autopilot/cui/
├── server/
│   ├── index.ts              # Main server + proxy setup
│   ├── knowledge-watcher.ts  # File system watcher
│   └── routes/               # API route handlers
├── src/
│   ├── components/
│   │   ├── panels/
│   │   │   ├── VirtualOffice.tsx   # Main dashboard
│   │   │   ├── AgentGrid.tsx       # Agent cards
│   │   │   ├── TeamOrgChart.tsx    # Hierarchy view
│   │   │   └── ResponsibilityMatrix.tsx  # RACI matrix
│   │   └── modals/
│   │       └── AgentDetailModal.tsx
│   └── types/
│       └── index.ts          # Type definitions
├── dist/                     # Built frontend (production)
├── ARCHITECTURE.md          # This file
└── package.json
```

---

## 🔧 Configuration

### Environment Variables

```bash
# Required
PORT=4005                     # Main server port
NODE_ENV=production          # production | development

# Optional
WERKING_REPORT_URL=...       # WR integration
WERKING_REPORT_ADMIN_SECRET=...
VERCEL_TOKEN=...             # For deployments
```

### Port Configuration

All ports are **hardcoded** in `server/index.ts`:

```typescript
const PORT = parseInt(process.env.PORT ?? '4005', 10);

const CUIS = [
  { id: 'rafael',    localPort: 5001, target: 'http://localhost:4001' },
  { id: 'engelmann', localPort: 5002, target: 'http://localhost:4002' },
  { id: 'office',    localPort: 5003, target: 'http://localhost:4003' },
  { id: 'local',     localPort: 5004, target: 'http://localhost:4004' },
];
```

**Why hardcoded?**
- Simplicity (no dynamic port allocation)
- Stability (ports never change)
- Claude Desktop expects fixed ports

---

## 🎨 Frontend Features

### Virtual Office Dashboard

**3-Panel Layout:**
1. **Left**: Activity Stream (SSE events)
2. **Center**: Agent Grid / Org Chart / RACI Matrix
3. **Right**: Action Items (pending approvals, overdue agents)

**Views:**
- 🎯 Agent Grid (default) - Card-based overview
- 🏢 Org Chart - Hierarchical structure
- 📊 RACI Matrix - Responsibility mapping

### Components

| Component | Purpose |
|-----------|---------|
| `VirtualOffice.tsx` | Main 3-panel dashboard |
| `AgentGrid.tsx` | Agent card grid view |
| `TeamOrgChart.tsx` | Hierarchical org chart |
| `ResponsibilityMatrix.tsx` | RACI matrix view |
| `AgentDetailModal.tsx` | Agent details popup |

---

## 🔄 Integration Points

### 1. Werking Report

```typescript
// server/index.ts
const wrUrl = process.env.WERKING_REPORT_URL;
const wrSecret = process.env.WERKING_REPORT_ADMIN_SECRET;

// API: POST /api/admin/wr/rebuild
// Triggers: WR frontend rebuild via Watchdog API
```

### 2. Team System

```typescript
// API: GET /api/agents/persona/:id
// Reads: /root/projekte/orchestrator/team/personas/*.md
// Returns: Parsed persona data (role, MBTI, responsibilities)
```

### 3. Activity Stream

```typescript
// API: GET /api/agents/activity-stream (SSE)
// Real-time events from agents
// Displayed in left panel of Virtual Office
```

---

## 🧪 Testing

### Screenshot Automation

```bash
cd /root/projekte/werkingflow/autopilot/cui

# Run capture script
python3 capture-all-views.py

# Output: /root/orchestrator/workspaces/team/*.png
# - 01-dashboard-agent-grid.png
# - 02-dashboard-org-chart.png
# - 03-dashboard-raci-matrix.png
# - 04-office-view.png
# ... etc
```

### Manual Testing

```bash
# Health check
curl http://localhost:4005/api/health

# Agent list
curl http://localhost:4005/api/agents

# Persona data
curl http://localhost:4005/api/agents/persona/rafbot
```

---

## 🐛 Troubleshooting

### Issue: "Unknown panel: virtual-office"

**Cause**: Missing component registration in `LayoutManager.tsx`

**Fix**: Both names must be registered:
```typescript
case 'office':
case 'virtual-office':  // ← BOTH required!
  return wrapWithId(<OfficePanel />);
```

### Issue: Port already in use

**Cause**: Previous server still running

**Fix**:
```bash
# Kill all CUI servers
pkill -f "tsx server/index.ts"

# Or specific port
lsof -ti:4005 | xargs kill -9
```

### Issue: Slow load times

**Cause**: SSE connection + data fetching

**Expected**: 10-12 seconds for full load (networkidle)

**Not a bug**: System needs time to establish all connections

---

## 📊 Performance

### Startup Time

- **Main Server**: ~2 seconds
- **All Contexts**: ~5 seconds
- **Full System Ready**: ~10 seconds

### Memory Usage

- **Main Server**: ~200 MB
- **Browser Context**: ~50 MB each
- **Total**: ~400 MB

### Network

- **Frontend Bundle**: ~2 MB (production)
- **SSE Overhead**: ~1 KB/s (activity stream)

---

## 🔐 Security

### Port Exposure

- **4001-4004**: Internal only (localhost)
- **4005**: Main UI (localhost)
- **5001-5004**: Proxies (localhost)

**No external exposure** - all ports bind to localhost only.

### Authentication

- No authentication required (local dev tool)
- For production: Add auth middleware to server/index.ts

---

## 🚀 Deployment

### Production Mode

```bash
# Build frontend
npm run build

# Start server
NODE_ENV=production PORT=4005 npx tsx server/index.ts
```

### Development Mode

```bash
# Start dev server (hot reload)
npm run dev

# Or manually:
npm run dev:server  # Port 4005 (backend)
npm run dev:client  # Port 5173 (frontend)
```

---

## 📚 References

- **Global Config**: `/root/.claude/CLAUDE.md` (Section: CUI Workspace & Virtual Office)
- **Workspace**: `/root/orchestrator/workspaces/cui-workspace/`
- **Team Personas**: `/root/projekte/orchestrator/team/personas/`
- **Port Inventory**: `/root/orchestrator/workspaces/werkingsafety/COMPLETE-PORT-INVENTORY.md`

---

*Version: 2.0*
*Last Updated: 2026-02-27*
*Architecture: Multi-Browser Context System with 9 ports*
