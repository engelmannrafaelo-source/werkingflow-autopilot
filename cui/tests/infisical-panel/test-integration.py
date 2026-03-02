#!/usr/bin/env python3
"""
Infisical Panel Integration Tests
Tests the full flow from API to UI rendering
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

def test_api_projects_endpoint() -> dict:
    """Test API projects endpoint and return data"""
    print_test("API: Get Projects")

    try:
        response = requests.get(f"{BASE_URL}/api/infisical/projects", timeout=10)
        data = response.json()

        print_success(f"API returned {len(data['projects'])} projects")
        return data['projects']

    except Exception as e:
        print_error(f"API failed: {e}")
        return []

async def test_ui_shows_projects(expected_count: int) -> bool:
    """Test that UI shows the correct number of projects"""
    print_test(f"UI: Verify {expected_count} Projects")

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
            await page.wait_for_selector('.project-card', timeout=10000)

            # Count projects
            project_cards = await page.query_selector_all('.project-card')
            actual_count = len(project_cards)

            await browser.close()

            if actual_count == expected_count:
                print_success(f"UI shows {actual_count} projects (matches API)")
                return True
            else:
                print_error(f"UI shows {actual_count} projects (expected {expected_count})")
                return False

    except Exception as e:
        print_error(f"UI test failed: {e}")
        return False

async def test_project_secrets_flow() -> bool:
    """Test clicking a project and loading secrets"""
    print_test("Full Flow: Click Project → Load Secrets")

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
            await page.wait_for_selector('.project-card', timeout=10000)
            print_success("Panel loaded")

            # Get first project ID from UI
            first_project = await page.query_selector('.project-card')
            project_id = await first_project.get_attribute('data-project-id')
            print_success(f"Found project: {project_id}")

            # Test API endpoint for this project
            response = requests.get(f"{BASE_URL}/api/infisical/secrets/{project_id}", timeout=10)
            api_secrets = response.json()
            expected_secret_count = len(api_secrets['secrets'])
            print_success(f"API returned {expected_secret_count} secrets")

            # Click project in UI
            await first_project.click()
            await asyncio.sleep(1)

            # Check if secrets loaded in UI
            secrets_section = await first_project.query_selector('.secrets-section')
            if not secrets_section:
                print_error("Secrets section not found after click")
                await browser.close()
                return False

            secret_items = await secrets_section.query_selector_all('.secret-item')
            actual_secret_count = len(secret_items)

            await browser.close()

            if actual_secret_count == expected_secret_count:
                print_success(f"UI shows {actual_secret_count} secrets (matches API)")
                return True
            else:
                print_error(f"UI shows {actual_secret_count} secrets (expected {expected_secret_count})")
                return False

    except Exception as e:
        print_error(f"Integration test failed: {e}")
        return False

async def test_sync_status_flow() -> bool:
    """Test sync status API and UI consistency"""
    print_test("Full Flow: Sync Status API → UI")

    try:
        # Get sync status from API
        response = requests.get(f"{BASE_URL}/api/infisical/sync-status", timeout=10)
        api_data = response.json()
        expected_sync_count = len(api_data['syncs'])
        print_success(f"API returned {expected_sync_count} sync items")

        # Check UI
        async with async_playwright() as p:
            browser = await p.chromium.launch(
                headless=True,
                args=['--disable-gpu', '--disable-software-rasterizer']
            )
            context = await browser.new_context(viewport={'width': 1920, 'height': 1080})
            page = await context.new_page()

            await page.goto(f"{BASE_URL}/?panels=infisical-monitor", timeout=30000)
            await page.wait_for_selector('.sync-item', timeout=10000)

            sync_items = await page.query_selector_all('.sync-item')
            actual_sync_count = len(sync_items)

            await browser.close()

            if actual_sync_count == expected_sync_count:
                print_success(f"UI shows {actual_sync_count} sync items (matches API)")
                return True
            else:
                print_error(f"UI shows {actual_sync_count} sync items (expected {expected_sync_count})")
                return False

    except Exception as e:
        print_error(f"Sync status flow failed: {e}")
        return False

async def test_refresh_updates_data() -> bool:
    """Test that refresh button fetches fresh data"""
    print_test("Full Flow: Refresh Button Updates Data")

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
            await page.wait_for_selector('.status-card', timeout=10000)
            print_success("Panel loaded")

            # Get initial last_check time
            status_response = requests.get(f"{BASE_URL}/api/infisical/status", timeout=10)
            initial_time = status_response.json()['last_check']
            print_success(f"Initial last_check: {initial_time}")

            # Wait a moment
            await asyncio.sleep(2)

            # Click refresh button
            refresh_btn = await page.query_selector('button[data-action="refresh"]')
            if not refresh_btn:
                print_error("Refresh button not found")
                await browser.close()
                return False

            await refresh_btn.click()
            print_success("Clicked refresh button")

            # Wait for refresh
            await asyncio.sleep(2)

            # Get new last_check time
            new_response = requests.get(f"{BASE_URL}/api/infisical/status", timeout=10)
            new_time = new_response.json()['last_check']
            print_success(f"New last_check: {new_time}")

            await browser.close()

            if new_time != initial_time:
                print_success("Data was refreshed (timestamp changed)")
                return True
            else:
                print_error("Data was not refreshed (timestamp unchanged)")
                return False

    except Exception as e:
        print_error(f"Refresh test failed: {e}")
        return False

async def run_all_tests():
    """Run all integration tests"""
    print_section("Infisical Panel Integration Tests")

    results = {}

    # Test API first
    projects = test_api_projects_endpoint()
    results['API Projects'] = len(projects) > 0

    if results['API Projects']:
        # Test UI matches API
        results['UI Projects Match'] = await test_ui_shows_projects(len(projects))

        # Test project secrets flow
        results['Project Secrets Flow'] = await test_project_secrets_flow()

        # Test sync status flow
        results['Sync Status Flow'] = await test_sync_status_flow()

        # Test refresh flow
        results['Refresh Updates Data'] = await test_refresh_updates_data()
    else:
        print_error("API projects failed, skipping remaining tests")

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
    success = asyncio.run(run_all_tests())
    exit(0 if success else 1)
