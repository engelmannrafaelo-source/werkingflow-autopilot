/**
 * Partner Docs Route — Self-service curated business document access for partners.
 *
 * Endpoints:
 *   GET    /api/partner/docs              — List docs (admin: all, partner: published only)
 *   GET    /api/partner/docs/:docId       — Get doc content as Markdown
 *   POST   /api/partner/docs/publish      — (Admin) Publish a doc
 *   DELETE /api/partner/docs/:docId       — (Admin) Unpublish a doc
 *
 * Config: data/partner-docs.json — which docs exist and which are published.
 * Content: read from werkingflow-business/ paths, only if published (or admin).
 */

import { Router } from 'express';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { requireRole } from '../auth/middleware.js';

// --- Types ---
export interface PartnerDoc {
  id: string;
  title: string;
  category: string;
  path: string;
  published: boolean;
  publishedAt?: string;
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

// --- Router ---
const router = Router();

export function initPartnerDocsRouter(dataDir: string): void {
  DOCS_CONFIG_FILE = join(dataDir, 'partner-docs.json');
}

/** GET /api/partner/docs — list docs. Admin sees all, partner sees published only. */
router.get('/docs', (req, res) => {
  const config = loadConfig();
  const isAdmin = req.user?.role === 'admin' || req.user?.role === 'product-owner';

  const docs = isAdmin ? config.docs : config.docs.filter(d => d.published);

  res.json({
    docs: docs.map(d => ({
      id: d.id,
      title: d.title,
      category: d.category,
      published: d.published,
      publishedAt: d.publishedAt,
    })),
  });
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
  if (!doc.published && !isAdmin) {
    res.status(403).json({ error: 'Doc not published' });
    return;
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
      published: doc.published,
      publishedAt: doc.publishedAt,
    },
    content,
  });
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

export default router;
