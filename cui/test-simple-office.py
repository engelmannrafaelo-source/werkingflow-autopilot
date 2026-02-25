#!/usr/bin/env python3
"""
Test ultra-simple office layout
"""
import asyncio
from pathlib import Path
from playwright.async_api import async_playwright

OUTPUT_DIR = "/root/orchestrator/workspaces/team"

async def test_simple():
    print("🎯 Testing Ultra-Simple Office Layout\n")

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=['--disable-gpu', '--disable-software-rasterizer']
        )

        context = await browser.new_context(viewport={'width': 1920, 'height': 1080})
        page = await context.new_page()

        logs = []
        page.on('console', lambda msg: logs.append(f"[{msg.type}] {msg.text}"))

        try:
            print("📍 Loading with ultra-simple layout (only Office tab)...")
            await page.goto("http://localhost:4005?project=team", wait_until='networkidle')
            await asyncio.sleep(10)

            await page.screenshot(path=f"{OUTPUT_DIR}/simple-office-test.png", full_page=True)
            print("📸 Screenshot saved")

            # Check everything
            result = await page.evaluate("""
                () => {
                    const bodyText = document.body.textContent || '';
                    const bodyHTML = document.body.innerHTML;

                    return {
                        bodyText: bodyText.substring(0, 2000),
                        hasOfficeTab: bodyText.includes('Office'),
                        hasVirtualOffice: bodyText.includes('Virtual Office'),
                        hasActivity: bodyText.includes('Activity') || bodyText.includes('Live Activity'),
                        hasAgentGrid: bodyText.includes('Agent Grid'),
                        hasDashboard: bodyText.includes('Dashboard'),
                        hasPending: bodyText.includes('PENDING'),
                        hasUnknown: bodyText.includes('Unknown panel'),

                        // Check for Virtual Office specific elements
                        hasActivityStream: bodyHTML.includes('activity-stream') || bodyHTML.includes('ActivityStream'),
                        hasVirtualOfficeClass: bodyHTML.includes('virtual-office') || bodyHTML.includes('VirtualOffice'),

                        // Check tabs
                        tabs: Array.from(document.querySelectorAll('[class*="tab"]')).slice(0, 10).map(t => ({
                            tag: t.tagName,
                            text: (t.textContent || '').substring(0, 50),
                            classes: (t.className || '').substring(0, 100)
                        }))
                    };
                }
            """)

            print(f"\n{'='*60}")
            print("FULL CHECK:")
            print(f"{'='*60}")
            print(f"  Office tab: {result['hasOfficeTab']}")
            print(f"  Virtual Office: {result['hasVirtualOffice']}")
            print(f"  Activity Stream: {result['hasActivity']}")
            print(f"  Agent Grid: {result['hasAgentGrid']}")
            print(f"  Dashboard: {result['hasDashboard']}")
            print(f"  PENDING: {result['hasPending']}")
            print(f"  Unknown panel: {result['hasUnknown']}")
            print(f"  Activity in HTML: {result['hasActivityStream']}")
            print(f"  Virtual Office in HTML: {result['hasVirtualOfficeClass']}")

            print(f"\nTabs found: {len(result['tabs'])}")
            for i, tab in enumerate(result['tabs'][:5]):
                print(f"  {i}: {tab['text'][:30]}")

            print(f"\n{'='*60}")
            print("BODY TEXT SAMPLE:")
            print(f"{'='*60}")
            print(result['bodyText'][:500])

            print(f"\n{'='*60}")
            print("CONSOLE LOGS:")
            print(f"{'='*60}")
            for log in logs[:10]:
                print(log)

            # Check if it worked
            if result['hasActivity'] or result['hasAgentGrid'] or result['hasPending'] or result['hasActivityStream']:
                print("\n🎉 SUCCESS! Virtual Office components ARE RENDERING!")
                return True
            else:
                print("\n❌ Still not rendering")
                return False

        finally:
            await browser.close()

if __name__ == "__main__":
    success = asyncio.run(test_simple())
    exit(0 if success else 1)
