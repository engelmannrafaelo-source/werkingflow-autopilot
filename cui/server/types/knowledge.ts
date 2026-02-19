// Knowledge Registry System - Type Definitions
// Created: 2026-02-19

export type DocumentCategory =
  | 'shared'
  | 'marketing'
  | 'sales'
  | 'customer-success'
  | 'legal'
  | 'finance'
  | 'foerderung';

export type DocumentType =
  | 'strategy'
  | 'customer-spec'
  | 'legal-contract'
  | 'financial-plan'
  | 'marketing-campaign'
  | 'grant-application'
  | 'technical-spec'
  | 'process-doc'
  | 'other';

export type ChangeType = 'created' | 'modified' | 'scanned' | 'reassigned';

export type AssignmentRelevance = 'primary' | 'secondary' | 'tangential';

export type AssignedBy = 'ai' | 'manual';

export interface DocumentChange {
  timestamp: string;              // ISO 8601
  change_type: ChangeType;
  details: string;
}

export interface PersonaAssignment {
  persona_id: string;             // 'mira', 'vera', 'felix', etc.
  confidence: number;             // 0-100
  reason: string;                 // "Marketing Lead - campaigns are core responsibility"
  relevance: AssignmentRelevance;
  assigned_at: string;            // ISO 8601
  assigned_by: AssignedBy;
}

export interface DocumentKnowledge {
  // File metadata
  path: string;                   // Relative: "shared/VISION.md"
  absolute_path: string;          // Full: "/root/projekte/werkingflow/business/shared/VISION.md"
  filename: string;               // "VISION.md"
  category: DocumentCategory;
  size_bytes: number;
  last_modified: string;          // File mtime (ISO 8601)
  last_scanned: string;           // AI analysis timestamp (ISO 8601)

  // AI-generated
  content_summary: string;        // Max 200 chars
  topics: string[];               // ["pricing", "marketing", "partnerships"]
  document_type: DocumentType;

  // Persona assignments
  assignments: PersonaAssignment[];

  // Legacy fields (from FRESHNESS_INDEX migration)
  owner?: string;                 // Original owner field
  max_age_days?: number;          // Staleness threshold
  status?: 'current' | 'stale' | 'critical';

  // Change tracking
  change_history: DocumentChange[];
}

export interface PersonaKnowledge {
  persona_id: string;             // 'mira', 'vera', etc.
  name: string;                   // 'Mira Marketing'
  role: string;                   // 'Marketing Lead'
  department: string;             // 'Business'
  table: string;                  // 'business' (from Virtual Office metadata)

  // Document knowledge
  primary_documents: string[];    // High relevance paths
  secondary_documents: string[];  // Medium relevance paths
  total_document_count: number;

  // Expertise mapping (extracted from persona .md)
  expertise_keywords: string[];   // ["marketing", "brand", "content", "campaigns"]
  primary_paths: string[];        // From "Primaere Pfade" table
  secondary_paths: string[];      // From "Sekundaere Pfade" table
  important_files: string[];      // From "Wichtige Dateien" table

  last_updated: string;           // ISO 8601
}

export interface ScanStatistics {
  total_documents: number;
  total_assignments: number;
  by_category: Record<DocumentCategory, number>;
  by_confidence: {
    high: number;                 // >80%
    medium: number;               // 50-80%
    low: number;                  // <50%
  };
  unassigned: number;
  pending_review: number;         // Assignments with 50-80% confidence
}

export interface KnowledgeRegistry {
  version: string;                              // "1.0.0"
  last_full_scan: string;                       // ISO 8601
  last_incremental_scan: string;                // ISO 8601
  documents: Record<string, DocumentKnowledge>; // Key = relative path
  personas: Record<string, PersonaKnowledge>;   // Key = persona_id
  scan_stats: ScanStatistics;
}

// --- Helper Types for API Requests/Responses ---

export interface ScanRequest {
  mode: 'full' | 'incremental';
  files?: string[];               // For incremental mode
  auto_assign?: boolean;          // Auto-assign >80% confidence
}

export interface ScanResult {
  scanned_count: number;
  classified_count: number;
  auto_assigned_count: number;
  pending_review_count: number;
  errors: Array<{ file: string; error: string }>;
  duration_ms: number;
}

export interface AssignRequest {
  document_path: string;
  persona_id: string;
  relevance: AssignmentRelevance;
  reason?: string;
}

export interface PersonaQueryResponse {
  persona: PersonaKnowledge;
  documents: {
    primary: DocumentKnowledge[];
    secondary: DocumentKnowledge[];
  };
  stats: {
    primary_count: number;
    secondary_count: number;
    total: number;
  };
}

export interface MigrationResult {
  migrated_count: number;
  preserved_assignments: number;
}

// --- Internal Helper Types ---

export interface PersonaProfile {
  id: string;
  name: string;
  role: string;
  department: string;
  expertise_keywords: string[];
  primary_paths: string[];
  description: string;            // First paragraph from persona .md
}

export interface ClassificationRequest {
  document_path: string;
  document_summary: string;       // Max 1000 chars
  filename: string;
  category: DocumentCategory;
  available_personas: PersonaProfile[];
}

export interface ClassificationResponse {
  assignments: Array<{
    persona_id: string;
    confidence: number;           // 0-100
    reason: string;
    relevance: AssignmentRelevance;
  }>;
  document_type: DocumentType;
  topics: string[];
  summary: string;                // Max 200 chars
}

export interface FileChangeEvent {
  event_type: 'add' | 'change' | 'unlink';
  file_path: string;              // Absolute path
  relative_path: string;          // Relative to business/
  timestamp: string;              // ISO 8601
  file_stats?: {
    size_bytes: number;
    mtime: string;                // ISO 8601
  };
}

export interface WatcherConfig {
  base_path: string;
  ignore_patterns: string[];
  debounce_ms: number;
  auto_scan_threshold: number;
}
