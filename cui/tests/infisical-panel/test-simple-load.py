#!/usr/bin/env python3
"""
Simple Load Test - Just verify panel renders without errors
"""

import asyncio
import sys
from playwright.async_api import async_playwright

BASE_URL = "http://localhost:4005"

async def test_panel_load():
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=['--disable-gpu', '--disable-software-rasterizer']
        )
        
        page = await browser.new_page()
        
        errors = []
        page.on('console', lambda msg: errors.append(msg) if msg.type == 'error' else None)
        
        try:
            response = await page.goto(f"{BASE_URL}/?panel=infisical-monitor", 
                                      wait_until='load', timeout=15000)
            
            if response and response.ok:
                print("✓ Page loaded successfully")
            else:
                print(f"✗ Page load failed: {response.status if response else 'no response'}")
                return False
            
            await page.wait_for_timeout(3000)
            
            # Check for critical errors
            critical_errors = [e for e in errors if 'CRITICAL' in e.text or 'Failed to fetch' in e.text]
            
            if len(critical_errors) > 0:
                print(f"✗ Found {len(critical_errors)} critical errors")
                for err in critical_errors[:3]:
                    print(f"  {err.text[:100]}")
                return False
            
            print(f"✓ No critical errors (found {len(errors)} minor errors)")
            
            # Take screenshot for manual verification
            await page.screenshot(path='/tmp/infisical-panel-simple.png')
            print("✓ Screenshot saved to /tmp/infisical-panel-simple.png")
            
            return True
            
        except Exception as e:
            print(f"✗ Test failed: {e}")
            return False
        finally:
            await browser.close()

if __name__ == "__main__":
    result = asyncio.run(test_panel_load())
    sys.exit(0 if result else 1)
