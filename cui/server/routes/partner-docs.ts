/**
 * Partner Docs Route — Self-service curated business document access for partners.
 *
 * Endpoints:
 *   GET    /api/partner/docs                    — List docs (admin: all, partner: published ∩ workspace-allowed)
 *   GET    /api/partner/docs/:docId             — Get doc content as Markdown (enforces workspace ACL)
 *   POST   /api/partner/docs                    — (Admin) Create a new doc entry
 *   PATCH  /api/partner/docs/:docId             — (Admin) Update doc metadata (title, category, path, workspaces)
 *   POST   /api/partner/docs/publish            — (Admin) Publish a doc
 *   DELETE /api/partner/docs/:docId             — (Admin) Unpublish a doc
 *   DELETE /api/partner/docs/:docId/permanent   — (Admin) Remove doc entry entirely
 *   GET    /api/partner/docs/workspaces         — (Admin) List available workspaces for the matrix UI
 *
 * Config: data/partner-docs.json — which docs exist, which are published, and per-doc workspace ACL.
 * Content: read from werkingflow-business/ paths, only if published AND workspace-allowed (or admin).
 */

import { Router } from 'express';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { requireRole } from '../auth/middleware.js';
import { findUser, isAuthEnabled } from '../auth/users.js';
import { PATHS } from '../config/paths.js';

// --- Types ---
export interface PartnerDoc {
  id: string;
  title: string;
  category: string;
  path: string;
  published: boolean;
  publishedAt?: string;
  /** Workspace IDs allowed to see this doc. ["*"] = all workspaces. */
  workspaces: string[];
}

interface DocsConfig {
  docs: PartnerDoc[];
}

// --- State ---
let DOCS_CONFIG_FILE: string;

function loadConfig(): DocsConfig {
  if (!existsSync(DOCS_CONFIG_FILE)) {
    throw new Error(`[partner-docs] Config file not found: ${DOCS_CONFIG_FILE}`);
  }
  try {
    return JSON.parse(readFileSync(DOCS_CONFIG_FILE, 'utf8'));
  } catch (err) {
    throw new Error(`[partner-docs] Failed to parse config: ${err}`);
  }
}

function saveConfig(config: DocsConfig): void {
  writeFileSync(DOCS_CONFIG_FILE, JSON.stringify(config, null, 2));
}

/** Check if a doc is visible in the given user-workspace set. */
function docMatchesWorkspaces(doc: PartnerDoc, userWorkspaces: string[] | '*'): boolean {
  // Wildcard user — sees everything
  if (userWorkspaces === '*') return true;
  // Wildcard doc — visible to any workspace
  if (doc.workspaces.includes('*')) return true;
  // Intersection
  return doc.workspaces.some(w => userWorkspaces.includes(w));
}

/** List all available workspaces by reading data/projects/. */
function listWorkspaces(): string[] {
  const projectsDir = join(PATHS.dataDir, 'projects');
  if (!existsSync(projectsDir)) return [];
  return readdirSync(projectsDir)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace(/\.json$/, ''))
    .sort();
}

// --- Router ---
const router = Router();

export function initPartnerDocsRouter(dataDir: string): void {
  DOCS_CONFIG_FILE = join(dataDir, 'partner-docs.json');
}

/** GET /api/partner/docs — list docs. Admin sees all, partner sees published ∩ workspace-allowed. */
router.get('/docs', (req, res) => {
  const config = loadConfig();
  const isAdmin = req.user?.role === 'admin' || req.user?.role === 'product-owner';

  let visibleDocs: PartnerDoc[];
  if (isAdmin) {
    // Admin sees all docs (incl. unpublished) with full metadata for the matrix UI
    visibleDocs = config.docs;
  } else if (!isAuthEnabled()) {
    // Auth disabled (dev mode) — expose published docs
    visibleDocs = config.docs.filter(d => d.published);
  } else {
    // Fachpartner — must be published AND workspace-allowed
    const user = req.user ? findUser(req.user.sub) : undefined;
    if (!user) {
      res.status(401).json({ error: 'User not found' });
      return;
    }
    visibleDocs = config.docs.filter(
      d => d.published && docMatchesWorkspaces(d, user.allowedWorkspaces)
    );
  }

  res.json({
    docs: visibleDocs.map(d => ({
      id: d.id,
      title: d.title,
      category: d.category,
      path: d.path,
      published: d.published,
      publishedAt: d.publishedAt,
      workspaces: d.workspaces,
    })),
  });
});

/** GET /api/partner/docs/workspaces — (Admin) list available workspaces for matrix UI. */
router.get('/docs/workspaces', requireRole('admin', 'product-owner'), (_req, res) => {
  res.json({ workspaces: listWorkspaces() });
});

