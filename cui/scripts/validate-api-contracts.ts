#!/usr/bin/env npx tsx
/**
 * Static Analysis: API Contract Validator
 *
 * Cross-references frontend validateApiResponse() schemas against
 * server route res.json() shapes to detect mismatches without a running server.
 *
 * Usage: npx tsx scripts/validate-api-contracts.ts
 * Exit code: 0 = all pass, 1 = mismatches found
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative, basename } from "path";

const PROJECT_ROOT = join(import.meta.dirname, "..");
const SRC_DIR = join(PROJECT_ROOT, "src");
const ROUTES_DIR = join(PROJECT_ROOT, "server", "routes");
const SERVER_DIR = join(PROJECT_ROOT, "server");

// Types
interface SchemaField { type: string; optional: boolean; }
interface FrontendValidation {
  file: string; line: number; endpoint: string;
  schema: Record<string, SchemaField>;
  isArrayItem: boolean; isSubObject: boolean;
  rawEndpoint: string; isDynamic: boolean;
}
interface ServerRoute {
  file: string; line: number; method: string;
  path: string; fullPath: string;
  responseFields: string[]; rawResponse: string; isProxy: boolean;
  hasSpread: boolean;
}
interface MatchResult {
  frontend: FrontendValidation;
  serverRoute: ServerRoute | null;
  status: "PASS" | "FAIL" | "SKIP";
  issues: string[];
}

// Route prefix mapping from server/index.ts
const ROUTE_PREFIXES: Record<string, string> = {
  "layouts.ts": "/api", "files.ts": "", "mission.ts": "/api/mission",
  "screenshots.ts": "/api", "templates.ts": "/api/prompt-templates",
  "autoinject.ts": "", "agents.ts": "", "bridge.ts": "", "qa.ts": "",
  "repo-dashboard.ts": "/api/repo-dashboard", "maintenance.ts": "/api/maintenance",
  "audit.ts": "/api/audit", "infrastructure.ts": "", "team.ts": "/api/team",
  "admin.ts": "/api", "control.ts": "/api", "infisical-routes.ts": "/api/infisical",
  "peer-awareness.ts": "", "background-ops.ts": "", "synchronise.ts": "",
  "prompt-explorer.ts": "/api/prompt-explorer", "partner-tasks.ts": "/api/partner",
  "partner-activity.ts": "/api/partner", "partner-docs.ts": "/api/partner",
  "partner-messages.ts": "", "partner-feedback.ts": "/api/partner",
  "partner-team-status.ts": "/api/partner", "report-builder.ts": "/api/report-builder",
  "business-angel.ts": "/api/business-angel", "architecture.ts": "/api/architecture",
  "architecture-status.ts": "/api/architecture/status", "state.ts": "", "app-proxy.ts": "",
  "knowledge-registry.ts": "/api/team/knowledge",
};

// Bridge proxy endpoints - response shape comes from external AI Bridge API
const BRIDGE_PROXY_ENDPOINTS = new Set([
  "/api/bridge/metrics/usage", "/api/bridge/metrics/cost",
  "/api/bridge/metrics/limits", "/api/bridge/metrics/activity",
  "/api/bridge/metrics/persistent", "/api/bridge/metrics/apps",
  "/api/bridge/metrics/prompt-performance",
  "/api/bridge/metrics/prompt-performance/timeline",
]);

// Known false positives: validation label endpoints that don't match route paths
// because the validation label is a simplified version of the actual fetch URL
const KNOWN_LABEL_MISMATCHES: Record<string, string> = {
  // Frontend uses /api/mission/conversation/${conv.sessionId} as label but
  // fetches /api/mission/conversation/${conv.accountId}/${conv.sessionId} (2 params)
  "/api/mission/conversation/:param": "Label has fewer params than actual fetch URL",
  // Frontend uses PATCH /api/partner/feedback/status as label but
  // fetches /api/partner/feedback/${id}/status (with :id param)
  "PATCH /api/partner/feedback/status": "Label missing :id param segment",
};

function collectFiles(dir: string, exts: string[]): string[] {
  const r: string[] = [];
  (function w(d: string) {
    try {
      for (const e of readdirSync(d)) {
        const f = join(d, e);
        try {
          if (statSync(f).isDirectory()) w(f);
          else if (exts.some(x => f.endsWith(x))) r.push(f);
        } catch {}
      }
    } catch {}
  })(dir);
  return r;
}

function relPath(p: string): string { return relative(PROJECT_ROOT, p); }

function extractBraceContent(content: string, startIdx: number): string | null {
  let depth = 0, result = "", started = false;
  for (let i = startIdx; i < content.length && i < startIdx + 3000; i++) {
    const ch = content[i];
    if (ch === "{") { depth++; if (depth === 1) { started = true; continue; } }
    if (ch === "}") { depth--; if (depth === 0 && started) return result; }
    if (started) result += ch;
  }
  return null;
}

// ===================== Frontend Extraction =====================

function extractFrontendValidations(): FrontendValidation[] {
  const results: FrontendValidation[] = [];
  for (const file of collectFiles(SRC_DIR, [".ts", ".tsx"])) {
    if (file.endsWith("validateApiResponse.ts")) continue;
    const content = readFileSync(file, "utf8");
    const re = /validateApiResponse\s*<[^>]*>\s*\(\s*[^,]+\s*,\s*/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const pos = m.index + m[0].length;
      const rest = content.substring(pos);
      let rawEndpoint = "", isDynamic = false, epLen = 0;
      if (rest[0] === "'" || rest[0] === '"') {
        const q = rest[0], end = rest.indexOf(q, 1);
        if (end < 0) continue;
        rawEndpoint = rest.substring(1, end); epLen = end + 1;
      } else if (rest[0] === "`") {
        const end = rest.indexOf("`", 1);
        if (end < 0) continue;
        rawEndpoint = rest.substring(1, end); isDynamic = true; epLen = end + 1;
      } else {
        const vm = rest.match(/^([\w.]+)/);
        if (!vm) continue;
        rawEndpoint = vm[1]; isDynamic = true; epLen = vm[0].length;
      }
      const afterEp = rest.substring(epLen);
      const ci = afterEp.indexOf(",");
      if (ci < 0) continue;
      const bi = afterEp.indexOf("{", ci);
      if (bi < 0) continue;
      const schemaAbsIdx = pos + epLen + bi;
      const schemaStr = extractBraceContent(content, schemaAbsIdx);
      if (!schemaStr) continue;
      const schema = parseSchemaString(schemaStr);
      const lineNum = content.substring(0, m.index).split("\n").length;
      const isArrayItem = rawEndpoint.includes("[${") || rawEndpoint.includes("[i]") || /\[\d+\]/.test(rawEndpoint) || rawEndpoint.includes("[item]");
      const isSubObject = rawEndpoint.includes(" .");
      results.push({
        file: relPath(file), line: lineNum,
        endpoint: normalizeEndpoint(rawEndpoint),
        schema, isArrayItem, isSubObject, rawEndpoint, isDynamic,
      });
    }
  }
  return results;
}

