#!/usr/bin/env python3
"""
Comprehensive Virtual Office Test - Check EVERYTHING
Tests all views, clicks through all tabs, captures everything
"""
import asyncio
import json
from pathlib import Path
from playwright.async_api import async_playwright
from datetime import datetime

BASE_URL = "http://localhost:4005"
OUTPUT_DIR = "/root/orchestrator/workspaces/team/comprehensive-test"
Path(OUTPUT_DIR).mkdir(parents=True, exist_ok=True)

class ComprehensiveTester:
    def __init__(self):
        self.screenshots = []
        self.findings = []

    def log(self, msg, level="INFO"):
        icons = {"INFO": "ℹ️", "SUCCESS": "✅", "ERROR": "❌", "WARNING": "⚠️"}
        print(f"{icons.get(level, '•')} {msg}")

    async def capture(self, page, name, description):
        """Capture screenshot and save"""
        path = f"{OUTPUT_DIR}/{name}.png"
        await page.screenshot(path=path, full_page=False)
        size = Path(path).stat().st_size // 1024
        self.log(f"Screenshot: {name}.png ({size}KB)")
        self.screenshots.append({
            "name": name,
            "description": description,
            "path": path,
            "size_kb": size
        })

    async def check_element_exists(self, page, selector, name):
        """Check if element exists and has content"""
        try:
            element = await page.wait_for_selector(selector, timeout=2000)
            text = await element.inner_text()
            has_content = len(text.strip()) > 10
            self.findings.append({
                "element": name,
                "exists": True,
                "has_content": has_content,
                "preview": text[:100] if has_content else "(empty)"
            })
            return True
        except:
            self.findings.append({
                "element": name,
                "exists": False,
                "has_content": False
            })
            return False

    async def run_comprehensive_test(self):
        self.log("🚀 Starting Comprehensive Virtual Office Test\n", "INFO")

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
                # 1. Load CUI
                self.log("Step 1: Loading CUI...")
                await page.goto(BASE_URL, wait_until='networkidle')
                await asyncio.sleep(3)
                await self.capture(page, "01-initial-load", "Initial CUI load")

                # 2. Find Virtual Office or Office Lite tab
                self.log("\nStep 2: Looking for Virtual Office tab...")

                # Try Virtual Office first
                virtual_office_found = False
                try:
                    # Look for Virtual Office tab in flexlayout
                    tabs = await page.locator("div[class*='flexlayout__tab']").all()
                    for tab in tabs:
                        text = await tab.inner_text()
                        if "Virtual Office" in text:
                            self.log(f"Found Virtual Office tab!", "SUCCESS")
                            await tab.click(timeout=5000)
                            await asyncio.sleep(2)
                            virtual_office_found = True
                            break
                except Exception as e:
                    self.log(f"Virtual Office tab not found: {e}", "WARNING")

                if not virtual_office_found:
                    # Fallback: Click Office Lite and try Dashboard
                    self.log("Trying Office Lite → Dashboard...")
                    try:
                        tabs = await page.locator("div[class*='flexlayout__tab']").all()
                        for tab in tabs:
                            text = await tab.inner_text()
                            if "Office Lite" in text or "Office" in text:
                                await tab.click(timeout=5000)
                                await asyncio.sleep(2)

                                # Click Dashboard button
                                try:
                                    await page.click("button:has-text('Dashboard')", timeout=3000)
                                    await asyncio.sleep(2)
                                    self.log("Clicked Dashboard button", "SUCCESS")
                                except:
                                    self.log("Dashboard button not found", "WARNING")
                                break
                    except Exception as e:
                        self.log(f"Office Lite not found: {e}", "ERROR")

                await self.capture(page, "02-office-opened", "Office/Virtual Office opened")

                # 3. Test all view buttons
                self.log("\nStep 3: Testing all view buttons...")
                buttons = [
                    ("Dashboard", "03-dashboard-view"),
                    ("Office", "04-office-view"),
                    ("Tasks", "05-tasks-view"),
                    ("Reviews", "06-reviews-view"),
                    ("Knowledge", "07-knowledge-view"),
                    ("Agents", "08-agents-view"),
                ]

                for button_text, screenshot_name in buttons:
                    try:
                        self.log(f"Clicking {button_text}...")
                        # Try multiple selector strategies
                        clicked = False
                        selectors = [
                            f"button:has-text('{button_text}')",
                            f"button:has-text('🎛️'):has-text('{button_text}')" if button_text == "Dashboard" else None,
                            f"button:has-text('🏢'):has-text('{button_text}')" if button_text == "Office" else None,
                            f"button:has-text('📋'):has-text('{button_text}')" if button_text == "Tasks" else None,
                            f"button:has-text('📝'):has-text('{button_text}')" if button_text == "Reviews" else None,
                            f"button:has-text('📚'):has-text('{button_text}')" if button_text == "Knowledge" else None,
                            f"button:has-text('🤖'):has-text('{button_text}')" if button_text == "Agents" else None,
                        ]

                        for selector in [s for s in selectors if s]:
                            try:
                                await page.click(selector, timeout=2000)
                                await asyncio.sleep(2)
                                clicked = True
                                self.log(f"  → Clicked via {selector}", "SUCCESS")
                                break
                            except:
                                continue

                        if not clicked:
                            self.log(f"  → Button not found", "WARNING")

                        await self.capture(page, screenshot_name, f"{button_text} view")

                        # Check for content
                        if button_text == "Tasks":
                            await self.check_element_exists(page, ".task-list, [data-tasks]", "Task List")
                        elif button_text == "Knowledge":
                            await self.check_element_exists(page, ".knowledge-base, [data-knowledge]", "Knowledge Base")
                        elif button_text == "Agents":
                            await self.check_element_exists(page, ".agent-card, [data-agent-card]", "Agent Cards")

                    except Exception as e:
                        self.log(f"  → Error: {e}", "ERROR")

                # 4. Check Virtual Office specific panels (if we're in Virtual Office)
                self.log("\nStep 4: Checking Virtual Office panels...")

                # Activity Stream
                if await self.check_element_exists(page, ".activity-stream, [data-panel='activity']", "Activity Stream"):
                    self.log("  Activity Stream exists", "SUCCESS")
                else:
                    self.log("  Activity Stream not found", "WARNING")

                # Agent Grid
                if await self.check_element_exists(page, ".agent-grid, [data-panel='agents']", "Agent Grid"):
                    self.log("  Agent Grid exists", "SUCCESS")
                else:
                    self.log("  Agent Grid not found", "WARNING")

                # Action Items
                if await self.check_element_exists(page, ".action-items, [data-panel='action-items']", "Action Items"):
                    self.log("  Action Items exists", "SUCCESS")
                else:
                    self.log("  Action Items not found", "WARNING")

                # 5. Final screenshot
                await self.capture(page, "09-final-state", "Final state")

                # Generate report
                self.generate_report()

            finally:
                await browser.close()

    def generate_report(self):
        """Generate comprehensive report"""
        report = {
            "timestamp": datetime.now().isoformat(),
            "base_url": BASE_URL,
            "output_dir": OUTPUT_DIR,
            "screenshots": self.screenshots,
            "findings": self.findings,
            "summary": {
                "total_screenshots": len(self.screenshots),
                "elements_found": sum(1 for f in self.findings if f.get("exists")),
                "elements_with_content": sum(1 for f in self.findings if f.get("has_content")),
                "elements_empty": sum(1 for f in self.findings if f.get("exists") and not f.get("has_content"))
            }
        }

        report_path = f"{OUTPUT_DIR}/REPORT.json"
        with open(report_path, 'w') as f:
            json.dump(report, f, indent=2)

        self.log("\n" + "="*70)
        self.log("COMPREHENSIVE TEST REPORT", "INFO")
        self.log("="*70)
        self.log(f"Screenshots: {len(self.screenshots)}")
        self.log(f"Elements found: {report['summary']['elements_found']}")
        self.log(f"Elements with content: {report['summary']['elements_with_content']}")
        self.log(f"Elements empty: {report['summary']['elements_empty']}")
        self.log(f"\nReport: {report_path}")
        self.log(f"Screenshots: {OUTPUT_DIR}/")
        self.log("="*70)

        # Print findings
        if self.findings:
            self.log("\nFindings:")
            for f in self.findings:
                status = "✅" if f.get("has_content") else ("⚠️" if f.get("exists") else "❌")
                self.log(f"  {status} {f['element']}: {f.get('preview', 'not found')[:50]}")

if __name__ == "__main__":
    tester = ComprehensiveTester()
    asyncio.run(tester.run_comprehensive_test())
