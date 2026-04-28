/**
 * code-state — Inspect a user's repo and produce a "Drei Welten" summary
 * (Live / Meine Tests / Vorschläge) for the Tool Hub Welcome dashboard.
 *
 * No git jargon leaks into the response — fields are named for the UX
 * vocabulary established in the Bridge research (Vorschlag, Testumgebung,
 * Live-Version).
 */

import { gitOut, repoExists, repoPathFor } from './git-shell.js';
import { listProposals, type ProposalMeta } from './proposals-store.js';

export interface CodeStateLive {
  sha: string;          // short SHA of origin/develop
  fullSha: string;
  message: string;
  authorName: string;
  date: string;         // ISO
}

export interface CodeStateMe {
  sha: string;          // short SHA of HEAD
  ahead: number;        // local commits not in develop
  behind: number;       // develop commits not in local
  dirtyFiles: number;   // uncommitted changed files
  inSync: boolean;      // ahead==0 && behind==0 && dirty==0
  lastCommitMessage: string;
  lastCommitDate: string;
}

export interface TimelineEvent {
  kind: 'live-update' | 'proposal-approved' | 'proposal-rejected' | 'proposal-pending' | 'my-edit';
  at: string;           // ISO
  title: string;
  detail?: string;
  by?: string;
  proposalId?: string;
  sha?: string;
}

export interface CodeState {
  available: boolean;
  reason?: string;       // when unavailable (e.g. repo missing)
  workspace: string;
  userId: string;
  live?: CodeStateLive;
  me?: CodeStateMe;
  proposalCounts: { pending: number; approved: number; rejected: number; mine: number };
  myProposals: ProposalMeta[];
  timeline: TimelineEvent[];
}

const PATCH_FILE_LINE = /^diff --git a\/(.+?) b\//;

async function safeGitOut(args: string[], userId: string, fallback = ''): Promise<string> {
  try { return await gitOut(args, { asUser: userId }); }
  catch { return fallback; }
}

export async function getCodeState(userId: string, workspace: string): Promise<CodeState> {
  const proposals = listProposals(workspace);
  const myProposals = proposals.filter(p => p.authorId === userId);
  const proposalCounts = {
    pending: proposals.filter(p => p.status === 'pending').length,
    approved: proposals.filter(p => p.status === 'approved').length,
    rejected: proposals.filter(p => p.status === 'rejected').length,
    mine: myProposals.length,
  };

  if (!repoExists(userId)) {
    return {
      available: false,
      reason: `Kein Repo unter ${repoPathFor(userId)}`,
      workspace, userId,
      proposalCounts, myProposals,
      timeline: proposalsToTimeline(proposals),
    };
  }

  // Best-effort: fetch latest origin/develop. Soft-fail on no network.
  await safeGitOut(['fetch', 'origin', 'develop', '--quiet'], userId);

  const liveSha = await safeGitOut(['rev-parse', 'origin/develop'], userId);
  const liveShort = await safeGitOut(['rev-parse', '--short', 'origin/develop'], userId);
  const liveLog = await safeGitOut(['log', '-1', '--format=%aI%x09%an%x09%s', 'origin/develop'], userId);
  const [liveDate = '', liveAuthor = '', liveMsg = ''] = liveLog.split('\t');

  const meSha = await safeGitOut(['rev-parse', '--short', 'HEAD'], userId);
  const meLog = await safeGitOut(['log', '-1', '--format=%aI%x09%s', 'HEAD'], userId);
  const [meDate = '', meMsg = ''] = meLog.split('\t');

  const aheadStr = await safeGitOut(['rev-list', '--count', 'origin/develop..HEAD'], userId, '0');
  const behindStr = await safeGitOut(['rev-list', '--count', 'HEAD..origin/develop'], userId, '0');
  const ahead = parseInt(aheadStr, 10) || 0;
  const behind = parseInt(behindStr, 10) || 0;

  // Dirty count, applying the same whitelist that partner-sync.sh uses to
  // ignore tooling churn that isn't a real user edit.
  const statusOut = await safeGitOut(['status', '--porcelain'], userId);
  const dirtyFiles = statusOut.split('\n').filter(line => {
    if (!line.trim()) return false;
    if (/^ M \.gitignore$/.test(line)) return false;
    if (/^\?\? CLAUDE\.md$/.test(line)) return false;
    if (/^ T apps\/[^/]+\/scripts\/nuclear-clean\.sh$/.test(line)) return false;
    if (/^ M pnpm-lock\.yaml$/.test(line)) return false;
    if (/^ M apps\/[^/]+\/supabase\/\.temp\//.test(line)) return false;
    return true;
  }).length;

  const inSync = ahead === 0 && behind === 0 && dirtyFiles === 0;

  // Recent live-update events (last 7 days on origin/develop)
  const recentDevelop = await safeGitOut([
    'log', '--since=7.days', '--format=%H%x09%aI%x09%an%x09%s', 'origin/develop',
  ], userId);

  const liveEvents: TimelineEvent[] = recentDevelop.split('\n').filter(Boolean).map(line => {
    const [sha, at, by, title] = line.split('\t');
    return { kind: 'live-update', at, title, by, sha: sha?.slice(0, 7) };
  });

  return {
    available: true,
    workspace, userId,
    live: { sha: liveShort, fullSha: liveSha, message: liveMsg, authorName: liveAuthor, date: liveDate },
    me: {
      sha: meSha, ahead, behind, dirtyFiles, inSync,
      lastCommitMessage: meMsg, lastCommitDate: meDate,
    },
    proposalCounts, myProposals,
    timeline: mergeTimeline(liveEvents, proposalsToTimeline(proposals)),
  };
}

function proposalsToTimeline(proposals: ProposalMeta[]): TimelineEvent[] {
  return proposals.map(p => {
    const at = p.decidedAt ?? p.createdAt;
    if (p.status === 'approved')
      return { kind: 'proposal-approved' as const, at, title: p.title, detail: p.description, by: p.decidedBy, proposalId: p.id };
    if (p.status === 'rejected')
      return { kind: 'proposal-rejected' as const, at, title: p.title, detail: p.decisionReason || p.description, by: p.decidedBy, proposalId: p.id };
    return { kind: 'proposal-pending' as const, at, title: p.title, detail: p.description, by: p.authorName, proposalId: p.id };
  });
}

function mergeTimeline(...lists: TimelineEvent[][]): TimelineEvent[] {
  const merged = lists.flat();
  merged.sort((a, b) => (a.at < b.at ? 1 : -1));
  return merged.slice(0, 50);
}

/** Parse the file-list out of a patch without applying it. */
export function patchFileList(patch: string): string[] {
  const files = new Set<string>();
  for (const line of patch.split('\n')) {
    const m = PATCH_FILE_LINE.exec(line);
    if (m) files.add(m[1]);
  }
  return Array.from(files);
}

/** Count +/- lines in a patch (excluding metadata lines). */
export function patchLineCounts(patch: string): { added: number; removed: number } {
  let added = 0, removed = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++ ') || line.startsWith('--- ') || line.startsWith('+++')) continue;
    if (line.startsWith('+') && !line.startsWith('++')) added++;
    if (line.startsWith('-') && !line.startsWith('--')) removed++;
  }
  return { added, removed };
}
