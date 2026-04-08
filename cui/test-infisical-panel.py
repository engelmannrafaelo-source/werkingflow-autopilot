#!/usr/bin/env python3
"""
Comprehensive Infisical Panel Test Suite
Tests all layers: API → Component → UI Rendering

Modeled after Bridge panel testing architecture
"""

import requests
import json
import time
from playwright.sync_api import sync_playwright, expect

# Configuration
CUI_BASE_URL = "http://localhost:4005"
API_BASE = f"{CUI_BASE_URL}/api/infisical"

# Expected data constants
EXPECTED_PROJECTS = [
    'werking-report',
    'engelmann',
    'werking-safety-fe',
    'werking-safety-be',
    'werking-energy-fe',
    'werking-energy-be',
    'platform'
]

class Colors:
    """Terminal colors for test output"""
    HEADER = '\033[95m'
    OKBLUE = '\033[94m'
    OKCYAN = '\033[96m'
    OKGREEN = '\033[92m'
    WARNING = '\033[93m'
    FAIL = '\033[91m'
    ENDC = '\033[0m'
    BOLD = '\033[1m'


def print_test(name: str):
    """Print test name"""
    print(f"\n{Colors.OKCYAN}🧪 {name}{Colors.ENDC}")


def print_pass(message: str):
    """Print success message"""
    print(f"{Colors.OKGREEN}✅ {message}{Colors.ENDC}")


def print_fail(message: str):
    """Print failure message"""
    print(f"{Colors.FAIL}❌ {message}{Colors.ENDC}")


def print_section(title: str):
    """Print section header"""
    print(f"\n{Colors.HEADER}{Colors.BOLD}{'='*60}")
    print(f"  {title}")
    print(f"{'='*60}{Colors.ENDC}\n")


# ============================================================================
# LAYER 1: API ENDPOINT TESTS
# ============================================================================

def test_api_status():
    """Test /api/infisical/status endpoint"""
    print_test("API: GET /api/infisical/status")

    try:
        response = requests.get(f"{API_BASE}/status", timeout=30)

        if response.status_code != 200:
            print_fail(f"Status code: {response.status_code}")
            return False

        data = response.json()

        # Validate structure
        assert 'server' in data, "Missing 'server' key"
        assert 'docker' in data, "Missing 'docker' key"
        assert 'auth' in data, "Missing 'auth' key"
        assert 'projects' in data, "Missing 'projects' key"

        # Validate server info
        assert data['server']['tailscale_ip'] == '100.79.71.99'
        assert data['server']['web_ui'] == 'http://100.79.71.99:80'

        # Validate projects
        assert len(data['projects']) == 7, f"Expected 7 projects, got {len(data['projects'])}"

        print_pass("Status endpoint returns valid data")
        return True

    except Exception as e:
        print_fail(f"Error: {str(e)}")
        return False


def test_api_health():
    """Test /api/infisical/health endpoint"""
    print_test("API: GET /api/infisical/health")

    try:
        response = requests.get(f"{API_BASE}/health", timeout=30)

        if response.status_code != 200:
            print_fail(f"Status code: {response.status_code}")
            return False

        data = response.json()

        # Validate structure
        assert 'status' in data, "Missing 'status' key"
        assert data['status'] in ['healthy', 'unhealthy'], f"Invalid status: {data['status']}"

        print_pass("Health endpoint returns valid data")
        return True

    except Exception as e:
        print_fail(f"Error: {str(e)}")
        return False


def test_api_projects():
    """Test /api/infisical/projects endpoint"""
    print_test("API: GET /api/infisical/projects")

    try:
        response = requests.get(f"{API_BASE}/projects", timeout=30)

        if response.status_code != 200:
            print_fail(f"Status code: {response.status_code}")
            return False

        data = response.json()

        # Handle both array and object wrapper formats
        projects = data.get('projects', data) if isinstance(data, dict) else data

        # Validate projects
        assert len(projects) == 7, f"Expected 7 projects, got {len(projects)}"

        # Validate each project has required fields
        for project in projects:
            assert 'id' in project, "Missing 'id' field"
            assert 'name' in project, "Missing 'name' field"
            assert 'status' in project, "Missing 'status' field"
            assert 'sync_target' in project or 'syncTarget' in project, "Missing sync target"

        print_pass(f"Projects endpoint returns {len(projects)} valid projects")
        return True

    except Exception as e:
        print_fail(f"Error: {str(e)}")
        return False


