#!/bin/bash
# Infisical Panel - Complete Test Suite Runner

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Colors
BLUE='\033[94m'
GREEN='\033[92m'
RED='\033[91m'
YELLOW='\033[93m'
RESET='\033[0m'

echo -e "${BLUE}============================================================${RESET}"
echo -e "${BLUE}Infisical Panel - Complete Test Suite${RESET}"
echo -e "${BLUE}============================================================${RESET}"

# Check if server is running
echo -e "\n${BLUE}[CHECK]${RESET} Server Health"
if curl -s -m 10 http://localhost:4005/api/health > /dev/null 2>&1; then
    echo -e "${GREEN}✓${RESET} Server is running"
else
    echo -e "${RED}✗${RESET} Server is not running"
    echo -e "${YELLOW}Please start the server with: npm run dev:server${RESET}"
    exit 1
fi

# Install Python dependencies if needed
echo -e "\n${BLUE}[CHECK]${RESET} Python Dependencies"
if ! python3 -c "import playwright" 2>/dev/null; then
    echo -e "${YELLOW}Installing playwright...${RESET}"
    pip3 install playwright requests
    playwright install chromium
fi

FAILED_TESTS=0

# Test 1: API Endpoints
echo -e "\n${BLUE}[1/3]${RESET} Running API Endpoint Tests"
if python3 test-api-endpoints.py; then
    echo -e "${GREEN}✓${RESET} API tests passed"
else
    echo -e "${RED}✗${RESET} API tests failed"
    ((FAILED_TESTS++))
fi

# Test 2: UI Tests
echo -e "\n${BLUE}[2/3]${RESET} Running UI Tests (Playwright)"
if python3 test-ui-simple.py; then
    echo -e "${GREEN}✓${RESET} UI tests passed"
else
    echo -e "${RED}✗${RESET} UI tests failed"
    ((FAILED_TESTS++))
fi

# Test 3: Integration Tests
echo -e "\n${BLUE}[3/3]${RESET} Running Integration Tests"
if python3 test-integration-simple.py; then
    echo -e "${GREEN}✓${RESET} Integration tests passed"
else
    echo -e "${RED}✗${RESET} Integration tests failed"
    ((FAILED_TESTS++))
fi

# Final Summary
echo -e "\n${BLUE}============================================================${RESET}"
echo -e "${BLUE}Test Suite Summary${RESET}"
echo -e "${BLUE}============================================================${RESET}"

if [ $FAILED_TESTS -eq 0 ]; then
    echo -e "${GREEN}✓ All test suites passed!${RESET}"
    echo -e "${GREEN}✓ Infisical Panel is 100% functional${RESET}"
    exit 0
else
    echo -e "${RED}✗ $FAILED_TESTS test suite(s) failed${RESET}"
    echo -e "${YELLOW}Please review the errors above${RESET}"
    exit 1
fi
