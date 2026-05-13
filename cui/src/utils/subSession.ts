/**
 * Sub-Session Detection — Single Source of Truth.
 *
 * A conversation is a sub-session if:
 *   (a) the server marks `isSubSession=true` (parent-mapping exists in convMeta), OR
 *   (b) the subject/customName/summary starts with a known SUB_PREFIX.
 *
 * The name-prefix fallback is NOT a heuristic. It is the documented spawn convention
 * in `/root/orchestrator/workspaces/arch-worker/CLAUDE.md` (Modus 1 and Modus 2):
 *
 *     "subject":"[Sub] {APP} {SCENARIO_ID} Fix"
 *     "parentSessionId":"<DEINE_SESSION_ID>"
 *
 * In practice the parentSessionId parameter is sometimes omitted by the spawning
 * agent (Master/Drive discipline issue) — leaving the server flag false even though
 * the conversation is intended as a sub. The prefix detection makes the client
 * resilient to this. If the spawn discipline is ever enforced server-side, this
 * fallback becomes dead code but does no harm.
 */

export const SUB_PREFIXES = ['[Sub]', '[Arch-Fix]', '[Arch-App]', '[Fix]', '[Analysis]'] as const;

export interface SubDetectableConv {
  isSubSession?: boolean;
  customName?: string;
  summary?: string;
  subject?: string;
}

export function isSubSession(conv: SubDetectableConv | null | undefined): boolean {
  if (!conv) return false;
  if (conv.isSubSession) return true;
  const name = (conv.customName || conv.summary || conv.subject || '') as string;
  return SUB_PREFIXES.some(p => name.startsWith(p));
}
