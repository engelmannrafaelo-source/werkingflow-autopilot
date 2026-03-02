#!/usr/bin/env python3
"""
Comprehensive Infisical Panel Test Suite
Similar structure to Bridge testing
"""

import sys
import time
import requests
from playwright.sync_api import sync_playwright, expect

BASE_URL = "http://localhost:4005"
API_BASE = f"{BASE_URL}/api/infisical"

class Colors:
    GREEN = '\033[92m'
    RED = '\033[91m'
    YELLOW = '\033[93m'
    BLUE = '\033[94m'
    END = '\033[0m'

def print_test(name, status, details=""):
    """Print test result with color"""
    color = Colors.GREEN if status == "PASS" else Colors.RED
    symbol = "✓" if status == "PASS" else "✗"
    print(f"{color}{symbol} {name}{Colors.END}")
    if details:
        print(f"  {details}")

def test_server_health():
    """Test 1: Server is running"""
    try:
        resp = requests.get(f"{BASE_URL}/health", timeout=5)
        if resp.status_code == 200:
            print_test("Server Health Check", "PASS", f"Server running on port 4005")
            return True
        else:
            print_test("Server Health Check", "FAIL", f"Status: {resp.status_code}")
            return False
    except Exception as e:
        print_test("Server Health Check", "FAIL", str(e))
        return False

def test_api_status():
    """Test 2: Status endpoint"""
    try:
        resp = requests.get(f"{API_BASE}/status", timeout=5)
        if resp.status_code != 200:
            print_test("API Status Endpoint", "FAIL", f"Status: {resp.status_code}")
            return False
        
        data = resp.json()
        required_fields = ['server', 'mode', 'projects_count']
        
        for field in required_fields:
            if field not in data:
                print_test("API Status Endpoint", "FAIL", f"Missing field: {field}")
                return False
        
        print_test("API Status Endpoint", "PASS", f"Mode: {data['mode']}, Projects: {data['projects_count']}")
        return True
    except Exception as e:
        print_test("API Status Endpoint", "FAIL", str(e))
        return False

def test_api_projects():
    """Test 3: Projects endpoint"""
    try:
        resp = requests.get(f"{API_BASE}/projects", timeout=5)
        if resp.status_code != 200:
            print_test("API Projects Endpoint", "FAIL", f"Status: {resp.status_code}")
            return False
        
        data = resp.json()
        if not isinstance(data, list):
            print_test("API Projects Endpoint", "FAIL", "Response is not a list")
            return False
        
        if len(data) != 7:
            print_test("API Projects Endpoint", "FAIL", f"Expected 7 projects, got {len(data)}")
            return False
        
        # Verify project structure
        required_fields = ['id', 'name', 'sync_target', 'status']
        for project in data:
            for field in required_fields:
                if field not in project:
                    print_test("API Projects Endpoint", "FAIL", f"Project missing field: {field}")
                    return False
        
        print_test("API Projects Endpoint", "PASS", f"All 7 projects returned with correct structure")
        return True
    except Exception as e:
        print_test("API Projects Endpoint", "FAIL", str(e))
        return False

def test_api_secrets():
    """Test 4: Secrets endpoint"""
    try:
        # Test with first project
        resp = requests.get(f"{API_BASE}/secrets/werking-report", timeout=5)
        if resp.status_code != 200:
            print_test("API Secrets Endpoint", "FAIL", f"Status: {resp.status_code}")
            return False
        
        data = resp.json()
        if 'project' not in data or 'secrets' not in data:
            print_test("API Secrets Endpoint", "FAIL", "Missing required fields")
            return False
        
        if not isinstance(data['secrets'], list):
            print_test("API Secrets Endpoint", "FAIL", "Secrets is not a list")
            return False
        
        print_test("API Secrets Endpoint", "PASS", f"Project: {data['project']}, Secrets: {len(data['secrets'])}")
        return True
    except Exception as e:
        print_test("API Secrets Endpoint", "FAIL", str(e))
        return False

def test_api_sync_status():
    """Test 5: Sync status endpoint"""
    try:
        resp = requests.get(f"{API_BASE}/sync-status", timeout=5)
        if resp.status_code != 200:
            print_test("API Sync Status Endpoint", "FAIL", f"Status: {resp.status_code}")
            return False
        
        data = resp.json()
        required_fields = ['last_sync', 'total_projects', 'synced', 'failed']
        
        for field in required_fields:
            if field not in data:
                print_test("API Sync Status Endpoint", "FAIL", f"Missing field: {field}")
                return False
        
        print_test("API Sync Status Endpoint", "PASS", f"Synced: {data['synced']}/{data['total_projects']}")
        return True
    except Exception as e:
        print_test("API Sync Status Endpoint", "FAIL", str(e))
        return False

def test_api_manual_sync():
    """Test 6: Manual sync endpoint"""
    try:
        resp = requests.post(f"{API_BASE}/sync/werking-report", timeout=5)
        if resp.status_code != 200:
            print_test("API Manual Sync Endpoint", "FAIL", f"Status: {resp.status_code}")
            return False
        
        data = resp.json()
        if 'success' not in data or 'message' not in data:
            print_test("API Manual Sync Endpoint", "FAIL", "Missing required fields")
            return False
        
        print_test("API Manual Sync Endpoint", "PASS", data['message'])
        return True
    except Exception as e:
        print_test("API Manual Sync Endpoint", "FAIL", str(e))
        return False

