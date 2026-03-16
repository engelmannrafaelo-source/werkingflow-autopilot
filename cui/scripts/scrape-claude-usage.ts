#!/usr/bin/env npx tsx
/**
 * Scrape Claude.ai Usage Data — JSON API Edition (v3)
 *
 * Uses curl-impersonate (Chrome TLS fingerprint) to bypass Cloudflare,
 * then calls claude.ai JSON API endpoints for usage data.
 * NO HTML parsing, NO Playwright dependency.
 *
 * API Flow:
 *   1. GET /api/organizations → org UUID + plan info
 *   2. GET /api/organizations/{uuid}/usage → structured usage JSON
 *
 * Session keys from:
 *   - Env vars: CLAUDE_SESSION_RAFAEL, CLAUDE_SESSION_OFFICE, CLAUDE_SESSION_ENGELMANN
 *   - Playwright session files: /root/projekte/local-storage/backends/cui/playwright-sessions/{account}.json
 *
 * Usage:
 *   npx tsx scripts/scrape-claude-usage.ts
 *   npx tsx scripts/scrape-claude-usage.ts --account rafael
 */

import { execSync } from "child_process";
import { writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";

const CURL_BIN = "/usr/local/bin/curl_chrome116";
const CURL_LIB = "/tmp";
const STORAGE_DIR = "/root/projekte/local-storage/backends/cui/playwright-sessions";

const ACCOUNTS: { id: string; displayName: string; envVar: string }[] = [
  { id: "rafael", displayName: "Gmail", envVar: "CLAUDE_SESSION_RAFAEL" },
  { id: "office", displayName: "Office", envVar: "CLAUDE_SESSION_OFFICE" },
  { id: "engelmann", displayName: "Engelmann", envVar: "CLAUDE_SESSION_ENGELMANN" },
];

// ── Output interface (backward-compatible with bridge.ts consumer) ──

interface UsageData {
  account: string;
  timestamp: string;
  plan: string;
  currentSession: { percent: number; resetIn: string };
  weeklyAllModels: { percent: number; resetDate: string };
  weeklySonnet: { percent: number; resetDate: string };
  extraUsage: { percent: number; spent: string; limit: string; balance: string };
  scrapeError?: string;
}

// ── API response types ──

interface OrgResponse {
  uuid: string;
  name: string;
  capabilities: string[];
  rate_limit_tier: string;
  billing_type: string;
}

interface UsageBucket {
  utilization: number;
  resets_at: string;
}

interface ExtraUsageResponse {
  is_enabled: boolean;
  monthly_limit: number;
  used_credits: number;
  utilization: number | null;
}

interface UsageResponse {
  five_hour: UsageBucket | null;
  seven_day: UsageBucket | null;
  seven_day_sonnet: UsageBucket | null;
  seven_day_opus: UsageBucket | null;
  seven_day_oauth_apps: UsageBucket | null;
  seven_day_cowork: UsageBucket | null;
  iguana_necktie: UsageBucket | null;
  extra_usage: ExtraUsageResponse | null;
}

// ── Helpers ──

function getSessionKey(accountId: string, envVar: string): string | null {
  const envKey = process.env[envVar];
  if (envKey && envKey.startsWith("sk-ant-")) return envKey;

  const sessionFile = join(STORAGE_DIR, `${accountId}.json`);
  if (existsSync(sessionFile)) {
    try {
      const data = JSON.parse(readFileSync(sessionFile, "utf-8"));
      const cookie = data.cookies?.find((c: any) => c.name === "sessionKey");
      if (cookie?.value?.startsWith("sk-ant-")) return cookie.value;
    } catch { /* corrupt file */ }
  }

  return null;
}

function curlFetch(url: string, sessionKey: string, timeout = 15): { status: number; body: string } {
  try {
    const result = execSync(
      `LD_LIBRARY_PATH=${CURL_LIB}:$LD_LIBRARY_PATH ${CURL_BIN} -s -w "\\n__HTTP_CODE__%{http_code}" --max-time ${timeout} "${url}" -H "Cookie: sessionKey=${sessionKey}" -H "Accept: application/json" -H "Referer: https://claude.ai/settings/usage"`,
      { encoding: "utf-8", timeout: (timeout + 5) * 1000 }
    );
    const lines = result.split("__HTTP_CODE__");
    const body = lines[0].trim();
    const status = parseInt(lines[1]?.trim() || "0", 10);
    return { status, body };
  } catch (err: any) {
    return { status: 0, body: err.message || "curl failed" };
  }
}

function isCloudflareBlocked(body: string): boolean {
  const lower = body.toLowerCase();
  return lower.includes("security verification") || lower.includes("cf_chl_opt") || lower.includes("just a moment");
}

/** Derive plan name from org capabilities and rate_limit_tier */
function derivePlan(org: OrgResponse): string {
  if (org.capabilities.includes("claude_max")) return "Max";
  if (org.rate_limit_tier?.includes("max")) return "Max";
  if (org.rate_limit_tier?.includes("pro")) return "Pro";
  if (org.capabilities.includes("chat")) return "Pro"; // chat-only without max = Pro
  if (org.billing_type === "free") return "Free";
  return "Pro"; // default assumption for paid subscriptions
}

/** Format reset time as human-readable relative string */
function formatResetTime(isoDate: string): string {
  if (!isoDate) return "";
  try {
    const resetMs = new Date(isoDate).getTime();
    const nowMs = Date.now();
    const diffMs = resetMs - nowMs;
    if (diffMs <= 0) return "resetting now";
    const hours = Math.floor(diffMs / 3600_000);
    const minutes = Math.floor((diffMs % 3600_000) / 60_000);
    if (hours > 24) {
      const days = Math.floor(hours / 24);
      const remHours = hours % 24;
      return `resets in ${days}d ${remHours}h`;
    }
    return `resets in ${hours}h ${minutes}m`;
  } catch {
    return isoDate;
  }
}

/** Convert cents to EUR string */
function centsToEur(cents: number): string {
  return (cents / 100).toFixed(2) + " EUR";
}

// ── Main scrape logic ──

async function scrapeAccount(accountId: string, envVar: string): Promise<UsageData | null> {
  const sessionKey = getSessionKey(accountId, envVar);
  if (!sessionKey) {
    console.error(`[${accountId}] No sessionKey found. Set ${envVar} or store in Playwright session file.`);
    return null;
  }

  console.log(`[${accountId}] Using sessionKey: ${sessionKey.substring(0, 25)}...`);

  // Step 1: Get organization UUID and plan info
  console.log(`[${accountId}] Fetching /api/organizations...`);
  const orgRes = curlFetch("https://claude.ai/api/organizations", sessionKey);

  if (orgRes.status === 0) {
    console.error(`[${accountId}] FAILED: Network error — ${orgRes.body.substring(0, 100)}`);
    return null;
  }

  if (isCloudflareBlocked(orgRes.body)) {
    console.error(`[${accountId}] FAILED: Cloudflare blocking curl-impersonate`);
    return null;
  }

  if (orgRes.status === 403) {
    let errorCode = "";
    try { errorCode = JSON.parse(orgRes.body)?.error?.details?.error_code ?? ""; } catch { /* not JSON */ }
    if (errorCode === "account_session_invalid") {
      console.error(`[${accountId}] FAILED: sessionKey expired. Refresh with: export ${envVar}="new-key-here"`);
    } else {
      console.error(`[${accountId}] FAILED: 403 Forbidden — ${orgRes.body.substring(0, 150)}`);
    }
    return null;
  }

  if (orgRes.status !== 200) {
    console.error(`[${accountId}] FAILED: HTTP ${orgRes.status} from /api/organizations`);
    return null;
  }

  let orgs: OrgResponse[];
  try {
    orgs = JSON.parse(orgRes.body);
  } catch {
    console.error(`[${accountId}] FAILED: Invalid JSON from /api/organizations`);
    return null;
  }

  if (!Array.isArray(orgs) || orgs.length === 0) {
    console.error(`[${accountId}] FAILED: No organizations found`);
    return null;
  }

  // Use the first org with chat capability (skip API-only orgs)
  const chatOrg = orgs.find(o => o.capabilities?.includes("chat")) ?? orgs[0];
  const plan = derivePlan(chatOrg);
  console.log(`[${accountId}] Org: "${chatOrg.name}" | Plan: ${plan} | Tier: ${chatOrg.rate_limit_tier}`);

  // Step 2: Get usage data
  console.log(`[${accountId}] Fetching /api/organizations/${chatOrg.uuid}/usage...`);
  const usageRes = curlFetch(`https://claude.ai/api/organizations/${chatOrg.uuid}/usage`, sessionKey);

  if (usageRes.status !== 200) {
    console.error(`[${accountId}] FAILED: HTTP ${usageRes.status} from usage endpoint`);
    return null;
  }

  let usage: UsageResponse;
  try {
    usage = JSON.parse(usageRes.body);
  } catch {
    console.error(`[${accountId}] FAILED: Invalid JSON from usage endpoint`);
    return null;
  }

  // Step 3: Map API response to backward-compatible UsageData

  const fiveHour = usage.five_hour;
  const sevenDay = usage.seven_day;
  const sevenDaySonnet = usage.seven_day_sonnet;
  const extra = usage.extra_usage;

  const extraSpent = extra ? centsToEur(extra.used_credits) : "";
  const extraLimit = extra ? centsToEur(extra.monthly_limit) : "";
  const extraBalance = extra ? centsToEur(extra.monthly_limit - extra.used_credits) : "";
  const extraPercent = extra?.utilization ?? (extra && extra.monthly_limit > 0
    ? Math.round((extra.used_credits / extra.monthly_limit) * 100)
    : 0);

  const result: UsageData = {
    account: accountId,
    timestamp: new Date().toISOString(),
    plan,
    currentSession: {
      percent: fiveHour?.utilization ?? 0,
      resetIn: fiveHour?.resets_at ? formatResetTime(fiveHour.resets_at) : "",
    },
    weeklyAllModels: {
      percent: sevenDay?.utilization ?? 0,
      resetDate: sevenDay?.resets_at ? formatResetTime(sevenDay.resets_at) : "",
    },
    weeklySonnet: {
      percent: sevenDaySonnet?.utilization ?? 0,
      resetDate: sevenDaySonnet?.resets_at ? formatResetTime(sevenDaySonnet.resets_at) : "",
    },
    extraUsage: {
      percent: extraPercent,
      spent: extraSpent,
      limit: extraLimit,
      balance: extraBalance,
    },
  };

  console.log(`[${accountId}] ${result.plan} | Session:${result.currentSession.percent}% | All:${result.weeklyAllModels.percent}% | Sonnet:${result.weeklySonnet.percent}% | Extra:${result.extraUsage.percent}%`);
  return result;
}

async function main() {
  // Verify curl-impersonate is available
  if (!existsSync(CURL_BIN)) {
    console.error(`curl-impersonate not found at ${CURL_BIN}!`);
    console.error("Install with:");
    console.error("  cd /tmp && curl -sLO https://github.com/lwthiker/curl-impersonate/releases/download/v0.6.1/curl-impersonate-v0.6.1.x86_64-linux-gnu.tar.gz");
    console.error("  tar xzf curl-impersonate-v0.6.1.x86_64-linux-gnu.tar.gz && cp curl_chrome116 /usr/local/bin/");
    process.exit(1);
  }

  const accIdx = process.argv.indexOf("--account");
  const specific = accIdx >= 0 ? process.argv[accIdx + 1] : null;
  const toScrape = specific ? ACCOUNTS.filter(a => a.id === specific) : ACCOUNTS;

  if (toScrape.length === 0) {
    console.error(`Unknown account: ${specific}`);
    process.exit(1);
  }

  console.log(`\n=== Claude Usage Scraper v3 — JSON API (${new Date().toISOString()}) ===\n`);

  const results: UsageData[] = [];
  const failures: string[] = [];

  for (const acc of toScrape) {
    const data = await scrapeAccount(acc.id, acc.envVar);
    if (data) {
      results.push(data);
    } else {
      failures.push(acc.id);
    }
  }

  const outputPath = join(process.cwd(), "claude-usage-scraped.json");

  if (results.length === 0) {
    console.error(`\nALL ${toScrape.length} accounts failed! NOT overwriting previous scraped data.`);
    console.error("\nTo fix: get fresh sessionKeys from claude.ai browser cookies:");
    console.error("  1. Open claude.ai in Chrome > DevTools (F12) > Application > Cookies");
    console.error("  2. Copy 'sessionKey' value (starts with sk-ant-sid01-...)");
    console.error("  3. Store in Playwright session file or set env var");

    // Mark previous data with error
    if (existsSync(outputPath)) {
      try {
        const prev: UsageData[] = JSON.parse(readFileSync(outputPath, "utf-8"));
        for (const entry of prev) {
          entry.scrapeError = `Scrape failed at ${new Date().toISOString()} — all sessions expired or blocked`;
        }
        writeFileSync(outputPath, JSON.stringify(prev, null, 2), "utf-8");
      } catch { /* keep as-is */ }
    }
    return 1;
  }

  // Merge failed accounts with previous data (keep stale data rather than dropping)
  if (failures.length > 0 && existsSync(outputPath)) {
    try {
      const prev: UsageData[] = JSON.parse(readFileSync(outputPath, "utf-8"));
      for (const failedId of failures) {
        const prevEntry = prev.find(p => p.account === failedId);
        if (prevEntry) {
          prevEntry.scrapeError = `Scrape failed at ${new Date().toISOString()} — session expired`;
          results.push(prevEntry);
        }
      }
    } catch { /* no previous data */ }
  }

  writeFileSync(outputPath, JSON.stringify(results, null, 2), "utf-8");
  console.log(`\nSaved ${results.length}/${toScrape.length} accounts to ${outputPath}`);

  console.log("\n--- USAGE SUMMARY ---");
  for (const r of results) {
    const tag = r.scrapeError ? " [STALE]" : "";
    console.log(`\n${r.account.toUpperCase()} (${r.plan})${tag}:`);
    console.log(`  Session (5h):  ${r.currentSession.percent}%  ${r.currentSession.resetIn}`);
    console.log(`  Weekly All:    ${r.weeklyAllModels.percent}%  ${r.weeklyAllModels.resetDate}`);
    console.log(`  Weekly Sonnet: ${r.weeklySonnet.percent}%  ${r.weeklySonnet.resetDate}`);
    console.log(`  Extra Usage:   ${r.extraUsage.percent}%  (${r.extraUsage.spent} / ${r.extraUsage.limit})`);
    if (r.scrapeError) console.log(`  WARNING: ${r.scrapeError}`);
  }

  return failures.length === 0 ? 0 : 1;
}

main().then(code => process.exit(code)).catch(err => { console.error("Fatal:", err); process.exit(1); });
