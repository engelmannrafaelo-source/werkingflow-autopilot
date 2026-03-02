#!/usr/bin/env python3
"""
Test 1: API Health Check
Tests basic connectivity to Infisical API endpoints
"""

import requests
import sys
import json

BASE_URL = "http://localhost:4005"

def test_health():
    """Test health endpoint"""
    print("🔍 Testing API health endpoint...")
    
    try:
        response = requests.get(f"{BASE_URL}/api/infisical/health", timeout=5)
        print(f"   Status: {response.status_code}")
        
        if response.status_code == 200:
            data = response.json()
            print(f"   ✅ Health check passed")
            print(f"   Server URL: {data.get('server_url')}")
            print(f"   Status: {data.get('status')}")
            return True
        else:
            print(f"   ❌ Health check failed: {response.status_code}")
            return False
            
    except Exception as e:
        print(f"   ❌ Health check error: {e}")
        return False

def test_status():
    """Test status endpoint"""
    print("\n🔍 Testing API status endpoint...")
    
    try:
        response = requests.get(f"{BASE_URL}/api/infisical/status", timeout=5)
        print(f"   Status: {response.status_code}")
        
        if response.status_code == 200:
            data = response.json()
            print(f"   ✅ Status check passed")
            print(f"   Server URL: {data.get('server_url')}")
            print(f"   Connected: {data.get('connected')}")
            print(f"   Mode: {data.get('mode')}")
            return True
        else:
            print(f"   ❌ Status check failed: {response.status_code}")
            return False
            
    except Exception as e:
        print(f"   ❌ Status check error: {e}")
        return False

def test_projects():
    """Test projects endpoint"""
    print("\n🔍 Testing API projects endpoint...")
    
    try:
        response = requests.get(f"{BASE_URL}/api/infisical/projects", timeout=5)
        print(f"   Status: {response.status_code}")
        
        if response.status_code == 200:
            data = response.json()
            projects = data.get('projects', [])
            print(f"   ✅ Projects check passed")
            print(f"   Projects found: {len(projects)}")
            
            if len(projects) == 7:
                print(f"   ✅ Expected 7 projects")
                for proj in projects[:3]:  # Show first 3
                    print(f"      - {proj['name']} ({proj['id']})")
                return True
            else:
                print(f"   ⚠️  Expected 7 projects, got {len(projects)}")
                return False
        else:
            print(f"   ❌ Projects check failed: {response.status_code}")
            return False
            
    except Exception as e:
        print(f"   ❌ Projects check error: {e}")
        return False

def test_sync_status():
    """Test sync status endpoint"""
    print("\n🔍 Testing API sync-status endpoint...")
    
    try:
        response = requests.get(f"{BASE_URL}/api/infisical/sync-status", timeout=5)
        print(f"   Status: {response.status_code}")
        
        if response.status_code == 200:
            data = response.json()
            print(f"   ✅ Sync status check passed")
            print(f"   Total syncs: {data.get('total_syncs')}")
            print(f"   Succeeded: {data.get('succeeded')}")
            print(f"   Failed: {data.get('failed')}")
            return True
        else:
            print(f"   ❌ Sync status check failed: {response.status_code}")
            return False
            
    except Exception as e:
        print(f"   ❌ Sync status check error: {e}")
        return False

def test_server_info():
    """Test server info endpoint"""
    print("\n🔍 Testing API server-info endpoint...")
    
    try:
        response = requests.get(f"{BASE_URL}/api/infisical/server-info", timeout=5)
        print(f"   Status: {response.status_code}")
        
        if response.status_code == 200:
            data = response.json()
            print(f"   ✅ Server info check passed")
            print(f"   URL: {data.get('url')}")
            print(f"   Public IP: {data.get('public_ip')}")
            return True
        else:
            print(f"   ❌ Server info check failed: {response.status_code}")
            return False
            
    except Exception as e:
        print(f"   ❌ Server info check error: {e}")
        return False

def main():
    """Run all API health tests"""
    print("=" * 60)
    print("Infisical Panel - API Health Tests")
    print("=" * 60)
    
    # Check if server is running
    try:
        requests.get(BASE_URL, timeout=2)
    except:
        print(f"❌ Server not running at {BASE_URL}")
        print("   Start with: npm run dev:server")
        sys.exit(1)
    
    results = []
    
    # Run tests
    results.append(("Health", test_health()))
    results.append(("Status", test_status()))
    results.append(("Projects", test_projects()))
    results.append(("Sync Status", test_sync_status()))
    results.append(("Server Info", test_server_info()))
    
    # Summary
    print("\n" + "=" * 60)
    print("Test Summary")
    print("=" * 60)
    
    passed = sum(1 for _, result in results if result)
    total = len(results)
    
    for name, result in results:
        status = "✅ PASS" if result else "❌ FAIL"
        print(f"{status} - {name}")
    
    print(f"\nTotal: {passed}/{total} tests passed")
    
    if passed == total:
        print("🎉 All API health tests passed!")
        sys.exit(0)
    else:
        print(f"⚠️  {total - passed} test(s) failed")
        sys.exit(1)

if __name__ == "__main__":
    main()
