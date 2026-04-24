import React, { useState, useEffect, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { resilientFetch } from '../../../utils/resilientFetch';
import { validateApiResponse } from '../../../lib/validateApiResponse';

// ─── Types ──────────────────────────────────────────────────────────────────
interface FilePreviewData {
  type: 'text' | 'image' | 'pdf' | 'unsupported';
  ext?: string;
  fileName: string;
  content: string;
  base64?: string;
  mimeType?: string;
  size?: number;
  modified?: string;
  message?: string;
}

interface FilePreviewSidebarProps {
  filePath: string | null;
  onClose: () => void;
}

// ─── Main Component ─────────────────────────────────────────────────────────
export default function FilePreviewSidebar({ filePath, onClose }: FilePreviewSidebarProps) {
  const [data, setData] = useState<FilePreviewData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPreview = useCallback(async (path: string) => {
    if ((window as any).__cuiServerAlive === false) return;
    setLoading(true);
    setError(null);
    setData(null);
    try {
      const res = await resilientFetch(`/api/qa/file-preview?path=${encodeURIComponent(path)}`);
      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(errData.error || `HTTP ${res.status}`);
      }
      const raw = await res.json();
      const validated = validateApiResponse<FilePreviewData>(raw, '/api/qa/file-preview', {
        type: 'string',
        fileName: 'string',
        content: 'string',
        ext: { type: 'string', optional: true },
        base64: { type: 'string', optional: true },
        mimeType: { type: 'string', optional: true },
        size: { type: 'number', optional: true },
        modified: { type: 'string', optional: true },
        message: { type: 'string', optional: true },
      });
      setData(validated);
    } catch (err: any) {
      setError(err.message || 'Failed to load preview');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (filePath) {
      fetchPreview(filePath);
    } else {
      setData(null);
      setError(null);
    }
  }, [filePath, fetchPreview]);

  if (!filePath) return null;

  const fileName = filePath.split('/').pop() || filePath;
  const shortPath = filePath.replace(/^\/root\/projekte\/werkingflow\/tests\/unified-tester\//, '');

  return (
    <div style={{
      width: 420,
      flexShrink: 0,
      display: 'flex',
      flexDirection: 'column',
      borderLeft: '2px solid rgba(125,207,255,0.3)',
      background: 'var(--tn-bg-dark)',
      height: '100%',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 10px',
        borderBottom: '1px solid var(--tn-border)',
        flexShrink: 0,
        background: 'rgba(125,207,255,0.05)',
      }}>
        <span style={{
          fontSize: 9,
          fontWeight: 800,
          color: '#7dcfff',
          fontFamily: 'monospace',
          textTransform: 'uppercase',
          letterSpacing: 0.5,
        }}>
          Preview
        </span>
        <span style={{
          flex: 1,
          fontSize: 10,
          fontWeight: 600,
          color: 'var(--tn-text)',
          fontFamily: 'monospace',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }} title={filePath}>
          {fileName}
        </span>
        {data && (
          <span style={{
            fontSize: 8,
            color: 'var(--tn-text-muted)',
            fontFamily: 'monospace',
          }}>
            {fmtBytes(data.size ?? 0)}
          </span>
        )}
        <button
          onClick={onClose}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--tn-text-muted)',
            cursor: 'pointer',
            fontSize: 14,
            lineHeight: 1,
            padding: '0 2px',
          }}
          title="Close preview"
        >
          x
        </button>
      </div>

      {/* Path bar */}
      <div style={{
        padding: '3px 10px',
        fontSize: 8,
        fontFamily: 'monospace',
        color: 'var(--tn-text-muted)',
        borderBottom: '1px solid var(--tn-border)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        flexShrink: 0,
      }} title={filePath}>
        {shortPath}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        {loading && (
          <div style={{ padding: 20, textAlign: 'center', color: 'var(--tn-text-muted)', fontSize: 11 }}>
            Loading preview...
          </div>
        )}

        {error && (
          <div style={{ padding: 16, color: 'var(--tn-red)', fontSize: 11 }}>
            {error}
          </div>
        )}

        {data && !loading && <PreviewContent data={data} />}
      </div>
    </div>
  );
}

