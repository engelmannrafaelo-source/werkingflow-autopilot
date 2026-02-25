#!/usr/bin/env python3
"""
Try clicking the Virtual Office menu option to open it
"""
import asyncio
from pathlib import Path
from playwright.async_api import async_playwright

OUTPUT_DIR = "/root/orchestrator/workspaces/team"

async def test_menu_click():
    print("🔍 Testing menu option click\n")

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=['--disable-gpu', '--disable-software-rasterizer']
        )

        context = await browser.new_context(viewport={'width': 1920, 'height': 1080})
        page = await context.new_page()

        try:
            await page.goto("http://localhost:4005?project=team", wait_until='networkidle')
            await asyncio.sleep(5)

            # Look for the + button or menu
            print("🔍 Looking for add panel menu...")

            # Try to find and click the "+" button in sticky buttons
            plus_buttons = await page.query_selector_all('text="+"')
            if plus_buttons:
                print(f"✅ Found {len(plus_buttons)} '+' buttons")
                for i, btn in enumerate(plus_buttons[:3]):
                    try:
                        await btn.click(timeout=1000)
                        await asyncio.sleep(2)
                        await page.screenshot(path=f"{OUTPUT_DIR}/menu-click-{i}.png")
                        print(f"📸 Clicked + button {i}")

                        # Look for Virtual Office option
                        vo_options = await page.query_selector_all('text=/Virtual Office/i')
                        if vo_options:
                            print(f"✅ Found {len(vo_options)} Virtual Office options")
                            for j, opt in enumerate(vo_options[:2]):
                                try:
                                    await opt.click(timeout=1000)
                                    await asyncio.sleep(3)
                                    await page.screenshot(path=f"{OUTPUT_DIR}/virtual-office-opened-{i}-{j}.png", full_page=True)
                                    print(f"📸 Clicked Virtual Office option {i}-{j}")

                                    # Check if it rendered
                                    has_virtual_office = await page.evaluate("""
                                        () => {
                                            return document.body.textContent.includes('Activity Stream') ||
                                                   document.body.textContent.includes('Agent Grid') ||
                                                   document.body.textContent.includes('Dashboard');
                                        }
                                    """)

                                    if has_virtual_office:
                                        print("✅ Virtual Office rendered successfully!")
                                        return True
                                except Exception as e:
                                    print(f"  ❌ Click failed: {e}")
                    except Exception as e:
                        print(f"  ❌ + button click failed: {e}")

            print("\n❌ Could not open Virtual Office via menu")
            return False

        finally:
            await browser.close()

if __name__ == "__main__":
    success = asyncio.run(test_menu_click())
    exit(0 if success else 1)
