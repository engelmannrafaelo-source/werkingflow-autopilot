#!/usr/bin/env python3
"""
Extended wait test - check if Virtual Office renders after longer wait
"""
import asyncio
from pathlib import Path
from playwright.async_api import async_playwright

OUTPUT_DIR = "/root/orchestrator/workspaces/team"
Path(OUTPUT_DIR).mkdir(parents=True, exist_ok=True)

async def test_extended_wait():
    print("🔍 Testing with extended wait times\n")

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=['--disable-gpu', '--disable-software-rasterizer']
        )

        context = await browser.new_context(viewport={'width': 1920, 'height': 1080})
        page = await context.new_page()

        # Capture console logs
        logs = []
        page.on('console', lambda msg: logs.append(f"[{msg.type}] {msg.text}"))

        try:
            print("📍 Loading: http://localhost:4005?project=team")
            await page.goto("http://localhost:4005?project=team", wait_until='networkidle')

            print("⏳ Waiting 10 seconds for full render...")
            await asyncio.sleep(10)

            # Take screenshot
            await page.screenshot(path=f"{OUTPUT_DIR}/extended-wait-10s.png", full_page=True)
            print("📸 Screenshot after 10s wait")

            # Check for office elements
            office_found = await page.evaluate("""
                () => {
                    const all = document.querySelectorAll('*');
                    const officeRelated = [];
                    for (const el of all) {
                        const className = typeof el.className === 'string' ? el.className : '';
                        const text = (el.textContent || '').substring(0, 50);
                        if (className.includes('office') ||
                            className.includes('virtual') ||
                            text.includes('Virtual Office') ||
                            text.includes('Activity') ||
                            text.includes('Agent Grid')) {
                            officeRelated.push({
                                tag: el.tagName,
                                class: className.substring(0, 100),
                                text: text
                            });
                        }
                    }
                    return officeRelated;
                }
            """)

            print(f"\n{'='*60}")
            print(f"OFFICE-RELATED ELEMENTS FOUND: {len(office_found)}")
            print(f"{'='*60}")

            if office_found:
                for elem in office_found[:10]:  # Show first 10
                    print(f"- {elem['tag']}: {elem['class']}")
                    if elem['text']:
                        print(f"  Text: {elem['text']}")
            else:
                print("❌ NO office-related elements found")

            # Check what tabs are actually visible
            tabs_info = await page.evaluate("""
                () => {
                    const tabs = document.querySelectorAll('[class*="flexlayout__tab_button"]');
                    return Array.from(tabs).slice(0, 20).map(tab => ({
                        text: tab.textContent?.trim().substring(0, 30),
                        selected: tab.className.includes('selected')
                    }));
                }
            """)

            print(f"\n{'='*60}")
            print(f"VISIBLE TABS:")
            print(f"{'='*60}")
            for tab in tabs_info:
                marker = "✓" if tab['selected'] else " "
                print(f"[{marker}] {tab['text']}")

            # Show relevant console logs
            print(f"\n{'='*60}")
            print(f"CONSOLE LOGS:")
            print(f"{'='*60}")
            for log in logs[:20]:
                print(log)

            print(f"\n📄 Screenshot saved: {OUTPUT_DIR}/extended-wait-10s.png")

        finally:
            await browser.close()

if __name__ == "__main__":
    asyncio.run(test_extended_wait())
