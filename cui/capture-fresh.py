#!/usr/bin/env python3
"""
Capture with fresh browser state (no cache, no local storage)
"""
import asyncio
from playwright.async_api import async_playwright
import time

OUTPUT = "/root/orchestrator/workspaces/team"

async def capture():
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=[
                '--disable-gpu',
                '--disable-software-rasterizer',
                '--disable-blink-features=AutomationControlled',
                '--incognito'  # Incognito mode = fresh state
            ]
        )
        context = await browser.new_context(
            viewport={'width': 1920, 'height': 1080},
            storage_state=None  # No cookies/localstorage
        )
        page = await context.new_page()

        print("🎯 Capturing with Fresh Browser State\n")

        # Add timestamp to bypass any HTTP cache
        url = f"http://localhost:4005?_t={int(time.time()*1000)}"
        await page.goto(url, timeout=60000, wait_until='networkidle')

        print("✅ Page loaded, waiting for layout to render...")
        await asyncio.sleep(15)  # Long wait for flexlayout to initialize

        # Take full screenshot
        await page.screenshot(path=f"{OUTPUT}/fresh-load.png", full_page=True)
        print(f"📸 Screenshot: fresh-load.png")

        # Try to find tabs
        print("\n🔍 Looking for tabs...")

        # Flexlayout tabs are in .flexlayout__tab
        tabs = await page.query_selector_all('.flexlayout__tab')
        print(f"   Found {len(tabs)} flexlayout tabs")

        for i, tab in enumerate(tabs[:15]):
            try:
                text = await tab.inner_text()
                print(f"   {i+1}. '{text}'")

                # Click Knowledge Base if found
                if 'Knowledge' in text:
                    print(f"\n📚 Clicking '{text}' tab...")
                    await tab.click()
                    await asyncio.sleep(5)
                    await page.screenshot(path=f"{OUTPUT}/knowledge-base-active.png", full_page=True)
                    print("   ✅ Screenshot: knowledge-base-active.png")
                    break
            except:
                pass

        await browser.close()

        print(f"\n{'='*60}")
        print("✅ CAPTURE COMPLETE!")
        print(f"   Output: {OUTPUT}/")
        print('='*60)

if __name__ == "__main__":
    asyncio.run(capture())
