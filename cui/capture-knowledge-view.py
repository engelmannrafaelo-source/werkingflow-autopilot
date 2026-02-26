#!/usr/bin/env python3
"""
Capture Knowledge Base view from Virtual Office
"""
import asyncio
from playwright.async_api import async_playwright

OUTPUT = "/root/orchestrator/workspaces/team"

async def capture():
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=['--disable-gpu', '--disable-software-rasterizer', '--disable-blink-features=AutomationControlled']
        )
        context = await browser.new_context(viewport={'width': 1920, 'height': 1080})
        page = await context.new_page()

        print("🎯 Capturing Knowledge Base View\n")

        # Force reload to clear cache
        await page.goto("http://localhost:4005?t=" + str(asyncio.get_event_loop().time()), timeout=60000)
        await asyncio.sleep(12)

        print("✅ Page loaded, looking for tabs...")

        # Click on Knowledge Base tab if it exists
        try:
            # First try to find the Knowledge Base tab in the left panel
            kb_tab = await page.query_selector('div[data-layout-path] >> text="Knowledge Base"')
            if kb_tab:
                print("📚 Found Knowledge Base tab, clicking...")
                await kb_tab.click()
                await asyncio.sleep(5)
                await page.screenshot(path=f"{OUTPUT}/knowledge-base-view.png", full_page=True)
                print("✅ Screenshot saved: knowledge-base-view.png")
            else:
                print("⚠️  Knowledge Base tab not found in layout")
                print("   Taking fallback screenshot...")
                await page.screenshot(path=f"{OUTPUT}/fallback-view.png", full_page=True)

                # Try to list all visible tabs
                tabs = await page.query_selector_all('[role="tab"]')
                print(f"\n   Found {len(tabs)} tabs:")
                for i, tab in enumerate(tabs[:10]):  # Max 10
                    text = await tab.inner_text()
                    print(f"   {i+1}. {text}")

        except Exception as e:
            print(f"❌ Error: {e}")
            await page.screenshot(path=f"{OUTPUT}/error-screenshot.png", full_page=True)

        await browser.close()

        print(f"\n{'='*60}")
        print("✅ CAPTURE COMPLETE!")
        print(f"   Output: {OUTPUT}/")
        print('='*60)

if __name__ == "__main__":
    asyncio.run(capture())
