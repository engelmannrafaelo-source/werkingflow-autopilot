#!/usr/bin/env python3
"""
Test Infisical Panel in Layout
Verifies that Infisical Monitor tab appears and displays data
"""

import time
from playwright.sync_api import sync_playwright
import sys

CUI_BASE_URL = "http://localhost:4005"

class Colors:
    OKGREEN = '\033[92m'
    FAIL = '\033[91m'
    ENDC = '\033[0m'
    BOLD = '\033[1m'

def test_infisical_panel_in_layout():
    """Test that Infisical Monitor panel is in the layout and displays data"""
    print(f"\n{Colors.BOLD}🧪 Testing Infisical Panel in Layout{Colors.ENDC}\n")

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=['--disable-gpu', '--disable-software-rasterizer']
        )
        # Disable cache to get fresh layout
        context = browser.new_context()
        page = context.new_page()

        # Enable console logging
        page.on("console", lambda msg: print(f"  [Browser] {msg.type}: {msg.text}"))

        try:
            # Step 1: Load CUI with cache bypass
            print("  ➜ Step 1: Loading CUI (bypassing cache)...")
            page.goto(CUI_BASE_URL, timeout=60000)

            # Force hard reload to bypass cache
            page.reload(wait_until="networkidle", timeout=60000)
            time.sleep(10)  # Wait for React and layout to fully load

            print(f"  {Colors.OKGREEN}✅ CUI loaded{Colors.ENDC}")

            # Step 2: Look for "Infisical Monitor" tab
            print("\n  ➜ Step 2: Looking for 'Infisical Monitor' tab...")

            # Take screenshot before checking
            page.screenshot(path="/tmp/cui-before-check.png")
            print("  📸 Screenshot: /tmp/cui-before-check.png")

            # Check page content
            content = page.content()

            if 'Infisical Monitor' in content:
                print(f"  {Colors.OKGREEN}✅ Found 'Infisical Monitor' in page{Colors.ENDC}")
            else:
                print(f"  {Colors.FAIL}❌ 'Infisical Monitor' not found in page{Colors.ENDC}")
                return False

            # Step 3: Try to click on the Infisical Monitor tab
            print("\n  ➜ Step 3: Clicking 'Infisical Monitor' tab...")

            tab_selectors = [
                'text="Infisical Monitor"',
                '[data-layout-path*="Infisical"]',
                '.flexlayout__tab_button:has-text("Infisical")',
            ]

            tab_element = None
            for selector in tab_selectors:
                tab_element = page.query_selector(selector)
                if tab_element:
                    print(f"  {Colors.OKGREEN}✅ Found tab with selector: {selector}{Colors.ENDC}")
                    break

            if not tab_element:
                print(f"  {Colors.FAIL}❌ Could not find Infisical Monitor tab element{Colors.ENDC}")
                page.screenshot(path="/tmp/cui-no-tab.png")
                print("  📸 Screenshot: /tmp/cui-no-tab.png")
                return False

            tab_element.click()
            time.sleep(5)  # Wait for panel to render and fetch data

            # Step 4: Verify panel content
            print("\n  ➜ Step 4: Verifying panel displays data...")

            page.screenshot(path="/tmp/cui-after-click.png")
            print("  📸 Screenshot: /tmp/cui-after-click.png")

            content = page.content()

            # Check for Infisical-specific content
            indicators = [
                '100.79.71.99',
                'werking-report',
                'engelmann',
                'Vercel',
                'Railway',
                'Auto-Sync',
                'Production',
            ]

            found = [ind for ind in indicators if ind in content]

            if len(found) >= 3:
                print(f"  {Colors.OKGREEN}✅ Panel displays data successfully{Colors.ENDC}")
                print(f"     Found indicators: {', '.join(found)}")
                page.screenshot(path="/tmp/cui-infisical-success.png")
                print("  📸 Success screenshot: /tmp/cui-infisical-success.png")
                return True
            else:
                print(f"  {Colors.FAIL}❌ Panel not showing expected data{Colors.ENDC}")
                print(f"     Only found: {', '.join(found) if found else 'none'}")
                return False

        except Exception as e:
            print(f"  {Colors.FAIL}❌ ERROR: {str(e)}{Colors.ENDC}")
            try:
                page.screenshot(path="/tmp/cui-error.png")
                print("  📸 Error screenshot: /tmp/cui-error.png")
            except:
                pass
            return False
        finally:
            browser.close()

if __name__ == '__main__':
    success = test_infisical_panel_in_layout()

    if success:
        print(f"\n{Colors.BOLD}{Colors.OKGREEN}✅ INFISICAL PANEL IS 100% FUNCTIONAL{Colors.ENDC}\n")
        sys.exit(0)
    else:
        print(f"\n{Colors.BOLD}{Colors.FAIL}❌ INFISICAL PANEL TEST FAILED{Colors.ENDC}\n")
        sys.exit(1)
