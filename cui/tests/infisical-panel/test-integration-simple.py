#!/usr/bin/env python3
"""
Infisical Panel Simple Integration Tests
Tests that API data flows correctly to the UI
"""

import asyncio
import requests
from playwright.async_api import async_playwright

BASE_URL = "http://localhost:4005"

class Colors:
    BLUE = "\033[94m"
    GREEN = "\033[92m"
    RED = "\033[91m"
    RESET = "\033[0m"

def print_test(msg: str):
    print(f"\n{Colors.BLUE}[TEST]{Colors.RESET} {msg}")

def print_success(msg: str):
    print(f"{Colors.GREEN}✓{Colors.RESET} {msg}")

def print_error(msg: str):
    print(f"{Colors.RED}✗{Colors.RESET} {msg}")

def print_section(title: str):
    print(f"\n{Colors.BLUE}{'='*60}{Colors.RESET}")
    print(f"{Colors.BLUE}{title}{Colors.RESET}")
    print(f"{Colors.BLUE}{'='*60}{Colors.RESET}")

async def test_api_to_ui_projects():
    """Test that projects from API appear in UI"""
    print_test("API → UI: Projects Count")

    try:
        # Get projects from API
        response = requests.get(f"{BASE_URL}/api/infisical/projects", timeout=10)
        projects = response.json()
        expected_count = len(projects)
        print_success(f"API returned {expected_count} projects")

        # Check UI
        async with async_playwright() as p:
            browser = await p.chromium.launch(
                headless=True,
                args=['--disable-gpu', '--disable-software-rasterizer']
            )
            context = await browser.new_context(viewport={'width': 1920, 'height': 1080})
            page = await context.new_page()

            await page.goto(f"{BASE_URL}/?panels=infisical-monitor", timeout=30000)
            await page.wait_for_selector('.infisical-monitor', timeout=10000)

            # Click Projects tab
            projects_tab = await page.query_selector('button:has-text("Projects")')
            if not projects_tab:
                print_error("Projects tab not found")
                await browser.close()
                return False

            await projects_tab.click()
            await asyncio.sleep(1)

            # Count project items (h4 tags within project cards)
            project_items = await page.query_selector_all('h4')
            actual_count = len(project_items)

            await browser.close()

            if actual_count >= expected_count * 0.8:  # Allow some tolerance
                print_success(f"UI shows {actual_count} project items (expected ~{expected_count})")
                return True
            else:
                print_error(f"UI shows {actual_count} project items (expected {expected_count})")
                return False

    except Exception as e:
        print_error(f"Test failed: {e}")
        return False

async def test_api_to_ui_syncs():
    """Test that syncs from API appear in UI"""
    print_test("API → UI: Syncs Count")

    try:
        # Get syncs from API
        response = requests.get(f"{BASE_URL}/api/infisical/sync-status", timeout=10)
        data = response.json()
        expected_count = len(data['syncs'])
        print_success(f"API returned {expected_count} syncs")

        # Check UI
        async with async_playwright() as p:
            browser = await p.chromium.launch(
                headless=True,
                args=['--disable-gpu', '--disable-software-rasterizer']
            )
            context = await browser.new_context(viewport={'width': 1920, 'height': 1080})
            page = await context.new_page()

            await page.goto(f"{BASE_URL}/?panels=infisical-monitor", timeout=30000)
            await page.wait_for_selector('.infisical-monitor', timeout=10000)

            # Click Syncs tab
            syncs_tab = await page.query_selector('button:has-text("Syncs")')
            if not syncs_tab:
                print_error("Syncs tab not found")
                await browser.close()
                return False

            await syncs_tab.click()
            await asyncio.sleep(1)

            # Count sync items (look for h4 tags)
            sync_items = await page.query_selector_all('h4')
            actual_count = len(sync_items)

            await browser.close()

            if actual_count >= expected_count * 0.8:  # Allow some tolerance
                print_success(f"UI shows {actual_count} sync items (expected ~{expected_count})")
                return True
            else:
                print_error(f"UI shows {actual_count} sync items (expected {expected_count})")
                return False

    except Exception as e:
        print_error(f"Test failed: {e}")
        return False

async def test_refresh_updates():
    """Test that refresh button fetches fresh data"""
    print_test("Refresh Button Updates Data")

    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch(
                headless=True,
                args=['--disable-gpu', '--disable-software-rasterizer']
            )
            context = await browser.new_context(viewport={'width': 1920, 'height': 1080})
            page = await context.new_page()

            # Load panel
            await page.goto(f"{BASE_URL}/?panels=infisical-monitor", timeout=30000)
            await page.wait_for_selector('.infisical-monitor', timeout=10000)
            print_success("Panel loaded")

            # Get initial timestamp
            status1 = requests.get(f"{BASE_URL}/api/infisical/status", timeout=10).json()
            initial_time = status1.get('last_check', '')

            # Wait and refresh
            await asyncio.sleep(2)

            refresh_btn = await page.query_selector('button:has-text("Refresh")')
            if not refresh_btn:
                print_error("Refresh button not found")
                await browser.close()
                return False

            await refresh_btn.click()
            await asyncio.sleep(2)

            # Get new timestamp
            status2 = requests.get(f"{BASE_URL}/api/infisical/status", timeout=10).json()
            new_time = status2.get('last_check', '')

            await browser.close()

            if new_time != initial_time:
                print_success("Data refreshed (timestamp changed)")
                return True
            else:
                print_error("Data not refreshed (timestamp unchanged)")
                return False

    except Exception as e:
        print_error(f"Test failed: {e}")
        return False

async def run_tests():
    """Run all integration tests"""
    print_section("Infisical Panel Integration Tests")

    results = {}
    results['API → UI Projects'] = await test_api_to_ui_projects()
    results['API → UI Syncs'] = await test_api_to_ui_syncs()
    results['Refresh Updates'] = await test_refresh_updates()

    # Print summary
    print_section("Test Summary")

    passed = sum(1 for v in results.values() if v)
    total = len(results)

    for test_name, result in results.items():
        status = f"{Colors.GREEN}✓{Colors.RESET}" if result else f"{Colors.RED}✗{Colors.RESET}"
        print(f"{status} {test_name}")

    print(f"\n{Colors.BLUE}Total:{Colors.RESET} {passed}/{total} tests passed")

    if passed < total:
        print(f"{Colors.RED}{total - passed} tests failed{Colors.RESET}")
        return False
    else:
        print(f"{Colors.GREEN}All tests passed!{Colors.RESET}")
        return True

if __name__ == "__main__":
    success = asyncio.run(run_tests())
    exit(0 if success else 1)
