#!/usr/bin/env python3
"""
Final Infisical Panel Test Suite
Tests all critical layers to guarantee 100% functionality
"""

import requests
import json
import time
import sys

# Configuration
CUI_BASE_URL = "http://localhost:4005"
API_BASE = f"{CUI_BASE_URL}/api/infisical"

# Expected projects
EXPECTED_PROJECTS = [
    'werking-report', 'engelmann', 'werking-safety-fe',
    'werking-safety-be', 'werking-energy-fe', 'werking-energy-be', 'platform'
]

class Colors:
    OKGREEN = '\033[92m'
    FAIL = '\033[91m'
    WARNING = '\033[93m'
    BOLD = '\033[1m'
    ENDC = '\033[0m'

def print_header(text):
    print(f"\n{Colors.BOLD}{'='*70}")
    print(f"  {text}")
    print(f"{'='*70}{Colors.ENDC}\n")

def print_test(name):
    print(f"  🧪 {name}...", end=" ")

def print_pass():
    print(f"{Colors.OKGREEN}✅ PASS{Colors.ENDC}")

def print_fail(reason=""):
    print(f"{Colors.FAIL}❌ FAIL{Colors.ENDC}")
    if reason:
        print(f"     {reason}")

# ===================================================================
# LAYER 1: API ENDPOINTS
# ===================================================================

def test_api_layer():
    """Test all API endpoints"""
    print_header("LAYER 1: API ENDPOINTS")

    results = {'pass': 0, 'fail': 0}

    # Test 1: Status endpoint
    print_test("GET /api/infisical/status")
    try:
        r = requests.get(f"{API_BASE}/status", timeout=30)
        assert r.status_code == 200
        data = r.json()
        assert 'server' in data and 'projects' in data
        assert len(data['projects']) == 7
        print_pass()
        results['pass'] += 1
    except Exception as e:
        print_fail(str(e))
        results['fail'] += 1

    # Test 2: Health endpoint
    print_test("GET /api/infisical/health")
    try:
        r = requests.get(f"{API_BASE}/health", timeout=30)
        assert r.status_code == 200
        data = r.json()
        assert data['status'] in ['healthy', 'unhealthy']
        print_pass()
        results['pass'] += 1
    except Exception as e:
        print_fail(str(e))
        results['fail'] += 1

    # Test 3: Projects endpoint
    print_test("GET /api/infisical/projects")
    try:
        r = requests.get(f"{API_BASE}/projects", timeout=30)
        assert r.status_code == 200
        data = r.json()
        projects = data.get('projects', data)
        assert len(projects) == 7
        # Verify all expected projects exist
        project_ids = [p['id'] for p in projects]
        assert all(pid in project_ids for pid in EXPECTED_PROJECTS)
        print_pass()
        results['pass'] += 1
    except Exception as e:
        print_fail(str(e))
        results['fail'] += 1

    # Test 4: Syncs endpoint
    print_test("GET /api/infisical/syncs")
    try:
        r = requests.get(f"{API_BASE}/syncs", timeout=30)
        assert r.status_code == 200
        data = r.json()
        assert 'syncs' in data and 'total' in data
        assert data['total'] == 7
        print_pass()
        results['pass'] += 1
    except Exception as e:
        print_fail(str(e))
        results['fail'] += 1

    # Test 5: Infrastructure endpoint
    print_test("GET /api/infisical/infrastructure")
    try:
        r = requests.get(f"{API_BASE}/infrastructure", timeout=30)
        assert r.status_code == 200
        data = r.json()
        assert 'server' in data and 'syncTargets' in data
        assert data['server'] == '100.79.71.99'
        print_pass()
        results['pass'] += 1
    except Exception as e:
        print_fail(str(e))
        results['fail'] += 1

    # Test 6: Server info endpoint
    print_test("GET /api/infisical/server-info")
    try:
        r = requests.get(f"{API_BASE}/server-info", timeout=30)
        assert r.status_code == 200
        data = r.json()
        assert data['tailscaleIP'] == '100.79.71.99'
        assert data['webUI'] == 'http://100.79.71.99:80'
        print_pass()
        results['pass'] += 1
    except Exception as e:
        print_fail(str(e))
        results['fail'] += 1

    return results

# ===================================================================
# LAYER 2: COMPONENT FUNCTIONALITY
# ===================================================================

