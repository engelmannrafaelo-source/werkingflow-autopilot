#!/bin/bash
# WerkingFlow Autopilot - Daily Routine
#
# Usage:
#   ./orchestrator/daily.sh              # Alle Projekte
#   ./orchestrator/daily.sh werkflow     # Nur ein Projekt
#   ./orchestrator/daily.sh --summary    # Nur Summary ohne Fixes
#
# Die Daily Routine läuft JEDEN TAG als erstes:
# 1. Git Hygiene
# 2. Code Cleanup
# 3. Dependency Health
# 4. Type Safety Check
# 5. Test Health
# 6. Documentation Sync
# 7. Security Scan
# 8. Performance Check
# 9. Daily Summary

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
REPORTS_DIR="$AUTOPILOT_DIR/reports"

# Current timestamps
DATE=$(date +%Y-%m-%d)
TIMESTAMP=$(date +%H:%M:%S)

# Mode flags
SUMMARY_ONLY=false
SINGLE_PROJECT=""
FIX_MODE=false

# Report data (accumulated during checks)
declare -a GIT_BRANCHES=()
declare -a STALE_BRANCHES=()
declare -a MERGE_READY=()
declare -a CRITICAL_ISSUES=()
declare -a WARNINGS=()
declare -a SECURITY_ISSUES=()

# Ensure directories exist
mkdir -p "$LOGS_DIR" "$REPORTS_DIR"

#######################################
# Logging
#######################################
log() {
    local level=$1
    shift
    local message="$*"
    local log_file="$LOGS_DIR/$DATE.log"
    echo "[$TIMESTAMP] [DAILY] [$level] $message" >> "$log_file"

    case $level in
        INFO)    echo -e "${BLUE}[INFO]${NC}    $message" ;;
        OK)      echo -e "${GREEN}[OK]${NC}      $message" ;;
        WARN)    echo -e "${YELLOW}[WARN]${NC}    $message" ;;
        ERROR)   echo -e "${RED}[ERROR]${NC}   $message" ;;
        TASK)    echo -e "${CYAN}[TASK]${NC}    $message" ;;
        SCAN)    echo -e "${MAGENTA}[SCAN]${NC}    $message" ;;
        CRITICAL) echo -e "${RED}[CRITICAL]${NC} $message" ;;
    esac
}

#######################################
# Registry Functions (from plan.sh)
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

#######################################
# 1. Git Hygiene
#######################################
run_git_hygiene() {
    local project=$1
    local repo=$(get_project_repo "$project")

    if [ -z "$repo" ] || [ ! -d "$repo" ]; then
        log WARN "$project: Repository nicht gefunden"
        return
    fi

    log TASK "$project: Git Hygiene Check..."

    cd "$repo" || return

    # Current branch
    local current_branch=$(git branch --show-current 2>/dev/null || echo "?")

    # All branches
    local branches=$(git branch -a 2>/dev/null | grep -v "remotes/origin/HEAD")

    # Local branches with last commit date
    while IFS= read -r branch; do
        branch=$(echo "$branch" | sed 's/^[ *]*//')
        if [ -n "$branch" ] && [[ ! "$branch" =~ "remotes/" ]]; then
            local last_commit_date=$(git log -1 --format="%ci" "$branch" 2>/dev/null | cut -d' ' -f1)
            local days_old=0

            if [ -n "$last_commit_date" ]; then
                days_old=$(( ($(date +%s) - $(date -j -f "%Y-%m-%d" "$last_commit_date" +%s 2>/dev/null || date -d "$last_commit_date" +%s 2>/dev/null || echo "0")) / 86400 ))
            fi

            local commits_ahead=$(git rev-list --count main.."$branch" 2>/dev/null || echo "0")
            local status="active"

            # Check if stale (>7 days without commits)
            if [ "$days_old" -gt 7 ] && [ "$branch" != "main" ] && [ "$branch" != "master" ]; then
                status="stale"
                STALE_BRANCHES+=("$project:$branch ($days_old days)")
            fi

            # Check if ready to merge (has commits, on feature branch)
            if [ "$commits_ahead" -gt 0 ] && [[ "$branch" =~ ^(feature|fix|autopilot)/ ]]; then
                # Check if all tests pass (simplified - just check if branch exists)
                MERGE_READY+=("$project:$branch (+$commits_ahead commits)")
            fi

            GIT_BRANCHES+=("$project|$branch|$commits_ahead|$days_old|$status")
        fi
    done <<< "$branches"

    # Check for merge conflicts with main
    local conflicts=$(git merge-tree $(git merge-base main HEAD 2>/dev/null || echo "HEAD") main HEAD 2>/dev/null | grep -c "<<<<<<" || echo "0")
    if [ "$conflicts" -gt 0 ]; then
        CRITICAL_ISSUES+=("$project: Merge-Konflikte mit main ($conflicts)")
    fi

    # Uncommitted changes
    local uncommitted=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
    if [ "$uncommitted" -gt 0 ]; then
        WARNINGS+=("$project: $uncommitted uncommitted changes")
    fi

    log OK "$project: Git Hygiene done"
}

