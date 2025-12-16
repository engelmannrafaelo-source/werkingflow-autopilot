#!/bin/bash
# WerkingFlow Autopilot - Registry-Based Hierarchical Planner
#
# Usage:
#   ./orchestrator/plan.sh              # Interaktiver Modus
#   ./orchestrator/plan.sh --auto       # Automatisch Pläne für alle Projekte
#   ./orchestrator/plan.sh --auto werkflow  # Nur für ein Projekt
#   ./orchestrator/plan.sh --review     # Generierte Pläne reviewen
#
# Der Autopilot scannt die Registry (projects/) und zeigt
# alle Projekte mit ihren adaptiven Levels.
#
# Levels werden PRO PROJEKT in CONFIG.yaml definiert.

set -e

# Mode flags
AUTO_MODE=false
REVIEW_MODE=false
SINGLE_PROJECT=""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
NC='\033[0m' # No Color

# Paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUTOPILOT_DIR="$(dirname "$SCRIPT_DIR")"
PROJECTS_DIR="$AUTOPILOT_DIR/projects"
LOGS_DIR="$AUTOPILOT_DIR/logs"
STATE_FILE="$AUTOPILOT_DIR/.state.json"

# Ensure directories exist
mkdir -p "$LOGS_DIR"

# Current timestamps
DATE=$(date +%Y-%m-%d)
TIMESTAMP=$(date +%H:%M:%S)

#######################################
# Logging
#######################################
log() {
    local level=$1
    shift
    local message="$*"
    local log_file="$LOGS_DIR/$DATE.log"
    echo "[$TIMESTAMP] [$level] $message" >> "$log_file"

    case $level in
        INFO)  echo -e "${BLUE}ℹ${NC}  $message" ;;
        OK)    echo -e "${GREEN}✅${NC} $message" ;;
        WARN)  echo -e "${YELLOW}⚠️${NC}  $message" ;;
        ERROR) echo -e "${RED}❌${NC} $message" ;;
        PLAN)  echo -e "${CYAN}📋${NC} $message" ;;
        SCAN)  echo -e "${MAGENTA}🔍${NC} $message" ;;
    esac
}

#######################################
# State Management
#######################################
save_state() {
    cat > "$STATE_FILE" << EOF
{
    "current_project": "$1",
    "current_level": $2,
    "timestamp": "$(date -Iseconds)",
    "status": "awaiting_approval"
}
EOF
}

load_state() {
    if [ -f "$STATE_FILE" ]; then
        cat "$STATE_FILE"
    else
        echo '{"current_project": null, "current_level": 0}'
    fi
}

#######################################
# Registry Scanner
#######################################
scan_registry() {
    log SCAN "Scanne Registry: $PROJECTS_DIR"
    echo ""

    local projects=()
    for dir in "$PROJECTS_DIR"/*/; do
        local name=$(basename "$dir")
        # Skip template
        if [ "$name" != "_template" ]; then
            projects+=("$name")
        fi
    done

    echo "${projects[@]}"
}

get_project_config() {
    local project=$1
    local config_file="$PROJECTS_DIR/$project/CONFIG.yaml"

    if [ -f "$config_file" ]; then
        cat "$config_file"
    else
        # Fallback: Erzeuge minimale Config aus GOAL.md
        echo "name: \"$project\""
        echo "levels:"
        echo "  - name: \"Ziel\""
        echo "    file: \"GOAL.md\""
    fi
}

get_project_repo() {
    local project=$1

    # Try CONFIG.yaml first
    local config_file="$PROJECTS_DIR/$project/CONFIG.yaml"
    if [ -f "$config_file" ]; then
        grep "^repo:" "$config_file" 2>/dev/null | sed 's/repo: *//' | tr -d '"' | head -1
        return
    fi

    # Fallback to repo.txt
    local repo_file="$PROJECTS_DIR/$project/repo.txt"
    if [ -f "$repo_file" ]; then
        head -1 "$repo_file"
        return
    fi

    echo ""
}

get_project_priority() {
    local project=$1
    local config_file="$PROJECTS_DIR/$project/CONFIG.yaml"

    if [ -f "$config_file" ]; then
        grep "^priority:" "$config_file" 2>/dev/null | sed 's/priority: *//' | head -1
    else
        echo "99"
    fi
}