def test_ui_panel_load():
    """Test 7: Panel loads in browser"""
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, args=[
                '--disable-gpu',
                '--disable-software-rasterizer'
            ])
            page = browser.new_page()
            
            # Navigate to panel
            page.goto(f"{BASE_URL}/?panel=infisical-monitor", wait_until="networkidle", timeout=30000)
            
            # Wait for panel to load
            time.sleep(3)
            
            # Check for panel element
            panel = page.locator('[class*="InfisicalMonitor"]').first
            if panel.count() == 0:
                print_test("UI Panel Load", "FAIL", "Panel component not found in DOM")
                browser.close()
                return False
            
            print_test("UI Panel Load", "PASS", "Panel rendered successfully")
            browser.close()
            return True
    except Exception as e:
        print_test("UI Panel Load", "FAIL", str(e))
        return False

def test_ui_tabs_present():
    """Test 8: All tabs are present"""
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, args=[
                '--disable-gpu',
                '--disable-software-rasterizer'
            ])
            page = browser.new_page()
            page.goto(f"{BASE_URL}/?panel=infisical-monitor", wait_until="networkidle", timeout=30000)
            time.sleep(3)
            
            # Check for tab buttons
            expected_tabs = ['Overview', 'Projects', 'Sync Status']
            
            for tab_name in expected_tabs:
                tab = page.get_by_text(tab_name, exact=True)
                if tab.count() == 0:
                    print_test("UI Tabs Present", "FAIL", f"Missing tab: {tab_name}")
                    browser.close()
                    return False
            
            print_test("UI Tabs Present", "PASS", "All 3 tabs found")
            browser.close()
            return True
    except Exception as e:
        print_test("UI Tabs Present", "FAIL", str(e))
        return False

def test_ui_data_displays():
    """Test 9: Data displays correctly"""
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, args=[
                '--disable-gpu',
                '--disable-software-rasterizer'
            ])
            page = browser.new_page()
            page.goto(f"{BASE_URL}/?panel=infisical-monitor", wait_until="networkidle", timeout=30000)
            time.sleep(3)
            
            # Check for server info
            server_text = page.get_by_text("100.79.71.99")
            if server_text.count() == 0:
                print_test("UI Data Display", "FAIL", "Server IP not displayed")
                browser.close()
                return False
            
            # Check for project count (7 projects)
            projects_text = page.get_by_text("7", exact=False)
            if projects_text.count() == 0:
                print_test("UI Data Display", "FAIL", "Project count not displayed")
                browser.close()
                return False
            
            print_test("UI Data Display", "PASS", "Server info and project count visible")
            browser.close()
            return True
    except Exception as e:
        print_test("UI Data Display", "FAIL", str(e))
        return False

def test_ui_projects_tab():
    """Test 10: Projects tab shows all projects"""
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, args=[
                '--disable-gpu',
                '--disable-software-rasterizer'
            ])
            page = browser.new_page()
            page.goto(f"{BASE_URL}/?panel=infisical-monitor", wait_until="networkidle", timeout=30000)
            time.sleep(3)
            
            # Click Projects tab
            projects_tab = page.get_by_text("Projects", exact=True)
            projects_tab.click()
            time.sleep(2)
            
            # Check for project names
            expected_projects = ['werking-report', 'engelmann', 'platform', 'werking-energy-fe', 'werking-energy-be']
            
            for project in expected_projects:
                project_elem = page.get_by_text(project, exact=False)
                if project_elem.count() == 0:
                    print_test("UI Projects Tab", "FAIL", f"Project not found: {project}")
                    browser.close()
                    return False
            
            print_test("UI Projects Tab", "PASS", "All projects visible in Projects tab")
            browser.close()
            return True
    except Exception as e:
        print_test("UI Projects Tab", "FAIL", str(e))
        return False

def run_all_tests():
    """Run all tests and report results"""
    print(f"\n{Colors.BLUE}{'='*60}{Colors.END}")
    print(f"{Colors.BLUE}Infisical Panel - Comprehensive Test Suite{Colors.END}")
    print(f"{Colors.BLUE}{'='*60}{Colors.END}\n")
    
    tests = [
        ("Server Health", test_server_health),
        ("API Status", test_api_status),
        ("API Projects", test_api_projects),
        ("API Secrets", test_api_secrets),
        ("API Sync Status", test_api_sync_status),
        ("API Manual Sync", test_api_manual_sync),
        ("UI Panel Load", test_ui_panel_load),
        ("UI Tabs Present", test_ui_tabs_present),
        ("UI Data Display", test_ui_data_displays),
        ("UI Projects Tab", test_ui_projects_tab),
    ]
    
    results = []
    for name, test_func in tests:
        print(f"\n{Colors.YELLOW}Running: {name}{Colors.END}")
        result = test_func()
        results.append((name, result))
        time.sleep(0.5)
    
    # Summary
    print(f"\n{Colors.BLUE}{'='*60}{Colors.END}")
    print(f"{Colors.BLUE}Test Summary{Colors.END}")
    print(f"{Colors.BLUE}{'='*60}{Colors.END}\n")
    
    passed = sum(1 for _, result in results if result)
    total = len(results)
    
    for name, result in results:
        status = "PASS" if result else "FAIL"
        color = Colors.GREEN if result else Colors.RED
        print(f"{color}{status:6}{Colors.END} {name}")
    
    print(f"\n{Colors.BLUE}Total: {passed}/{total} tests passed ({passed*100//total}%){Colors.END}\n")
    
    return passed == total

if __name__ == "__main__":
    success = run_all_tests()
    sys.exit(0 if success else 1)