// ─── Content Renderer ───────────────────────────────────────────────────────
function PreviewContent({ data }: { data: FilePreviewData }) {
  // Text files
  if (data.type === 'text') {
    // Markdown
    if (data.ext === '.md') {
      return (
        <div style={{
          padding: '12px 16px',
          fontSize: 12,
          lineHeight: 1.7,
          color: 'var(--tn-text)',
        }} className="qa-file-preview-markdown">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              h1: ({node, ...props}) => <h1 style={{ fontSize: 18, fontWeight: 700, color: 'var(--tn-text)', marginTop: 20, marginBottom: 10, borderBottom: '1px solid var(--tn-border)', paddingBottom: 6 }} {...props} />,
              h2: ({node, ...props}) => <h2 style={{ fontSize: 15, fontWeight: 600, color: 'var(--tn-text)', marginTop: 16, marginBottom: 8 }} {...props} />,
              h3: ({node, ...props}) => <h3 style={{ fontSize: 13, fontWeight: 600, color: 'var(--tn-blue)', marginTop: 14, marginBottom: 6 }} {...props} />,
              p: ({node, ...props}) => <p style={{ marginBottom: 8, color: 'var(--tn-text)' }} {...props} />,
              ul: ({node, ...props}) => <ul style={{ marginLeft: 16, marginBottom: 8, listStyleType: 'disc' }} {...props} />,
              ol: ({node, ...props}) => <ol style={{ marginLeft: 16, marginBottom: 8 }} {...props} />,
              li: ({node, ...props}) => <li style={{ marginBottom: 3, color: 'var(--tn-text)' }} {...props} />,
              code: ({node, inline, ...props}: any) => inline
                ? <code style={{ background: 'rgba(30,45,74,0.5)', padding: '1px 4px', borderRadius: 3, fontSize: 11, fontFamily: 'monospace', color: 'var(--tn-blue)' }} {...props} />
                : <code style={{ display: 'block', background: 'rgba(30,45,74,0.5)', padding: 8, borderRadius: 4, fontSize: 11, fontFamily: 'monospace', overflow: 'auto', marginBottom: 8, border: '1px solid var(--tn-border)' }} {...props} />,
              table: ({node, ...props}) => <div style={{ overflowX: 'auto', marginBottom: 12 }}><table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }} {...props} /></div>,
              thead: ({node, ...props}) => <thead style={{ background: 'rgba(30,45,74,0.5)', borderBottom: '2px solid var(--tn-border)' }} {...props} />,
              th: ({node, ...props}) => <th style={{ padding: '6px 8px', textAlign: 'left', fontWeight: 600, borderBottom: '1px solid var(--tn-border)', color: 'var(--tn-text)', whiteSpace: 'nowrap' }} {...props} />,
              td: ({node, ...props}) => <td style={{ padding: '5px 8px', borderBottom: '1px solid var(--tn-border)', color: 'var(--tn-text)' }} {...props} />,
              blockquote: ({node, ...props}) => <blockquote style={{ borderLeft: '3px solid var(--tn-blue)', paddingLeft: 10, marginLeft: 0, marginBottom: 8, color: 'var(--tn-text-muted)', fontStyle: 'italic' }} {...props} />,
              hr: ({node, ...props}) => <hr style={{ border: 'none', borderTop: '1px solid var(--tn-border)', margin: '12px 0' }} {...props} />,
              strong: ({node, ...props}) => <strong style={{ fontWeight: 700, color: 'var(--tn-text)' }} {...props} />,
              a: ({node, ...props}) => <a style={{ color: 'var(--tn-blue)', textDecoration: 'none' }} {...props} />,
            }}
          >
            {data.content}
          </ReactMarkdown>
        </div>
      );
    }

    // HTML — render in sandboxed iframe
    if (data.ext === '.html' || data.ext === '.htm') {
      return (
        <iframe
          srcDoc={data.content}
          style={{ width: '100%', height: '100%', border: 'none', background: 'white' }}
          sandbox="allow-scripts"
        />
      );
    }

    // JSON — pretty-printed
    if (data.ext === '.json') {
      let formatted = data.content;
      try { formatted = JSON.stringify(JSON.parse(data.content), null, 2); } catch {} // silent-ok: invalid JSON formatting attempt fails gracefully; raw content displayed
      return (
        <pre style={{
          padding: 12,
          fontSize: 11,
          fontFamily: "'JetBrains Mono', monospace",
          color: 'var(--tn-text-subtle)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          margin: 0,
        }}>
          {formatted}
        </pre>
      );
    }

    // CSV — simple table view
    if (data.ext === '.csv') {
      return <CsvPreview content={data.content} />;
    }

    // Other text files — plain code view
    return (
      <pre style={{
        padding: 12,
        fontSize: 11,
        fontFamily: "'JetBrains Mono', monospace",
        color: 'var(--tn-text-subtle)',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        margin: 0,
      }}>
        {data.content}
      </pre>
    );
  }

  // Images
  if (data.type === 'image') {
    return (
      <div style={{
        padding: 12,
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'flex-start',
      }}>
        <img
          src={`data:${data.mimeType ?? ''};base64,${data.base64 ?? ''}`}
          alt={data.fileName}
          style={{
            maxWidth: '100%',
            maxHeight: '80vh',
            objectFit: 'contain',
            borderRadius: 4,
            border: '1px solid var(--tn-border)',
          }}
        />
      </div>
    );
  }

  // PDF — embedded viewer
  if (data.type === 'pdf') {
    return (
      <iframe
        src={`data:application/pdf;base64,${data.base64 ?? ''}`}
        style={{ width: '100%', height: '100%', border: 'none' }}
        title={data.fileName}
      />
    );
  }

  // Unsupported
  return (
    <div style={{
      padding: 24,
      textAlign: 'center',
      color: 'var(--tn-text-muted)',
      fontSize: 11,
    }}>
      <div style={{ fontSize: 28, marginBottom: 8, opacity: 0.4 }}>?</div>
      <div style={{ fontWeight: 600 }}>{data.fileName}</div>
      <div style={{ marginTop: 4 }}>{data.message || `No preview for ${data.ext ?? ''} files`}</div>
      <div style={{ marginTop: 8, fontSize: 9 }}>{fmtBytes(data.size ?? 0)}</div>
    </div>
  );
}

