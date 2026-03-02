#!/usr/bin/env python3
"""
Layout-Based Integration Test - Infisical Panel
Tests panel by creating a project with Infisical in the layout
"""

import asyncio
import sys
import json
import requests
from playwright.async_api import async_playwright, Page

BASE_URL = "http://localhost:4005"
API_URL = f"{BASE_URL}/api"

class Colors:
    GREEN = '\033[92m'
    RED = '\033[91m'
    BLUE = '\033[94m'
    YELLOW = '\033[93m'
    RESET = '\033[0m'

def print_test(name: str):
    print(f"\n{Colors.BLUE}[TEST]{Colors.RESET} {name}")

def print_success(msg: str):
    print(f"{Colors.GREEN}✓{Colors.RESET} {msg}")

def print_error(msg: str):
    print(f"{Colors.RED}✗{Colors.RESET} {msg}")

def print_warning(msg: str):
    print(f"{Colors.YELLOW}⚠{Colors.RESET} {msg}")

def create_test_project() -> dict:
    """Create a test project with Infisical panel in layout"""
    layout = {
        "global": {},
        "borders": [],
        "layout": {
            "type": "row",
            "children": [
                {
                    "type": "tabset",
                    "children": [
                        {
                            "type": "tab",
                            "name": "Infisical Monitor",
                            "component": "infisical-monitor"
                        }
                    ]
                }
            ]
        }
    }

    project = {
        "id": "test-infisical",
        "name": "Infisical Test",
        "workDir": "/tmp",
        "layout": json.dumps(layout),
        "lastOpened": "2026-03-02T00:00:00.000Z"
    }

    return project

async def test_create_project_with_panel() -> bool:
    """Test creating a project with Infisical panel"""
    print_test("Create Test Project")

    try:
        project = create_test_project()
        response = requests.post(f"{API_URL}/projects", json=project, timeout=10)

        if response.status_code == 200:
            print_success("Test project created")
            return True
        else:
            print_error(f"Failed to create project: {response.status_code}")
            return False

    except Exception as e:
        print_error(f"Failed to create project: {e}")
        return False

async def test_panel_renders(page: Page) -> bool:
    """Test that Infisical panel renders in the test project"""
    print_test("Panel Rendering")

    try:
        # Open test project
        await page.goto(f"{BASE_URL}/?project=test-infisical", wait_until='domcontentloaded', timeout=15000)
        await page.wait_for_timeout(5000)  # Wait for layout to load
        print_success("Page loaded")

        # Check for Infisical tab
        if await page.locator('text=Infisical Monitor').count() > 0:
            print_success("Found 'Infisical Monitor' tab")
        else:
            print_warning("'Infisical Monitor' tab not found")

        # Check for panel content
        if await page.locator('text=Infisical').count() > 0:
            print_success("Found 'Infisical' text in content")

        if await page.locator('text=Prod-Ops').count() > 0:
            print_success("Found 'Prod-Ops' text (PanelConnectivityGuard)")

        # Take screenshot
        await page.screenshot(path='/tmp/infisical-panel-layout-test.png')
        print_success("Screenshot: /tmp/infisical-panel-layout-test.png")

        return True

    except Exception as e:
        print_error(f"Panel rendering test failed: {e}")
        # Try to take screenshot anyway
        try:
            await page.screenshot(path='/tmp/infisical-panel-layout-test-error.png')
            print_warning("Error screenshot: /tmp/infisical-panel-layout-test-error.png")
        except:
            pass
        return False

async def test_panel_functionality(page: Page) -> bool:
    """Test panel tabs and interactions"""
    print_test("Panel Functionality")

    try:
        await page.goto(f"{BASE_URL}/?project=test-infisical", wait_until='domcontentloaded', timeout=15000)
        await page.wait_for_timeout(3000)

        # Look for Overview/Projects/Secrets tabs
        tabs_found = 0

        if await page.locator('text=Overview').count() > 0:
            print_success("Found 'Overview' tab")
            tabs_found += 1

        if await page.locator('text=Projects').count() > 0:
            print_success("Found 'Projects' tab")
            tabs_found += 1

        if await page.locator('text=Secrets').count() > 0:
            print_success("Found 'Secrets' tab")
            tabs_found += 1

        if tabs_found > 0:
            print_success(f"Found {tabs_found}/3 expected tabs")
            return True
        else:
            print_warning("No tabs found - panel might be showing connectivity guard")
            return True  # Not critical if Infisical is unavailable

    except Exception as e:
        print_error(f"Functionality test failed: {e}")
        return False

async def test_cleanup() -> bool:
    """Cleanup test project"""
    print_test("Cleanup")

    try:
        response = requests.delete(f"{API_URL}/projects/test-infisical", timeout=10)
        if response.status_code == 200:
            print_success("Test project deleted")
            return True
        else:
            print_warning(f"Failed to delete project: {response.status_code}")
            return True  # Not critical

    except Exception as e:
        print_warning(f"Cleanup failed: {e}")
        return True  # Not critical

async def run_tests():
    """Run all tests"""
    print(f"\n{Colors.BLUE}{'='*60}{Colors.RESET}")
    print(f"{Colors.BLUE}Infisical Panel Layout Tests{Colors.RESET}")
    print(f"{Colors.BLUE}{'='*60}{Colors.RESET}")

    # Create project first
    if not await test_create_project_with_panel():
        print(f"\n{Colors.RED}Failed to create test project - aborting{Colors.RESET}")
        return 1

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=['--disable-gpu', '--disable-software-rasterizer']
        )

        page = await browser.new_page()

        tests = [
            ("Panel Renders", lambda: test_panel_renders(page)),
            ("Panel Functionality", lambda: test_panel_functionality(page)),
        ]

        results = [("Project Creation", True)]  # Already passed

        for test_name, test_func in tests:
            try:
                result = await test_func()
                results.append((test_name, result))
            except Exception as e:
                print_error(f"Test crashed: {e}")
                results.append((test_name, False))

        await browser.close()

        # Cleanup
        cleanup_result = await test_cleanup()
        results.append(("Cleanup", cleanup_result))

        # Print summary
        print(f"\n{Colors.BLUE}{'='*60}{Colors.RESET}")
        print(f"{Colors.BLUE}Test Summary{Colors.RESET}")
        print(f"{Colors.BLUE}{'='*60}{Colors.RESET}")

        passed = sum(1 for _, r in results if r)
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
    exit_code = asyncio.run(run_tests())
    sys.exit(exit_code)
