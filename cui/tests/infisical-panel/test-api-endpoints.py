#!/usr/bin/env python3
"""
Infisical Panel API Endpoint Tests
Tests all backend routes for the Infisical panel
"""

import requests
import json
import sys
from typing import Dict, Any, List

BASE_URL = "http://localhost:4005"

class Colors:
    GREEN = '\033[92m'
    RED = '\033[91m'
    YELLOW = '\033[93m'
    BLUE = '\033[94m'
    RESET = '\033[0m'

def print_test(name: str):
    print(f"\n{Colors.BLUE}[TEST]{Colors.RESET} {name}")

def print_success(msg: str):
    print(f"{Colors.GREEN}✓{Colors.RESET} {msg}")

def print_error(msg: str):
    print(f"{Colors.RED}✗{Colors.RESET} {msg}")

def print_warning(msg: str):
    print(f"{Colors.YELLOW}⚠{Colors.RESET} {msg}")

def test_server_health() -> bool:
    """Test if the CUI server is running"""
    print_test("Server Health Check")
    try:
        response = requests.get(f"{BASE_URL}/api/health", timeout=5)
        if response.status_code == 200:
            print_success(f"Server is running on {BASE_URL}")
            return True
        else:
            print_error(f"Server returned status {response.status_code}")
            return False
    except requests.exceptions.ConnectionError:
        print_error(f"Cannot connect to server at {BASE_URL}")
        print_warning("Please start the server with: npm run dev:server")
        return False
    except Exception as e:
        print_error(f"Unexpected error: {e}")
        return False

def test_infisical_status() -> bool:
    """Test /api/infisical/status endpoint"""
    print_test("GET /api/infisical/status")
    try:
        response = requests.get(f"{BASE_URL}/api/infisical/status", timeout=10)

        if response.status_code != 200:
            print_error(f"Status code: {response.status_code}")
            return False

        data = response.json()

        # Validate response structure
        required_fields = ['server', 'available', 'projects', 'last_check']
        for field in required_fields:
            if field not in data:
                print_error(f"Missing field: {field}")
                return False

        print_success(f"Server: {data['server']}")
        print_success(f"Available: {data['available']}")
        print_success(f"Projects: {data['projects']}")

        return True

    except Exception as e:
        print_error(f"Request failed: {e}")
        return False

def test_infisical_projects() -> bool:
    """Test /api/infisical/projects endpoint"""
    print_test("GET /api/infisical/projects")
    try:
        response = requests.get(f"{BASE_URL}/api/infisical/projects", timeout=10)

        if response.status_code != 200:
            print_error(f"Status code: {response.status_code}")
            return False

        data = response.json()

        if not isinstance(data, list):
            print_error("Response is not an array")
            return False

        print_success(f"Found {len(data)} projects")

        # Validate project structure
        if len(data) > 0:
            project = data[0]
            required_fields = ['id', 'name', 'sync_target', 'status']
            for field in required_fields:
                if field not in project:
                    print_error(f"Missing field in project: {field}")
                    return False
            print_success(f"Sample project: {project['name']} → {project['sync_target']}")

        return True

    except Exception as e:
        print_error(f"Request failed: {e}")
        return False

def test_infisical_secrets() -> bool:
    """Test /api/infisical/secrets/:projectId endpoint"""
    print_test("GET /api/infisical/secrets/:projectId")

    # First get a project ID
    try:
        projects_response = requests.get(f"{BASE_URL}/api/infisical/projects", timeout=10)
        projects = projects_response.json()

        if len(projects) == 0:
            print_warning("No projects available to test secrets endpoint")
            return True

        project_id = projects[0]['id']
        print_success(f"Testing with project: {projects[0]['name']} ({project_id})")

        response = requests.get(f"{BASE_URL}/api/infisical/secrets/{project_id}", timeout=10)

        if response.status_code != 200:
            print_error(f"Status code: {response.status_code}")
            return False

        data = response.json()

        required_fields = ['project_id', 'environment', 'secrets']
        for field in required_fields:
            if field not in data:
                print_error(f"Missing field: {field}")
                return False

        if not isinstance(data['secrets'], list):
            print_error("Secrets is not an array")
            return False

        print_success(f"Found {len(data['secrets'])} secrets in {data['environment']}")

        return True

    except Exception as e:
        print_error(f"Request failed: {e}")
        return False

