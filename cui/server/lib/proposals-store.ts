/**
 * proposals-store — Persistent inbox for code proposals.
 *
 * Each proposal is a pair of files in /opt/cui-workspace-data/proposals/<workspace>/:
 *   <id>.patch  — git format-patch output
 *   <id>.json   — metadata (author, title, description, status, baseSha, ...)
 *
 * IDs are time-ordered so listing in reverse alphabetical order = newest first.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { PATHS } from '../config/paths.js';

export type ProposalStatus = 'pending' | 'approved' | 'rejected';

export interface ProposalMeta {
  id: string;
  workspace: string;
  authorId: string;
  authorName: string;
  authorRole: string;
  title: string;
  description: string;
  baseSha: string;     // origin/develop commit at time of creation
  headSha: string;     // local HEAD at time of creation (snapshot)
  filesChanged: string[];
  linesChanged: { added: number; removed: number };
  createdAt: string;
  status: ProposalStatus;
  decidedAt?: string;
  decidedBy?: string;
  decisionReason?: string;
}

const ROOT = join(PATHS.dataDir, 'proposals');

function workspaceDir(workspace: string): string {
  return join(ROOT, workspace);
}

function ensureDir(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function newId(authorId: string): string {
  // YYYYMMDD-HHMMSS-author — sortable by creation time
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  return `${stamp}-${authorId}`;
}

export function writeProposal(meta: ProposalMeta, patch: string): void {
  const dir = workspaceDir(meta.workspace);
  ensureDir(dir);
  writeFileSync(join(dir, `${meta.id}.patch`), patch, 'utf8');
  writeFileSync(join(dir, `${meta.id}.json`), JSON.stringify(meta, null, 2), 'utf8');
}

export function readMeta(workspace: string, id: string): ProposalMeta | null {
  const f = join(workspaceDir(workspace), `${id}.json`);
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; }
}

export function readPatch(workspace: string, id: string): string | null {
  const f = join(workspaceDir(workspace), `${id}.patch`);
  if (!existsSync(f)) return null;
  return readFileSync(f, 'utf8');
}

export function updateStatus(workspace: string, id: string, status: ProposalStatus, decidedBy: string, reason?: string): ProposalMeta | null {
  const meta = readMeta(workspace, id);
  if (!meta) return null;
  meta.status = status;
  meta.decidedAt = new Date().toISOString();
  meta.decidedBy = decidedBy;
  if (reason) meta.decisionReason = reason;
  writeFileSync(join(workspaceDir(workspace), `${id}.json`), JSON.stringify(meta, null, 2), 'utf8');
  return meta;
}

export function listProposals(workspace?: string, status?: ProposalStatus): ProposalMeta[] {
  if (!existsSync(ROOT)) return [];
  const wsList = workspace ? [workspace] : readdirSync(ROOT);
  const out: ProposalMeta[] = [];
  for (const ws of wsList) {
    const dir = workspaceDir(ws);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const meta: ProposalMeta = JSON.parse(readFileSync(join(dir, f), 'utf8'));
        if (status && meta.status !== status) continue;
        out.push(meta);
      } catch {
        // skip corrupt
      }
    }
  }
  // Newest first (id encodes timestamp)
  out.sort((a, b) => b.id.localeCompare(a.id));
  return out;
}

/** Hard-delete a proposal (used by auto-cleanup of decided + old proposals). */
export function deleteProposal(workspace: string, id: string): boolean {
  const dir = workspaceDir(workspace);
  let removed = false;
  for (const ext of ['.patch', '.json']) {
    const f = join(dir, `${id}${ext}`);
    if (existsSync(f)) { unlinkSync(f); removed = true; }
  }
  return removed;
}
