// Document Viewer Modal - Full markdown preview for business documents
// Created: 2026-02-28

import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface DocumentViewerModalProps {
  documentPath: string;
  onClose: () => void;
}

export default function DocumentViewerModal({ documentPath, onClose }: DocumentViewerModalProps) {
  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadDocument();
  }, [documentPath]);

  async function loadDocument() {
    try {
      setLoading(true);
      setError(null);

      // Construct full path (business docs are under /root/projekte/werkingflow/business)
      const fullPath = `/root/projekte/werkingflow/business/${documentPath}`;
      const response = await fetch(`/api/file?path=${encodeURIComponent(fullPath)}`);

      if (!response.ok) throw new Error('Failed to load document');

      const data = await response.json();
      setContent(data.content || '');
    } catch (err: any) {
      console.error('[DocumentViewer] Load error:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  // Close on ESC
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(0,0,0,0.8)',
        zIndex: 10000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2rem',
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'var(--tn-bg)',
          borderRadius: 8,
          maxWidth: '1200px',
          width: '100%',
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 20px 60px rgba(0,0,0,0.4)',
          border: '1px solid var(--tn-border)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            padding: '1rem 1.5rem',
            borderBottom: '1px solid var(--tn-border)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div>
            <h3 style={{ fontSize: 14, margin: 0, color: 'var(--tn-text)' }}>Document Preview</h3>
            <div style={{ fontSize: 11, color: 'var(--tn-text-muted)', marginTop: '0.25rem' }}>
              {documentPath}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'var(--tn-bg-secondary)',
              border: '1px solid var(--tn-border)',
              borderRadius: 4,
              padding: '0.5rem 1rem',
              fontSize: 11,
              color: 'var(--tn-text)',
              cursor: 'pointer',
              fontWeight: 600,
            }}
          >
            Close (ESC)
          </button>
        </div>

        {/* Content */}
        <div
          style={{
            flex: 1,
            overflow: 'auto',
            padding: '2rem',
          }}
        >
          {loading && (
            <div style={{ textAlign: 'center', color: 'var(--tn-text-muted)', fontSize: 11 }}>
              Loading document...
            </div>
          )}

          {error && (
            <div
              style={{
                background: 'rgba(239,68,68,0.1)',
                border: '1px solid #ef4444',
                borderRadius: 6,
                padding: '1rem',
                color: '#ef4444',
                fontSize: 11,
              }}
            >
              <strong>Error:</strong> {error}
            </div>
          )}

          {!loading && !error && content && (
            <div className="markdown-content">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
            </div>
          )}

          {!loading && !error && !content && (
            <div style={{ textAlign: 'center', color: 'var(--tn-text-muted)', fontSize: 11 }}>
              Document is empty
            </div>
          )}
        </div>
      </div>

      {/* Markdown Styles */}
      <style>{`
        .markdown-content {
          color: var(--tn-text);
          font-size: 13px;
          line-height: 1.8;
        }

        .markdown-content h1 {
          font-size: 24px;
          font-weight: 700;
          margin-top: 2rem;
          margin-bottom: 1rem;
          color: var(--tn-text);
          border-bottom: 2px solid var(--tn-border);
          padding-bottom: 0.5rem;
        }

        .markdown-content h2 {
          font-size: 20px;
          font-weight: 600;
          margin-top: 1.5rem;
          margin-bottom: 0.75rem;
          color: var(--tn-text);
        }

        .markdown-content h3 {
          font-size: 16px;
          font-weight: 600;
          margin-top: 1.25rem;
          margin-bottom: 0.5rem;
          color: var(--tn-text);
        }

        .markdown-content p {
          margin-bottom: 1rem;
        }

        .markdown-content ul, .markdown-content ol {
          margin-bottom: 1rem;
          padding-left: 1.5rem;
        }

        .markdown-content li {
          margin-bottom: 0.5rem;
        }

        .markdown-content code {
          background: var(--tn-bg-secondary);
          padding: 2px 6px;
          border-radius: 3px;
          font-family: 'JetBrains Mono', monospace;
          font-size: 12px;
          color: #7aa2f7;
        }

        .markdown-content pre {
          background: var(--tn-bg-dark);
          border: 1px solid var(--tn-border);
          border-radius: 6px;
          padding: 1rem;
          overflow-x: auto;
          margin-bottom: 1rem;
        }

        .markdown-content pre code {
          background: none;
          padding: 0;
          color: var(--tn-text);
        }

        .markdown-content blockquote {
          border-left: 3px solid var(--tn-border);
          padding-left: 1rem;
          margin-left: 0;
          color: var(--tn-text-muted);
          font-style: italic;
        }

        .markdown-content table {
          width: 100%;
          border-collapse: collapse;
          margin-bottom: 1rem;
        }

        .markdown-content th, .markdown-content td {
          border: 1px solid var(--tn-border);
          padding: 0.5rem;
          text-align: left;
        }

        .markdown-content th {
          background: var(--tn-bg-secondary);
          font-weight: 600;
        }

        .markdown-content a {
          color: #7aa2f7;
          text-decoration: none;
        }

        .markdown-content a:hover {
          text-decoration: underline;
        }

        .markdown-content hr {
          border: none;
          border-top: 1px solid var(--tn-border);
          margin: 2rem 0;
        }

        .markdown-content img {
          max-width: 100%;
          border-radius: 6px;
          margin: 1rem 0;
        }
      `}</style>
    </div>
  );
}
