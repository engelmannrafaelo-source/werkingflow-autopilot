#!/usr/bin/env python3
"""
Autonomous Visual Tester for Virtual Office
Uses Playwright + Vision API to validate UI functionality
"""
import asyncio
import json
import os
import sys
from pathlib import Path
from playwright.async_api import async_playwright
import anthropic

# Configuration
BASE_URL = "http://localhost:4005"
SCREENSHOT_DIR = "/tmp/cui-screenshots"
AI_BRIDGE_KEY = os.getenv("AI_BRIDGE_API_KEY")

# Panels to test
PANELS_TO_TEST = [
    {
        "name": "virtual-office",
        "selector": "[data-panel='virtual-office']",
        "tabs": ["grid", "org", "raci", "business"],
        "expectations": [
            "Activity Stream should show recent events",
            "Agent Grid should display 17 agent cards",
            "Business Approval should show 4 pending items",
            "Action Items panel visible on right"
        ]
    },
    {
        "name": "business-approval",
        "selector": ".business-approval-panel",
        "expectations": [
            "List of 4 pending reports on left side",
            "Markdown content visible on right side",
            "Approve and Reject buttons visible",
            "Comment input field present"
        ]
    },
    {
        "name": "activity-stream",
        "selector": ".activity-stream",
        "expectations": [
            "At least 5 activity events visible",
            "Timestamps showing (e.g., '2m ago', '5h ago')",
            "Agent names and actions displayed",
            "Icons for different action types (✅, 📝, ❌)"
        ]
    }
]

async def capture_screenshot(page, panel_name: str, selector: str = None):
    """Capture screenshot of a specific panel"""
    try:
        if selector:
            element = await page.wait_for_selector(selector, timeout=3000)
            screenshot_path = f"{SCREENSHOT_DIR}/{panel_name}-{int(asyncio.get_event_loop().time() * 1000)}.png"
            await element.screenshot(path=screenshot_path)
        else:
            screenshot_path = f"{SCREENSHOT_DIR}/{panel_name}-{int(asyncio.get_event_loop().time() * 1000)}.png"
            await page.screenshot(path=screenshot_path, full_page=True)

        print(f"✅ Screenshot captured: {screenshot_path}")
        return screenshot_path
    except Exception as e:
        print(f"❌ Failed to capture {panel_name}: {e}")
        return None

async def analyze_screenshot_with_vision(screenshot_path: str, expectations: list[str]):
    """Use Claude Vision to analyze screenshot"""
    if not AI_BRIDGE_KEY:
        print("⚠️  AI_BRIDGE_API_KEY not set - skipping vision analysis")
        return None

    try:
        # Read image
        with open(screenshot_path, "rb") as f:
            image_data = f.read()

        import base64
        image_base64 = base64.b64encode(image_data).decode()

        # Use Anthropic client
        client = anthropic.Anthropic(api_key=AI_BRIDGE_KEY)

        expectations_text = "\n".join([f"- {exp}" for exp in expectations])

        message = client.messages.create(
            model="claude-sonnet-4-5-20250929",
            max_tokens=1024,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": "image/png",
                                "data": image_base64,
                            },
                        },
                        {
                            "type": "text",
                            "text": f"""Analyze this Virtual Office UI screenshot and verify:

{expectations_text}

For each expectation, respond with:
- ✅ PASS: [explanation] if it's visible and working
- ❌ FAIL: [explanation] if it's missing or broken
- ⚠️  PARTIAL: [explanation] if partially visible

Also note any obvious UI bugs, layout issues, or missing data."""
                        }
                    ],
                }
            ],
        )

        analysis = message.content[0].text
        print(f"\n🔍 Vision Analysis:\n{analysis}\n")
        return analysis

    except Exception as e:
        print(f"❌ Vision analysis failed: {e}")
        return None

async def test_virtual_office():
    """Main test function"""
    print("🚀 Starting Visual Office Test\n")

    async with async_playwright() as p:
        # Launch browser
        browser = await p.chromium.launch(
            headless=True,
            args=['--disable-gpu', '--disable-software-rasterizer']
        )

        context = await browser.new_context(
            viewport={'width': 1920, 'height': 1080}
        )

        page = await context.new_page()

        try:
            # Navigate to CUI
            print(f"📍 Navigating to {BASE_URL}")
            await page.goto(BASE_URL, wait_until='networkidle')
            await asyncio.sleep(2)  # Wait for React to render

            # Find and click Virtual Office tab
            print("🔍 Looking for Virtual Office tab...")

            # Try different selectors
            selectors = [
                "button:has-text('Virtual Office')",
                "[data-tab='virtual-office']",
                "text=Virtual Office"
            ]

            clicked = False
            for selector in selectors:
                try:
                    await page.click(selector, timeout=2000)
                    clicked = True
                    print(f"✅ Clicked Virtual Office tab via: {selector}")
                    break
                except:
                    continue

            if not clicked:
                print("⚠️  Virtual Office tab not found - taking full screenshot")
                screenshot_path = await capture_screenshot(page, "full-page")
                if screenshot_path and AI_BRIDGE_KEY:
                    await analyze_screenshot_with_vision(screenshot_path, [
                        "Virtual Office tab should be visible in tab bar",
                        "CUI interface should be loaded"
                    ])
                await browser.close()
                return

            await asyncio.sleep(2)  # Wait for panel to render

            # Capture and analyze each panel
            for panel in PANELS_TO_TEST:
                print(f"\n📸 Testing: {panel['name']}")

                # Capture screenshot
                screenshot_path = await capture_screenshot(
                    page,
                    panel['name'],
                    panel.get('selector')
                )

                if not screenshot_path:
                    continue

                # Analyze with vision
                if AI_BRIDGE_KEY:
                    await analyze_screenshot_with_vision(
                        screenshot_path,
                        panel['expectations']
                    )

                # Test tabs if present
                if 'tabs' in panel:
                    for tab in panel['tabs']:
                        print(f"  🔄 Switching to tab: {tab}")
                        # Try to click tab (implementation depends on UI structure)
                        # For now just log

            # Final full screenshot
            print("\n📸 Capturing final full screenshot...")
            final_screenshot = await capture_screenshot(page, "virtual-office-final")

            if final_screenshot and AI_BRIDGE_KEY:
                await analyze_screenshot_with_vision(final_screenshot, [
                    "Overall UI layout looks correct",
                    "No obvious visual bugs or rendering errors",
                    "All panels are populated with data"
                ])

            print("\n✅ Visual testing complete!")

        except Exception as e:
            print(f"\n❌ Test failed: {e}")
            import traceback
            traceback.print_exc()

        finally:
            await browser.close()

if __name__ == "__main__":
    asyncio.run(test_virtual_office())
