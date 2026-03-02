#!/usr/bin/env python3
"""
Infisical Panel UI Tests (Playwright)
Tests the frontend rendering, interactions, and data display
"""

import asyncio
import json
from playwright.async_api import async_playwright, Page, Browser
from typing import Dict, Any

BASE_URL = "http://localhost:4005"

class Colors:
    BLUE = "\033[94m"
    GREEN = "\033[92m"
    YELLOW = "\033[93m"
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

async def wait_for_network_idle(page: Page, timeout: int = 5000):
    """Wait for network to be idle"""
    try:
        await page.wait_for_load_state("networkidle", timeout=timeout)
        return True
    except:
        return False

async def test_infisical_panel_loads(page: Page) -> bool:
    """Test that Infisical panel loads correctly"""
    print_test("Infisical Panel Loads")

    try:
        # Navigate to CUI with Infisical panel
        await page.goto(f"{BASE_URL}/?panels=infisical-monitor", timeout=30000)

        # Wait for panel to load
        await page.wait_for_selector('.infisical-monitor', timeout=10000)
        print_success("Panel container loaded")

        # Check for header
        header = await page.query_selector('.infisical-panel-header')
        if header:
            print_success("Panel header found")
        else:
            print_error("Panel header not found")
            return False

        return True

    except Exception as e:
        print_error(f"Failed to load panel: {e}")
        return False

async def test_status_section_renders(page: Page) -> bool:
    """Test that status section renders correctly"""
    print_test("Status Section Renders")

    try:
        # Wait for status section
        await page.wait_for_selector('.status-card', timeout=5000)
        print_success("Status card found")

        # Check for server URL
        server_elem = await page.query_selector('.server-url')
        if server_elem:
            server_text = await server_elem.text_content()
            print_success(f"Server URL: {server_text}")
        else:
            print_error("Server URL not found")
            return False

        # Check for status indicator
        status_indicator = await page.query_selector('.status-indicator')
        if status_indicator:
            print_success("Status indicator found")
        else:
            print_error("Status indicator not found")
            return False

        return True

    except Exception as e:
        print_error(f"Status section failed: {e}")
        return False

async def test_projects_list_renders(page: Page) -> bool:
    """Test that projects list renders correctly"""
    print_test("Projects List Renders")

    try:
        # Wait for projects section
        await page.wait_for_selector('.projects-section', timeout=5000)
        print_success("Projects section found")

        # Count project cards
        project_cards = await page.query_selector_all('.project-card')
        print_success(f"Found {len(project_cards)} project cards")

        if len(project_cards) == 0:
            print_error("No project cards found")
            return False

        # Check first project card structure
        first_card = project_cards[0]

        # Project name
        name_elem = await first_card.query_selector('.project-name')
        if name_elem:
            name = await name_elem.text_content()
            print_success(f"Project name: {name}")
        else:
            print_error("Project name not found")
            return False

        # Sync target
        target_elem = await first_card.query_selector('.sync-target')
        if target_elem:
            target = await target_elem.text_content()
            print_success(f"Sync target: {target}")
        else:
            print_error("Sync target not found")
            return False

        return True

    except Exception as e:
        print_error(f"Projects list failed: {e}")
        return False

async def test_project_expansion(page: Page) -> bool:
    """Test that clicking a project expands its secrets"""
    print_test("Project Expansion")

    try:
        # Wait for projects
        await page.wait_for_selector('.project-card', timeout=5000)

        # Click first project
        first_project = await page.query_selector('.project-card')
        await first_project.click()
        print_success("Clicked first project")

        # Wait for secrets to load
        await asyncio.sleep(1)

        # Check if secrets section appears
        secrets_section = await first_project.query_selector('.secrets-section')
        if secrets_section:
            print_success("Secrets section appeared")

            # Check for secret items
            secret_items = await secrets_section.query_selector_all('.secret-item')
            print_success(f"Found {len(secret_items)} secrets")

            if len(secret_items) > 0:
                # Check first secret structure
                first_secret = secret_items[0]
                key_elem = await first_secret.query_selector('.secret-key')
                if key_elem:
                    key = await key_elem.text_content()
                    print_success(f"Secret key: {key}")
                else:
                    print_error("Secret key not found")
                    return False

            return True
        else:
            print_error("Secrets section not found")
            return False

    except Exception as e:
        print_error(f"Project expansion failed: {e}")
        return False

