/**
 * Journey scaffold — prepares the per-run directory + journeyId.
 *
 * The actual browser work has moved into the Sub-Session. Each Sub uses
 * `journey-action.mjs` (Node + Playwright) to log in, click around, and
 * capture screenshots from inside the user's session. This file only owns
 * the storage layout: <baseDir>/<userId>/<workspace>/<journeyId>/.
 */

import { mkdirSync } from 'fs';
import { join } from 'path';

export interface JourneyScaffold {
  journeyId: string;
  dirPath: string;
}

function makeJourneyId(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function prepareJourney(baseDir: string, userId: string, workspace: string): JourneyScaffold {
  const journeyId = makeJourneyId(new Date());
  const dirPath = join(baseDir, userId, workspace, journeyId);
  mkdirSync(dirPath, { recursive: true });
  return { journeyId, dirPath };
}
