#!/usr/bin/env python3
"""
Virtual Office Autonomous Tester - FINAL VERSION
Tests gegen den richtigen "Virtual Office" Tab mit allen Features
"""
import asyncio
import json
from pathlib import Path
from datetime import datetime
from playwright.async_api import async_playwright

BASE_URL = "http://localhost:4005"
OUTPUT_DIR = "/root/orchestrator/workspaces/team/screenshots"
REPORT_FILE = "/root/orchestrator/workspaces/team/VIRTUAL_OFFICE_TEST_RESULTS.json"

Path(OUTPUT_DIR).mkdir(parents=True, exist_ok=True)

class VirtualOfficeTest:
    def __init__(self):
        self.results = []
        self.screenshots = []
        self.start_time = datetime.now()

    def log(self, message, level="INFO"):
        timestamp = datetime.now().strftime("%H:%M:%S")
        prefix = {
            "INFO": "ℹ️",
            "SUCCESS": "✅",
            "ERROR": "❌",
            "WARNING": "⚠️",
            "SCREENSHOT": "📸"
        }.get(level, "•")
        print(f"[{timestamp}] {prefix} {message}")

    async def wait_and_screenshot(self, page, name, description):
        """Wait for stability and take screenshot"""
        await asyncio.sleep(1.5)
        path = f"{OUTPUT_DIR}/{name}.png"
        await page.screenshot(path=path, full_page=False)
        self.screenshots.append({"name": name, "path": path, "description": description})
        self.log(f"Screenshot: {name} - {description}", "SCREENSHOT")
        return path

    async def verify_element(self, page, selector, name, timeout=3000):
        """Verify element exists"""
        try:
            await page.wait_for_selector(selector, timeout=timeout)
            self.log(f"Found: {name}", "SUCCESS")
            self.results.append({"test": name, "status": "PASS", "selector": selector})
            return True
        except:
            self.log(f"Not found: {name}", "ERROR")
            self.results.append({"test": name, "status": "FAIL", "selector": selector})
            return False

    async def count_elements(self, page, selector, name):
        """Count matching elements"""
        try:
            count = await page.locator(selector).count()
            self.log(f"Count {name}: {count}", "INFO")
            self.results.append({"test": name, "status": "PASS", "count": count})
            return count
        except:
            self.log(f"Failed to count: {name}", "ERROR")
            self.results.append({"test": name, "status": "FAIL", "count": 0})
            return 0

    async def run_tests(self):
        """Run all tests"""
        self.log("🚀 Starting Virtual Office Autonomous Tests")
        self.log(f"Target: {BASE_URL}")
        self.log(f"Output: {OUTPUT_DIR}")

        async with async_playwright() as p:
            browser = await p.chromium.launch(
                headless=True,
                args=['--disable-gpu', '--disable-software-rasterizer']
            )

            context = await browser.new_context(
                viewport={'width': 1920, 'height': 1080}
            )

            page = await context.new_page()

            try:
                # ==========================================
                # TEST 1: Navigation & Tab Finding
                # ==========================================
                self.log("\n" + "="*60)
                self.log("TEST 1: Navigation & Virtual Office Tab")
                self.log("="*60)

                await page.goto(BASE_URL, wait_until='networkidle')
                await self.wait_and_screenshot(page, "01-initial-load", "Initial CUI load")

                # Find Virtual Office tab
                virtual_office_selectors = [
                    "button:has-text('Virtual Office')",
                    "[role='tab']:has-text('Virtual Office')",
                    ".flexlayout__tab:has-text('Virtual Office')"
                ]

                tab_found = False
                for selector in virtual_office_selectors:
                    try:
                        await page.click(selector, timeout=2000)
                        self.log("Clicked Virtual Office tab", "SUCCESS")
                        tab_found = True
                        break
                    except:
                        continue

                if not tab_found:
                    self.log("Virtual Office tab not found - trying alternatives", "WARNING")

                await asyncio.sleep(3)  # Wait for content to render
                await self.wait_and_screenshot(page, "02-virtual-office-loaded", "Virtual Office tab active")

                # ==========================================
                # TEST 2: Dashboard View & Buttons
                # ==========================================
                self.log("\n" + "="*60)
                self.log("TEST 2: Dashboard View & Navigation Buttons")
                self.log("="*60)

                # Verify Dashboard button is selected
                await self.verify_element(page, "button:has-text('Dashboard')", "Dashboard Button")
                await self.verify_element(page, "button:has-text('Office')", "Office Button")
                await self.verify_element(page, "button:has-text('Tasks')", "Tasks Button")
                await self.verify_element(page, "button:has-text('Reviews')", "Reviews Button")
                await self.verify_element(page, "button:has-text('Knowledge')", "Knowledge Button")
                await self.verify_element(page, "button:has-text('Agents')", "Agents Button")

                # ==========================================
                # TEST 3: Three-Panel Layout
                # ==========================================
                self.log("\n" + "="*60)
                self.log("TEST 3: Three-Panel Layout Verification")
                self.log("="*60)

                # Left Panel - Live Activity
                await self.verify_element(page, "text=Live Activity", "Live Activity Panel Header")

                # Center Panel - Agent Grid
                await self.verify_element(page, "button:has-text('Agent Grid')", "Agent Grid Button")

                # Right Panel - Action Items
                await self.verify_element(page, "text=Action Items", "Action Items Panel")

                await self.wait_and_screenshot(page, "03-three-panel-layout", "Complete three-panel layout")

                # ==========================================
                # TEST 4: Agent Grid
                # ==========================================
                self.log("\n" + "="*60)
                self.log("TEST 4: Agent Grid & Agent Cards")
                self.log("="*60)

                # Click Agent Grid if not already selected
                try:
                    await page.click("button:has-text('Agent Grid')", timeout=2000)
                    await asyncio.sleep(1)
                except:
                    pass

                # Count agent cards
                agent_count = await self.count_elements(page, ".agent-card, [data-agent-card]", "Agent Cards")

                # Verify search functionality
                await self.verify_element(page, "input[placeholder*='Search'], input[placeholder*='agents']", "Agent Search Input")

                await self.wait_and_screenshot(page, "04-agent-grid", f"Agent Grid with {agent_count} agents")

                # ==========================================
                # TEST 5: Business Approvals
                # ==========================================
                self.log("\n" + "="*60)
                self.log("TEST 5: Business Approvals (Action Items)")
                self.log("="*60)

                # Look for PENDING indicator
                pending_found = await self.verify_element(page, "text=PENDING", "PENDING Indicator")

                if pending_found:
                    # Count pending items
                    pending_count = await self.count_elements(page, "text=/PENDING.*\\([0-9]+\\)/", "Pending Items Count")

                    # Try to click first approval item
                    try:
                        approval_selectors = [
                            "button:has-text('Approve')",
                            "text=2026-02-22",
                            "text=office-status",
                            "text=Security Audit"
                        ]

                        for selector in approval_selectors:
                            try:
                                elements = await page.locator(selector).all()
                                if elements:
                                    await elements[0].click(timeout=2000)
                                    self.log("Clicked approval item", "SUCCESS")
                                    await asyncio.sleep(2)
                                    break
                            except:
                                continue

                        await self.wait_and_screenshot(page, "05-business-approval-opened", "Business Approval item opened")

                    except Exception as e:
                        self.log(f"Could not open approval: {e}", "WARNING")

                # ==========================================
                # TEST 6: Activity Stream
                # ==========================================
                self.log("\n" + "="*60)
                self.log("TEST 6: Activity Stream Events")
                self.log("="*60)

                # Count activity events
                activity_count = await self.count_elements(page, ".activity-event, [data-activity]", "Activity Events")

                # Look for specific activity indicators
                await self.verify_element(page, "text=/[0-9]+m ago|[0-9]+h ago|Just now/", "Timestamp Indicators")

                await self.wait_and_screenshot(page, "06-activity-stream", f"Activity Stream with {activity_count} events")

                # ==========================================
                # TEST 7: View Switching
                # ==========================================
                self.log("\n" + "="*60)
                self.log("TEST 7: View Switching (Org Chart, RACI)")
                self.log("="*60)

                # Try Org Chart
                try:
                    await page.click("button:has-text('Org Chart')", timeout=2000)
                    await asyncio.sleep(1.5)
                    await self.wait_and_screenshot(page, "07-org-chart-view", "Org Chart view")

                    # Try RACI Matrix
                    await page.click("button:has-text('RACI')", timeout=2000)
                    await asyncio.sleep(1.5)
                    await self.wait_and_screenshot(page, "08-raci-matrix", "RACI Matrix view")

                    # Back to Agent Grid
                    await page.click("button:has-text('Agent Grid')", timeout=2000)
                    await asyncio.sleep(1)
                    self.log("View switching works", "SUCCESS")
                except Exception as e:
                    self.log(f"View switching failed: {e}", "WARNING")

                # ==========================================
                # TEST 8: Agent Detail Modal
                # ==========================================
                self.log("\n" + "="*60)
                self.log("TEST 8: Agent Detail Modal")
                self.log("="*60)

                try:
                    # Try to click first agent card
                    agent_card = await page.locator(".agent-card, [data-agent-card]").first.element_handle(timeout=3000)
                    if agent_card:
                        await agent_card.click()
                        await asyncio.sleep(2)

                        # Verify modal opened
                        modal_found = await self.verify_element(page, "[role='dialog'], .modal", "Agent Detail Modal")

                        if modal_found:
                            # Check for tabs
                            await self.verify_element(page, "button:has-text('Overview')", "Overview Tab")
                            await self.verify_element(page, "button:has-text('Inbox')", "Inbox Tab")
                            await self.verify_element(page, "button:has-text('Worklist')", "Worklist Tab")
                            await self.verify_element(page, "button:has-text('Knowledge')", "Knowledge Tab")

                            await self.wait_and_screenshot(page, "09-agent-detail-modal", "Agent Detail Modal")

                            # Close modal
                            try:
                                await page.click("button:has-text('×'), button:has-text('Close')", timeout=2000)
                                await asyncio.sleep(1)
                            except:
                                pass
                except Exception as e:
                    self.log(f"Agent detail modal test failed: {e}", "WARNING")

                # ==========================================
                # FINAL: Full Screenshot
                # ==========================================
                self.log("\n" + "="*60)
                self.log("FINAL: Complete State")
                self.log("="*60)

                await self.wait_and_screenshot(page, "10-final-complete-state", "Final complete state")

            except Exception as e:
                self.log(f"Test execution error: {e}", "ERROR")
                import traceback
                traceback.print_exc()

            finally:
                await browser.close()

        # ==========================================
        # SUMMARY
        # ==========================================
        self.generate_summary()

    def generate_summary(self):
        """Generate test summary"""
        duration = (datetime.now() - self.start_time).total_seconds()

        passed = sum(1 for r in self.results if r.get("status") == "PASS")
        failed = sum(1 for r in self.results if r.get("status") == "FAIL")
        total = len(self.results)

        summary = {
            "timestamp": self.start_time.isoformat(),
            "duration_seconds": duration,
            "total_tests": total,
            "passed": passed,
            "failed": failed,
            "pass_rate": round((passed / total * 100) if total > 0 else 0, 2),
            "screenshots": len(self.screenshots),
            "results": self.results,
            "screenshots_list": self.screenshots
        }

        # Save JSON report
        with open(REPORT_FILE, 'w') as f:
            json.dump(summary, f, indent=2)

        # Print summary
        print("\n" + "="*70)
        print("  TEST SUMMARY")
        print("="*70)
        print(f"Duration: {duration:.2f}s")
        print(f"Tests: {passed}/{total} passed ({summary['pass_rate']}%)")
        print(f"Screenshots: {len(self.screenshots)} captured")
        print(f"\nReport saved: {REPORT_FILE}")
        print(f"Screenshots: {OUTPUT_DIR}/")
        print("\nScreenshots:")
        for s in self.screenshots:
            print(f"  - {s['name']}.png - {s['description']}")
        print("="*70)

async def main():
    tester = VirtualOfficeTest()
    await tester.run_tests()

if __name__ == "__main__":
    asyncio.run(main())