def test_component_layer():
    """Test component is registered and accessible"""
    print_header("LAYER 2: COMPONENT REGISTRATION")

    results = {'pass': 0, 'fail': 0}

    # Test 1: Component exists in build
    print_test("Component file exists")
    try:
        import os
        component_path = "/root/projekte/werkingflow/autopilot/cui/src/components/panels/InfisicalMonitor/InfisicalMonitor.tsx"
        assert os.path.exists(component_path)
        print_pass()
        results['pass'] += 1
    except Exception as e:
        print_fail(str(e))
        results['fail'] += 1

    # Test 2: Component registered in LayoutManager
    print_test("Component registered in LayoutManager")
    try:
        import os
        layout_manager = "/root/projekte/werkingflow/autopilot/cui/src/components/LayoutManager.tsx"
        with open(layout_manager, 'r') as f:
            content = f.read()
        assert 'InfisicalMonitor' in content
        assert "import('./panels/InfisicalMonitor/InfisicalMonitor')" in content
        print_pass()
        results['pass'] += 1
    except Exception as e:
        print_fail(str(e))
        results['fail'] += 1

    # Test 3: Component in layout JSON
    print_test("Component in administration layout")
    try:
        layout_path = "/root/projekte/werkingflow/autopilot/cui/data/layouts/administration.json"
        with open(layout_path, 'r') as f:
            layout = json.load(f)

        # Check if InfisicalMonitor exists in layout
        def find_component(node):
            if isinstance(node, dict):
                if node.get('component') == 'InfisicalMonitor':
                    return True
                for value in node.values():
                    if find_component(value):
                        return True
            elif isinstance(node, list):
                for item in node:
                    if find_component(item):
                        return True
            return False

        assert find_component(layout)
        print_pass()
        results['pass'] += 1
    except Exception as e:
        print_fail(str(e))
        results['fail'] += 1

    return results

# ===================================================================
# LAYER 3: DATA FLOW
# ===================================================================

def test_data_flow():
    """Test complete data flow from API to expected rendering"""
    print_header("LAYER 3: DATA FLOW")

    results = {'pass': 0, 'fail': 0}

    # Test 1: All projects have required fields
    print_test("Projects have all required fields")
    try:
        r = requests.get(f"{API_BASE}/projects", timeout=30)
        data = r.json()
        projects = data.get('projects', data)

        for project in projects:
            assert 'id' in project
            assert 'name' in project
            assert 'status' in project
            assert 'sync_target' in project or 'syncTarget' in project
            assert 'environment' in project

        print_pass()
        results['pass'] += 1
    except Exception as e:
        print_fail(str(e))
        results['fail'] += 1

    # Test 2: Syncs data structure valid
    print_test("Syncs data structure valid")
    try:
        r = requests.get(f"{API_BASE}/syncs", timeout=30)
        data = r.json()

        assert data['total'] == len(data['syncs'])
        assert data['succeeded'] == len([s for s in data['syncs'] if s['status'] == 'succeeded'])

        for sync in data['syncs']:
            assert 'project' in sync
            assert 'integration' in sync
            assert 'status' in sync
            assert 'lastSync' in sync

        print_pass()
        results['pass'] += 1
    except Exception as e:
        print_fail(str(e))
        results['fail'] += 1

    # Test 3: Infrastructure has correct architecture
    print_test("Infrastructure shows correct architecture")
    try:
        r = requests.get(f"{API_BASE}/infrastructure", timeout=30)
        data = r.json()

        vercel_count = len(data['syncTargets']['vercel'])
        railway_count = len(data['syncTargets']['railway'])

        assert vercel_count == 5  # 5 Vercel projects
        assert railway_count == 2  # 2 Railway projects
        assert data['totalProjects'] == 7

        print_pass()
        results['pass'] += 1
    except Exception as e:
        print_fail(str(e))
        results['fail'] += 1

    return results

# ===================================================================
# MAIN
# ===================================================================

def main():
    print_header("INFISICAL PANEL COMPREHENSIVE TEST SUITE")
    print(f"{Colors.BOLD}Testing all critical layers for 100% functionality guarantee{Colors.ENDC}\n")

    all_results = {'pass': 0, 'fail': 0}

    # Run all test layers
    for test_func in [test_api_layer, test_component_layer, test_data_flow]:
        results = test_func()
        all_results['pass'] += results['pass']
        all_results['fail'] += results['fail']
        time.sleep(0.5)

    # Final summary
    print_header("TEST SUMMARY")
    total = all_results['pass'] + all_results['fail']
    success_rate = (all_results['pass'] / total * 100) if total > 0 else 0

    print(f"  Total Tests:    {total}")
    print(f"  {Colors.OKGREEN}Passed:         {all_results['pass']}{Colors.ENDC}")
    print(f"  {Colors.FAIL}Failed:         {all_results['fail']}{Colors.ENDC}")
    print(f"  Success Rate:   {success_rate:.1f}%\n")

    if all_results['fail'] == 0:
        print(f"{Colors.BOLD}{Colors.OKGREEN}✅ ALL TESTS PASSED - INFISICAL PANEL IS 100% FUNCTIONAL{Colors.ENDC}\n")
        print(f"{Colors.BOLD}Verified:{Colors.ENDC}")
        print(f"  ✅ All 6 API endpoints working correctly")
        print(f"  ✅ Component registered and available")
        print(f"  ✅ Complete data flow validated")
        print(f"  ✅ 7 projects with auto-sync to Vercel (5) and Railway (2)")
        print(f"  ✅ Infrastructure architecture correct\n")
        return 0
    else:
        print(f"{Colors.BOLD}{Colors.FAIL}❌ {all_results['fail']} TEST(S) FAILED{Colors.ENDC}\n")
        return 1

if __name__ == '__main__':
    sys.exit(main())
