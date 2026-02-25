// Document Scanner - Full and Incremental
// Created: 2026-02-19
import { promises as fs } from 'fs';
import { join } from 'path';
import { batchClassifyDocuments } from './knowledge-classifier.js';
const BUSINESS_PATH = '/root/projekte/werkingflow/business';
const PERSONAS_PATH = '/root/projekte/orchestrator/team/personas';
const REGISTRY_PATH = '/root/projekte/orchestrator/team/KNOWLEDGE_REGISTRY.json';
export async function performFullScan(autoAssign) {
    const startTime = Date.now();
    const result = {
        scanned_count: 0,
        classified_count: 0,
        auto_assigned_count: 0,
        pending_review_count: 0,
        errors: [],
        duration_ms: 0,
    };
    try {
        console.log('[Scanner] Starting full scan...');
        // 1. Load registry
        const registry = await loadRegistry();
        // 2. Load personas
        const personas = await loadPersonaProfiles();
        console.log(`[Scanner] Loaded ${personas.length} persona profiles`);
        // 3. Scan business folder
        const documents = await scanBusinessFolder();
        result.scanned_count = documents.length;
        console.log(`[Scanner] Found ${documents.length} documents`);
        // 4. Generate document summaries
        const documentsWithSummaries = await Promise.all(documents.map(async (doc) => {
            try {
                const content = await fs.readFile(doc.absolute_path, 'utf-8');
                return {
                    ...doc,
                    summary: extractSmartSummary(content),
                    content_length: content.length,
                };
            }
            catch (err) {
                result.errors.push({ file: doc.path, error: `Failed to read: ${err.message}` });
                return null;
            }
        }));
        const validDocuments = documentsWithSummaries.filter(Boolean);
        // 5. Batch classify via AI Bridge
        console.log('[Scanner] Classifying documents via AI Bridge...');
        const classifications = await batchClassifyDocuments(validDocuments.map((d) => ({
            path: d.path,
            summary: d.summary,
            filename: d.filename,
            category: d.category,
        })), personas);
        result.classified_count = Object.keys(classifications).length;
        // 6. Update registry
        for (const doc of validDocuments) {
            const classification = classifications[doc.path];
            if (!classification)
                continue;
            // Create or update document knowledge
            const docKnowledge = registry.documents[doc.path] || {
                path: doc.path,
                absolute_path: doc.absolute_path,
                filename: doc.filename,
                category: doc.category,
                size_bytes: doc.size_bytes,
                last_modified: doc.last_modified,
                last_scanned: new Date().toISOString(),
                content_summary: classification.summary,
                topics: classification.topics,
                document_type: classification.document_type,
                assignments: [],
                change_history: [],
            };
            // Update with new classification
            docKnowledge.last_scanned = new Date().toISOString();
            docKnowledge.content_summary = classification.summary;
            docKnowledge.topics = classification.topics;
            docKnowledge.document_type = classification.document_type;
            // Process assignments
            for (const assignment of classification.assignments) {
                if (autoAssign && assignment.confidence >= 80) {
                    // Remove existing AI assignments for this persona
                    docKnowledge.assignments = docKnowledge.assignments.filter((a) => !(a.persona_id === assignment.persona_id && a.assigned_by === 'ai'));
                    docKnowledge.assignments.push({
                        ...assignment,
                        assigned_at: new Date().toISOString(),
                        assigned_by: 'ai',
                    });
                    updatePersonaKnowledge(registry, doc.path, assignment.persona_id, assignment.relevance);
                    result.auto_assigned_count++;
                }
                else if (assignment.confidence >= 50 && assignment.confidence < 80) {
                    result.pending_review_count++;
                }
            }
            // Add scan to change history
            if (!docKnowledge.change_history)
                docKnowledge.change_history = [];
            docKnowledge.change_history.push({
                timestamp: new Date().toISOString(),
                change_type: 'scanned',
                details: `Full scan classified with ${classification.assignments.length} assignments`,
            });
            registry.documents[doc.path] = docKnowledge;
        }
        // 7. Update scan stats
        registry.last_full_scan = new Date().toISOString();
        updateScanStats(registry);
        // 8. Save registry
        await saveRegistry(registry);
        console.log('[Scanner] Full scan complete');
    }
    catch (err) {
        console.error('[Scanner] Full scan error:', err);
        result.errors.push({ file: 'SYSTEM', error: err.message });
    }
    result.duration_ms = Date.now() - startTime;
    return result;
}
export async function performIncrementalScan(files, autoAssign) {
    const startTime = Date.now();
    const result = {
        scanned_count: files.length,
        classified_count: 0,
        auto_assigned_count: 0,
        pending_review_count: 0,
        errors: [],
        duration_ms: 0,
    };
    try {
        console.log(`[Scanner] Starting incremental scan for ${files.length} files`);
        const registry = await loadRegistry();
        const personas = await loadPersonaProfiles();
        // Build document list for specified files
        const documents = [];
        for (const relativePath of files) {
            const absolutePath = join(BUSINESS_PATH, relativePath);
            try {
                const stats = await fs.stat(absolutePath);
                const content = await fs.readFile(absolutePath, 'utf-8');
                documents.push({
                    path: relativePath,
                    absolute_path: absolutePath,
                    filename: relativePath.split('/').pop() || '',
                    category: extractCategory(relativePath),
                    size_bytes: stats.size,
                    last_modified: stats.mtime.toISOString(),
                    summary: extractSmartSummary(content),
                });
            }
            catch (err) {
                result.errors.push({ file: relativePath, error: `File not found: ${err.message}` });
            }
        }
        if (documents.length === 0) {
            result.duration_ms = Date.now() - startTime;
            return result;
        }
        // Classify
        const classifications = await batchClassifyDocuments(documents.map((d) => ({
            path: d.path,
            summary: d.summary,
            filename: d.filename,
            category: d.category,
        })), personas);
        result.classified_count = Object.keys(classifications).length;
        // Update registry (same logic as full scan)
        for (const doc of documents) {
            const classification = classifications[doc.path];
            if (!classification)
                continue;
            const docKnowledge = registry.documents[doc.path] || {
                path: doc.path,
                absolute_path: doc.absolute_path,
                filename: doc.filename,
                category: doc.category,
                size_bytes: doc.size_bytes,
                last_modified: doc.last_modified,
                last_scanned: new Date().toISOString(),
                content_summary: classification.summary,
                topics: classification.topics,
                document_type: classification.document_type,
                assignments: [],
                change_history: [],
            };
            docKnowledge.last_scanned = new Date().toISOString();
            docKnowledge.content_summary = classification.summary;
            docKnowledge.topics = classification.topics;
            docKnowledge.document_type = classification.document_type;
            for (const assignment of classification.assignments) {
                if (autoAssign && assignment.confidence >= 80) {
                    docKnowledge.assignments = docKnowledge.assignments.filter((a) => !(a.persona_id === assignment.persona_id && a.assigned_by === 'ai'));
                    docKnowledge.assignments.push({
                        ...assignment,
                        assigned_at: new Date().toISOString(),
                        assigned_by: 'ai',
                    });
                    updatePersonaKnowledge(registry, doc.path, assignment.persona_id, assignment.relevance);
                    result.auto_assigned_count++;
                }
                else if (assignment.confidence >= 50 && assignment.confidence < 80) {
                    result.pending_review_count++;
                }
            }
            if (!docKnowledge.change_history)
                docKnowledge.change_history = [];
            docKnowledge.change_history.push({
                timestamp: new Date().toISOString(),
                change_type: 'scanned',
                details: `Incremental scan`,
            });
            registry.documents[doc.path] = docKnowledge;
        }
        registry.last_incremental_scan = new Date().toISOString();
        updateScanStats(registry);
        await saveRegistry(registry);
        console.log('[Scanner] Incremental scan complete');
    }
    catch (err) {
        console.error('[Scanner] Incremental scan error:', err);
        result.errors.push({ file: 'SYSTEM', error: err.message });
    }
    result.duration_ms = Date.now() - startTime;
    return result;
}
async function scanBusinessFolder() {
    const documents = [];
    async function scan(dir, relativePath = '') {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = join(dir, entry.name);
            const relPath = relativePath ? join(relativePath, entry.name) : entry.name;
            if (entry.isDirectory()) {
                if (!['archive', '_archiv', 'node_modules'].includes(entry.name)) {
                    await scan(fullPath, relPath);
                }
            }
            else if (entry.name.endsWith('.md') || entry.name.endsWith('.txt')) {
                const stats = await fs.stat(fullPath);
                const category = extractCategory(relPath);
                documents.push({
                    path: relPath,
                    absolute_path: fullPath,
                    filename: entry.name,
                    category,
                    size_bytes: stats.size,
                    last_modified: stats.mtime.toISOString(),
                });
            }
        }
    }
    await scan(BUSINESS_PATH);
    return documents;
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
function extractSmartSummary(content) {
    const maxLength = 1000;
    if (content.length <= maxLength)
        return content;
    const truncated = content.slice(0, maxLength);
    const lastPeriod = truncated.lastIndexOf('.');
    const lastNewline = truncated.lastIndexOf('\n');
    const cutoff = Math.max(lastPeriod, lastNewline);
    return cutoff > maxLength * 0.8 ? truncated.slice(0, cutoff + 1) : truncated + '...';
}
export async function loadPersonaProfiles() {
    const files = await fs.readdir(PERSONAS_PATH);
    const profiles = [];
    for (const file of files) {
        if (!file.endsWith('.md'))
            continue;
        const personaId = file.replace('.md', '').split('-')[0]; // 'max-weber.md' → 'max'
        const content = await fs.readFile(join(PERSONAS_PATH, file), 'utf-8');
        const profile = parsePersonaProfile(personaId, content);
        if (profile)
            profiles.push(profile);
    }
    return profiles;
}
function parsePersonaProfile(id, content) {
    const nameMatch = content.match(/^# (.+?) - (.+)/m);
    const roleMatch = content.match(/\*\*Rolle\*\*:\s*(.+)/);
    const deptMatch = content.match(/\*\*Department\*\*:\s*(.+)/);
    if (!nameMatch || !roleMatch)
        return null;
    // Extract expertise from "Spezialgebiet" line
    const expertiseMatch = content.match(/\*\*Spezialgebiet\*\*:\s*(.+)/);
    const expertiseKeywords = expertiseMatch
        ? expertiseMatch[1].split(',').map((s) => s.trim().toLowerCase())
        : [];
    // Extract primary paths from "Primaere Pfade" table
    const primaryPaths = [];
    const primaryPathsSection = content.match(/### Primaere Pfade\n\| Pfad[\s\S]*?\n\n/);
    if (primaryPathsSection) {
        const pathLines = primaryPathsSection[0].match(/\| `(.+?)` \|/g);
        if (pathLines) {
            pathLines.forEach((line) => {
                const pathMatch = line.match(/`(.+?)`/);
                if (pathMatch)
                    primaryPaths.push(pathMatch[1]);
            });
        }
    }
    // Extract first paragraph as description
    const descriptionMatch = content.match(/## Persönlichkeit\n\n> ?(.+)/);
    const description = descriptionMatch ? descriptionMatch[1].trim() : roleMatch[1];
    return {
        id,
        name: nameMatch[1],
        role: roleMatch[1],
        department: deptMatch ? deptMatch[1] : 'Unknown',
        expertise_keywords: expertiseKeywords,
        primary_paths: primaryPaths,
        description,
    };
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
    persona.total_document_count = persona.primary_documents.length + persona.secondary_documents.length;
    persona.last_updated = new Date().toISOString();
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
async function loadRegistry() {
    try {
        const content = await fs.readFile(REGISTRY_PATH, 'utf-8');
        return JSON.parse(content);
    }
    catch (err) {
        if (err.code === 'ENOENT') {
            // Initialize new registry
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
