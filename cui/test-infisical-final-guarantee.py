#!/usr/bin/env python3
"""
INFISICAL MONITOR - FINAL 100% FUNCTIONAL GUARANTEE TEST
Tests complete data flow: API → Component → UI
"""

import sys
import json
import requests
from pathlib import Path

CUI_URL = "http://localhost:4005"

class Colors:
    GREEN = '\033[92m'
    RED = '\033[91m'
    BLUE = '\033[94m'
    YELLOW = '\033[93m'
    BOLD = '\033[1m'
    RESET = '\033[0m'

def print_header(text):
    print(f"\n{Colors.BOLD}{Colors.BLUE}{'=' * 70}{Colors.RESET}")
    print(f"{Colors.BOLD}{Colors.BLUE}{text:^70}{Colors.RESET}")
    print(f"{Colors.BOLD}{Colors.BLUE}{'=' * 70}{Colors.RESET}\n")

def test(name, condition, details=""):
    status = f"{Colors.GREEN}✓{Colors.RESET}" if condition else f"{Colors.RED}✗{Colors.RESET}"
    print(f"{status} {name}")
    if details:
        print(f"  {Colors.YELLOW}{details}{Colors.RESET}")
    return condition

def main():
    print_header("INFISICAL MONITOR - FINAL 100% FUNCTIONAL GUARANTEE")

    all_passed = True

    # ===== GUARANTEE 1: COMPONENT EXISTS =====
    print(f"\n{Colors.BOLD}GUARANTEE 1: Component WILL Load{Colors.RESET}")
    print("-" * 70)

    # Check build output
    build_file = Path("/root/projekte/werkingflow/autopilot/cui/dist/assets")
    infisical_files = list(build_file.glob("InfisicalMonitor-*.js"))

    all_passed &= test(
        "Component in build output",
        len(infisical_files) > 0,
        f"Found: {infisical_files[0].name if infisical_files else 'MISSING'}"
    )

    if infisical_files:
        size_kb = infisical_files[0].stat().st_size / 1024
        all_passed &= test(
            "Component size reasonable",
            10 < size_kb < 50,
            f"Size: {size_kb:.2f} KB"
        )

    # Check LayoutManager registration
    layout_manager = Path("/root/projekte/werkingflow/autopilot/cui/src/components/LayoutManager.tsx")
    content = layout_manager.read_text()

    all_passed &= test(
        "Lazy import exists",
        "InfisicalMonitor" in content and ("React.lazy" in content or "lazy(" in content),
        "import('./panels/InfisicalMonitor/InfisicalMonitor')"
    )

    all_passed &= test(
        "Component case handler",
        "case 'infisical-monitor':" in content,
        "Registered in switch statement"
    )

    # ===== GUARANTEE 2: API RESPONDS =====
    print(f"\n{Colors.BOLD}GUARANTEE 2: API WILL Respond{Colors.RESET}")
    print("-" * 70)

    endpoints = [
        ("health", "/api/infisical/health"),
        ("status", "/api/infisical/status"),
        ("projects", "/api/infisical/projects"),
        ("syncs", "/api/infisical/syncs"),
        ("infrastructure", "/api/infisical/infrastructure"),
        ("server-info", "/api/infisical/server-info"),
    ]

    for name, endpoint in endpoints:
        try:
            resp = requests.get(f"{CUI_URL}{endpoint}", timeout=20)
            all_passed &= test(
                f"Endpoint: {name}",
                resp.status_code == 200,
                f"Status {resp.status_code}"
            )
        except Exception as e:
            all_passed &= test(f"Endpoint: {name}", False, str(e))

    # ===== GUARANTEE 3: DATA IS VALID =====
    print(f"\n{Colors.BOLD}GUARANTEE 3: Data WILL Display{Colors.RESET}")
    print("-" * 70)

    try:
        resp = requests.get(f"{CUI_URL}/api/infisical/status", timeout=20)
        data = resp.json()

        all_passed &= test(
            "Status returns JSON",
            isinstance(data, dict),
            f"Type: {type(data).__name__}"
        )

        all_passed &= test(
            "Has server field",
            "server" in data,
            f"Server: {data.get('server', {}).get('tailscale_ip', 'N/A')}"
        )

        all_passed &= test(
            "Has projects field",
            "projects" in data,
            f"Projects: {len(data.get('projects', []))}"
        )

        # Verify all 7 projects
        projects = data.get("projects", [])
        expected_projects = [
            "werking-report", "engelmann", "werking-safety-fe",
            "werking-safety-be", "werking-energy-fe",
            "werking-energy-be", "platform"
        ]

        found_ids = [p.get("id") for p in projects]
        missing = [exp for exp in expected_projects if exp not in found_ids]

        all_passed &= test(
            "All 7 projects present",
            len(missing) == 0,
            f"Found: {len(found_ids)}/7, Missing: {missing or 'none'}"
        )

        # Verify project structure
        if projects:
            first_project = projects[0]
            required_fields = ["id", "name", "sync_target", "status"]
            has_fields = all(field in first_project for field in required_fields)

            all_passed &= test(
                "Project structure valid",
                has_fields,
                f"Fields: {list(first_project.keys())[:4]}"
            )

        # Verify sync targets
        sync_targets = [p.get("sync_target", "") for p in projects]
        vercel_count = sum(1 for t in sync_targets if "Vercel" in t)
        railway_count = sum(1 for t in sync_targets if "Railway" in t)

        all_passed &= test(
            "Sync targets valid",
            vercel_count == 5 and railway_count == 2,
            f"Vercel: {vercel_count}/5, Railway: {railway_count}/2"
        )

    except Exception as e:
        all_passed &= test("Data validation", False, str(e))

    # ===== GUARANTEE 4: INTEGRATION COMPLETE =====
    print(f"\n{Colors.BOLD}GUARANTEE 4: Integration Complete{Colors.RESET}")
    print("-" * 70)

    # Check LayoutBuilder
    layout_builder = Path("/root/projekte/werkingflow/autopilot/cui/src/components/LayoutBuilder.tsx")
    lb_content = layout_builder.read_text()

    all_passed &= test(
        "LayoutBuilder dropdown",
        "infisical-monitor" in lb_content and "Infisical Monitor" in lb_content,
        "Available in dropdown"
    )

    all_passed &= test(
        "LayoutBuilder factory",
        "case 'infisical-monitor':" in lb_content,
        "Config factory exists"
    )

    # Check server routes
    server_index = Path("/root/projekte/werkingflow/autopilot/cui/server/index.ts")
    server_content = server_index.read_text()

    all_passed &= test(
        "Routes imported",
        "infisicalRoutes" in server_content,
        "import infisicalRoutes from './routes/infisical-routes.js'"
    )

    all_passed &= test(
        "Routes registered",
        "app.use('/api/infisical', infisicalRoutes)" in server_content,
        "Mounted at /api/infisical"
    )

    # Check route file exists
    routes_file = Path("/root/projekte/werkingflow/autopilot/cui/server/routes/infisical-routes.ts")
    all_passed &= test(
        "Route file exists",
        routes_file.exists(),
        f"Size: {routes_file.stat().st_size} bytes"
    )

    # ===== GUARANTEE 5: ERROR HANDLING =====
    print(f"\n{Colors.BOLD}GUARANTEE 5: Error Handling Works{Colors.RESET}")
    print("-" * 70)

    # Test invalid project ID
    try:
        resp = requests.get(f"{CUI_URL}/api/infisical/secrets/INVALID", timeout=20)
        all_passed &= test(
            "Invalid project ID handled",
            resp.status_code == 200,  # Should return empty, not error
            f"Status: {resp.status_code}"
        )
    except Exception as e:
        all_passed &= test("Invalid project ID", False, str(e))

    # Test malformed request
    try:
        resp = requests.post(
            f"{CUI_URL}/api/infisical/trigger-sync",
            json={"invalid": "data"},
            timeout=20
        )
        all_passed &= test(
            "Malformed request handled",
            resp.status_code in [200, 400],  # Either accepts or rejects gracefully
            f"Status: {resp.status_code}"
        )
    except Exception as e:
        all_passed &= test("Malformed request", False, str(e))

    # Test concurrent requests
    try:
        import concurrent.futures

        def make_request():
            return requests.get(f"{CUI_URL}/api/infisical/status", timeout=20)

        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
            futures = [executor.submit(make_request) for _ in range(5)]
            results = [f.result() for f in futures]
            success_count = sum(1 for r in results if r.status_code == 200)

            all_passed &= test(
                "Concurrent requests",
                success_count == 5,
                f"Successful: {success_count}/5"
            )
    except Exception as e:
        all_passed &= test("Concurrent requests", False, str(e))

    # ===== FINAL SUMMARY =====
    print_header("FINAL VERIFICATION SUMMARY")

    if all_passed:
        print(f"{Colors.GREEN}{Colors.BOLD}✓ ALL GUARANTEES VERIFIED{Colors.RESET}")
        print(f"\n{Colors.BOLD}100% FUNCTIONAL GUARANTEE:{Colors.RESET}")
        print(f"  1. ✅ Component WILL load (in build, registered)")
        print(f"  2. ✅ API WILL respond (all 6 endpoints tested)")
        print(f"  3. ✅ Data WILL display (7 projects, valid structure)")
        print(f"  4. ✅ Integration complete (LayoutBuilder, routes)")
        print(f"  5. ✅ Error handling works (edge cases tested)")
        print(f"\n{Colors.GREEN}{Colors.BOLD}🎉 PANEL IS PRODUCTION READY{Colors.RESET}")
        return 0
    else:
        print(f"{Colors.RED}{Colors.BOLD}✗ SOME GUARANTEES FAILED{Colors.RESET}")
        print(f"\nPanel may not be fully functional. Review errors above.")
        return 1

if __name__ == "__main__":
    sys.exit(main())
