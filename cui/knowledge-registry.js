// Knowledge Registry API Endpoints
// Created: 2026-02-19
import { Router } from 'express';
import { promises as fs } from 'fs';
import { migrateFreshnessIndex } from './migrate-freshness-index.js';
import { performFullScan, performIncrementalScan } from './knowledge-scanner.js';
const router = Router();
const REGISTRY_PATH = '/root/projekte/orchestrator/team/KNOWLEDGE_REGISTRY.json';
// --- GET /api/team/knowledge/registry ---
router.get('/registry', async (req, res) => {
    try {
        const registry = await loadRegistry();
        res.json(registry);
    }
    catch (err) {
        console.error('[KnowledgeRegistry] Load error:', err);
        res.status(500).json({ error: err.message });
    }
});
// --- GET /api/team/knowledge/persona/:id ---
router.get('/persona/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const registry = await loadRegistry();
        const personaKnowledge = registry.personas[id];
        if (!personaKnowledge) {
            return res.status(404).json({ error: 'Persona not found' });
        }
        // Build document details
        const documents = {
            primary: personaKnowledge.primary_documents
                .map((path) => registry.documents[path])
                .filter(Boolean),
            secondary: personaKnowledge.secondary_documents
                .map((path) => registry.documents[path])
                .filter(Boolean),
        };
        const response = {
            persona: personaKnowledge,
            documents,
            stats: {
                primary_count: documents.primary.length,
                secondary_count: documents.secondary.length,
                total: documents.primary.length + documents.secondary.length,
            },
        };
        res.json(response);
    }
    catch (err) {
        console.error('[KnowledgeRegistry] Persona query error:', err);
        res.status(500).json({ error: err.message });
    }
});
// --- GET /api/team/knowledge/document ---
router.get('/document', async (req, res) => {
    try {
        const { path: docPath } = req.query;
        if (!docPath) {
            return res.status(400).json({ error: 'Missing path parameter' });
        }
        const registry = await loadRegistry();
        const doc = registry.documents[docPath];
        if (!doc) {
            return res.status(404).json({ error: 'Document not in registry' });
        }
        res.json(doc);
    }
    catch (err) {
        console.error('[KnowledgeRegistry] Document query error:', err);
        res.status(500).json({ error: err.message });
    }
});
// --- POST /api/team/knowledge/scan ---
router.post('/scan', async (req, res) => {
    try {
        const { mode, files, auto_assign = false } = req.body;
        if (mode === 'full') {
            const result = await performFullScan(auto_assign);
            res.json(result);
        }
        else if (mode === 'incremental') {
            if (!files || files.length === 0) {
                return res.status(400).json({ error: 'files array required for incremental scan' });
            }
            const result = await performIncrementalScan(files, auto_assign);
            res.json(result);
        }
        else {
            res.status(400).json({ error: 'Invalid mode: must be "full" or "incremental"' });
        }
    }
    catch (err) {
        console.error('[KnowledgeRegistry] Scan error:', err);
        // NEVER expose internal paths to client
        const safeError = err.message.replace(/\/root\/projekte\//g, '/');
        res.status(500).json({
            error: 'Scan failed',
            details: safeError,
            timestamp: new Date().toISOString(),
        });
    }
});
// --- POST /api/team/knowledge/assign ---
router.post('/assign', async (req, res) => {
    try {
        const { document_path, persona_id, relevance, reason } = req.body;
        if (!document_path || !persona_id || !relevance) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        // Validate persona exists
        const personaFile = `/root/projekte/orchestrator/team/personas/${persona_id}.md`;
        try {
            await fs.access(personaFile);
        }
        catch {
            return res.status(404).json({ error: `Persona ${persona_id} not found` });
        }
        const registry = await loadRegistry();
        // Validate document exists
        if (!registry.documents[document_path]) {
            return res.status(404).json({ error: 'Document not found in registry' });
        }
        // Add manual assignment
        const assignment = {
            persona_id,
            confidence: 100, // Manual = 100%
            reason: reason || 'Manual assignment',
            relevance,
            assigned_at: new Date().toISOString(),
            assigned_by: 'manual',
        };
        // Remove existing assignment for same persona if present
        registry.documents[document_path].assignments = registry.documents[document_path].assignments.filter((a) => a.persona_id !== persona_id);
        registry.documents[document_path].assignments.push(assignment);
        // Update persona knowledge
        updatePersonaKnowledge(registry, document_path, persona_id, relevance);
        // Save registry
        await saveRegistry(registry);
        res.json({ success: true, assignment });
    }
    catch (err) {
        console.error('[KnowledgeRegistry] Assignment error:', err);
        res.status(500).json({ error: err.message });
    }
});
// --- GET /api/team/knowledge/stats ---
router.get('/stats', async (req, res) => {
    try {
        const registry = await loadRegistry();
        res.json(registry.scan_stats);
    }
    catch (err) {
        console.error('[KnowledgeRegistry] Stats error:', err);
        res.status(500).json({ error: err.message });
    }
});
// --- POST /api/team/knowledge/migrate-freshness-index ---
router.post('/migrate-freshness-index', async (req, res) => {
    try {
        const result = await migrateFreshnessIndex();
        res.json({
            success: true,
            ...result,
        });
    }
    catch (err) {
        console.error('[Migration] Error:', err);
        res.status(500).json({ error: err.message });
    }
});
// --- Helper Functions ---
async function loadRegistry() {
    try {
        const content = await fs.readFile(REGISTRY_PATH, 'utf-8');
        return JSON.parse(content);
    }
    catch (err) {
        if (err.code === 'ENOENT') {
            // Return empty registry if not exists
            return {
                version: '1.0.0',
                last_full_scan: '',
                last_incremental_scan: '',
                documents: {},
                personas: {},
                scan_stats: {
                    total_documents: 0,
                    total_assignments: 0,
                    by_category: {
                        shared: 0,
                        marketing: 0,
                        sales: 0,
                        'customer-success': 0,
                        legal: 0,
                        finance: 0,
                        foerderung: 0,
                    },
                    by_confidence: { high: 0, medium: 0, low: 0 },
                    unassigned: 0,
                    pending_review: 0,
                },
            };
        }
        throw err;
    }
}
async function saveRegistry(registry) {
    await fs.writeFile(REGISTRY_PATH, JSON.stringify(registry, null, 2), 'utf-8');
}
function updatePersonaKnowledge(registry, documentPath, personaId, relevance) {
    if (!registry.personas[personaId]) {
        registry.personas[personaId] = {
            persona_id: personaId,
            name: '',
            role: '',
            department: '',
            table: '',
            primary_documents: [],
            secondary_documents: [],
            total_document_count: 0,
            expertise_keywords: [],
            primary_paths: [],
            secondary_paths: [],
            important_files: [],
            last_updated: new Date().toISOString(),
        };
    }
    const persona = registry.personas[personaId];
    // Remove from all arrays first
    persona.primary_documents = persona.primary_documents.filter((p) => p !== documentPath);
    persona.secondary_documents = persona.secondary_documents.filter((p) => p !== documentPath);
    // Add to appropriate array
    if (relevance === 'primary') {
        persona.primary_documents.push(documentPath);
    }
    else if (relevance === 'secondary') {
        persona.secondary_documents.push(documentPath);
    }
    // Update count
    persona.total_document_count =
        persona.primary_documents.length + persona.secondary_documents.length;
    persona.last_updated = new Date().toISOString();
}
export default router;
