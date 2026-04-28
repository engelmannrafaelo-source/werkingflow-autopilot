/**
 * Code-Management Routes — "Vorschlag senden" workflow for non-coders.
 *
 * Mirrors the partner-server routing topology:
 *   - dev-server runs in FORWARD mode (proxies all requests to partner)
 *   - partner-server runs in NATIVE mode (does the actual git work)
 *
 * Auth: standard JWT (any logged-in user). Per-route checks restrict
 * approve/reject to admin + product-owner.
 *
 * UX vocabulary (Bridge research, do not change without re-reading the report):
 *   - Live-Version  ← origin/develop
 *   - Meine Tests   ← user's HEAD + working tree
 *   - Vorschlag     ← format-patch output, stored in proposals inbox
 *   - Übernehmen    ← git am + push (PO/admin only)
 *   - Ablehnen      ← mark rejected (PO/admin only)
 */

import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { findUser } from '../auth/users.js';
import { gitOut, runGit, repoExists } from '../lib/git-shell.js';
import { getCodeState, patchFileList, patchLineCounts } from '../lib/code-state.js';
import {
  newId, writeProposal, readMeta, readPatch, listProposals, updateStatus,
  type ProposalMeta,
} from '../lib/proposals-store.js';

function isForwardMode(): boolean {
  return Boolean(process.env.CUI_PARTNER_FORWARD_URL && process.env.CUI_PARTNER_INTERNAL_TOKEN);
}

async function forwardToPartner(req: Request, res: Response): Promise<void> {
  const target = process.env.CUI_PARTNER_FORWARD_URL!.replace(/\/$/, '') + req.originalUrl;
  const token = process.env.CUI_PARTNER_INTERNAL_TOKEN!;
  const headers: Record<string, string> = {
    'x-cui-internal-token': token,
    accept: req.headers.accept || '*/*',
  };
  // Forward the user's identity so partner can act on their behalf.
  if (req.user) {
    headers['x-cui-forward-user'] = encodeURIComponent(JSON.stringify(req.user));
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    headers['content-type'] = (req.headers['content-type'] as string) || 'application/json';
  }
  const body = (req.method !== 'GET' && req.method !== 'HEAD')
    ? (typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}))
    : undefined;

  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });

  try {
    const r = await fetch(target, { method: req.method, headers, body, signal: ac.signal });
    res.status(r.status);
    const ct = r.headers.get('content-type'); if (ct) res.setHeader('Content-Type', ct);
    if (!r.body) { res.end(); return; }
    const reader = r.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) res.write(Buffer.from(value));
    }
    res.end();
  } catch (err: any) {
    const cause = err?.cause?.message || err?.cause?.code || '';
    if (!res.headersSent) {
      res.status(502).json({ error: `Forward to partner failed: ${err.message}${cause ? ` (${cause})` : ''}` });
    } else {
      res.end();
    }
  }
}

/**
 * Auth: JWT cookie OR shared internal-token + x-cui-forward-user (from dev forward).
 */
function authOrInternal(req: Request, res: Response, next: NextFunction): void {
  const internalToken = process.env.CUI_PARTNER_INTERNAL_TOKEN;
  const headerToken = req.header('x-cui-internal-token');
  if (internalToken && headerToken && headerToken === internalToken) {
    const fwdUser = req.header('x-cui-forward-user');
    if (fwdUser) {
      try { (req as any).user = JSON.parse(decodeURIComponent(fwdUser)); }
      catch { /* fall through to admin synth */ }
    }
    if (!(req as any).user) {
      (req as any).user = { sub: '__internal__', name: 'Internal', role: 'admin', claudeAccountId: 'internal' };
    }
    next();
    return;
  }
  requireAuth(req, res, next);
}

