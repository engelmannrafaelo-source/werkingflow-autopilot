#!/usr/bin/env python3
"""
Click the actual virtual-office tab element visible at the top
"""
import asyncio
from playwright.async_api import async_playwright

OUTPUT = "/root/projekte/werkingflow/autopilot/cui/data/active/team"

async def capture():
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=['--disable-gpu', '--disable-software-rasterizer']
        )
        page = await browser.new_page(viewport={'width': 1920, 'height': 1080})

        print("🎯 Capturing Virtual Office - Direct Tab Click\n")

        await page.goto("http://localhost:4005?project=team", timeout=60000)
        await asyncio.sleep(15)

        # Close welcome
        try:
            close_btn = await page.query_selector('button:has-text("Got it")')
            if close_btn:
                await close_btn.click()
                await asyncio.sleep(1)
        except:
            pass

        print("✅ Page loaded")

        # Click the virtual-office tab that's visible at the top
        print("🔍 Clicking virtual-office tab...")

        # Try clicking by the tab title/name that's visible
        try:
            # Look for the tab button with "virtual-office" in it
            await page.click('.flexlayout__tab:has-text("virtual-office")', timeout=5000)
            await asyncio.sleep(5)
            print("✅ Clicked virtual-office tab")
        except Exception as e:
            print(f"⚠️  Method 1 failed: {e}")

            # Alternative: try clicking any element containing "virtual-office"
            try:
                await page.click('text=virtual-office', timeout=5000)
                await asyncio.sleep(5)
                print("✅ Clicked via text selector")
            except Exception as e2:
                print(f"❌ Method 2 also failed: {e2}")

        # Check if Virtual Office is now visible
        agent_grid = await page.query_selector('button:has-text("Agent Grid")')
        activity_stream = await page.query_selector('text=Activity Stream')

        print(f"\n🔍 Virtual Office check:")
        print(f"  Agent Grid button: {agent_grid is not None}")
        print(f"  Activity Stream: {activity_stream is not None}")

        if not agent_grid:
            print("\n⚠️  Virtual Office still not visible")
            await page.screenshot(path=f"{OUTPUT}/00-debug.png", full_page=True)

            # Try one more thing: use keyboard to switch tabs
            print("🔍 Trying keyboard navigation (Cmd+1)...")
            await page.keyboard.press('Meta+1')
            await asyncio.sleep(3)

            agent_grid = await page.query_selector('button:has-text("Agent Grid")')
            if agent_grid:
                print("✅ Keyboard navigation worked!")
            else:
                print("❌ Still not visible")
                await browser.close()
                return

        print("\n📸 Capturing all 9 views...\n")

        # Now capture all views
        print("1. Dashboard - Agent Grid...")
        await agent_grid.click()
        await asyncio.sleep(3)
        await page.screenshot(path=f"{OUTPUT}/01-dashboard-agent-grid.png", full_page=True)
        print("   ✅")

        print("2. Dashboard - Org Chart...")
        org_btn = await page.query_selector('button:has-text("Org Chart")')
        if org_btn:
            await org_btn.click()
            await asyncio.sleep(3)
        await page.screenshot(path=f"{OUTPUT}/02-dashboard-org-chart.png", full_page=True)
        print("   ✅")

        print("3. Dashboard - RACI Matrix...")
        raci_btn = await page.query_selector('button:has-text("RACI")')
        if raci_btn:
            await raci_btn.click()
            await asyncio.sleep(3)
        await page.screenshot(path=f"{OUTPUT}/03-dashboard-raci-matrix.png", full_page=True)
        print("   ✅")

        views = [
            ("Office", "04-office-view.png"),
            ("Tasks", "05-tasks-view.png"),
            ("Reviews", "06-reviews-view.png"),
            ("Knowledge", "07-knowledge-view.png"),
            ("Agents", "08-agents-view.png"),
            ("Chat", "09-chat-view.png")
        ]

        for i, (name, filename) in enumerate(views, 4):
            print(f"{i}. {name} View...")
            btn = await page.query_selector(f'button:has-text("{name}")')
            if btn:
                await btn.click()
                await asyncio.sleep(3)
            await page.screenshot(path=f"{OUTPUT}/{filename}", full_page=True)
            print("   ✅")

        await browser.close()

        print(f"\n{'='*60}")
        print("✅ ALL SCREENSHOTS CAPTURED!")
        print(f"{'='*60}")
        print(f"Location: {OUTPUT}/")
        print(f"{'='*60}\n")

asyncio.run(capture())
