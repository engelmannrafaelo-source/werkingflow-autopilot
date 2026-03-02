#!/usr/bin/env python3
"""
Infisical Panel Simple UI Tests
Tests the actual rendered panel structure
"""

import asyncio
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

async def run_tests():
    """Run simplified UI tests"""
    print_section("Infisical Panel UI Tests")

    results = {}

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=['--disable-gpu', '--disable-software-rasterizer']
        )
        context = await browser.new_context(viewport={'width': 1920, 'height': 1080})
        page = await context.new_page()

        # Test 1: Panel loads
        print_test("Panel Loads")
        try:
            await page.goto(f"{BASE_URL}/?panels=infisical-monitor", timeout=30000)
            await page.wait_for_selector('.infisical-monitor', timeout=15000)
            print_success("Panel container loaded")
            results['Panel Loads'] = True
        except Exception as e:
            print_error(f"Failed: {e}")
            results['Panel Loads'] = False
            await browser.close()
            return results

        # Test 2: Header renders
        print_test("Header Renders")
        try:
            header = await page.query_selector('h3:has-text("Infisical Monitor")')
            if header:
                print_success("Header found")
                results['Header'] = True
            else:
                print_error("Header not found")
                results['Header'] = False
        except Exception as e:
            print_error(f"Failed: {e}")
            results['Header'] = False

        # Test 3: Tabs render
        print_test("Tabs Render")
        try:
            # Look for tab buttons (they contain emoji + text)
            tabs = await page.query_selector_all('button:has-text("Overview"), button:has-text("Projects"), button:has-text("Syncs")')
            if len(tabs) >= 3:
                print_success(f"Found {len(tabs)} tab buttons")
                results['Tabs'] = True
            else:
                print_error(f"Only found {len(tabs)} tabs (expected at least 3)")
                results['Tabs'] = False
        except Exception as e:
            print_error(f"Failed: {e}")
            results['Tabs'] = False

        # Test 4: Can click Projects tab
        print_test("Click Projects Tab")
        try:
            projects_tab = await page.query_selector('button:has-text("Projects")')
            if projects_tab:
                await projects_tab.click()
                await asyncio.sleep(1)
                print_success("Clicked Projects tab")
                results['Tab Click'] = True
            else:
                print_error("Projects tab not found")
                results['Tab Click'] = False
        except Exception as e:
            print_error(f"Failed: {e}")
            results['Tab Click'] = False

        # Test 5: Projects content loads
        print_test("Projects Content Loads")
        try:
            # After clicking Projects, look for project items (they have h4 tags)
            await asyncio.sleep(1)
            project_headers = await page.query_selector_all('h4')
            if len(project_headers) >= 5:  # We know there are 7 projects
                print_success(f"Found {len(project_headers)} project items")
                results['Projects Content'] = True
            else:
                print_error(f"Only found {len(project_headers)} project items")
                results['Projects Content'] = False
        except Exception as e:
            print_error(f"Failed: {e}")
            results['Projects Content'] = False

        # Test 6: Can click Syncs tab
        print_test("Click Syncs Tab")
        try:
            syncs_tab = await page.query_selector('button:has-text("Syncs")')
            if syncs_tab:
                await syncs_tab.click()
                await asyncio.sleep(1)
                print_success("Clicked Syncs tab")
                results['Syncs Tab'] = True
            else:
                print_error("Syncs tab not found")
                results['Syncs Tab'] = False
        except Exception as e:
            print_error(f"Failed: {e}")
            results['Syncs Tab'] = False

        # Test 7: Refresh button works
        print_test("Refresh Button")
        try:
            refresh_btn = await page.query_selector('button:has-text("Refresh")')
            if refresh_btn:
                await refresh_btn.click()
                await asyncio.sleep(2)
                print_success("Refresh button works")
                results['Refresh'] = True
            else:
                print_error("Refresh button not found")
                results['Refresh'] = False
        except Exception as e:
            print_error(f"Failed: {e}")
            results['Refresh'] = False

        await browser.close()

    return results

async def main():
    results = await run_tests()

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
    success = asyncio.run(main())
    exit(0 if success else 1)
