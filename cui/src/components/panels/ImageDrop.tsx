import { useState, useRef, useCallback, useEffect } from 'react';

const ACCOUNTS = [
  { id: 'rafael', label: 'Rafael (Remote)' },
  { id: 'engelmann', label: 'Engelmann (Remote)' },
  { id: 'office', label: 'Office (Remote)' },
  { id: 'local', label: 'Local' },
];

interface UploadedImage {
  name: string;
  preview: string; // data URL for thumbnail
  size: number;
}

interface UploadResult {
  readCommand: string;
  count: number;
  target: string;
  paths: string[];
}

export default function ImageDrop() {
  const [accountId, setAccountId] = useState('rafael');
  const [images, setImages] = useState<UploadedImage[]>([]);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [uploading, setUploading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const dropRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pasteRef = useRef<HTMLDivElement>(null);

  // Paste is handled by the onPaste handler on the paste area div below

  const addFile = useCallback((file: File) => {
    if (!file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      setImages(prev => [...prev, {
        name: file.name,
        preview: e.target?.result as string,
        size: file.size,
      }]);
      setResult(null);
      setError('');
    };
    reader.readAsDataURL(file);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    for (const file of e.dataTransfer.files) addFile(file);
  }, [addFile]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const removeImage = (idx: number) => {
    setImages(prev => prev.filter((_, i) => i !== idx));
    setResult(null);
  };

  const upload = async () => {
    if (!images.length) return;
    setUploading(true);
    setError('');
    try {
      const resp = await fetch('/api/images', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId,
          images: images.map(img => ({ name: img.name, data: img.preview })),
        }),
      });
      if (!resp.ok) {
        const err = await resp.json();
        throw new Error(err.error || 'Upload failed');
      }
      const data: UploadResult = await resp.json();
      setResult(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  };

  const copyCommand = async () => {
    if (!result) return;
    await navigator.clipboard.writeText(result.readCommand);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const clear = () => {
    setImages([]);
    setResult(null);
    setError('');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#1a1a2e', color: '#e0e0e0', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      {/* Header */}
      <div style={{ padding: '8px 12px', borderBottom: '1px solid #333', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>Images</span>
        <select
          value={accountId}
          onChange={e => { setAccountId(e.target.value); setResult(null); }}
          style={{ marginLeft: 'auto', background: '#2a2a4a', color: '#e0e0e0', border: '1px solid #444', borderRadius: 4, padding: '2px 6px', fontSize: 12 }}
        >
          {ACCOUNTS.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
        </select>
      </div>

      {/* Paste area - click here then Cmd+V */}
      <div
        ref={pasteRef}
        tabIndex={0}
        onPaste={(e) => {
          const items = e.clipboardData?.items;
          if (!items) return;
          for (const item of items) {
            if (item.type.startsWith('image/')) {
              e.preventDefault();
              const file = item.getAsFile();
              if (file) addFile(file);
            }
          }
        }}
        onClick={() => pasteRef.current?.focus()}
        style={{
          margin: '8px 8px 0', padding: '6px 10px',
          background: '#1e1e3a', border: '1px solid #444', borderRadius: 6,
          fontSize: 11, color: '#888', cursor: 'text',
          outline: 'none', transition: 'border-color 0.2s',
        }}
        onFocus={(e) => { e.currentTarget.style.borderColor = '#7c3aed'; }}
        onBlur={(e) => { e.currentTarget.style.borderColor = '#444'; }}
      >
        Hier klicken, dann Cmd+V zum Einfuegen
      </div>

      {/* Drop zone + file picker */}
      <div
        ref={dropRef}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onClick={() => fileRef.current?.click()}
        style={{
          margin: '4px 8px 8px',
          padding: images.length ? 8 : 24,
          border: '2px dashed #555',
          borderRadius: 8,
          textAlign: 'center',
          cursor: 'pointer',
          minHeight: 60,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 4,
          transition: 'border-color 0.2s',
        }}
        onDragEnter={(e) => { e.preventDefault(); if (dropRef.current) dropRef.current.style.borderColor = '#7c3aed'; }}
        onDragLeave={() => { if (dropRef.current) dropRef.current.style.borderColor = '#555'; }}
      >
        {images.length === 0 ? (
          <>
            <span style={{ fontSize: 24 }}>+</span>
            <span style={{ fontSize: 12, color: '#888' }}>Drop oder klick fuer Datei-Auswahl</span>
          </>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'center' }}>
            {images.map((img, i) => (
              <div key={i} style={{ position: 'relative', width: 56, height: 56 }}>
                <img src={img.preview} alt={img.name} style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 4, border: '1px solid #444' }} />
                <button
                  onClick={(e) => { e.stopPropagation(); removeImage(i); }}
                  style={{ position: 'absolute', top: -4, right: -4, background: '#ef4444', color: '#fff', border: 'none', borderRadius: '50%', width: 16, height: 16, fontSize: 10, cursor: 'pointer', lineHeight: '16px', padding: 0 }}
                >x</button>
                <span style={{ position: 'absolute', bottom: 0, left: 0, right: 0, fontSize: 8, background: 'rgba(0,0,0,0.7)', color: '#ccc', textAlign: 'center', borderRadius: '0 0 4px 4px', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                  {Math.round(img.size / 1024)}KB
                </span>
              </div>
            ))}
          </div>
        )}
        <input ref={fileRef} type="file" multiple accept="image/*" style={{ display: 'none' }} onChange={e => { for (const f of e.target.files || []) addFile(f); e.target.value = ''; }} />
      </div>

      {/* Actions */}
      {images.length > 0 && !result && (
        <div style={{ padding: '0 8px 8px', display: 'flex', gap: 6 }}>
          <button
            onClick={upload}
            disabled={uploading}
            style={{ flex: 1, padding: '6px 12px', background: uploading ? '#555' : '#7c3aed', color: '#fff', border: 'none', borderRadius: 6, cursor: uploading ? 'wait' : 'pointer', fontSize: 12, fontWeight: 600 }}
          >
            {uploading ? 'Uploading...' : `Upload ${images.length} image${images.length > 1 ? 's' : ''} (${accountId})`}
          </button>
          <button onClick={clear} style={{ padding: '6px 10px', background: '#333', color: '#aaa', border: '1px solid #555', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}>Clear</button>
        </div>
      )}

      {/* Error */}
      {error && (
        <div style={{ margin: '0 8px 8px', padding: 8, background: '#3b1111', border: '1px solid #7f1d1d', borderRadius: 6, fontSize: 11, color: '#fca5a5' }}>
          {error}
        </div>
      )}

      {/* Result: Read command */}
      {result && (
        <div style={{ margin: '0 8px 8px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ padding: 8, background: '#1e293b', border: '1px solid #334155', borderRadius: 6, fontSize: 11, fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: '#86efac', maxHeight: 120, overflow: 'auto' }}>
            {result.readCommand}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              onClick={copyCommand}
              style={{ flex: 1, padding: '6px 12px', background: copied ? '#16a34a' : '#2563eb', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600, transition: 'background 0.2s' }}
            >
              {copied ? 'Copied!' : 'Copy command'}
            </button>
            <button onClick={clear} style={{ padding: '6px 10px', background: '#333', color: '#aaa', border: '1px solid #555', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}>New</button>
          </div>
          <span style={{ fontSize: 10, color: '#666', textAlign: 'center' }}>
            {result.count} image{result.count > 1 ? 's' : ''} → {result.target}
          </span>
        </div>
      )}
    </div>
  );
}