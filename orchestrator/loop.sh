#!/bin/bash
# WerkingFlow Autopilot - Autonomous Execution Loop
#
# Usage:
#   ./orchestrator/loop.sh werkflow           # Ein Projekt autonom entwickeln
#   ./orchestrator/loop.sh --all              # Alle Projekte nacheinander
#   ./orchestrator/loop.sh werkflow --timeout 1h  # Mit Timeout
#   ./orchestrator/loop.sh werkflow --dry-run     # Nur Plan, keine Ausführung
#
# Der Loop:
# 1. Erstellt Feature-Branch (autopilot/YYYY-MM-DD-HHmm)
# 2. Lädt Kontext (CONTEXT.md, GOAL.md, PLAN.md)
# 3. Startet Claude autonom (--dangerously-skip-permissions)
# 4. Claude arbeitet bis: Ziel erreicht / Blockiert / Timeout
# 5. Erstellt Summary für Merge-Review
# 6. NIEMALS auf main pushen - wartet auf User-Approval

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
NC='\033[0m'

# Paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUTOPILOT_DIR="$(dirname "$SCRIPT_DIR")"
PROJECTS_DIR="$AUTOPILOT_DIR/projects"
LOGS_DIR="$AUTOPILOT_DIR/logs"
SUMMARIES_DIR="$AUTOPILOT_DIR/summaries"

# Current timestamps
DATE=$(date +%Y-%m-%d)
TIME=$(date +%H%M)
TIMESTAMP=$(date +%H:%M:%S)

# Mode flags
DRY_RUN=false
ALL_PROJECTS=false
TIMEOUT_DURATION="2h"
SINGLE_PROJECT=""
VERBOSE=false
WATCH_MODE=false
EXECUTION_MODE="full"  # full, cleanup, architecture, features

# Ensure directories exist
mkdir -p "$LOGS_DIR" "$SUMMARIES_DIR"

#######################################
# Logging
#######################################
log() {
    local level=$1
    shift
    local message="$*"
    local log_file="$LOGS_DIR/$DATE.log"
    echo "[$TIMESTAMP] [LOOP] [$level] $message" >> "$log_file"

    case $level in
        INFO)    echo -e "${BLUE}[INFO]${NC}    $message" ;;
        OK)      echo -e "${GREEN}[OK]${NC}      $message" ;;
        WARN)    echo -e "${YELLOW}[WARN]${NC}    $message" ;;
        ERROR)   echo -e "${RED}[ERROR]${NC}   $message" ;;
        EXEC)    echo -e "${CYAN}[EXEC]${NC}    $message" ;;
        CLAUDE)  echo -e "${MAGENTA}[CLAUDE]${NC}  $message" ;;
    esac
}

#######################################
# Registry Functions
#######################################
scan_registry() {
    local projects=()
    for dir in "$PROJECTS_DIR"/*/; do
        local name=$(basename "$dir")
        if [ "$name" != "_template" ]; then
            projects+=("$name")
        fi
    done
    echo "${projects[@]}"
}

get_project_repo() {
    local project=$1
    local config_file="$PROJECTS_DIR/$project/CONFIG.yaml"

    if [ -f "$config_file" ]; then
        grep "^repo:" "$config_file" 2>/dev/null | sed 's/repo: *//' | tr -d '"' | head -1
        return
    fi

    local repo_file="$PROJECTS_DIR/$project/repo.txt"
    if [ -f "$repo_file" ]; then
        head -1 "$repo_file"
        return
    fi

    echo ""
}

get_project_main_branch() {
    local project=$1
    local config_file="$PROJECTS_DIR/$project/CONFIG.yaml"

    if [ -f "$config_file" ]; then
        local main=$(grep "main_branch:" "$config_file" 2>/dev/null | sed 's/.*main_branch: *//' | tr -d '"' | head -1)
        echo "${main:-main}"
    else
        echo "main"
    fi
}

