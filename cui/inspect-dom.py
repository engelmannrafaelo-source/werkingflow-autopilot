#!/usr/bin/env python3
import asyncio
from playwright.async_api import async_playwright

async def inspect():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, args=['--disable-gpu', '--disable-software-rasterizer'])
        page = await browser.new_page(viewport={'width': 1920, 'height': 1080})

        await page.goto("http://localhost:4005?project=team", timeout=60000)
        await asyncio.sleep(15)

        # Get all tab button texts
        tabs = await page.query_selector_all('.flexlayout__tab')
        print(f"\n📋 Found {len(tabs)} tabs:")
        for i, tab in enumerate(tabs):
            text = await tab.inner_text()
            title = await tab.get_attribute('title')
            print(f"  {i+1}. Text: '{text}' | Title: '{title}'")

        # Check for Virtual Office specific elements
        print("\n🔍 Checking for Virtual Office elements:")

        checks = [
            ('Activity Stream', 'text=Activity Stream'),
            ('Agent Grid button', 'button:has-text("Agent Grid")'),
            ('Dashboard text', 'text=Dashboard'),
            ('Virtual Office tab', 'div:has-text("Virtual Office")'),
        ]

        for name, selector in checks:
            elem = await page.query_selector(selector)
            print(f"  {name}: {'✅ Found' if elem else '❌ Not found'}")

        # Save HTML for inspection
        html = await page.content()
        with open('/root/orchestrator/workspaces/team/page-dom.html', 'w') as f:
            f.write(html)
        print("\n💾 Saved full HTML to: /root/orchestrator/workspaces/team/page-dom.html")

        await browser.close()

asyncio.run(inspect())
