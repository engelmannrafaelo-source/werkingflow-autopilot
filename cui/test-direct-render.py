#!/usr/bin/env python3
"""
Direct render test - load page and take screenshots immediately
"""
import asyncio
from pathlib import Path
from playwright.async_api import async_playwright

OUTPUT_DIR = "/root/orchestrator/workspaces/team"
Path(OUTPUT_DIR).mkdir(parents=True, exist_ok=True)

async def capture_screenshots():
    print("🎯 Direct Virtual Office Screenshot Capture\n")

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=['--disable-gpu', '--disable-software-rasterizer']
        )

        context = await browser.new_context(viewport={'width': 1920, 'height': 1080})
        page = await context.new_page()

        try:
            # Load page
            print("📍 Loading CUI...")
            await page.goto("http://localhost:4005?project=team", wait_until='networkidle')
            await asyncio.sleep(8)

            # Just take screenshots of whatever is visible
            print("\n📸 Capturing full page...")
            await page.screenshot(path=f"{OUTPUT_DIR}/full-page.png", full_page=True)
            print(f"  ✅ Saved: full-page.png")

            # Try to find and click on tabsets to capture different areas
            print("\n🔍 Finding all visible panels...")

            # Get all visible panels
            panels = await page.query_selector_all('[class*="flexlayout__tab"]')
            print(f"  Found {len(panels)} panels")

            # Capture each visible tabset area
            tabsets = await page.query_selector_all('[class*="flexlayout__tabset_content"]')
            for i, tabset in enumerate(tabsets[:10]):  # First 10 tabsets
                try:
                    # Check if tabset is visible
                    is_visible = await tabset.is_visible()
                    if is_visible:
                        # Get bounding box
                        box = await tabset.bounding_box()
                        if box and box['width'] > 100 and box['height'] > 100:
                            # Screenshot this area
                            await tabset.screenshot(path=f"{OUTPUT_DIR}/panel-{i}.png")
                            print(f"  ✅ Captured panel-{i}.png ({int(box['width'])}x{int(box['height'])})")
                except:
                    pass

            print(f"\n✅ All screenshots saved to: {OUTPUT_DIR}/")
            return True

        finally:
            await browser.close()

if __name__ == "__main__":
    asyncio.run(capture_screenshots())
