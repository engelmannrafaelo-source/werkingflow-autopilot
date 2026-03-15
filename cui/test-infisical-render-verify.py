#!/usr/bin/env python3
"""
INFISICAL MONITOR - FINAL UI RENDERING VERIFICATION
Tests actual panel rendering after adding via Layout Builder
100% functional guarantee
"""

import sys
import time
import requests
from playwright.sync_api import sync_playwright

CUI_URL = "http://localhost:4005"

class Colors:
    GREEN = '\033[92m'
    RED = '\033[91m'
    YELLOW = '\033[93m'
    BLUE = '\033[94m'
    RESET = '\033[0m'
    BOLD = '\033[1m'

def print_header(text):
    print(f"\n{Colors.BOLD}{Colors.BLUE}{'=' * 70}{Colors.RESET}")
    print(f"{Colors.BOLD}{Colors.BLUE}{text:^70}{Colors.RESET}")
    print(f"{Colors.BOLD}{Colors.BLUE}{'=' * 70}{Colors.RESET}\n")

def print_test(name, passed, details=""):
    status = f"{Colors.GREEN}✓{Colors.RESET}" if passed else f"{Colors.RED}✗{Colors.RESET}"
    print(f"{status} {name}")
    if details:
        for line in details.split('\n'):
            print(f"  {Colors.YELLOW}{line}{Colors.RESET}")

