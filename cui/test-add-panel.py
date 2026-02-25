#!/usr/bin/env python3
"""
Try to add Virtual Office panel via the "+" button
"""
import asyncio
from pathlib import Path
from playwright.async_api import async_playwright

OUTPUT_DIR = "/root/orchestrator/workspaces/team/add-panel-test"
Path(OUTPUT_DIR).mkdir(parents=True, exist_ok=True)

async def test_add_panel():
    print("🔍 Testing Add Panel Button\n")

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=['--disable-gpu', '--disable-software-rasterizer']
        )

        context = await browser.new_context(viewport={'width': 1920, 'height': 1080})
        page = await context.new_page()

        try:
            await page.goto("http://localhost:4005?project=team", wait_until='networkidle')
            await asyncio.sleep(3)

            await page.screenshot(path=f"{OUTPUT_DIR}/01-initial.png")
            print("📸 01: Initial\n")

            # Look for the "+" button in sticky buttons
            print("🔍 Looking for + button...")
            plus_buttons = await page.query_selector_all('text="+Rafael"')
            print(f"Found {len(plus_buttons)} elements with '+Rafael' text")

            # Try clicking the actual + button area
            try:
                # Get the sticky buttons container
                sticky_container = await page.query_selector('.flexlayout__tab_toolbar_sticky_buttons_container')
                if sticky_container:
                    print("✅ Found sticky buttons container")

                    # Look for the + specifically
                    plus_btn = await page.query_selector('text="+"')
                    if plus_btn:
                        print("✅ Found + button, clicking...")
                        await plus_btn.click()
                        await asyncio.sleep(2)
                        await page.screenshot(path=f"{OUTPUT_DIR}/02-after-plus-click.png")
                        print("📸 02: After + click")

                        # Check if menu appeared
                        menu = await page.query_selector('[class*="menu"]')
                        if menu:
                            print("✅ Menu appeared!")

                            # Look for "office" option
                            office_option = await page.query_selector('text="office"')
                            if office_option:
                                print("✅ Found office option, clicking...")
                                await office_option.click()
                                await asyncio.sleep(3)
                                await page.screenshot(path=f"{OUTPUT_DIR}/03-office-added.png")
                                print("📸 03: Office added")
                            else:
                                print("❌ No office option in menu")
                        else:
                            print("❌ No menu appeared")
                    else:
                        print("❌ No + button found")
                else:
                    print("❌ No sticky buttons container")
            except Exception as e:
                print(f"❌ Error: {e}")

            # Check if we now have Virtual Office elements
            print("\n🔍 Checking for Virtual Office elements...")
            elements = [
                "button:has-text('Dashboard')",
                "button:has-text('Agent Grid')",
                "div:has-text('Live Activity')"
            ]

            for selector in elements:
                try:
                    elem = await page.wait_for_selector(selector, timeout=2000)
                    if elem:
                        print(f"  ✅ Found: {selector}")
                except:
                    print(f"  ❌ Not found: {selector}")

            await page.screenshot(path=f"{OUTPUT_DIR}/04-final.png")
            print("📸 04: Final state")

        finally:
            await browser.close()

if __name__ == "__main__":
    asyncio.run(test_add_panel())
