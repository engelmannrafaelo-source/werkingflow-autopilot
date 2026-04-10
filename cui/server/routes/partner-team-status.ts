import { Router, Request, Response } from 'express';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { PATHS } from '../config/paths.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const LEADERS = [
  { key: 'max', label: 'Max — Tech & DevOps', file: 'max.md' },
  { key: 'herbert', label: 'Herbert — Security', file: 'herbert.md' },
] as const;

type LeaderKey = (typeof LEADERS)[number]['key'];

/**
 * Extract sections from a markdown worklist that are relevant to a given app.
 * Matches headings and list items that mention the app name (case-insensitive).
 */
function extractAppSections(content: string, app: string): string {
  if (!app) return content;

  const appLower = app.toLowerCase();
  const lines = content.split('\n');
  const result: string[] = [];

  // Always keep the document title (first H1)
  let titleAdded = false;
  let inRelevantBlock = false;
  let currentHeadingDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Document title — always include
    if (!titleAdded && line.startsWith('# ')) {
      result.push(line);
      titleAdded = true;
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);

    if (headingMatch) {
      const depth = headingMatch[1].length;
      const headingText = headingMatch[2].toLowerCase();

      // If heading mentions the app, start a relevant block
      if (headingText.includes(appLower)) {
        inRelevantBlock = true;
        currentHeadingDepth = depth;
        result.push('');
        result.push(line);
        continue;
      }

      // If we encounter a heading at same/higher level, end the relevant block
      if (inRelevantBlock && depth <= currentHeadingDepth) {
        inRelevantBlock = false;
      }
    }

    if (inRelevantBlock) {
      result.push(line);
      continue;
    }

    // Include lines that explicitly mention the app (bullet points, tasks)
    if (line.toLowerCase().includes(appLower)) {
      result.push(line);
    }
  }

  const filtered = result.join('\n').trim();
  if (!filtered || filtered === (lines[0] ?? '').trim()) {
    return `_Keine relevanten Einträge für "${app}" gefunden._`;
  }
  return filtered;
}

function readWorklist(file: string): string {
  const filePath = join(PATHS.worklistsDir, file);
  if (!existsSync(filePath)) {
    return `_Worklist nicht gefunden: ${file}_`;
  }
  try {
    return readFileSync(filePath, 'utf-8');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[PartnerTeamStatus] Failed to read ${file}:`, msg);
    return `_Fehler beim Lesen von ${file}: ${msg}_`;
  }
}

// ─── Router ──────────────────────────────────────────────────────────────────

export default function createPartnerTeamStatusRouter(): Router {
  const router = Router();

  // GET /api/partner/team-status?app=werking-energy
  router.get('/team-status', (req: Request, res: Response) => {
    const app = (req.query.app as string | undefined) ?? '';

    try {
      const sections = LEADERS.map(({ key, label, file }) => {
        const raw = readWorklist(file);
        const content = app ? extractAppSections(raw, app) : raw;
        return { key, label, content };
      });

      res.json({
        app: app || null,
        sections,
        fetchedAt: new Date().toISOString(),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[PartnerTeamStatus] Failed:', msg);
      res.status(500).json({ error: 'Failed to load team status' });
    }
  });

  return router;
}
