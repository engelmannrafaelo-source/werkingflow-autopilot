/**
 * Business Docs Panel — Partner self-service access to curated business documents.
 *
 * Tabs:
 *   - Reader (all roles): doc list + markdown renderer
 *   - Admin Matrix (admin/product-owner only): Docs × Workspaces grid for
 *     assigning which workspace (partner) may see which doc, plus publish
 *     toggle and doc creation / deletion.
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
  path?: string;
  published?: boolean;
  publishedAt?: string;
  /** ["*"] = all workspaces */
  workspaces?: string[];
}

interface DocContent {
  doc: DocMeta;
  content: string;
}

type BusinessDocsTab = 'reader' | 'admin';

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

  const [tab, setTab] = useState<BusinessDocsTab>('reader');

  const tabButton = (id: BusinessDocsTab, label: string) => (
    <button
      onClick={() => setTab(id)}
      style={{
        padding: '4px 12px',
        fontSize: 11,
        fontWeight: 500,
        cursor: 'pointer',
        background: tab === id ? 'var(--tn-bg-highlight)' : 'transparent',
        border: 'none',
        borderBottom: tab === id ? '2px solid var(--tn-blue)' : '2px solid transparent',
        color: tab === id ? 'var(--tn-text)' : 'var(--tn-text-muted)',
      }}
    >
      {label}
    </button>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--tn-bg)', color: 'var(--tn-text)' }}>
      {isAdmin && (
        <div style={{
          display: 'flex',
          gap: 2,
          padding: '2px 8px 0',
          background: 'var(--tn-bg-dark)',
          borderBottom: '1px solid var(--tn-border)',
          flexShrink: 0,
        }}>
          {tabButton('reader', 'Reader')}
          {tabButton('admin', 'Admin Matrix')}
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0 }}>
        {tab === 'admin' && isAdmin ? <AdminMatrixView /> : <ReaderView isAdmin={isAdmin} />}
      </div>
    </div>
  );
}

