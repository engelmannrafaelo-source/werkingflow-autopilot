#!/usr/bin/env python3
"""
Load WITHOUT project parameter to see default layout
"""
import asyncio
from pathlib import Path
from playwright.async_api import async_playwright

OUTPUT_DIR = "/root/orchestrator/workspaces/team"

async def test_no_project():
    print("🔍 Loading WITHOUT project parameter\n")

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=['--disable-gpu', '--disable-software-rasterizer']
        )

        context = await browser.new_context(viewport={'width': 1920, 'height': 1080})
        page = await context.new_page()

        try:
            # Load WITHOUT project parameter
            print("📍 Loading: http://localhost:4005 (no project param)")
            await page.goto("http://localhost:4005", wait_until='networkidle')
            await asyncio.sleep(8)

            await page.screenshot(path=f"{OUTPUT_DIR}/no-project.png", full_page=True)
            print("📸 Screenshot: no-project.png")

            # Check tabs
            tabs = await page.evaluate("""
                () => {
                    const buttons = document.querySelectorAll('[class*="flexlayout__tab_button_content"]');
                    return Array.from(buttons).slice(0, 20).map(b => b.textContent?.trim());
                }
            """)

            print(f"\nTabs found: {tabs}")

        finally:
            await browser.close()

if __name__ == "__main__":
    asyncio.run(test_no_project())
