#!/usr/bin/env python3
"""
Test if minimal layout with only Virtual Office works
"""
import asyncio
from pathlib import Path
from playwright.async_api import async_playwright

OUTPUT_DIR = "/root/orchestrator/workspaces/team"

async def test_minimal():
    print("🔍 Testing minimal layout with only Virtual Office\n")

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=['--disable-gpu', '--disable-software-rasterizer']
        )

        context = await browser.new_context(viewport={'width': 1920, 'height': 1080})
        page = await context.new_page()

        logs = []
        errors = []
        page.on('console', lambda msg: logs.append(f"[{msg.type}] {msg.text}"))
        page.on('pageerror', lambda err: errors.append(str(err)))

        try:
            print("📍 Loading with minimal layout...")
            await page.goto("http://localhost:4005?project=team", wait_until='networkidle')
            await asyncio.sleep(8)

            await page.screenshot(path=f"{OUTPUT_DIR}/minimal-layout.png", full_page=True)
            print("📸 Screenshot saved")

            # Check what's visible
            result = await page.evaluate("""
                () => {
                    const text = document.body.textContent || '';
                    return {
                        hasVirtualOfficeTab: text.includes('Virtual Office'),
                        hasActivityStream: text.includes('Activity') || text.includes('Live Activity'),
                        hasAgentGrid: text.includes('Agent Grid'),
                        hasDashboard: text.includes('Dashboard'),
                        hasUnknownPanel: text.includes('Unknown panel'),
                        bodyText: text.substring(0, 1000)
                    };
                }
            """)

            print(f"\n{'='*60}")
            print("CONTENT CHECK:")
            print(f"{'='*60}")
            print(f"  Virtual Office tab: {result['hasVirtualOfficeTab']}")
            print(f"  Activity Stream: {result['hasActivityStream']}")
            print(f"  Agent Grid: {result['hasAgentGrid']}")
            print(f"  Dashboard: {result['hasDashboard']}")
            print(f"  Unknown Panel: {result['hasUnknownPanel']}")

            if errors:
                print(f"\n{'='*60}")
                print("JAVASCRIPT ERRORS:")
                print(f"{'='*60}")
                for err in errors:
                    print(f"  {err}")

            if result['hasAgentGrid'] or result['hasActivityStream']:
                print("\n✅ SUCCESS! Virtual Office is rendering!")
                return True
            elif result['hasUnknownPanel']:
                print(f"\n❌ Unknown panel error")
                print(f"Body text sample:\n{result['bodyText'][:300]}")
            else:
                print(f"\n❌ Virtual Office not rendering")
                print(f"Body text sample:\n{result['bodyText'][:300]}")

            return False

        finally:
            await browser.close()

if __name__ == "__main__":
    success = asyncio.run(test_minimal())
    exit(0 if success else 1)
