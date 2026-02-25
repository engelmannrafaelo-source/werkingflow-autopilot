#!/usr/bin/env python3
"""
Final Virtual Office Screenshot Capture
"""
import asyncio
from pathlib import Path
from playwright.async_api import async_playwright

OUTPUT_DIR = "/root/orchestrator/workspaces/team"
Path(OUTPUT_DIR).mkdir(parents=True, exist_ok=True)

async def capture_all():
    print("🎯 Virtual Office Screenshot Capture - FINAL\n")

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=['--disable-gpu', '--disable-software-rasterizer']
        )

        context = await browser.new_context(viewport={'width': 1920, 'height': 1080})
        page = await context.new_page()

        try:
            print("📍 Loading CUI...")
            await page.goto("http://localhost:4005?project=team", wait_until='networkidle')
            await asyncio.sleep(10)

            # Full page screenshot
            print("\n📸 Capturing full page...")
            await page.screenshot(path=f"{OUTPUT_DIR}/virtual-office-full.png", full_page=True)
            print("  ✅ virtual-office-full.png")

            # Check if Virtual Office is rendering
            content_check = await page.evaluate("""
                () => {
                    const text = document.body.textContent || '';
                    return {
                        hasActivityStream: text.includes('Live Activity') || text.includes('Activity Stream'),
                        hasAgentGrid: text.includes('Agent Grid'),
                        hasDashboard: text.includes('Dashboard'),
                        hasActionItems: text.includes('PENDING') || text.includes('Action Items'),
                        hasUnknownPanel: text.includes('Unknown panel')
                    };
                }
            """)

            print(f"\n{'='*60}")
            print("CONTENT CHECK:")
            print(f"{'='*60}")
            for key, value in content_check.items():
                icon = "✅" if value else "❌"
                print(f"  {icon} {key}: {value}")

            if content_check['hasUnknownPanel']:
                print("\n⚠️  'Unknown panel' detected - Virtual Office component issue")

            if content_check['hasAgentGrid'] or content_check['hasActivityStream']:
                print("\n✅ SUCCESS! Virtual Office is rendering!")
            else:
                print("\n❌ Virtual Office not fully rendering yet")

            # Capture individual panels
            print("\n📸 Capturing individual panels...")

            tabsets = await page.query_selector_all('[class*="flexlayout__tabset_content"]')
            captured = 0
            for i, tabset in enumerate(tabsets):
                try:
                    is_visible = await tabset.is_visible()
                    if is_visible:
                        box = await tabset.bounding_box()
                        if box and box['width'] > 200 and box['height'] > 200:
                            await tabset.screenshot(path=f"{OUTPUT_DIR}/panel-{captured}.png")
                            print(f"  ✅ panel-{captured}.png ({int(box['width'])}x{int(box['height'])})")
                            captured += 1
                            if captured >= 10:  # Max 10 panels
                                break
                except:
                    pass

            print(f"\n{'='*60}")
            print(f"✅ Capture Complete!")
            print(f"{'='*60}")
            print(f"  Total screenshots: {captured + 1}")
            print(f"  Location: {OUTPUT_DIR}/")
            print(f"{'='*60}\n")

            return content_check['hasAgentGrid'] or content_check['hasActivityStream']

        finally:
            await browser.close()

if __name__ == "__main__":
    success = asyncio.run(capture_all())
    exit(0 if success else 1)
