// Knowledge Graph View - Shows personas with document counts
// Created: 2026-02-19

import { useState, useEffect } from 'react';

interface PersonaCard {
  id: string;
  name: string;
  role: string;
  status: string;
}

interface PersonaKnowledge {
  persona_id: string;
  name: string;
  role: string;
  total_document_count: number;
  primary_documents: string[];
  secondary_documents: string[];
}

interface KnowledgeGraphViewProps {
  personas: PersonaCard[];
  onPersonaClick: (personaId: string) => void;
  selected?: PersonaCard | null;
}

export default function KnowledgeGraphView({
  personas,
  onPersonaClick,
  selected,
}: KnowledgeGraphViewProps) {
  const [knowledgeData, setKnowledgeData] = useState<Record<string, PersonaKnowledge>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadKnowledgeData();
  }, []);

  async function loadKnowledgeData() {
    try {
      const response = await fetch('/api/team/knowledge/registry');
      if (!response.ok) throw new Error('Failed to load registry');

      const registry = await response.json();
      setKnowledgeData(registry.personas);
    } catch (err: any) {
      console.error('[KnowledgeGraph] Load error:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <div
        style={{
          padding: '1rem',
          color: 'var(--tn-text-muted)',
          fontSize: 12,
          textAlign: 'center',
        }}
      >
        Loading knowledge graph...
      </div>
    );
  }

  if (error) {
    return (
      <div
        style={{
          padding: '1rem',
          color: 'var(--tn-red)',
          fontSize: 12,
          textAlign: 'center',
        }}
      >
        Error loading knowledge graph: {error}
      </div>
    );
  }

  return (
    <div
      className="knowledge-graph"
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
        gap: '1rem',
        padding: '1rem',
      }}
    >
      {personas.map((persona) => {
        const knowledge = knowledgeData[persona.id];
        const docCount = knowledge?.total_document_count || 0;

        // Color-coded badge: Green (>5), Yellow (1-5), Gray (0)
        const badgeColor =
          docCount > 5
            ? { bg: 'rgba(16,185,129,0.15)', border: '#10b981', text: '#10b981' }
            : docCount > 0
            ? { bg: 'rgba(245,158,11,0.15)', border: '#f59e0b', text: '#f59e0b' }
            : { bg: 'rgba(107,114,128,0.15)', border: '#6b7280', text: '#6b7280' };

        return (
          <div
            key={persona.id}
            onClick={() => onPersonaClick(persona.id)}
            style={{
              background: 'var(--tn-bg-secondary)',
              border: selected?.id === persona.id ? '2px solid var(--tn-blue)' : '1px solid var(--tn-border)',
              borderRadius: 8,
              padding: '1rem',
              cursor: 'pointer',
              transition: 'all 0.2s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = 'translateY(-2px)';
              e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,0,0,0.1)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = 'translateY(0)';
              e.currentTarget.style.boxShadow = 'none';
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: '0.5rem', color: 'var(--tn-text)' }}>
              {persona.name}
            </div>
            <div style={{ fontSize: 11, color: 'var(--tn-text-muted)', marginBottom: '0.75rem' }}>
              {persona.role}
            </div>

            <div
              className="document-badge"
              style={{
                display: 'inline-block',
                background: badgeColor.bg,
                color: badgeColor.text,
                border: `1px solid ${badgeColor.border}`,
                padding: '0.25rem 0.5rem',
                borderRadius: 12,
                fontSize: 11,
                fontWeight: 600,
              }}
            >
              {docCount} {docCount === 1 ? 'doc' : 'docs'}
            </div>

            {knowledge && knowledge.total_document_count > 0 && (
              <div style={{ marginTop: '0.5rem', fontSize: 10, color: 'var(--tn-text-muted)' }}>
                {knowledge.primary_documents.length} primary · {knowledge.secondary_documents.length} secondary
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
