#!/usr/bin/env python3
"""
Click on "Team" workspace tab in top bar, then capture Virtual Office
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

        print("🎯 Capturing Virtual Office - Click Team Workspace\n")

        await page.goto("http://localhost:4005", timeout=60000)
        await asyncio.sleep(15)

        # Close welcome dialog
        try:
            close_btn = await page.query_selector('button:has-text("Got it")')
            if close_btn:
                await close_btn.click()
                await asyncio.sleep(1)
        except:
            pass

        print("✅ Page loaded")

        # Click "Team" in the top workspace bar
        print("🔍 Looking for Team workspace tab...")
        try:
            # Try multiple selectors
            await page.click('text=Team', timeout=10000)
            await asyncio.sleep(5)
            print("✅ Clicked Team workspace")
        except Exception as e:
            print(f"⚠️  Could not click Team workspace: {e}")

            # Try clicking "Team (Screenshots)"
            try:
                await page.click('text=Team (Screenshots)', timeout=5000)
                await asyncio.sleep(5)
                print("✅ Clicked Team (Screenshots)")
            except Exception as e2:
                print(f"❌ Also failed: {e2}")
                await page.screenshot(path=f"{OUTPUT}/00-no-team-tab.png", full_page=True)
                await browser.close()
                return

        # Now look for Virtual Office panel
        agent_grid = await page.query_selector('button:has-text("Agent Grid")')
        print(f"\n🔍 Virtual Office visible: {agent_grid is not None}")

        if not agent_grid:
            print("⚠️  Taking fallback screenshot")
            await page.screenshot(path=f"{OUTPUT}/00-after-team-click.png", full_page=True)
            await browser.close()
            return

        print("\n📸 Capturing all 9 views...\n")

        # 1. Agent Grid
        print("1. Dashboard - Agent Grid...")
        await agent_grid.click()
        await asyncio.sleep(3)
        await page.screenshot(path=f"{OUTPUT}/01-dashboard-agent-grid.png", full_page=True)
        print("   ✅")

        # 2. Org Chart
        print("2. Dashboard - Org Chart...")
        org_btn = await page.query_selector('button:has-text("Org Chart")')
        if org_btn:
            await org_btn.click()
            await asyncio.sleep(3)
        await page.screenshot(path=f"{OUTPUT}/02-dashboard-org-chart.png", full_page=True)
        print("   ✅")

        # 3. RACI
        print("3. Dashboard - RACI Matrix...")
        raci_btn = await page.query_selector('button:has-text("RACI")')
        if raci_btn:
            await raci_btn.click()
            await asyncio.sleep(3)
        await page.screenshot(path=f"{OUTPUT}/03-dashboard-raci-matrix.png", full_page=True)
        print("   ✅")

        # 4-9: Other views
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
