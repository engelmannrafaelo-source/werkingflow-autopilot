#!/usr/bin/env python3
"""
Simplified Infisical Panel UI Test
Tests actual rendering in browser without complex selectors
"""

import time
from playwright.sync_api import sync_playwright

CUI_BASE_URL = "http://localhost:4005"

def test_ui_simple():
    """Simple test: Can we load CUI and does it have content?"""
    print("\n🧪 Testing CUI UI Load...")

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=['--disable-gpu', '--disable-software-rasterizer']
        )
        context = browser.new_context()
        page = context.new_page()

        try:
            print("  ➜ Loading CUI...")
            page.goto(CUI_BASE_URL, timeout=60000)

            print("  ➜ Waiting for content...")
            time.sleep(8)  # Give React time to mount

            # Check page title
            title = page.title()
            print(f"  ➜ Page title: {title}")

            # Get page content
            content = page.content()

            # Basic checks
            if '#root' not in content and 'id="root"' not in content:
                print("  ❌ FAIL: No root element")
                return False

            if 'flexlayout' in content.lower() or 'cui' in content.lower():
                print("  ✅ PASS: CUI content detected")
                return True
            else:
                print("  ❌ FAIL: No CUI content found")
                # Print first 500 chars for debugging
                print(f"  Content preview: {content[:500]}")
                return False

        except Exception as e:
            print(f"  ❌ ERROR: {str(e)}")
            return False
        finally:
            browser.close()

if __name__ == '__main__':
    success = test_ui_simple()
    exit(0 if success else 1)