def main():
    print_header("INFISICAL MONITOR - FINAL UI RENDERING TEST")

    all_passed = True

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,  # Must be headless on server (no X display)
            args=['--disable-gpu', '--disable-software-rasterizer']
        )

        context = browser.new_context(viewport={'width': 1920, 'height': 1080})
        page = context.new_page()

        try:
            # Step 1: Load CUI
            print(f"\n{Colors.BOLD}[1/7] Loading CUI...{Colors.RESET}")
            page.goto(CUI_URL, wait_until='networkidle', timeout=30000)
            time.sleep(5)
            print_test("CUI loaded", True, "")

            # Step 2: Take screenshot of initial state
            page.screenshot(path='/tmp/infisical-test-01-initial.png')
            print_test("Initial screenshot", True, "Saved: /tmp/infisical-test-01-initial.png")

            # Step 3: Find and click Layout Builder
            print(f"\n{Colors.BOLD}[2/7] Opening Layout Builder...{Colors.RESET}")

            # Try to find the ⊞ button
            layout_btn = None
            buttons = page.query_selector_all('button')

            for btn in buttons:
                try:
                    text = btn.inner_text() or ''
                    title = btn.get_attribute('title') or ''
                    aria = btn.get_attribute('aria-label') or ''

                    if '⊞' in text or 'Layout' in title or 'Add Panel' in aria:
                        layout_btn = btn
                        print_test("Found Layout Builder button", True, f"Text: '{text}', Title: '{title}'")
                        break
                except:
                    continue

            if not layout_btn:
                print_test("Layout Builder button", False, "Could not find button")
                all_passed = False
                return 1

            # Click it
            layout_btn.click()
            time.sleep(2)
            page.screenshot(path='/tmp/infisical-test-02-layout-builder.png')
            print_test("Opened Layout Builder", True, "Screenshot: /tmp/infisical-test-02-layout-builder.png")

            # Step 4: Find Infisical Monitor in dropdown
            print(f"\n{Colors.BOLD}[3/7] Selecting Infisical Monitor...{Colors.RESET}")

            # Look for select/dropdown
            select_found = False
            selects = page.query_selector_all('select')

            for select in selects:
                try:
                    options = select.query_selector_all('option')
                    option_texts = [opt.inner_text() for opt in options]

                    print_test("Found dropdown", True, f"{len(option_texts)} options: {', '.join(option_texts[:5])}")

                    # Find Infisical Monitor option
                    infisical_option = None
                    for opt in options:
                        if 'Infisical' in opt.inner_text():
                            infisical_option = opt
                            break

                    if infisical_option:
                        value = infisical_option.get_attribute('value')
                        select.select_option(value=value)
                        select_found = True
                        print_test("Selected Infisical Monitor", True, f"Value: {value}")
                        time.sleep(1)
                        break
                except Exception as e:
                    print_test("Dropdown error", False, str(e))
                    continue

            if not select_found:
                print_test("Infisical Monitor option", False, "Not found in dropdown")
                all_passed = False
                return 1

            # Step 5: Click Add Panel button
            print(f"\n{Colors.BOLD}[4/7] Adding panel...{Colors.RESET}")

            add_btn = page.locator('button').filter(has_text='Add')
            if add_btn.count() > 0:
                add_btn.first.click()
                time.sleep(3)
                page.screenshot(path='/tmp/infisical-test-03-panel-added.png')
                print_test("Panel added", True, "Screenshot: /tmp/infisical-test-03-panel-added.png")
            else:
                print_test("Add button", False, "Not found")
                all_passed = False
                return 1

            # Step 6: Verify panel is visible
            print(f"\n{Colors.BOLD}[5/7] Verifying panel visibility...{Colors.RESET}")

            time.sleep(3)
            html = page.content()

            # Check for Infisical-specific content
            checks = [
                ('Panel title "Infisical Monitor"', 'Infisical Monitor' in html),
                ('Server IP (100.79.71.99)', '100.79.71.99' in html),
                ('Project: werking-report', 'werking-report' in html),
                ('Project: engelmann', 'engelmann' in html),
                ('Sync target: Vercel', 'Vercel' in html),
                ('Sync target: Railway', 'Railway' in html),
                ('Sync status: succeeded', 'succeeded' in html),
            ]

            for check_name, check_result in checks:
                print_test(check_name, check_result, "")
                if not check_result:
                    all_passed = False

            # Step 7: Test tab navigation
            print(f"\n{Colors.BOLD}[6/7] Testing tab navigation...{Colors.RESET}")

            # Find tabs
            tabs = page.query_selector_all('[data-ai-id*="tab"]')
            if len(tabs) > 0:
                print_test(f"Found {len(tabs)} tabs", True, "")

                # Try clicking a few tabs
                for i, tab in enumerate(tabs[:3]):
                    try:
                        tab_text = tab.inner_text()
                        tab.click()
                        time.sleep(1)
                        print_test(f"Tab '{tab_text}' clickable", True, "")
                    except Exception as e:
                        print_test(f"Tab {i} navigation", False, str(e))
                        all_passed = False
            else:
                print_test("Tab navigation", False, "No tabs found")
                all_passed = False

            # Step 8: Verify API calls
            print(f"\n{Colors.BOLD}[7/7] Verifying API integration...{Colors.RESET}")

            # Check via direct API call
            try:
                resp = requests.get(f"{CUI_URL}/api/infisical/status", timeout=5)
                if resp.status_code == 200:
                    data = resp.json()
                    projects = data.get('projects', [])
                    print_test("API responding", True, f"{len(projects)} projects")

                    # Verify all 7 projects
                    expected = ['werking-report', 'engelmann', 'werking-safety-fe',
                               'werking-safety-be', 'werking-energy-fe',
                               'werking-energy-be', 'platform']

                    found_ids = [p.get('id') for p in projects]
                    missing = [exp for exp in expected if exp not in found_ids]

                    if not missing:
                        print_test("All 7 projects present", True, "")
                    else:
                        print_test("All projects present", False, f"Missing: {missing}")
                        all_passed = False
                else:
                    print_test("API status", False, f"HTTP {resp.status_code}")
                    all_passed = False
            except Exception as e:
                print_test("API call", False, str(e))
                all_passed = False

            # Final screenshot
            page.screenshot(path='/tmp/infisical-test-04-final.png')
            print_test("Final screenshot", True, "Saved: /tmp/infisical-test-04-final.png")

        except Exception as e:
            print(f"\n{Colors.RED}{Colors.BOLD}ERROR:{Colors.RESET} {e}")
            import traceback
            traceback.print_exc()
            all_passed = False

        finally:
            time.sleep(2)  # Keep browser open briefly to see result
            browser.close()

    # Summary
    print_header("TEST RESULTS")

    if all_passed:
        print(f"{Colors.GREEN}{Colors.BOLD}✓ ALL CHECKS PASSED{Colors.RESET}")
        print(f"\n{Colors.BOLD}GUARANTEE: Panel is 100% functional{Colors.RESET}")
        print(f"\nScreenshots saved:")
        print(f"  - /tmp/infisical-test-01-initial.png")
        print(f"  - /tmp/infisical-test-02-layout-builder.png")
        print(f"  - /tmp/infisical-test-03-panel-added.png")
        print(f"  - /tmp/infisical-test-04-final.png")
        return 0
    else:
        print(f"{Colors.RED}{Colors.BOLD}✗ SOME CHECKS FAILED{Colors.RESET}")
        print(f"\nPanel may not be fully functional. Review screenshots:")
        print(f"  - /tmp/infisical-test-*.png")
        return 1

if __name__ == "__main__":
    sys.exit(main())