function normalizeEndpoint(ep: string): string {
  // Remove array indices like [${i}], [0], [item]
  let r = ep.replace(/\[(?:\$\{[^}]+\}|[^\]]+)\]/g, "");
  // Replace template params like ${id} with :param
  r = r.replace(/\$\{[^}]+\}/g, ":param");
  // Remove .overall suffix
  r = r.replace(/\s+\.overall$/, "");
  return r.trim();
}

function parseSchemaString(s: string): Record<string, SchemaField> {
  const result: Record<string, SchemaField> = {};
  // Complex: field: { type: 'x', optional: true }
  const cplx = /(\w+)\s*:\s*\{\s*type\s*:\s*'(string|number|boolean|array|object)'(?:\s*,\s*optional\s*:\s*(true|false))?\s*\}/g;
  let cm: RegExpExecArray | null;
  while ((cm = cplx.exec(s)) !== null) {
    result[cm[1]] = { type: cm[2], optional: cm[3] === "true" };
  }
  // Simple: field: 'type' (not inside { type: ... } blocks)
  const simplified = s.replace(/\w+\s*:\s*\{[^}]*\}/g, "");
  const simple = /(\w+)\s*:\s*'(string|number|boolean|array|object)'/g;
  let sm: RegExpExecArray | null;
  while ((sm = simple.exec(simplified)) !== null) {
    if (sm[1] !== "type" && sm[1] !== "optional" && !result[sm[1]]) {
      result[sm[1]] = { type: sm[2], optional: false };
    }
  }
  return result;
}

