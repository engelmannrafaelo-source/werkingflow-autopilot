#!/usr/bin/env python3
"""
Debug what's actually rendered
"""
import asyncio
from playwright.async_api import async_playwright

async def debug():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, args=['--disable-gpu', '--disable-software-rasterizer'])
        page = await browser.new_page(viewport={'width': 1920, 'height': 1080})

        # Clear storage
        await page.goto("http://localhost:4005")
        await page.evaluate("() => { localStorage.clear(); sessionStorage.clear(); }")

        # Load team-screenshots
        await page.goto("http://localhost:4005?project=team-screenshots", timeout=60000)
        await asyncio.sleep(12)

        # Get HTML of the page
        content = await page.content()
        with open("/root/orchestrator/workspaces/team/debug.html", "w") as f:
            f.write(content)

        # Check for Virtual Office elements
        dashboard = await page.query_selector('text=Dashboard')
        agent_grid = await page.query_selector('button:has-text("Agent Grid")')

        print(f"Dashboard found: {dashboard is not None}")
        print(f"Agent Grid button found: {agent_grid is not None}")

        # Take screenshot
        await page.screenshot(path="/root/orchestrator/workspaces/team/debug.png")

        await browser.close()

asyncio.run(debug())
