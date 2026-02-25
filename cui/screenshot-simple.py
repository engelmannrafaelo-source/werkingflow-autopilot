#!/usr/bin/env python3
"""
Simplest approach: Just click Virtual Office tab and screenshot
"""
import asyncio
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, args=['--disable-gpu', '--disable-software-rasterizer'])
        page = await browser.new_page(viewport={'width': 1920, 'height': 1080})

        # Load team project
        print("Loading project=team...")
        await page.goto("http://localhost:4005?project=team", timeout=60000)
        await asyncio.sleep(15)

        # Find ALL tabs and list them
        print("\n📋 All tabs found:")
        all_divs = await page.query_selector_all('div')
        for div in all_divs:
            text = await div.inner_text()
            if 'Virtual Office' in text and len(text) < 50:
                print(f"  Found: '{text}'")
                # Try clicking it
                try:
                    await div.click()
                    print(f"  ✅ Clicked!")
                    await asyncio.sleep(5)
                    break
                except Exception as e:
                    print(f"  ❌ Can't click: {e}")

        # Take screenshot
        await page.screenshot(path='/root/orchestrator/workspaces/team/test.png', full_page=True)
        print("\n📸 Screenshot saved")

        await browser.close()

asyncio.run(main())