// ─── CSV Preview ────────────────────────────────────────────────────────────
function CsvPreview({ content }: { content: string }) {
  const lines = content.split('\n').filter(l => l.trim());
  const rows = lines.map(l => {
    // Simple CSV parsing (handles quoted values)
    const cells: string[] = [];
    let current = '';
    let inQuote = false;
    for (const ch of l) {
      if (ch === '"') { inQuote = !inQuote; continue; }
      if (ch === ',' && !inQuote) { cells.push(current.trim()); current = ''; continue; }
      if (ch === ';' && !inQuote) { cells.push(current.trim()); current = ''; continue; }
      current += ch;
    }
    cells.push(current.trim());
    return cells;
  });

  if (rows.length === 0) return null;

  const headers = rows[0];
  const dataRows = rows.slice(1, 100); // Limit to 100 rows

  return (
    <div style={{ overflow: 'auto', padding: 8 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10, fontFamily: 'monospace' }}>
        <thead>
          <tr style={{ background: 'rgba(30,45,74,0.5)' }}>
            {headers.map((h, i) => (
              <th key={i} style={{
                padding: '5px 8px',
                textAlign: 'left',
                fontWeight: 700,
                color: 'var(--tn-text)',
                borderBottom: '2px solid var(--tn-border)',
                whiteSpace: 'nowrap',
              }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {dataRows.map((row, ri) => (
            <tr key={ri}>
              {row.map((cell, ci) => (
                <td key={ci} style={{
                  padding: '4px 8px',
                  borderBottom: '1px solid var(--tn-border)',
                  color: 'var(--tn-text-subtle)',
                  maxWidth: 200,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {lines.length > 101 && (
        <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', padding: '4px 0', textAlign: 'center' }}>
          ... {lines.length - 101} more rows
        </div>
      )}
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
