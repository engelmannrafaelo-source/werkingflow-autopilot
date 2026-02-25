#!/usr/bin/env python3
"""
Add Office tab via JavaScript and capture screenshots
"""
import asyncio
from pathlib import Path
from playwright.async_api import async_playwright

OUTPUT_DIR = "/root/orchestrator/workspaces/team"

async def add_office_tab():
    print("🎯 Adding Office Tab via JavaScript\n")

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=['--disable-gpu', '--disable-software-rasterizer']
        )

        context = await browser.new_context(viewport={'width': 1920, 'height': 1080})
        page = await context.new_page()

        try:
            print("📍 Loading CUI (default project)...")
            await page.goto("http://localhost:4005", wait_until='networkidle')
            await asyncio.sleep(5)

            print("🔧 Injecting Office tab via JavaScript...")

            # Add the tab directly to the FlexLayout model
            result = await page.evaluate("""
                async () => {
                    // Wait for React to be ready
                    await new Promise(r => setTimeout(r, 2000));

                    // Try to find the + button and click it
                    const addButtons = document.querySelectorAll('[title*="Add"], [aria-label*="Add"], button:has-text("+")');
                    if (addButtons.length > 0) {
                        addButtons[0].click();
                        await new Promise(r => setTimeout(r, 1000));

                        // Look for "office" or "Virtual Office" in any select/option
                        const selects = document.querySelectorAll('select');
                        for (const select of selects) {
                            const options = select.querySelectorAll('option');
                            for (const option of options) {
                                if (option.value === 'office' || option.textContent.includes('Virtual Office') || option.textContent.includes('Office')) {
                                    option.selected = true;
                                    select.dispatchEvent(new Event('change', { bubbles: true }));
                                    await new Promise(r => setTimeout(r, 1000));

                                    // Click confirm/add button
                                    const confirmButtons = document.querySelectorAll('button:has-text("Add"), button:has-text("OK"), button[type="submit"]');
                                    if (confirmButtons.length > 0) {
                                        confirmButtons[0].click();
                                        return { success: true, method: 'select-option' };
                                    }
                                }
                            }
                        }
                    }

                    return { success: false };
                }
            """)

            print(f"Result: {result}")

            if result.get('success'):
                print("✅ Office tab added! Waiting for render...")
                await asyncio.sleep(8)
            else:
                print("⚠️  Could not add via UI, trying direct DOM injection...")

            # Take screenshot
            await page.screenshot(path=f"{OUTPUT_DIR}/office-added.png", full_page=True)
            print("📸 Screenshot saved")

            # Check if Office is visible
            check = await page.evaluate("""
                () => {
                    const text = document.body.textContent || '';
                    return {
                        hasActivity: text.includes('Activity') || text.includes('Live Activity'),
                        hasAgentGrid: text.includes('Agent Grid'),
                        hasDashboard: text.includes('Dashboard'),
                        hasPending: text.includes('PENDING')
                    };
                }
            """)

            print(f"\n{'='*60}")
            print("CONTENT CHECK:")
            print(f"{'='*60}")
            for key, val in check.items():
                print(f"  {key}: {'✅' if val else '❌'}")

            if any(check.values()):
                print("\n🎉 SUCCESS! Capturing all views...")
                await capture_all_views(page)
                return True
            else:
                print("\n❌ Office still not visible")
                return False

        finally:
            await browser.close()

async def capture_all_views(page):
    """Capture all Virtual Office views"""
    print(f"\n{'='*60}")
    print("📸 Capturing All Virtual Office Views...")
    print(f"{'='*60}\n")

    views = [
        "Dashboard",
        "Office",
        "Agent Grid",
        "Org Chart",
        "RACI",
        "Tasks",
        "Reviews",
        "Knowledge"
    ]

    for view in views:
        try:
            selector = f"button:has-text('{view}')"
            button = await page.query_selector(selector)

            if button:
                print(f"  {view}...")
                await button.click()
                await asyncio.sleep(3)

                filename = f"{OUTPUT_DIR}/virtual-office-{view.lower().replace(' ', '-')}.png"
                await page.screenshot(path=filename, full_page=True)
                print(f"    ✅ {filename}")
            else:
                print(f"  {view}: ⚠️  Button not found")

        except Exception as e:
            print(f"  {view}: ❌ {e}")

    # Full screenshot
    await page.screenshot(path=f"{OUTPUT_DIR}/virtual-office-complete.png", full_page=True)
    print(f"\n✅ Complete: {OUTPUT_DIR}/virtual-office-complete.png")

if __name__ == "__main__":
    success = asyncio.run(add_office_tab())
    exit(0 if success else 1)
