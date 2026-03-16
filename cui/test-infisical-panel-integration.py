#!/usr/bin/env python3
"""
Infisical Panel Integration Test
Tests the complete flow: Load CUI → Open Panel → Verify Data
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

def test_open_infisical_panel():
    """Test opening Infisical panel and verifying it loads data"""
    print(f"\n{Colors.BOLD}🧪 Testing Infisical Panel Integration{Colors.ENDC}\n")

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=['--disable-gpu', '--disable-software-rasterizer']
        )
        context = browser.new_context()
        page = context.new_page()

        # Enable console logging for debugging
        page.on("console", lambda msg: print(f"  [Browser Console] {msg.type}: {msg.text}"))

        try:
            # Step 1: Load CUI
            print("  ➜ Step 1: Loading CUI...")
            page.goto(CUI_BASE_URL, timeout=60000)
            time.sleep(8)  # Wait for React to mount

            title = page.title()
            if title != "CUI Workspace":
                print(f"  {Colors.FAIL}❌ FAIL: Wrong page title: {title}{Colors.ENDC}")
                return False
            print(f"  {Colors.OKGREEN}✅ CUI loaded (title: {title}){Colors.ENDC}")

            # Step 2: Find and click the "+" button to add panel
            print("\n  ➜ Step 2: Looking for '+' button to add panel...")

            # Try multiple selectors
            add_button = None
            selectors = [
                'button:has-text("+")',
                'button[aria-label*="Add"]',
                'button[title*="Add"]',
                '.flexlayout__tab_toolbar_button',
            ]

            for selector in selectors:
                add_button = page.query_selector(selector)
                if add_button:
                    print(f"  {Colors.OKGREEN}✅ Found add button with selector: {selector}{Colors.ENDC}")
                    break

            if not add_button:
                print(f"  {Colors.FAIL}❌ FAIL: Could not find '+' button{Colors.ENDC}")
                # Take screenshot for debugging
                page.screenshot(path="/tmp/cui-no-add-button.png")
                print("  📸 Screenshot saved to /tmp/cui-no-add-button.png")
                return False

            add_button.click()
            time.sleep(2)

            # Step 3: Look for "Infisical Monitor" in menu
            print("\n  ➜ Step 3: Looking for 'Infisical Monitor' menu item...")

            menu_item = page.query_selector('text="Infisical Monitor"')
            if not menu_item:
                # Try alternative selectors
                menu_item = page.query_selector('li:has-text("Infisical")')

            if not menu_item:
                print(f"  {Colors.FAIL}❌ FAIL: Could not find 'Infisical Monitor' in menu{Colors.ENDC}")
                page.screenshot(path="/tmp/cui-no-menu-item.png")
                print("  📸 Screenshot saved to /tmp/cui-no-menu-item.png")
                return False

            print(f"  {Colors.OKGREEN}✅ Found 'Infisical Monitor' menu item{Colors.ENDC}")
            menu_item.click()
            time.sleep(3)

            # Step 4: Verify panel opened
            print("\n  ➜ Step 4: Verifying panel opened...")

            # Check page content for Infisical-related text
            content = page.content()

            # Look for any of these indicators
            indicators = [
                'infisical',
                'Infisical',
                '100.79.71.99',
                'werking-report',
                'engelmann',
                'Auto-Sync'
            ]

            found_indicators = [ind for ind in indicators if ind in content]

            if len(found_indicators) >= 2:
                print(f"  {Colors.OKGREEN}✅ Panel opened successfully{Colors.ENDC}")
                print(f"     Found indicators: {', '.join(found_indicators[:3])}")

                # Take success screenshot
                page.screenshot(path="/tmp/cui-infisical-success.png")
                print("  📸 Success screenshot: /tmp/cui-infisical-success.png")
                return True
            else:
                print(f"  {Colors.FAIL}❌ FAIL: Panel content not found{Colors.ENDC}")
                print(f"     Found only: {', '.join(found_indicators) if found_indicators else 'none'}")
                page.screenshot(path="/tmp/cui-infisical-fail.png")
                print("  📸 Failure screenshot: /tmp/cui-infisical-fail.png")
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
    success = test_open_infisical_panel()

    if success:
        print(f"\n{Colors.BOLD}{Colors.OKGREEN}✅ ALL TESTS PASSED - INFISICAL PANEL IS FUNCTIONAL{Colors.ENDC}\n")
        sys.exit(0)
    else:
        print(f"\n{Colors.BOLD}{Colors.FAIL}❌ TEST FAILED - SEE SCREENSHOTS IN /tmp/{Colors.ENDC}\n")
        sys.exit(1)
