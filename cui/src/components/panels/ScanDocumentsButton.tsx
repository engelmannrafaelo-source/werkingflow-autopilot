// Scan Documents Button - Triggers full/incremental scan
// Created: 2026-02-19

import { useState } from 'react';

interface ScanResult {
  scanned_count: number;
  classified_count: number;
  auto_assigned_count: number;
  pending_review_count: number;
  duration_ms: number;
  errors?: Array<{ file: string; error: string }>;
}

export default function ScanDocumentsButton() {
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function triggerScan() {
    setScanning(true);
    setResult(null);
    setError(null);

    try {
      const response = await fetch('/api/team/knowledge/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'full',
          auto_assign: true,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Scan failed');
      }

      const data = await response.json();
      setResult(data);

      // Refresh knowledge data after scan
      window.dispatchEvent(new Event('knowledge-updated'));
    } catch (err: any) {
      console.error('[ScanButton] Error:', err);
      setError(err.message);
    } finally {
      setScanning(false);
    }
  }

  return (
    <div className="scan-documents-panel" style={{ padding: '1rem', borderBottom: '1px solid var(--tn-border)' }}>
      <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start' }}>
        <button
          onClick={triggerScan}
          disabled={scanning}
          style={{
            background: scanning ? 'var(--tn-bg-tertiary)' : 'var(--tn-blue)',
            color: '#fff',
            border: 'none',
            padding: '0.5rem 1rem',
            borderRadius: 6,
            fontSize: 12,
            fontWeight: 600,
            cursor: scanning ? 'not-allowed' : 'pointer',
            opacity: scanning ? 0.6 : 1,
          }}
        >
          {scanning ? '🔄 Scanning...' : '🔍 Scan New Documents'}
        </button>

        {scanning && (
          <div style={{ fontSize: 11, color: 'var(--tn-text-muted)', alignSelf: 'center' }}>
            This may take 1-2 minutes...
          </div>
        )}
      </div>

      {error && (
        <div
          style={{
            marginTop: '1rem',
            padding: '0.75rem',
            background: 'rgba(239,68,68,0.1)',
            border: '1px solid rgba(239,68,68,0.3)',
            borderRadius: 6,
            fontSize: 11,
            color: '#ef4444',
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: '0.25rem' }}>Scan Failed</div>
          {error}
        </div>
      )}

      {result && (
        <div
          style={{
            marginTop: '1rem',
            padding: '0.75rem',
            background: 'var(--tn-bg-secondary)',
            borderRadius: 6,
            fontSize: 11,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: '0.5rem', color: 'var(--tn-text)' }}>
            ✅ Scan Complete
          </div>
          <div style={{ color: 'var(--tn-text-muted)', lineHeight: 1.6 }}>
            Scanned: <strong>{result.scanned_count}</strong> documents
            <br />
            Classified: <strong>{result.classified_count}</strong>
            <br />
            Auto-assigned: <strong>{result.auto_assigned_count}</strong>
            <br />
            Pending review: <strong>{result.pending_review_count}</strong>
            <br />
            Duration: <strong>{(result.duration_ms / 1000).toFixed(1)}s</strong>
          </div>

          {result.errors && result.errors.length > 0 && (
            <div style={{ marginTop: '0.5rem', fontSize: 10, color: '#f59e0b' }}>
              {result.errors.length} errors occurred
            </div>
          )}
        </div>
      )}
    </div>
  );
}
