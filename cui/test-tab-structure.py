#!/usr/bin/env python3
"""
Debug tab structure to understand how to properly click Virtual Office
"""
import asyncio
from playwright.async_api import async_playwright

async def debug_tabs():
    print("🔍 Debugging Tab Structure\n")

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=['--disable-gpu', '--disable-software-rasterizer']
        )

        context = await browser.new_context(viewport={'width': 1920, 'height': 1080})
        page = await context.new_page()

        try:
            await page.goto("http://localhost:4005?project=team", wait_until='networkidle')
            await asyncio.sleep(3)

            # Get detailed tab information via JavaScript
            tab_info = await page.evaluate("""
                () => {
                    const results = [];

                    // Find all tab elements
                    const tabs = document.querySelectorAll('[class*="flexlayout__tab"]');

                    tabs.forEach((tab, i) => {
                        results.push({
                            index: i,
                            text: tab.textContent.trim().substring(0, 50),
                            classes: tab.className,
                            dataPath: tab.getAttribute('data-layout-path'),
                            dataId: tab.getAttribute('data-layout-id'),
                            visible: tab.offsetParent !== null,
                            selected: tab.classList.contains('flexlayout__tab--selected'),
                            innerHTML: tab.innerHTML.substring(0, 200)
                        });
                    });

                    return results;
                }
            """)

            print("TAB STRUCTURE:\n")
            for tab in tab_info:
                print(f"Tab {tab['index']}:")
                print(f"  Text: {tab['text']}")
                print(f"  Classes: {tab['classes']}")
                print(f"  Data-Path: {tab.get('dataPath', 'none')}")
                print(f"  Data-ID: {tab.get('dataId', 'none')}")
                print(f"  Visible: {tab['visible']}")
                print(f"  Selected: {tab['selected']}")
                if "Virtual Office" in tab['text']:
                    print(f"  ⭐ THIS IS VIRTUAL OFFICE!")
                    print(f"  HTML: {tab['innerHTML']}")
                print()

            # Try to find Virtual Office by exact ID from layout
            print("\nSearching for Virtual Office by ID: #d9620459-5e42-41c9-a506-b9d00e1a04e3")
            vo_tab = await page.query_selector('[data-layout-id="#d9620459-5e42-41c9-a506-b9d00e1a04e3"]')
            if vo_tab:
                print("✅ Found by ID!")
                text = await vo_tab.inner_text()
                print(f"Text: {text}")
            else:
                print("❌ Not found by ID")

        finally:
            await browser.close()

if __name__ == "__main__":
    asyncio.run(debug_tabs())
