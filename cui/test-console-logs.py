#!/usr/bin/env python3
"""
Capture all console logs to see why Virtual Office isn't rendering
"""
import asyncio
from playwright.async_api import async_playwright

async def test_console():
    print("🔍 Capturing Console Logs\n")

    console_logs = []
    errors = []

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=['--disable-gpu', '--disable-software-rasterizer']
        )

        context = await browser.new_context(viewport={'width': 1920, 'height': 1080})
        page = await context.new_page()

        # Capture all console messages
        page.on('console', lambda msg: console_logs.append(f"[{msg.type}] {msg.text}"))
        page.on('pageerror', lambda err: errors.append(f"[PAGE ERROR] {err}"))

        try:
            print("📍 Loading: http://localhost:4005?project=team\n")
            await page.goto("http://localhost:4005?project=team", wait_until='networkidle')
            await asyncio.sleep(5)

            # Try to check if office component is registered
            has_office = await page.evaluate("""
                () => {
                    // Check if office factory is registered
                    return typeof window.OfficePanel !== 'undefined' ||
                           typeof window.VirtualOffice !== 'undefined';
                }
            """)

            print(f"Office component registered: {has_office}\n")

            # Check what's actually selected
            selected_info = await page.evaluate("""
                () => {
                    const tabs = document.querySelectorAll('[class*="flexlayout__tab_button--selected"]');
                    return Array.from(tabs).map(tab => ({
                        text: tab.textContent,
                        path: tab.getAttribute('data-layout-path')
                    }));
                }
            """)

            print(f"Selected tabs:")
            for tab in selected_info:
                print(f"  - {tab['text']} (path: {tab['path']})")

            print("\n" + "="*60)
            print("CONSOLE LOGS:")
            print("="*60)
            for log in console_logs:
                print(log)

            if errors:
                print("\n" + "="*60)
                print("ERRORS:")
                print("="*60)
                for err in errors:
                    print(err)

        finally:
            await browser.close()

if __name__ == "__main__":
    asyncio.run(test_console())