/** GET /api/partner/docs/:docId — get doc Markdown content. */
router.get('/docs/:docId', (req, res) => {
  const config = loadConfig();
  const doc = config.docs.find(d => d.id === req.params.docId);

  if (!doc) {
    res.status(404).json({ error: 'Doc not found' });
    return;
  }

  const isAdmin = req.user?.role === 'admin' || req.user?.role === 'product-owner';

  if (!isAdmin) {
    if (!doc.published) {
      res.status(403).json({ error: 'Doc not published' });
      return;
    }
    if (isAuthEnabled()) {
      const user = req.user ? findUser(req.user.sub) : undefined;
      if (!user) {
        res.status(401).json({ error: 'User not found' });
        return;
      }
      if (!docMatchesWorkspaces(doc, user.allowedWorkspaces)) {
        res.status(403).json({ error: 'Doc not available in your workspace' });
        return;
      }
    }
  }

  if (!existsSync(doc.path)) {
    res.status(404).json({ error: `Source file not found: ${doc.path}` });
    return;
  }

  const content = readFileSync(doc.path, 'utf8');
  res.json({
    doc: {
      id: doc.id,
      title: doc.title,
      category: doc.category,
      path: doc.path,
      published: doc.published,
      publishedAt: doc.publishedAt,
      workspaces: doc.workspaces,
    },
    content,
  });
});

/** POST /api/partner/docs — (Admin) create a new doc entry. */
router.post('/docs', requireRole('admin', 'product-owner'), (req, res) => {
  const { id, title, category, path, workspaces } = req.body as Partial<PartnerDoc>;

  if (!id?.trim()) { res.status(400).json({ error: 'id is required' }); return; }
  if (!title?.trim()) { res.status(400).json({ error: 'title is required' }); return; }
  if (!category?.trim()) { res.status(400).json({ error: 'category is required' }); return; }
  if (!path?.trim()) { res.status(400).json({ error: 'path is required' }); return; }
  if (!Array.isArray(workspaces)) { res.status(400).json({ error: 'workspaces must be an array' }); return; }

  const config = loadConfig();
  if (config.docs.some(d => d.id === id.trim())) {
    res.status(409).json({ error: `Doc with id "${id}" already exists` });
    return;
  }

  if (!existsSync(path)) {
    res.status(400).json({ error: `Source file does not exist: ${path}` });
    return;
  }

  const doc: PartnerDoc = {
    id: id.trim(),
    title: title.trim(),
    category: category.trim(),
    path: path.trim(),
    published: false,
    workspaces: workspaces.map(w => String(w)),
  };
  config.docs.push(doc);
  saveConfig(config);

  res.status(201).json({ doc });
});

/** PATCH /api/partner/docs/:docId — (Admin) update doc metadata (incl. workspace ACL). */
router.patch('/docs/:docId', requireRole('admin', 'product-owner'), (req, res) => {
  const config = loadConfig();
  const doc = config.docs.find(d => d.id === req.params.docId);

  if (!doc) {
    res.status(404).json({ error: 'Doc not found' });
    return;
  }

  const { title, category, path, workspaces } = req.body as Partial<PartnerDoc>;

  if (title !== undefined) {
    if (typeof title !== 'string' || !title.trim()) {
      res.status(400).json({ error: 'title must be a non-empty string' });
      return;
    }
    doc.title = title.trim();
  }
  if (category !== undefined) {
    if (typeof category !== 'string' || !category.trim()) {
      res.status(400).json({ error: 'category must be a non-empty string' });
      return;
    }
    doc.category = category.trim();
  }
  if (path !== undefined) {
    if (typeof path !== 'string' || !path.trim()) {
      res.status(400).json({ error: 'path must be a non-empty string' });
      return;
    }
    if (!existsSync(path)) {
      res.status(400).json({ error: `Source file does not exist: ${path}` });
      return;
    }
    doc.path = path.trim();
  }
  if (workspaces !== undefined) {
    if (!Array.isArray(workspaces)) {
      res.status(400).json({ error: 'workspaces must be an array' });
      return;
    }
    doc.workspaces = workspaces.map(w => String(w));
  }

  saveConfig(config);
  res.json({ doc });
});

/** POST /api/partner/docs/publish — publish a doc (admin only). */
router.post('/docs/publish', requireRole('admin', 'product-owner'), (req, res) => {
  const { docId } = req.body as { docId?: string };

  if (!docId?.trim()) {
    res.status(400).json({ error: 'docId is required' });
    return;
  }

  const config = loadConfig();
  const doc = config.docs.find(d => d.id === docId.trim());

  if (!doc) {
    res.status(404).json({ error: 'Doc not found' });
    return;
  }

  doc.published = true;
  doc.publishedAt = new Date().toISOString();
  saveConfig(config);

  res.json({ doc });
});

/** DELETE /api/partner/docs/:docId — unpublish a doc (admin only). */
router.delete('/docs/:docId', requireRole('admin', 'product-owner'), (req, res) => {
  const config = loadConfig();
  const doc = config.docs.find(d => d.id === req.params.docId);

  if (!doc) {
    res.status(404).json({ error: 'Doc not found' });
    return;
  }

  doc.published = false;
  delete doc.publishedAt;
  saveConfig(config);

  res.json({ ok: true });
});

/** DELETE /api/partner/docs/:docId/permanent — remove doc entry entirely (admin only). */
router.delete('/docs/:docId/permanent', requireRole('admin', 'product-owner'), (req, res) => {
  const config = loadConfig();
  const idx = config.docs.findIndex(d => d.id === req.params.docId);

  if (idx === -1) {
    res.status(404).json({ error: 'Doc not found' });
    return;
  }

  config.docs.splice(idx, 1);
  saveConfig(config);

  res.json({ ok: true });
});

export default router;
