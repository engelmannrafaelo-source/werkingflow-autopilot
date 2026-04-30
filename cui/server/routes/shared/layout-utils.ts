/**
 * Layout cleanup utilities — pure helpers (no broadcast, no DI).
 *
 * Problem: when a session is finished (convMeta.setFinished(sid, true)) the
 * tab in the persisted layout file becomes a "zombie": it points to a session
 * that getWorkspaceConversations() filters out, but runAutoLayout() never
 * removes it because it only triggers on *missing* ongoing sessions.
 *
 * removeSessionFromLayouts() iterates all layout files in LAYOUTS_DIR,
 * recursively finds tab nodes whose component is cui/cui-lite and whose
 * config.initialSessionId (or config.sessionId) matches the given sid,
 * removes them, prunes empty tabsets, bumps _v, and writes back.
 *
 * Returns the list of changed layouts so the caller can broadcast
 * `control:apply-layout` to connected clients.
 */

import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { atomicWriteFileSync } from './utils.js';

interface LayoutNode {
  type?: string;
  component?: string;
  config?: { initialSessionId?: string; sessionId?: string; [k: string]: unknown };
  children?: LayoutNode[];
  [k: string]: unknown;
}

interface LayoutFile {
  global?: Record<string, unknown>;
  borders?: unknown[];
  layout?: LayoutNode;
  _v?: number;
  [k: string]: unknown;
}

export interface LayoutChange {
  projectId: string;
  layoutPath: string;
  layout: LayoutFile;
  removed: number;
}

/**
 * Recursively walk node tree, applying mutator to children arrays.
 * Returns number of tab nodes removed.
 */
function pruneTabsForSession(node: LayoutNode | undefined, sids: Set<string>): number {
  if (!node || !node.children) return 0;
  let removed = 0;
  // Filter direct children: drop matching CUI tabs
  const kept: LayoutNode[] = [];
  for (const child of node.children) {
    if (
      child.type === 'tab' &&
      (child.component === 'cui' || child.component === 'cui-lite')
    ) {
      const sid = child.config?.initialSessionId || child.config?.sessionId;
      if (sid && sids.has(sid)) {
        removed++;
        continue;
      }
    }
    kept.push(child);
  }
  // Recurse into kept children (rows / tabsets)
  for (const child of kept) {
    removed += pruneTabsForSession(child, sids);
  }
  // Drop tabsets that have become empty after pruning. A row that becomes
  // empty likewise drops; the top-level layout row is preserved even if empty
  // (the frontend can render an empty workspace).
  node.children = kept.filter((c) => {
    if (c.type === 'tabset' || c.type === 'row') {
      return Array.isArray(c.children) && c.children.length > 0;
    }
    return true;
  });
  return removed;
}

/**
 * Layout file naming policy:
 *  - `{projectId}.json`              → live layout (cleaned)
 *  - `{projectId}_template.json`     → template, never cleaned
 *  - `*.bak*`, `*.json.bak*`         → backups, never cleaned
 */
function isLiveLayoutFile(name: string): boolean {
  if (!name.endsWith('.json')) return false;
  if (name.endsWith('_template.json')) return false;
  if (name.includes('.bak')) return false;
  return true;
}

/**
 * Remove all CUI/cui-lite tabs that point at any of `sessionIds` from every
 * live layout file under LAYOUTS_DIR. Empty tabsets/rows are pruned. Each
 * changed layout gets `_v` bumped and is written back atomically.
 *
 * Pure: does not broadcast. Caller (e.g. state.ts) is responsible for
 * dispatching `control:apply-layout` per returned LayoutChange.
 */
export function removeSessionFromLayouts(
  layoutsDir: string,
  sessionIds: string | string[],
): LayoutChange[] {
  const sids = new Set(
    Array.isArray(sessionIds) ? sessionIds.filter(Boolean) : sessionIds ? [sessionIds] : [],
  );
  if (sids.size === 0) return [];
  if (!existsSync(layoutsDir)) return [];

  const changes: LayoutChange[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(layoutsDir);
  } catch {
    return [];
  }

  for (const name of entries) {
    if (!isLiveLayoutFile(name)) continue;
    const layoutPath = join(layoutsDir, name);
    let layout: LayoutFile;
    try {
      layout = JSON.parse(readFileSync(layoutPath, 'utf8')) as LayoutFile;
    } catch {
      continue;
    }
    const removed = pruneTabsForSession(layout.layout, sids);
    if (removed === 0) continue;

    layout._v = (typeof layout._v === 'number' ? layout._v : 0) + 1;
    try {
      atomicWriteFileSync(layoutPath, JSON.stringify(layout, null, 2));
    } catch (err) {
      console.warn(
        `[LayoutUtils] Failed to write ${layoutPath}:`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }

    const projectId = name.replace(/\.json$/, '');
    changes.push({ projectId, layoutPath, layout, removed });
  }

  return changes;
}

/**
 * Collect the set of CUI/cui-lite session IDs referenced by a single layout
 * file. Used by zombie-detection in runAutoLayout: any sid present in the
 * layout but absent from getWorkspaceConversations().mainConvs is a zombie.
 */
export function collectLayoutSessionIds(layout: LayoutFile | undefined): Set<string> {
  const out = new Set<string>();
  function walk(node: LayoutNode | undefined): void {
    if (!node) return;
    if (
      node.type === 'tab' &&
      (node.component === 'cui' || node.component === 'cui-lite')
    ) {
      const sid = node.config?.initialSessionId || node.config?.sessionId;
      if (sid) out.add(sid);
    }
    for (const child of node.children ?? []) walk(child);
  }
  walk(layout?.layout);
  return out;
}
