/**
 * Business Docs Panel — Partner self-service access to curated business documents.
 *
 * Features:
 *   - Sidebar: doc list grouped by category (Strategie, Produkt, Technik)
 *   - Main area: Markdown renderer with syntax highlighting
 *   - Search: filter docs by title
 *   - Admin: Publish / Unpublish buttons
 *   - Partner: published docs only (server-enforced + client hints)
 */

import { useState, useEffect, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAuth } from '../../contexts/AuthContext';
import { validateApiResponse } from '../../lib/validateApiResponse';

const API = '/api';

// --- Types ---
interface DocMeta {
  id: string;
  title: string;
  category: string;
  published?: boolean;
  publishedAt?: string;
}

interface DocContent {
  doc: DocMeta;
  content: string;
}

// --- Helpers ---
function groupByCategory(docs: DocMeta[]): Record<string, DocMeta[]> {
  return docs.reduce<Record<string, DocMeta[]>>((acc, doc) => {
    const cat = doc.category;
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(doc);
    return acc;
  }, {});
}

// Category display order
const CATEGORY_ORDER = ['Strategie', 'Produkt', 'Technik'];

// --- Markdown Components ---
const mdComponents = {
  h1: ({ children }: { children?: React.ReactNode }) => (
    <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 12, marginTop: 24, borderBottom: '1px solid var(--tn-border)', paddingBottom: 8 }}>{children}</h1>
  ),
  h2: ({ children }: { children?: React.ReactNode }) => (
    <h2 style={{ fontSize: 17, fontWeight: 600, marginBottom: 8, marginTop: 20 }}>{children}</h2>
  ),
  h3: ({ children }: { children?: React.ReactNode }) => (
    <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 6, marginTop: 16 }}>{children}</h3>
  ),
  p: ({ children }: { children?: React.ReactNode }) => (
    <p style={{ marginBottom: 10, lineHeight: 1.6 }}>{children}</p>
  ),
  ul: ({ children }: { children?: React.ReactNode }) => (
    <ul style={{ paddingLeft: 20, marginBottom: 10 }}>{children}</ul>
  ),
  ol: ({ children }: { children?: React.ReactNode }) => (
    <ol style={{ paddingLeft: 20, marginBottom: 10 }}>{children}</ol>
  ),
  li: ({ children }: { children?: React.ReactNode }) => (
    <li style={{ marginBottom: 4 }}>{children}</li>
  ),
  code: ({ inline, children }: { inline?: boolean; children?: React.ReactNode }) =>
    inline ? (
      <code style={{ background: 'var(--tn-bg-secondary)', padding: '1px 5px', borderRadius: 3, fontSize: 12, fontFamily: 'monospace' }}>{children}</code>
    ) : (
      <code style={{ display: 'block', background: 'var(--tn-bg-secondary)', padding: '10px 14px', borderRadius: 6, fontSize: 12, fontFamily: 'monospace', overflowX: 'auto', marginBottom: 10 }}>{children}</code>
    ),
  pre: ({ children }: { children?: React.ReactNode }) => (
    <pre style={{ margin: 0 }}>{children}</pre>
  ),
  blockquote: ({ children }: { children?: React.ReactNode }) => (
    <blockquote style={{ borderLeft: '3px solid var(--tn-accent)', paddingLeft: 12, margin: '10px 0', color: 'var(--tn-text-muted)', fontStyle: 'italic' }}>{children}</blockquote>
  ),
  table: ({ children }: { children?: React.ReactNode }) => (
    <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 12, fontSize: 13 }}>{children}</table>
  ),
  th: ({ children }: { children?: React.ReactNode }) => (
    <th style={{ textAlign: 'left', padding: '6px 10px', background: 'var(--tn-bg-secondary)', borderBottom: '1px solid var(--tn-border)', fontWeight: 600 }}>{children}</th>
  ),
  td: ({ children }: { children?: React.ReactNode }) => (
    <td style={{ padding: '5px 10px', borderBottom: '1px solid var(--tn-border)' }}>{children}</td>
  ),
  hr: () => <hr style={{ border: 'none', borderTop: '1px solid var(--tn-border)', margin: '16px 0' }} />,
};

