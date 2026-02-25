#!/usr/bin/env python3
"""
Quick screenshot tester - Get screenshots of Virtual Office working state
Saves to /root/orchestrator/workspaces/team/
"""
import asyncio
from pathlib import Path
from playwright.async_api import async_playwright

BASE_URL = "http://localhost:4005"
OUTPUT_DIR = "/root/orchestrator/workspaces/team"

async def capture_screenshots():
    print("🚀 Capturing Virtual Office Screenshots\n")

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=['--disable-gpu', '--disable-software-rasterizer']
        )

        context = await browser.new_context(
            viewport={'width': 1920, 'height': 1080}
        )

        page = await context.new_page()

        try:
            # Navigate
            print("📍 Loading CUI...")
            await page.goto(BASE_URL, wait_until='networkidle')
            await asyncio.sleep(3)

            # 1. Full page overview
            print("📸 1/6 - Full Page Overview")
            await page.screenshot(path=f"{OUTPUT_DIR}/01-full-page-overview.png", full_page=False)

            # 2. Try to find and click Office panel/tab
            print("🔍 Looking for Office panel...")

            # Try clicking Dashboard button (default view shows VirtualOffice)
            selectors_to_try = [
                "button:has-text('Dashboard')",
                "button:has-text('🎛️')",
                ".office-header button:first-child",
            ]

            for selector in selectors_to_try:
                try:
                    await page.click(selector, timeout=2000)
                    print(f"✅ Clicked: {selector}")
                    await asyncio.sleep(2)
                    break
                except:
                    continue

            # 3. Virtual Office (should be visible now)
            print("📸 2/6 - Virtual Office Dashboard")
            await page.screenshot(path=f"{OUTPUT_DIR}/02-virtual-office-dashboard.png")

            # 4. Try clicking Business Approval in Action Items
            print("🔍 Looking for Business Approval...")
            try:
                # Look for action items on right side
                await page.click("text=Approve, text=approval, button:has-text('Business')", timeout=3000)
                await asyncio.sleep(2)
                print("📸 3/6 - Business Approval Panel")
                await page.screenshot(path=f"{OUTPUT_DIR}/03-business-approval.png")
            except:
                print("⚠️  Business Approval not found - taking current state")
                await page.screenshot(path=f"{OUTPUT_DIR}/03-current-state.png")

            # 5. Activity Stream (left panel)
            print("📸 4/6 - Activity Stream (if visible)")
            try:
                element = await page.query_selector("[data-panel='activity'], .activity-stream")
                if element:
                    await element.screenshot(path=f"{OUTPUT_DIR}/04-activity-stream.png")
                else:
                    print("⚠️  Activity Stream not found as separate element")
            except:
                pass

            # 6. Try Office tab (not Dashboard)
            print("🔍 Clicking Office tab...")
            try:
                await page.click("button:has-text('🏢 Office')", timeout=2000)
                await asyncio.sleep(2)
                print("📸 5/6 - Office View")
                await page.screenshot(path=f"{OUTPUT_DIR}/05-office-view.png")
            except:
                print("⚠️  Office tab not found")

            # 7. Final full screenshot
            print("📸 6/6 - Final State")
            await page.screenshot(path=f"{OUTPUT_DIR}/06-final-state.png")

            print(f"\n✅ Screenshots saved to {OUTPUT_DIR}/")
            print("\nFiles created:")
            for f in sorted(Path(OUTPUT_DIR).glob("0*.png")):
                size_kb = f.stat().st_size // 1024
                print(f"  - {f.name} ({size_kb}KB)")

        finally:
            await browser.close()

if __name__ == "__main__":
    asyncio.run(capture_screenshots())
