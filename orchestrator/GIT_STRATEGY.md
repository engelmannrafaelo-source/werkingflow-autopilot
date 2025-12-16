# Git-Strategie für Hierarchische Planung

## Prinzip

Jede Plan-Ebene → Eigener Branch
Approval → Merge nach oben

```
main
 │
 └── autopilot/sprint-2024-12-16          ← MASTER_PLAN Branch
      │
      ├── werkflow/auth-refactor          ← Feature Branch
      │    │
      │    ├── werkflow/auth-middleware   ← Task Branch (optional)
      │    └── werkflow/auth-tests
      │
      ├── werkflow/billing-extension
      │
      └── teufel-ai/phase-3
```

## Branch-Naming Convention

```
{projekt}/{feature-name}

Beispiele:
- werkflow/auth-refactor
- werkflow/billing-dashboard
- teufel-ai/phase-3-vision
- cross-project/shared-types
```

## Workflow

### Level 0: Master Plan → Sprint Branch

```bash
# Autopilot erstellt Sprint-Branch
git checkout -b autopilot/sprint-2024-12-16

# MASTER_PLAN.md wird hier committed
git add MASTER_PLAN.md
git commit -m "plan: Sprint 2024-12-16 Master Plan"
```

### Level 1: Project Plan → Feature Branch

```bash
# Vom Sprint-Branch aus
git checkout autopilot/sprint-2024-12-16
git checkout -b werkflow/auth-refactor

# Im ECHTEN Repo (werkflow)
cd /path/to/werkflow
git checkout -b feature/auth-refactor

# PLAN.md wird hier committed
git add PLAN.md
git commit -m "plan: Auth Middleware Refactor"
```

### Level 2/3: Execution → Commits auf Feature Branch

```bash
# Arbeitet auf Feature Branch
git checkout feature/auth-refactor

# Einzelne Tasks = Einzelne Commits
git commit -m "refactor: Extract auth middleware to /lib/auth"
git commit -m "refactor: Migrate API routes to new middleware"
git commit -m "test: Add middleware unit tests"
```

### Nach Completion: Merge Upstream

```bash
# Feature fertig → PR zu main
gh pr create --title "feat: Auth Middleware Refactor" --base main

# Nach Review + Merge
# Sprint-Branch updated sich automatisch
```

## Commit Message Convention

```
{type}: {description}

Types:
- plan:     Plan-Erstellung oder Update
- feat:     Neues Feature
- fix:      Bug Fix
- refactor: Code Refactoring
- test:     Tests
- docs:     Dokumentation
- chore:    Maintenance
```

## Parallel Execution

Wenn mehrere Features parallel laufen:

```
main
 │
 └── autopilot/sprint-2024-12-16
      │
      ├── werkflow/auth-refactor      ← Agent 1
      │
      ├── werkflow/billing-extension  ← Agent 2
      │
      └── teufel-ai/phase-3           ← Agent 3
```

**Wichtig:**
- Jeder Agent arbeitet auf EIGENEM Branch
- Keine Konflikte möglich
- Merges passieren nach Approval

## Cross-Project Changes

Wenn eine Änderung mehrere Repos betrifft:

```
1. MASTER_PLAN identifiziert Cross-Project Dependency
2. Shared-Types Package wird ZUERST erstellt
3. Abhängige Features warten auf Shared-Types Merge
4. Dann parallel weiter
```

**Beispiel:**
```
MASTER_PLAN:
1. [x] shared-types: TenantContext Type definieren
2. [ ] werkflow: TenantContext importieren (wartet auf 1)
3. [ ] teufel-ai: TenantContext importieren (wartet auf 1)
```

## Rollback-Strategie

Wenn etwas schief geht:

```bash
# Feature Branch löschen (vor Merge)
git branch -D werkflow/auth-refactor

# Nach Merge: Revert
git revert <merge-commit>

# Komplett zurück zum Sprint-Start
git reset --hard autopilot/sprint-2024-12-16~1
```

## Visualisierung im Log

```
Autopilot zeigt immer:

📊 Git Status:
├── main: 3 commits behind
├── autopilot/sprint-2024-12-16: Active
│   ├── werkflow/auth-refactor: 5 commits, PR ready
│   ├── werkflow/billing: In Progress (2 commits)
│   └── teufel-ai/phase-3: Not started
```

## Automatische PR-Erstellung

Nach jedem "Go!" auf einem Feature:

```bash
# Autopilot erstellt automatisch PR
gh pr create \
  --title "feat(werkflow): Auth Middleware Refactor" \
  --body "## Summary
  - Extracted auth middleware to /lib/auth
  - Migrated 12 API routes
  - Added unit tests

  ## Plan Reference
  See werkflow/PLAN.md

  🤖 Generated with WerkingFlow Autopilot"
```

## Status-Tracking

```
projects/werkflow/PLAN.md:

## Auth Refactor

### Git
- Branch: `feature/auth-refactor`
- Status: `in_progress`
- Commits: 5
- PR: #123 (draft)

### Tasks
- [x] Middleware extrahieren
- [x] Types definieren
- [ ] Routes migrieren (in progress)
- [ ] Tests schreiben
```