// --- Main Component ---
export default function BusinessDocsPanel() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin' || user?.role === 'product-owner';

  const [docs, setDocs] = useState<DocMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [docContent, setDocContent] = useState<DocContent | null>(null);
  const [docLoading, setDocLoading] = useState(false);
  const [docError, setDocError] = useState<string | null>(null);

  const [publishing, setPublishing] = useState<string | null>(null);

  // Load doc list
  const loadDocs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API}/partner/docs`, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = await res.json();
      const data = validateApiResponse<{ docs: DocMeta[] }>(raw, '/api/partner/docs', { docs: 'array' });
      setDocs(data.docs);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadDocs(); }, [loadDocs]);

  // Load doc content
  const loadDoc = useCallback(async (docId: string) => {
    setSelectedId(docId);
    setDocLoading(true);
    setDocError(null);
    setDocContent(null);
    try {
      const res = await fetch(`${API}/partner/docs/${encodeURIComponent(docId)}`, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error ?? `HTTP ${res.status}`);
      }
      const raw = await res.json();
      const data = validateApiResponse<DocContent>(raw, `/api/partner/docs/${docId}`, {
        doc: 'object',
        content: 'string',
      });
      setDocContent(data);
    } catch (err: unknown) {
      setDocError(err instanceof Error ? err.message : String(err));
    } finally {
      setDocLoading(false);
    }
  }, []);

  // Publish / Unpublish
  const publish = useCallback(async (docId: string) => {
    setPublishing(docId);
    try {
      const res = await fetch(`${API}/partner/docs/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docId }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await loadDocs();
      // Refresh content if currently viewing this doc
      if (selectedId === docId) loadDoc(docId);
    } catch (err: unknown) {
      console.error('[BusinessDocsPanel] publish error:', err);
    } finally {
      setPublishing(null);
    }
  }, [loadDocs, loadDoc, selectedId]);

  const unpublish = useCallback(async (docId: string) => {
    setPublishing(docId);
    try {
      const res = await fetch(`${API}/partner/docs/${encodeURIComponent(docId)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await loadDocs();
    } catch (err: unknown) {
      console.error('[BusinessDocsPanel] unpublish error:', err);
    } finally {
      setPublishing(null);
    }
  }, [loadDocs]);

  // Filter + group
  const filtered = docs.filter(d =>
    !search.trim() || d.title.toLowerCase().includes(search.trim().toLowerCase())
  );
  const grouped = groupByCategory(filtered);
  const categories = CATEGORY_ORDER.filter(c => grouped[c]?.length);
  // Add any unlisted categories at the end
  Object.keys(grouped).forEach(c => { if (!CATEGORY_ORDER.includes(c)) categories.push(c); });

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden', background: 'var(--tn-bg)', color: 'var(--tn-text)', fontSize: 13 }}>
      {/* Sidebar */}
      <div style={{ width: 240, minWidth: 200, borderRight: '1px solid var(--tn-border)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Header */}
        <div style={{ padding: '12px 14px 8px', borderBottom: '1px solid var(--tn-border)' }}>
          <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>Business Docs</div>
          <input
            type="text"
            placeholder="Suchen…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              padding: '5px 8px',
              background: 'var(--tn-bg-secondary)',
              border: '1px solid var(--tn-border)',
              borderRadius: 4,
              color: 'var(--tn-text)',
              fontSize: 12,
              outline: 'none',
            }}
          />
        </div>

        {/* Doc list */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
          {loading && (
            <div style={{ padding: '16px 14px', color: 'var(--tn-text-muted)', fontSize: 12 }}>Laden…</div>
          )}
          {error && (
            <div style={{ padding: '12px 14px', color: '#E53E3E', fontSize: 12 }}>{error}</div>
          )}
          {!loading && !error && categories.length === 0 && (
            <div style={{ padding: '16px 14px', color: 'var(--tn-text-muted)', fontSize: 12 }}>
              {search ? 'Keine Treffer.' : 'Keine Dokumente verfügbar.'}
            </div>
          )}
          {categories.map(category => (
            <div key={category}>
              <div style={{
                padding: '6px 14px 3px',
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                color: 'var(--tn-text-muted)',
              }}>
                {category}
              </div>
              {grouped[category].map(doc => (
                <DocItem
                  key={doc.id}
                  doc={doc}
                  selected={selectedId === (doc.id)}
                  isAdmin={isAdmin}
                  publishing={publishing === (doc.id)}
                  onClick={() => loadDoc(doc.id)}
                  onPublish={() => publish(doc.id)}
                  onUnpublish={() => unpublish(doc.id)}
                />
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* Main content */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {!selectedId ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--tn-text-muted)', fontSize: 13 }}>
            Dokument auswählen
          </div>
        ) : docLoading ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--tn-text-muted)', fontSize: 13 }}>
            Laden…
          </div>
        ) : docError ? (
          <div style={{ flex: 1, padding: 24, color: '#E53E3E' }}>
            Fehler: {docError}
          </div>
        ) : docContent ? (
          <>
            {/* Doc header */}
            <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--tn-border)', display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontWeight: 600, fontSize: 14, flex: 1 }}>{docContent.doc.title}</span>
              <span style={{
                fontSize: 11,
                padding: '2px 8px',
                borderRadius: 10,
                background: (docContent.doc.published ?? false) ? 'rgba(56,161,105,0.15)' : 'var(--tn-bg-secondary)',
                color: (docContent.doc.published ?? false) ? '#38A169' : 'var(--tn-text-muted)',
                border: `1px solid ${(docContent.doc.published ?? false) ? '#38A16940' : 'var(--tn-border)'}`,
              }}>
                {(docContent.doc.published ?? false) ? 'Freigegeben' : 'Entwurf'}
              </span>
              {isAdmin && (
                (docContent.doc.published ?? false) ? (
                  <button
                    onClick={() => unpublish(docContent.doc.id)}
                    disabled={publishing === (docContent.doc.id)}
                    style={{
                      fontSize: 11,
                      padding: '3px 10px',
                      borderRadius: 4,
                      border: '1px solid var(--tn-border)',
                      background: 'var(--tn-bg-secondary)',
                      color: 'var(--tn-text)',
                      cursor: 'pointer',
                    }}
                  >
                    Zurückziehen
                  </button>
                ) : (
                  <button
                    onClick={() => publish(docContent.doc.id)}
                    disabled={publishing === (docContent.doc.id)}
                    style={{
                      fontSize: 11,
                      padding: '3px 10px',
                      borderRadius: 4,
                      border: '1px solid #38A169',
                      background: 'rgba(56,161,105,0.12)',
                      color: '#38A169',
                      cursor: 'pointer',
                    }}
                  >
                    Freigeben
                  </button>
                )
              )}
            </div>

            {/* Markdown content */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '20px 28px' }}>
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents as Record<string, unknown>}>
                {docContent.content}
              </ReactMarkdown>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

// --- DocItem ---
interface DocItemProps {
  doc: DocMeta;
  selected: boolean;
  isAdmin: boolean;
  publishing: boolean;
  onClick: () => void;
  onPublish: () => void;
  onUnpublish: () => void;
}

function DocItem({ doc, selected, isAdmin, publishing, onClick, onPublish, onUnpublish }: DocItemProps) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        padding: '6px 14px',
        cursor: 'pointer',
        background: selected
          ? 'var(--tn-accent-muted, rgba(66,153,225,0.12))'
          : hovered
          ? 'var(--tn-bg-hover, rgba(255,255,255,0.04))'
          : 'transparent',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        position: 'relative',
      }}
    >
      {/* Status dot (admin only) */}
      {isAdmin && (
        <div style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: (doc.published ?? false) ? '#38A169' : 'var(--tn-border)',
          flexShrink: 0,
        }} />
      )}

      <span style={{
        flex: 1,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        color: selected ? 'var(--tn-accent, #4299E1)' : 'var(--tn-text)',
        fontSize: 13,
      }}>
        {doc.title}
      </span>

      {/* Admin publish/unpublish toggle */}
      {isAdmin && hovered && (
        <button
          onClick={e => {
            e.stopPropagation();
            (doc.published ?? false) ? onUnpublish() : onPublish();
          }}
          disabled={publishing}
          title={(doc.published ?? false) ? 'Zurückziehen' : 'Freigeben'}
          style={{
            fontSize: 10,
            padding: '1px 6px',
            borderRadius: 3,
            border: `1px solid ${(doc.published ?? false) ? 'var(--tn-border)' : '#38A169'}`,
            background: (doc.published ?? false) ? 'var(--tn-bg-secondary)' : 'rgba(56,161,105,0.12)',
            color: (doc.published ?? false) ? 'var(--tn-text-muted)' : '#38A169',
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          {(doc.published ?? false) ? '✕' : '✓'}
        </button>
      )}
    </div>
  );
}
