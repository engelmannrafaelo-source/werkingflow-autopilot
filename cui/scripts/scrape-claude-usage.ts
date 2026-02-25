#!/usr/bin/env npx tsx
/**
 * Scrape Claude.ai Usage Data
 *
 * Navigates via homepage first to bypass Cloudflare, then extracts
 * usage limits from claude.ai/settings/usage for all accounts.
 *
 * Usage:
 *   npx tsx scripts/scrape-claude-usage.ts
 *   npx tsx scripts/scrape-claude-usage.ts --account rafael
 */

import { chromium } from "playwright";
import { writeFileSync, existsSync } from "fs";
import { join } from "path";

const STORAGE_DIR = "/root/projekte/local-storage/backends/cui/playwright-sessions";
const ACCOUNTS = ["rafael", "office", "engelmann"];

interface UsageData {
  account: string;
  timestamp: string;
  plan: string;
  currentSession: { percent: number; resetIn: string };
  weeklyAllModels: { percent: number; resetDate: string };
  weeklySonnet: { percent: number; resetDate: string };
  extraUsage: { percent: number; spent: string; limit: string; balance: string };
}

function parseUsagePage(bodyText: string): Omit<UsageData, "account" | "timestamp"> {
  const lines = bodyText.split("\n").map(l => l.trim()).filter(Boolean);

  // Detect plan
  let plan = "unknown";
  for (const l of lines) {
    if (/max\s*plan/i.test(l)) { plan = "Max"; break; }
    if (/pro\s*plan/i.test(l)) { plan = "Pro"; break; }
    if (/free\s*plan/i.test(l)) { plan = "Free"; break; }
    if (/team\s*plan/i.test(l)) { plan = "Team"; break; }
  }

  // Collect ALL percentages in page order
  const allPcts: { percent: number; lineIdx: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/(\d+)\s*%/);
    if (m) allPcts.push({ percent: parseInt(m[1], 10), lineIdx: i });
  }

  // Find reset text near a line
  function findResetNear(lineIdx: number): string {
    for (let i = Math.max(0, lineIdx - 3); i < Math.min(lines.length, lineIdx + 2); i++) {
      const l = lines[i].toLowerCase();
      if (l.includes("reset") || l.includes("zur\u00fccksetzung")) return lines[i];
    }
    return "";
  }

  // Map labels to the NEXT percentage AFTER each label (prevents cross-matching)
  let sessionPct: typeof allPcts[0] | null = null;
  let allModelsPct: typeof allPcts[0] | null = null;
  let sonnetPct: typeof allPcts[0] | null = null;
  let extraPct: typeof allPcts[0] | null = null;
  const used = new Set<number>();

  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();
    if ((lower.includes("current session") || lower.includes("aktuelle sitzung")) && !sessionPct) {
      const p = allPcts.find(p => p.lineIdx > i && !used.has(p.lineIdx));
      if (p) { sessionPct = p; used.add(p.lineIdx); }
    }
    if ((lower.includes("all models") || lower.includes("alle modelle")) && !allModelsPct) {
      const p = allPcts.find(p => p.lineIdx > i && !used.has(p.lineIdx));
      if (p) { allModelsPct = p; used.add(p.lineIdx); }
    }
    if ((lower.includes("sonnet only") || lower.includes("nur sonnet")) && !sonnetPct) {
      const p = allPcts.find(p => p.lineIdx > i && !used.has(p.lineIdx));
      if (p) { sonnetPct = p; used.add(p.lineIdx); }
    }
    if ((lower.includes("spent") || lower.includes("ausgegeben")) && !extraPct) {
      const p = allPcts.find(p => Math.abs(p.lineIdx - i) <= 2 && !used.has(p.lineIdx));
      if (p) { extraPct = p; used.add(p.lineIdx); }
    }
  }

  // Extract financial details
  let extraSpent = "";
  let extraLimit = "";
  let extraBalance = "";
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const spentMatch = l.match(/[\u20ac$]?\s*([\d,.]+)\s*[\u20ac$]?\s*(spent|ausgegeben)/i);
    if (spentMatch) extraSpent = spentMatch[1].replace(",", ".") + " EUR";
    if (i + 1 < lines.length) {
      const nextLower = lines[i + 1].toLowerCase();
      if (nextLower.includes("monthly") || nextLower.includes("monatlich")) {
        const m = l.match(/[\u20ac$]?\s*([\d,.]+)\s*[\u20ac$]?/);
        if (m) extraLimit = m[1].replace(",", ".") + " EUR";
      }
      if (nextLower.includes("balance") || nextLower.includes("guthaben")) {
        const m = l.match(/[\u20ac$]?\s*([\d,.]+)\s*[\u20ac$]?/);
        if (m) extraBalance = m[1].replace(",", ".") + " EUR";
      }
    }
  }

  return {
    plan,
    currentSession: { percent: sessionPct?.percent ?? 0, resetIn: sessionPct ? findResetNear(sessionPct.lineIdx) : "" },
    weeklyAllModels: { percent: allModelsPct?.percent ?? 0, resetDate: allModelsPct ? findResetNear(allModelsPct.lineIdx) : "" },
    weeklySonnet: { percent: sonnetPct?.percent ?? 0, resetDate: sonnetPct ? findResetNear(sonnetPct.lineIdx) : "" },
    extraUsage: { percent: extraPct?.percent ?? 0, spent: extraSpent, limit: extraLimit, balance: extraBalance },
  };
}