// ===================== Server Route Extraction =====================

function extractServerRoutes(): ServerRoute[] {
  const results: ServerRoute[] = [];
  // Scan both server/routes/ and top-level server/ files (e.g. knowledge-registry.ts)
  const routeFiles = collectFiles(ROUTES_DIR, [".ts"]).filter(f => !f.includes(".bak"));
  // Also include specific top-level server files that define routes
  const topLevelRouteFiles = ["knowledge-registry.ts"];
  for (const tlf of topLevelRouteFiles) {
    const fp = join(SERVER_DIR, tlf);
    try { statSync(fp); routeFiles.push(fp); } catch {}
  }
  for (const file of routeFiles) {
    const content = readFileSync(file, "utf8");
    const lines = content.split("\n");
    const fileName = basename(file);
    const prefix = ROUTE_PREFIXES[fileName] ?? "";

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Standard string-quoted routes
      const rm = line.match(/(?:router|app)\.(get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"]/i);
      // Regex routes: router.get(/^\/api\/.../, ...)
      const rxm = !rm ? line.match(/(?:router|app)\.(get|post|put|patch|delete)\s*\(\s*\//) : null;

      let method: string, routePath: string, isRegexRoute = false;

      if (rm) {
        method = rm[1].toUpperCase(); routePath = rm[2];
      } else if (rxm) {
        method = rxm[1].toUpperCase(); isRegexRoute = true;
        // Extract path from regex (handles escaped slashes like \/api\/...)
        const rxStr = line.substring(line.indexOf("/", line.indexOf(rxm[0])));
        // Try unescaped first, then try with escaped slashes
        let pathMatch = rxStr.match(/\/api\/[a-zA-Z0-9/_-]+/);
        if (!pathMatch) {
          // Extract path with escaped slashes and unescape
          const escapedMatch = rxStr.match(/\\?\/api(?:\\?\/[a-zA-Z0-9_-]+)+/);
          if (escapedMatch) {
            pathMatch = [escapedMatch[0].replace(/\\\//g, "/")] as unknown as RegExpMatchArray;
          }
        }
        routePath = pathMatch ? pathMatch[0] : "";
        if (!routePath) continue;
        // If regex has a capture group like (.+) or ([^/]+) or ([^\/]+), add :param suffix
        if (rxStr.match(/\(\.\+\)\$|\(\[\^\\?\/\]\+\)/)) {
          routePath += "/:param";
        }
      } else continue;

      const responseFields = new Set<string>();
      const rawResponses: string[] = [];
      let hasVariableJson = false;
      let hasProxyPattern = false;
      let hasSpread = false;

      for (let j = i + 1; j < Math.min(i + 300, lines.length); j++) {
        if (j > i + 1 && lines[j].match(/(?:router|app)\.(get|post|put|patch|delete)\s*\(/)) break;
        // Detect explicit proxy patterns (forwarding external API responses)
        if (lines[j].match(/\.json\(\s*r\.body\s*\)/)) hasProxyPattern = true;
        // Detect res.json or res.status(2xx).json — skip error responses (4xx/5xx)
        const hasResJson = lines[j].includes("res.json(") || lines[j].includes("res.json (");
        const hasStatusJson = lines[j].match(/res\.status\(\s*(\d+)\s*\)\.json\(/);
        if (!hasResJson && !hasStatusJson) continue;
        // Skip error responses: res.status(4xx/5xx).json({error: ...})
        if (hasStatusJson && parseInt(hasStatusJson[1]) >= 400) continue;
        if (lines[j].match(/return\s+res\.status\(\s*[45]\d\d\s*\)/)) continue;
        // Check if this res.json is in error-handling context (catch block or error condition)
        // Look at preceding 3 lines for error indicators
        const prevCtx = lines.slice(Math.max(0, j - 3), j).join(" ");
        if (prevCtx.match(/catch\s*\(|\.catch\(|if\s*\(\s*!|if\s*\(\s*error|if\s*\(\s*err\b|} else {/i) &&
            lines[j].match(/res\.(?:status\(\d+\)\.)?json\(\s*\{\s*error\b/)) continue;
        const lo = lines.slice(0, j).join("\n").length + 1;
        // For res.status(2xx).json( patterns, we need to find .json( not res.json(
        let ji: number;
        if (hasStatusJson) {
          ji = content.indexOf(".json(", lo - 1);
          if (ji < 0 || ji > lo + lines[j].length + 50) continue;
          ji += 1; // skip the dot, so ji points at "json("
        } else {
          ji = content.indexOf("res.json(", lo - 1);
          if (ji < 0 || ji > lo + lines[j].length + 30) continue;
          ji += 4; // skip "res.", so ji points at "json("
        }
        const parenStart = ji + 4; // "json" is 4 chars, then parenStart = index of "("
        const aft = content.substring(parenStart + 1).trimStart();
        if (!aft.startsWith("{")) {
          // res.json(variable) or res.json(array) or res.json(entries[idx])
          hasVariableJson = true;
          continue;
        }
        const bs = parenStart + 1 + content.substring(parenStart + 1).indexOf("{");
        const obj = extractBraceContent(content, bs);
        if (obj) {
          // Check for spread operators - these merge in unknown fields
          if (obj.includes("...")) {
            hasSpread = true; // Spread means we can't know all fields
          }
          rawResponses.push(obj);
          extractTopLevelFields(obj).forEach(f => responseFields.add(f));
        }
      }

      // If the only fields are "error" / "message" / "details", likely only error handlers were captured
      const errorOnlyFields = new Set(["error", "message", "details", "status"]);
      const onlyErrorFields = responseFields.size > 0 &&
        [...responseFields].every(f => errorOnlyFields.has(f));

      // Route is proxy if: (a) only variable-based json (no object literals), or
      // (b) has variable json AND only error-handler fields were captured from object literals
      const isProxy = (hasProxyPattern || hasVariableJson) &&
        (responseFields.size === 0 || onlyErrorFields);

      if (responseFields.size === 0 && !isProxy) continue;

      let fullPath: string;
      if (isRegexRoute) {
        fullPath = routePath;
      } else {
        fullPath = (prefix + routePath).replace(/\/+/g, "/");
        if (!fullPath.startsWith("/")) fullPath = "/" + fullPath;
      }

      results.push({
        file: relPath(file), line: i + 1,
        method, path: routePath, fullPath,
        responseFields: [...responseFields],
        rawResponse: rawResponses.join(" | "), isProxy, hasSpread,
      });
    }
  }
  return results;
}

function extractTopLevelFields(objStr: string): string[] {
  const fields: string[] = [];
  let depth = 0, inStr = false, strCh = "", token = "";
  for (let i = 0; i < objStr.length; i++) {
    const ch = objStr[i], prev = i > 0 ? objStr[i - 1] : "";
    if (!inStr && (ch === '"' || ch === "'" || ch === "`")) { inStr = true; strCh = ch; continue; }
    if (inStr) { if (ch === strCh && prev !== "\\") inStr = false; continue; }
    if (ch === "{" || ch === "[" || ch === "(") { depth++; continue; }
    if (ch === "}" || ch === "]" || ch === ")") { depth--; continue; }
    // Line comments
    if (depth === 0 && ch === "/" && i + 1 < objStr.length && objStr[i + 1] === "/") {
      const nl = objStr.indexOf("\n", i); if (nl > 0) i = nl; continue;
    }
    if (depth === 0) {
      if (ch === ":") {
        const n = token.trim();
        if (n && /^[a-zA-Z_$][\w$]*$/.test(n)) fields.push(n);
        token = "";
      } else if (ch === "," || ch === "\n") {
        // Handle ES6 shorthand properties: { agents } or { agents, sessions }
        const n = token.trim();
        if (n && /^[a-zA-Z_$][\w$]*$/.test(n)) fields.push(n);
        token = "";
      } else if (ch === "." && token.trim() === "" && i + 2 < objStr.length && objStr[i + 1] === "." && objStr[i + 2] === ".") {
        // Skip spread operator ...
        i += 2;
        // Skip the spread variable name
        while (i + 1 < objStr.length && /[\w.]/.test(objStr[i + 1])) i++;
        token = "";
      } else {
        token += ch;
      }
    }
  }
  // Handle last token (shorthand property at end without trailing comma)
  const lastToken = token.trim();
  if (lastToken && /^[a-zA-Z_$][\w$]*$/.test(lastToken)) fields.push(lastToken);
  return fields;
}

// ===================== Matching =====================

function norm(r: string): string {
  return r.replace(/:[a-zA-Z_]+/g, ":p").replace(/\/+/g, "/").replace(/\/$/, "");
}

function findRoutes(fv: FrontendValidation, routes: ServerRoute[]): ServerRoute[] {
  const ep = fv.endpoint
    .replace(/^(GET|POST|PUT|PATCH|DELETE)\s+/i, "")
    .replace(/:param/g, ":p")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "");
  const mm = fv.endpoint.match(/^(GET|POST|PUT|PATCH|DELETE)\s+/i);
  const method = mm ? mm[1].toUpperCase() : null;
  const matched = routes.filter(r => {
    if (method && r.method !== method) return false;
    const rn = norm(r.fullPath);
    if (rn === ep) return true;
    try {
      if (new RegExp("^" + rn.replace(/:p/g, "[^/]+") + "$").test(ep)) return true;
      if (new RegExp("^" + ep.replace(/:p/g, "[^/]+") + "$").test(rn)) return true;
    } catch {}
    return false;
  });
  // Prefer GET routes when no method specified (most validations are for GET responses)
  if (!method && matched.length > 1) {
    const getRoutes = matched.filter(r => r.method === "GET");
    if (getRoutes.length > 0) {
      matched.length = 0;
      matched.push(...getRoutes);
    }
  }
  // If frontend endpoint has params, prefer server routes with params at same positions
  if (matched.length > 1 && ep.includes(":p")) {
    const epParts = ep.split("/");
    const paramPositions = epParts.map((p, i) => p === ":p" ? i : -1).filter(i => i >= 0);
    const paramRoutes = matched.filter(r => {
      const rParts = norm(r.fullPath).split("/");
      return paramPositions.every(pos => pos < rParts.length && rParts[pos] === ":p");
    });
    if (paramRoutes.length > 0) {
      matched.length = 0;
      matched.push(...paramRoutes);
    }
  }
  // Prefer routes with more response fields (more specific match)
  if (matched.length > 1) {
    matched.sort((a, b) => b.responseFields.length - a.responseFields.length);
  }
  return matched;
}

// ===================== Cross-Reference =====================

function crossRef(fvs: FrontendValidation[], routes: ServerRoute[]): MatchResult[] {
  const results: MatchResult[] = [];
  for (const fv of fvs) {
    if (fv.isArrayItem) {
      results.push({ frontend: fv, serverRoute: null, status: "SKIP", issues: ["Array item validation"] });
      continue;
    }
    if (fv.isSubObject) {
      results.push({ frontend: fv, serverRoute: null, status: "SKIP", issues: ["Sub-object validation"] });
      continue;
    }
    if (fv.isDynamic && !fv.endpoint.startsWith("/")) {
      results.push({ frontend: fv, serverRoute: null, status: "SKIP", issues: ["Dynamic endpoint variable"] });
      continue;
    }
    const ep = fv.endpoint.replace(/^(GET|POST|PUT|PATCH|DELETE)\s+/i, "");
    if (!ep.startsWith("/api/")) {
      results.push({ frontend: fv, serverRoute: null, status: "SKIP", issues: ["External endpoint"] });
      continue;
    }
    if (Object.keys(fv.schema).length === 0) {
      results.push({ frontend: fv, serverRoute: null, status: "SKIP", issues: ["Empty schema"] });
      continue;
    }
    // Bridge proxy endpoints
    if (BRIDGE_PROXY_ENDPOINTS.has(ep)) {
      results.push({ frontend: fv, serverRoute: null, status: "SKIP", issues: ["Bridge proxy endpoint"] });
      continue;
    }
    // Known label mismatches (validation label != actual fetch URL)
    const labelKey = fv.endpoint.includes(" ") ? fv.endpoint : ep;
    if (KNOWN_LABEL_MISMATCHES[labelKey]) {
      results.push({ frontend: fv, serverRoute: null, status: "SKIP", issues: ["Known label mismatch: " + KNOWN_LABEL_MISMATCHES[labelKey]] });
      continue;
    }

    const matches = findRoutes(fv, routes);
    if (matches.length === 0) {
      results.push({ frontend: fv, serverRoute: null, status: "FAIL", issues: ["No matching server route found"] });
      continue;
    }
    const best = matches[0];
    if (best.isProxy && best.responseFields.length === 0) {
      results.push({ frontend: fv, serverRoute: best, status: "SKIP", issues: ["Proxy/passthrough route"] });
      continue;
    }

    const issues: string[] = [];
    for (const [field, spec] of Object.entries(fv.schema)) {
      if (spec.optional) continue;
      if (best.responseFields.includes(field)) continue;
      // Check aliases
      const ALIASES: Record<string, string[]> = {
        success: ["ok"], ok: ["success"], count: ["total"], total: ["count"],
      };
      const alias = (ALIASES[field] || []).find(a => best.responseFields.includes(a));
      if (alias) {
        issues.push("FIELD MISMATCH: frontend expects '" + field + "' but server sends '" + alias + "'");
      } else if (!best.isProxy && !best.hasSpread) {
        // Only report missing fields if the route does NOT use spread operators
        // (spread operators merge in unknown fields that we can't resolve statically)
        issues.push("MISSING FIELD: frontend expects '" + field + "' (" + spec.type + "), server has [" + best.responseFields.join(", ") + "]");
      }
    }
    results.push({
      frontend: fv, serverRoute: best,
      status: issues.length > 0 ? "FAIL" : "PASS", issues,
    });
  }
  return results;
}

// ===================== Report =====================

function printReport(results: MatchResult[]): boolean {
  const passes = results.filter(r => r.status === "PASS");
  const fails = results.filter(r => r.status === "FAIL");
  const skips = results.filter(r => r.status === "SKIP");

  console.log("\n" + "=".repeat(80));
  console.log("  API Contract Validation Report");
  console.log("=".repeat(80));
  console.log("\n  Total: " + results.length + "  |  PASS: " + passes.length + "  |  FAIL: " + fails.length + "  |  SKIP: " + skips.length + "\n");

  if (fails.length > 0) {
    console.log("-".repeat(80));
    console.log("  FAILURES");
    console.log("-".repeat(80));
    for (const r of fails) {
      console.log("\n  FAIL  " + r.frontend.rawEndpoint);
      console.log("        Frontend: " + r.frontend.file + ":" + r.frontend.line);
      if (r.serverRoute) {
        console.log("        Server:   " + r.serverRoute.file + ":" + r.serverRoute.line + " (" + r.serverRoute.method + " " + r.serverRoute.fullPath + ")");
        console.log("        Server fields: [" + r.serverRoute.responseFields.join(", ") + "]");
      }
      const ss = Object.entries(r.frontend.schema).map(function([k, v]) {
        return k + ": '" + v.type + "'" + (v.optional ? " (opt)" : "");
      }).join(", ");
      console.log("        Schema: { " + ss + " }");
      for (const iss of r.issues) console.log("        >> " + iss);
    }
  }

  if (passes.length > 0) {
    console.log("\n" + "-".repeat(80));
    console.log("  PASSES (" + passes.length + ")");
    console.log("-".repeat(80));
    for (const r of passes) {
      console.log("  PASS  " + r.frontend.endpoint + "  (" + r.frontend.file + ":" + r.frontend.line + ")");
    }
  }

  if (skips.length > 0) {
    console.log("\n" + "-".repeat(80));
    console.log("  SKIPPED (" + skips.length + ")");
    console.log("-".repeat(80));
    for (const r of skips) {
      console.log("  SKIP  " + r.frontend.rawEndpoint + "  -- " + r.issues[0]);
    }
  }

  console.log("\n" + "=".repeat(80));
  if (fails.length > 0) {
    console.log("\n  " + fails.length + " mismatch(es) found. Exit code 1.\n");
    return false;
  }
  console.log("\n  All validations passed.\n");
  return true;
}

// ===================== Main =====================

console.log("[validate-api-contracts] Scanning frontend validations...");
const fvs = extractFrontendValidations();
console.log("  Found " + fvs.length + " validateApiResponse calls");

console.log("[validate-api-contracts] Scanning server routes...");
const routes = extractServerRoutes();
console.log("  Found " + routes.length + " route handlers");

console.log("[validate-api-contracts] Cross-referencing...\n");
const results = crossRef(fvs, routes);
const ok = printReport(results);
process.exit(ok ? 0 : 1);
