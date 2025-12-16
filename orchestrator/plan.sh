#!/bin/bash
# WerkingFlow Autopilot - Registry-Based Hierarchical Planner
#
# Usage: ./orchestrator/plan.sh
#
# Der Autopilot scannt die Registry (projects/) und zeigt
# alle Projekte mit ihren adaptiven Levels.
#
# Levels werden PRO PROJEKT in CONFIG.yaml definiert.

set -e

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
    echo -e "  ${GREEN}list${NC}              - Registry Overview anzeigen"
    echo -e "  ${GREEN}show [projekt]${NC}    - Projekt-Details anzeigen"
    echo -e "  ${GREEN}deeper [projekt]${NC}  - Nächstes Level für Projekt"
    echo -e "  ${GREEN}go [projekt]${NC}      - Projekt ausführen (öffnet Repo)"
    echo -e "  ${GREEN}status${NC}            - Aktuellen Status anzeigen"
    echo -e "  ${GREEN}help${NC}              - Diese Hilfe"
    echo -e "  ${GREEN}exit${NC}              - Beenden"
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

            go|Go|GO|g)
                if [ -n "$args" ]; then
                    local repo=$(get_project_repo "$args")
                    if [ -n "$repo" ] && [ -d "$repo" ]; then
                        log OK "Starte Arbeit an: $args"
                        echo ""
                        echo -e "${GREEN}Nächste Schritte:${NC}"
                        echo "  1. cd $repo"
                        echo "  2. claude  # Starte Claude Code"
                        echo ""
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
# Main
#######################################
main() {
    log INFO "WerkingFlow Autopilot gestartet"
    log SCAN "Registry: $PROJECTS_DIR"

    interactive_mode
}

# Run
main "$@"
