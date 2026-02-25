#!/usr/bin/env python3
"""
Capture React errors to see why OfficePanel fails to render
"""
import asyncio
import json
from playwright.async_api import async_playwright

async def test_react_errors():
    print("🔍 Checking for React/Component Errors\n")

    console_logs = []
    page_errors = []

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=['--disable-gpu', '--disable-software-rasterizer']
        )

        context = await browser.new_context(viewport={'width': 1920, 'height': 1080})
        page = await context.new_page()

        # Capture EVERYTHING
        page.on('console', lambda msg: console_logs.append({
            'type': msg.type,
            'text': msg.text,
            'location': msg.location
        }))
        page.on('pageerror', lambda err: page_errors.append(str(err)))

        # Also inject a global error handler
        await page.add_init_script("""
            window.addEventListener('error', (event) => {
                console.error('[GLOBAL ERROR]', event.error?.message || event.message);
            });
            window.addEventListener('unhandledrejection', (event) => {
                console.error('[UNHANDLED PROMISE]', event.reason);
            });
        """)

        try:
            print("📍 Loading: http://localhost:4005?project=team\n")
            await page.goto("http://localhost:4005?project=team", wait_until='networkidle')
            await asyncio.sleep(5)

            # Check what components are actually mounted
            mounted_components = await page.evaluate("""
                () => {
                    const results = [];

                    // Check for Virtual Office specific elements
                    if (document.querySelector('[class*="virtual-office"]')) {
                        results.push('VirtualOffice mounted');
                    }
                    if (document.querySelector('[class*="activity-stream"]')) {
                        results.push('ActivityStream mounted');
                    }
                    if (document.querySelector('[class*="agent-grid"]')) {
                        results.push('AgentGrid mounted');
                    }
                    if (document.querySelector('[class*="action-items"]')) {
                        results.push('ActionItems mounted');
                    }

                    // Check for any office-related classes
                    const officeElems = document.querySelectorAll('[class*="office"]');
                    results.push(`Found ${officeElems.length} elements with 'office' in className`);

                    return results;
                }
            """)

            print("Mounted Components:")
            for comp in mounted_components:
                print(f"  {comp}")

            # Separate logs by type
            errors = [log for log in console_logs if log['type'] == 'error']
            warnings = [log for log in console_logs if log['type'] == 'warning']
            info = [log for log in console_logs if log['type'] in ['log', 'info']]

            print(f"\n{'='*60}")
            print(f"SUMMARY:")
            print(f"{'='*60}")
            print(f"Errors: {len(errors)}")
            print(f"Warnings: {len(warnings)}")
            print(f"Info logs: {len(info)}")
            print(f"Page errors: {len(page_errors)}")

            if errors:
                print(f"\n{'='*60}")
                print(f"ERRORS:")
                print(f"{'='*60}")
                for err in errors:
                    print(f"[{err['type']}] {err['text']}")
                    if err.get('location'):
                        print(f"  Location: {err['location']}")

            if page_errors:
                print(f"\n{'='*60}")
                print(f"PAGE ERRORS:")
                print(f"{'='*60}")
                for err in page_errors:
                    print(err)

            # Save full log
            with open("/root/orchestrator/workspaces/team/browser-logs.json", "w") as f:
                json.dump({
                    "console_logs": console_logs,
                    "page_errors": page_errors,
                    "mounted_components": mounted_components
                }, f, indent=2)

            print(f"\n📄 Full log saved: /root/orchestrator/workspaces/team/browser-logs.json")

        finally:
            await browser.close()

if __name__ == "__main__":
    asyncio.run(test_react_errors())