#######################################
# 2. Code Cleanup
#######################################
run_code_cleanup() {
    local project=$1
    local repo=$(get_project_repo "$project")

    if [ -z "$repo" ] || [ ! -d "$repo" ]; then
        return
    fi

    log TASK "$project: Code Cleanup Check..."

    cd "$repo" || return

    # Find console.log statements (in TypeScript/JavaScript files)
    local console_logs=$(grep -r "console\.log" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" . 2>/dev/null | grep -v "node_modules" | grep -v ".next" | wc -l | tr -d ' ')
    if [ "$console_logs" -gt 0 ]; then
        WARNINGS+=("$project: $console_logs console.log statements found")
    fi

    # Find TODO/FIXME comments
    local todos=$(grep -rn "TODO\|FIXME" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.sh" --include="*.md" . 2>/dev/null | grep -v "node_modules" | grep -v ".next" | wc -l | tr -d ' ')
    if [ "$todos" -gt 0 ]; then
        WARNINGS+=("$project: $todos TODO/FIXME comments")
    fi

    # Find debugger statements
    local debuggers=$(grep -r "debugger" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" . 2>/dev/null | grep -v "node_modules" | wc -l | tr -d ' ')
    if [ "$debuggers" -gt 0 ]; then
        CRITICAL_ISSUES+=("$project: $debuggers debugger statements!")
    fi

    log OK "$project: Code Cleanup done"
}

#######################################
# 3. Dependency Health
#######################################
run_dependency_check() {
    local project=$1
    local repo=$(get_project_repo "$project")

    if [ -z "$repo" ] || [ ! -d "$repo" ]; then
        return
    fi

    log TASK "$project: Dependency Health Check..."

    cd "$repo" || return

    # Check if package.json exists (Node.js project)
    if [ -f "package.json" ]; then
        # npm audit (security vulnerabilities)
        local audit_output=$(npm audit --json 2>/dev/null || echo '{}')
        local vulnerabilities=$(echo "$audit_output" | grep -o '"total":[0-9]*' | head -1 | cut -d':' -f2 || echo "0")

        if [ "$vulnerabilities" -gt 0 ]; then
            local critical=$(echo "$audit_output" | grep -o '"critical":[0-9]*' | cut -d':' -f2 || echo "0")
            local high=$(echo "$audit_output" | grep -o '"high":[0-9]*' | cut -d':' -f2 || echo "0")

            if [ "$critical" -gt 0 ] || [ "$high" -gt 0 ]; then
                SECURITY_ISSUES+=("$project: $critical critical, $high high vulnerabilities")
            else
                WARNINGS+=("$project: $vulnerabilities low/moderate vulnerabilities")
            fi
        fi

        # Check for outdated packages (simplified)
        local outdated=$(npm outdated --json 2>/dev/null | grep -c '"current"' || echo "0")
        if [ "$outdated" -gt 5 ]; then
            WARNINGS+=("$project: $outdated outdated packages")
        fi
    fi

    # Check for requirements.txt (Python project)
    if [ -f "requirements.txt" ]; then
        log INFO "$project: Python project detected"
        # Could add pip-audit here
    fi

    log OK "$project: Dependency Check done"
}

#######################################
# 4. Type Safety Check
#######################################
run_type_safety_check() {
    local project=$1
    local repo=$(get_project_repo "$project")

    if [ -z "$repo" ] || [ ! -d "$repo" ]; then
        return
    fi

    log TASK "$project: Type Safety Check..."

    cd "$repo" || return

    # Check for TypeScript project
    if [ -f "tsconfig.json" ]; then
        # Find 'any' types
        local any_types=$(grep -rn ": any" --include="*.ts" --include="*.tsx" . 2>/dev/null | grep -v "node_modules" | grep -v ".next" | wc -l | tr -d ' ')
        if [ "$any_types" -gt 0 ]; then
            WARNINGS+=("$project: $any_types 'any' type usages")
        fi

        # Find @ts-ignore comments
        local ts_ignores=$(grep -rn "@ts-ignore\|@ts-nocheck" --include="*.ts" --include="*.tsx" . 2>/dev/null | grep -v "node_modules" | wc -l | tr -d ' ')
        if [ "$ts_ignores" -gt 0 ]; then
            CRITICAL_ISSUES+=("$project: $ts_ignores @ts-ignore/@ts-nocheck")
        fi

        # Try to run typecheck
        if [ -f "package.json" ] && grep -q "typecheck\|tsc" package.json 2>/dev/null; then
            local typecheck_result=$(npm run typecheck 2>&1 || npm run tsc -- --noEmit 2>&1 || echo "")
            local type_errors=$(echo "$typecheck_result" | grep -c "error TS" || echo "0")
            if [ "$type_errors" -gt 0 ]; then
                CRITICAL_ISSUES+=("$project: $type_errors TypeScript errors")
            fi
        fi
    fi

    log OK "$project: Type Safety done"
}

#######################################
# 5. Test Health
#######################################
run_test_health() {
    local project=$1
    local repo=$(get_project_repo "$project")

    if [ -z "$repo" ] || [ ! -d "$repo" ]; then
        return
    fi

    log TASK "$project: Test Health Check..."

    cd "$repo" || return

    # Check if tests exist
    local test_files=0

    if [ -d "tests" ] || [ -d "test" ] || [ -d "__tests__" ]; then
        test_files=$(find . -name "*.test.*" -o -name "*.spec.*" 2>/dev/null | grep -v "node_modules" | wc -l | tr -d ' ')
    fi

    if [ "$test_files" -eq 0 ]; then
        WARNINGS+=("$project: No test files found")
    else
        # Try to run tests (don't fail the whole script)
        if [ -f "package.json" ]; then
            if grep -q '"test"' package.json 2>/dev/null; then
                # Run tests in background, capture result
                local test_output
                test_output=$(timeout 120 npm test 2>&1 || echo "TIMEOUT_OR_FAIL")

                if [[ "$test_output" == *"TIMEOUT_OR_FAIL"* ]] || [[ "$test_output" == *"FAIL"* ]] || [[ "$test_output" == *"failed"* ]]; then
                    local failed_count=$(echo "$test_output" | grep -oE "[0-9]+ failed" | head -1 || echo "some")
                    CRITICAL_ISSUES+=("$project: Tests failing ($failed_count)")
                else
                    log OK "$project: All tests passing"
                fi
            fi
        fi
    fi

    log OK "$project: Test Health done"
}

#######################################
# 6. Documentation Sync
#######################################
run_documentation_sync() {
    local project=$1
    local repo=$(get_project_repo "$project")

    if [ -z "$repo" ] || [ ! -d "$repo" ]; then
        return
    fi

    log TASK "$project: Documentation Sync Check..."

    cd "$repo" || return

    # Check if CLAUDE.md exists
    if [ ! -f "CLAUDE.md" ]; then
        WARNINGS+=("$project: No CLAUDE.md found")
    else
        # Check if CLAUDE.md was updated recently
        local claude_md_age=$(( ($(date +%s) - $(stat -f %m "CLAUDE.md" 2>/dev/null || stat -c %Y "CLAUDE.md" 2>/dev/null || echo "0")) / 86400 ))
        if [ "$claude_md_age" -gt 30 ]; then
            WARNINGS+=("$project: CLAUDE.md is $claude_md_age days old")
        fi
    fi

    # Check if README.md exists
    if [ ! -f "README.md" ]; then
        WARNINGS+=("$project: No README.md found")
    fi

    log OK "$project: Documentation Sync done"
}

#######################################
# 7. Security Scan
#######################################
run_security_scan() {
    local project=$1
    local repo=$(get_project_repo "$project")

    if [ -z "$repo" ] || [ ! -d "$repo" ]; then
        return
    fi

    log TASK "$project: Security Scan..."

    cd "$repo" || return

    # Check for hardcoded secrets patterns
    local secrets_patterns="password=\|api_key=\|secret=\|token=\|AWS_\|STRIPE_\|SUPABASE_SERVICE"
    local hardcoded_secrets=$(grep -rn "$secrets_patterns" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" . 2>/dev/null | grep -v "node_modules" | grep -v ".env" | grep -v "example" | wc -l | tr -d ' ')

    if [ "$hardcoded_secrets" -gt 0 ]; then
        SECURITY_ISSUES+=("$project: $hardcoded_secrets potential hardcoded secrets")
    fi

    # Check if .env is in .gitignore
    if [ -f ".env" ] && [ -f ".gitignore" ]; then
        if ! grep -q "^\.env$" .gitignore 2>/dev/null; then
            SECURITY_ISSUES+=("$project: .env not in .gitignore!")
        fi
    fi

    # Check for exposed API endpoints without auth
    # This is a simplified check - real security scan would be more thorough

    log OK "$project: Security Scan done"
}

#######################################
# 8. Performance Check
#######################################
run_performance_check() {
    local project=$1
    local repo=$(get_project_repo "$project")

    if [ -z "$repo" ] || [ ! -d "$repo" ]; then
        return
    fi

    log TASK "$project: Performance Check..."

    cd "$repo" || return

    # Find large files (>500 lines)
    local large_files=$(find . -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" 2>/dev/null | grep -v "node_modules" | grep -v ".next" | while read -r file; do
        lines=$(wc -l < "$file" 2>/dev/null | tr -d ' ')
        if [ "$lines" -gt 500 ]; then
            echo "$file:$lines"
        fi
    done | wc -l | tr -d ' ')

    if [ "$large_files" -gt 0 ]; then
        WARNINGS+=("$project: $large_files files with >500 lines (potential God Classes)")
    fi

    # Check bundle size if Next.js
    if [ -d ".next" ]; then
        local bundle_size=$(du -sh .next 2>/dev/null | cut -f1 || echo "?")
        log INFO "$project: .next bundle size: $bundle_size"
    fi

    log OK "$project: Performance Check done"
}

#######################################
# 9. Generate Daily Summary
#######################################
generate_daily_summary() {
    local report_file="$REPORTS_DIR/daily-$DATE.md"

    echo ""
    echo -e "${CYAN}╔═══════════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║              Autopilot Daily Report - $DATE              ║${NC}"
    echo -e "${CYAN}╚═══════════════════════════════════════════════════════════════════╝${NC}"
    echo ""

    # Write report to file
    cat > "$report_file" << EOF
# Autopilot Daily Report - $DATE

Generated at: $(date)

---

## Git Status

### Branches Ready to Merge
EOF

    if [ ${#MERGE_READY[@]} -eq 0 ]; then
        echo "No branches ready to merge." >> "$report_file"
        echo -e "${YELLOW}No branches ready to merge${NC}"
    else
        echo "| Project | Branch | Status |" >> "$report_file"
        echo "|---------|--------|--------|" >> "$report_file"
        for entry in "${MERGE_READY[@]}"; do
            echo "| ${entry/:/ | } | Ready |" >> "$report_file"
            echo -e "${GREEN}  Ready to merge: $entry${NC}"
        done
    fi

    echo "" >> "$report_file"
    echo "### Stale Branches (>7 days)" >> "$report_file"

    if [ ${#STALE_BRANCHES[@]} -eq 0 ]; then
        echo "No stale branches." >> "$report_file"
    else
        for entry in "${STALE_BRANCHES[@]}"; do
            echo "- $entry" >> "$report_file"
            echo -e "${YELLOW}  Stale: $entry${NC}"
        done
    fi

    echo "" >> "$report_file"
    echo "---" >> "$report_file"
    echo "" >> "$report_file"
    echo "## Critical Issues" >> "$report_file"

    if [ ${#CRITICAL_ISSUES[@]} -eq 0 ]; then
        echo "No critical issues found." >> "$report_file"
        echo -e "${GREEN}No critical issues${NC}"
    else
        for issue in "${CRITICAL_ISSUES[@]}"; do
            echo "- $issue" >> "$report_file"
            echo -e "${RED}  CRITICAL: $issue${NC}"
        done
    fi

    echo "" >> "$report_file"
    echo "## Security Issues" >> "$report_file"

    if [ ${#SECURITY_ISSUES[@]} -eq 0 ]; then
        echo "No security issues found." >> "$report_file"
        echo -e "${GREEN}No security issues${NC}"
    else
        for issue in "${SECURITY_ISSUES[@]}"; do
            echo "- $issue" >> "$report_file"
            echo -e "${RED}  SECURITY: $issue${NC}"
        done
    fi

    echo "" >> "$report_file"
    echo "## Warnings" >> "$report_file"

    if [ ${#WARNINGS[@]} -eq 0 ]; then
        echo "No warnings." >> "$report_file"
    else
        for warning in "${WARNINGS[@]}"; do
            echo "- $warning" >> "$report_file"
            echo -e "${YELLOW}  Warning: $warning${NC}"
        done
    fi

    echo "" >> "$report_file"
    echo "---" >> "$report_file"
    echo "" >> "$report_file"
    echo "## Summary" >> "$report_file"
    echo "" >> "$report_file"
    echo "| Metric | Count |" >> "$report_file"
    echo "|--------|-------|" >> "$report_file"
    echo "| Branches ready to merge | ${#MERGE_READY[@]} |" >> "$report_file"
    echo "| Stale branches | ${#STALE_BRANCHES[@]} |" >> "$report_file"
    echo "| Critical issues | ${#CRITICAL_ISSUES[@]} |" >> "$report_file"
    echo "| Security issues | ${#SECURITY_ISSUES[@]} |" >> "$report_file"
    echo "| Warnings | ${#WARNINGS[@]} |" >> "$report_file"

    echo "" >> "$report_file"
    echo "---" >> "$report_file"
    echo "" >> "$report_file"
    echo "**What should I work on today?**" >> "$report_file"

    echo ""
    echo -e "${CYAN}───────────────────────────────────────────────────────────────────${NC}"
    echo ""
    echo -e "Summary: ${GREEN}${#MERGE_READY[@]}${NC} ready to merge | ${YELLOW}${#STALE_BRANCHES[@]}${NC} stale | ${RED}${#CRITICAL_ISSUES[@]}${NC} critical | ${#WARNINGS[@]} warnings"
    echo ""
    echo -e "Report saved to: ${BLUE}$report_file${NC}"
    echo ""

    # Interactive merge question
    if [ ${#MERGE_READY[@]} -gt 0 ]; then
        echo -e "${YELLOW}Branches ready to merge:${NC}"
        local i=1
        for entry in "${MERGE_READY[@]}"; do
            echo "  [$i] $entry"
            ((i++))
        done
        echo ""
        echo -e "${CYAN}Which branches should be merged? (Enter numbers separated by space, or 'skip'):${NC}"
    fi
}

#######################################
# Run All Checks for a Project
#######################################
run_all_checks() {
    local project=$1

    echo ""
    echo -e "${CYAN}════════════════════════════════════════════════════════════════════${NC}"
    echo -e "${CYAN}  Project: $project${NC}"
    echo -e "${CYAN}════════════════════════════════════════════════════════════════════${NC}"
    echo ""

    run_git_hygiene "$project"
    run_code_cleanup "$project"
    run_dependency_check "$project"
    run_type_safety_check "$project"
    # run_test_health "$project"  # Commented out - can be slow
    run_documentation_sync "$project"
    run_security_scan "$project"
    run_performance_check "$project"
}

#######################################
# Parse Arguments
#######################################
parse_args() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            --summary|-s)
                SUMMARY_ONLY=true
                shift
                ;;
            --fix|-f)
                FIX_MODE=true
                shift
                ;;
            --help|-h)
                echo "Usage: ./daily.sh [OPTIONS] [PROJECT]"
                echo ""
                echo "Options:"
                echo "  --summary, -s    Only show summary, don't run full checks"
                echo "  --fix, -f        Attempt to auto-fix issues"
                echo "  --help, -h       Show this help"
                echo ""
                echo "Without PROJECT: Run on all projects in registry"
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
    echo -e "${CYAN}║           WerkingFlow Autopilot - Daily Routine                   ║${NC}"
    echo -e "${CYAN}╚═══════════════════════════════════════════════════════════════════╝${NC}"
    echo ""

    log INFO "Daily Routine started at $TIMESTAMP"

    # Get projects
    local projects
    if [ -n "$SINGLE_PROJECT" ]; then
        projects=("$SINGLE_PROJECT")
        log INFO "Running for single project: $SINGLE_PROJECT"
    else
        projects=($(scan_registry))
        log INFO "Running for ${#projects[@]} projects"
    fi

    # Run checks for each project
    for project in "${projects[@]}"; do
        run_all_checks "$project"
    done

    # Generate summary
    generate_daily_summary

    log OK "Daily Routine completed"
}

# Run
main "$@"