#######################################
# Git Operations
#######################################
create_autopilot_branch() {
    local project=$1
    local repo=$(get_project_repo "$project")
    local main_branch=$(get_project_main_branch "$project")
    local branch_name="autopilot/$DATE-$TIME"

    if [ -z "$repo" ] || [ ! -d "$repo" ]; then
        log ERROR "Repository nicht gefunden: $repo"
        return 1
    fi

    cd "$repo" || return 1

    # Check for uncommitted changes
    local changes=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
    if [ "$changes" -gt 0 ]; then
        log WARN "Uncommitted changes detected ($changes files)"
        log INFO "Stashing changes..."
        git stash push -m "autopilot-stash-$DATE-$TIME" 2>/dev/null || true
    fi

    # Ensure we're on main and up to date
    log INFO "Checkout $main_branch..."
    git checkout "$main_branch" 2>/dev/null || {
        log ERROR "Konnte nicht auf $main_branch wechseln"
        return 1
    }

    log INFO "Pull latest..."
    git pull origin "$main_branch" 2>/dev/null || log WARN "Pull fehlgeschlagen (offline?)"

    # Create autopilot branch
    log INFO "Erstelle Branch: $branch_name"
    git checkout -b "$branch_name" 2>/dev/null || {
        log WARN "Branch existiert bereits, wechsle..."
        git checkout "$branch_name" 2>/dev/null || {
            log ERROR "Konnte Branch nicht erstellen/wechseln"
            return 1
        }
    }

    log OK "Branch erstellt: $branch_name"
    echo "$branch_name"
}

#######################################
# Build Context for Claude
#######################################
build_context() {
    local project=$1
    local repo=$(get_project_repo "$project")

    local context=""

    # Global CONTEXT.md
    if [ -f "$AUTOPILOT_DIR/CONTEXT.md" ]; then
        context+="## Developer Context\n"
        context+=$(cat "$AUTOPILOT_DIR/CONTEXT.md")
        context+="\n\n"
    fi

    # Project GOAL.md
    local goal_file="$PROJECTS_DIR/$project/GOAL.md"
    if [ -f "$goal_file" ]; then
        context+="## Project Goal (GOAL.md)\n"
        context+=$(cat "$goal_file")
        context+="\n\n"
    fi

    # Project PLAN.md (if exists)
    local plan_file="$PROJECTS_DIR/$project/PLAN.md"
    if [ -f "$plan_file" ]; then
        context+="## Current Plan (PLAN.md)\n"
        context+=$(cat "$plan_file")
        context+="\n\n"
    fi

    # SYSTEM.md
    if [ -f "$AUTOPILOT_DIR/orchestrator/SYSTEM.md" ]; then
        context+="## System Role\n"
        context+=$(cat "$AUTOPILOT_DIR/orchestrator/SYSTEM.md")
        context+="\n\n"
    fi

    echo -e "$context"
}

#######################################
# Build Mode-Specific Instructions
#######################################
get_mode_instructions() {
    local mode=$1

    case $mode in
        cleanup)
            cat << 'CLEANUP_EOF'
## MODUS: CLEANUP

Du fokussierst dich NUR auf Code-Cleanup:
- Entferne console.log, debugger statements
- Entferne unbenutzten Code (dead code)
- Fixe TypeScript Fehler und `any` Types
- Entferne auskommentierte Code-Blöcke
- Aktualisiere veraltete Imports
- Fixe Linting-Warnings

NICHT in diesem Modus:
- Keine neuen Features
- Keine Architektur-Änderungen
- Keine Refactorings die Verhalten ändern

Commit-Prefix: chore: oder fix:
CLEANUP_EOF
            ;;
        architecture)
            cat << 'ARCH_EOF'
## MODUS: ARCHITECTURE

