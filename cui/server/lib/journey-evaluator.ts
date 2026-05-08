/**
 * Journey Evaluator — sends Playwright-captured screenshots + journey.md
 * to Claude Vision (via AI Bridge) and stores a structured evaluation
 * next to the screenshots.
 *
 * Output: evaluation.json with shape:
 *   {
 *     rating: 1..5,
 *     works_e2e: boolean,
 *     summary: string,
 *     findings: string[],
 *     blockers: string[],
 *     model: string,
 *     evaluated_at: ISO-string,
 *   }
 *
 * Why this exists: the Playwright runner only checks "URL no longer /login" —
 * which is a weak signal. Login can succeed but the dashboard can be empty,
 * show errors, render in the wrong language, or the post-login screen can be
 * a stub page. Vision evaluates what the user *actually sees*.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { bridgeChat, BridgeContentBlock } from './bridge-fetch.js';

export interface JourneyEvaluation {
  rating: number;            // 1..5
  works_e2e: boolean;
  summary: string;
  findings: string[];
  blockers: string[];
  model: string;
  evaluated_at: string;
}

const EVALUATION_PROMPT = `Du bist ein QA-Tester für die WerkING-Plattform. Du bekommst 4 Screenshots eines Login-Journeys einer Web-App und das Journey-Log.

Bewerte ob der Login + Post-Login-Zustand funktioniert. Achte auf:
- Login-Form wirklich submitted? (Form-Felder gefüllt sichtbar)
- Nach Submit: Dashboard / Workflows / Projekte sichtbar — oder bleibt Login-Form?
- Sichtbare Fehler-Banner, Tracebacks, "404", "500", "Unauthorized"
- Leeres Dashboard (0 Items wo welche sein müssten)
- Rendering-Bugs (Layout-Bruch, fehlende Texte)
- Sprache passt (Deutsch erwartet)

Antworte AUSSCHLIESSLICH mit einem JSON-Objekt mit folgenden Feldern (kein Markdown, kein Text drumrum):
{
  "rating": <1-5, 5=perfekt, 1=komplett kaputt>,
  "works_e2e": <true wenn echter Login + sinnvolle Post-Login-Seite, sonst false>,
  "summary": "<1 Satz Beschreibung was du siehst>",
  "findings": ["<konkrete Beobachtungen, leere Liste wenn alles ok>"],
  "blockers": ["<harte Probleme die Funktionalität verhindern>"]
}`;

function buildContent(journeyMdPath: string, screenshotPaths: string[]): BridgeContentBlock[] {
  const blocks: BridgeContentBlock[] = [{ type: 'text', text: EVALUATION_PROMPT }];
  if (existsSync(journeyMdPath)) {
    blocks.push({ type: 'text', text: '\n\n=== Journey-Log ===\n' + readFileSync(journeyMdPath, 'utf8') });
  }
  for (const p of screenshotPaths) {
    if (!existsSync(p)) continue;
    const base = p.split('/').pop() || p;
    blocks.push({ type: 'text', text: `\n\n--- ${base} ---` });
    const data = readFileSync(p).toString('base64');
    blocks.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${data}` } });
  }
  return blocks;
}

function parseEvaluation(raw: string): Omit<JourneyEvaluation, 'model' | 'evaluated_at'> {
  // Try direct parse first; fall back to extracting first JSON object.
  let txt = raw.trim();
  if (txt.startsWith('```')) {
    txt = txt.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  }
  let obj: any;
  try {
    obj = JSON.parse(txt);
  } catch {
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) throw new Error(`Could not parse evaluation JSON. Raw start: ${raw.slice(0, 200)}`);
    obj = JSON.parse(m[0]);
  }
  const rating = Number(obj.rating);
  if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
    throw new Error(`Invalid rating: ${obj.rating}`);
  }
  return {
    rating: Math.round(rating),
    works_e2e: Boolean(obj.works_e2e),
    summary: String(obj.summary || ''),
    findings: Array.isArray(obj.findings) ? obj.findings.map((s: any) => String(s)) : [],
    blockers: Array.isArray(obj.blockers) ? obj.blockers.map((s: any) => String(s)) : [],
  };
}

export async function evaluateJourney(dirPath: string, model = 'claude-sonnet-4-5-20250929'): Promise<JourneyEvaluation> {
  // Bridge has a 1MB request body limit (nginx default). Each full-page PNG
  // is ~300KB binary, ~400KB base64 — sending all 4 blows the limit. The
  // only screenshots that change the verdict are post-submit ones; before
  // that the model just sees an empty form. Send 03 + 04 only.
  const screenshots = ['03-after-login.png', '04-projekte.png']
    .map(n => join(dirPath, n));
  const content = buildContent(join(dirPath, 'journey.md'), screenshots);

  const raw = await bridgeChat({
    model,
    max_tokens: 1024,
    messages: [{ role: 'user', content }],
    timeout: 120000,
    attribution: { appId: 'cui', agentId: 'journey-evaluator' },
  });

  const parsed = parseEvaluation(raw);
  const evaluation: JourneyEvaluation = {
    ...parsed,
    model,
    evaluated_at: new Date().toISOString(),
  };
  writeFileSync(join(dirPath, 'evaluation.json'), JSON.stringify(evaluation, null, 2), 'utf8');
  return evaluation;
}