get_project_levels() {
    local project=$1
    local config_file="$PROJECTS_DIR/$project/CONFIG.yaml"

    if [ -f "$config_file" ]; then
        # Extract level names from CONFIG.yaml
        grep -A1 "  - name:" "$config_file" 2>/dev/null | grep "name:" | sed 's/.*name: *//' | tr -d '"'
    else
        echo "Ziel"
    fi
}

#######################################
# Repository Analysis
#######################################
analyze_repo() {
    local repo_path=$1

    if [ -z "$repo_path" ] || [ ! -d "$repo_path" ]; then
        echo "Repository nicht gefunden"
        return
    fi

    cd "$repo_path" 2>/dev/null || return

    local branch=$(git branch --show-current 2>/dev/null || echo "?")
    local last_commit=$(git log -1 --format='%h %s' 2>/dev/null | head -c 50 || echo "?")
    local changes=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')

    echo "Branch: $branch | Commit: $last_commit | Changes: $changes"
}

#######################################
# Git Operations
#######################################
get_git_branch_prefix() {
    local project=$1
    local config_file="$PROJECTS_DIR/$project/CONFIG.yaml"

    if [ -f "$config_file" ]; then
        grep "branch_prefix:" "$config_file" 2>/dev/null | sed 's/.*branch_prefix: *//' | tr -d '"' | head -1
    else
        echo "$project"
    fi
}

get_git_main_branch() {
    local project=$1
    local config_file="$PROJECTS_DIR/$project/CONFIG.yaml"

    if [ -f "$config_file" ]; then
        local main=$(grep "main_branch:" "$config_file" 2>/dev/null | sed 's/.*main_branch: *//' | tr -d '"' | head -1)
        echo "${main:-main}"
    else
        echo "main"
    fi
}

create_feature_branch() {
    local project=$1
    local feature_name=$2
    local repo_path=$(get_project_repo "$project")

    if [ -z "$repo_path" ] || [ ! -d "$repo_path" ]; then
        log ERROR "Repository nicht gefunden: $repo_path"
        return 1
    fi

    cd "$repo_path" || return 1

    local prefix=$(get_git_branch_prefix "$project")
    local main_branch=$(get_git_main_branch "$project")
    local branch_name="${prefix}/${feature_name}"

    # Check for uncommitted changes
    local changes=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
    if [ "$changes" -gt 0 ]; then
        log WARN "Uncommitted changes detected ($changes files)"
        echo -ne "${YELLOW}Trotzdem Branch erstellen? [y/N]:${NC} "
        read -r confirm
        if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
            log INFO "Abgebrochen"
            return 1
        fi
    fi

    # Ensure we're on main and up to date
    log INFO "Checkout $main_branch..."
    git checkout "$main_branch" 2>/dev/null || {
        log ERROR "Konnte nicht auf $main_branch wechseln"
        return 1
    }

    log INFO "Pull latest..."
    git pull origin "$main_branch" 2>/dev/null || log WARN "Pull fehlgeschlagen (offline?)"

    # Create and checkout feature branch
    log INFO "Erstelle Branch: $branch_name"
    git checkout -b "$branch_name" 2>/dev/null || {
        # Branch exists, just checkout
        log INFO "Branch existiert bereits, wechsle..."
        git checkout "$branch_name" 2>/dev/null || {
            log ERROR "Konnte Branch nicht erstellen/wechseln"
            return 1
        }
    }

    log OK "Branch erstellt: $branch_name"
    return 0
}

