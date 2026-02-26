import { Router } from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import { createPatch } from 'diff';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const router = Router();

// --- Types ---
export interface DocumentEdit {
  id: string;
  documentPath: string;
  personaId: string;
  originalContent: string;
  proposedContent: string;
  diff: string;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  validationWarnings?: string[];
  createdAt: string;
  updatedAt: string;
}

// In-Memory Storage (MVP - später DB)
let edits: DocumentEdit[] = [];
let demoDataLoaded = false;

// Lazy-load demo reviews on first access
async function ensureDemoDataLoaded() {
  if (demoDataLoaded) return;
  demoDataLoaded = true;

  try {
    const demoPath = '/root/projekte/werkingflow/autopilot/cui/data/active/team/reviews.json';
    const content = await fs.readFile(demoPath, 'utf-8');
    const data = JSON.parse(content);
    const demoReviews = Array.isArray(data) ? data : (data.reviews || []);
    edits.push(...demoReviews);
    console.log(`[DocumentManager] Loaded ${demoReviews.length} demo reviews from ${demoPath}`);
  } catch (err) {
    console.warn('[DocumentManager] Could not load demo reviews:', err);
  }
}

// WebSocket clients for live updates
const wsClients: Set<any> = new Set();

export function registerWebSocketClient(ws: any) {
  wsClients.add(ws);
  ws.on('close', () => wsClients.delete(ws));
}

function broadcast(message: any) {
  const payload = JSON.stringify(message);
  wsClients.forEach(ws => {
    if (ws.readyState === 1) { // WebSocket.OPEN
      ws.send(payload);
    }
  });
}

// --- Business Document Scanner ---
async function scanBusinessDocs(basePath: string): Promise<Array<{path: string; name: string; size: number}>> {
  const docs: Array<{path: string; name: string; size: number}> = [];

  async function scan(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await scan(fullPath);
      } else if (entry.name.endsWith('.md') || entry.name.endsWith('.txt')) {
        const stats = await fs.stat(fullPath);
        docs.push({
          path: fullPath.replace(basePath + '/', ''),
          name: entry.name,
          size: stats.size
        });
      }
    }
  }

  await scan(basePath);
  return docs;
}

// --- Validation (Anti-Hallucination) ---
interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

function extractNumbers(content: string): string[] {
  const matches = content.match(/EUR\s*[\d.,]+k?/gi) || [];
  return matches.map(m => m.replace(/\s+/g, '').toUpperCase());
}

function extractRoutes(content: string): string[] {
  const matches = content.match(/\/api\/[\w/-]+/g) || [];
  return [...new Set(matches)];
}

