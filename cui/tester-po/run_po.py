"""
PO-Test Runner — single-shot mental-model evaluation.

Reads /scenario/scenario.json, navigates to target_url, captures
page-text + screenshot, sends scenario+observation to AI bridge for
pass/fail verdict, writes immutable result to /report/.

Output:
  /report/result.json        verdict + summary + duration + status
  /report/page-text.txt      what the tester "saw"
  /report/screenshot.png     visual evidence
  /report/bridge-prompt.txt  prompt sent to bridge (for audit)
  /report/bridge-response.txt raw bridge response

Exits 0 on completed run (regardless of pass/fail), 2 on infrastructure
error (bridge down, browser crash, etc).
"""
import json
import os
import sys
import time
from pathlib import Path

import requests
from playwright.sync_api import sync_playwright


SCENARIO_PATH = Path("/scenario/scenario.json")
REPORT_DIR = Path("/report")

BRIDGE_URL = os.environ.get("AI_BRIDGE_URL", "").rstrip("/")
BRIDGE_KEY = os.environ.get("AI_BRIDGE_API_KEY", "")
BRIDGE_MODEL = os.environ.get("BRIDGE_MODEL", "claude-sonnet-4-6")

# Seconds. Soft caps inside the runner; the host enforces a hard SIGKILL too.
PAGE_LOAD_TIMEOUT = 30
BRIDGE_TIMEOUT = 600


def fail_infra(message: str, exc: Exception | None = None) -> None:
    """Infrastructure failure — write minimal result + exit 2."""
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    (REPORT_DIR / "result.json").write_text(json.dumps({
        "status": "infra-error",
        "verdict": "error",
        "summary": message,
        "error": str(exc) if exc else None,
    }, indent=2))
    print(f"[run_po] INFRA: {message}", file=sys.stderr)
    if exc:
        print(f"[run_po] {exc}", file=sys.stderr)
    sys.exit(2)


def load_scenario() -> dict:
    if not SCENARIO_PATH.exists():
        fail_infra(f"Scenario not found at {SCENARIO_PATH}")
    try:
        return json.loads(SCENARIO_PATH.read_text())
    except json.JSONDecodeError as e:
        fail_infra("Scenario JSON malformed", e)
        return {}  # unreachable, satisfies type checker


def capture_page(target_url: str) -> tuple[str, bytes, str]:
    """Returns (page_text, screenshot_png_bytes, final_url)."""
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        try:
            context = browser.new_context(
                viewport={"width": 1280, "height": 800},
                ignore_https_errors=True,
            )
            page = context.new_page()
            page.goto(target_url, timeout=PAGE_LOAD_TIMEOUT * 1000, wait_until="networkidle")
            text = page.evaluate("() => document.body ? document.body.innerText : ''")
            screenshot = page.screenshot(full_page=True, type="png")
            final_url = page.url
            return (text or ""), screenshot, final_url
        finally:
            browser.close()


def build_prompt(scenario: dict, page_text: str, final_url: str) -> str:
    tester = scenario.get("tester") or {}
    perspektive = tester.get("perspektive", "Endnutzer")
    erfahrung = tester.get("erfahrung", "normal")
    auftrag = scenario.get("auftrag", "")
    ziele = scenario.get("ziele") or []
    qualitaetsfrage = scenario.get("qualitaetsfrage", "")

    ziele_block = "\n".join(f"  - {z}" for z in ziele) if ziele else "  (keine expliziten Ziele)"

    truncated = page_text[:8000]
    if len(page_text) > 8000:
        truncated += f"\n... [{len(page_text) - 8000} Zeichen abgeschnitten]"

    return f"""Du bist ein Tester der eine Webseite aus einer bestimmten Perspektive bewertet.

# Deine Rolle
- Perspektive: {perspektive}
- Erfahrungslevel: {erfahrung}

# Auftrag
{auftrag}

# Ziele (was bei erfolgreichem Test erreicht sein muss)
{ziele_block}

# Qualitätsfrage (musst du am Ende beantworten)
{qualitaetsfrage}

# Was du gesehen hast
URL nach Navigation: {final_url}

Sichtbarer Seiteninhalt (innerText des Body):
```
{truncated}
```

# Deine Aufgabe
Beurteile aus der Tester-Perspektive:
1. Ist der Auftrag in dieser Form überhaupt prüfbar mit dem was du gesehen hast?
2. Welche Ziele sind sichtbar erreicht / nicht erreicht / unklar?
3. Pass / Fail / Unclear für die Qualitätsfrage.

Antworte AUSSCHLIESSLICH als JSON, kein Markdown drumherum, keine Erklärung davor:

```json
{{
  "verdict": "pass" | "fail" | "unclear",
  "summary": "max 3 Sätze deutsche Zusammenfassung der Bewertung",
  "ziele_status": [
    {{"ziel": "...", "status": "erreicht" | "nicht-erreicht" | "unklar", "begruendung": "..."}}
  ],
  "qualitaetsfrage_antwort": "..."
}}
```
"""