def test_infisical_sync_status() -> bool:
    """Test /api/infisical/sync-status endpoint"""
    print_test("GET /api/infisical/sync-status")
    try:
        response = requests.get(f"{BASE_URL}/api/infisical/sync-status", timeout=10)

        if response.status_code != 200:
            print_error(f"Status code: {response.status_code}")
            return False

        data = response.json()

        required_fields = ['total', 'succeeded', 'failed', 'syncs']
        for field in required_fields:
            if field not in data:
                print_error(f"Missing field: {field}")
                return False

        print_success(f"Total syncs: {data['total']}")
        print_success(f"Succeeded: {data['succeeded']}")
        print_success(f"Failed: {data['failed']}")

        return True

    except Exception as e:
        print_error(f"Request failed: {e}")
        return False

def test_infisical_trigger_sync() -> bool:
    """Test POST /api/infisical/trigger-sync endpoint"""
    print_test("POST /api/infisical/trigger-sync")

    # First get a project ID
    try:
        projects_response = requests.get(f"{BASE_URL}/api/infisical/projects", timeout=10)
        projects = projects_response.json()

        if len(projects) == 0:
            print_warning("No projects available to test trigger sync")
            return True

        project_id = projects[0]['id']
        print_success(f"Testing with project: {projects[0]['name']} ({project_id})")

        payload = {'project_id': project_id}
        response = requests.post(
            f"{BASE_URL}/api/infisical/trigger-sync",
            json=payload,
            timeout=30
        )

        if response.status_code not in [200, 202]:
            print_error(f"Status code: {response.status_code}")
            return False

        data = response.json()

        if 'status' not in data:
            print_error("Missing status field")
            return False

        print_success(f"Sync status: {data['status']}")

        return True

    except Exception as e:
        print_error(f"Request failed: {e}")
        return False

def run_all_tests():
    """Run all API endpoint tests"""
    print(f"\n{Colors.BLUE}{'='*60}{Colors.RESET}")
    print(f"{Colors.BLUE}Infisical Panel API Tests{Colors.RESET}")
    print(f"{Colors.BLUE}{'='*60}{Colors.RESET}")

    tests = [
        ("Server Health", test_server_health),
        ("Infisical Status", test_infisical_status),
        ("Projects List", test_infisical_projects),
        ("Project Secrets", test_infisical_secrets),
        ("Sync Status", test_infisical_sync_status),
        ("Trigger Sync", test_infisical_trigger_sync),
    ]

    results = []

    for test_name, test_func in tests:
        try:
            result = test_func()
            results.append((test_name, result))
        except KeyboardInterrupt:
            print(f"\n{Colors.YELLOW}Tests interrupted by user{Colors.RESET}")
            sys.exit(1)
        except Exception as e:
            print_error(f"Test crashed: {e}")
            results.append((test_name, False))

    # Print summary
    print(f"\n{Colors.BLUE}{'='*60}{Colors.RESET}")
    print(f"{Colors.BLUE}Test Summary{Colors.RESET}")
    print(f"{Colors.BLUE}{'='*60}{Colors.RESET}")

    passed = sum(1 for _, result in results if result)
    total = len(results)

    for test_name, result in results:
        if result:
            print(f"{Colors.GREEN}✓{Colors.RESET} {test_name}")
        else:
            print(f"{Colors.RED}✗{Colors.RESET} {test_name}")

    print(f"\n{Colors.BLUE}Total:{Colors.RESET} {passed}/{total} tests passed")

    if passed == total:
        print(f"{Colors.GREEN}All tests passed!{Colors.RESET}")
        return 0
    else:
        print(f"{Colors.RED}{total - passed} tests failed{Colors.RESET}")
        return 1

if __name__ == "__main__":
    exit_code = run_all_tests()
    sys.exit(exit_code)
