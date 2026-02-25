// FRESHNESS_INDEX.json → KNOWLEDGE_REGISTRY.json Migration
// Created: 2026-02-19
import { promises as fs } from 'fs';
import { join } from 'path';
const FRESHNESS_INDEX_PATH = '/root/projekte/orchestrator/team/FRESHNESS_INDEX.json';
const KNOWLEDGE_REGISTRY_PATH = '/root/projekte/orchestrator/team/KNOWLEDGE_REGISTRY.json';
const BUSINESS_PATH = '/root/projekte/werkingflow/business';
const OWNER_TO_PERSONA_MAP = {
    'rafael': 'rafael',
    'mira': 'mira',
    'vera': 'vera',
    'max': 'max',
    'herbert': 'herbert',
    'finn': 'finn',
    'felix': 'felix',
    'otto': 'otto',
    'klaus': 'klaus',
    'sarah': 'sarah',
    'lisa': 'lisa',
    'tim': 'tim',
    'anna': 'anna',
    'peter': 'peter',
    'chris': 'chris',
};
export async function migrateFreshnessIndex() {
    console.log('[Migration] Starting FRESHNESS_INDEX → KNOWLEDGE_REGISTRY migration...');
    let migratedCount = 0;
    let preservedAssignments = 0;
    try {
        // 1. Load FRESHNESS_INDEX.json
        const freshnessContent = await fs.readFile(FRESHNESS_INDEX_PATH, 'utf-8');
        const freshnessIndex = JSON.parse(freshnessContent);
        console.log(`[Migration] Found ${Object.keys(freshnessIndex.documents).length} documents in FRESHNESS_INDEX`);
        // 2. Create empty KNOWLEDGE_REGISTRY
        const registry = {
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
        // 3. Migrate each document
        for (const [docPath, freshnessDoc] of Object.entries(freshnessIndex.documents)) {
            // Normalize path: "business/shared/VISION.md" → "shared/VISION.md"
            const normalizedPath = docPath.replace(/^business\//, '');
            const absolutePath = join(BUSINESS_PATH, normalizedPath);
            // Check if file exists
            try {
                const stats = await fs.stat(absolutePath);
                // Extract category from path
                const category = extractCategory(normalizedPath);
                // Create DocumentKnowledge
                const docKnowledge = {
                    path: normalizedPath,
                    absolute_path: absolutePath,
                    filename: normalizedPath.split('/').pop() || '',
                    category,
                    size_bytes: stats.size,
                    last_modified: stats.mtime.toISOString(),
                    last_scanned: '', // Not yet scanned by AI
                    content_summary: '',
                    topics: [],
                    document_type: 'other',
                    assignments: [],
                    // Legacy fields
                    owner: freshnessDoc.owner,
                    max_age_days: freshnessDoc.max_age_days,
                    status: freshnessDoc.status,
                    change_history: [],
                };
                // Map owner to persona ID
                const personaId = OWNER_TO_PERSONA_MAP[freshnessDoc.owner.toLowerCase()];
                if (personaId) {
                    // Create manual assignment from owner
                    docKnowledge.assignments.push({
                        persona_id: personaId,
                        confidence: 100,
                        reason: `Migrated from FRESHNESS_INDEX.json owner field`,
                        relevance: 'primary',
                        assigned_at: freshnessDoc.last_updated,
                        assigned_by: 'manual',
                    });
                    preservedAssignments++;
                }
                // Add migration note to change history
                docKnowledge.change_history.push({
                    timestamp: new Date().toISOString(),
                    change_type: 'created',
                    details: `Migrated from FRESHNESS_INDEX.json (owner: ${freshnessDoc.owner}, status: ${freshnessDoc.status})`,
                });
                if (freshnessDoc.note) {
                    docKnowledge.change_history.push({
                        timestamp: freshnessDoc.last_updated,
                        change_type: 'modified',
                        details: freshnessDoc.note,
                    });
                }
                registry.documents[normalizedPath] = docKnowledge;
                migratedCount++;
                console.log(`[Migration] ✓ Migrated: ${normalizedPath} (owner: ${freshnessDoc.owner})`);
            }
            catch (err) {
                console.warn(`[Migration] ⚠️  Skipping ${normalizedPath}: file not found`);
            }
        }
        // 4. Build PersonaKnowledge for all personas
        await buildPersonaKnowledge(registry);
        // 5. Update scan stats
        updateScanStats(registry);
        // 6. Save KNOWLEDGE_REGISTRY.json
        await fs.writeFile(KNOWLEDGE_REGISTRY_PATH, JSON.stringify(registry, null, 2), 'utf-8');
        console.log(`[Migration] ✓ Saved KNOWLEDGE_REGISTRY.json`);
        // 7. Backup FRESHNESS_INDEX.json
        await fs.copyFile(FRESHNESS_INDEX_PATH, FRESHNESS_INDEX_PATH.replace('.json', '.backup.json'));
        console.log(`[Migration] ✓ Backed up FRESHNESS_INDEX.json`);
        console.log(`[Migration] Migration complete: ${migratedCount} documents, ${preservedAssignments} assignments preserved`);
        return {
            migrated_count: migratedCount,
            preserved_assignments: preservedAssignments,
        };
    }
    catch (err) {
        console.error('[Migration] Error:', err);
        throw err;
    }
}
function extractCategory(relativePath) {
    const parts = relativePath.split('/');
    const category = parts[0];
    const validCategories = [
        'shared',
        'marketing',
        'sales',
        'customer-success',
        'legal',
        'finance',
        'foerderung',
    ];
    return validCategories.includes(category)
        ? category
        : 'shared';
}
async function buildPersonaKnowledge(registry) {
    // Build persona knowledge from document assignments
    const personaMap = new Map();
    // Initialize from document assignments
    for (const doc of Object.values(registry.documents)) {
        for (const assignment of doc.assignments) {
            if (!personaMap.has(assignment.persona_id)) {
                personaMap.set(assignment.persona_id, {
                    persona_id: assignment.persona_id,
                    name: '', // Will be filled from persona .md later
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
                });
            }
            const persona = personaMap.get(assignment.persona_id);
            if (assignment.relevance === 'primary') {
                persona.primary_documents.push(doc.path);
            }
            else if (assignment.relevance === 'secondary') {
                persona.secondary_documents.push(doc.path);
            }
            persona.total_document_count++;
        }
    }
    // Convert map to registry
    for (const [personaId, personaKnowledge] of personaMap.entries()) {
        registry.personas[personaId] = personaKnowledge;
    }
}
function updateScanStats(registry) {
    const stats = registry.scan_stats;
    // Reset counters
    stats.total_documents = Object.keys(registry.documents).length;
    stats.total_assignments = 0;
    stats.by_category = {
        shared: 0,
        marketing: 0,
        sales: 0,
        'customer-success': 0,
        legal: 0,
        finance: 0,
        foerderung: 0,
    };
    stats.by_confidence = { high: 0, medium: 0, low: 0 };
    stats.unassigned = 0;
    stats.pending_review = 0;
    // Count
    for (const doc of Object.values(registry.documents)) {
        stats.by_category[doc.category]++;
        if (doc.assignments.length === 0) {
            stats.unassigned++;
        }
        else {
            stats.total_assignments += doc.assignments.length;
            for (const assignment of doc.assignments) {
                if (assignment.confidence >= 80) {
                    stats.by_confidence.high++;
                }
                else if (assignment.confidence >= 50) {
                    stats.by_confidence.medium++;
                    stats.pending_review++;
                }
                else {
                    stats.by_confidence.low++;
                }
            }
        }
    }
}
