# CUI Workspace

**Stack**: TypeScript, React, Vite, Express, Node.js
**Runs on**: Remote dev server (100.121.161.109:4005) — Mac is thin client (browser only)
**Source**: Syncthing syncs source code from Mac → remote. Data/dist/deps are local per machine.

## Architecture

```
Dev Server (100.121.161.109) — SINGLE INSTANCE
├── Express Server (:4005)
│   ├── Vite frontend (React SPA from dist/)
│   ├── /api/* routes (direct local filesystem — no SSH!)
│   ├── /watchdog/* → localhost:9090 (same machine)
│   └── CUI Proxy ports:
│       ├── :5001 → localhost:4001 (rafael)
│       ├── :5002 → localhost:4002 (engelmann)
│       ├── :5003 → localhost:4003 (office)
│       └── :5004 → localhost:4004 (local, optional)
│
├── CUI binaries via PM2 (:4001, :4002, :4003)
├── Dev Server Watchdog (:9090)
├── Next.js apps (:3004-:3012 user, :3104-:3112 test)
└── AI-Bridge (49.12.72.66:8000 — public IP)

Mac (thin client)
├── Electron app (Desktop-Doppelklick) → http://100.121.161.109:4005
├── Browser → http://100.121.161.109:4005 (via Tailscale)
└── cui-local (PM2, optional) → localhost:4004 (Mac-only CUI binary)
```

## Syncthing

Only **source code** is synced (Mac → remote). Everything else stays local.

`.stignore` excludes: `/data`, `/dist`, `/node_modules`, `.env`, `*.log`, `*.sync-conflict-*`

## Systemd Service

```bash
systemctl status cui-workspace    # Check status
systemctl restart cui-workspace   # Restart after server code changes
journalctl -u cui-workspace -f    # Follow logs
```

Service file: `/etc/systemd/system/cui-workspace.service`
Log file: `/var/log/cui-workspace.log`

### KRITISCH: Workspace-Server vs CUI-Binaries — NICHT VERWECHSELN!

| Komponente | Verwaltet durch | Ports | Neustart |
|------------|----------------|-------|----------|
| **Workspace-Server** (server/index.ts) | **systemd** (`cui-workspace.service`) | 4005, 5001-5004 | `systemctl restart cui-workspace` |
| **CUI-Binaries** (claude-code CLI) | **PM2** (`ecosystem.config.js`) | 4001, 4002, 4003 | `su - claude-user -c "pm2 restart cui-1"` |

**NIEMALS:**
- `pm2 start ... --name werkingflow-cui` oder ähnliche PM2-Befehle für den Workspace-Server
- `pm2 start npm -- run dev:server` — der Server läuft über systemd, NICHT PM2!
- `pm2 save` nach Änderungen an CUI-Prozessen — kann die ecosystem.config.js überschreiben!
- PM2 IDs/Namen ändern — `cui-1`, `cui-2`, `cui-3` sind fest definiert in `/root/.cui/ecosystem.config.js`

**IMMER:**
- Workspace-Server: `systemctl restart cui-workspace`
- CUI-Binaries: `su - claude-user -c "pm2 restart cui-{1,2,3}"`
- PM2 ecosystem wiederherstellen: `su - claude-user -c "pm2 start /root/.cui/ecosystem.config.js"`

## Development Workflow

1. Edit source code on Mac (VS Code)
2. Syncthing syncs `src/` and `server/` to remote (~1-2s)
3. **IMMER `cui-rebuild` verwenden** — baut Frontend und startet Server:

```bash
cui-rebuild          # Quick: vite build + systemctl restart
cui-rebuild --full   # Full: npm install + vite build + restart
```

NIEMALS nur `vite build` ohne Restart oder nur Restart ohne Build!

## Environment Variables

All credentials come from `~/.zshrc` on the remote server plus `/root/projekte/werkingflow/autopilot/cui/.env`.

Required in `.env`: `WERKING_REPORT_ADMIN_SECRET`, `VERCEL_TOKEN`, `WERKING_REPORT_URL`, `WERKING_REPORT_STAGING_URL`

## Panel Classification

All panels run from the remote server. Mac browser just renders them.

| Panel | Data Source | Notes |
|-------|-----------|-------|
| CuiPanel | `:5001-5004` → localhost CUI binaries | Main chat interface |
| BrowserPanel | User-provided URL | Generic iframe |
| FilePreview | `/api/file` → local filesystem | Direct fs access (no SSH!) |
| MissionControl | `/api/*` Express | Conversation dashboard |
| OfficePanel | `/api/*` Express | Team persona management |
| NotesPanel | localStorage (browser) | Client-side only |
| ImageDrop | `/api/images` → local `/tmp/cui-images` | Direct save |
| SystemHealth | `/api/admin/wr/*`, `/api/ops/*` | Vercel deploy status |
| LinkedInPanel | `/api/file` → local filesystem | Marketing HTML |
| WerkingReportAdmin | `/api/*` | WR admin dashboard |
| BridgeMonitor | `49.12.72.66:8000` direct | AI-Bridge public IP |
| WatchdogPanel | `/watchdog/` → localhost:9090 | Dev server monitoring |

## Key Files

| File | Purpose |
|------|---------|
| `server/index.ts` | Express server, all API endpoints (~4200 lines) |
| `src/components/panels/*.tsx` | Panel components |
| `src/components/LayoutManager.tsx` | Panel registry and rendering |
| `vite.config.ts` | Frontend build config |
| `.stignore` | Syncthing exclusions |
| `.env` | Server credentials (NOT synced) |

## Build & Deploy

```bash
# On remote server:
cd /root/projekte/werkingflow/autopilot/cui

# Rebuild frontend
npx vite build

# Restart server
systemctl restart cui-workspace

# Full rebuild (after dependency changes)
npm install && npx vite build && systemctl restart cui-workspace
```