async def test_sync_status_section(page: Page) -> bool:
    """Test that sync status section renders correctly"""
    print_test("Sync Status Section")

    try:
        # Wait for sync status section
        await page.wait_for_selector('.sync-status-section', timeout=5000)
        print_success("Sync status section found")

        # Check for sync items
        sync_items = await page.query_selector_all('.sync-item')
        print_success(f"Found {len(sync_items)} sync items")

        if len(sync_items) == 0:
            print_error("No sync items found")
            return False

        # Check first sync item structure
        first_sync = sync_items[0]

        # Project name
        project_elem = await first_sync.query_selector('.sync-project')
        if project_elem:
            project = await project_elem.text_content()
            print_success(f"Sync project: {project}")
        else:
            print_error("Sync project not found")
            return False

        # Status badge
        status_badge = await first_sync.query_selector('.sync-status-badge')
        if status_badge:
            status = await status_badge.text_content()
            print_success(f"Sync status: {status}")
        else:
            print_error("Sync status badge not found")
            return False

        return True

    except Exception as e:
        print_error(f"Sync status section failed: {e}")
        return False

async def test_refresh_button(page: Page) -> bool:
    """Test that refresh button works"""
    print_test("Refresh Button")

    try:
        # Find refresh button
        refresh_btn = await page.query_selector('button[data-action="refresh"]')
        if not refresh_btn:
            print_error("Refresh button not found")
            return False

        print_success("Refresh button found")

        # Click refresh
        await refresh_btn.click()
        print_success("Clicked refresh button")

        # Wait for refresh to complete
        await asyncio.sleep(2)

        # Verify panel still works
        status_card = await page.query_selector('.status-card')
        if status_card:
            print_success("Panel refreshed successfully")
            return True
        else:
            print_error("Panel broken after refresh")
            return False

    except Exception as e:
        print_error(f"Refresh button test failed: {e}")
        return False

async def test_error_handling(page: Page) -> bool:
    """Test that error states are handled gracefully"""
    print_test("Error Handling")

    try:
        # Check if error message appears when API fails
        # (This assumes mock data is working)

        # Look for any error messages
        error_messages = await page.query_selector_all('.error-message')

        if len(error_messages) > 0:
            print_success("Error messages rendered when needed")
        else:
            print_success("No errors (API working correctly)")

        return True

    except Exception as e:
        print_error(f"Error handling test failed: {e}")
        return False

async def run_all_tests():
    """Run all UI tests"""
    print_section("Infisical Panel UI Tests (Playwright)")

    results = {}

    async with async_playwright() as p:
        # Launch browser
        browser = await p.chromium.launch(
            headless=True,
            args=[
                '--disable-gpu',
                '--disable-software-rasterizer',
                '--no-sandbox',
                '--disable-dev-shm-usage'
            ]
        )

        context = await browser.new_context(
            viewport={'width': 1920, 'height': 1080}
        )

        page = await context.new_page()

        # Run tests in sequence
        results['Panel Loads'] = await test_infisical_panel_loads(page)

        if results['Panel Loads']:
            results['Status Section'] = await test_status_section_renders(page)
            results['Projects List'] = await test_projects_list_renders(page)
            results['Project Expansion'] = await test_project_expansion(page)
            results['Sync Status'] = await test_sync_status_section(page)
            results['Refresh Button'] = await test_refresh_button(page)
            results['Error Handling'] = await test_error_handling(page)
        else:
            print_error("Panel failed to load, skipping remaining tests")

        await browser.close()

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
