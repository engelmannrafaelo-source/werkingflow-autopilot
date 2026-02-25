#!/usr/bin/env python3
"""
Virtual Office Test mit Project Parameter - DIE LÖSUNG!
Nutzt ?project=team um Rafael's Layout zu laden
"""
import asyncio
from pathlib import Path
from playwright.async_api import async_playwright

BASE_URL = "http://localhost:4005?project=team"  # ← DIE LÖSUNG!
OUTPUT_DIR = "/root/orchestrator/workspaces/team/solution-test"

Path(OUTPUT_DIR).mkdir(parents=True, exist_ok=True)

async def test_solution():
    print("🎯 Testing Clean Solution: ?project=team parameter\n")

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=['--disable-gpu', '--disable-software-rasterizer']
        )

        context = await browser.new_context(viewport={'width': 1920, 'height': 1080})
        page = await context.new_page()

        try:
            # Navigate mit project parameter
            print(f"📍 Loading: {BASE_URL}")
            await page.goto(BASE_URL, wait_until='networkidle')
            await asyncio.sleep(3)

            # Screenshot 1: Initial load
            await page.screenshot(path=f"{OUTPUT_DIR}/01-initial-with-project-param.png")
            print("📸 01: Initial load")

            # Check welche Tabs sichtbar sind
            tabs = await page.query_selector_all("div[class*='flexlayout__tab']")
            print(f"✅ Found {len(tabs)} tabs")

            # Versuche Virtual Office Tab zu finden
            virtual_office_found = False
            for i, tab in enumerate(tabs):
                text = await tab.inner_text()
                print(f"   Tab {i}: {text}")
                if "Virtual Office" in text:
                    virtual_office_found = True
                    print(f"   ✅ Virtual Office gefunden!")

                    # Versuche zu klicken
                    try:
                        await tab.click(timeout=3000)
                        print(f"   ✅ Click erfolgreich!")
                        await asyncio.sleep(2)
                        await page.screenshot(path=f"{OUTPUT_DIR}/02-virtual-office-clicked.png")
                        print("📸 02: Virtual Office clicked")
                        break
                    except Exception as e:
                        print(f"   ❌ Click failed: {e}")

            if not virtual_office_found:
                print("❌ Virtual Office tab nicht gefunden!")

            # Prüfe ob Virtual Office Elemente sichtbar sind
            print("\n🔍 Checking Virtual Office elements...")

            elements_to_check = [
                ("button:has-text('Dashboard')", "Dashboard button"),
                ("button:has-text('Agent Grid')", "Agent Grid button"),
                ("div:has-text('PENDING')", "Pending items"),
                ("div:has-text('Live Activity')", "Activity Stream"),
            ]

            found_count = 0
            for selector, name in elements_to_check:
                try:
                    element = await page.wait_for_selector(selector, timeout=2000)
                    if element:
                        print(f"   ✅ {name} gefunden!")
                        found_count += 1
                except:
                    print(f"   ❌ {name} nicht gefunden")

            # Final screenshot
            await page.screenshot(path=f"{OUTPUT_DIR}/03-final-state.png")
            print("📸 03: Final state")

            print(f"\n{'='*60}")
            print(f"RESULT: {found_count}/{len(elements_to_check)} elements found")
            print(f"Screenshots: {OUTPUT_DIR}/")
            print(f"{'='*60}")

            return found_count > 0

        finally:
            await browser.close()

if __name__ == "__main__":
    success = asyncio.run(test_solution())
    exit(0 if success else 1)