export default function createCodeMgmtRoutes() {
  const router = Router();

  // FORWARD MODE — dev only, proxy everything to partner.
  if (isForwardMode()) {
    router.use(authOrInternal);
    router.use(forwardToPartner);
    return router;
  }

  // NATIVE MODE — runs on partner.
  router.use(authOrInternal);

  /** Is the caller the Product Owner of this workspace?
   *  - admin: always true
   *  - others: must have workspace in their `productOwnerOf` list */
  function isPoOfWorkspace(userId: string | undefined, workspace: string): boolean {
    if (!userId || userId === '__internal__') return false;
    const u = findUser(userId);
    if (!u) return false;
    if (u.role === 'admin') return true;
    const po = u.productOwnerOf;
    if (po === '*') return true;
    return Array.isArray(po) && po.includes(workspace);
  }

  /**
   * GET /api/code-mgmt/state?workspace=...
   * Returns the "Drei Welten" summary for the calling user + workspace.
   */
  router.get('/state', async (req, res) => {
    const userId = req.user?.sub;
    const workspace = String(req.query.workspace || '').trim();
    if (!userId || !workspace) {
      res.status(400).json({ error: 'workspace query param required' });
      return;
    }
    if (userId === '__internal__') {
      // No authenticated user — return a "not available" stub instead of 4xx
      // so the dashboard renders cleanly on dev/no-auth setups.
      res.json({
        available: false,
        reason: 'Bitte melde dich an, um deinen Code-Stand zu sehen.',
        workspace, userId,
        proposalCounts: { pending: 0, approved: 0, rejected: 0, mine: 0 },
        myProposals: [],
        timeline: [],
      });
      return;
    }
    try {
      const state = await getCodeState(userId, workspace);
      res.json(state);
    } catch (err: any) {
      console.error('[code-mgmt] state failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/code-mgmt/proposals
   * Body: { workspace, title, description, force? }
   * Creates a patch from the user's local commits + working tree.
   *
   * Pre-flight conflict check: rejects if origin/develop has moved since
   * the user started, unless force=true.
   */
  router.post('/proposals', async (req, res) => {
    const userId = req.user?.sub;
    if (!userId || userId === '__internal__') {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    const userRecord = findUser(userId);
    const { workspace, title, description, force } = (req.body || {}) as {
      workspace?: string; title?: string; description?: string; force?: boolean;
    };
    if (!workspace || !title || !description) {
      res.status(400).json({ error: 'workspace, title and description are required' });
      return;
    }
    if (!repoExists(userId)) {
      res.status(404).json({ error: `Kein Repo für ${userId}` });
      return;
    }

    try {
      // Make sure we have a fresh view of origin/develop.
      try { await gitOut(['fetch', 'origin', 'develop', '--quiet'], { asUser: userId }); }
      catch (e: any) { console.warn('[code-mgmt] fetch failed (offline?):', e.message); }

      // Auto-commit any uncommitted work on the fly so format-patch sees it.
      const dirty = await gitOut(['status', '--porcelain'], { asUser: userId });
      if (dirty.trim()) {
        await runGit(['add', '-A'], { asUser: userId });
        await runGit(['-c', `user.email=${userRecord?.email || userId + '@partner.werking.tools'}`,
                      '-c', `user.name=${userRecord?.name || userId}`,
                      'commit', '-m', `Vorschlag: ${title}`], { asUser: userId });
      }

      const baseSha = await gitOut(['rev-parse', 'origin/develop'], { asUser: userId });
      const headSha = await gitOut(['rev-parse', 'HEAD'], { asUser: userId });
      const mergeBase = await gitOut(['merge-base', 'origin/develop', 'HEAD'], { asUser: userId });

      // Pre-flight: if origin/develop has commits not in our HEAD's history,
      // we'd produce a patch from a stale base. Warn unless force=true.
      const developAhead = parseInt(
        await gitOut(['rev-list', '--count', `${mergeBase}..origin/develop`], { asUser: userId }),
        10,
      ) || 0;

      if (developAhead > 0 && !force) {
        res.status(409).json({
          error: 'live-version-changed',
          message: `Die Live-Version hat sich um ${developAhead} Aktualisierungen weiterentwickelt seit du angefangen hast. Aktualisiere deine Testumgebung oder sende trotzdem.`,
          developAhead,
          baseSha: mergeBase.slice(0, 7),
          liveSha: baseSha.slice(0, 7),
        });
        return;
      }

      // Generate patch from merge-base..HEAD (covers all user-local commits).
      const patch = await gitOut(['format-patch', `${mergeBase}..HEAD`, '--stdout'], { asUser: userId });
      if (!patch.trim()) {
        res.status(400).json({ error: 'Keine Änderungen zu senden — deine Testumgebung ist identisch mit der Live-Version.' });
        return;
      }

      const filesChanged = patchFileList(patch);
      const linesChanged = patchLineCounts(patch);

      const id = newId(userId);
      const meta: ProposalMeta = {
        id, workspace,
        authorId: userId,
        authorName: userRecord?.name || userId,
        authorRole: userRecord?.role || (req.user?.role as string) || 'fachpartner',
        title, description,
        baseSha: mergeBase,
        headSha,
        filesChanged,
        linesChanged,
        createdAt: new Date().toISOString(),
        status: 'pending',
      };
      writeProposal(meta, patch);
      res.json({ ok: true, proposal: meta });
    } catch (err: any) {
      console.error('[code-mgmt] create proposal failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/code-mgmt/proposals?workspace=...&status=...&mine=1
   */
  router.get('/proposals', (req, res) => {
    const workspace = req.query.workspace ? String(req.query.workspace) : undefined;
    const status = req.query.status as ProposalMeta['status'] | undefined;
    const mine = req.query.mine === '1';
    let list = listProposals(workspace, status);
    if (mine && req.user?.sub) {
      list = list.filter(p => p.authorId === req.user!.sub);
    }
    res.json({ proposals: list });
  });

  /**
   * GET /api/code-mgmt/proposals/:workspace/:id
   * Returns metadata + patch + parsed file-tree summary.
   */
  router.get('/proposals/:workspace/:id', (req, res) => {
    const { workspace, id } = req.params;
    const meta = readMeta(workspace, id);
    if (!meta) { res.status(404).json({ error: 'Vorschlag nicht gefunden' }); return; }
    const patch = readPatch(workspace, id);
    res.json({ proposal: meta, patch });
  });

  /**
   * POST /api/code-mgmt/proposals/:workspace/:id/approve
   * Applies the patch in the PO's own repo and pushes to origin/develop.
   * Restricted to admin + the Product Owner of THIS workspace
   * (`productOwnerOf` field in users.json).
   */
  router.post('/proposals/:workspace/:id/approve', async (req, res) => {
    const decider = req.user?.sub;
    if (!decider || decider === '__internal__') {
      res.status(401).json({ error: 'Anmeldung erforderlich' });
      return;
    }
    const { workspace, id } = req.params;
    if (!isPoOfWorkspace(decider, workspace)) {
      res.status(403).json({ error: `Nur der Product Owner von ${workspace} darf Vorschläge übernehmen` });
      return;
    }
    const meta = readMeta(workspace, id);
    if (!meta) { res.status(404).json({ error: 'Vorschlag nicht gefunden' }); return; }
    if (meta.status !== 'pending') { res.status(409).json({ error: `Status ist bereits '${meta.status}'` }); return; }
    const patch = readPatch(workspace, id);
    if (!patch) { res.status(404).json({ error: 'Patch-Datei fehlt' }); return; }

    if (!repoExists(decider)) {
      res.status(404).json({ error: `Kein Repo unter /home/${decider}/projekte/werkingflow-production — Übernehmen nicht möglich` });
      return;
    }

    try {
      // 1. Make sure decider's repo is on develop and up-to-date.
      try { await runGit(['fetch', 'origin', 'develop', '--quiet'], { asUser: decider }); }
      catch (e: any) { console.warn('[code-mgmt] approve: fetch failed:', e.message); }

      const branchOut = await gitOut(['rev-parse', '--abbrev-ref', 'HEAD'], { asUser: decider });
      if (branchOut !== 'develop') {
        await runGit(['checkout', 'develop'], { asUser: decider });
      }
      await runGit(['pull', '--ff-only', 'origin', 'develop'], { asUser: decider });

      // 2. Apply patch via git am (preserves author).
      try {
        await runGit(['am', '--3way'], { asUser: decider, stdin: patch });
      } catch (err: any) {
        // Abort to leave repo clean if am failed.
        try { await runGit(['am', '--abort'], { asUser: decider }); } catch {}
        res.status(409).json({
          error: 'merge-konflikt',
          message: 'Der Vorschlag passt nicht mehr auf die aktuelle Live-Version. Bitte den Fachpartner um eine aktualisierte Variante.',
          gitError: err.message,
        });
        return;
      }

      // 3. Push to origin/develop.
      try {
        await runGit(['push', 'origin', 'develop'], { asUser: decider });
      } catch (err: any) {
        // Push failed — rewind to keep the local repo clean.
        const stepsBack = await gitOut(['rev-list', '--count', `origin/develop..HEAD`], { asUser: decider }).catch(() => '0');
        try { await runGit(['reset', '--hard', `HEAD~${stepsBack}`], { asUser: decider }); } catch {}
        res.status(500).json({ error: 'push-fehlgeschlagen', message: err.message });
        return;
      }

      const updated = updateStatus(workspace, id, 'approved', decider);
      res.json({ ok: true, proposal: updated });
    } catch (err: any) {
      console.error('[code-mgmt] approve failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/code-mgmt/proposals/:workspace/:id/reject
   * Body: { reason?: string }
   */
  router.post('/proposals/:workspace/:id/reject', (req, res) => {
    const decider = req.user?.sub;
    if (!decider || decider === '__internal__') {
      res.status(401).json({ error: 'Anmeldung erforderlich' });
      return;
    }
    const { workspace, id } = req.params;
    if (!isPoOfWorkspace(decider, workspace)) {
      res.status(403).json({ error: `Nur der Product Owner von ${workspace} darf Vorschläge ablehnen` });
      return;
    }
    const reason = (req.body?.reason as string | undefined) || '';
    const meta = readMeta(workspace, id);
    if (!meta) { res.status(404).json({ error: 'Vorschlag nicht gefunden' }); return; }
    if (meta.status !== 'pending') { res.status(409).json({ error: `Status ist bereits '${meta.status}'` }); return; }
    const updated = updateStatus(workspace, id, 'rejected', decider, reason);
    res.json({ ok: true, proposal: updated });
  });

  /**
   * POST /api/code-mgmt/reset
   * Body: { workspace, snapshot? }
   * Resets the user's repo to origin/develop, optionally creating a snapshot
   * branch first so they can recover. Snapshot branches are kept 7 days.
   */
  router.post('/reset', async (req, res) => {
    const userId = req.user?.sub;
    if (!userId || userId === '__internal__') {
      res.status(401).json({ error: 'Anmeldung erforderlich' });
      return;
    }
    if (!repoExists(userId)) {
      res.status(404).json({ error: `Kein Repo für ${userId}` });
      return;
    }
    const { snapshot } = (req.body || {}) as { workspace?: string; snapshot?: boolean };
    try {
      // Create a snapshot branch first if there's anything worth keeping.
      let snapshotName: string | null = null;
      if (snapshot !== false) {
        const ahead = parseInt(await gitOut(['rev-list', '--count', 'origin/develop..HEAD'], { asUser: userId }).catch(() => '0'), 10) || 0;
        const dirty = (await gitOut(['status', '--porcelain'], { asUser: userId }).catch(() => '')).trim();
        if (ahead > 0 || dirty) {
          // Commit any uncommitted work before tagging.
          if (dirty) {
            await runGit(['add', '-A'], { asUser: userId });
            await runGit(['-c', 'user.email=snapshot@partner.werking.tools', '-c', 'user.name=snapshot',
                          'commit', '-m', 'Auto-Snapshot vor Zurücksetzen'], { asUser: userId });
          }
          const ts = new Date().toISOString().replace(/[:.]/g, '-');
          snapshotName = `snapshot/${userId}/${ts}`;
          await runGit(['branch', snapshotName, 'HEAD'], { asUser: userId });
        }
      }
      await runGit(['fetch', 'origin', 'develop', '--quiet'], { asUser: userId });
      await runGit(['checkout', 'develop'], { asUser: userId });
      await runGit(['reset', '--hard', 'origin/develop'], { asUser: userId });
      res.json({ ok: true, snapshot: snapshotName });
    } catch (err: any) {
      console.error('[code-mgmt] reset failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/code-mgmt/snapshots
   * Lists snapshot/<userId>/* branches for the calling user (last 7 days).
   */
  router.get('/snapshots', async (req, res) => {
    const userId = req.user?.sub;
    if (!userId || userId === '__internal__') {
      res.status(401).json({ error: 'Anmeldung erforderlich' });
      return;
    }
    if (!repoExists(userId)) { res.json({ snapshots: [] }); return; }
    try {
      const out = await gitOut(['for-each-ref',
        '--format=%(refname:short)|%(committerdate:iso-strict)|%(subject)',
        `refs/heads/snapshot/${userId}`], { asUser: userId });
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const snapshots = out.split('\n').filter(Boolean).map(line => {
        const [ref, date, subject] = line.split('|');
        return { ref, date, subject };
      }).filter(s => Date.parse(s.date) > cutoff);
      res.json({ snapshots });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