#######################################
# Display Functions
#######################################
show_registry_overview() {
    echo ""
    echo -e "${CYAN}╔═══════════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║              WerkingFlow Autopilot - Registry Overview             ║${NC}"
    echo -e "${CYAN}╚═══════════════════════════════════════════════════════════════════╝${NC}"
    echo ""

    local projects=($(scan_registry))

    if [ ${#projects[@]} -eq 0 ]; then
        log WARN "Keine Projekte in Registry gefunden"
        return
    fi

    echo -e "${YELLOW}Projekte in Registry:${NC}"
    echo ""

    for project in "${projects[@]}"; do
        local priority=$(get_project_priority "$project")
        local repo=$(get_project_repo "$project")
        local repo_status=$(analyze_repo "$repo")
        local levels=$(get_project_levels "$project" | wc -l | tr -d ' ')

        echo -e "  ${GREEN}▸ $project${NC} (Prio: $priority, Levels: $levels)"
        echo -e "    ${BLUE}$repo_status${NC}"

        # Show level names
        local level_names=$(get_project_levels "$project" | tr '\n' ' → ' | sed 's/ → $//')
        echo -e "    ${MAGENTA}Levels: $level_names${NC}"
        echo ""
    done

    echo -e "${CYAN}───────────────────────────────────────────────────────────────────${NC}"
    echo ""
}

show_project_detail() {
    local project=$1
    local level=${2:-0}

    local config_file="$PROJECTS_DIR/$project/CONFIG.yaml"
    local goal_file="$PROJECTS_DIR/$project/GOAL.md"

    echo ""
    echo -e "${CYAN}╔═══════════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║  Projekt: $project $(printf '%*s' $((50 - ${#project})) '')║${NC}"
    echo -e "${CYAN}╚═══════════════════════════════════════════════════════════════════╝${NC}"
    echo ""

    # Show repo info
    local repo=$(get_project_repo "$project")
    echo -e "${YELLOW}Repository:${NC} $repo"
    echo -e "${YELLOW}Status:${NC} $(analyze_repo "$repo")"
    echo ""

    # Show levels
    echo -e "${YELLOW}Adaptive Levels:${NC}"
    local level_num=0
    get_project_levels "$project" | while read -r level_name; do
        if [ $level_num -eq $level ]; then
            echo -e "  ${GREEN}→ [$level_num] $level_name${NC} ◄ AKTUELL"
        else
            echo -e "    [$level_num] $level_name"
        fi
        level_num=$((level_num + 1))
    done
    echo ""

    # Show current level content
    if [ -f "$goal_file" ]; then
        echo -e "${CYAN}───────────────────────────────────────────────────────────────────${NC}"
        echo -e "${YELLOW}Inhalt (GOAL.md):${NC}"
        echo ""
        cat "$goal_file" | head -60
        echo ""
        if [ $(wc -l < "$goal_file") -gt 60 ]; then
            echo -e "${BLUE}... ($(wc -l < "$goal_file") Zeilen total)${NC}"
        fi
    fi

    # Show prompts if defined
    if [ -f "$config_file" ] && grep -q "prompts:" "$config_file"; then
        echo ""
        echo -e "${CYAN}───────────────────────────────────────────────────────────────────${NC}"
        echo -e "${YELLOW}Projekt-spezifische Prompts definiert${NC}"
    fi

    echo ""
}

#######################################
# Interactive Menu
#######################################
show_menu() {
    echo -e "${CYAN}───────────────────────────────────────────────────────────────────${NC}"
    echo "Befehle:"
    echo -e "  ${GREEN}list${NC}                      - Registry Overview anzeigen"
    echo -e "  ${GREEN}show [projekt]${NC}            - Projekt-Details anzeigen"
    echo -e "  ${GREEN}plan [projekt|all]${NC}        - Plan generieren (Claude)"
    echo -e "  ${GREEN}review${NC}                    - Generierte Pläne reviewen"
    echo -e "  ${GREEN}deeper [projekt]${NC}          - Nächstes Level für Projekt"
    echo -e "  ${GREEN}branch [projekt] [name]${NC}   - Feature-Branch erstellen"
    echo -e "  ${GREEN}go [projekt]${NC}              - Projekt ausführen (öffnet Repo)"
    echo -e "  ${GREEN}status${NC}                    - Aktuellen Status anzeigen"
    echo -e "  ${GREEN}help${NC}                      - Diese Hilfe"
    echo -e "  ${GREEN}exit${NC}                      - Beenden"
    echo -e "${CYAN}───────────────────────────────────────────────────────────────────${NC}"
    echo ""
}

interactive_mode() {
    show_registry_overview
    show_menu

    while true; do
        echo -ne "${YELLOW}autopilot>${NC} "
        read -r command args

        case $command in
            list|List|LIST|l)
                show_registry_overview
                ;;

            show|Show|SHOW|s)
                if [ -n "$args" ]; then
                    show_project_detail "$args"
                else
                    echo "Usage: show [projekt-name]"
                    echo "Verfügbar: $(scan_registry)"
                fi
                ;;

            plan|Plan|PLAN|p)
                if ! check_claude; then
                    echo "Claude CLI nicht verfügbar"
                else
                    if [ "$args" = "all" ] || [ "$args" = "alle" ]; then
                        local projects=($(scan_registry))
                        for project in "${projects[@]}"; do
                            generate_plan_for_project "$project"
                        done
                    elif [ -n "$args" ]; then
                        generate_plan_for_project "$args"
                    else
                        echo "Usage: plan [projekt-name|all]"
                        echo "Verfügbar: $(scan_registry)"
                    fi
                fi
                ;;

            review|Review|REVIEW|r)
                review_mode
                ;;

            deeper|Deeper|DEEPER|d)
                if [ -n "$args" ]; then
                    # Get current level from state, increment
                    local current_level=$(cat "$STATE_FILE" 2>/dev/null | grep "current_level" | grep -o '[0-9]*' || echo "0")
                    local new_level=$((current_level + 1))
                    save_state "$args" "$new_level"
                    show_project_detail "$args" "$new_level"
                else
                    echo "Usage: deeper [projekt-name]"
                fi
                ;;

            branch|Branch|BRANCH|b)
                local project=$(echo "$args" | awk '{print $1}')
                local feature=$(echo "$args" | awk '{print $2}')

                if [ -n "$project" ] && [ -n "$feature" ]; then
                    create_feature_branch "$project" "$feature"
                else
                    echo "Usage: branch [projekt] [feature-name]"
                    echo "Beispiel: branch werkflow auth-refactor"
                fi
                ;;

            go|Go|GO|g)
                if [ -n "$args" ]; then
                    local repo=$(get_project_repo "$args")
                    if [ -n "$repo" ] && [ -d "$repo" ]; then
                        log OK "Starte Arbeit an: $args"

                        # Ask if user wants to create a branch
                        echo ""
                        echo -ne "${YELLOW}Feature-Branch erstellen? [name/N]:${NC} "
                        read -r branch_name

                        if [ -n "$branch_name" ] && [ "$branch_name" != "n" ] && [ "$branch_name" != "N" ]; then
                            create_feature_branch "$args" "$branch_name"
                        fi

                        echo ""
                        echo -e "${GREEN}Nächste Schritte:${NC}"
                        echo "  1. cd $repo"
                        echo "  2. claude  # Starte Claude Code"
                        echo ""

                        local current_branch=$(cd "$repo" && git branch --show-current 2>/dev/null || echo "?")
                        echo -e "${BLUE}Aktueller Branch: $current_branch${NC}"
                        echo -e "${YELLOW}Claude wird automatisch GOAL.md und CONFIG.yaml lesen.${NC}"
                    else
                        log ERROR "Repository nicht gefunden: $repo"
                    fi
                else
                    echo "Usage: go [projekt-name]"
                fi
                ;;

            status|Status|STATUS)
                echo ""
                echo "State:"
                load_state
                echo ""
                echo "Registry: $(scan_registry | wc -w | tr -d ' ') Projekte"
                ;;

            help|Help|HELP|h|?)
                show_menu
                ;;

            exit|Exit|EXIT|quit|q)
                log INFO "Autopilot beendet"
                exit 0
                ;;

            "")
                # Empty input
                ;;

            *)
                echo "Unbekannt: $command - Tippe 'help'"
                ;;
        esac
    done
}

