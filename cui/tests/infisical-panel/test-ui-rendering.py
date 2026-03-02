#!/usr/bin/env python3
"""
Infisical Panel UI Rendering Tests
"""

import asyncio
import sys
from playwright.async_api import async_playwright, Page

BASE_URL = "http://localhost:4005"

class Colors:
    GREEN = '\033[92m'
    RED = '\033[91m'
    BLUE = '\033[94m'
    RESET = '\033[0m'

def print_test(name: str):
    print(f"\n{Colors.BLUE}[TEST]{Colors.RESET} {name}")

def print_success(msg: str):
    print(f"{Colors.GREEN}✓{Colors.RESET} {msg}")

def print_error(msg: str):
    print(f"{Colors.RED}✗{Colors.RESET} {msg}")

async def test_page_load(page: Page) -> bool:
    print_test("Page Load")
    try:
        await page.goto(BASE_URL, wait_until='networkidle', timeout=30000)
        title = await page.title()
        print_success(f"Page loaded: {title}")
        return True
    except Exception as e:
        print_error(f"Failed: {e}")
        return False

async def test_panel_exists(page: Page) -> bool:
    print_test("Infisical Panel Exists")
    try:
        await page.goto(f"{BASE_URL}/?panel=infisical-monitor", wait_until='networkidle', timeout=30000)
        await page.wait_for_timeout(2000)

        panel = page.locator('text=Infisical')
        count = await panel.count()

        if count > 0:
            print_success(f"Panel found ({count} elements)")
            return True
        else:
            print_error("Panel not found")
            return False
    except Exception as e:
        print_error(f"Failed: {e}")
        return False

async def run_all_tests():
    print(f"\n{Colors.BLUE}{'='*60}{Colors.RESET}")
    print(f"{Colors.BLUE}Infisical Panel UI Tests{Colors.RESET}")
    print(f"{Colors.BLUE}{'='*60}{Colors.RESET}")

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=['--disable-gpu', '--disable-software-rasterizer']
        )
        
        page = await browser.new_page()
        
        tests = [
            ("Page Load", lambda: test_page_load(page)),
            ("Panel Exists", lambda: test_panel_exists(page)),
        ]
        
        results = []
        for test_name, test_func in tests:
            try:
                result = await test_func()
                results.append((test_name, result))
            except Exception as e:
                print_error(f"Test crashed: {e}")
                results.append((test_name, False))
        
        await browser.close()
        
        passed = sum(1 for _, r in results if r)
        total = len(results)
        
        print(f"\n{Colors.BLUE}Total:{Colors.RESET} {passed}/{total} tests passed")
        return 0 if passed == total else 1

if __name__ == "__main__":
    exit_code = asyncio.run(run_all_tests())
    sys.exit(exit_code)
