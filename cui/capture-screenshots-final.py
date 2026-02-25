#!/usr/bin/env python3
"""
Final screenshot capture - simplified approach
"""
import asyncio
from pathlib import Path
from playwright.async_api import async_playwright

OUTPUT_DIR = "/root/orchestrator/workspaces/team"

async def capture_screenshots():
    print("🎯 Virtual Office Screenshot Capture\n")

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=['--disable-gpu', '--disable-software-rasterizer']
        )

        context = await browser.new_context(viewport={'width': 1920, 'height': 1080})
        page = await context.new_page()

        try:
            print("📍 Loading http://localhost:4005?project=team")
            # Use domcontentloaded instead of networkidle to avoid WebSocket timeout
            await page.goto("http://localhost:4005?project=team", wait_until='domcontentloaded', timeout=15000)
            print("✅ Page loaded (DOM ready)")

            # Wait for React to render
            print("⏳ Waiting for React render...")
            await asyncio.sleep(15)

            # Take initial screenshot
            await page.screenshot(path=f"{OUTPUT_DIR}/01-initial-load.png", full_page=True)
            print("📸 01: Initial load")

            # Check what's visible
            content = await page.evaluate("""
                () => {
                    const text = document.body.textContent || '';
                    const html = document.body.innerHTML;

                    // Find all tabs
                    const tabs = Array.from(document.querySelectorAll('[class*="tab"]'))
                        .slice(0, 20)
                        .map(t => (t.textContent || '').trim().substring(0, 50))
                        .filter(t => t.length > 0 && t.length < 40);

                    return {
                        bodyLength: text.length,
                        hasActivity: text.includes('Activity') || text.includes('Live Activity'),
                        hasAgentGrid: text.includes('Agent Grid'),
                        hasDashboard: text.includes('Dashboard'),
                        hasPending: text.includes('PENDING'),
                        hasOfficePanel: html.includes('office-panel') || html.includes('OfficePanel'),
                        hasVirtualOffice: html.includes('virtual-office') || html.includes('VirtualOffice'),
                        tabs: [...new Set(tabs)], // Remove duplicates
                        sample: text.substring(0, 800)
                    };
                }
            """)

            print(f"\n{'='*60}")
            print("PAGE ANALYSIS:")
            print(f"{'='*60}")
            print(f"  Body length: {content['bodyLength']} chars")
            print(f"  Has Activity: {content['hasActivity']}")
            print(f"  Has Agent Grid: {content['hasAgentGrid']}")
            print(f"  Has Dashboard: {content['hasDashboard']}")
            print(f"  Has PENDING: {content['hasPending']}")
            print(f"  Has Office Panel: {content['hasOfficePanel']}")
            print(f"  Has Virtual Office: {content['hasVirtualOffice']}")

            print(f"\n  Tabs found: {len(content['tabs'])}")
            for i, tab in enumerate(content['tabs'][:15]):
                print(f"    {i+1}. {tab}")

            print(f"\n{'='*60}")
            print("BODY TEXT SAMPLE:")
            print(f"{'='*60}")
            print(content['sample'])
            print("...")

            # Try clicking all possible "Virtual Office" / "Office" related elements
            print(f"\n{'='*60}")
            print("TRYING TO OPEN VIRTUAL OFFICE:")
            print(f"{'='*60}\n")

            # Strategy 1: Click any tab/button with "Office" text
            clicked = await page.evaluate("""
                () => {
                    const elements = Array.from(document.querySelectorAll('*'));
                    for (const el of elements) {
                        const text = (el.textContent || '').trim();
                        if ((text === 'Virtual Office' || text === 'Office' || text.includes('Virtual Office')) &&
                            el.offsetParent !== null && // visible
                            (el.tagName === 'BUTTON' || el.tagName === 'DIV' || el.tagName === 'SPAN')) {
                            if (el.click) {
                                console.log('[CLICK] Clicked:', text.substring(0, 30), el.tagName);
                                el.click();
                                return { clicked: true, text: text.substring(0, 50), tag: el.tagName };
                            }
                        }
                    }
                    return { clicked: false };
                }
            """)

            if clicked.get('clicked'):
                print(f"✅ Clicked: {clicked['text']} ({clicked['tag']})")
                await asyncio.sleep(5)

                await page.screenshot(path=f"{OUTPUT_DIR}/02-after-click.png", full_page=True)
                print("📸 02: After click")

                # Check again
                check2 = await page.evaluate("""
                    () => {
                        const text = document.body.textContent || '';
                        return {
                            hasActivity: text.includes('Activity') || text.includes('Live Activity'),
                            hasAgentGrid: text.includes('Agent Grid'),
                            hasPending: text.includes('PENDING')
                        };
                    }
                """)

                print(f"\n  After click:")
                for key, val in check2.items():
                    print(f"    {key}: {'✅' if val else '❌'}")

                if any(check2.values()):
                    print("\n🎉 SUCCESS! Virtual Office is visible!")
                    await capture_all_views(page)
                    return True

            # If not visible yet, try to find buttons
            print("\n🔍 Looking for view buttons...")
            buttons_found = await page.evaluate("""
                () => {
                    const buttons = Array.from(document.querySelectorAll('button'));
                    return buttons.map(b => (b.textContent || '').trim()).filter(t => t.length > 0 && t.length < 30).slice(0, 30);
                }
            """)

            print(f"  Found {len(buttons_found)} buttons:")
            for btn in buttons_found[:15]:
                print(f"    - {btn}")

            # Save final screenshot
            await page.screenshot(path=f"{OUTPUT_DIR}/03-final-state.png", full_page=True)
            print(f"\n📸 03: Final state")

            print(f"\n{'='*60}")
            print(f"Screenshots saved to: {OUTPUT_DIR}/")
            print(f"{'='*60}")

            return False

        finally:
            await browser.close()

async def capture_all_views(page):
    """Capture all views if Virtual Office is visible"""
    print(f"\n{'='*60}")
    print("📸 CAPTURING ALL VIEWS:")
    print(f"{'='*60}\n")

    views = ["Dashboard", "Agent Grid", "Org Chart", "RACI", "Tasks", "Reviews"]

    for view in views:
        try:
            button = await page.query_selector(f"button:has-text('{view}')")
            if button:
                print(f"  {view}...")
                await button.click()
                await asyncio.sleep(3)

                filename = f"{OUTPUT_DIR}/view-{view.lower().replace(' ', '-')}.png"
                await page.screenshot(path=filename, full_page=True)
                print(f"    ✅ Saved")
        except Exception as e:
            print(f"  {view}: ❌ {e}")

    await page.screenshot(path=f"{OUTPUT_DIR}/virtual-office-all.png", full_page=True)
    print(f"\n✅ Complete screenshot saved")

if __name__ == "__main__":
    success = asyncio.run(capture_screenshots())
    print(f"\n{'='*60}")
    if success:
        print("✅ SUCCESS - All screenshots captured!")
    else:
        print("⚠️  Partial success - Check screenshots manually")
    print(f"{'='*60}")
    exit(0 if success else 1)