// ============================================================
// ReaderView — doc list + markdown renderer (all roles)
// ============================================================
function ReaderView({ isAdmin }: { isAdmin: boolean }) {
  const [docs, setDocs] = useState<DocMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [docContent, setDocContent] = useState<DocContent | null>(null);
  const [docLoading, setDocLoading] = useState(false);
  const [docError, setDocError] = useState<string | null>(null);

  const [publishing, setPublishing] = useState<string | null>(null);

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

  const loadDoc = useCallback(async (docId: string) => {
    setSelectedId(docId);
    setDocLoading(true);
    setDocError(null);
    setDocContent(null);
    try {
      const res = await fetch(`${API}/partner/docs/${encodeURIComponent(docId)}`, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({})); // silent-ok: error response parse failure falls back to empty object; HTTP status used for error
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

  const filtered = docs.filter(d =>
    !search.trim() || d.title.toLowerCase().includes(search.trim().toLowerCase())
  );
  const grouped = groupByCategory(filtered);
  const categories = CATEGORY_ORDER.filter(c => grouped[c]?.length);
  Object.keys(grouped).forEach(c => { if (!CATEGORY_ORDER.includes(c)) categories.push(c); });

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden', fontSize: 13 }}>
      {/* Sidebar */}
      <div style={{ width: 240, minWidth: 200, borderRight: '1px solid var(--tn-border)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
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
                  selected={selectedId === doc.id}
                  isAdmin={isAdmin}
                  publishing={publishing === doc.id}
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
                    disabled={publishing === docContent.doc.id}
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
                    disabled={publishing === docContent.doc.id}
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

// ============================================================
// AdminMatrixView — Docs × Workspaces grid (admin/product-owner only)
// ============================================================
function AdminMatrixView() {
  const [docs, setDocs] = useState<DocMeta[]>([]);
  const [workspaces, setWorkspaces] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showNewForm, setShowNewForm] = useState(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [docsRes, wsRes] = await Promise.all([
        fetch(`${API}/partner/docs`, { signal: AbortSignal.timeout(10000) }),
        fetch(`${API}/partner/docs/workspaces`, { signal: AbortSignal.timeout(10000) }),
      ]);
      if (!docsRes.ok) throw new Error(`[docs] HTTP ${docsRes.status}`);
      if (!wsRes.ok) throw new Error(`[workspaces] HTTP ${wsRes.status}`);
      const docsRaw = await docsRes.json();
      const wsRaw = await wsRes.json();
      const docsData = validateApiResponse<{ docs: DocMeta[] }>(docsRaw, '/api/partner/docs', { docs: 'array' });
      const wsData = validateApiResponse<{ workspaces: string[] }>(wsRaw, '/api/partner/docs/workspaces', { workspaces: 'array' });
      setDocs(docsData.docs);
      setWorkspaces(wsData.workspaces);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  const toggleWorkspace = useCallback(async (doc: DocMeta, ws: string) => {
    setBusy(doc.id);
    try {
      const current = doc.workspaces ?? [];
      const hasWildcard = current.includes('*');
      let next: string[];
      if (ws === '*') {
        next = hasWildcard ? [] : ['*'];
      } else {
        // Clicking a specific workspace removes wildcard
        const filtered = current.filter(w => w !== '*');
        next = filtered.includes(ws) ? filtered.filter(w => w !== ws) : [...filtered, ws];
      }
      const res = await fetch(`${API}/partner/docs/${encodeURIComponent(doc.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaces: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await loadAll();
    } catch (err: unknown) {
      console.error('[AdminMatrix] toggle workspace error:', err);
    } finally {
      setBusy(null);
    }
  }, [loadAll]);

  const togglePublish = useCallback(async (doc: DocMeta) => {
    setBusy(doc.id);
    try {
      if (doc.published) {
        const res = await fetch(`${API}/partner/docs/${encodeURIComponent(doc.id)}`, { method: 'DELETE' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } else {
        const res = await fetch(`${API}/partner/docs/publish`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ docId: doc.id }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      }
      await loadAll();
    } catch (err: unknown) {
      console.error('[AdminMatrix] toggle publish error:', err);
    } finally {
      setBusy(null);
    }
  }, [loadAll]);

  const deleteDoc = useCallback(async (doc: DocMeta) => {
    if (!confirm(`Dokument "${doc.title}" wirklich entfernen? (Die Markdown-Quelldatei bleibt erhalten.)`)) return;
    setBusy(doc.id);
    try {
      const res = await fetch(`${API}/partner/docs/${encodeURIComponent(doc.id)}/permanent`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await loadAll();
    } catch (err: unknown) {
      console.error('[AdminMatrix] delete error:', err);
    } finally {
      setBusy(null);
    }
  }, [loadAll]);

  if (loading) {
    return <div style={{ padding: 24, color: 'var(--tn-text-muted)', fontSize: 13 }}>Laden…</div>;
  }
  if (error) {
    return <div style={{ padding: 24, color: '#E53E3E', fontSize: 13 }}>Fehler: {error}</div>;
  }

  return (
    <div style={{ padding: 16, height: '100%', overflow: 'auto', fontSize: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>
          Dokument-Freigabe-Matrix ({docs.length} Docs × {workspaces.length} Workspaces)
        </div>
        <button
          onClick={() => setShowNewForm(v => !v)}
          style={{
            padding: '4px 10px', fontSize: 11, cursor: 'pointer', borderRadius: 4,
            background: showNewForm ? 'var(--tn-bg-secondary)' : 'rgba(66,153,225,0.15)',
            border: `1px solid ${showNewForm ? 'var(--tn-border)' : 'var(--tn-blue)'}`,
            color: showNewForm ? 'var(--tn-text-muted)' : 'var(--tn-blue)',
          }}
        >
          {showNewForm ? 'Abbrechen' : '+ Neues Dokument'}
        </button>
      </div>

      {showNewForm && (
        <NewDocForm
          workspaces={workspaces}
          onCreated={async () => { setShowNewForm(false); await loadAll(); }}
        />
      )}

      <div style={{ overflowX: 'auto', border: '1px solid var(--tn-border)', borderRadius: 4 }}>
        <table style={{ borderCollapse: 'collapse', fontSize: 11, minWidth: '100%' }}>
          <thead>
            <tr style={{ background: 'var(--tn-bg-secondary)' }}>
              <th style={thStyle}>Dokument</th>
              <th style={thStyle}>Kategorie</th>
              <th style={thStyle}>Freigabe</th>
              <th style={{ ...thStyle, textAlign: 'center' }}>Alle (*)</th>
              {workspaces.map(ws => (
                <th key={ws} style={{ ...thStyle, textAlign: 'center', writingMode: 'vertical-rl', transform: 'rotate(180deg)', minWidth: 26, maxWidth: 26, padding: '8px 4px' }}>
                  {ws}
                </th>
              ))}
              <th style={thStyle}></th>
            </tr>
          </thead>
          <tbody>
            {docs.map(doc => {
              const ws = doc.workspaces ?? [];
              const hasWildcard = ws.includes('*');
              const isBusy = busy === doc.id;
              return (
                <tr key={doc.id} style={{ borderTop: '1px solid var(--tn-border)', opacity: isBusy ? 0.5 : 1 }}>
                  <td style={tdStyle}>
                    <div style={{ fontWeight: 500 }}>{doc.title}</div>
                    <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', fontFamily: 'monospace' }}>{doc.id}</div>
                  </td>
                  <td style={tdStyle}>{doc.category}</td>
                  <td style={tdStyle}>
                    <button
                      onClick={() => togglePublish(doc)}
                      disabled={isBusy}
                      style={{
                        fontSize: 10, padding: '2px 8px', borderRadius: 3, cursor: 'pointer',
                        background: doc.published ? 'rgba(56,161,105,0.15)' : 'var(--tn-bg-secondary)',
                        border: `1px solid ${doc.published ? '#38A169' : 'var(--tn-border)'}`,
                        color: doc.published ? '#38A169' : 'var(--tn-text-muted)',
                      }}
                    >
                      {doc.published ? 'Live' : 'Entwurf'}
                    </button>
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'center' }}>
                    <input
                      type="checkbox"
                      checked={hasWildcard}
                      disabled={isBusy}
                      onChange={() => toggleWorkspace(doc, '*')}
                    />
                  </td>
                  {workspaces.map(w => (
                    <td key={w} style={{ ...tdStyle, textAlign: 'center', padding: '4px 2px' }}>
                      <input
                        type="checkbox"
                        checked={hasWildcard || ws.includes(w)}
                        disabled={isBusy || hasWildcard}
                        onChange={() => toggleWorkspace(doc, w)}
                        title={hasWildcard ? 'Alle Workspaces sichtbar (*)' : `Toggle ${w}`}
                      />
                    </td>
                  ))}
                  <td style={tdStyle}>
                    <button
                      onClick={() => deleteDoc(doc)}
                      disabled={isBusy}
                      title="Dokument-Eintrag entfernen"
                      style={{
                        fontSize: 10, padding: '2px 6px', borderRadius: 3, cursor: 'pointer',
                        background: 'transparent', border: '1px solid var(--tn-border)',
                        color: '#E53E3E',
                      }}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              );
            })}
            {docs.length === 0 && (
              <tr>
                <td colSpan={4 + workspaces.length + 1} style={{ ...tdStyle, textAlign: 'center', color: 'var(--tn-text-muted)', padding: 16 }}>
                  Keine Dokumente. Lege ein neues an.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 12, fontSize: 10, color: 'var(--tn-text-muted)', lineHeight: 1.5 }}>
        <strong>Alle (*)</strong> = Dokument ist in jedem Workspace sichtbar. Bei aktivem Wildcard sind Einzel-Checkboxen deaktiviert.<br />
        <strong>Freigabe</strong> = Live-Schalter. Partner sehen nur Live-Dokumente, die auch in ihrem Workspace freigeschaltet sind.<br />
        <strong>✕</strong> = Dokument-Eintrag aus der Matrix entfernen (Quelldatei unter <code>werkingflow-business/</code> bleibt erhalten).
      </div>
    </div>
  );
}

// --- New-Doc Form ---
function NewDocForm({ workspaces, onCreated }: { workspaces: string[]; onCreated: () => void }) {
  const [id, setId] = useState('');
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('Strategie');
  const [path, setPath] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set(['*']));
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  function toggle(ws: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (ws === '*') {
        if (next.has('*')) next.delete('*');
        else { next.clear(); next.add('*'); }
      } else {
        next.delete('*');
        if (next.has(ws)) next.delete(ws);
        else next.add(ws);
      }
      return next;
    });
  }

  async function submit() {
    setFormError(null);
    if (!id.trim() || !title.trim() || !path.trim()) {
      setFormError('id, title und path sind Pflichtfelder');
      return;
    }
    if (selected.size === 0) {
      setFormError('Mindestens einen Workspace auswählen (oder Alle (*))');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`${API}/partner/docs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: id.trim(), title: title.trim(), category: category.trim(), path: path.trim(),
          workspaces: Array.from(selected),
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})); // silent-ok: error response parse failure falls back to empty object; HTTP status used for error
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      onCreated();
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{
      padding: 12, marginBottom: 12, border: '1px solid var(--tn-border)',
      borderRadius: 4, background: 'var(--tn-bg-secondary)',
    }}>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>Neues Dokument</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
        <input
          type="text" placeholder="id (z.B. 'energy-specs')" value={id} onChange={e => setId(e.target.value)}
          style={inputStyle}
        />
        <input
          type="text" placeholder="Titel" value={title} onChange={e => setTitle(e.target.value)}
          style={inputStyle}
        />
        <select value={category} onChange={e => setCategory(e.target.value)} style={inputStyle}>
          <option value="Strategie">Strategie</option>
          <option value="Produkt">Produkt</option>
          <option value="Technik">Technik</option>
          <option value="Partner">Partner</option>
          <option value="Marketing">Marketing</option>
          <option value="Finance">Finance</option>
        </select>
        <input
          type="text" placeholder="Quell-Pfad (absolut, .md)" value={path} onChange={e => setPath(e.target.value)}
          style={{ ...inputStyle, fontFamily: 'monospace' }}
        />
      </div>

      <div style={{ fontSize: 11, marginBottom: 4, color: 'var(--tn-text-muted)' }}>Sichtbar in Workspaces:</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
        <label style={{ ...chipStyle, background: selected.has('*') ? 'rgba(66,153,225,0.2)' : 'var(--tn-bg)', borderColor: selected.has('*') ? 'var(--tn-blue)' : 'var(--tn-border)' }}>
          <input type="checkbox" checked={selected.has('*')} onChange={() => toggle('*')} style={{ marginRight: 4 }} />
          Alle (*)
        </label>
        {workspaces.map(w => (
          <label key={w} style={{ ...chipStyle, background: selected.has(w) ? 'rgba(66,153,225,0.2)' : 'var(--tn-bg)', borderColor: selected.has(w) ? 'var(--tn-blue)' : 'var(--tn-border)', opacity: selected.has('*') ? 0.4 : 1 }}>
            <input type="checkbox" checked={selected.has(w)} disabled={selected.has('*')} onChange={() => toggle(w)} style={{ marginRight: 4 }} />
            {w}
          </label>
        ))}
      </div>

      {formError && <div style={{ color: '#E53E3E', fontSize: 11, marginBottom: 6 }}>{formError}</div>}

      <button
        onClick={submit}
        disabled={submitting}
        style={{
          padding: '4px 12px', fontSize: 11, cursor: submitting ? 'wait' : 'pointer', borderRadius: 4,
          background: 'rgba(66,153,225,0.15)', border: '1px solid var(--tn-blue)', color: 'var(--tn-blue)',
        }}
      >
        {submitting ? 'Anlegen…' : 'Dokument anlegen'}
      </button>
    </div>
  );
}

const thStyle: React.CSSProperties = {
  padding: '6px 8px', textAlign: 'left', fontWeight: 600,
  borderBottom: '1px solid var(--tn-border)', whiteSpace: 'nowrap',
};
const tdStyle: React.CSSProperties = { padding: '6px 8px', verticalAlign: 'middle' };
const inputStyle: React.CSSProperties = {
  padding: '4px 8px', fontSize: 11, border: '1px solid var(--tn-border)',
  borderRadius: 3, background: 'var(--tn-bg)', color: 'var(--tn-text)',
};
const chipStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', padding: '2px 8px', fontSize: 10,
  borderRadius: 10, border: '1px solid', cursor: 'pointer', userSelect: 'none',
};

// ============================================================
// DocItem (used in ReaderView sidebar)
// ============================================================
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