#######################################
# Claude Integration
#######################################
check_claude() {
    if ! command -v claude &> /dev/null; then
        log ERROR "Claude CLI nicht gefunden. Installiere mit: npm install -g @anthropic-ai/claude-code"
        return 1
    fi
    return 0
}

generate_plan_for_project() {
    local project=$1
    local goal_file="$PROJECTS_DIR/$project/GOAL.md"
    local config_file="$PROJECTS_DIR/$project/CONFIG.yaml"
    local plan_file="$PROJECTS_DIR/$project/PLAN.md"
    local repo=$(get_project_repo "$project")

    if [ ! -f "$goal_file" ]; then
        log ERROR "$project: GOAL.md nicht gefunden"
        return 1
    fi

    log PLAN "$project: Generiere Plan..."

    # Build context for Claude
    local context_file="$AUTOPILOT_DIR/CONTEXT.md"
    local system_file="$AUTOPILOT_DIR/orchestrator/SYSTEM.md"

    # Read project-specific prompts if available
    local analyze_prompt=""
    if [ -f "$config_file" ]; then
        analyze_prompt=$(sed -n '/prompts:/,/^[^ ]/p' "$config_file" | grep -A20 "analyze:" | tail -n +2 | sed '/^[^ ]/,$d' | sed 's/^    //')
    fi

    # Default analyze prompt if none defined
    if [ -z "$analyze_prompt" ]; then
        analyze_prompt="Analysiere dieses Projekt basierend auf GOAL.md. Was ist der aktuelle Stand? Was fehlt noch? Erstelle einen konkreten Plan für die nächsten Schritte."
    fi

    # Prepare the prompt
    local full_prompt="
Du bist der WerkingFlow Autopilot.

## Deine Aufgabe
Erstelle einen PLAN.md für das Projekt '$project'.

## Kontext
$(cat "$context_file" 2>/dev/null || echo "Kein CONTEXT.md gefunden")

## Projekt-Ziel (GOAL.md)
$(cat "$goal_file")

## Projekt-Konfiguration
$(cat "$config_file" 2>/dev/null || echo "Keine CONFIG.yaml")

## Repository-Status
Pfad: $repo
$(analyze_repo "$repo")

## Projekt-spezifischer Analyse-Prompt
$analyze_prompt

## Output-Format
Erstelle einen strukturierten Plan im Markdown-Format:

\`\`\`markdown
# Plan: $project - $(date +%Y-%m-%d)

## Analyse
### Aktueller Stand
[Was existiert bereits]

### Lücken zu GOAL.md
[Was fehlt noch laut Erfolgskriterien]

## Geplante Arbeit

### Priorität 1 (Kritisch)
- [ ] [Task 1]
- [ ] [Task 2]

### Priorität 2 (Wichtig)
- [ ] [Task 3]

### Priorität 3 (Nice-to-have)
- [ ] [Task 4]

## Empfohlene Reihenfolge
1. [Zuerst]
2. [Dann]
3. [Danach]

## Geschätzte Komplexität
[Einfach/Mittel/Komplex] - [Begründung]

## Nächster konkreter Schritt
[Ein einzelner, sofort ausführbarer Schritt]
\`\`\`

Antworte NUR mit dem Markdown-Plan, keine Erklärungen drumherum.
"

    # Call Claude CLI
    local plan_output
    plan_output=$(cd "$repo" 2>/dev/null && claude --print "$full_prompt" 2>&1) || {
        log ERROR "$project: Claude-Aufruf fehlgeschlagen"
        echo "$plan_output" >> "$LOGS_DIR/$DATE.log"
        return 1
    }

    # Save plan
    echo "$plan_output" > "$plan_file"
    log OK "$project: PLAN.md erstellt"

    return 0
}

#######################################
# Auto Mode
#######################################
auto_mode() {
    echo ""
    echo -e "${CYAN}╔═══════════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║           WerkingFlow Autopilot - Automatischer Modus             ║${NC}"
    echo -e "${CYAN}╚═══════════════════════════════════════════════════════════════════╝${NC}"
    echo ""

    # Check Claude is available
    if ! check_claude; then
        exit 1
    fi

    # Get projects to process
    local projects
    if [ -n "$SINGLE_PROJECT" ]; then
        projects=("$SINGLE_PROJECT")
        log INFO "Verarbeite einzelnes Projekt: $SINGLE_PROJECT"
    else
        projects=($(scan_registry))
        log INFO "Verarbeite alle ${#projects[@]} Projekte"
    fi

    echo ""

    # Process each project
    local success_count=0
    local fail_count=0

    for project in "${projects[@]}"; do
        if generate_plan_for_project "$project"; then
            ((success_count++))
        else
            ((fail_count++))
        fi
    done

    echo ""
    echo -e "${CYAN}───────────────────────────────────────────────────────────────────${NC}"
    echo ""
    log OK "Fertig! $success_count Pläne erstellt"
    if [ $fail_count -gt 0 ]; then
        log WARN "$fail_count Projekte fehlgeschlagen"
    fi

    echo ""
    echo -e "${GREEN}Nächste Schritte:${NC}"
    echo "  ./plan.sh --review          # Pläne reviewen"
    echo "  ./plan.sh                   # Interaktiv weiterarbeiten"
    echo ""
}

#######################################
# Review Mode
#######################################
review_mode() {
    echo ""
    echo -e "${CYAN}╔═══════════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║           WerkingFlow Autopilot - Plan Review                     ║${NC}"
    echo -e "${CYAN}╚═══════════════════════════════════════════════════════════════════╝${NC}"
    echo ""

    local projects=($(scan_registry))
    local plans_found=0

    for project in "${projects[@]}"; do
        local plan_file="$PROJECTS_DIR/$project/PLAN.md"
        if [ -f "$plan_file" ]; then
            ((plans_found++))
            local mod_time=$(stat -f "%Sm" -t "%Y-%m-%d %H:%M" "$plan_file" 2>/dev/null || stat -c "%y" "$plan_file" 2>/dev/null | cut -d'.' -f1)
            echo -e "${GREEN}▸ $project${NC} - PLAN.md vorhanden (${mod_time})"
        else
            echo -e "${YELLOW}○ $project${NC} - Kein Plan"
        fi
    done

    echo ""

    if [ $plans_found -eq 0 ]; then
        log WARN "Keine Pläne gefunden. Führe zuerst --auto aus."
        return
    fi

    echo -e "${CYAN}───────────────────────────────────────────────────────────────────${NC}"
    echo ""
    echo -ne "${YELLOW}Welchen Plan anzeigen? [projekt-name/alle/exit]:${NC} "
    read -r choice

    case $choice in
        alle|all|a)
            for project in "${projects[@]}"; do
                local plan_file="$PROJECTS_DIR/$project/PLAN.md"
                if [ -f "$plan_file" ]; then
                    echo ""
                    echo -e "${CYAN}════════════════════════════════════════════════════════════════════${NC}"
                    echo -e "${GREEN}$project${NC}"
                    echo -e "${CYAN}════════════════════════════════════════════════════════════════════${NC}"
                    cat "$plan_file"
                fi
            done
            ;;
        exit|e|q)
            return
            ;;
        "")
            return
            ;;
        *)
            local plan_file="$PROJECTS_DIR/$choice/PLAN.md"
            if [ -f "$plan_file" ]; then
                echo ""
                cat "$plan_file"
                echo ""
                echo -e "${CYAN}───────────────────────────────────────────────────────────────────${NC}"
                echo -ne "${YELLOW}Optionen: [go] Ausführen | [deeper] Mehr Details | [edit] Bearbeiten | [exit]:${NC} "
                read -r action
                case $action in
                    go|g)
                        log OK "Starte Ausführung für $choice"
                        local repo=$(get_project_repo "$choice")
                        echo -e "${GREEN}Nächste Schritte:${NC}"
                        echo "  1. cd $repo"
                        echo "  2. claude  # Claude wird PLAN.md lesen und ausführen"
                        ;;
                    deeper|d)
                        log INFO "Generiere detaillierten Plan für $choice..."
                        # Could call generate_plan with deeper flag
                        ;;
                    edit|e)
                        ${EDITOR:-nano} "$plan_file"
                        ;;
                esac
            else
                log ERROR "Plan nicht gefunden: $choice"
            fi
            ;;
    esac
}

#######################################
# Main
#######################################
show_usage() {
    echo "Usage: ./plan.sh [OPTIONS] [PROJECT]"
    echo ""
    echo "Options:"
    echo "  --auto [projekt]    Automatisch Pläne generieren (alle oder einzeln)"
    echo "  --review            Generierte Pläne reviewen"
    echo "  --help              Diese Hilfe anzeigen"
    echo ""
    echo "Ohne Optionen: Interaktiver Modus"
}

parse_args() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            --auto|-a)
                AUTO_MODE=true
                if [[ -n "$2" && ! "$2" =~ ^-- ]]; then
                    SINGLE_PROJECT="$2"
                    shift
                fi
                shift
                ;;
            --review|-r)
                REVIEW_MODE=true
                shift
                ;;
            --help|-h)
                show_usage
                exit 0
                ;;
            *)
                # Unknown option or project name
                if [ -d "$PROJECTS_DIR/$1" ]; then
                    SINGLE_PROJECT="$1"
                fi
                shift
                ;;
        esac
    done
}

main() {
    parse_args "$@"

    log INFO "WerkingFlow Autopilot gestartet"
    log SCAN "Registry: $PROJECTS_DIR"

    if [ "$AUTO_MODE" = true ]; then
        auto_mode
    elif [ "$REVIEW_MODE" = true ]; then
        review_mode
    else
        interactive_mode
    fi
}

# Run
main "$@"