def call_bridge(prompt: str) -> tuple[str, dict]:
    """Returns (raw_text, parsed_verdict_dict_or_empty)."""
    if not BRIDGE_URL or not BRIDGE_KEY:
        fail_infra("AI_BRIDGE_URL or AI_BRIDGE_API_KEY missing in env")

    try:
        resp = requests.post(
            f"{BRIDGE_URL}/v1/research",
            headers={
                "Authorization": f"Bearer {BRIDGE_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "query": prompt,
                "model": BRIDGE_MODEL,
                "depth": "quick",
                "strategy": "planning",
                "max_turns": 5,
            },
            timeout=BRIDGE_TIMEOUT,
        )
    except requests.RequestException as e:
        fail_infra("Bridge request failed", e)
        return "", {}  # unreachable

    if not resp.ok:
        fail_infra(f"Bridge returned HTTP {resp.status_code}: {resp.text[:500]}")

    data = resp.json()
    raw = data.get("content") or data.get("output") or ""
    if not raw:
        fail_infra(f"Bridge response had no content field. Keys: {list(data.keys())}")

    # Try to extract JSON from response
    parsed = {}
    try:
        # Look for ```json ... ``` first
        if "```json" in raw:
            block = raw.split("```json", 1)[1].split("```", 1)[0]
            parsed = json.loads(block.strip())
        elif "```" in raw:
            block = raw.split("```", 1)[1].split("```", 1)[0]
            parsed = json.loads(block.strip())
        else:
            # Try to find a JSON object in the raw text
            start = raw.find("{")
            end = raw.rfind("}")
            if start >= 0 and end > start:
                parsed = json.loads(raw[start:end + 1])
    except (json.JSONDecodeError, IndexError):
        # Bridge didn't return parseable JSON — that's a "fail" verdict with reason
        parsed = {
            "verdict": "unclear",
            "summary": "Bridge-Antwort konnte nicht als JSON geparst werden",
            "ziele_status": [],
        }

    return raw, parsed


def main() -> None:
    REPORT_DIR.mkdir(parents=True, exist_ok=True)

    scenario = load_scenario()
    target_url = scenario.get("target_url", "").strip()
    if not target_url:
        fail_infra("scenario.target_url missing or empty")

    print(f"[run_po] scenario={scenario.get('id', '?')} target={target_url}")

    started = time.time()

    # Capture phase
    try:
        page_text, screenshot_bytes, final_url = capture_page(target_url)
    except Exception as e:
        fail_infra(f"Browser capture failed for {target_url}", e)
        return  # unreachable

    capture_duration = time.time() - started
    print(f"[run_po] captured page in {capture_duration:.1f}s ({len(page_text)} chars)")

    (REPORT_DIR / "page-text.txt").write_text(page_text or "")
    (REPORT_DIR / "screenshot.png").write_bytes(screenshot_bytes)

    # Judge phase
    prompt = build_prompt(scenario, page_text, final_url)
    (REPORT_DIR / "bridge-prompt.txt").write_text(prompt)

    bridge_started = time.time()
    raw, parsed = call_bridge(prompt)
    bridge_duration = time.time() - bridge_started

    (REPORT_DIR / "bridge-response.txt").write_text(raw)

    total_duration = time.time() - started
    print(f"[run_po] bridge call took {bridge_duration:.1f}s, total {total_duration:.1f}s")

    result = {
        "status": "completed",
        "verdict": parsed.get("verdict", "unclear"),
        "summary": parsed.get("summary", "(keine Zusammenfassung von Bridge)"),
        "ziele_status": parsed.get("ziele_status", []),
        "qualitaetsfrage_antwort": parsed.get("qualitaetsfrage_antwort", ""),
        "scenario_id": scenario.get("id"),
        "target_url": target_url,
        "final_url": final_url,
        "duration_seconds": round(total_duration, 1),
        "capture_duration_seconds": round(capture_duration, 1),
        "bridge_duration_seconds": round(bridge_duration, 1),
        "model": BRIDGE_MODEL,
    }

    (REPORT_DIR / "result.json").write_text(json.dumps(result, indent=2, ensure_ascii=False))
    print(f"[run_po] verdict={result['verdict']} summary={result['summary'][:120]}")


if __name__ == "__main__":
    main()
