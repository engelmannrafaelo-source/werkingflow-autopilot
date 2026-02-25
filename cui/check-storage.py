#!/usr/bin/env python3
import asyncio
from playwright.async_api import async_playwright
import json

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, args=['--disable-gpu', '--disable-software-rasterizer'])
        page = await browser.new_page()

        await page.goto("http://localhost:4005")
        await asyncio.sleep(5)

        # Get ALL localStorage
        storage = await page.evaluate("() => { return JSON.stringify(localStorage); }")
        storage_obj = json.loads(storage)

        print("📦 localStorage keys:")
        for key in sorted(storage_obj.keys()):
            value_len = len(storage_obj[key])
            print(f"  - {key}: {value_len} chars")
            if 'layout' in key.lower() or 'project' in key.lower():
                print(f"    Preview: {storage_obj[key][:200]}...")

        await browser.close()

asyncio.run(main())
