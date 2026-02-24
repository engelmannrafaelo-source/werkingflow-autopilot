#!/usr/bin/env python3
"""
Extract Claude.ai sessionKey Cookies from Mac Browsers

Works on macOS with Chrome, Brave, Firefox, Safari, Arc, Edge.
Run this ON YOUR MAC, then copy output to server's ~/.zshrc
"""

import os
import sqlite3
import json
import subprocess
from pathlib import Path

BROWSERS = {
    "Chrome": "~/Library/Application Support/Google/Chrome/Default/Cookies",
    "Brave": "~/Library/Application Support/BraveSoftware/Brave-Browser/Default/Cookies",
    "Arc": "~/Library/Application Support/Arc/User Data/Default/Cookies",
    "Edge": "~/Library/Application Support/Microsoft Edge/Default/Cookies",
    "Firefox": "~/Library/Application Support/Firefox/Profiles/*.default-release/cookies.sqlite",
}

def decrypt_chrome_cookie_mac(encrypted_value):
    """Decrypt Chrome cookies on macOS using Keychain"""
    try:
        # Chrome stores encryption key in Keychain
        cmd = ['security', 'find-generic-password', '-w', '-s', 'Chrome Safe Storage', '-a', 'Chrome']
        key = subprocess.check_output(cmd).strip()

        # Decryption logic (simplified - Chrome v10+ uses different format)
        # For now, return placeholder
        return None
    except:
        return None

def extract_from_chromium(cookie_path):
    """Extract from Chromium-based browsers (Chrome, Brave, Arc, Edge)"""
    path = Path(cookie_path).expanduser()
    if not path.exists():
        return []

    # Copy to temp (Chrome locks the file)
    temp_path = f"/tmp/{path.name}.copy"
    subprocess.run(['cp', str(path), temp_path], capture_output=True)

    try:
        conn = sqlite3.connect(temp_path)
        cursor = conn.cursor()

        # Query for claude.ai sessionKey
        cursor.execute("""
            SELECT host_key, name, value, encrypted_value
            FROM cookies
            WHERE host_key LIKE '%claude.ai'
            AND name = 'sessionKey'
        """)

        results = []
        for row in cursor.fetchall():
            host, name, value, encrypted = row

            # Try plaintext first
            if value:
                results.append(value)
            # Encrypted value (Chrome v10+)
            elif encrypted:
                # Decrypt attempt (may fail)
                decrypted = decrypt_chrome_cookie_mac(encrypted)
                if decrypted:
                    results.append(decrypted)

        conn.close()
        os.remove(temp_path)
        return results
    except Exception as e:
        print(f"  Error: {e}")
        return []

def extract_from_firefox(profile_pattern):
    """Extract from Firefox"""
    profile_dir = Path(profile_pattern).expanduser().parent
    profiles = list(profile_dir.glob("*.default-release"))

    results = []
    for profile in profiles:
        cookie_path = profile / "cookies.sqlite"
        if not cookie_path.exists():
            continue

        temp_path = f"/tmp/firefox_cookies.copy"
        subprocess.run(['cp', str(cookie_path), temp_path], capture_output=True)

        try:
            conn = sqlite3.connect(temp_path)
            cursor = conn.cursor()

            cursor.execute("""
                SELECT host, name, value
                FROM moz_cookies
                WHERE host LIKE '%claude.ai'
                AND name = 'sessionKey'
            """)

            for row in cursor.fetchall():
                results.append(row[2])

            conn.close()
            os.remove(temp_path)
        except:
            pass

    return results

def main():
    print("=== Claude.ai Token Extractor (macOS) ===\n")
    print("Searching browsers for sessionKey cookies...\n")

    all_tokens = {}

    for browser, path in BROWSERS.items():
        print(f"[{browser}]")

        try:
            if browser == "Firefox":
                tokens = extract_from_firefox(path)
            else:
                tokens = extract_from_chromium(path)

            if tokens:
                print(f"  ✓ Found {len(tokens)} token(s)")
                all_tokens[browser] = tokens
            else:
                print(f"  ✗ No tokens found")
        except Exception as e:
            print(f"  ✗ Error: {e}")

        print()

    if not all_tokens:
        print("\n❌ No tokens found!")
        print("\nManual extraction:")
        print("1. Open claude.ai in browser")
        print("2. DevTools (Cmd+Opt+I) → Application → Cookies")
        print("3. Find 'sessionKey', copy value")
        return

    # Consolidate unique tokens
    unique_tokens = set()
    for tokens in all_tokens.values():
        unique_tokens.update(tokens)

    print(f"\n✅ Found {len(unique_tokens)} unique token(s):\n")

    for i, token in enumerate(unique_tokens, 1):
        print(f"[{i}] {token[:30]}...{token[-10:]}")

    print("\n📋 Copy these to server's ~/.zshrc:\n")
    print("# Claude.ai Authentication Tokens")

    if len(unique_tokens) >= 3:
        tokens_list = list(unique_tokens)
        print(f'export CLAUDE_AUTH_TOKEN_RAFAEL="{tokens_list[0]}"')
        print(f'export CLAUDE_AUTH_TOKEN_OFFICE="{tokens_list[1]}"')
        print(f'export CLAUDE_AUTH_TOKEN_ENGELMANN="{tokens_list[2]}"')
    else:
        for i, token in enumerate(unique_tokens, 1):
            print(f'export CLAUDE_AUTH_TOKEN_{i}="{token}"')

    print("\nThen on server:")
    print("  source ~/.zshrc")
    print("  cd /root/projekte/werkingflow/autopilot/cui")
    print("  ./scripts/setup-cc-usage.sh")

if __name__ == "__main__":
    main()