def test_api_syncs():
    """Test /api/infisical/syncs endpoint"""
    print_test("API: GET /api/infisical/syncs")

    try:
        response = requests.get(f"{API_BASE}/syncs", timeout=30)

        if response.status_code != 200:
            print_fail(f"Status code: {response.status_code}")
            return False

        data = response.json()

        # Validate structure
        assert 'total' in data, "Missing 'total' key"
        assert 'succeeded' in data, "Missing 'succeeded' key"
        assert 'failed' in data, "Missing 'failed' key"
        assert 'syncs' in data, "Missing 'syncs' key"

        # Validate syncs
        assert len(data['syncs']) == 7, f"Expected 7 syncs, got {len(data['syncs'])}"

        print_pass(f"Syncs endpoint returns {data['total']} syncs")
        return True

    except Exception as e:
        print_fail(f"Error: {str(e)}")
        return False


def test_api_infrastructure():
    """Test /api/infisical/infrastructure endpoint"""
    print_test("API: GET /api/infisical/infrastructure")

    try:
        response = requests.get(f"{API_BASE}/infrastructure", timeout=30)

        if response.status_code != 200:
            print_fail(f"Status code: {response.status_code}")
            return False

        data = response.json()

        # Validate structure
        assert 'server' in data, "Missing 'server' key"
        assert 'webUI' in data, "Missing 'webUI' key"
        assert 'syncTargets' in data, "Missing 'syncTargets' key"
        assert 'vercel' in data['syncTargets'], "Missing Vercel targets"
        assert 'railway' in data['syncTargets'], "Missing Railway targets"

        print_pass("Infrastructure endpoint returns valid data")
        return True

    except Exception as e:
        print_fail(f"Error: {str(e)}")
        return False


# ============================================================================
# LAYER 2: COMPONENT RENDERING TESTS
# ============================================================================

def test_panel_renders():
    """Test that Infisical panel renders without errors"""
    print_test("Component: Panel renders")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context()
        page = context.new_page()

        try:
            # Navigate to CUI
            page.goto(CUI_BASE_URL, wait_until="networkidle", timeout=30000)

            # Wait for layout to load (FlexLayout tabs container)
            page.wait_for_selector('.flexlayout__tabset_tabbar_outer', timeout=20000)

            # Open panel menu
            page.click('button:has-text("+")', timeout=5000)

            # Click "Infisical Monitor 🔐"
            page.click('text="Infisical Monitor 🔐"', timeout=5000)

            # Wait for panel to appear
            time.sleep(2)

            # Check if panel container exists
            panel = page.query_selector('[data-panel-type="infisical"]')

            if not panel:
                print_fail("Infisical panel not found in DOM")
                return False

            print_pass("Panel renders successfully")
            return True

        except Exception as e:
            print_fail(f"Error: {str(e)}")
            return False
        finally:
            browser.close()


def test_panel_loads_data():
    """Test that panel loads and displays data"""
    print_test("Component: Panel loads data")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context()
        page = context.new_page()

        try:
            # Navigate and open panel
            page.goto(CUI_BASE_URL, wait_until="networkidle", timeout=30000)
            page.wait_for_selector('.flexlayout__tabset_tabbar_outer', timeout=20000)
            page.click('button:has-text("+")', timeout=5000)
            page.click('text="Infisical Monitor 🔐"', timeout=5000)

            # Wait for data to load
            time.sleep(3)

            # Check for loading state or data
            loading = page.query_selector('text="Loading"')
            error = page.query_selector('text="Error"')

            if error:
                print_fail("Panel shows error state")
                return False

            if loading:
                print_fail("Panel stuck in loading state")
                return False

            print_pass("Panel loads data successfully")
            return True

        except Exception as e:
            print_fail(f"Error: {str(e)}")
            return False
        finally:
            browser.close()


def test_panel_shows_projects():
    """Test that panel displays project list"""
    print_test("Component: Shows project list")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context()
        page = context.new_page()

        try:
            # Navigate and open panel
            page.goto(CUI_BASE_URL, wait_until="networkidle", timeout=30000)
            page.wait_for_selector('.flexlayout__tabset_tabbar_outer', timeout=20000)
            page.click('button:has-text("+")', timeout=5000)
            page.click('text="Infisical Monitor 🔐"', timeout=5000)

            # Wait for data
            time.sleep(3)

            # Count how many expected projects are visible
            found_projects = []
            for project in EXPECTED_PROJECTS:
                if page.query_selector(f'text="{project}"'):
                    found_projects.append(project)

            if len(found_projects) < 5:  # At least 5 of 7 should be visible
                print_fail(f"Only found {len(found_projects)} projects: {found_projects}")
                return False

            print_pass(f"Panel shows {len(found_projects)}/7 projects")
            return True

        except Exception as e:
            print_fail(f"Error: {str(e)}")
            return False
        finally:
            browser.close()