async function validateBusinessDocEdit(
  docPath: string,
  originalContent: string,
  proposedContent: string
): Promise<ValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Zahlen-Validation (EUR-Beträge)
  const originalNumbers = extractNumbers(originalContent);
  const proposedNumbers = extractNumbers(proposedContent);

  for (const num of proposedNumbers) {
    if (!originalNumbers.includes(num)) {
      warnings.push(`⚠️ Neue Zahl gefunden: ${num} - Bitte verifizieren!`);
    }
  }

  // 2. Route-Validation (wenn FEATURES.md)
  if (docPath.includes('FEATURES.md')) {
    const proposedRoutes = extractRoutes(proposedContent);

    // Lade Route Registry
    try {
      const registryPath = '/root/projekte/werkingflow/platform/src/registry/routes.json';
      const registryContent = await fs.readFile(registryPath, 'utf-8');
      const registry = JSON.parse(registryContent);
      const validRoutes = registry.routes || [];

      for (const route of proposedRoutes) {
        if (!validRoutes.includes(route)) {
          errors.push(`❌ Route ${route} existiert nicht in Registry!`);
        }
      }
    } catch (err) {
      warnings.push('⚠️ Route Registry nicht gefunden - Konnte Routes nicht validieren');
    }
  }

  // 3. Größencheck (verdächtige Dokument-Explosionen)
  const originalSize = Buffer.byteLength(originalContent, 'utf-8');
  const proposedSize = Buffer.byteLength(proposedContent, 'utf-8');

  if (proposedSize > originalSize * 3) {
    warnings.push(`⚠️ Dokument-Größe verdreifacht (${originalSize} → ${proposedSize} bytes)`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

// --- API Endpoints ---

// GET /api/team/documents - Liste aller Business-Dokumente
router.get('/documents', async (req, res) => {
  try {
    const businessPath = '/root/projekte/werkingflow/business';
    const docs = await scanBusinessDocs(businessPath);
    res.json(docs);
  } catch (err: any) {
    console.error('[DocumentManager] Scan error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/team/documents/read - Dokument-Inhalt lesen (Query: ?path=...)
router.get('/documents/read', async (req, res) => {
  try {
    const relativePath = req.query.path as string;

    if (!relativePath) {
      return res.status(400).json({ error: 'Missing path query parameter' });
    }
    const docPath = path.join('/root/projekte/werkingflow/business', relativePath);

    // Security: Verhindere Path Traversal
    if (!docPath.startsWith('/root/projekte/werkingflow/business')) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const content = await fs.readFile(docPath, 'utf-8');
    res.type('text/markdown').send(content);
  } catch (err: any) {
    console.error('[DocumentManager] Read error:', err);
    res.status(404).json({ error: 'Document not found' });
  }
});

// POST /api/team/documents/edit - Edit vorschlagen (NICHT direkt schreiben!)
router.post('/documents/edit', async (req, res) => {
  try {
    const { path: relativePath, personaId, proposedContent, reason } = req.body;

    if (!relativePath || !personaId || !proposedContent || !reason) {
      return res.status(400).json({ error: 'Missing required fields: path, personaId, proposedContent, reason' });
    }

    const docPath = path.join('/root/projekte/werkingflow/business', relativePath);

    // Security Check
    if (!docPath.startsWith('/root/projekte/werkingflow/business')) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // CRITICAL: Nicht direkt schreiben!
    const originalContent = await fs.readFile(docPath, 'utf-8');

    // Validation
    const validation = await validateBusinessDocEdit(docPath, originalContent, proposedContent);

    if (!validation.valid) {
      return res.status(400).json({
        error: 'Validation failed',
        errors: validation.errors,
        warnings: validation.warnings
      });
    }

    // Diff erstellen
    const diff = createPatch(
      relativePath,
      originalContent,
      proposedContent,
      'Original',
      'Proposed by ' + personaId
    );

    const edit: DocumentEdit = {
      id: Date.now().toString(),
      documentPath: docPath,
      personaId,
      originalContent,
      proposedContent,
      diff,
      reason,
      status: 'pending',
      validationWarnings: validation.warnings,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    edits.push(edit);

    // Broadcast via WebSocket
    broadcast({ type: 'document-edit-pending', edit });

    res.json(edit);
  } catch (err: any) {
    console.error('[DocumentManager] Edit error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/team/reviews - Pending Reviews
router.get('/reviews', async (req, res) => {
  const logDebug = (msg: string) => {
    console.log(msg);
    require('fs').appendFileSync('/tmp/review-debug.log', `${new Date().toISOString()} ${msg}\n`);
  };

  logDebug(`[DocumentManager] GET /reviews - edits.length BEFORE: ${edits.length}`);
  await ensureDemoDataLoaded();
  logDebug(`[DocumentManager] GET /reviews - edits.length AFTER: ${edits.length}`);
  const pending = edits.filter(e => e.status === 'pending');
  logDebug(`[DocumentManager] Returning ${pending.length} pending reviews`);
  res.json(pending);
});

// GET /api/team/reviews/:id - Spezifisches Review
router.get('/reviews/:id', (req, res) => {
  const edit = edits.find(e => e.id === req.params.id);
  if (!edit) return res.status(404).json({ error: 'Review not found' });
  res.json(edit);
});

// POST /api/team/reviews/:id/approve - Review approven und committen
router.post('/reviews/:id/approve', async (req, res) => {
  try {
    const edit = edits.find(e => e.id === req.params.id);
    if (!edit) return res.status(404).json({ error: 'Review not found' });

    if (edit.status !== 'pending') {
      return res.status(400).json({ error: 'Review already processed' });
    }

    // Apply Patch
    await fs.writeFile(edit.documentPath, edit.proposedContent, 'utf-8');

    edit.status = 'approved';
    edit.updatedAt = new Date().toISOString();

    // Git Commit
    const relPath = edit.documentPath.replace('/root/projekte/werkingflow/', '');
    const commitMsg = `docs: ${edit.personaId} updated ${path.basename(edit.documentPath)}

${edit.reason}

Co-Authored-By: ${edit.personaId} (Virtual Persona)`;

    await execAsync(`cd /root/projekte/werkingflow && git add ${relPath}`);
    await execAsync(`cd /root/projekte/werkingflow && git commit -m "${commitMsg.replace(/"/g, '\\"')}"`);

    // Broadcast
    broadcast({ type: 'document-edit-approved', edit });

    res.json(edit);
  } catch (err: any) {
    console.error('[DocumentManager] Approve error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/team/reviews/:id/reject - Review ablehnen
router.post('/reviews/:id/reject', async (req, res) => {
  try {
    const edit = edits.find(e => e.id === req.params.id);
    if (!edit) return res.status(404).json({ error: 'Review not found' });

    if (edit.status !== 'pending') {
      return res.status(400).json({ error: 'Review already processed' });
    }

    edit.status = 'rejected';
    edit.updatedAt = new Date().toISOString();

    // Broadcast
    broadcast({ type: 'document-edit-rejected', edit });

    res.json(edit);
  } catch (err: any) {
    console.error('[DocumentManager] Reject error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
