#!/usr/bin/env python3
"""
Virtual Office Tester - Using Screenshot Request API
Works with the REAL browser that has Virtual Office tab open
"""
import asyncio
import json
import requests
import time
from pathlib import Path

BASE_URL = "http://localhost:4005"
OUTPUT_DIR = "/root/orchestrator/workspaces/team/screenshots-api"
REPORT_FILE = "/root/orchestrator/workspaces/team/VIRTUAL_OFFICE_API_TEST.json"

Path(OUTPUT_DIR).mkdir(parents=True, exist_ok=True)

class APIScreenshotTester:
    def __init__(self):
        self.results = []
        self.screenshots = []

    def log(self, msg, level="INFO"):
        prefix = {"INFO": "ℹ️", "SUCCESS": "✅", "ERROR": "❌", "WARNING": "⚠️"}.get(level, "•")
        print(f"{prefix} {msg}")

    def request_screenshot(self, panel_name, wait_ms=5000):
        """Request screenshot from actual browser via API"""
        self.log(f"Requesting screenshot: {panel_name}")

        try:
            response = requests.post(
                f"{BASE_URL}/api/control/screenshot/request",
                json={"panel": panel_name, "wait": wait_ms},
                timeout=wait_ms/1000 + 2
            )

            if response.status_code == 200:
                data = response.json()
                if data.get("ok"):
                    # Download the screenshot
                    img_url = f"{BASE_URL}{data['url']}"
                    img_response = requests.get(img_url)

                    if img_response.status_code == 200:
                        filename = f"{panel_name.replace('/', '-')}-{int(time.time())}.png"
                        filepath = f"{OUTPUT_DIR}/{filename}"

                        with open(filepath, 'wb') as f:
                            f.write(img_response.content)

                        self.log(f"Screenshot saved: {filename}", "SUCCESS")
                        self.screenshots.append({
                            "panel": panel_name,
                            "file": filepath,
                            "captured_at": data.get("capturedAt")
                        })
                        self.results.append({"test": panel_name, "status": "SUCCESS"})
                        return filepath
                    else:
                        self.log(f"Failed to download image: {img_response.status_code}", "ERROR")
                        self.results.append({"test": panel_name, "status": "FAIL", "error": "download_failed"})
                else:
                    self.log(f"Screenshot request failed: {data}", "ERROR")
                    self.results.append({"test": panel_name, "status": "FAIL", "error": str(data)})
            else:
                error_data = response.json() if response.headers.get('content-type') == 'application/json' else response.text
                self.log(f"HTTP {response.status_code}: {error_data}", "ERROR")
                self.results.append({"test": panel_name, "status": "FAIL", "error": str(error_data)})

        except Exception as e:
            self.log(f"Exception: {e}", "ERROR")
            self.results.append({"test": panel_name, "status": "FAIL", "error": str(e)})

        return None

    def run_tests(self):
        """Run all screenshot tests"""
        self.log("🚀 Virtual Office API Screenshot Tests")
        self.log(f"Target: {BASE_URL}")
        self.log(f"Output: {OUTPUT_DIR}\n")

        # Test panels to capture
        panels_to_test = [
            ("full", "Full page overview"),
            ("virtual-office", "Virtual Office complete panel"),
            ("activity-stream", "Activity Stream (left panel)"),
            ("agent-grid", "Agent Grid (center panel)"),
            ("action-items", "Action Items (right panel)"),
            ("business-approval", "Business Approval panel"),
        ]

        self.log("="*60)
        self.log("Capturing screenshots from live browser...")
        self.log("="*60 + "\n")

        for panel_id, description in panels_to_test:
            self.log(f"\n[{panel_id}] {description}")
            self.request_screenshot(panel_id, wait_ms=6000)
            time.sleep(1)  # Wait between requests

        # Generate summary
        self.generate_summary()

    def generate_summary(self):
        """Generate test summary"""
        passed = sum(1 for r in self.results if r.get("status") == "SUCCESS")
        failed = len(self.results) - passed

        summary = {
            "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
            "total_tests": len(self.results),
            "passed": passed,
            "failed": failed,
            "screenshots": self.screenshots,
            "results": self.results
        }

        # Save report
        with open(REPORT_FILE, 'w') as f:
            json.dump(summary, f, indent=2)

        # Print summary
        print("\n" + "="*70)
        print("  TEST SUMMARY")
        print("="*70)
        print(f"Tests: {passed}/{len(self.results)} successful")
        print(f"Screenshots captured: {len(self.screenshots)}")
        print(f"\nReport: {REPORT_FILE}")
        print(f"Screenshots: {OUTPUT_DIR}/\n")

        if self.screenshots:
            print("Captured:")
            for s in self.screenshots:
                size_kb = Path(s['file']).stat().st_size // 1024
                print(f"  - {Path(s['file']).name} ({size_kb}KB)")

        print("="*70)

        # Return success/failure
        return passed == len(self.results)

if __name__ == "__main__":
    tester = APIScreenshotTester()
    success = tester.run_tests()

    exit(0 if success else 1)
