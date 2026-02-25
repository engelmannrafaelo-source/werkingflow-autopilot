#!/usr/bin/env python3
"""
Click directly on the Virtual Office tab in the correct tabset
"""
import asyncio
from pathlib import Path
from playwright.async_api import async_playwright

OUTPUT_DIR = "/root/orchestrator/workspaces/team"

async def test_direct_tab():
    print("🔍 Testing direct tab click in layout\n")

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

            await page.screenshot(path=f"{OUTPUT_DIR}/before-click.png", full_page=True)
            print("📸 Before click")

            # According to the layout, Virtual Office should be at index 2 (after File Preview and Notes)
            # in the first tabset. Let's find that tabset at the bottom where File Preview and Notes are visible.

            # Get all tabsets
            tabsets = await page.query_selector_all('[class*="flexlayout__tabset_tabbar"]')
            print(f"Found {len(tabsets)} tabsets")

            for i, tabset in enumerate(tabsets):
                # Get tab buttons in this tabset
                tabs_in_set = await tabset.query_selector_all('[class*="flexlayout__tab_button_content"]')
                tab_names = []
                for tab in tabs_in_set:
                    text = await tab.inner_text()
                    tab_names.append(text.strip())

                print(f"\nTabset {i}: {', '.join(tab_names)}")

                # Check if this is the tabset with File Preview and Notes
                if 'File Preview' in tab_names or 'Notes' in tab_names:
                    print(f"  ✅ This is the target tabset (has File Preview/Notes)")

                    # Now look for Virtual Office tab
                    # It should be the 3rd tab (index 2)
                    if len(tabs_in_set) >= 3:
                        # Click the third tab
                        try:
                            third_tab = tabs_in_set[2]
                            third_tab_text = await third_tab.inner_text()
                            print(f"  Clicking tab at index 2: '{third_tab_text}'")

                            # Click the parent button element (not just the content)
                            parent_button = await third_tab.evaluate_handle("el => el.closest('[class*=\"flexlayout__tab_button\"]')")
                            if parent_button:
                                await parent_button.as_element().click()
                                await asyncio.sleep(3)

                                await page.screenshot(path=f"{OUTPUT_DIR}/after-tab-click.png", full_page=True)
                                print(f"📸 After clicking tab")

                                # Check content
                                content = await page.evaluate("""
                                    () => {
                                        const text = document.body.textContent || '';
                                        return {
                                            hasActivityStream: text.includes('Activity Stream') || text.includes('Live Activity'),
                                            hasAgentGrid: text.includes('Agent Grid'),
                                            hasDashboard: text.includes('Dashboard'),
                                            hasUnknownPanel: text.includes('Unknown panel'),
                                            fullText: text.substring(0, 500)
                                        };
                                    }
                                """)

                                print(f"\n{'='*60}")
                                print(f"CONTENT CHECK:")
                                print(f"{'='*60}")
                                print(f"  Activity Stream: {content['hasActivityStream']}")
                                print(f"  Agent Grid: {content['hasAgentGrid']}")
                                print(f"  Dashboard: {content['hasDashboard']}")
                                print(f"  Unknown Panel: {content['hasUnknownPanel']}")

                                if content['hasActivityStream'] or content['hasAgentGrid']:
                                    print("\n✅ Virtual Office IS RENDERING!")
                                    return True
                                else:
                                    print(f"\n❌ Not rendering. Sample text:\n{content['fullText'][:200]}")

                        except Exception as e:
                            print(f"  ❌ Click failed: {e}")

            print("\n❌ Virtual Office not found or not rendering")
            return False

        finally:
            await browser.close()

if __name__ == "__main__":
    success = asyncio.run(test_direct_tab())
    exit(0 if success else 1)
