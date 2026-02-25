#!/usr/bin/env python3
"""
Capture ONLY Virtual Office content (not the whole page with multiple tabs)
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

        print("🎯 Capturing Virtual Office Content ONLY\n")

        # Load team project (has Virtual Office tab)
        await page.goto("http://localhost:4005?project=team", timeout=60000)
        await asyncio.sleep(15)  # Wait for full render

        # Close welcome dialog if present
        try:
            close_btn = await page.query_selector('button:has-text("Got it")')
            if close_btn:
                await close_btn.click()
                await asyncio.sleep(1)
        except:
            pass

        # Find and click the "Virtual Office" tab to activate it
        print("🔍 Looking for Virtual Office tab...")

        # Try multiple selectors to find the tab
        tab_selectors = [
            'div.flexlayout__tab_button_content:has-text("Virtual Office")',
            'div.flexlayout__tab:has-text("Virtual Office")',
            'div[title="Virtual Office"]',
            'button:has-text("Virtual Office")'
        ]

        tab_clicked = False
        for selector in tab_selectors:
            try:
                tab = await page.query_selector(selector)
                if tab:
                    await tab.click()
                    await asyncio.sleep(3)
                    print(f"✅ Clicked Virtual Office tab with selector: {selector}")
                    tab_clicked = True
                    break
            except:
                continue

        if not tab_clicked:
            print("⚠️  Could not click Virtual Office tab - trying to screenshot anyway")

        # Now find the Virtual Office panel container
        print("🔍 Looking for Virtual Office panel...")

        # Wait for Virtual Office specific elements to be visible
        try:
            await page.wait_for_selector('text=Activity Stream', timeout=10000)
            print("✅ Found Virtual Office content (Activity Stream)")
        except:
            print("⚠️  Activity Stream not found - panel may not be visible")

        # Try to find the Virtual Office container element
        panel_selectors = [
            'div.virtual-office-container',
            'div[data-component="office"]',
            'div.office-panel',
            # Find by checking for child elements that are unique to Virtual Office
            'div:has(div:has-text("Activity Stream"))',
        ]

        panel = None
        for selector in panel_selectors:
            try:
                panel = await page.query_selector(selector)
                if panel:
                    print(f"✅ Found Virtual Office panel with selector: {selector}")
                    break
            except:
                continue

        if panel:
            # Screenshot ONLY the Virtual Office panel, not the whole page
            print("\n📸 Capturing Virtual Office panel screenshots...\n")

            # 1. Dashboard - Agent Grid
            print("📸 1. Dashboard - Agent Grid...")
            agent_grid_btn = await page.query_selector('button:has-text("Agent Grid")')
            if agent_grid_btn:
                await agent_grid_btn.click()
                await asyncio.sleep(3)
            await panel.screenshot(path=f"{OUTPUT}/01-dashboard-agent-grid.png")
            print("   ✅ Saved")

            # 2. Dashboard - Org Chart
            print("📸 2. Dashboard - Org Chart...")
            org_chart_btn = await page.query_selector('button:has-text("Org Chart")')
            if org_chart_btn:
                await org_chart_btn.click()
                await asyncio.sleep(3)
            await panel.screenshot(path=f"{OUTPUT}/02-dashboard-org-chart.png")
            print("   ✅ Saved")

            # 3. Dashboard - RACI Matrix
            print("📸 3. Dashboard - RACI Matrix...")
            raci_btn = await page.query_selector('button:has-text("RACI")')
            if raci_btn:
                await raci_btn.click()
                await asyncio.sleep(3)
            await panel.screenshot(path=f"{OUTPUT}/03-dashboard-raci-matrix.png")
            print("   ✅ Saved")

            # 4-9: Other views (Office, Tasks, Reviews, Knowledge, Agents, Chat)
            views = [
                ("Office", "04-office-view.png"),
                ("Tasks", "05-tasks-view.png"),
                ("Reviews", "06-reviews-view.png"),
                ("Knowledge", "07-knowledge-view.png"),
                ("Agents", "08-agents-view.png"),
                ("Chat", "09-chat-view.png")
            ]

            for i, (view_name, filename) in enumerate(views, 4):
                print(f"📸 {i}. {view_name} View...")
                btn = await page.query_selector(f'button:has-text("{view_name}")')
                if btn:
                    await btn.click()
                    await asyncio.sleep(3)
                    await panel.screenshot(path=f"{OUTPUT}/{filename}")
                    print("   ✅ Saved")
                else:
                    print(f"   ⚠️  {view_name} button not found")

        else:
            print("❌ Could not find Virtual Office panel element!")
            print("📸 Taking full page screenshot as fallback...")
            await page.screenshot(path=f"{OUTPUT}/fallback-full-page.png", full_page=True)

        await browser.close()

        print(f"\n{'='*60}")
        print("✅ SCREENSHOTS COMPLETE!")
        print(f"{'='*60}")
        print(f"Location: {OUTPUT}/")
        print(f"{'='*60}\n")

asyncio.run(capture())
