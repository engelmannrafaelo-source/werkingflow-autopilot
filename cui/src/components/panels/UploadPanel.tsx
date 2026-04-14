import { useState, useRef, useCallback } from 'react';

const API = '/api';

interface UploadedFile {
  name: string;
  size: number;
  serverPath: string;
}

/** Copy text to clipboard with fallback */
function copyToClipboard(text: string): void {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    });
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function UploadPanel() {
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const uploadFiles = useCallback(async (fileList: FileList | File[]) => {
    setUploading(true);
    setError('');
    const newFiles: UploadedFile[] = [];

    for (const file of Array.from(fileList)) {
      try {
        const formData = new FormData();
        formData.append('file', file);

        const res = await fetch(`${API}/uploads/file`, {
          method: 'POST',
          body: formData,
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
          throw new Error(err.error || `Upload failed: ${res.status}`);
        }

        const data = await res.json();
        newFiles.push({
          name: file.name,
          size: file.size,
          serverPath: data.path,
        });
      } catch (err: any) {
        setError(`${file.name}: ${err.message}`);
      }
    }

    if (newFiles.length > 0) {
      setFiles(prev => [...newFiles, ...prev]);
    }
    setUploading(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files?.length) {
      uploadFiles(e.dataTransfer.files);
    }
  }, [uploadFiles]);

  const handleCopy = (path: string) => {
    copyToClipboard(path);
    setCopied(path);
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--tn-surface)' }}>
      {/* Header */}
      <div style={{
        padding: '8px 12px', borderBottom: '1px solid var(--tn-border)',
        display: 'flex', alignItems: 'center', gap: 8,
        background: 'var(--tn-bg-dark)',
      }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--tn-text)', flex: 1 }}>
          Uploads
        </span>
        <span style={{ fontSize: 10, color: 'var(--tn-text-muted)' }}>
          {files.length} Dateien
        </span>
      </div>

      {/* Drop Zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
        style={{
          margin: '8px 12px',
          padding: '16px',
          border: `2px dashed ${dragOver ? 'var(--tn-blue)' : 'var(--tn-border)'}`,
          borderRadius: 6,
          background: dragOver ? 'rgba(59,130,246,0.08)' : 'var(--tn-bg)',
          textAlign: 'center',
          cursor: 'pointer',
          transition: 'all 0.15s',
        }}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => { if (e.target.files?.length) uploadFiles(e.target.files); e.target.value = ''; }}
        />
        <div style={{ fontSize: 20, marginBottom: 4 }}>{uploading ? '\u23F3' : '\u2B06'}</div>
        <div style={{ fontSize: 11, color: 'var(--tn-text-muted)' }}>
          {uploading ? 'Wird hochgeladen...' : 'Dateien hierher ziehen oder klicken'}
        </div>
      </div>

      {error && (
        <div style={{ margin: '0 12px 8px', padding: '6px 10px', fontSize: 10, background: 'rgba(239,68,68,0.1)', color: '#EF4444', borderRadius: 4 }}>
          {error}
        </div>
      )}

      {/* File List */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 12px 12px' }}>
        {files.map((f, i) => (
          <div key={i} style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '6px 8px', marginBottom: 4,
            background: 'var(--tn-bg)', borderRadius: 4,
            border: '1px solid var(--tn-border)',
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--tn-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {f.name}
              </div>
              <div style={{
                fontSize: 10, color: 'var(--tn-green)', fontFamily: "'JetBrains Mono', monospace",
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {f.serverPath}
              </div>
            </div>
            <span style={{ fontSize: 9, color: 'var(--tn-text-muted)', whiteSpace: 'nowrap' }}>
              {formatSize(f.size)}
            </span>
            <button
              onClick={() => handleCopy(f.serverPath)}
              title="Pfad kopieren"
              style={{
                padding: '2px 6px', fontSize: 9, borderRadius: 3, cursor: 'pointer',
                background: copied === f.serverPath ? 'rgba(16,185,129,0.25)' : 'rgba(255,255,255,0.05)',
                border: '1px solid var(--tn-border)',
                color: copied === f.serverPath ? '#10B981' : 'var(--tn-text-muted)',
                transition: 'all 0.15s',
                whiteSpace: 'nowrap',
              }}
            >
              {copied === f.serverPath ? '\u2713 Kopiert' : '\u2398 Pfad'}
            </button>
          </div>
        ))}
        {files.length === 0 && !uploading && (
          <div style={{ textAlign: 'center', padding: '20px 0', color: 'var(--tn-text-muted)', fontSize: 11 }}>
            Noch keine Dateien hochgeladen
          </div>
        )}
      </div>
    </div>
  );
}