Du fokussierst dich NUR auf Architektur-Verbesserungen:
- Code-Struktur optimieren
- Duplicate Code eliminieren (DRY)
- Abstraktionen verbessern
- Dependency-Struktur aufräumen
- Module besser trennen
- Circular Dependencies auflösen

NICHT in diesem Modus:
- Keine neuen Features
- Keine Bug-Fixes (außer durch Refactoring)
- Keine Cleanup-Tasks (separate session)

Commit-Prefix: refactor: oder chore:
ARCH_EOF
            ;;
        features)
            cat << 'FEAT_EOF'
## MODUS: FEATURES

Du fokussierst dich NUR auf neue Features:
- Implementiere Tasks aus PLAN.md/GOAL.md
- Schreibe Tests für neue Funktionalität
- Dokumentiere neue APIs
- Füge UI-Elemente hinzu

NICHT in diesem Modus:
- Kein Code-Cleanup (separate session)
- Keine Architektur-Refactorings
- Keine bestehenden Features ändern

Commit-Prefix: feat: oder test:
FEAT_EOF
            ;;
        full)
            cat << 'FULL_EOF'
## MODUS: FULL (Alle Aufgaben)

Du kannst alle Arten von Tasks ausführen:
1. Code Cleanup (console.log, dead code, etc.)
2. Architecture Improvements
3. New Features
4. Bug Fixes
5. Tests
6. Documentation

Priorisierung:
1. Erst Cleanup (stabiles Fundament)
2. Dann Architektur (wenn nötig)
3. Dann Features (aus PLAN.md)

Commit-Prefixes: feat:, fix:, refactor:, chore:, test:, docs:
FULL_EOF
            ;;
    esac
}

