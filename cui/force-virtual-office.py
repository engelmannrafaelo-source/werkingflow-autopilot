#!/usr/bin/env python3
"""
Force Virtual Office tab by ID and capture screenshots
"""
import asyncio
from pathlib import Path
from playwright.async_api import async_playwright

OUTPUT_DIR = "/root/orchestrator/workspaces/team"
Path(OUTPUT_DIR).mkdir(parents=True, exist_ok=True)

async def force_virtual_office():
    print("🎯 Forcing Virtual Office Tab by ID\n")

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=['--disable-gpu', '--disable-software-rasterizer']
        )

        context = await browser.new_context(viewport={'width': 1920, 'height': 1080})
        page = await context.new_page()

        try:
            print("📍 Loading page...")
            await page.goto("http://localhost:4005?project=team", wait_until='networkidle')
            await asyncio.sleep(5)

            # Force activate the Virtual Office tab by its exact ID
            print("🔧 Forcing Virtual Office tab activation...")

            result = await page.evaluate("""
                () => {
                    // The exact tab ID from Rafael's layout
                    const tabId = 'd9620459-5e42-41c9-a506-b9d00e1a04e3';

                    // Find the tab button with this ID
                    const allElements = document.querySelectorAll('*');
                    for (const el of allElements) {
                        const dataId = el.getAttribute('data-layout-id');
                        const dataPath = el.getAttribute('data-layout-path');
                        const dataNodeId = el.getAttribute('data-node-id');

                        if ((dataId && dataId.includes(tabId)) ||
                            (dataPath && dataPath.includes(tabId)) ||
                            (dataNodeId && dataNodeId.includes(tabId))) {

                            // Try to click it
                            if (el.click) {
                                el.click();
                                return { found: true, clicked: true, element: el.tagName };
                            }

                            // If it's the content div, find the tab button
                            const tabButton = document.querySelector(`[data-layout-path*="${tabId}"]`);
                            if (tabButton && tabButton.click) {
                                tabButton.click();
                                return { found: true, clicked: true, element: 'tab-button' };
                            }
                        }
                    }

                    // Alternative: Look for any element with "Virtual Office" text and click it
                    const tabs = document.querySelectorAll('[class*="flexlayout__tab_button"]');
                    for (const tab of tabs) {
                        if (tab.textContent.includes('Virtual Office')) {
                            tab.click();
                            return { found: true, clicked: true, element: 'text-search' };
                        }
                    }

                    return { found: false };
                }
            """)

            print(f"Result: {result}")

            if result.get('clicked'):
                print("✅ Tab clicked! Waiting for render...")
                await asyncio.sleep(5)

                # Take screenshot
                await page.screenshot(path=f"{OUTPUT_DIR}/virtual-office-forced.png", full_page=True)
                print("📸 Screenshot saved")

                # Check if Virtual Office is now visible
                content = await page.evaluate("""
                    () => {
                        const text = document.body.textContent || '';
                        return {
                            hasActivity: text.includes('Activity') || text.includes('Live Activity'),
                            hasAgentGrid: text.includes('Agent Grid'),
                            hasDashboard: text.includes('Dashboard'),
                            hasPending: text.includes('PENDING'),
                            hasUnknown: text.includes('Unknown panel')
                        };
                    }
                """)

                print(f"\n{'='*60}")
                print("CONTENT CHECK:")
                print(f"{'='*60}")
                for key, val in content.items():
                    print(f"  {key}: {'✅' if val else '❌'}")

                if content['hasActivity'] or content['hasAgentGrid'] or content['hasPending']:
                    print("\n🎉 SUCCESS! Virtual Office IS RENDERING!")

                    # Capture all views
                    await capture_all_views(page)
                    return True
                else:
                    print("\n❌ Still not rendering Virtual Office content")
            else:
                print("❌ Could not find/click Virtual Office tab")

            return False

        finally:
            await browser.close()

async def capture_all_views(page):
    """Capture all Virtual Office views"""
    print(f"\n{'='*60}")
    print("📸 Capturing All Views...")
    print(f"{'='*60}")

    views = [
        ("Dashboard", "button:has-text('Dashboard')"),
        ("Office", "button:has-text('Office')"),
        ("Agent Grid", "button:has-text('Agent Grid')"),
        ("Org Chart", "button:has-text('Org Chart')"),
        ("RACI", "button:has-text('RACI')"),
    ]

    for i, (name, selector) in enumerate(views, 1):
        try:
            print(f"\n{i}. {name}...")

            # Try to click the view button
            button = await page.query_selector(selector)
            if button:
                await button.click()
                await asyncio.sleep(3)

                filename = f"{OUTPUT_DIR}/virtual-office-{name.lower().replace(' ', '-')}.png"
                await page.screenshot(path=filename, full_page=True)
                print(f"   ✅ Saved: {filename}")
            else:
                print(f"   ⚠️  Button not found, skipping")

        except Exception as e:
            print(f"   ❌ Error: {e}")

    # Also capture full page
    await page.screenshot(path=f"{OUTPUT_DIR}/virtual-office-complete.png", full_page=True)
    print(f"\n✅ Complete screenshot: {OUTPUT_DIR}/virtual-office-complete.png")

if __name__ == "__main__":
    success = asyncio.run(force_virtual_office())
    exit(0 if success else 1)
