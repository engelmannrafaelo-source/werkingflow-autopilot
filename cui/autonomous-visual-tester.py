#!/usr/bin/env python3
"""
CUI Autonomous Visual Tester - Rafbot Style
Inspects Virtual Office like a real user would

Pattern: Unified-Tester für UI/UX
- Playwright headless browser
- Screenshot capture
- Claude Vision analysis
- AI-driven decision making
- Self-healing test logic
"""
import asyncio
import json
import os
import sys
import base64
from pathlib import Path
from datetime import datetime
from playwright.async_api import async_playwright
import anthropic

#  Configuration
BASE_URL = os.getenv("CUI_URL", "http://localhost:4005")
SCREENSHOT_DIR = "/tmp/cui-visual-tests"
AI_BRIDGE_KEY = os.getenv("AI_BRIDGE_API_KEY")
ANTHROPIC_KEY = os.getenv("ANTHROPIC_API_KEY", AI_BRIDGE_KEY)

Path(SCREENSHOT_DIR).mkdir(exist_ok=True)

# Test Scenarios - What Rafbot would check
TEST_SCENARIOS = [
    {
        "name": "Virtual Office Overview",
        "steps": [
            {"action": "navigate", "url": BASE_URL},
            {"action": "wait", "selector": "#root", "timeout": 5000},
            {"action": "click", "selector": "text=Virtual Office", "optional": True},
            {"action": "wait_for_stable", "duration": 2},
            {"action": "screenshot", "name": "virtual-office-overview"},
            {"action": "analyze", "expectations": [
                "Activity Stream panel visible on the left",
                "Agent Grid or view selector in center",
                "Action Items panel visible on right",
                "At least some data populated (not all empty)"
            ]}
        ]
    },
    {
        "name": "Activity Stream Check",
        "steps": [
            {"action": "screenshot", "selector": ".activity-stream, [data-panel='activity']", "name": "activity-stream"},
            {"action": "analyze", "expectations": [
                "At least 3-5 activity events visible",
                "Events have timestamps (e.g., '2m ago', '1h ago')",
                "Agent names displayed (Herbert, Klaus, Sarah, etc.)",
                "Action icons visible (✅, 📝, ❌, 💬)"
            ]}
        ]
    },
    {
        "name": "Business Approval Panel",
        "steps": [
            {"action": "click", "selector": "text=Business", "optional": True},
            {"action": "wait_for_stable", "duration": 1},
            {"action": "screenshot", "name": "business-approval-panel"},
            {"action": "analyze", "expectations": [
                "List of pending items visible on left (4 items expected)",
                "Reports listed: Security Audit, Performance, Tech Debt",
                "Right side shows content area (may be empty until item clicked)",
                "Approve/Reject buttons present"
            ]}
        ]
    },
    {
        "name": "Business Approval - Content Check",
        "steps": [
            {"action": "click", "selector": "text=Security Audit, text=Performance, text=Tech Debt", "first": True},
            {"action": "wait_for_stable", "duration": 1},
            {"action": "screenshot", "name": "business-approval-content"},
            {"action": "analyze", "expectations": [
                "Markdown content visible on right side",
                "Content is NOT empty",
                "Headers, lists, or formatted text visible",
                "Content matches selected report (Security/Performance/Tech Debt)"
            ], "critical": True}
        ]
    },
    {
        "name": "Agent Grid",
        "steps": [
            {"action": "click", "selector": "button:has-text('Agent Grid'), [data-view='grid']", "optional": True},
            {"action": "wait_for_stable", "duration": 1},
            {"action": "screenshot", "name": "agent-grid"},
            {"action": "analyze", "expectations": [
                "Multiple agent cards visible (expecting 17 agents)",
                "Each card shows agent name",
                "MBTI badges visible (ENTJ, INTP, etc.)",
                "Status indicators (idle, working, error)"
            ]}
        ]
    },
    {
        "name": "Agent Detail Modal",
        "steps": [
            {"action": "click", "selector": ".agent-card, button:has-text('Herbert'), button:has-text('Sarah')", "first": True},
            {"action": "wait_for_stable", "duration": 1},
            {"action": "screenshot", "name": "agent-detail-modal"},
            {"action": "analyze", "expectations": [
                "Modal overlay visible",
                "Agent details displayed (name, role, MBTI)",
                "Tabs visible (Overview, Inbox, Worklist, Knowledge, etc.)",
                "Can see agent-specific information"
            ]}
        ]
    }
]

