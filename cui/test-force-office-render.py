#!/usr/bin/env python3
"""
Force render Virtual Office by directly calling the factory
"""
import asyncio
from pathlib import Path
from playwright.async_api import async_playwright

OUTPUT_DIR = "/root/orchestrator/workspaces/team"

async def force_render():
    print("🔍 Forcing Virtual Office to render\n")

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=['--disable-gpu', '--disable-software-rasterizer']
        )

        context = await browser.new_context(viewport={'width': 1920, 'height': 1080})
        page = await context.new_page()

        try:
            await page.goto("http://localhost:4005?project=team", wait_until='networkidle')
            await asyncio.sleep(5)

            # Try to use FlexLayout API to select the Virtual Office tab by ID
            result = await page.evaluate("""
                () => {
                    // Find the Virtual Office tab ID from the layout
                    const virtualOfficeId = '#d9620459-5e42-41c9-a506-b9d00e1a04e3';

                    // Try to find and activate this tab
                    // FlexLayout stores model in a global or React context
                    // We need to trigger an action to select this tab

                    // Look for the tab element with this ID
                    const allDivs = document.querySelectorAll('[data-node-id]');
                    for (const div of allDivs) {
                        const id = div.getAttribute('data-node-id');
                        if (id && id.includes('d9620459')) {
                            return { found: true, id, visible: div.offsetParent !== null };
                        }
                    }

                    return { found: false };
                }
            """)

            print(f"Virtual Office tab search: {result}")

            if result.get('found'):
                print("✅ Found Virtual Office tab element!")
                if result.get('visible'):
                    print("✅ And it's visible!")

                    # Take screenshot
                    await page.screenshot(path=f"{OUTPUT_DIR}/virtual-office-found.png", full_page=True)
                    print("📸 Screenshot saved")

                    # Check content
                    has_components = await page.evaluate("""
                        () => {
                            const text = document.body.textContent || '';
                            return {
                                activityStream: text.includes('Activity') || text.includes('Live Activity'),
                                agentGrid: text.includes('Agent Grid') || text.includes('PENDING'),
                                dashboard: text.includes('Dashboard')
                            };
                        }
                    """)

                    print(f"\nComponents check:")
                    for name, present in has_components.items():
                        print(f"  {name}: {'✅' if present else '❌'}")

                    return any(has_components.values())
                else:
                    print("❌ Tab exists but not visible")
            else:
                print("❌ Virtual Office tab element not found in DOM")

                # Alternative: Try to force-add the tab via the + menu
                print("\n🔧 Trying alternative: Add via menu...")

                # Look for LayoutBuilder or add panel functionality
                add_result = await page.evaluate("""
                    async () => {
                        // Try to open add panel dialog
                        const plusButtons = Array.from(document.querySelectorAll('text="+"'));
                        if (plusButtons.length > 0) {
                            plusButtons[0].click();
                            await new Promise(r => setTimeout(r, 1000));

                            // Look for office option
                            const options = document.querySelectorAll('option');
                            for (const opt of options) {
                                if (opt.textContent.includes('Virtual Office')) {
                                    opt.selected = true;
                                    opt.parentElement?.dispatchEvent(new Event('change'));
                                    return { clicked: true };
                                }
                            }
                        }
                        return { clicked: false };
                    }
                """)

                print(f"Add via menu: {add_result}")

            return False

        finally:
            await browser.close()

if __name__ == "__main__":
    success = asyncio.run(force_render())
    exit(0 if success else 1)