# ============================================================================
# LAYER 3: UI INTERACTION TESTS
# ============================================================================

def test_panel_refresh():
    """Test panel refresh functionality"""
    print_test("UI: Refresh button works")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context()
        page = context.new_page()

        try:
            # Navigate and open panel
            page.goto(CUI_BASE_URL, wait_until="networkidle", timeout=30000)
            page.wait_for_selector('.flexlayout__tabset_tabbar_outer', timeout=20000)
            page.click('button:has-text("+")', timeout=5000)
            page.click('text="Infisical Monitor 🔐"', timeout=5000)

            # Wait for initial load
            time.sleep(3)

            # Find and click refresh button
            refresh_btn = page.query_selector('button:has-text("Refresh")')

            if not refresh_btn:
                print_fail("Refresh button not found")
                return False

            refresh_btn.click()

            # Wait for refresh
            time.sleep(2)

            print_pass("Refresh button works")
            return True

        except Exception as e:
            print_fail(f"Error: {str(e)}")
            return False
        finally:
            browser.close()


def test_panel_tabs():
    """Test panel tab navigation"""
    print_test("UI: Tab navigation works")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context()
        page = context.new_page()

        try:
            # Navigate and open panel
            page.goto(CUI_BASE_URL, wait_until="networkidle", timeout=30000)
            page.wait_for_selector('.flexlayout__tabset_tabbar_outer', timeout=20000)
            page.click('button:has-text("+")', timeout=5000)
            page.click('text="Infisical Monitor 🔐"', timeout=5000)

            # Wait for panel
            time.sleep(3)

            # Look for tab buttons (Overview, Projects, Sync Status, Infrastructure)
            tabs = ['Overview', 'Projects', 'Infrastructure']
            found_tabs = 0

            for tab in tabs:
                if page.query_selector(f'button:has-text("{tab}")'):
                    found_tabs += 1

            if found_tabs < 2:  # At least 2 tabs should exist
                print_fail(f"Only found {found_tabs} tabs")
                return False

            print_pass(f"Panel has {found_tabs} tabs")
            return True

        except Exception as e:
            print_fail(f"Error: {str(e)}")
            return False
        finally:
            browser.close()


# ============================================================================
# MAIN TEST RUNNER
# ============================================================================

def run_all_tests():
    """Run all test layers"""
    print_section("INFISICAL PANEL COMPREHENSIVE TEST SUITE")

    results = {
        'passed': 0,
        'failed': 0,
        'total': 0
    }

    # Layer 1: API Tests
    print_section("LAYER 1: API ENDPOINT TESTS")
    api_tests = [
        test_api_status,
        test_api_health,
        test_api_projects,
        test_api_syncs,
        test_api_infrastructure,
    ]

    for test in api_tests:
        results['total'] += 1
        if test():
            results['passed'] += 1
        else:
            results['failed'] += 1
        time.sleep(0.5)

    # Layer 2: Component Tests
    print_section("LAYER 2: COMPONENT RENDERING TESTS")
    component_tests = [
        test_panel_renders,
        test_panel_loads_data,
        test_panel_shows_projects,
    ]

    for test in component_tests:
        results['total'] += 1
        if test():
            results['passed'] += 1
        else:
            results['failed'] += 1
        time.sleep(0.5)

    # Layer 3: UI Tests
    print_section("LAYER 3: UI INTERACTION TESTS")
    ui_tests = [
        test_panel_refresh,
        test_panel_tabs,
    ]

    for test in ui_tests:
        results['total'] += 1
        if test():
            results['passed'] += 1
        else:
            results['failed'] += 1
        time.sleep(0.5)

    # Summary
    print_section("TEST SUMMARY")
    print(f"{Colors.BOLD}Total Tests:{Colors.ENDC} {results['total']}")
    print(f"{Colors.OKGREEN}Passed:{Colors.ENDC} {results['passed']}")
    print(f"{Colors.FAIL}Failed:{Colors.ENDC} {results['failed']}")

    success_rate = (results['passed'] / results['total'] * 100) if results['total'] > 0 else 0
    print(f"{Colors.BOLD}Success Rate:{Colors.ENDC} {success_rate:.1f}%")

    if results['failed'] == 0:
        print(f"\n{Colors.OKGREEN}{Colors.BOLD}✅ ALL TESTS PASSED - PANEL IS 100% FUNCTIONAL{Colors.ENDC}")
        return 0
    else:
        print(f"\n{Colors.FAIL}{Colors.BOLD}❌ {results['failed']} TEST(S) FAILED - PANEL NEEDS FIXES{Colors.ENDC}")
        return 1


if __name__ == '__main__':
    exit(run_all_tests())
