import React, { useEffect, useState, useCallback, useMemo } from 'react';

interface Cell {
  userId: string;
  userName: string;
  role: string;
  claudeAccountId: string;
  workspace: string;
  capturedAt: string | null;
  status: 'success' | 'error' | null;
  error: string | null;
  durationMs: number | null;
  inFlight: boolean;
  screenshotUrl: string | null;
}

interface MatrixResponse {
  baseUrl: string;
  users: Array<{ id: string; name: string; role: string }>;
  cells: Cell[];
}

const API = '/api/partner-server';

export default function PartnerServerPanel() {
  const [data, setData] = useState<MatrixResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [bulkRunning, setBulkRunning] = useState(false);
  const [zoom, setZoom] = useState<Cell | null>(null);

  const fetchMatrix = useCallback(async () => {
    try {
      const r = await fetch(`${API}/matrix`);
      if (!r.ok) throw new Error(`matrix ${r.status}`);
      const d = await r.json();
      setData(d);
      setError(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchMatrix(); }, [fetchMatrix]);

  const cellKey = (c: Cell) => `${c.userId}__${c.workspace}`;

  const triggerCapture = useCallback(async (cell: Cell) => {
    const key = cellKey(cell);
    setBusy(s => new Set(s).add(key));
    try {
      const r = await fetch(`${API}/capture`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: cell.userId, workspace: cell.workspace }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `capture ${r.status}`);
      }
      await fetchMatrix();
    } catch (e: any) {
      console.error('[PartnerServer] capture failed:', e);
    } finally {
      setBusy(s => { const n = new Set(s); n.delete(key); return n; });
    }
  }, [fetchMatrix]);

  const runAll = useCallback(async () => {
    if (!data) return;
    setBulkRunning(true);
    for (const cell of data.cells) {
      await triggerCapture(cell);
    }
    setBulkRunning(false);
  }, [data, triggerCapture]);

  const grouped = useMemo(() => {
    if (!data) return new Map<string, Cell[]>();
    const m = new Map<string, Cell[]>();
    for (const c of data.cells) {
      if (!m.has(c.userId)) m.set(c.userId, []);
      m.get(c.userId)!.push(c);
    }
    return m;
  }, [data]);

  if (loading) {
    return <div style={{ padding: 20, color: 'var(--tn-text-muted)' }}>Lade Partner-Matrix...</div>;
  }
  if (error) {
    return (
      <div style={{ padding: 20, color: 'var(--tn-red, #f7768e)' }}>
        Fehler: {error}
        <button onClick={fetchMatrix} style={btnStyle}>Retry</button>
      </div>
    );
  }
  if (!data) return null;

  return (
    <div style={{ height: '100%', overflow: 'auto', background: 'var(--tn-bg, #1a1b26)', color: 'var(--tn-text, #c0caf5)', padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Partner-Server Health</h2>
        <span style={{ fontSize: 11, color: 'var(--tn-text-muted, #a9b1d6)' }}>{data.baseUrl}</span>
        <span style={{ flex: 1 }} />
        <button onClick={fetchMatrix} style={btnStyle} disabled={bulkRunning}>↻ Refresh</button>
        <button onClick={runAll} style={{ ...btnStyle, background: 'var(--tn-blue, #7aa2f7)', color: '#1a1b26' }} disabled={bulkRunning}>
          {bulkRunning ? '... Running' : '▶ Capture All'}
        </button>
      </div>

      <div style={{ fontSize: 11, color: 'var(--tn-text-muted, #a9b1d6)', marginBottom: 12 }}>
        Klick auf eine Zelle = Screenshot generieren (zeigt was der User sieht beim Login + Workspace-Klick).
        Klick auf den Screenshot = Vollbild.
      </div>

      {Array.from(grouped.entries()).map(([userId, cells]) => (
        <div key={userId} style={{ marginBottom: 24 }}>
          <div style={{ fontWeight: 600, marginBottom: 8, paddingBottom: 4, borderBottom: '1px solid var(--tn-border, #292e42)' }}>
            {cells[0].userName} <span style={{ fontSize: 11, color: 'var(--tn-text-muted, #a9b1d6)' }}>· {cells[0].role} · {userId}</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
            {cells.map(c => {
              const key = `${c.userId}__${c.workspace}`;
              const isBusy = busy.has(key) || c.inFlight;
              return (
                <div key={key} style={{
                  border: '1px solid var(--tn-border, #292e42)',
                  borderRadius: 6,
                  background: 'var(--tn-bg-elevated, #1f2335)',
                  overflow: 'hidden',
                  display: 'flex',
                  flexDirection: 'column',
                }}>
                  <div style={{ padding: '6px 10px', display: 'flex', alignItems: 'center', gap: 8, borderBottom: '1px solid var(--tn-border, #292e42)', fontSize: 12 }}>
                    <span style={{ fontWeight: 500 }}>{c.workspace}</span>
                    {c.status === 'success' && <span style={{ color: 'var(--tn-green, #9ece6a)', fontSize: 10 }}>✓ {c.durationMs ? `${(c.durationMs/1000).toFixed(1)}s` : ''}</span>}
                    {c.status === 'error' && <span style={{ color: 'var(--tn-red, #f7768e)', fontSize: 10 }} title={c.error || ''}>✗ error</span>}
                    <span style={{ flex: 1 }} />
                    <button onClick={() => triggerCapture(c)} style={miniBtnStyle} disabled={isBusy}>
                      {isBusy ? '...' : c.status ? 'Re-Capture' : 'Capture'}
                    </button>
                  </div>
                  <div
                    style={{
                      flex: 1, minHeight: 160, position: 'relative', background: '#0d0e16',
                      cursor: c.screenshotUrl ? 'zoom-in' : 'default',
                    }}
                    onClick={() => c.screenshotUrl && setZoom(c)}
                  >
                    {c.screenshotUrl ? (
                      <img
                        src={c.screenshotUrl}
                        alt={`${c.userId} ${c.workspace}`}
                        style={{ width: '100%', height: 'auto', display: 'block' }}
                      />
                    ) : (
                      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--tn-text-muted, #565f89)', fontSize: 12 }}>
                        {isBusy ? 'Capturing...' : 'No screenshot yet'}
                      </div>
                    )}
                  </div>
                  {c.capturedAt && (
                    <div style={{ padding: '4px 10px', fontSize: 10, color: 'var(--tn-text-muted, #565f89)', borderTop: '1px solid var(--tn-border, #292e42)' }}>
                      {new Date(c.capturedAt).toLocaleString('de-DE')}
                    </div>
                  )}
                  {c.status === 'error' && c.error && (
                    <div style={{ padding: '4px 10px', fontSize: 10, color: 'var(--tn-red, #f7768e)', borderTop: '1px solid var(--tn-border, #292e42)' }}>
                      {c.error.slice(0, 200)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {zoom && zoom.screenshotUrl && (
        <div
          onClick={() => setZoom(null)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 9999,
            display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'zoom-out',
          }}
        >
          <div style={{ position: 'absolute', top: 16, left: 16, color: '#fff', fontSize: 14 }}>
            {zoom.userName} · {zoom.workspace}
            {zoom.capturedAt && <span style={{ marginLeft: 12, fontSize: 11, opacity: 0.7 }}>{new Date(zoom.capturedAt).toLocaleString('de-DE')}</span>}
          </div>
          <img src={zoom.screenshotUrl} alt="" style={{ maxWidth: '95%', maxHeight: '95%', boxShadow: '0 4px 32px rgba(0,0,0,0.6)' }} />
        </div>
      )}
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  padding: '4px 10px',
  fontSize: 12,
  background: 'var(--tn-surface, #292e42)',
  color: 'var(--tn-text, #c0caf5)',
  border: '1px solid var(--tn-border, #3b4261)',
  borderRadius: 4,
  cursor: 'pointer',
};
const miniBtnStyle: React.CSSProperties = {
  ...btnStyle,
  padding: '2px 8px',
  fontSize: 11,
};
