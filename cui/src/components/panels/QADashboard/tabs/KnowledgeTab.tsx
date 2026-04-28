import { useState, useEffect, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { resilientFetch } from '../../../../utils/resilientFetch';

interface KnowledgeDoc {
  id: string;
  title: string;
  category: string;
  description: string;
}

const CATEGORY_ORDER = ['Einstieg', 'Layer-Modell', 'Tests schreiben', 'Status'];

export default function KnowledgeTab() {
  const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    resilientFetch('/api/qa/knowledge')
      .then(r => r.json())
      .then(data => {
        setAvailable(!!data.available);
        const list: KnowledgeDoc[] = data.docs ?? [];
        setDocs(list);
        if (list.length > 0 && !activeId) setActiveId(list[0].id);
      })
      .catch(() => setAvailable(false));
  }, []);

  const loadDoc = useCallback((id: string) => {
    setLoading(true);
    setError(null);
    resilientFetch(`/api/qa/knowledge/${id}`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(data => setContent(data.content || ''))
      .catch(e => setError(e.message || 'Konnte Doku nicht laden'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (activeId) loadDoc(activeId);
  }, [activeId, loadDoc]);

  const grouped = docs.reduce<Record<string, KnowledgeDoc[]>>((acc, d) => {
    (acc[d.category] ??= []).push(d);
    return acc;
  }, {});

  const orderedCategories = CATEGORY_ORDER.filter(c => grouped[c]?.length > 0);

  if (available === false) {
    return (
      <div style={{ padding: 24, color: 'var(--tn-text-muted)' }}>
        Keine Test-Dokumentation verfügbar — der unified-tester ist auf diesem Server nicht installiert.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
      {/* Sidebar */}
      <div style={{
        width: 240,
        borderRight: '1px solid var(--tn-border)',
        background: 'var(--tn-bg-dark)',
        overflowY: 'auto',
        flexShrink: 0,
      }}>
        <div style={{
          padding: '12px 14px 8px',
          fontSize: 10, fontWeight: 700, letterSpacing: '0.08em',
          color: 'var(--tn-text-muted)',
          textTransform: 'uppercase',
        }}>
          Wissensbasis
        </div>
        {orderedCategories.map(cat => (
          <div key={cat} style={{ marginBottom: 8 }}>
            <div style={{
              padding: '6px 14px 4px',
              fontSize: 9, fontWeight: 700, letterSpacing: '0.06em',
              color: 'var(--tn-blue)',
              textTransform: 'uppercase',
            }}>
              {cat}
            </div>
            {grouped[cat].map(d => (
              <button
                key={d.id}
                onClick={() => setActiveId(d.id)}
                title={d.description}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '6px 14px',
                  background: activeId === d.id ? 'rgba(122,162,247,0.15)' : 'transparent',
                  border: 'none',
                  borderLeft: activeId === d.id ? '3px solid var(--tn-blue)' : '3px solid transparent',
                  color: activeId === d.id ? 'var(--tn-text)' : 'var(--tn-text-muted)',
                  fontSize: 12,
                  fontWeight: activeId === d.id ? 600 : 400,
                  cursor: 'pointer',
                  transition: 'all 0.1s',
                }}
              >
                {d.title}
                <div style={{
                  fontSize: 10,
                  color: 'var(--tn-text-muted)',
                  fontWeight: 400,
                  marginTop: 2,
                  lineHeight: 1.3,
                }}>
                  {d.description}
                </div>
              </button>
            ))}
          </div>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', minWidth: 0, padding: '20px 28px' }}>
        {loading && <div style={{ color: 'var(--tn-text-muted)' }}>Lädt...</div>}
        {error && <div style={{ color: 'var(--tn-red)' }}>Fehler: {error}</div>}
        {!loading && !error && content && (
          <div className="qa-knowledge-md" style={{
            color: 'var(--tn-text)',
            fontSize: 13,
            lineHeight: 1.6,
            maxWidth: 820,
          }}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
          </div>
        )}
        {!loading && !error && !content && activeId && (
          <div style={{ color: 'var(--tn-text-muted)' }}>Leere Datei.</div>
        )}
      </div>
    </div>
  );
}