class VisualTester:
    def __init__(self):
        self.results = []
        self.screenshots = []
        self.client = anthropic.Anthropic(api_key=ANTHROPIC_KEY) if ANTHROPIC_KEY else None
        self.conversation_history = []  # AI maintains context

    async def run_step(self, page, step):
        """Execute a single test step"""
        action = step["action"]

        if action == "navigate":
            await page.goto(step["url"], wait_until='networkidle')
            print(f"  ✅ Navigated to {step['url']}")

        elif action == "wait":
            selector = step["selector"]
            timeout = step.get("timeout", 5000)
            await page.wait_for_selector(selector, timeout=timeout)
            print(f"  ✅ Found: {selector}")

        elif action == "click":
            selector = step["selector"]
            optional = step.get("optional", False)
            first = step.get("first", False)

            # Support multiple selectors (try each until one works)
            selectors = [s.strip() for s in selector.split(",")]

            clicked = False
            for sel in selectors:
                try:
                    if first:
                        await page.locator(sel).first.click(timeout=2000)
                    else:
                        await page.click(sel, timeout=2000)
                    print(f"  ✅ Clicked: {sel}")
                    clicked = True
                    break
                except Exception as e:
                    if not optional:
                        print(f"  ⚠️  Click failed: {sel} - {e}")
                    continue

            if not clicked and not optional:
                raise Exception(f"Could not click any of: {selector}")

        elif action == "wait_for_stable":
            duration = step.get("duration", 1)
            await asyncio.sleep(duration)
            print(f"  ⏱️  Waited {duration}s for stability")

        elif action == "screenshot":
            screenshot_name = step["name"]
            selector = step.get("selector")

            timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
            screenshot_path = f"{SCREENSHOT_DIR}/{screenshot_name}-{timestamp}.png"

            if selector:
                # Try to find element
                try:
                    element = await page.locator(selector).first.element_handle(timeout=2000)
                    await element.screenshot(path=screenshot_path)
                except:
                    # Fallback to full page
                    await page.screenshot(path=screenshot_path, full_page=False)
            else:
                await page.screenshot(path=screenshot_path, full_page=False)

            print(f"  📸 Screenshot saved: {screenshot_path}")
            self.screenshots.append(screenshot_path)
            return screenshot_path

        elif action == "analyze":
            if not self.client:
                print("  ⚠️  Vision analysis skipped (no AI_BRIDGE_API_KEY)")
                return None

            expectations = step["expectations"]
            critical = step.get("critical", False)

            # Analyze last screenshot
            if not self.screenshots:
                print("  ❌ No screenshot to analyze")
                return None

            last_screenshot = self.screenshots[-1]
            result = await self.analyze_with_vision(last_screenshot, expectations, critical)
            return result

    async def analyze_with_vision(self, screenshot_path: str, expectations: list, critical: bool = False):
        """Use Claude Vision to analyze screenshot"""
        try:
            with open(screenshot_path, "rb") as f:
                image_data = base64.b64encode(f.read()).decode()

            expectations_text = "\n".join([f"- {exp}" for exp in expectations])

            # Build conversation context
            system_context = f"""You are Rafbot, the Virtual Office Manager, testing the CUI interface.
You've been asked to verify the UI is working correctly.

Previous findings:
{json.dumps(self.conversation_history[-3:] if self.conversation_history else [], indent=2)}

This screenshot is {'CRITICAL - must pass' if critical else 'important to verify'}.
"""

            response = self.client.messages.create(
                model="claude-sonnet-4-5-20250929",
                max_tokens=1024,
                system=system_context,
                messages=[
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "image",
                                "source": {
                                    "type": "base64",
                                    "media_type": "image/png",
                                    "data": image_data,
                                },
                            },
                            {
                                "type": "text",
                                "text": f"""Analyze this UI screenshot and verify these expectations:

{expectations_text}

For each expectation, respond:
- ✅ PASS: [brief explanation]
- ❌ FAIL: [what's wrong]
- ⚠️  PARTIAL: [what's missing]

Also note:
- Any obvious bugs or layout issues
- Empty panels that should have data
- Missing UI elements
- Performance issues (loading states, etc.)

Be concise but thorough."""
                            }
                        ],
                    }
                ],
            )

            analysis = response.content[0].text
            print(f"\n🔍 Vision Analysis:\n{analysis}\n")

            # Track in conversation
            self.conversation_history.append({
                "screenshot": screenshot_path,
                "expectations": expectations,
                "analysis": analysis,
                "critical": critical
            })

            # Check for failures
            if "❌ FAIL" in analysis and critical:
                print(f"\n⚠️  CRITICAL FAILURE detected!")

            return analysis

        except Exception as e:
            print(f"❌ Vision analysis failed: {e}")
            return None

    async def run_scenario(self, page, scenario):
        """Run a complete test scenario"""
        print(f"\n{'='*60}")
        print(f"📋 Scenario: {scenario['name']}")
        print(f"{'='*60}\n")

        try:
            for i, step in enumerate(scenario["steps"], 1):
                print(f"[{i}/{len(scenario['steps'])}] {step['action']}")
                await self.run_step(page, step)

            print(f"\n✅ Scenario '{scenario['name']}' completed\n")
            return True

        except Exception as e:
            print(f"\n❌ Scenario '{scenario['name']}' failed: {e}\n")
            return False

    async def run_all(self):
        """Run all test scenarios"""
        print(f"""
{'='*70}
  CUI Autonomous Visual Tester
  Testing: {BASE_URL}
  Screenshots: {SCREENSHOT_DIR}
{'='*70}
""")

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
                for scenario in TEST_SCENARIOS:
                    success = await self.run_scenario(page, scenario)
                    self.results.append({
                        "scenario": scenario["name"],
                        "success": success
                    })

                # Generate summary
                self.print_summary()

            finally:
                await browser.close()

    def print_summary(self):
        """Print test summary"""
        print(f"\n{'='*70}")
        print("  TEST SUMMARY")
        print(f"{'='*70}\n")

        passed = sum(1 for r in self.results if r["success"])
        failed = len(self.results) - passed

        for r in self.results:
            status = "✅ PASS" if r["success"] else "❌ FAIL"
            print(f"{status}: {r['scenario']}")

        print(f"\nTotal: {passed}/{len(self.results)} passed")
        print(f"Screenshots: {len(self.screenshots)} captured")

        if self.conversation_history:
            critical_failures = [
                h for h in self.conversation_history
                if h.get("critical") and "❌ FAIL" in h.get("analysis", "")
            ]

            if critical_failures:
                print(f"\n⚠️  {len(critical_failures)} CRITICAL FAILURES detected:")
                for f in critical_failures:
                    print(f"   - {Path(f['screenshot']).name}")

        print(f"\n{'='*70}\n")

async def main():
    tester = VisualTester()
    await tester.run_all()

if __name__ == "__main__":
    asyncio.run(main())
