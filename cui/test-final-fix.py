#!/usr/bin/env python3
"""
Virtual Office Test - FINAL FIX!
Tries multiple approaches to activate the correct Virtual Office panel
"""
import asyncio
import json
from pathlib import Path
from playwright.async_api import async_playwright

BASE_URL = "http://localhost:4005?project=team"
OUTPUT_DIR = "/root/orchestrator/workspaces/team/final-fix-test"

Path(OUTPUT_DIR).mkdir(parents=True, exist_ok=True)

async def test_final_fix():
    print("🎯 Virtual Office Test - Final Fix!\n")

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=['--disable-gpu', '--disable-software-rasterizer']
        )

        context = await browser.new_context(viewport={'width': 1920, 'height': 1080})
        page = await context.new_page()

        # Enable console logs to debug
        page.on('console', lambda msg: print(f"   Browser: {msg.text}"))

        try:
            # Step 1: Navigate with project parameter
            print(f"📍 Loading: {BASE_URL}")
            await page.goto(BASE_URL, wait_until='networkidle')
            await asyncio.sleep(3)

            await page.screenshot(path=f"{OUTPUT_DIR}/01-initial.png")
            print("📸 01: Initial load\n")

            # Step 2: Find Virtual Office tab
            print("🔍 Finding Virtual Office tab...")
            tabs = await page.query_selector_all("div[class*='flexlayout__tab']")
            print(f"   Found {len(tabs)} tabs total")

            virtual_office_tab = None
            for i, tab in enumerate(tabs):
                text = await tab.inner_text()
                print(f"   Tab {i}: {text}")
                if "Virtual Office" in text:
                    virtual_office_tab = tab
                    print(f"   ✅ Virtual Office found at index {i}\n")
                    break

            if not virtual_office_tab:
                print("❌ Virtual Office tab nicht gefunden!")
                return False

            # Step 3: Try JavaScript-based activation (APPROACH 1)
            print("🚀 Approach 1: JavaScript tab activation...")
            try:
                await page.evaluate("""
                    // Find Virtual Office tab and trigger click event
                    const tabs = document.querySelectorAll('[class*="flexlayout__tab"]');
                    for (const tab of tabs) {
                        if (tab.textContent.includes('Virtual Office')) {
                            // Force click via JavaScript
                            tab.click();
                            console.log('JavaScript click on Virtual Office tab');
                            break;
                        }
                    }
                """)
                await asyncio.sleep(3)  # Wait for panel to render
                await page.screenshot(path=f"{OUTPUT_DIR}/02-js-click.png")
                print("📸 02: After JavaScript click\n")
            except Exception as e:
                print(f"   ❌ JavaScript click failed: {e}\n")

            # Step 4: Check if Virtual Office elements are now visible
            print("🔍 Checking Virtual Office elements...")

            elements_to_check = [
                ("button:has-text('Dashboard')", "Dashboard button"),
                ("button:has-text('Agent Grid')", "Agent Grid button"),
                ("button:has-text('Org Chart')", "Org Chart button"),
                ("button:has-text('RACI')", "RACI button"),
                ("div:has-text('Live Activity')", "Activity Stream"),
                ("div:has-text('PENDING')", "Pending items"),
            ]

            found_elements = []
            for selector, name in elements_to_check:
                try:
                    element = await page.wait_for_selector(selector, timeout=2000)
                    if element:
                        print(f"   ✅ {name} gefunden!")
                        found_elements.append(name)
                except:
                    print(f"   ❌ {name} nicht gefunden")

            # If elements not found, try APPROACH 2: Direct component access
            if len(found_elements) < 3:
                print("\n🚀 Approach 2: Direct component navigation...")
                try:
                    # Look for office panel directly
                    office_panel = await page.query_selector('[data-component="office"]')
                    if office_panel:
                        print("   ✅ Office panel found!")
                        # Try to click Dashboard button in that panel
                        dashboard_btn = await office_panel.query_selector('button:has-text("Dashboard")')
                        if dashboard_btn:
                            await dashboard_btn.click()
                            await asyncio.sleep(2)
                            await page.screenshot(path=f"{OUTPUT_DIR}/03-dashboard-direct.png")
                            print("📸 03: After direct Dashboard click\n")
                except Exception as e:
                    print(f"   ❌ Direct navigation failed: {e}\n")

            # Step 5: Try APPROACH 3: Wait for specific Virtual Office container
            print("🚀 Approach 3: Wait for Virtual Office container...")
            try:
                # Wait for the actual Virtual Office component to mount
                await page.wait_for_function("""
                    () => {
                        const panels = document.querySelectorAll('[class*="panel"]');
                        for (const panel of panels) {
                            if (panel.textContent.includes('Live Activity') ||
                                panel.textContent.includes('Agent Grid') ||
                                panel.textContent.includes('Dashboard')) {
                                return true;
                            }
                        }
                        return false;
                    }
                """, timeout=5000)
                print("   ✅ Virtual Office container detected!\n")
                await asyncio.sleep(2)
                await page.screenshot(path=f"{OUTPUT_DIR}/04-container-found.png")
                print("📸 04: Virtual Office container found\n")
            except Exception as e:
                print(f"   ❌ Container wait failed: {e}\n")

            # Step 6: Re-check elements after all approaches
            print("🔍 Final element check...")
            final_found = []
            for selector, name in elements_to_check:
                try:
                    element = await page.wait_for_selector(selector, timeout=2000)
                    if element:
                        print(f"   ✅ {name} gefunden!")
                        final_found.append(name)
                except:
                    print(f"   ❌ {name} nicht gefunden")

            # Step 7: Take final screenshot
            await page.screenshot(path=f"{OUTPUT_DIR}/05-final-state.png")
            print("📸 05: Final state\n")

            # Step 8: Try to capture Virtual Office data
            print("📊 Checking for Virtual Office data...")
            try:
                # Check Activity Stream
                activity_count = await page.evaluate("""
                    () => {
                        const stream = document.querySelector('[class*="activity"]');
                        if (stream) {
                            const items = stream.querySelectorAll('[class*="item"]');
                            return items.length;
                        }
                        return 0;
                    }
                """)
                print(f"   Activity items: {activity_count}")

                # Check Agent Grid
                agent_count = await page.evaluate("""
                    () => {
                        const grid = document.querySelector('[class*="agent"]');
                        if (grid) {
                            const cards = grid.querySelectorAll('[class*="card"]');
                            return cards.length;
                        }
                        return 0;
                    }
                """)
                print(f"   Agent cards: {agent_count}")

                # Check Action Items
                action_count = await page.evaluate("""
                    () => {
                        const actions = document.querySelector('[class*="action"]');
                        if (actions) {
                            const items = actions.querySelectorAll('[class*="item"]');
                            return items.length;
                        }
                        return 0;
                    }
                """)
                print(f"   Action items: {action_count}")
            except Exception as e:
                print(f"   ❌ Data check failed: {e}")

            # Results
            print(f"\n{'='*60}")
            print(f"RESULTS:")
            print(f"  Elements found: {len(final_found)}/{len(elements_to_check)}")
            print(f"  Found: {', '.join(final_found) if final_found else 'None'}")
            print(f"  Screenshots: {OUTPUT_DIR}/")
            print(f"{'='*60}")

            # Generate report
            report = {
                "timestamp": "2026-02-24T15:30:00",
                "base_url": BASE_URL,
                "approaches_tried": [
                    "JavaScript click activation",
                    "Direct component navigation",
                    "Container wait with polling"
                ],
                "elements_found": len(final_found),
                "elements_total": len(elements_to_check),
                "found_list": final_found,
                "screenshots": [
                    "01-initial.png",
                    "02-js-click.png",
                    "03-dashboard-direct.png",
                    "04-container-found.png",
                    "05-final-state.png"
                ],
                "success": len(final_found) >= 3
            }

            with open(f"{OUTPUT_DIR}/REPORT.json", "w") as f:
                json.dump(report, f, indent=2)

            print(f"\n📄 Report saved: {OUTPUT_DIR}/REPORT.json")

            return report["success"]

        finally:
            await browser.close()

if __name__ == "__main__":
    success = asyncio.run(test_final_fix())
    exit(0 if success else 1)
