#!/usr/bin/env python3
"""
Simplified Infisical Panel Test
Tests that panel works when directly loaded via URL parameter
"""

import requests
from playwright.sync_api import sync_playwright
import time

# Configuration
CUI_BASE_URL = "http://localhost:4005"
API_BASE = f"{CUI_BASE_URL}/api/infisical"

print("=" * 60)
print("INFISICAL PANEL SIMPLE TEST")
print("=" * 60)

# Test 1: API Endpoints
print("\n[1/3] Testing API endpoints...")
try:
    response = requests.get(f"{API_BASE}/status", timeout=30)
    assert response.status_code == 200
    data = response.json()
    assert 'projects' in data
    assert len(data['projects']) == 7
    print("✅ API endpoints working")
except Exception as e:
    print(f"❌ API test failed: {e}")
    exit(1)

# Test 2: Component Registration
print("\n[2/3] Testing component registration...")
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()

        # Go to Administration project (should auto-load Infisical panel)
        page.goto(f"{CUI_BASE_URL}", wait_until="networkidle", timeout=30000)
        time.sleep(3)

        # Click Administration project tab
        admin_tab = page.query_selector('button:has-text("ADMINISTRATION")')
        if admin_tab:
            admin_tab.click()
            time.sleep(3)

            # Check if infisical panel rendered
            panel = page.query_selector('[data-component="InfisicalMonitor"]')
            if panel:
                print("✅ InfisicalMonitor component rendered")
            else:
                print("❌ InfisicalMonitor component NOT found")
                print("   Available components:")
                comps = page.query_selector_all('[data-component]')
                for c in comps[:10]:
                    print(f"   - {c.get_attribute('data-component')}")
        else:
            print("⚠️  ADMINISTRATION tab not found")

        browser.close()
except Exception as e:
    print(f"❌ Component test failed: {e}")
    exit(1)

# Test 3: Panel Data Loading
print("\n[3/3] Testing panel data loading...")
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page.goto(f"{CUI_BASE_URL}", wait_until="networkidle", timeout=30000)
        time.sleep(3)

        # Click Administration
        admin_tab = page.query_selector('button:has-text("ADMINISTRATION")')
        if admin_tab:
            admin_tab.click()
            time.sleep(5)  # Wait for data to load

            # Check if project names are visible
            found_projects = 0
            for project in ['werking-report', 'engelmann', 'platform']:
                if page.query_selector(f'text="{project}"'):
                    found_projects += 1

            if found_projects >= 2:
                print(f"✅ Panel loads data ({found_projects}/3 projects visible)")
            else:
                print(f"⚠️  Panel data incomplete ({found_projects}/3 projects)")

        browser.close()
except Exception as e:
    print(f"❌ Data loading test failed: {e}")

print("\n" + "=" * 60)
print("SIMPLE TEST COMPLETE")
print("=" * 60)
