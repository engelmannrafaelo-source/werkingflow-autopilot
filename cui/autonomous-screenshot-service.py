#!/usr/bin/env python3
"""
Autonomous Screenshot Service - Server-Side Rendering
Works WITHOUT needing browser to be open - starts its own browser and renders tabs
"""
import asyncio
import json
from pathlib import Path
from datetime import datetime
from playwright.async_api import async_playwright

BASE_URL = "http://localhost:4005"
OUTPUT_DIR = "/root/orchestrator/workspaces/team/autonomous-screenshots"
Path(OUTPUT_DIR).mkdir(parents=True, exist_ok=True)

class AutonomousScreenshotService:
    def __init__(self):
        self.browser = None
        self.context = None
        self.page = None
        self.screenshots = []

    async def start(self):
        """Start headless browser"""
        print("🚀 Starting Autonomous Screenshot Service")
        print(f"   Target: {BASE_URL}")
        print(f"   Output: {OUTPUT_DIR}\n")

        playwright = await async_playwright().start()
        self.browser = await playwright.chromium.launch(
            headless=True,
            args=['--disable-gpu', '--disable-software-rasterizer']
        )

        self.context = await self.browser.new_context(
            viewport={'width': 1920, 'height': 1080},
            # Store state to persist across sessions if needed
            storage_state=None
        )

        self.page = await self.context.new_page()
        print("✅ Browser started\n")

    async def navigate_to_virtual_office(self):
        """Navigate to CUI and open Virtual Office tab"""
        print("📍 Navigating to CUI...")
        await self.page.goto(BASE_URL, wait_until='networkidle')
        await asyncio.sleep(3)  # Wait for React to initialize

        print("🔍 Looking for Virtual Office tab...")

        # Strategy 1: Try to find existing "Virtual Office" tab in flexlayout
        tab_selectors = [
            "div[class*='flexlayout__tab']:has-text('Virtual Office')",
            ".flexlayout__tab_button:has-text('Virtual Office')",
            "[data-tab='virtual-office']",
        ]

        found = False
        for selector in tab_selectors:
            try:
                element = await self.page.wait_for_selector(selector, timeout=2000)
                if element:
                    await element.click()
                    print(f"✅ Clicked Virtual Office tab via: {selector}")
                    await asyncio.sleep(2)
                    found = True
                    break
            except:
                continue

        # Strategy 2: If no tab found, look for "Office Lite" and click Dashboard
        if not found:
            print("⚠️  Virtual Office tab not found, trying Office Lite → Dashboard...")

            office_lite_selectors = [
                "div[class*='flexlayout__tab']:has-text('Office Lite')",
                ".flexlayout__tab_button:has-text('Office')",
            ]

            for selector in office_lite_selectors:
                try:
                    element = await self.page.wait_for_selector(selector, timeout=2000)
                    if element:
                        await element.click()
                        print(f"✅ Opened Office Lite tab")
                        await asyncio.sleep(2)

                        # Now click Dashboard button inside
                        dashboard_button = await self.page.wait_for_selector(
                            "button:has-text('Dashboard'), button:has-text('🎛️')",
                            timeout=3000
                        )
                        if dashboard_button:
                            await dashboard_button.click()
                            print("✅ Clicked Dashboard button")
                            await asyncio.sleep(2)
                            found = True
                            break
                except Exception as e:
                    print(f"   ⚠️  {selector} failed: {e}")
                    continue

        # Strategy 3: Add Virtual Office tab if it doesn't exist
        if not found:
            print("⚠️  Trying to add Virtual Office tab via + button...")
            try:
                # Look for tab add button
                add_button = await self.page.wait_for_selector(
                    ".flexlayout__tab_toolbar_button-add, button[aria-label='Add']",
                    timeout=2000
                )
                if add_button:
                    await add_button.click()
                    await asyncio.sleep(1)
                    # This might open a menu - would need to select "office" component
                    print("   ⚠️  Add button clicked, but panel selection not implemented")
            except:
                pass

        if not found:
            print("❌ Could not open Virtual Office - capturing current state anyway")

        return found

    async def capture_screenshot(self, name: str, description: str, selector: str = None):
        """Capture a screenshot of full page or specific element"""
        print(f"📸 Capturing: {name}")
        print(f"   {description}")

        timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        filename = f"{name}-{timestamp}.png"
        filepath = f"{OUTPUT_DIR}/{filename}"

        try:
            if selector:
                # Try to capture specific element
                try:
                    element = await self.page.wait_for_selector(selector, timeout=3000)
                    await element.screenshot(path=filepath)
                    print(f"   ✅ Saved: {filename} (element)\n")
                except:
                    # Fallback to full page
                    await self.page.screenshot(path=filepath, full_page=False)
                    print(f"   ✅ Saved: {filename} (fallback: full page)\n")
            else:
                # Full page screenshot
                await self.page.screenshot(path=filepath, full_page=False)
                print(f"   ✅ Saved: {filename}\n")

            size_kb = Path(filepath).stat().st_size // 1024
            self.screenshots.append({
                "name": name,
                "description": description,
                "file": filepath,
                "size_kb": size_kb,
                "timestamp": timestamp
            })

            return filepath

        except Exception as e:
            print(f"   ❌ Failed: {e}\n")
            return None

    async def capture_virtual_office_panels(self):
        """Capture all Virtual Office panels"""
        print("="*70)
        print("CAPTURING VIRTUAL OFFICE PANELS")
        print("="*70 + "\n")

        # 1. Full page overview
        await self.capture_screenshot(
            "01-full-page",
            "Complete CUI workspace with Virtual Office",
            None
        )

        # 2. Activity Stream (left panel)
        await self.capture_screenshot(
            "02-activity-stream",
            "Live Activity panel showing recent agent events",
            ".activity-stream, [data-panel*='activity']"
        )

        # 3. Agent Grid (center panel)
        await self.capture_screenshot(
            "03-agent-grid",
            "Agent Grid showing all 17 agents with status",
            ".agent-grid, [data-view='grid']"
        )

        # 4. Action Items (right panel)
        await self.capture_screenshot(
            "04-action-items",
            "Action Items panel with pending approvals",
            ".action-items, [data-panel*='action']"
        )

        # Try clicking Business Approvals
        try:
            print("🔍 Trying to click Business Approval item...")
            business_button = await self.page.wait_for_selector(
                "button:has-text('Business'), div:has-text('PENDING')",
                timeout=3000
            )
            if business_button:
                await business_button.click()
                await asyncio.sleep(2)
                print("   ✅ Clicked Business Approvals\n")

                # 5. Business Approval Panel
                await self.capture_screenshot(
                    "05-business-approval",
                    "Business Approval Panel with 4 pending reports",
                    ".business-approval-panel, [data-panel*='business']"
                )
        except Exception as e:
            print(f"   ⚠️  Could not click Business Approval: {e}\n")

        # Try clicking an agent card
        try:
            print("🔍 Trying to open Agent Detail Modal...")
            agent_card = await self.page.wait_for_selector(
                ".agent-card, [data-agent-card]",
                timeout=3000
            )
            if agent_card:
                await agent_card.click()
                await asyncio.sleep(2)
                print("   ✅ Opened Agent Detail Modal\n")

                # 6. Agent Detail Modal
                await self.capture_screenshot(
                    "06-agent-modal",
                    "Agent Detail Modal with tabs (Inbox, Worklist, Knowledge)",
                    ".modal, [role='dialog']"
                )

                # Close modal
                close_button = await self.page.query_selector("[aria-label='Close'], button:has-text('×')")
                if close_button:
                    await close_button.click()
                    await asyncio.sleep(1)
        except Exception as e:
            print(f"   ⚠️  Could not open Agent Modal: {e}\n")

        # 7. Try other views (Org Chart, RACI)
        for view_name, button_text in [("org-chart", "Org Chart"), ("raci", "RACI")]:
            try:
                print(f"🔍 Trying to switch to {view_name} view...")
                view_button = await self.page.wait_for_selector(
                    f"button:has-text('{button_text}')",
                    timeout=2000
                )
                if view_button:
                    await view_button.click()
                    await asyncio.sleep(2)
                    print(f"   ✅ Switched to {view_name}\n")

                    await self.capture_screenshot(
                        f"07-{view_name}",
                        f"{button_text} view",
                        None
                    )

                    # Switch back to grid
                    grid_button = await self.page.query_selector("button:has-text('Agent Grid')")
                    if grid_button:
                        await grid_button.click()
                        await asyncio.sleep(1)
                    break  # Only capture one alternative view
            except:
                continue

        # 8. Final state
        await self.capture_screenshot(
            "08-final-state",
            "Final state after all interactions",
            None
        )

    async def generate_report(self):
        """Generate summary report"""
        print("="*70)
        print("GENERATING REPORT")
        print("="*70 + "\n")

        report = {
            "timestamp": datetime.now().isoformat(),
            "base_url": BASE_URL,
            "output_dir": OUTPUT_DIR,
            "screenshots": self.screenshots,
            "total_screenshots": len(self.screenshots),
            "total_size_kb": sum(s["size_kb"] for s in self.screenshots)
        }

        report_file = f"{OUTPUT_DIR}/REPORT.json"
        with open(report_file, 'w') as f:
            json.dump(report, f, indent=2)

        print(f"📄 Report saved: {report_file}\n")
        print(f"📊 Summary:")
        print(f"   Screenshots: {report['total_screenshots']}")
        print(f"   Total size: {report['total_size_kb']}KB\n")

        print("📸 Screenshots:")
        for s in self.screenshots:
            print(f"   - {s['name']}.png ({s['size_kb']}KB)")
            print(f"     {s['description']}")

        return report

    async def stop(self):
        """Stop browser"""
        if self.browser:
            await self.browser.close()
            print("\n✅ Browser stopped")

    async def run(self):
        """Run complete screenshot capture workflow"""
        try:
            await self.start()
            await self.navigate_to_virtual_office()
            await self.capture_virtual_office_panels()
            await self.generate_report()
        finally:
            await self.stop()

async def main():
    service = AutonomousScreenshotService()
    await service.run()

if __name__ == "__main__":
    asyncio.run(main())