#######################################
# Build Execution Prompt
#######################################
build_execution_prompt() {
    local project=$1
    local branch_name=$2

    local mode_instructions=$(get_mode_instructions "$EXECUTION_MODE")

    cat << EOF
Du bist der WerkingFlow Autopilot im AUSFÜHRUNGS-Modus.

## Deine Aufgabe
Arbeite autonom an Projekt '$project' basierend auf dem PLAN.md und GOAL.md.

$mode_instructions

## WICHTIGE REGELN
1. Du arbeitest auf Branch: $branch_name
2. Du darfst committen (NUR auf diesem Branch!)
3. Du darfst NIEMALS auf main/master pushen
4. Erstelle atomic commits mit Conventional Commits
5. Teste deinen Code (wenn Tests existieren)
6. Dokumentiere wichtige Änderungen

## Workflow
1. Lies PLAN.md und GOAL.md
2. Identifiziere den nächsten konkreten Task (passend zum Modus!)
3. Implementiere den Task
4. Teste die Änderung
5. Committe mit sinnvoller Message
6. Wiederhole bis PLAN.md abgearbeitet oder du blockiert bist

## Wenn du blockiert bist
- Schreibe in eine Datei BLOCKED.md was das Problem ist
- Committe diese Datei
- Beende die Session

## Wenn du fertig bist
- Erstelle eine Datei SUMMARY.md mit:
  - Was wurde gemacht
  - Welche Dateien wurden geändert
  - Was sollte als nächstes passieren
- Committe diese Datei
- Beende die Session

## Quality Gates (prüfe vor jedem Commit)
- TypeScript kompiliert (falls TS-Projekt)
- Keine neuen \`any\` Types
- Keine console.log im Production Code
- Tests passen (falls vorhanden)

Los geht's! Starte mit dem Lesen von PLAN.md und GOAL.md.
EOF
}

#######################################
# Status Display (for watch mode)
#######################################
STATUS_PID=""
START_TIME=""

show_status_bar() {
    local project=$1
    local repo=$2
    local log_file=$3

    START_TIME=$(date +%s)

    while true; do
        local now=$(date +%s)
        local elapsed=$((now - START_TIME))
        local mins=$((elapsed / 60))
        local secs=$((elapsed % 60))

        # Count commits on current branch
        local commits=$(cd "$repo" && git rev-list --count HEAD 2>/dev/null || echo "?")

        # Count modified files
        local modified=$(cd "$repo" && git status --porcelain 2>/dev/null | wc -l | tr -d ' ')

        # Log file size
        local log_size="0"
        if [ -f "$log_file" ]; then
            log_size=$(du -h "$log_file" 2>/dev/null | cut -f1)
        fi

        # Clear line and print status
        printf "\r${CYAN}⏱ %02d:%02d${NC} │ ${GREEN}📝 %s files${NC} │ ${BLUE}📋 Log: %s${NC} │ ${YELLOW}Project: %s${NC}   " \
            "$mins" "$secs" "$modified" "$log_size" "$project"

        sleep 2
    done
}

stop_status_bar() {
    if [ -n "$STATUS_PID" ]; then
        kill $STATUS_PID 2>/dev/null || true
        wait $STATUS_PID 2>/dev/null || true
        STATUS_PID=""
        echo ""  # New line after status bar
    fi
}

#######################################
# Run Claude Autonomously
#######################################
run_claude_autonomous() {
    local project=$1
    local repo=$(get_project_repo "$project")
    local branch_name=$2
    local log_file="$LOGS_DIR/$DATE/${project}.log"

    mkdir -p "$(dirname "$log_file")"

    log CLAUDE "Starting autonomous Claude session..."
    log CLAUDE "Timeout: $TIMEOUT_DURATION"
    log CLAUDE "Log: $log_file"

    if [ "$WATCH_MODE" = true ]; then
        log INFO "Watch mode active - Press Ctrl+C to stop"
    fi

    # Build the full prompt
    local context=$(build_context "$project")
    local execution_prompt=$(build_execution_prompt "$project" "$branch_name")

    local full_prompt="
$context

---

$execution_prompt
"

    cd "$repo" || return 1

    if [ "$DRY_RUN" = true ]; then
        log INFO "DRY RUN - Would execute Claude with:"
        echo "$full_prompt" | head -50
        echo "..."
        return 0
    fi

    # Check if Claude CLI is available
    if ! command -v claude &> /dev/null; then
        log ERROR "Claude CLI nicht gefunden. Installiere mit: npm install -g @anthropic-ai/claude-code"
        return 1
    fi

    # Run Claude with timeout and skip permissions
    log EXEC "Starting Claude..."
    echo ""
    echo -e "${CYAN}────────────────── CLAUDE OUTPUT ──────────────────${NC}"
    echo ""

    # Use timeout command (GNU coreutils or macOS)
    local timeout_cmd="timeout"
    if ! command -v timeout &> /dev/null; then
        # macOS alternative using perl
        timeout_cmd="perl -e 'alarm shift; exec @ARGV' $((2*60*60))"
    fi

    # Start status bar in background if watch mode
    if [ "$WATCH_MODE" = true ]; then
        show_status_bar "$project" "$repo" "$log_file" &
        STATUS_PID=$!
    fi

    # Execute Claude - output goes to terminal AND log file
    $timeout_cmd $TIMEOUT_DURATION claude \
        --dangerously-skip-permissions \
        --print \
        "$full_prompt" \
        2>&1 | tee "$log_file"

    local exit_code=$?

    # Stop status bar
    stop_status_bar

    echo ""
    echo -e "${CYAN}────────────────── END CLAUDE OUTPUT ──────────────────${NC}"
    echo ""

    if [ $exit_code -eq 124 ]; then
        log WARN "Claude session timed out after $TIMEOUT_DURATION"
        # Create timeout marker
        echo "Session timed out at $(date)" > "$repo/TIMEOUT.md"
        git add TIMEOUT.md 2>/dev/null && git commit -m "chore: autopilot timeout marker" 2>/dev/null || true
    elif [ $exit_code -ne 0 ]; then
        log ERROR "Claude session failed with exit code $exit_code"
    else
        log OK "Claude session completed successfully"
    fi

    return $exit_code
}

#######################################
# Generate Merge Summary
#######################################
generate_merge_summary() {
    local project=$1
    local repo=$(get_project_repo "$project")
    local branch_name=$2
    local main_branch=$(get_project_main_branch "$project")
    local summary_file="$SUMMARIES_DIR/$project-$DATE-$TIME.md"

    cd "$repo" || return

    # Get commit count on this branch
    local commits=$(git rev-list --count "$main_branch..$branch_name" 2>/dev/null || echo "0")

    # Get files changed
    local files_changed=$(git diff --name-only "$main_branch..$branch_name" 2>/dev/null | wc -l | tr -d ' ')

    # Get commit messages
    local commit_messages=$(git log --oneline "$main_branch..$branch_name" 2>/dev/null || echo "No commits")

    cat > "$summary_file" << EOF
# Merge Summary: $project

**Branch:** $branch_name
**Date:** $DATE
**Time:** $TIME

---

## Statistics

| Metric | Value |
|--------|-------|
| Commits | $commits |
| Files Changed | $files_changed |

---

## Commits

\`\`\`
$commit_messages
\`\`\`

---

## Files Changed

\`\`\`
$(git diff --name-only "$main_branch..$branch_name" 2>/dev/null || echo "None")
\`\`\`

---

## Review Checklist

- [ ] Code reviewed
- [ ] Tests passing
- [ ] No security issues
- [ ] Ready to merge

---

**To merge:**
\`\`\`bash
cd $repo
git checkout $main_branch
git merge $branch_name
git push origin $main_branch
\`\`\`
EOF

    log OK "Merge summary created: $summary_file"
    echo "$summary_file"
}

#######################################
# Execute Project Loop
#######################################
execute_project() {
    local project=$1

    # Mode display string
    local mode_display=""
    case $EXECUTION_MODE in
        cleanup)      mode_display="🧹 CLEANUP" ;;
        architecture) mode_display="🏗️  ARCHITECTURE" ;;
        features)     mode_display="✨ FEATURES" ;;
        full)         mode_display="🔄 FULL" ;;
    esac

    echo ""
    echo -e "${CYAN}╔═══════════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║  Autopilot Loop: $project $(printf '%*s' $((43 - ${#project})) '')║${NC}"
    echo -e "${CYAN}║  Mode: $mode_display $(printf '%*s' $((48 - ${#mode_display})) '')║${NC}"
    echo -e "${CYAN}╚═══════════════════════════════════════════════════════════════════╝${NC}"
    echo ""

    local repo=$(get_project_repo "$project")

    if [ -z "$repo" ] || [ ! -d "$repo" ]; then
        log ERROR "Repository nicht gefunden für: $project"
        return 1
    fi

    log INFO "Repository: $repo"

    # 1. Create autopilot branch
    local branch_name
    branch_name=$(create_autopilot_branch "$project")
    if [ $? -ne 0 ]; then
        log ERROR "Konnte Branch nicht erstellen"
        return 1
    fi

    # 2. Run Claude autonomously
    run_claude_autonomous "$project" "$branch_name"
    local claude_exit=$?

    # 3. Generate merge summary
    generate_merge_summary "$project" "$branch_name"

    # 4. Final status
    echo ""
    echo -e "${CYAN}───────────────────────────────────────────────────────────────────${NC}"
    echo ""

    if [ $claude_exit -eq 0 ]; then
        log OK "Autopilot session für $project abgeschlossen"
        echo ""
        echo -e "${GREEN}Branch $branch_name ist bereit für Review.${NC}"
        echo -e "${YELLOW}Merge manuell nach Review:${NC}"
        echo "  cd $repo"
        echo "  git checkout main && git merge $branch_name"
    else
        log WARN "Autopilot session für $project mit Problemen beendet"
    fi

    echo ""
    return $claude_exit
}

#######################################
# Parse Arguments
#######################################
parse_args() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            --all|-a)
                ALL_PROJECTS=true
                shift
                ;;
            --dry-run|-n)
                DRY_RUN=true
                shift
                ;;
            --timeout|-t)
                TIMEOUT_DURATION="$2"
                shift 2
                ;;
            --verbose|-v)
                VERBOSE=true
                shift
                ;;
            --watch|-w)
                WATCH_MODE=true
                shift
                ;;
            --mode|-m)
                case "$2" in
                    cleanup|clean)
                        EXECUTION_MODE="cleanup"
                        ;;
                    architecture|arch)
                        EXECUTION_MODE="architecture"
                        ;;
                    features|feat)
                        EXECUTION_MODE="features"
                        ;;
                    full|all)
                        EXECUTION_MODE="full"
                        ;;
                    *)
                        echo "Invalid mode: $2"
                        echo "Valid modes: cleanup, architecture, features, full"
                        exit 1
                        ;;
                esac
                shift 2
                ;;
            --help|-h)
                echo "Usage: ./loop.sh [OPTIONS] [PROJECT]"
                echo ""
                echo "Options:"
                echo "  --all, -a            Run on all projects"
                echo "  --dry-run, -n        Don't actually run Claude"
                echo "  --timeout, -t TIME   Set timeout (default: 2h)"
                echo "  --verbose, -v        Show detailed progress"
                echo "  --watch, -w          Watch mode with live status"
                echo "  --mode, -m MODE      Execution mode:"
                echo "                         cleanup      - Only code cleanup tasks"
                echo "                         architecture - Only architecture improvements"
                echo "                         features     - Only new features"
                echo "                         full         - All tasks (default)"
                echo "  --help, -h           Show this help"
                echo ""
                echo "Examples:"
                echo "  ./loop.sh werkflow                   # Full mode"
                echo "  ./loop.sh werkflow --mode cleanup    # Only cleanup"
                echo "  ./loop.sh werkflow --mode arch       # Architecture only"
                echo "  ./loop.sh werkflow --watch           # With live status"
                echo "  ./loop.sh --all --timeout 1h         # All projects, 1h timeout"
                exit 0
                ;;
            *)
                if [ -d "$PROJECTS_DIR/$1" ]; then
                    SINGLE_PROJECT="$1"
                fi
                shift
                ;;
        esac
    done
}

#######################################
# Main
#######################################
main() {
    parse_args "$@"

    echo ""
    echo -e "${CYAN}╔═══════════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║       WerkingFlow Autopilot - Autonomous Execution Loop           ║${NC}"
    echo -e "${CYAN}╚═══════════════════════════════════════════════════════════════════╝${NC}"
    echo ""

    log INFO "Autonomous Loop started at $TIMESTAMP"

    if [ "$DRY_RUN" = true ]; then
        log WARN "DRY RUN MODE - No actual changes will be made"
    fi

    # Get projects to process
    local projects
    if [ "$ALL_PROJECTS" = true ]; then
        projects=($(scan_registry))
        log INFO "Processing all ${#projects[@]} projects"
    elif [ -n "$SINGLE_PROJECT" ]; then
        projects=("$SINGLE_PROJECT")
        log INFO "Processing single project: $SINGLE_PROJECT"
    else
        echo "Error: Specify a project or use --all"
        echo "Available projects: $(scan_registry)"
        exit 1
    fi

    # Execute for each project
    local success_count=0
    local fail_count=0

    for project in "${projects[@]}"; do
        if execute_project "$project"; then
            ((success_count++))
        else
            ((fail_count++))
        fi
    done

    # Final summary
    echo ""
    echo -e "${CYAN}═══════════════════════════════════════════════════════════════════${NC}"
    echo ""
    log OK "Loop completed: $success_count successful, $fail_count failed"

    if [ $fail_count -gt 0 ]; then
        exit 1
    fi
}

# Run
main "$@"
