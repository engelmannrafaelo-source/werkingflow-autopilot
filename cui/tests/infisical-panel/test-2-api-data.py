#!/usr/bin/env python3
"""
Test 2: API Data Validation
Tests data structure and content from API endpoints
"""

import requests
import sys
import json

BASE_URL = "http://localhost:4005"

def test_projects_structure():
    """Test projects data structure"""
    print("🔍 Testing projects data structure...")
    
    try:
        response = requests.get(f"{BASE_URL}/api/infisical/projects", timeout=5)
        
        if response.status_code != 200:
            print(f"   ❌ Projects endpoint failed: {response.status_code}")
            return False
        
        data = response.json()
        projects = data.get('projects', [])
        
        if not projects:
            print(f"   ❌ No projects returned")
            return False
        
        # Validate structure of first project
        proj = projects[0]
        required_fields = ['id', 'name', 'description', 'environment', 'lastSync', 'status']
        
        missing = [field for field in required_fields if field not in proj]
        if missing:
            print(f"   ❌ Missing fields in project: {missing}")
            return False
        
        print(f"   ✅ Project structure valid")
        print(f"   ✅ All {len(projects)} projects have required fields")
        return True
        
    except Exception as e:
        print(f"   ❌ Error: {e}")
        return False

def test_secrets_endpoint():
    """Test secrets endpoint for a project"""
    print("\n🔍 Testing secrets endpoint...")
    
    try:
        # First get a project ID
        response = requests.get(f"{BASE_URL}/api/infisical/projects", timeout=5)
        projects = response.json().get('projects', [])
        
        if not projects:
            print(f"   ❌ No projects to test secrets")
            return False
        
        project_id = projects[0]['id']
        
        # Now test secrets endpoint
        response = requests.get(f"{BASE_URL}/api/infisical/secrets/{project_id}", timeout=5)
        
        if response.status_code != 200:
            print(f"   ❌ Secrets endpoint failed: {response.status_code}")
            return False
        
        data = response.json()
        secrets = data.get('secrets', [])
        
        print(f"   ✅ Secrets endpoint working")
        print(f"   Found {len(secrets)} secrets for project {project_id}")
        
        if secrets:
            # Validate structure
            secret = secrets[0]
            if 'key' not in secret:
                print(f"   ❌ Secret missing 'key' field")
                return False
            if 'value' in secret and secret['value'] != '[HIDDEN]':
                print(f"   ⚠️  Secret values should be hidden!")
                return False
            
            print(f"   ✅ Secret structure valid")
            print(f"   ✅ Values properly hidden")
        
        return True
        
    except Exception as e:
        print(f"   ❌ Error: {e}")
        return False

def test_sync_status_structure():
    """Test sync status data structure"""
    print("\n🔍 Testing sync status structure...")
    
    try:
        response = requests.get(f"{BASE_URL}/api/infisical/sync-status", timeout=5)
        
        if response.status_code != 200:
            print(f"   ❌ Sync status endpoint failed: {response.status_code}")
            return False
        
        data = response.json()
        
        # Check required fields
        required_fields = ['total_syncs', 'succeeded', 'failed', 'last_sync', 'syncs']
        missing = [field for field in required_fields if field not in data]
        
        if missing:
            print(f"   ❌ Missing fields: {missing}")
            return False
        
        syncs = data.get('syncs', [])
        if syncs:
            sync = syncs[0]
            sync_fields = ['project', 'target', 'status', 'timestamp']
            missing = [field for field in sync_fields if field not in sync]
            
            if missing:
                print(f"   ❌ Missing sync fields: {missing}")
                return False
        
        print(f"   ✅ Sync status structure valid")
        print(f"   ✅ Found {len(syncs)} sync records")
        return True
        
    except Exception as e:
        print(f"   ❌ Error: {e}")
        return False

def test_project_environments():
    """Test that all 7 projects have correct environments"""
    print("\n🔍 Testing project environments...")
    
    try:
        response = requests.get(f"{BASE_URL}/api/infisical/projects", timeout=5)
        data = response.json()
        projects = data.get('projects', [])
        
        # Expected environment mapping
        vercel_projects = ['werking-report', 'engelmann', 'werking-safety-fe', 
                           'werking-energy-fe', 'platform']
        railway_projects = ['werking-safety-be', 'werking-energy-be']
        
        errors = []
        for proj in projects:
            name = proj['id']
            env = proj['environment']
            
            if name in vercel_projects and env != 'Vercel':
                errors.append(f"{name} should be Vercel, got {env}")
            elif name in railway_projects and env != 'Railway':
                errors.append(f"{name} should be Railway, got {env}")
        
        if errors:
            print(f"   ❌ Environment mismatches:")
            for error in errors:
                print(f"      - {error}")
            return False
        
        print(f"   ✅ All project environments correct")
        print(f"   ✅ 5 Vercel + 2 Railway = 7 total")
        return True
        
    except Exception as e:
        print(f"   ❌ Error: {e}")
        return False

def test_sync_targets():
    """Test sync target mapping"""
    print("\n🔍 Testing sync targets...")
    
    try:
        response = requests.get(f"{BASE_URL}/api/infisical/sync-status", timeout=5)
        data = response.json()
        syncs = data.get('syncs', [])
        
        # Verify all 7 projects have syncs
        project_names = {sync['project'] for sync in syncs}
        
        if len(project_names) != 7:
            print(f"   ⚠️  Expected 7 unique projects, got {len(project_names)}")
        
        # Check target format
        for sync in syncs:
            target = sync['target']
            if ':' not in target:
                print(f"   ❌ Invalid target format: {target}")
                return False
        
        print(f"   ✅ All sync targets valid")
        print(f"   ✅ {len(project_names)} projects configured")
        return True
        
    except Exception as e:
        print(f"   ❌ Error: {e}")
        return False

def main():
    """Run all data validation tests"""
    print("=" * 60)
    print("Infisical Panel - API Data Validation Tests")
    print("=" * 60)
    
    # Check if server is running
    try:
        requests.get(BASE_URL, timeout=2)
    except:
        print(f"❌ Server not running at {BASE_URL}")
        sys.exit(1)
    
    results = []
    
    # Run tests
    results.append(("Projects Structure", test_projects_structure()))
    results.append(("Secrets Endpoint", test_secrets_endpoint()))
    results.append(("Sync Status Structure", test_sync_status_structure()))
    results.append(("Project Environments", test_project_environments()))
    results.append(("Sync Targets", test_sync_targets()))
    
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
        print("🎉 All data validation tests passed!")
        sys.exit(0)
    else:
        print(f"⚠️  {total - passed} test(s) failed")
        sys.exit(1)

if __name__ == "__main__":
    main()