async function scrapeAccount(accountName: string): Promise<UsageData | null> {
  const storagePath = join(STORAGE_DIR, `${accountName}.json`);
  if (!existsSync(storagePath)) {
    console.error(`[${accountName}] No session state found at ${storagePath}`);
    return null;
  }

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-blink-features=AutomationControlled", "--disable-gpu"],
  });

  try {
    const ctx = await browser.newContext({
      storageState: storagePath,
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      viewport: { width: 1920, height: 1080 },
    });
    const page = await ctx.newPage();

    // Step 1: Homepage first (bypasses Cloudflare)
    console.log(`[${accountName}] Step 1: Homepage...`);
    await page.goto("https://claude.ai", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(5000);

    const homeText = await page.textContent("body") || "";
    if (homeText.includes("security verification")) {
      console.log(`[${accountName}] Cloudflare detected, waiting...`);
      await page.waitForTimeout(10000);
    }
    if (page.url().includes("/login")) {
      throw new Error("Session expired - redirected to login");
    }

    // Step 2: Settings/Usage
    console.log(`[${accountName}] Step 2: Settings/Usage...`);
    await page.goto("https://claude.ai/settings/usage", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(8000);

    const usageUrl = page.url();
    if (!usageUrl.includes("settings")) {
      throw new Error(`Unexpected redirect to: ${usageUrl}`);
    }

    await page.screenshot({ path: `/tmp/cc-usage-${accountName}.png`, fullPage: true });

    const bodyText = await page.evaluate(() => document.body.innerText);
    const parsed = parseUsagePage(bodyText);

    const result: UsageData = { account: accountName, timestamp: new Date().toISOString(), ...parsed };
    console.log(`[${accountName}] ${result.plan} | Session:${result.currentSession.percent}% | All:${result.weeklyAllModels.percent}% | Sonnet:${result.weeklySonnet.percent}% | Extra:${result.extraUsage.percent}%`);

    await browser.close();
    return result;
  } catch (err: any) {
    console.error(`[${accountName}] FAILED: ${err.message}`);
    await browser.close();
    return null;
  }
}

async function main() {
  const accIdx = process.argv.indexOf("--account");
  const specific = accIdx >= 0 ? process.argv[accIdx + 1] : null;
  const toScrape = specific ? [specific] : ACCOUNTS;

  console.log(`\n=== Claude Usage Scraper (${new Date().toISOString()}) ===\n`);

  const results: UsageData[] = [];
  for (const acc of toScrape) {
    const data = await scrapeAccount(acc);
    if (data) results.push(data);
  }

  const outputPath = join(process.cwd(), "claude-usage-scraped.json");
  writeFileSync(outputPath, JSON.stringify(results, null, 2), "utf-8");
  console.log(`\nSaved ${results.length}/${toScrape.length} accounts to ${outputPath}`);

  console.log("\n--- USAGE SUMMARY ---");
  for (const r of results) {
    console.log(`\n${r.account.toUpperCase()} (${r.plan}):`);
    console.log(`  Session:       ${r.currentSession.percent}%  ${r.currentSession.resetIn}`);
    console.log(`  Weekly All:    ${r.weeklyAllModels.percent}%  ${r.weeklyAllModels.resetDate}`);
    console.log(`  Weekly Sonnet: ${r.weeklySonnet.percent}%  ${r.weeklySonnet.resetDate}`);
    console.log(`  Extra Usage:   ${r.extraUsage.percent}%  (${r.extraUsage.spent} / ${r.extraUsage.limit})`);
  }

  return results.length > 0 ? 0 : 1;
}

main().then(code => process.exit(code)).catch(err => { console.error("Fatal:", err); process.exit(1); });
