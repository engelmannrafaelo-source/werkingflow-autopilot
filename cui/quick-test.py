#!/usr/bin/env python3
import asyncio
from playwright.async_api import async_playwright

async def quick_test():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, args=['--disable-gpu', '--disable-software-rasterizer'])
        page = await browser.new_page(viewport={'width': 1920, 'height': 1080})

        print("Loading...")
        await page.goto("http://localhost:4005?project=team", timeout=60000)
        await asyncio.sleep(12)

        await page.screenshot(path="/root/orchestrator/workspaces/team/quick-test.png", full_page=True)
        print("✅ Screenshot: /root/orchestrator/workspaces/team/quick-test.png")

        text = await page.evaluate("() => document.body.textContent")
        has_vo = "Agent Grid" in text or "Live Activity" in text or "Activity Stream" in text
        has_unknown = "Unknown panel" in text

        print(f"Virtual Office rendering: {has_vo}")
        print(f"Unknown panel: {has_unknown}")

        await browser.close()
        return has_vo

asyncio.run(quick_test())
