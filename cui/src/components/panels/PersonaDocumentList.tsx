// Persona Document List - Shows primary/secondary documents for a persona
// Created: 2026-02-19

import { useState, useEffect } from 'react';

interface DocumentKnowledge {
  path: string;
  filename: string;
  category: string;
  topics: string[];
  document_type: string;
  content_summary: string;
}

interface PersonaDocumentListProps {
  personaId: string;
  personaName: string;
}

export default function PersonaDocumentList({ personaId, personaName }: PersonaDocumentListProps) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadPersonaDocuments();

    // Listen for knowledge updates
    const handleUpdate = () => loadPersonaDocuments();
    window.addEventListener('knowledge-updated', handleUpdate);

    return () => window.removeEventListener('knowledge-updated', handleUpdate);
  }, [personaId]);

  async function loadPersonaDocuments() {
    try {
      setLoading(true);
      const response = await fetch(`/api/team/knowledge/persona/${personaId}`);

      if (!response.ok) throw new Error('Failed to load persona documents');

      const data = await response.json();
      setData(data);
    } catch (err: any) {
      console.error('[PersonaDocumentList] Load error:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <div style={{ padding: '1rem', fontSize: 11, color: 'var(--tn-text-muted)' }}>
        Loading documents...
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: '1rem', fontSize: 11, color: 'var(--tn-red)' }}>Error: {error}</div>
    );
  }

  if (!data || data.stats.total === 0) {
    return (
      <div style={{ padding: '1rem', fontSize: 11, color: 'var(--tn-text-muted)' }}>
        No documents assigned yet. Run a scan to analyze documents.
      </div>
    );
  }

  return (
    <div className="persona-document-list" style={{ padding: '1rem' }}>
      <h3 style={{ fontSize: 14, marginBottom: '1rem', color: 'var(--tn-text)' }}>
        {personaName}'s Documents ({data.stats.total})
      </h3>

      {data.documents.primary.length > 0 && (
        <div style={{ marginBottom: '1.5rem' }}>
          <h4
            style={{
              fontSize: 12,
              color: 'var(--tn-text-muted)',
              marginBottom: '0.5rem',
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
            }}
          >
            Primary ({data.documents.primary.length})
          </h4>
          {data.documents.primary.map((doc: DocumentKnowledge) => (
            <DocumentItem key={doc.path} doc={doc} relevance="primary" />
          ))}
        </div>
      )}

      {data.documents.secondary.length > 0 && (
        <div>
          <h4
            style={{
              fontSize: 12,
              color: 'var(--tn-text-muted)',
              marginBottom: '0.5rem',
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
            }}
          >
            Secondary ({data.documents.secondary.length})
          </h4>
          {data.documents.secondary.map((doc: DocumentKnowledge) => (
            <DocumentItem key={doc.path} doc={doc} relevance="secondary" />
          ))}
        </div>
      )}
    </div>
  );
}

function DocumentItem({ doc, relevance }: { doc: DocumentKnowledge; relevance: string }) {
  const relevanceColor =
    relevance === 'primary'
      ? { bg: 'rgba(16,185,129,0.1)', border: '#10b981', text: '#10b981' }
      : { bg: 'rgba(59,130,246,0.1)', border: '#3b82f6', text: '#3b82f6' };

  return (
    <div
      style={{
        background: 'var(--tn-bg-secondary)',
        border: '1px solid var(--tn-border)',
        borderRadius: 6,
        padding: '0.75rem',
        marginBottom: '0.5rem',
        fontSize: 11,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
        <div style={{ fontWeight: 600, color: 'var(--tn-text)', flex: 1 }}>{doc.filename}</div>
        <span
          style={{
            fontSize: 9,
            padding: '2px 6px',
            borderRadius: 4,
            background: relevanceColor.bg,
            color: relevanceColor.text,
            border: `1px solid ${relevanceColor.border}`,
            textTransform: 'uppercase',
            fontWeight: 600,
            letterSpacing: '0.5px',
          }}
        >
          {relevance}
        </span>
      </div>

      <div style={{ color: 'var(--tn-text-muted)', marginBottom: '0.5rem', fontSize: 10 }}>
        {doc.path}
      </div>

      {doc.content_summary && (
        <div
          style={{
            color: 'var(--tn-text-muted)',
            fontSize: 10,
            lineHeight: 1.5,
            marginBottom: '0.5rem',
            fontStyle: 'italic',
          }}
        >
          {doc.content_summary.slice(0, 150)}
          {doc.content_summary.length > 150 ? '...' : ''}
        </div>
      )}

      {(doc.topics.length > 0 || doc.document_type) && (
        <div style={{ display: 'flex', gap: '0.5rem', fontSize: 9, flexWrap: 'wrap' }}>
          {doc.document_type && (
            <span
              style={{
                background: 'var(--tn-bg-dark)',
                padding: '2px 6px',
                borderRadius: 3,
                color: 'var(--tn-text-muted)',
              }}
            >
              {doc.document_type}
            </span>
          )}
          {doc.topics.slice(0, 3).map((topic) => (
            <span
              key={topic}
              style={{
                background: 'rgba(122,162,247,0.1)',
                color: '#7aa2f7',
                padding: '2px 6px',
                borderRadius: 3,
              }}
            >
              {topic}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
