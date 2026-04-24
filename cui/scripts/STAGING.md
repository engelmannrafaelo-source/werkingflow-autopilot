# CUI Staging Instance (:4105)

Parallel CUI instance for sub-session testing without affecting the live server on port 4005.

## Usage

```bash
npm run start:staging   # Start on :4105
npm run stop:staging    # Stop staging instance
npm run reset:staging   # Reset data dir + start fresh
```

## Data Isolation

| Instance | Port | Data Directory |
|----------|------|----------------|
| Live (systemd) | 4005 | `autopilot/cui/data/` |
| Staging (manual) | 4105 | `/tmp/cui-staging-data/` |

On first start, data/ is copied to /tmp/cui-staging-data/. Subsequent starts reuse it (persistent across restarts). Use `reset:staging` to wipe and re-copy.

## Frontend Snapshot

Staging shares the existing `dist/` directory — it does NOT rebuild the frontend. The backend runs live from source via `tsx`. This is sufficient for testing backend API fixes.

**WARNING**: Rebuilding the frontend (`npm run build:local`) restarts port 4005 — never run this in a sub-session without Rafael's approval.

## Verification

```bash
# Both should return JSON:
curl http://localhost:4105/api/panels/inspect
curl http://localhost:4005/api/panels/inspect   # must be unaffected

# Two tsx processes — one systemd (4005), one staging (4105):
ps aux | grep tsx
```

## Logs

```bash
tail -f /tmp/cui-staging.log
```
